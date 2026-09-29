'use strict';

const NUMBERS = require('./accountNumbers');
const CA = require('./creditArrangements');
const DR = require('./depositRules');
const { can } = require('../lib/permissions');
const { orgToday } = require('../lib/orgDate');

const acct = require('./accounting');
const S = require('./schedule');
const PA = require('./productAccounting');
const accruals = require('./accruals');
const channels = require('./channels');
const customFields = require('./customFields');
const { err, round2 } = acct;

/**
 * Deposit accounts. Every function takes an open tenant client.
 *
 * Balances are mutated in SQL on the numeric column, never read into JS,
 * changed, and written back. That closes the read-modify-write race two
 * tellers posting to the same account at once would otherwise hit, and it
 * keeps the arithmetic in exact decimal rather than binary float.
 *
 * Accounting follows the product, after the reference platform's deposit rules:
 *
 *   Deposit                  Dr Transaction Source      Cr Savings Control
 *   Withdrawal               Dr Savings Control         Cr Transaction Source
 *   Fee applied              Dr Savings Control         Cr Fee Income
 *   Withholding tax          Dr Savings Control         Cr Taxes Payable
 *   Interest accrued         Dr Interest Expense        Cr Interest Payable      (ACCRUAL)
 *   Interest applied         Dr Interest Payable        Cr Savings Control       (ACCRUAL)
 *                            Dr Interest Expense        Cr Savings Control       (CASH)
 *   Negative interest        Dr Neg. Interest Rec.      Cr Neg. Interest Income  (accrued, ACCRUAL)
 *                            Dr Savings Control         Cr Neg. Interest Rec./Income
 *   Overdraft withdrawal     Dr Overdraft Portfolio     Cr Transaction Source
 *   Overdraft repaid         Dr Transaction Source      Cr Overdraft Portfolio
 *   Overdraft interest       Dr OD Interest Receivable  Cr OD Interest Income    (accrued, ACCRUAL)
 *                            Dr Overdraft Portfolio     Cr OD Interest Rec.      (applied, ACCRUAL)
 *   Overdraft write-off      Dr OD Write-off Expense    Cr Overdraft Portfolio
 *
 * Under CASH, overdraft interest and fees applied to an overdrawn balance
 * are owed but not yet income (od_interest_due, od_fees_due); the deposit
 * that pays them recognises them. Under NONE the product's legs are not
 * posted and the channel's leg goes against the tenant's suspense account.
 *
 * A movement that crosses zero is split: the part above zero moves Savings
 * Control, the part below moves the Overdraft Portfolio.
 */

const PRODUCT_COLUMNS = `
  p.name AS product_name, p.gl_liability, p.gl_interest_exp, p.gl_interest_payable, p.gl_fee_inc, p.gl_tax_payable,
  p.gl_neg_interest_inc, p.gl_neg_interest_rec, p.gl_od_portfolio, p.gl_od_writeoff, p.gl_od_interest_inc,
  p.gl_od_interest_rec, p.withdrawable, p.min_balance, p.annual_rate, p.is_funding_account,
  p.accounting_method, p.interest_accrued_accounting, p.accrual_granularity, p.interest_paid_into_account,
  p.interest_calc_balance, p.interest_day_count, p.interest_application, p.min_balance_for_interest,
  p.allow_negative_rate, p.withholding_tax_percent, p.allow_overdraft, p.max_overdraft_limit,
  p.overdraft_annual_rate AS product_overdraft_rate, p.allow_technical_overdraft,
  COALESCE(a.overdraft_rate, p.overdraft_annual_rate) AS overdraft_annual_rate,
  p.product_type, p.category, p.interest_rate_terms, p.interest_rate_min, p.interest_rate_max, p.interest_rate_frequency,
  p.interest_rate_x_days, p.interest_index_source_id, p.interest_spread_min, p.interest_spread_max, p.interest_spread_default,
  p.interest_rate_tiers, p.interest_max_balance, p.interest_fixed_dates, p.collect_interest_when_locked,
  p.accrue_interest_after_maturity, p.recommended_deposit_amount, p.max_withdrawal_amount, p.min_opening_balance,
  p.max_opening_balance, p.default_opening_balance, p.term_unit, p.term_min, p.term_max, p.term_default, p.dormancy_days,
  p.allow_arbitrary_fees, p.od_rate_terms, p.od_rate_min, p.od_rate_max, p.od_index_source_id, p.od_spread_min, p.od_spread_max,
  p.od_spread_default, p.od_rate_tiers, p.od_day_count, p.od_calc_balance`;

async function lock(c, accountId) {
  const { rows } = await c.query(
    `SELECT a.*, ${PRODUCT_COLUMNS}
     FROM savings_accounts a
     JOIN savings_products p ON p.id = a.product_id
     WHERE a.id::text = $1 OR a.account_no = $1
     FOR UPDATE OF a`,
    [accountId]
  );
  if (!rows.length) throw err('SAVINGS_ACCOUNT_NOT_FOUND', 404);
  return rows[0];
}

async function channel(c, id) {
  const { rows } = await c.query(
    'SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [id]
  );
  if (!rows.length) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${id}`);
  return rows[0];
}

const books = (a) => a.accounting_method !== 'NONE';
const accrues = (a) => PA.accrues(a);

/**
 * What a member's deposits are committed to: guarantor pledges on others'
 * loans (called ones until recovered or released), and funding pledged on
 * approved loans not yet disbursed.
 */
async function pledgedAmount(c, memberId) {
  // A pledge stays committed for what has not yet been taken from it: a
  // called one (the loan was written off) or one collected in part before
  // the write-off.
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(pledged_amount - recovered), 0) AS total
     FROM loan_guarantors WHERE member_id = $1 AND status IN ('PLEDGED', 'CALLED')`,
    [memberId]
  );
  const locked = await lockedFunding(c, memberId);
  return round2(Number(r.total) + locked);
}

/**
 * Funding pledged from a member's funding accounts to approved loans not yet
 * disbursed, where the product locks funds at approval. Kept here rather
 * than in ./funding because savings sits below the loan modules.
 */
async function lockedFunding(c, memberId) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(f.amount), 0) AS t
     FROM loan_funding_sources f
     JOIN loan_accounts l ON l.id = f.loan_id
     JOIN loan_products p ON p.id = l.product_id
     WHERE f.member_id = $1 AND f.status = 'PLEDGED' AND l.status = 'APPROVED' AND p.lock_funds_at_approval`, [memberId]);
  return round2(r.t);
}

/**
 * The account as it lends on a day: past its overdraft expiry date (the reference platform)
 * the overdraft limit no longer lends, though what is overdrawn stays owed.
 */
function onDay(a, day) {
  if (!a.overdraft_expires_on || !day || String(a.overdraft_expires_on).slice(0, 10) >= String(day).slice(0, 10)) return a;
  return { ...a, overdraft_limit: 0 };
}

/** What may be withdrawn: the balance plus the authorised overdraft, less pledges and the minimum balance. */
function availableOf(a, pledged) {
  return round2(Number(a.balance) + Number(a.overdraft_limit || 0) - pledged - Number(a.min_balance || 0));
}

async function summary(c, accountId) {
  const locked = await lock(c, accountId);
  const a = onDay(locked, await orgToday(c));
  const pledged = await pledgedAmount(c, a.member_id);
  return {
    accountId: a.id,
    accountNo: a.account_no,
    memberId: a.member_id,
    productId: a.product_id,
    branchId: a.branch_id,
    status: a.status,
    balance: round2(a.balance),
    pledged,
    minBalance: round2(a.min_balance),
    overdraftLimit: round2(locked.overdraft_limit),
    overdraftExpiryDate: a.overdraft_expires_on ? S.ymd(a.overdraft_expires_on) : null,
    overdraftExpired: Number(a.overdraft_limit) !== Number(locked.overdraft_limit),
    creditArrangementId: a.credit_arrangement_id || null,
    overdrawn: round2(Math.max(0, -Number(a.balance))),
    available: round2(Math.max(0, availableOf(a, pledged))),
    interest: {
      accrued: round2(a.interest_accrued), negativeAccrued: round2(a.neg_interest_accrued),
      overdraftAccrued: round2(a.od_interest_accrued), accruedThrough: a.accrued_through ? S.ymd(a.accrued_through) : null,
      lastApplied: a.last_interest_applied_on ? S.ymd(a.last_interest_applied_on) : null,
    },
    overdraftChargesDue: { interest: round2(a.od_interest_due), fees: round2(a.od_fees_due) },
    productType: a.product_type,
    interestRate: a.interest_rate === null ? (a.interest_rate_terms === 'FIXED' ? Number(a.annual_rate) : null) : Number(a.interest_rate),
    interestRateOwn: a.interest_rate !== null, interestRateTerms: a.interest_rate_terms, interestSpread: a.interest_spread === null ? null : Number(a.interest_spread),
    overdraftRate: Number(a.overdraft_annual_rate), overdraftSpread: a.overdraft_spread === null ? null : Number(a.overdraft_spread),
    maxBalance: a.max_balance === null ? null : Number(a.max_balance),
    maxWithdrawalAmount: a.max_withdrawal_amount === null ? null : Number(a.max_withdrawal_amount),
    recommendedDepositAmount: a.recommended_deposit_amount === null ? null : Number(a.recommended_deposit_amount),
    maturity: DR.hasTerm(a.product_type) ? {
      termLength: a.term_length ?? a.term_default, termUnit: a.term_unit,
      startedOn: a.maturity_started_on ? S.ymd(a.maturity_started_on) : null, maturityDate: a.maturity_date ? S.ymd(a.maturity_date) : null,
      minOpeningBalance: a.min_opening_balance === null ? null : Number(a.min_opening_balance),
    } : null,
    lastActivityOn: a.last_activity_on ? S.ymd(a.last_activity_on) : null,
  };
}

const ref = (kind) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

async function record(c, row) {
  const { rows } = await c.query(
    `INSERT INTO transactions
       (reference, kind, member_id, savings_account_id, loan_account_id, share_account_id,
        channel_id, amount, value_date, entry_id, allocation, narration, created_by, branch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, current_date),$10,$11,$12,$13,
             COALESCE($14::uuid, (SELECT branch_id FROM loan_accounts WHERE id = $5::uuid),
                      (SELECT branch_id FROM savings_accounts WHERE id = $4::uuid),
                      (SELECT branch_id FROM members WHERE id = $3::uuid)))
     RETURNING *`,
    [row.reference, row.kind, row.memberId || null, row.savingsAccountId || null,
     row.loanAccountId || null, row.shareAccountId || null, row.channelId || null,
     row.amount, row.valueDate || null, row.entryId || null,
     JSON.stringify(row.allocation || {}), row.narration || null, row.createdBy || 'SYSTEM', row.branchId || null]
  );
  return rows[0];
}

// --------------------------------------------------------------------------
// Legs: how money into or out of an account splits across the GL
// --------------------------------------------------------------------------

/**
 * Money into an account pays, in order: overdraft fees then overdraft
 * interest owed under cash accounting (recognised as income now), the rest
 * of the overdraft (Overdraft Portfolio), and what is left becomes balance
 * (Savings Control).
 */
function inLegs(a, amount) {
  const bal = Number(a.balance);
  let left = round2(amount);
  const odFees = round2(Math.min(left, Number(a.od_fees_due || 0)));
  left = round2(left - odFees);
  const odInterest = round2(Math.min(left, Number(a.od_interest_due || 0)));
  left = round2(left - odInterest);
  const overdrawn = round2(Math.max(0, -bal) - Number(a.od_fees_due || 0) - Number(a.od_interest_due || 0));
  const odPrincipal = round2(Math.min(left, Math.max(0, overdrawn)));
  const savings = round2(left - odPrincipal);
  const credits = [];
  if (books(a)) {
    const mid = a.member_id;
    const br = a.branch_id;
    if (odFees > 0) credits.push({ glCode: a.gl_fee_inc, amount: odFees, memberId: mid, branchId: br });
    if (odInterest > 0) credits.push({ glCode: a.gl_od_interest_inc, amount: odInterest, memberId: mid, branchId: br });
    if (odPrincipal > 0) credits.push({ glCode: a.gl_od_portfolio, amount: odPrincipal, memberId: mid, branchId: br });
    if (savings > 0) credits.push({ glCode: a.gl_liability, amount: savings, memberId: mid, branchId: br });
  }
  return { credits, allocation: { odFees, odInterest, odPrincipal, savings } };
}

/** Money out of an account: Savings Control down to zero, the Overdraft Portfolio below it. */
function outLegs(a, amount) {
  const bal = Number(a.balance);
  const savings = round2(Math.min(amount, Math.max(0, bal)));
  const odPrincipal = round2(amount - savings);
  const debits = [];
  if (books(a)) {
    if (savings > 0) debits.push({ glCode: a.gl_liability, amount: savings, memberId: a.member_id, branchId: a.branch_id });
    if (odPrincipal > 0) {
      if (!a.gl_od_portfolio) throw err('PRODUCT_HAS_NO_OVERDRAFT_PORTFOLIO_ACCOUNT', 409);
      debits.push({ glCode: a.gl_od_portfolio, amount: odPrincipal, memberId: a.member_id, branchId: a.branch_id });
    }
  }
  return { debits, allocation: { savings, odPrincipal } };
}

/**
 * Post a movement between a channel and an account. Under NONE the channel
 * still moves (the cash is real) and its other side is the suspense account.
 */
async function postWithChannel(c, a, { channelGl, amount, direction, productLegs, narration, sourceType, channelId, valueDate, createdBy, tellerBranch }) {
  const chLeg = { glCode: channelGl, amount, memberId: a.member_id, branchId: tellerBranch || a.branch_id };
  let legs = productLegs;
  if (!books(a)) legs = [{ glCode: await PA.suspense(c), amount, memberId: a.member_id, branchId: a.branch_id }];
  const e = await acct.post(c, {
    debits: direction === 'IN' ? [chLeg] : legs,
    credits: direction === 'IN' ? legs : [chLeg],
    narration, sourceType, channelId, bookingDate: valueDate, createdBy, branchId: a.branch_id,
  });
  return e.entryId;
}

// --------------------------------------------------------------------------
// What the product lets in and out (the reference platform's Deposit Products)
// --------------------------------------------------------------------------

const need = (user, code) => { if (user && !can(user, code)) throw err(`PERMISSION_REQUIRED: ${code}`, 403); };
const inTerm = (a, day) => Boolean(a.maturity_started_on) && a.maturity_date && day < S.ymd(a.maturity_date);

/**
 * Money in: the account is open to it, a fixed deposit takes nothing once
 * its maturity has started and a savings plan nothing after maturity, the
 * opening balance of either stays within the product's maximum before the
 * term starts, and the balance stays within the account's maximum
 * (MAXIMUM_DEPOSIT_BALANCE_EXCEEDED). A dormant account takes it with
 * POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS.
 */
function assertMayCredit(a, amt, { user = null, day, source = 'DEPOSIT' } = {}) {
  if (a.status === 'DORMANT') need(user, 'POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS');
  else if (a.status === 'MATURED') throw err('DEPOSITS_CLOSED_AFTER_MATURITY', 409);
  else if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (a.product_type === 'FIXED_DEPOSIT' && a.maturity_started_on) throw err('A_FIXED_DEPOSIT_TAKES_NO_DEPOSITS_ONCE_ITS_MATURITY_HAS_STARTED', 409);
  if (a.product_type === 'SAVINGS_PLAN' && a.maturity_date && day >= S.ymd(a.maturity_date)) throw err('DEPOSITS_CLOSED_AFTER_MATURITY', 409);
  const after = round2(Number(a.balance) + Number(amt));
  if (DR.hasTerm(a.product_type) && !a.maturity_started_on && a.max_opening_balance !== null && a.max_opening_balance !== undefined
    && after > Number(a.max_opening_balance)) throw err(`ABOVE_THE_MAXIMUM_OPENING_BALANCE: ${a.max_opening_balance}`, 409);
  if (a.max_balance !== null && a.max_balance !== undefined && after > Number(a.max_balance)) {
    throw err(`MAXIMUM_DEPOSIT_BALANCE_EXCEEDED: the balance of the account may not go beyond ${a.max_balance}`, 409);
  }
  return source;
}

/**
 * Money out: the account is open to it (a matured one is), no more than the
 * product's maximum withdrawal in one transaction, and during a fixed
 * deposit's or savings plan's term only with MAKE_EARLY_WITHDRAWALS. A
 * dormant account pays out with POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS.
 */
function assertMayDebit(a, amt, { user = null, day, offsetting = false } = {}) {
  if (a.status === 'DORMANT') need(user, 'POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS');
  else if (!['ACTIVE', 'MATURED'].includes(a.status)) throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (offsetting) return;
  if (a.max_withdrawal_amount !== null && a.max_withdrawal_amount !== undefined && Number(amt) > Number(a.max_withdrawal_amount)) {
    throw err(`ABOVE_THE_MAXIMUM_WITHDRAWAL: ${a.max_withdrawal_amount} in one transaction`, 409);
  }
  if (inTerm(a, day)) {
    if (!user) throw err(`WITHDRAWALS_CLOSED_UNTIL_MATURITY: ${S.ymd(a.maturity_date)}`, 409);
    need(user, 'MAKE_EARLY_WITHDRAWALS');
  }
}

/** A holder's movement: the last financial activity (dormancy), and a dormant account active again. */
async function touch(c, a, day) {
  const { rows: [r] } = await c.query(
    `UPDATE savings_accounts SET last_activity_on = GREATEST(COALESCE(last_activity_on, $2::date), $2::date),
       status = CASE WHEN status = 'DORMANT' THEN 'ACTIVE' ELSE status END WHERE id = $1 RETURNING status`, [a.id, day]);
  if (a.status === 'DORMANT' && r.status === 'ACTIVE') {
    await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ('SYSTEM','SAVINGS_ACCOUNT_REACTIVATED','savings_account',$1,$2,$3)`,
      [a.id, JSON.stringify({ status: 'DORMANT' }), JSON.stringify({ status: 'ACTIVE', on: day })]);
  }
}

// --------------------------------------------------------------------------
// Deposits, withdrawals, transfers
// --------------------------------------------------------------------------

async function deposit(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy, branchId = null, user = null }) {
  const a = await lock(c, accountId);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  const day = valueDate ? S.ymd(valueDate) : await orgToday(c);
  assertMayCredit(a, amt, { user, day });
  const ch = await channels.assertUsable(c, channelId, { side: 'SAVINGS', type: 'DEPOSIT', amount: amt, productId: a.product_id, user });
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const legs = inLegs(a, amt);
  const entryId = await postWithChannel(c, a, {
    channelGl: ch.gl_account_code, amount: amt, direction: 'IN', productLegs: legs.credits,
    narration: narration || `Savings deposit ${a.account_no}`, sourceType: 'SAVINGS_DEPOSIT', channelId,
    valueDate, createdBy, tellerBranch: branchId,
  });
  await c.query(
    `UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3
     WHERE id = $4`, [amt, legs.allocation.odFees, legs.allocation.odInterest, a.id]);
  await touch(c, a, day);
  return record(c, {
    reference: ref('SD'), kind: 'SAVINGS_DEPOSIT', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate, branchId: a.branch_id,
    entryId, narration, createdBy, allocation: legs.allocation,
  });
}

async function withdraw(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy, branchId = null, offsetPledge = null, user = null }) {
  const day = valueDate ? S.ymd(valueDate) : await orgToday(c);
  const a = onDay(await lock(c, accountId), day);
  // `offsetPledge`: a guarantor's pledge being collected (./loanClosures
  // collectSecurities). The deposits it was pledged from need not be
  // withdrawable, and that pledge does not hold them back.
  const offsetting = offsetPledge !== null && offsetPledge !== undefined;
  if (!a.withdrawable && !offsetting) throw err('PRODUCT_NOT_WITHDRAWABLE', 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  assertMayDebit(a, amt, { user, day, offsetting });

  const pledged = round2(await pledgedAmount(c, a.member_id) - (offsetting ? Number(offsetPledge) : 0));
  const available = availableOf(a, pledged);
  if (amt > available) {
    throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}, requested ${amt}` +
      (pledged ? ` (${pledged} pledged as loan security)` : ''), 409);
  }
  // Into a linked overdraft: the credit arrangement's state, expiry and limit.
  await CA.onOverdraw(c, a, amt, day);
  const ch = await channels.assertUsable(c, channelId, { side: 'SAVINGS', type: 'WITHDRAWAL', amount: amt, productId: a.product_id, user });
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const legs = outLegs(a, amt);
  const entryId = await postWithChannel(c, a, {
    channelGl: ch.gl_account_code, amount: amt, direction: 'OUT', productLegs: legs.debits,
    narration: narration || `Savings withdrawal ${a.account_no}`, sourceType: 'SAVINGS_WITHDRAWAL', channelId,
    valueDate, createdBy, tellerBranch: branchId,
  });

  // The floor trigger on savings_accounts is the last line of defence if
  // the availability maths above is ever wrong.
  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, a.id]);
  if (!offsetting) await touch(c, a, day);
  return record(c, {
    reference: ref('SW'), kind: 'SAVINGS_WITHDRAWAL', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate, branchId: a.branch_id,
    entryId, narration, createdBy, allocation: legs.allocation,
  });
}

async function transfer(c, fromId, { toAccountId, amount, valueDate, narration, createdBy, user = null }) {
  // Lock in a deterministic order so two opposing transfers cannot deadlock.
  const ids = [fromId, toAccountId];
  const first = ids.slice().sort()[0];
  await lock(c, first);

  const day = valueDate ? S.ymd(valueDate) : await orgToday(c);
  const from = onDay(await lock(c, fromId), day);
  const to = await lock(c, toAccountId);
  if (from.id === to.id) throw err('SAME_ACCOUNT_TRANSFER');
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  assertMayDebit(from, amt, { user, day });
  assertMayCredit(to, amt, { user, day, source: 'TRANSFER' });

  const pledged = await pledgedAmount(c, from.member_id);
  const available = availableOf(from, pledged);
  if (amt > available) throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}`, 409);
  await CA.onOverdraw(c, from, amt, day);

  const out = outLegs(from, amt);
  const inn = inLegs(to, amt);
  const suspense = await PA.suspense(c);
  const debits = books(from) ? out.debits : [{ glCode: suspense, amount: amt, memberId: from.member_id, branchId: from.branch_id }];
  const credits = books(to) ? inn.credits : [{ glCode: suspense, amount: amt, memberId: to.member_id, branchId: to.branch_id }];
  let entryId = null;
  if (books(from) || books(to)) {
    entryId = (await acct.post(c, {
      debits, credits,
      narration: narration || `Transfer ${from.account_no} to ${to.account_no}`,
      sourceType: 'SAVINGS_TRANSFER', channelId: 'internal', bookingDate: valueDate, createdBy, branchId: from.branch_id,
    })).entryId;
  }

  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, from.id]);
  await c.query(
    `UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3
     WHERE id = $4`, [amt, inn.allocation.odFees, inn.allocation.odInterest, to.id]);
  await touch(c, from, day);
  await touch(c, to, day);

  return record(c, {
    reference: ref('ST'), kind: 'SAVINGS_TRANSFER', memberId: from.member_id,
    savingsAccountId: from.id, channelId: 'internal', amount: amt, valueDate, branchId: from.branch_id,
    entryId, allocation: { toAccountId: to.id, toAccountNo: to.account_no, from: out.allocation, to: inn.allocation },
    narration, createdBy,
  });
}

// --------------------------------------------------------------------------
// Fees
// --------------------------------------------------------------------------

/**
 * Charge a fee. The part the balance covers is income now; the part that
 * overdraws the account is income now under accrual (it joins the overdraft
 * portfolio) and when paid under cash (od_fees_due). A fee may use the
 * authorised overdraft; beyond it only a product with technical overdrafts
 * lets the charge through.
 */
async function applyFee(c, accountId, { feeCode = null, amount = null, name = null, valueDate, createdBy, narration } = {}) {
  const a = await lock(c, accountId);
  if (!['ACTIVE', 'DORMANT', 'LOCKED', 'MATURED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  let fee = null;
  if (feeCode) {
    const { rows: [f] } = await c.query(
      'SELECT * FROM savings_product_fees WHERE product_id = $1 AND (code = $2 OR id::text = $2) AND is_active', [a.product_id, feeCode]);
    if (!f) throw err(`UNKNOWN_FEE: ${feeCode}`, 404);
    fee = f;
  }
  // A fee not defined on the product (the reference platform's arbitrary fee) only where the product allows them.
  if (!fee && a.allow_arbitrary_fees === false) throw err(`ARBITRARY_FEES_NOT_ALLOWED: product ${a.product_id}; define the fee on the product`, 409);
  const amt = round2(amount ?? fee?.amount);
  if (!(amt > 0)) throw err('FEE_NEEDS_AN_AMOUNT', 400);
  const room = round2(Number(a.balance) + Number(a.overdraft_limit || 0));
  if (amt > room && !a.allow_technical_overdraft) throw err(`INSUFFICIENT_BALANCE_FOR_FEE: room ${room}, fee ${amt}`, 409);

  const out = outLegs(a, amt);
  const cashDue = a.accounting_method === 'CASH' ? out.allocation.odPrincipal : 0;
  const recognised = round2(amt - cashDue);
  let entryId = null;
  if (books(a) && recognised > 0) {
    const debits = out.debits.filter((d) => d.glCode === a.gl_liability);
    if (a.accounting_method !== 'CASH' && out.allocation.odPrincipal > 0) debits.push(...out.debits.filter((d) => d.glCode === a.gl_od_portfolio));
    entryId = (await acct.post(c, {
      debits,
      credits: [{ glCode: fee?.gl_income || a.gl_fee_inc, amount: recognised, memberId: a.member_id, branchId: a.branch_id }],
      narration: narration || `${fee?.name || name || 'Fee'} ${a.account_no}`,
      sourceType: 'SAVINGS_FEE', bookingDate: valueDate, createdBy, branchId: a.branch_id,
    })).entryId;
  }
  await c.query('UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2 WHERE id = $3', [amt, cashDue, a.id]);
  return record(c, {
    reference: ref('SF'), kind: 'SAVINGS_FEE', memberId: a.member_id, savingsAccountId: a.id,
    amount: amt, valueDate, branchId: a.branch_id, entryId, createdBy, narration,
    allocation: { fee: fee?.code || null, name: fee?.name || name, ...out.allocation, odFeesDue: cashDue },
  });
}

/**
 * Monthly fees on every open account of products that charge them, dated
 * by each fee's apply date method: the last day of the month (the
 * platform's first rule), the first day of every month, or monthly from
 * the account's activation (the reference platform).
 */
async function applyMonthlyFees(c, { date, createdBy = 'EOD' } = {}) {
  const { rows: all } = await c.query(
    `SELECT a.id, a.opened_on, f.code, COALESCE(f.apply_date_method, 'END_OF_MONTH') AS method FROM savings_accounts a
     JOIN savings_product_fees f ON f.product_id = a.product_id AND f.trigger = 'MONTHLY' AND f.is_active
     WHERE a.status IN ('ACTIVE','DORMANT','MATURED')
       AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.savings_account_id = a.id AND t.kind = 'SAVINGS_FEE'
                         AND t.value_date = $1::date AND t.allocation->>'fee' = f.code AND t.reversed_by IS NULL)
     ORDER BY a.account_no`, [date]);
  const rows = all.filter((r) => DR.isMonthlyFeeDate(date, r.method, S.ymd(r.opened_on)));
  let charged = 0;
  const skipped = [];
  for (const r of rows) {
    await c.query('SAVEPOINT fee');
    try {
      await applyFee(c, r.id, { feeCode: r.code, valueDate: date, createdBy });
      await c.query('RELEASE SAVEPOINT fee');
      charged += 1;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT fee');
      skipped.push({ accountId: r.id, fee: r.code, reason: e.message });
    }
  }
  return { charged, skipped: skipped.length, detail: skipped };
}

// --------------------------------------------------------------------------
// Interest
// --------------------------------------------------------------------------

const DAY = 86400000;
const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const weight = (prev, day, conv) => (conv === 'THIRTY_360' ? S.dayCount(prev, day, 'THIRTY_360') : 1);
// Whether interest is applied on a day: the calendar schedules, and the reference platform's (./depositRules).
const isApplicationDate = DR.isApplicationDate;

/** The index rate of a source on each day of a range, from the rates in force. */
async function indexRates(c, sourceId, from, to) {
  if (!sourceId) return () => null;
  const { rows } = await c.query(
    `SELECT valid_from::text AS d, rate FROM index_rates WHERE source_id = $1 AND valid_from <= $2::date ORDER BY valid_from`, [sourceId, to]);
  return (day) => {
    let r = null;
    for (const x of rows) { if (x.d <= day) r = Number(x.rate); else break; }
    return r;
  };
}

/**
 * Accrue interest through `date`: positive interest on a positive balance,
 * negative interest where the rate is below zero, overdraft interest on a
 * negative balance.
 *
 * Each day's balance is recorded in savings_daily_balances; for days the end
 * of day did not run on (a catch-up), the balance as it stands is used.
 * END_OF_DAY prices each day on that day's balance; MINIMUM prices the
 * period so far on its lowest balance and books the change.
 *
 * Under ACCRUAL with a GL accrual method, what has accrued is booked to the
 * payable (or receivable) as it changes, through ./accruals.
 */
async function accrueInterest(c, accountId, { date, createdBy = 'EOD' } = {}) {
  const a = await lock(c, accountId);
  if (!['ACTIVE', 'DORMANT', 'LOCKED', 'MATURED'].includes(a.status)) return null;
  const interestOn = Boolean(a.interest_paid_into_account) && !a.is_funding_account;
  const opened = S.ymd(a.opened_on);
  const start = a.accrued_through ? S.ymd(a.accrued_through) : addDays(opened, -1);
  if (date <= start) return null;
  const periodStart = a.period_started_on ? S.ymd(a.period_started_on) : opened;
  const conv = a.interest_day_count || 'ACTUAL_365';
  const odConv = a.od_day_count || conv;
  const threshold = a.min_balance_for_interest === null ? null : Number(a.min_balance_for_interest);
  const cap = a.interest_max_balance === null || a.interest_max_balance === undefined ? null : Number(a.interest_max_balance);
  const basis = a.interest_calc_balance || 'END_OF_DAY';
  // Locked accounts earn only if the product collects interest when locked;
  // after maturity only if it accrues after maturity (the reference platform).
  const lockedOut = a.status === 'LOCKED' && a.collect_interest_when_locked === false;
  const maturity = a.maturity_date ? S.ymd(a.maturity_date) : null;
  const creditIndex = await indexRates(c, a.interest_rate_terms === 'INDEX' ? a.interest_index_source_id : null, start, date);
  const odIndex = await indexRates(c, a.od_rate_terms === 'INDEX' ? a.od_index_source_id : null, start, date);
  const { rows: intraday } = await c.query(
    'SELECT day::text AS d, open_balance, min_balance, sum_after, movements FROM savings_intraday_balances WHERE account_id = $1 AND day > $2::date AND day <= $3::date',
    [a.id, start, date]);
  const moves = new Map(intraday.map((x) => [x.d, x]));

  let pos = 0;
  let neg = 0;
  let od = 0;
  for (let d = addDays(start, 1); d <= date; d = addDays(d, 1)) {
    await c.query(
      'INSERT INTO savings_daily_balances (account_id, day, balance) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [a.id, d, a.balance]);
    const { rows: [snap] } = await c.query('SELECT balance FROM savings_daily_balances WHERE account_id = $1 AND day = $2', [a.id, d]);
    const bal = Number(snap.balance);
    const mv = moves.get(d);
    const dayMin = mv ? Math.min(Number(mv.open_balance), Number(mv.min_balance)) : bal;
    const dayAvg = mv ? Number(mv.sum_after) / Number(mv.movements) : bal;
    const w = weight(addDays(d, -1), d, conv);
    const earning = interestOn && !lockedOut && !(maturity && d > maturity && !a.accrue_interest_after_maturity);
    if (earning && basis !== 'MINIMUM') {
      let b = basis === 'MINIMUM_DAILY' ? dayMin : basis === 'AVERAGE_DAILY' ? dayAvg : bal;
      if (basis === 'END_OF_DAY' && cap !== null) b = Math.min(b, cap);
      if (b > 0 && (threshold === null || b >= threshold)) {
        const x = DR.creditOn(a, b, d, { index: creditIndex(d) });
        const amt = x.amount * w / DR.yearDays(conv, d);
        if (amt >= 0) pos += amt; else neg += -amt;
      }
    }
    const odBal = a.od_calc_balance === 'MINIMUM_DAILY' ? dayMin : bal;
    if (odBal < 0) {
      const r = DR.overdraftRateOn(a, -odBal, { index: odIndex(d) });
      if (r > 0) od += -odBal * r / 100 * weight(addDays(d, -1), d, odConv) / DR.yearDays(odConv, d);
    }
  }
  if (interestOn && basis === 'MINIMUM' && !lockedOut) {
    const { rows: [m] } = await c.query(
      'SELECT min(balance) AS lo FROM savings_daily_balances WHERE account_id = $1 AND day BETWEEN $2 AND $3', [a.id, periodStart, date]);
    const lo = Number(m.lo);
    let days = 0;
    for (let d = periodStart; d <= date; d = addDays(d, 1)) days += weight(addDays(d, -1), d, conv);
    const x = lo > 0 && (threshold === null || lo >= threshold) ? DR.creditOn(a, lo, date, { index: creditIndex(date) }) : { amount: 0 };
    const target = x.amount * days / DR.yearDays(conv, date);
    // The period so far is priced again; what changes is booked (either side).
    pos = Math.max(target, 0) - Number(a.interest_accrued);
    neg = Math.max(-target, 0) - Number(a.neg_interest_accrued);
  }
  const posAdd = pos;
  const negAdd = neg;
  const { rows: [u] } = await c.query(
    `UPDATE savings_accounts SET interest_accrued = interest_accrued + $1, neg_interest_accrued = neg_interest_accrued + $2,
       od_interest_accrued = od_interest_accrued + $3, accrued_through = $4::date,
       period_started_on = COALESCE(period_started_on, opened_on)
     WHERE id = $5 RETURNING *`, [posAdd, negAdd, od, date, a.id]);

  // Book what has changed to the ledger.
  let entryId = null;
  if (books(a) && accrues(a)) {
    const comps = [
      ['INTEREST', 'interest_accrued', 'interest_booked', a.gl_interest_exp, a.gl_interest_payable, interestOn],
      ['NEG_INTEREST', 'neg_interest_accrued', 'neg_interest_booked', a.gl_neg_interest_rec, a.gl_neg_interest_inc, interestOn && a.allow_negative_rate],
      ['OD_INTEREST', 'od_interest_accrued', 'od_interest_booked', a.gl_od_interest_rec, a.gl_od_interest_inc, Boolean(a.gl_od_interest_rec)],
    ];
    const lines = [];
    const sets = [];
    for (const [component, accruedCol, bookedCol, dr, cr, on] of comps) {
      if (!on) continue;
      const delta = round2(round2(u[accruedCol]) - Number(u[bookedCol]));
      if (delta === 0) continue;
      lines.push({ component, debitGl: dr, creditGl: cr, amount: delta });
      sets.push(`${bookedCol} = ${bookedCol} + ${delta}`);
    }
    if (lines.length) {
      entryId = await accruals.record(c, {
        kind: 'SAVINGS', product: { ...a, id: a.product_id }, accountId: a.id, memberId: a.member_id, branchId: a.branch_id,
        date, lines, narration: `Deposit interest accrual ${a.account_no} to ${date}`, createdBy,
      });
      await c.query(`UPDATE savings_accounts SET ${sets.join(', ')} WHERE id = $1`, [a.id]);
    }
  }
  return {
    accountId: a.id, through: date,
    interest: round2(u.interest_accrued), negative: round2(u.neg_interest_accrued), overdraft: round2(u.od_interest_accrued), entryId,
  };
}

/**
 * Apply what has accrued to the balance: positive interest (less
 * withholding tax), negative interest, overdraft interest. The sub-cent
 * remainder carries into the next period.
 */
async function applyInterest(c, accountId, { date, createdBy = 'EOD' } = {}) {
  let a = await lock(c, accountId);
  const out = [];
  const pos = round2(a.interest_accrued);
  const neg = round2(a.neg_interest_accrued);
  const odi = round2(a.od_interest_accrued);
  const recognised = books(a) && accrues(a);
  const mid = a.member_id;
  const br = a.branch_id;

  if (pos > 0) {
    const booked = recognised ? Number(a.interest_booked) : 0;
    const inn = inLegs(a, pos);
    let entryId = null;
    if (books(a)) {
      const debits = [];
      if (booked > 0) debits.push({ glCode: a.gl_interest_payable, amount: booked, memberId: mid, branchId: br });
      if (pos - booked > 0) debits.push({ glCode: a.gl_interest_exp, amount: round2(pos - booked), memberId: mid, branchId: br });
      entryId = (await acct.post(c, {
        debits, credits: inn.credits, narration: `Interest applied ${a.account_no}`,
        sourceType: 'SAVINGS_INTEREST_APPLIED', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
      })).entryId;
    }
    await c.query(
      `UPDATE savings_accounts SET balance = balance + $1, interest_accrued = interest_accrued - $1, interest_booked = 0,
         od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3 WHERE id = $4`,
      [pos, inn.allocation.odFees, inn.allocation.odInterest, a.id]);
    out.push(await record(c, {
      reference: ref('SI'), kind: 'SAVINGS_INTEREST_APPLIED', memberId: mid, savingsAccountId: a.id, amount: pos,
      valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, ...inn.allocation },
    }));
    const wht = a.withholding_tax_percent === null ? 0 : round2(pos * Number(a.withholding_tax_percent) / 100);
    if (wht > 0) {
      a = await lock(c, a.id);
      const legs = outLegs(a, wht);
      let taxEntry = null;
      if (books(a)) {
        taxEntry = (await acct.post(c, {
          debits: legs.debits, credits: [{ glCode: a.gl_tax_payable, amount: wht, memberId: mid, branchId: br }],
          narration: `Withholding tax ${a.withholding_tax_percent}% on interest ${a.account_no}`,
          sourceType: 'SAVINGS_WITHHOLDING_TAX', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
        })).entryId;
      }
      await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [wht, a.id]);
      out.push(await record(c, {
        reference: ref('WT'), kind: 'SAVINGS_WITHHOLDING_TAX', memberId: mid, savingsAccountId: a.id, amount: wht,
        valueDate: date, branchId: br, entryId: taxEntry, createdBy,
        allocation: { rate: Number(a.withholding_tax_percent), on: pos, ...legs.allocation },
      }));
    }
  }

  if (neg > 0) {
    a = await lock(c, a.id);
    const room = round2(Number(a.balance) + Number(a.overdraft_limit || 0));
    const charge = a.allow_technical_overdraft ? neg : round2(Math.max(0, Math.min(neg, room)));
    if (charge > 0) {
      const booked = recognised ? Math.min(Number(a.neg_interest_booked), charge) : 0;
      const legs = outLegs(a, charge);
      let entryId = null;
      if (books(a)) {
        const credits = [];
        if (booked > 0) credits.push({ glCode: a.gl_neg_interest_rec, amount: booked, memberId: mid, branchId: br });
        if (charge - booked > 0) credits.push({ glCode: a.gl_neg_interest_inc, amount: round2(charge - booked), memberId: mid, branchId: br });
        entryId = (await acct.post(c, {
          debits: legs.debits, credits, narration: `Negative interest ${a.account_no}`,
          sourceType: 'SAVINGS_NEGATIVE_INTEREST', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
        })).entryId;
      }
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1, neg_interest_accrued = neg_interest_accrued - $2,
           neg_interest_booked = neg_interest_booked - $3 WHERE id = $4`, [charge, neg, booked, a.id]);
      out.push(await record(c, {
        reference: ref('SN'), kind: 'SAVINGS_NEGATIVE_INTEREST', memberId: mid, savingsAccountId: a.id, amount: charge,
        valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, ...legs.allocation },
      }));
    }
  }

  if (odi > 0) {
    a = await lock(c, a.id);
    const booked = recognised ? Number(a.od_interest_booked) : 0;
    const legs = outLegs(a, odi);
    // Under cash, the part that overdraws the account is owed, not earned.
    const cashDue = a.accounting_method === 'CASH' ? legs.allocation.odPrincipal : 0;
    const earned = round2(odi - cashDue);
    let entryId = null;
    if (books(a) && earned > 0) {
      const debits = a.accounting_method === 'CASH' ? legs.debits.filter((d) => d.glCode === a.gl_liability) : legs.debits;
      const credits = [];
      if (booked > 0) credits.push({ glCode: a.gl_od_interest_rec, amount: booked, memberId: mid, branchId: br });
      if (earned - booked > 0) credits.push({ glCode: a.gl_od_interest_inc, amount: round2(earned - booked), memberId: mid, branchId: br });
      entryId = (await acct.post(c, {
        debits, credits, narration: `Overdraft interest ${a.account_no}`,
        sourceType: 'OVERDRAFT_INTEREST_APPLIED', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
      })).entryId;
    }
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, od_interest_accrued = od_interest_accrued - $1,
         od_interest_booked = 0, od_interest_due = od_interest_due + $2 WHERE id = $3`, [odi, cashDue, a.id]);
    out.push(await record(c, {
      reference: ref('OI'), kind: 'OVERDRAFT_INTEREST_APPLIED', memberId: mid, savingsAccountId: a.id, amount: odi,
      valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, odInterestDue: cashDue, ...legs.allocation },
    }));
  }

  await c.query(
    `UPDATE savings_accounts SET last_interest_applied_on = $1::date, period_started_on = ($1::date + 1) WHERE id = $2`, [date, a.id]);
  return out;
}

/**
 * The end of day for deposits: accrue every open account, apply on
 * application dates, mature the fixed deposits and savings plans whose date
 * has come, charge monthly fees, and make dormant the accounts without
 * financial activity for the product's dormancy days (the reference platform: anything but
 * interest postings counts as activity; fees the end of day charges do not).
 */
async function endOfDay(c, { date, createdBy = 'EOD' } = {}) {
  const { rows } = await c.query(
    `SELECT a.id, a.status, a.opened_on, a.maturity_date, p.interest_application, p.interest_fixed_dates
       FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
     WHERE a.status IN ('ACTIVE','DORMANT','LOCKED','MATURED') ORDER BY a.account_no`);
  let accrued = 0;
  let applied = 0;
  let matured = 0;
  for (const r of rows) {
    const x = await accrueInterest(c, r.id, { date, createdBy });
    if (x) accrued += 1;
    if (isApplicationDate(date, { ...r, opened_on: S.ymd(r.opened_on) })) {
      const done = await applyInterest(c, r.id, { date, createdBy });
      if (done.length) applied += 1;
    }
    if (r.maturity_date && S.ymd(r.maturity_date) <= date && ['ACTIVE', 'DORMANT'].includes(r.status)) {
      await c.query("UPDATE savings_accounts SET status = 'MATURED' WHERE id = $1", [r.id]);
      await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'SAVINGS_ACCOUNT_MATURED','savings_account',$2,$3,$4)`,
        [createdBy, r.id, JSON.stringify({ status: r.status }), JSON.stringify({ status: 'MATURED', on: date })]);
      matured += 1;
    }
  }
  const fees = await applyMonthlyFees(c, { date, createdBy });
  const { rows: dormant } = await c.query(
    `UPDATE savings_accounts a SET status = 'DORMANT'
       FROM savings_products p
      WHERE p.id = a.product_id AND a.status = 'ACTIVE' AND p.dormancy_days IS NOT NULL
        AND p.product_type NOT IN ('FIXED_DEPOSIT', 'SAVINGS_PLAN')
        AND COALESCE(a.last_activity_on, a.opened_on) <= ($1::date - p.dormancy_days)
      RETURNING a.id, a.account_no`, [date]);
  for (const d of dormant) {
    await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'SAVINGS_ACCOUNT_DORMANT','savings_account',$2,$3,$4)`,
      [createdBy, d.id, JSON.stringify({ status: 'ACTIVE' }), JSON.stringify({ status: 'DORMANT', on: date })]);
  }
  return { accounts: rows.length, accrued, applied, matured, dormant: dormant.length, fees };
}

// --------------------------------------------------------------------------
// Term and maturity (fixed deposits and savings plans)
// --------------------------------------------------------------------------

/**
 * Start the maturity period (the reference platform's Activate Maturity): once the opening
 * balance is reached, the term runs from today; its length is the one
 * given, the account's, or the product's default, within the product's
 * range. A fixed deposit takes no more deposits; neither pays out during
 * the term without MAKE_EARLY_WITHDRAWALS.
 */
async function startMaturity(c, accountId, { termLength = null, createdBy } = {}) {
  const a = await lock(c, accountId);
  if (!DR.hasTerm(a.product_type)) throw err(`MATURITY_IS_FOR_FIXED_DEPOSITS_AND_SAVINGS_PLANS: ${a.product_type}`, 409);
  if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (a.maturity_started_on) throw err(`MATURITY_ALREADY_STARTED: ${S.ymd(a.maturity_started_on)}`, 409);
  if (a.min_opening_balance !== null && Number(a.balance) < Number(a.min_opening_balance)) {
    throw err(`OPENING_BALANCE_NOT_REACHED: ${a.balance} of ${a.min_opening_balance}`, 409);
  }
  const n = Number(termLength ?? a.term_length ?? a.term_default);
  if (!(Number.isInteger(n) && n > 0)) throw err('TERM_LENGTH_IS_A_WHOLE_NUMBER', 400);
  if (a.term_min !== null && n < Number(a.term_min)) throw err(`TERM_BELOW_THE_PRODUCT_MINIMUM: ${a.term_min} ${a.term_unit}`, 400);
  if (a.term_max !== null && n > Number(a.term_max)) throw err(`TERM_ABOVE_THE_PRODUCT_MAXIMUM: ${a.term_max} ${a.term_unit}`, 400);
  const today = await orgToday(c);
  const due = DR.maturityDate(today, n, a.term_unit);
  const { rows: [r] } = await c.query(
    'UPDATE savings_accounts SET maturity_started_on = $2, maturity_date = $3, term_length = $4 WHERE id = $1 RETURNING *', [a.id, today, due, n]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'SAVINGS_MATURITY_STARTED','savings_account',$2,$3)`,
    [createdBy || 'SYSTEM', a.id, JSON.stringify({ startedOn: today, maturityDate: due, term: `${n} ${a.term_unit}` })]);
  return r;
}

/** Undo the maturity before its date (the reference platform's Undo Maturity). */
async function undoMaturity(c, accountId, { createdBy } = {}) {
  const a = await lock(c, accountId);
  if (!a.maturity_started_on) throw err('MATURITY_NOT_STARTED', 409);
  if (a.status === 'MATURED' || S.ymd(a.maturity_date) <= await orgToday(c)) throw err(`ALREADY_MATURED: ${S.ymd(a.maturity_date)}`, 409);
  const { rows: [r] } = await c.query('UPDATE savings_accounts SET maturity_started_on = NULL, maturity_date = NULL WHERE id = $1 RETURNING *', [a.id]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'SAVINGS_MATURITY_UNDONE','savings_account',$2,$3)`,
    [createdBy || 'SYSTEM', a.id, JSON.stringify({ startedOn: S.ymd(a.maturity_started_on), maturityDate: S.ymd(a.maturity_date) })]);
  return r;
}

// --------------------------------------------------------------------------
// The interest rate of an account (the reference platform's changeInterestRate)
// --------------------------------------------------------------------------

/**
 * Change a fixed-rate account's credit rate from a value date: today, or
 * back to the day after the last interest application (not forward).
 * What accrued from the value date is priced again at the new rate, and
 * the change is booked as accruals are.
 */
async function changeInterestRate(c, accountId, { interestRate, valueDate = null, notes = null, createdBy } = {}) {
  const a = await lock(c, accountId);
  if ((a.interest_rate_terms || 'FIXED') !== 'FIXED') throw err(`THE_RATE_OF_A_${a.interest_rate_terms}_PRODUCT_CHANGES_ON_THE_PRODUCT`, 409);
  if (!['ACTIVE', 'DORMANT', 'LOCKED', 'MATURED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  const rate = Number(interestRate);
  if (!Number.isFinite(rate)) throw err('INTEREST_RATE_IS_A_NUMBER', 400);
  if (rate < 0 && !a.allow_negative_rate) throw err('A_NEGATIVE_RATE_NEEDS_ALLOW_NEGATIVE_RATE', 400);
  if (a.interest_rate_min !== null && rate < Number(a.interest_rate_min)) throw err(`RATE_BELOW_THE_PRODUCT_MINIMUM: ${a.interest_rate_min}`, 400);
  if (a.interest_rate_max !== null && rate > Number(a.interest_rate_max)) throw err(`RATE_ABOVE_THE_PRODUCT_MAXIMUM: ${a.interest_rate_max}`, 400);
  const today = await orgToday(c);
  const from = valueDate ? S.ymd(valueDate) : today;
  if (from > today) throw err('VALUE_DATE_CANNOT_BE_IN_THE_FUTURE', 400);
  const floor = a.last_interest_applied_on ? addDays(S.ymd(a.last_interest_applied_on), 1) : S.ymd(a.opened_on);
  if (from < floor) throw err(`VALUE_DATE_BEFORE_THE_LAST_INTEREST_APPLICATION: from ${floor}`, 400);
  const old = Number(a.interest_rate ?? a.annual_rate);
  // Days already accrued from the value date are priced again.
  let delta = 0;
  const through = a.accrued_through ? S.ymd(a.accrued_through) : null;
  if (through && from <= through && (a.interest_calc_balance || 'END_OF_DAY') !== 'MINIMUM' && a.interest_paid_into_account) {
    const conv = a.interest_day_count || 'ACTUAL_365';
    const { rows: days } = await c.query(
      `SELECT d.day::text AS d, d.balance, x.open_balance, x.min_balance, x.sum_after, x.movements FROM savings_daily_balances d
         LEFT JOIN savings_intraday_balances x ON x.account_id = d.account_id AND x.day = d.day
        WHERE d.account_id = $1 AND d.day BETWEEN $2 AND $3`, [a.id, from, through]);
    const threshold = a.min_balance_for_interest === null ? null : Number(a.min_balance_for_interest);
    for (const r of days) {
      const bal = Number(r.balance);
      let b = a.interest_calc_balance === 'MINIMUM_DAILY' ? (r.movements ? Math.min(Number(r.open_balance), Number(r.min_balance)) : bal)
        : a.interest_calc_balance === 'AVERAGE_DAILY' ? (r.movements ? Number(r.sum_after) / Number(r.movements) : bal) : bal;
      if (a.interest_calc_balance === 'END_OF_DAY' && a.interest_max_balance !== null) b = Math.min(b, Number(a.interest_max_balance));
      if (!(b > 0) || (threshold !== null && b < threshold)) continue;
      const Y = DR.yearDays(conv, r.d);
      delta += b * (rate - old) * DR.annualFactor(a, Y) / 100 * weight(addDays(r.d, -1), r.d, conv) / Y;
    }
  }
  await c.query('UPDATE savings_accounts SET interest_rate = $2 WHERE id = $1', [a.id, rate]);
  if (delta !== 0) {
    await c.query('UPDATE savings_accounts SET interest_accrued = GREATEST(0, interest_accrued + $2) WHERE id = $1', [a.id, delta]);
    if (books(a) && accrues(a)) {
      const u = await lock(c, a.id);
      const change = round2(round2(u.interest_accrued) - Number(u.interest_booked));
      if (change !== 0) {
        await accruals.record(c, {
          kind: 'SAVINGS', product: { ...u, id: u.product_id }, accountId: u.id, memberId: u.member_id, branchId: u.branch_id, date: today,
          lines: [{ component: 'INTEREST', debitGl: u.gl_interest_exp, creditGl: u.gl_interest_payable, amount: change }],
          narration: `Interest rate change ${u.account_no} from ${from}`, createdBy,
        });
        await c.query('UPDATE savings_accounts SET interest_booked = interest_booked + $2 WHERE id = $1', [a.id, change]);
      }
    }
  }
  await c.query(`INSERT INTO savings_interest_rate_changes (product_id, account_id, kind, scope, value_date, old_rate, new_rate, notes, created_by)
    VALUES ($1,$2,'CREDIT','ACCOUNT',$3,$4,$5,$6,$7)`, [a.product_id, a.id, from, old, rate, notes, createdBy || 'SYSTEM']);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'SAVINGS_INTEREST_RATE_CHANGED','savings_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', a.id, JSON.stringify({ interestRate: old }), JSON.stringify({ interestRate: rate, valueDate: from, repriced: round2(delta) })]);
  return { accountId: a.id, interestRate: rate, previousRate: old, valueDate: from, accruedChange: round2(delta) };
}

/** The account's own limits (the reference platform's maximum deposit balance) and notes. */
async function updateAccount(c, accountId, patch = {}, { createdBy } = {}) {
  const a = await lock(c, accountId);
  const sets = {};
  if (patch.maxBalance !== undefined) {
    const v = patch.maxBalance === null || patch.maxBalance === '' ? null : round2(patch.maxBalance);
    if (v !== null && !(v >= 0)) throw err('MAX_BALANCE_IS_ZERO_OR_MORE', 400);
    sets.max_balance = v;
  }
  if (patch.notes !== undefined) sets.notes = patch.notes || null;
  const keys = Object.keys(sets);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS: maxBalance, notes', 400);
  const { rows: [r] } = await c.query(`UPDATE savings_accounts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [a.id, ...keys.map((k) => sets[k])]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'SAVINGS_ACCOUNT_EDITED','savings_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', a.id, JSON.stringify(Object.fromEntries(keys.map((k) => [k, a[k]]))), JSON.stringify(sets)]);
  return r;
}

// --------------------------------------------------------------------------
// Overdrafts
// --------------------------------------------------------------------------

async function setOverdraftLimit(c, accountId, { limit, expiryDate, interestRate, interestSpread, createdBy } = {}) {
  const a = await lock(c, accountId);
  const lim = limit === undefined ? round2(a.overdraft_limit) : round2(limit);
  if (!(lim >= 0)) throw err('INVALID_OVERDRAFT_LIMIT', 400);
  if (lim > 0 && !a.allow_overdraft) throw err('PRODUCT_DOES_NOT_ALLOW_OVERDRAFTS', 409);
  if (a.max_overdraft_limit !== null && lim > Number(a.max_overdraft_limit)) throw err(`OVERDRAFT_LIMIT_ABOVE_PRODUCT_MAXIMUM: ${a.max_overdraft_limit}`, 400);
  if (Number(a.balance) < -lim && !a.allow_technical_overdraft) throw err(`BALANCE_ALREADY_BELOW_THAT_LIMIT: ${a.balance}`, 409);
  // The overdraft expiry date (the reference platform): optional, a date or null to clear it.
  let expires = a.overdraft_expires_on ? S.ymd(a.overdraft_expires_on) : null;
  if (expiryDate !== undefined) {
    if (expiryDate === null || expiryDate === '') expires = null;
    else {
      expires = String(expiryDate).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) throw err('OVERDRAFT_EXPIRY_DATE_IS_A_DATE: yyyy-MM-dd', 400);
    }
  }
  // The credit arrangement it is linked to, or the product's requirement for one.
  await CA.onOverdraft(c, a, { limit: lim, expiresOn: expires });
  // The account's overdraft rate (fixed) or spread (index), within the product's range (the reference platform's Adjust Overdraft Terms).
  let odRate = a.overdraft_rate === null ? null : Number(a.overdraft_rate);
  let odSpread = a.overdraft_spread === null || a.overdraft_spread === undefined ? null : Number(a.overdraft_spread);
  const inRange = (v, lo, hi, what) => {
    if (!Number.isFinite(v)) throw err(`${what}_IS_A_NUMBER`, 400);
    if (lo !== null && lo !== undefined && v < Number(lo)) throw err(`${what}_BELOW_THE_PRODUCT_MINIMUM: ${lo}`, 400);
    if (hi !== null && hi !== undefined && v > Number(hi)) throw err(`${what}_ABOVE_THE_PRODUCT_MAXIMUM: ${hi}`, 400);
  };
  if (interestRate !== undefined) {
    if ((a.od_rate_terms || 'FIXED') !== 'FIXED') throw err(`THE_OVERDRAFT_RATE_OF_A_${a.od_rate_terms}_PRODUCT_IS_SET_ON_THE_PRODUCT`, 409);
    odRate = interestRate === null ? null : Number(interestRate);
    if (odRate !== null) { inRange(odRate, a.od_rate_min, a.od_rate_max, 'OVERDRAFT_RATE'); if (odRate < 0) throw err('OVERDRAFT_RATE_CANNOT_BE_NEGATIVE', 400); }
  }
  if (interestSpread !== undefined) {
    if (a.od_rate_terms !== 'INDEX') throw err('A_SPREAD_IS_FOR_AN_INDEX_OVERDRAFT_RATE', 409);
    odSpread = interestSpread === null ? null : Number(interestSpread);
    if (odSpread !== null) inRange(odSpread, a.od_spread_min, a.od_spread_max, 'OVERDRAFT_SPREAD');
  }
  const { rows: [r] } = await c.query(
    'UPDATE savings_accounts SET overdraft_limit = $1, overdraft_expires_on = $3, overdraft_rate = $4, overdraft_spread = $5 WHERE id = $2 RETURNING *',
    [lim, a.id, expires, odRate, odSpread]);
  for (const [was, now] of [[a.overdraft_rate, odRate], [a.overdraft_spread, odSpread]]) {
    if ((was === null || was === undefined ? null : Number(was)) !== now && (interestRate !== undefined || interestSpread !== undefined)) {
      await c.query(`INSERT INTO savings_interest_rate_changes (product_id, account_id, kind, scope, value_date, old_rate, new_rate, created_by)
        VALUES ($1,$2,'OVERDRAFT','ACCOUNT',current_date,$3,$4,$5)`, [a.product_id, a.id, was, now, createdBy || 'SYSTEM']);
      break;
    }
  }
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'OVERDRAFT_LIMIT_SET','savings_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', a.id, JSON.stringify({ overdraftLimit: Number(a.overdraft_limit), overdraftExpiryDate: a.overdraft_expires_on ? S.ymd(a.overdraft_expires_on) : null }),
      JSON.stringify({ overdraftLimit: lim, overdraftExpiryDate: expires, overdraftRate: odRate, overdraftSpread: odSpread })]);
  return r;
}

/**
 * Write off an overdraft: the balance returns to zero. Under accrual the
 * portfolio (principal, applied interest and fees) and any accrued overdraft
 * interest go to the write-off expense; under cash, charges owed but never
 * recognised are simply cleared.
 */
async function writeOffOverdraft(c, accountId, { narration, createdBy } = {}) {
  const a = await lock(c, accountId);
  const overdrawn = round2(-Number(a.balance));
  if (!(overdrawn > 0)) throw err('ACCOUNT_IS_NOT_OVERDRAWN', 409);
  const cashCharges = round2(Number(a.od_fees_due) + Number(a.od_interest_due));
  const portfolio = round2(overdrawn - cashCharges);
  const accruedOd = round2(a.od_interest_booked);
  let entryId = null;
  if (books(a)) {
    const credits = [];
    if (portfolio > 0) credits.push({ glCode: a.gl_od_portfolio, amount: portfolio, memberId: a.member_id, branchId: a.branch_id });
    if (accruedOd > 0) credits.push({ glCode: a.gl_od_interest_rec, amount: accruedOd, memberId: a.member_id, branchId: a.branch_id });
    const total = round2(portfolio + accruedOd);
    if (total > 0) {
      entryId = (await acct.post(c, {
        debits: [{ glCode: a.gl_od_writeoff, amount: total, memberId: a.member_id, branchId: a.branch_id }],
        credits, narration: narration || `Overdraft write-off ${a.account_no}`,
        sourceType: 'OVERDRAFT_WRITE_OFF', sourceId: a.id, createdBy, branchId: a.branch_id,
      })).entryId;
    }
  }
  await c.query(
    `UPDATE savings_accounts SET balance = 0, od_fees_due = 0, od_interest_due = 0, od_interest_accrued = 0,
       od_interest_booked = 0, overdraft_limit = 0 WHERE id = $1`, [a.id]);
  return record(c, {
    reference: ref('OW'), kind: 'OVERDRAFT_WRITE_OFF', memberId: a.member_id, savingsAccountId: a.id, amount: overdrawn,
    branchId: a.branch_id, entryId, createdBy, narration,
    allocation: { portfolio, accruedInterest: accruedOd, cashChargesCleared: cashCharges },
  });
}

// --------------------------------------------------------------------------
// Reversal
// --------------------------------------------------------------------------

const REVERSIBLE = ['SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER', 'SAVINGS_FEE'];

/**
 * Reverse a posted deposit transaction. Never edits the original. One half
 * of a transfer with a loan (a repayment from this account, a disbursement
 * into it) is reversed with its loan transaction, which reverses both; on
 * its own (`linked` false) it is refused.
 */
async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy, linked = false } = {}) {
  const { rows } = await c.query(
    'SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]
  );
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.savings_account_id) throw err('NOT_A_SAVINGS_TRANSACTION');
  if (!REVERSIBLE.includes(tx.kind)) throw err(`CANNOT_REVERSE_${tx.kind}`, 409);
  if (tx.allocation?.loanTransfer && !linked) {
    throw err(`LINKED_TO_A_LOAN_TRANSACTION: reverse ${tx.allocation.loanTransfer.reference}, which reverses both`, 409);
  }

  const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
  const al = tx.allocation || {};
  const amt = Number(tx.amount);

  if (tx.kind === 'SAVINGS_DEPOSIT') {
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2, od_interest_due = od_interest_due + $3
       WHERE id = $4`, [amt, al.odFees || 0, al.odInterest || 0, tx.savings_account_id]);
  } else if (tx.kind === 'SAVINGS_WITHDRAWAL') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
  } else if (tx.kind === 'SAVINGS_FEE') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2 WHERE id = $3',
      [amt, al.odFeesDue || 0, tx.savings_account_id]);
  } else if (tx.kind === 'SAVINGS_TRANSFER') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
    if (al.toAccountId) {
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2, od_interest_due = od_interest_due + $3
         WHERE id = $4`, [amt, al.to?.odFees || 0, al.to?.odInterest || 0, al.toAccountId]);
    }
  }

  const rev = await record(c, {
    reference: ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    savingsAccountId: tx.savings_account_id, amount: -tx.amount, branchId: tx.branch_id,
    entryId: entry.entryId, allocation: { reversalOf: tx.reference }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

// --------------------------------------------------------------------------
// Opening
// --------------------------------------------------------------------------

async function open(c, { memberId, productId = 'SAV01', accountNo, branchId = undefined, overdraftLimit = 0, openedOn = null, customFields: cf = {}, user = null,
  interestRate = undefined, interestSpread = undefined, overdraftRate = undefined, overdraftSpread = undefined, maxBalance = undefined, termLength = undefined }) {
  const { rows: [p] } = await c.query('SELECT * FROM savings_products WHERE id = $1', [productId]);
  if (!p) throw err('UNKNOWN_DEPOSIT_PRODUCT', 404);
  if (p.is_active === false) throw err('DEPOSIT_PRODUCT_INACTIVE', 409);
  const lim = round2(overdraftLimit || 0);
  if (lim > 0 && !p.allow_overdraft) throw err('PRODUCT_DOES_NOT_ALLOW_OVERDRAFTS', 409);
  // An overdraft under a product that requires a credit arrangement is set once the account is linked.
  if (lim > 0 && p.credit_arrangement_requirement === 'REQUIRED') throw err(`OVERDRAFT_NEEDS_A_CREDIT_ARRANGEMENT: product ${p.id} requires one`, 409);
  if (lim > 0 && p.max_overdraft_limit !== null && lim > Number(p.max_overdraft_limit)) {
    throw err(`OVERDRAFT_LIMIT_ABOVE_PRODUCT_MAXIMUM: ${p.max_overdraft_limit}`, 400);
  }
  const { rows: [m] } = await c.query('SELECT branch_id FROM members WHERE id = $1', [memberId]);
  if (!m) throw err('MEMBER_NOT_FOUND', 404);
  const branch = branchId === undefined ? m.branch_id : branchId;
  // The product must be offered in the account's branch (the reference platform's product availability).
  if (p.branch_ids && p.branch_ids.length && branch && !p.branch_ids.includes(branch)) {
    throw err(`DEPOSIT_PRODUCT_NOT_AVAILABLE_IN_THIS_BRANCH: ${p.id}`, 409);
  }
  // The account's own terms, within the product's ranges (the reference platform's new account settings).
  const own = accountTerms(p, { interestRate, interestSpread, overdraftRate, overdraftSpread, maxBalance, termLength });
  const values = await customFields.prepare(c, 'SAVINGS_ACCOUNT', { item: p.id, patch: cf || {}, user, creating: true });
  const no = accountNo || await NUMBERS.forProduct(c, p);
  const { rows } = await c.query(
    `INSERT INTO savings_accounts (account_no, member_id, product_id, status, branch_id, overdraft_limit, opened_on, period_started_on, custom_fields,
       interest_rate, interest_spread, overdraft_rate, overdraft_spread, max_balance, term_length, last_activity_on)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,COALESCE($6::date, current_date),COALESCE($6::date, current_date),$7,$8,$9,$10,$11,$12,$13,COALESCE($6::date, current_date))
     RETURNING *`,
    [no, memberId, productId, branch, lim, openedOn, JSON.stringify(values),
      own.interestRate, own.interestSpread, own.overdraftRate, own.overdraftSpread, own.maxBalance, own.termLength]
  );
  return rows[0];
}

/** An account's own rate, spread, maximum balance and term, checked against its product. */
function accountTerms(p, x) {
  const out = { interestRate: null, interestSpread: null, overdraftRate: null, overdraftSpread: null, maxBalance: null, termLength: null };
  const within = (v, lo, hi, what) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw err(`${what}_IS_A_NUMBER`, 400);
    if (lo !== null && lo !== undefined && n < Number(lo)) throw err(`${what}_BELOW_THE_PRODUCT_MINIMUM: ${lo}`, 400);
    if (hi !== null && hi !== undefined && n > Number(hi)) throw err(`${what}_ABOVE_THE_PRODUCT_MAXIMUM: ${hi}`, 400);
    return n;
  };
  if (x.interestRate !== undefined && x.interestRate !== null) {
    if ((p.interest_rate_terms || 'FIXED') !== 'FIXED') throw err(`A_${p.interest_rate_terms}_PRODUCT_SETS_THE_RATE`, 400);
    out.interestRate = within(x.interestRate, p.interest_rate_min, p.interest_rate_max, 'INTEREST_RATE');
    if (out.interestRate < 0 && !p.allow_negative_rate) throw err('A_NEGATIVE_RATE_NEEDS_ALLOW_NEGATIVE_RATE', 400);
  }
  if (x.interestSpread !== undefined && x.interestSpread !== null) {
    if (p.interest_rate_terms !== 'INDEX') throw err('A_SPREAD_IS_FOR_AN_INDEX_RATE', 400);
    out.interestSpread = within(x.interestSpread, p.interest_spread_min, p.interest_spread_max, 'INTEREST_SPREAD');
  }
  if (x.overdraftRate !== undefined && x.overdraftRate !== null) {
    if (!p.allow_overdraft || (p.od_rate_terms || 'FIXED') !== 'FIXED') throw err('AN_OVERDRAFT_RATE_NEEDS_A_FIXED_OVERDRAFT_RATE_PRODUCT', 400);
    out.overdraftRate = within(x.overdraftRate, p.od_rate_min, p.od_rate_max, 'OVERDRAFT_RATE');
  }
  if (x.overdraftSpread !== undefined && x.overdraftSpread !== null) {
    if (p.od_rate_terms !== 'INDEX') throw err('A_SPREAD_IS_FOR_AN_INDEX_OVERDRAFT_RATE', 400);
    out.overdraftSpread = within(x.overdraftSpread, p.od_spread_min, p.od_spread_max, 'OVERDRAFT_SPREAD');
  }
  if (x.maxBalance !== undefined && x.maxBalance !== null) out.maxBalance = within(x.maxBalance, 0, null, 'MAX_BALANCE');
  if (x.termLength !== undefined && x.termLength !== null) {
    if (!DR.hasTerm(p.product_type)) throw err('A_TERM_IS_FOR_FIXED_DEPOSITS_AND_SAVINGS_PLANS', 400);
    out.termLength = within(x.termLength, p.term_min, p.term_max, 'TERM_LENGTH');
    if (!Number.isInteger(out.termLength) || out.termLength <= 0) throw err('TERM_LENGTH_IS_A_WHOLE_NUMBER', 400);
  }
  return out;
}

/**
 * Close a deposit account (the reference platform's Close), which a member's exit needs. Only
 * an account with nothing in it and nothing owed on it closes: a zero
 * balance, no interest accrued or booked, no overdraft interest or fees due,
 * and not the settlement account of a running loan. Closing a member's last
 * open account makes the member INACTIVE (tenant migration 033).
 */
async function closeAccount(c, accountId, { createdBy, notes = null } = {}) {
  const a = await lock(c, accountId);
  if (!['ACTIVE', 'DORMANT', 'MATURED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  const left = ['balance', 'interest_accrued', 'neg_interest_accrued', 'od_interest_accrued', 'interest_booked', 'neg_interest_booked',
    'od_interest_booked', 'od_interest_due', 'od_fees_due'].filter((k) => Number(a[k] || 0) !== 0);
  if (left.length) throw err(`ACCOUNT_NOT_EMPTY: ${left.join(', ')}`, 409);
  const { rows: [l] } = await c.query(
    "SELECT account_no FROM loan_accounts WHERE settlement_account_id = $1 AND status NOT LIKE 'CLOSED%' LIMIT 1", [a.id]);
  if (l) throw err(`SETTLEMENT_ACCOUNT_OF_A_RUNNING_LOAN: ${l.account_no}`, 409);
  const { rows: [out] } = await c.query(
    `UPDATE savings_accounts SET status = 'CLOSED', closed_on = current_date, notes = COALESCE($2, notes), updated_at = now()
     WHERE id = $1 RETURNING *`, [a.id, notes]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'SAVINGS_ACCOUNT_CLOSED','savings_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', a.id, JSON.stringify({ status: a.status }), JSON.stringify({ status: 'CLOSED', closedOn: out.closed_on })]);
  return out;
}

module.exports = {
  closeAccount, lockedFunding, open, deposit, withdraw, transfer, summary, reverseTransaction, pledgedAmount, lock, record, ref,
  applyFee, applyMonthlyFees, accrueInterest, applyInterest, endOfDay, isApplicationDate,
  setOverdraftLimit, writeOffOverdraft, inLegs, outLegs, availableOf, onDay, books,
  startMaturity, undoMaturity, changeInterestRate, updateAccount, accountTerms,
};
