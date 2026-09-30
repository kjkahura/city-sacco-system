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
const { recordAudit } = require('../lib/auditLog');
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
  p.od_spread_default, p.od_rate_tiers, p.od_day_count, p.od_calc_balance, p.initial_state, p.allow_offset,
  p.withholding_source_id AS product_withholding_source_id,
  p.interest_review_count, p.interest_review_unit, p.od_review_count, p.od_review_unit`;

// The states an account is open in (it holds money, earns and is charged).
const OPEN = ['ACTIVE', 'IN_ARREARS', 'DORMANT', 'LOCKED', 'MATURED'];
// The reference platform's accountState for a state here (a closed account by how it was closed).
const apiState = (a) => (a.status === 'IN_ARREARS' ? 'ACTIVE_IN_ARREARS'
  : a.status !== 'CLOSED' || !a.closed_as ? a.status
    : { REJECTED: 'CLOSED_REJECTED', WITHDRAWN: 'WITHDRAWN', WRITTEN_OFF: 'CLOSED_WRITTEN_OFF' }[a.closed_as]);

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
  const hb = await heldBack(c, a.id);
  const overdrawn = round2(Math.max(0, -Number(a.balance)));
  const avail = round2(Math.max(0, availableOf(a, pledged) - hb.blocked - hb.holds));
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
    available: avail,
    // The reference platform's balances (Deposit Account Overview Details).
    balances: {
      totalBalance: round2(a.balance), availableBalance: avail,
      overdraftAvailable: round2(Math.max(0, Number(a.overdraft_limit || 0) - overdrawn)),
      holdBalance: hb.holds, lockedBalance: pledged, blockedBalance: hb.blocked, overdraftAmountDue: overdrawn,
      pendingCredits: hb.credits,
    },
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
    maxWithdrawalAmount: maxWithdrawal(a),
    recommendedDepositAmount: a.own_recommended_deposit !== null && a.own_recommended_deposit !== undefined ? Number(a.own_recommended_deposit)
      : a.recommended_deposit_amount === null ? null : Number(a.recommended_deposit_amount),
    withholdingTaxSourceId: a.withholding_source_id || a.product_withholding_source_id || null,
    maturity: DR.hasTerm(a.product_type) ? {
      termLength: a.term_length ?? a.term_default, termUnit: a.term_unit,
      startedOn: a.maturity_started_on ? S.ymd(a.maturity_started_on) : null, maturityDate: a.maturity_date ? S.ymd(a.maturity_date) : null,
      minOpeningBalance: a.min_opening_balance === null ? null : Number(a.min_opening_balance),
    } : null,
    lastActivityOn: a.last_activity_on ? S.ymd(a.last_activity_on) : null,
    name: a.name || a.product_name, ownName: a.name || null,
    accountState: apiState(a), closedAs: a.closed_as || null,
    approvedOn: a.approved_on ? S.ymd(a.approved_on) : null, activatedOn: a.activated_on ? S.ymd(a.activated_on) : null,
    lockedOn: a.locked_on ? S.ymd(a.locked_on) : null, stateBeforeLock: a.state_before_lock || null,
    inArrearsSince: a.in_arrears_since ? S.ymd(a.in_arrears_since) : null,
    closedOn: a.closed_on ? S.ymd(a.closed_on) : null, allowOffset: Boolean(a.allow_offset),
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

// The most one withdrawal may take: the account's own maximum or the
// product's, the lower where both are set (the reference platform's account-level limit).
const maxWithdrawal = (a) => {
  const xs = [a.own_max_withdrawal, a.max_withdrawal_amount].filter((v) => v !== null && v !== undefined).map(Number);
  return xs.length ? Math.min(...xs) : null;
};
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
  else if (!['ACTIVE', 'IN_ARREARS', 'APPROVED'].includes(a.status)) throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
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
  else if (!['ACTIVE', 'IN_ARREARS', 'MATURED', 'APPROVED'].includes(a.status)) throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (offsetting) return;
  const most = maxWithdrawal(a);
  if (most !== null && Number(amt) > most) throw err(`ABOVE_THE_MAXIMUM_WITHDRAWAL: ${most} in one transaction`, 409);
  if (inTerm(a, day)) {
    if (!user) throw err(`WITHDRAWALS_CLOSED_UNTIL_MATURITY: ${S.ymd(a.maturity_date)}`, 409);
    need(user, 'MAKE_EARLY_WITHDRAWALS');
  }
}

/**
 * A holder's movement: the last financial activity (dormancy), a dormant
 * account active again, and an approved account activated by its first
 * transaction (the reference platform). An activated account earns from the day of that
 * transaction, not from the day it was opened. The account leaves arrears
 * once the balance is back within what the overdraft lends.
 */
async function touch(c, a, day) {
  const { rows: [r] } = await c.query(
    `UPDATE savings_accounts SET last_activity_on = GREATEST(COALESCE(last_activity_on, $2::date), $2::date),
       status = CASE WHEN status IN ('DORMANT', 'APPROVED') THEN 'ACTIVE' ELSE status END,
       activated_on = CASE WHEN status = 'APPROVED' THEN $2::date ELSE activated_on END,
       period_started_on = CASE WHEN status = 'APPROVED' THEN $2::date ELSE period_started_on END,
       accrued_through = CASE WHEN status = 'APPROVED' THEN $2::date - 1 ELSE accrued_through END
     WHERE id = $1 RETURNING status`, [a.id, day]);
  if (['DORMANT', 'APPROVED'].includes(a.status) && r.status === 'ACTIVE') {
    await recordAudit(c, { actor: 'SYSTEM', action: a.status === 'DORMANT' ? 'SAVINGS_ACCOUNT_REACTIVATED' : 'SAVINGS_ACCOUNT_ACTIVATED', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ status: a.status }), after: JSON.stringify({ status: 'ACTIVE', on: day }) });
  }
  await followArrears(c, a.id, day);
}

/**
 * In Arrears (the reference platform): an account overdrawn past its overdraft expiry date,
 * or one whose overdraft limit was lowered below what it owes
 * (`limitChanged`). It is ACTIVE again once the balance is back within what
 * the overdraft lends. An account that went below zero through a fee or
 * interest under a technical overdraft stays ACTIVE, as before.
 */
async function followArrears(c, id, day, { limitChanged = false, createdBy = 'SYSTEM' } = {}) {
  const { rows: [a] } = await c.query('SELECT id, status, balance, overdraft_limit, overdraft_expires_on FROM savings_accounts WHERE id = $1', [id]);
  if (!a || !['ACTIVE', 'IN_ARREARS'].includes(a.status)) return null;
  const expired = Boolean(a.overdraft_expires_on) && S.ymd(a.overdraft_expires_on) < day;
  const lends = expired ? 0 : Number(a.overdraft_limit);
  const bal = Number(a.balance);
  const beyond = bal < 0 && -bal > lends;
  let next = null;
  if (a.status === 'IN_ARREARS' && !beyond) next = 'ACTIVE';
  else if (a.status === 'ACTIVE' && beyond && (expired || limitChanged)) next = 'IN_ARREARS';
  if (!next) return null;
  await c.query("UPDATE savings_accounts SET status = $2, in_arrears_since = CASE WHEN $2 = 'IN_ARREARS' THEN $3::date END WHERE id = $1", [id, next, day]);
  await recordAudit(c, { actor: createdBy, action: next === 'IN_ARREARS' ? 'SAVINGS_ACCOUNT_IN_ARREARS' : 'SAVINGS_ACCOUNT_OUT_OF_ARREARS', entity: 'savings_account', entityId: id, before: JSON.stringify({ status: a.status, balance: bal }), after: JSON.stringify({ status: next, on: day, reason: next === 'ACTIVE' ? 'COVERED' : expired ? 'OVERDRAFT_EXPIRED' : 'LIMIT_BELOW_BALANCE' }) });
  return next;
}

/**
 * The value date of a holder's movement. A staff user (`user`) may not date
 * one in the future, and needs BACKDATE_SAVINGS_TRANSACTIONS to date one in
 * the past, back no further than the day after the last interest
 * application (the interest from that day is priced again). Callers inside
 * the platform (the end of day, loan transfers, imports) date as they did.
 */
async function valueDay(c, a, valueDate, user) {
  const today = await orgToday(c);
  const day = valueDate ? S.ymd(valueDate) : today;
  if (user) {
    if (day > today) throw err(`VALUE_DATE_CANNOT_BE_IN_THE_FUTURE: ${day}`, 400);
    if (day < today) {
      need(user, 'BACKDATE_SAVINGS_TRANSACTIONS');
      const floor = repriceFloor(a);
      if (a.accrued_through && day <= S.ymd(a.accrued_through) && day < floor) {
        throw err(`BACKDATED_BEFORE_THE_LAST_INTEREST_APPLICATION: the earliest value date is ${floor}`, 409);
      }
    }
  }
  return { day, today };
}

/**
 * The reference platform refuses a backdated withdrawal that takes the account below what it
 * may owe on a day already past. Only the days recorded are checked.
 */
async function assertBackdatedFloor(c, a, day, delta) {
  if (a.allow_technical_overdraft) return;
  const { rows: [r] } = await c.query(
    'SELECT min(balance) AS lo, (array_agg(day::text ORDER BY balance))[1] AS lo_day FROM savings_daily_balances WHERE account_id = $1 AND day >= $2', [a.id, day]);
  if (r.lo === null) return;
  if (Number(r.lo) + delta < -Number(a.overdraft_limit || 0)) {
    throw err(`BACKDATED_WITHDRAWAL_WOULD_OVERDRAW: the balance on ${r.lo_day} would be ${round2(Number(r.lo) + delta)}`, 409);
  }
}

/** What is held back from the holder: pending blocks (less what was seized) and debit holds, and credit holds on their way. */
async function heldBack(c, accountId) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE((SELECT sum(amount - seized) FROM savings_blocks WHERE account_id = $1 AND state = 'PENDING'), 0) AS blocked,
            COALESCE((SELECT sum(amount) FROM savings_holds WHERE account_id = $1 AND state = 'PENDING' AND indicator = 'DBIT'), 0) AS holds,
            COALESCE((SELECT sum(amount) FROM savings_holds WHERE account_id = $1 AND state = 'PENDING' AND indicator = 'CRDT'), 0) AS credits`, [accountId]);
  return { blocked: round2(r.blocked), holds: round2(r.holds), credits: round2(r.credits) };
}

/**
 * The hold a deposit (CRDT) or withdrawal (DBIT) settles (the reference platform: the
 * transaction names holdExternalReferenceId, for exactly the amount held,
 * with no value date). Settling needs UPDATE_HOLDS.
 */
async function holdToSettle(c, a, reference, indicator, amt, { valueDate, user }) {
  if (!reference) return null;
  need(user, 'UPDATE_HOLDS');
  if (valueDate) throw err('A_VALUE_DATE_IS_NOT_TAKEN_WITH_A_HOLD', 400);
  const { rows: [h] } = await c.query('SELECT * FROM savings_holds WHERE external_reference_id = $1 FOR UPDATE', [String(reference)]);
  if (!h || h.account_id !== a.id) throw err(`HOLD_NOT_FOUND: ${reference}`, 404);
  if (h.state !== 'PENDING') throw err(`HOLD_IS_${h.state}: ${reference}`, 409);
  if (h.indicator !== indicator) throw err(`A_${h.indicator}_HOLD_IS_SETTLED_BY_A_${h.indicator === 'DBIT' ? 'WITHDRAWAL' : 'DEPOSIT'}`, 409);
  if (round2(h.amount) !== round2(amt)) throw err(`THE_AMOUNT_MUST_MATCH_THE_HOLD: ${round2(h.amount)}`, 409);
  return h;
}

async function settleHold(c, h, t) {
  await c.query("UPDATE savings_holds SET state = 'SETTLED', transaction_id = $2, closed_at = now() WHERE id = $1", [h.id, t.id]);
}

// --------------------------------------------------------------------------
// Deposits, withdrawals, transfers
// --------------------------------------------------------------------------

async function deposit(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy, branchId = null, user = null, holdExternalReferenceId = null }) {
  const a = await lock(c, accountId);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  const hold = await holdToSettle(c, a, holdExternalReferenceId, 'CRDT', amt, { valueDate, user });
  const { day } = await valueDay(c, a, valueDate, user);
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
  const repriced = await repriceFrom(c, a.id, day, amt, { createdBy });
  const t = await record(c, {
    reference: ref('SD'), kind: 'SAVINGS_DEPOSIT', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate, branchId: a.branch_id,
    entryId, narration, createdBy, allocation: { ...legs.allocation, ...(repriced ? { repricedFrom: day } : {}), ...(hold ? { hold: hold.external_reference_id } : {}) },
  });
  if (hold) await settleHold(c, hold, t);
  return t;
}
async function withdraw(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy, branchId = null, offsetPledge = null, user = null, holdExternalReferenceId = null }) {
  const locked = await lock(c, accountId);
  const hold = await holdToSettle(c, locked, holdExternalReferenceId, 'DBIT', round2(amount), { valueDate, user });
  const { day } = await valueDay(c, locked, valueDate, user);
  const a = onDay(locked, day);
  // `offsetPledge`: a guarantor's pledge being collected (./loanClosures
  // collectSecurities). The deposits it was pledged from need not be
  // withdrawable, and that pledge does not hold them back.
  const offsetting = offsetPledge !== null && offsetPledge !== undefined;
  if (!a.withdrawable && !offsetting) throw err('PRODUCT_NOT_WITHDRAWABLE', 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  assertMayDebit(a, amt, { user, day, offsetting });

  const pledged = round2(await pledgedAmount(c, a.member_id) - (offsetting ? Number(offsetPledge) : 0));
  // Blocked funds and debit holds are not available (the reference platform); the hold this
  // withdrawal settles is.
  const hb = await heldBack(c, a.id);
  const available = round2(availableOf(a, pledged) - hb.blocked - hb.holds + (hold ? Number(hold.amount) : 0));
  if (amt > available) {
    throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}, requested ${amt}` +
      (pledged ? ` (${pledged} pledged as loan security)` : '') + (hb.blocked ? ` (${hb.blocked} blocked)` : '') + (hb.holds ? ` (${hb.holds} on hold)` : ''), 409);
  }
  if (user) await assertBackdatedFloor(c, a, day, -amt);
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
  const repriced = await repriceFrom(c, a.id, day, -amt, { createdBy });
  const t = await record(c, {
    reference: ref('SW'), kind: 'SAVINGS_WITHDRAWAL', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate, branchId: a.branch_id,
    entryId, narration, createdBy, allocation: { ...legs.allocation, ...(repriced ? { repricedFrom: day } : {}), ...(hold ? { hold: hold.external_reference_id } : {}) },
  });
  if (hold) await settleHold(c, hold, t);
  return t;
}
async function transfer(c, fromId, { toAccountId, amount, valueDate, narration, createdBy, user = null }) {
  // Lock in a deterministic order so two opposing transfers cannot deadlock.
  const ids = [fromId, toAccountId];
  const first = ids.slice().sort()[0];
  await lock(c, first);

  const fromLocked = await lock(c, fromId);
  const { day } = await valueDay(c, fromLocked, valueDate, user);
  const from = onDay(fromLocked, day);
  const to = await lock(c, toAccountId);
  if (from.id === to.id) throw err('SAME_ACCOUNT_TRANSFER');
  // To another holder's account (the reference platform's inter-client transfer).
  if (from.member_id !== to.member_id) need(user, 'MAKE_INTER_CLIENTS_TRANSFERS');
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  assertMayDebit(from, amt, { user, day });
  assertMayCredit(to, amt, { user, day, source: 'TRANSFER' });

  const pledged = await pledgedAmount(c, from.member_id);
  const hb = await heldBack(c, from.id);
  const available = round2(availableOf(from, pledged) - hb.blocked - hb.holds);
  if (amt > available) throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}`, 409);
  if (user) await assertBackdatedFloor(c, from, day, -amt);
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
  const r1 = await repriceFrom(c, from.id, day, -amt, { createdBy });
  const r2 = await repriceFrom(c, to.id, day, amt, { createdBy });

  return record(c, {
    reference: ref('ST'), kind: 'SAVINGS_TRANSFER', memberId: from.member_id,
    savingsAccountId: from.id, channelId: 'internal', amount: amt, valueDate, branchId: from.branch_id,
    entryId, allocation: { toAccountId: to.id, toAccountNo: to.account_no, from: out.allocation, to: inn.allocation, ...(r1 || r2 ? { repricedFrom: day } : {}) },
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
  // A locked account takes no transactions (the reference platform).
  if (a.status === 'LOCKED') throw err('ACCOUNT_LOCKED: unlock it first', 409);
  if (!['ACTIVE', 'IN_ARREARS', 'DORMANT', 'MATURED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
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
 * the account's activation (the reference platform). A dormant account is charged no
 * automated fee, and a locked one nothing (the reference platform).
 */
async function applyMonthlyFees(c, { date, createdBy = 'EOD' } = {}) {
  const { rows: all } = await c.query(
    `SELECT a.id, a.opened_on, f.code, COALESCE(f.apply_date_method, 'END_OF_MONTH') AS method FROM savings_accounts a
     JOIN savings_product_fees f ON f.product_id = a.product_id AND f.trigger = 'MONTHLY' AND f.is_active
     WHERE a.status IN ('ACTIVE','IN_ARREARS','MATURED')
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

/**
 * The index rate of a source on each day of a range, from the rates in
 * force. With a review frequency (the reference platform's Interest Rate Review Frequency:
 * every `count` DAYS, WEEKS or MONTHS from the account's activation) a day
 * takes the rate in force on its latest review date; without one, the rate
 * in force that day.
 */
async function indexRates(c, sourceId, from, to, review = null) {
  if (!sourceId) return () => null;
  const { rows } = await c.query(
    `SELECT valid_from::text AS d, rate FROM index_rates WHERE source_id = $1 AND valid_from <= $2::date ORDER BY valid_from`, [sourceId, to]);
  const on = (day) => {
    let r = null;
    for (const x of rows) { if (x.d <= day) r = Number(x.rate); else break; }
    return r;
  };
  if (!review || !review.count || !review.unit || !review.anchor) return on;
  return (day) => on(DR.reviewDate(review.anchor, day, review.count, review.unit));
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
/** What the accrual of an account needs for a range of days: its rules, and the index rates in force. */
async function accrualContext(c, a, start, date) {
  const conv = a.interest_day_count || 'ACTUAL_365';
  return {
    interestOn: Boolean(a.interest_paid_into_account) && !a.is_funding_account,
    conv, odConv: a.od_day_count || conv,
    threshold: a.min_balance_for_interest === null ? null : Number(a.min_balance_for_interest),
    cap: a.interest_max_balance === null || a.interest_max_balance === undefined ? null : Number(a.interest_max_balance),
    basis: a.interest_calc_balance || 'END_OF_DAY',
    // Locked accounts earn only if the product collects interest when locked;
    // after maturity only if it accrues after maturity (the reference platform).
    lockedOut: a.status === 'LOCKED' && a.collect_interest_when_locked === false,
    // A dormant account accrues no interest, credit or overdraft (the reference platform); its days are still recorded.
    dormant: a.status === 'DORMANT',
    maturity: a.maturity_date ? S.ymd(a.maturity_date) : null,
    creditIndex: await indexRates(c, a.interest_rate_terms === 'INDEX' ? a.interest_index_source_id : null, start, date,
      { count: a.interest_review_count, unit: a.interest_review_unit, anchor: S.ymd(a.activated_on || a.opened_on) }),
    odIndex: await indexRates(c, a.od_rate_terms === 'INDEX' ? a.od_index_source_id : null, start, date,
      { count: a.od_review_count, unit: a.od_review_unit, anchor: S.ymd(a.activated_on || a.opened_on) }),
  };
}

/**
 * One day's interest on an account: credit (or negative) interest on the
 * day's balance by the product's basis (not MINIMUM, which prices the
 * period), and overdraft interest on what is overdrawn.
 */
function dayInterest(a, x, d, bal, mv) {
  const dayMin = mv ? Math.min(Number(mv.open_balance), Number(mv.min_balance)) : bal;
  const dayAvg = mv ? Number(mv.sum_after) / Number(mv.movements) : bal;
  const w = weight(addDays(d, -1), d, x.conv);
  let pos = 0;
  let neg = 0;
  let od = 0;
  const earning = x.interestOn && !x.lockedOut && !x.dormant && !(x.maturity && d > x.maturity && !a.accrue_interest_after_maturity);
  if (earning && x.basis !== 'MINIMUM') {
    let b = x.basis === 'MINIMUM_DAILY' ? dayMin : x.basis === 'AVERAGE_DAILY' ? dayAvg : bal;
    if (x.basis === 'END_OF_DAY' && x.cap !== null) b = Math.min(b, x.cap);
    if (b > 0 && (x.threshold === null || b >= x.threshold)) {
      const r = DR.creditOn(a, b, d, { index: x.creditIndex(d) });
      const amt = r.amount * w / DR.yearDays(x.conv, d);
      if (amt >= 0) pos += amt; else neg += -amt;
    }
  }
  const odBal = a.od_calc_balance === 'MINIMUM_DAILY' ? dayMin : bal;
  if (odBal < 0 && !x.dormant) {
    const r = DR.overdraftRateOn(a, -odBal, { index: x.odIndex(d) });
    if (r > 0) od += -odBal * r / 100 * weight(addDays(d, -1), d, x.odConv) / DR.yearDays(x.odConv, d);
  }
  return { pos, neg, od };
}

/** Book to the ledger what has accrued and is not yet booked, under accrual accounting (./accruals). */
async function bookAccrued(c, a, u, date, narration, createdBy) {
  if (!(books(a) && accrues(a))) return null;
  const interestOn = Boolean(a.interest_paid_into_account) && !a.is_funding_account;
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
  if (!lines.length) return null;
  const entryId = await accruals.record(c, {
    kind: 'SAVINGS', product: { ...a, id: a.product_id }, accountId: a.id, memberId: a.member_id, branchId: a.branch_id,
    date, lines, narration, createdBy,
  });
  await c.query(`UPDATE savings_accounts SET ${sets.join(', ')} WHERE id = $1`, [a.id]);
  return entryId;
}

async function accrueInterest(c, accountId, { date, createdBy = 'EOD' } = {}) {
  const a = await lock(c, accountId);
  if (!OPEN.includes(a.status)) return null;
  const opened = S.ymd(a.opened_on);
  const start = a.accrued_through ? S.ymd(a.accrued_through) : addDays(opened, -1);
  if (date <= start) return null;
  const periodStart = a.period_started_on ? S.ymd(a.period_started_on) : opened;
  const x = await accrualContext(c, a, start, date);
  const { rows: intraday } = await c.query(
    'SELECT day::text AS d, open_balance, min_balance, sum_after, movements FROM savings_intraday_balances WHERE account_id = $1 AND day > $2::date AND day <= $3::date',
    [a.id, start, date]);
  const moves = new Map(intraday.map((m) => [m.d, m]));

  let pos = 0;
  let neg = 0;
  let od = 0;
  for (let d = addDays(start, 1); d <= date; d = addDays(d, 1)) {
    await c.query(
      'INSERT INTO savings_daily_balances (account_id, day, balance) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [a.id, d, a.balance]);
    const { rows: [snap] } = await c.query('SELECT balance FROM savings_daily_balances WHERE account_id = $1 AND day = $2', [a.id, d]);
    const day = dayInterest(a, x, d, Number(snap.balance), moves.get(d));
    pos += day.pos; neg += day.neg; od += day.od;
  }
  if (x.interestOn && x.basis === 'MINIMUM' && !x.lockedOut && !x.dormant) {
    const { rows: [m] } = await c.query(
      'SELECT min(balance) AS lo FROM savings_daily_balances WHERE account_id = $1 AND day BETWEEN $2 AND $3', [a.id, periodStart, date]);
    const lo = Number(m.lo);
    let days = 0;
    for (let d = periodStart; d <= date; d = addDays(d, 1)) days += weight(addDays(d, -1), d, x.conv);
    const r = lo > 0 && (x.threshold === null || lo >= x.threshold) ? DR.creditOn(a, lo, date, { index: x.creditIndex(date) }) : { amount: 0 };
    const target = r.amount * days / DR.yearDays(x.conv, date);
    // The period so far is priced again; what changes is booked (either side).
    pos = Math.max(target, 0) - Number(a.interest_accrued);
    neg = Math.max(-target, 0) - Number(a.neg_interest_accrued);
  }
  const { rows: [u] } = await c.query(
    `UPDATE savings_accounts SET interest_accrued = interest_accrued + $1, neg_interest_accrued = neg_interest_accrued + $2,
       od_interest_accrued = od_interest_accrued + $3, accrued_through = $4::date,
       period_started_on = COALESCE(period_started_on, opened_on)
     WHERE id = $5 RETURNING *`, [pos, neg, od, date, a.id]);
  // Book what has changed to the ledger.
  const entryId = await bookAccrued(c, a, u, date, `Deposit interest accrual ${a.account_no} to ${date}`, createdBy);
  return {
    accountId: a.id, through: date,
    interest: round2(u.interest_accrued), negative: round2(u.neg_interest_accrued), overdraft: round2(u.od_interest_accrued), entryId,
  };
}

/**
 * The first day a movement may be dated and priced again: the day after the
 * last interest application, or the day the account started earning
 * (The reference platform reposts applied interest too; here what was applied stays).
 */
function repriceFloor(a) {
  if (a.last_interest_applied_on) return addDays(S.ymd(a.last_interest_applied_on), 1);
  return S.ymd(a.activated_on || a.opened_on);
}

/**
 * A backdated movement (or the reversal of one) of `delta` on `day`: the
 * recorded daily balances from that day to the last day accrued move by it,
 * the interest on those days is priced again, and the change is booked.
 * The movement counts from the start of its day. Under the MINIMUM
 * (period) basis the next accrual prices the period again itself.
 */
async function repriceFrom(c, accountId, day, delta, { createdBy } = {}) {
  const a = await lock(c, accountId);
  const through = a.accrued_through ? S.ymd(a.accrued_through) : null;
  if (!through || day > through || delta === 0 || day < repriceFloor(a)) return null;
  const x = await accrualContext(c, a, addDays(day, -1), through);
  const { rows } = await c.query(
    `SELECT d.day::text AS d, d.balance, m.open_balance, m.min_balance, m.sum_after, m.movements
       FROM savings_daily_balances d LEFT JOIN savings_intraday_balances m ON m.account_id = d.account_id AND m.day = d.day
      WHERE d.account_id = $1 AND d.day BETWEEN $2 AND $3 ORDER BY d.day`, [a.id, day, through]);
  let pos = 0;
  let neg = 0;
  let od = 0;
  for (const r of rows) {
    const mv = r.movements ? r : null;
    const was = dayInterest(a, x, r.d, Number(r.balance), mv);
    const moved = mv ? { open_balance: Number(r.open_balance) + delta, min_balance: Number(r.min_balance) + delta,
      sum_after: Number(r.sum_after) + delta * Number(r.movements), movements: r.movements } : null;
    const now = dayInterest(a, x, r.d, Number(r.balance) + delta, moved);
    pos += now.pos - was.pos; neg += now.neg - was.neg; od += now.od - was.od;
  }
  await c.query('UPDATE savings_daily_balances SET balance = balance + $2 WHERE account_id = $1 AND day BETWEEN $3 AND $4', [a.id, delta, day, through]);
  await c.query(`UPDATE savings_intraday_balances SET open_balance = open_balance + $2, min_balance = min_balance + $2, sum_after = sum_after + $2 * movements
                  WHERE account_id = $1 AND day BETWEEN $3 AND $4`, [a.id, delta, day, through]);
  if (x.basis === 'MINIMUM') { pos = 0; neg = 0; }
  const { rows: [u] } = await c.query(
    `UPDATE savings_accounts SET interest_accrued = GREATEST(0, interest_accrued + $2), neg_interest_accrued = GREATEST(0, neg_interest_accrued + $3),
       od_interest_accrued = GREATEST(0, od_interest_accrued + $4) WHERE id = $1 RETURNING *`, [a.id, pos, neg, od]);
  const entryId = await bookAccrued(c, a, u, await orgToday(c), `Interest priced again ${a.account_no} from ${day}`, createdBy || 'SYSTEM');
  return { from: day, through, interest: pos, negative: neg, overdraft: od, entryId };
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
    const whtRate = await withholdingRate(c, a, date);
    const wht = whtRate === null ? 0 : round2(pos * whtRate / 100);
    if (wht > 0) {
      a = await lock(c, a.id);
      const legs = outLegs(a, wht);
      let taxEntry = null;
      if (books(a)) {
        taxEntry = (await acct.post(c, {
          debits: legs.debits, credits: [{ glCode: a.gl_tax_payable, amount: wht, memberId: mid, branchId: br }],
          narration: `Withholding tax ${whtRate}% on interest ${a.account_no}`,
          sourceType: 'SAVINGS_WITHHOLDING_TAX', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
        })).entryId;
      }
      await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [wht, a.id]);
      out.push(await record(c, {
        reference: ref('WT'), kind: 'SAVINGS_WITHHOLDING_TAX', memberId: mid, savingsAccountId: a.id, amount: wht,
        valueDate: date, branchId: br, entryId: taxEntry, createdBy,
        allocation: { rate: whtRate, on: pos, interestReference: out[out.length - 1].reference, ...legs.allocation },
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
 * application dates (not on dormant accounts), mature the fixed deposits and savings plans whose date
 * has come, charge monthly fees, and make dormant the accounts without
 * financial activity for the product's dormancy days (the reference platform: anything but
 * interest postings counts as activity; fees the end of day charges do not).
 */
async function endOfDay(c, { date, createdBy = 'EOD' } = {}) {
  const { rows } = await c.query(
    `SELECT a.id, a.status, a.opened_on, a.maturity_date, p.interest_application, p.interest_fixed_dates
       FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
     WHERE a.status = ANY($1) ORDER BY a.account_no`, [OPEN]);
  let accrued = 0;
  let applied = 0;
  let matured = 0;
  for (const r of rows) {
    const x = await accrueInterest(c, r.id, { date, createdBy });
    if (x) accrued += 1;
    // A dormant account gets no automated transactions (the reference platform): what it
    // accrued before is applied once it is active again.
    if (r.status !== 'DORMANT' && isApplicationDate(date, { ...r, opened_on: S.ymd(r.opened_on) })) {
      const done = await applyInterest(c, r.id, { date, createdBy });
      if (done.length) applied += 1;
    }
    if (r.maturity_date && S.ymd(r.maturity_date) <= date && ['ACTIVE', 'DORMANT'].includes(r.status)) {
      await c.query("UPDATE savings_accounts SET status = 'MATURED' WHERE id = $1", [r.id]);
      await recordAudit(c, { actor: createdBy, action: 'SAVINGS_ACCOUNT_MATURED', entity: 'savings_account', entityId: r.id, before: JSON.stringify({ status: r.status }), after: JSON.stringify({ status: 'MATURED', on: date }) });
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
    await recordAudit(c, { actor: createdBy, action: 'SAVINGS_ACCOUNT_DORMANT', entity: 'savings_account', entityId: d.id, before: JSON.stringify({ status: 'ACTIVE' }), after: JSON.stringify({ status: 'DORMANT', on: date }) });
  }
  // In Arrears: overdrawn past the overdraft expiry date, or covered again.
  const { rows: watch } = await c.query(
    `SELECT id FROM savings_accounts WHERE status = 'IN_ARREARS'
        OR (status = 'ACTIVE' AND balance < 0 AND overdraft_expires_on < $1::date) ORDER BY account_no`, [date]);
  let inArrears = 0;
  for (const w of watch) if (await followArrears(c, w.id, date, { createdBy }) === 'IN_ARREARS') inArrears += 1;
  return { accounts: rows.length, accrued, applied, matured, dormant: dormant.length, inArrears, fees };
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
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_MATURITY_STARTED', entity: 'savings_account', entityId: a.id, after: JSON.stringify({ startedOn: today, maturityDate: due, term: `${n} ${a.term_unit}` }) });
  return r;
}

/** Undo the maturity before its date (the reference platform's Undo Maturity). */
async function undoMaturity(c, accountId, { createdBy } = {}) {
  const a = await lock(c, accountId);
  if (!a.maturity_started_on) throw err('MATURITY_NOT_STARTED', 409);
  if (a.status === 'MATURED' || S.ymd(a.maturity_date) <= await orgToday(c)) throw err(`ALREADY_MATURED: ${S.ymd(a.maturity_date)}`, 409);
  const { rows: [r] } = await c.query('UPDATE savings_accounts SET maturity_started_on = NULL, maturity_date = NULL WHERE id = $1 RETURNING *', [a.id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_MATURITY_UNDONE', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ startedOn: S.ymd(a.maturity_started_on), maturityDate: S.ymd(a.maturity_date) }) });
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
  if (!OPEN.includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
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
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_INTEREST_RATE_CHANGED', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ interestRate: old }), after: JSON.stringify({ interestRate: rate, valueDate: from, repriced: round2(delta) }) });
  return { accountId: a.id, interestRate: rate, previousRate: old, valueDate: from, accruedChange: round2(delta) };
}

/**
 * The account's own maximum withdrawal and recommended deposit (the reference platform's
 * account-level amounts). The maximum may not exceed the product's.
 */
function ownLimits(p, x) {
  const out = {};
  if (x.maxWithdrawalAmount !== undefined) {
    const v = x.maxWithdrawalAmount === null || x.maxWithdrawalAmount === '' ? null : round2(x.maxWithdrawalAmount);
    if (v !== null && !(v > 0)) throw err('MAX_WITHDRAWAL_AMOUNT_IS_MORE_THAN_ZERO', 400);
    if (v !== null && p.max_withdrawal_amount !== null && p.max_withdrawal_amount !== undefined && v > Number(p.max_withdrawal_amount)) {
      throw err(`MAX_WITHDRAWAL_AMOUNT_ABOVE_THE_PRODUCT_MAXIMUM: ${p.max_withdrawal_amount}`, 400);
    }
    out.own_max_withdrawal = v;
  }
  if (x.recommendedDepositAmount !== undefined) {
    const v = x.recommendedDepositAmount === null || x.recommendedDepositAmount === '' ? null : round2(x.recommendedDepositAmount);
    if (v !== null && !(v > 0)) throw err('RECOMMENDED_DEPOSIT_AMOUNT_IS_MORE_THAN_ZERO', 400);
    out.own_recommended_deposit = v;
  }
  return out;
}

// The account's terms, which the reference platform lets be edited only before activation.
const TERM_FIELDS = { interestRate: 'interest_rate', interestSpread: 'interest_spread', overdraftRate: 'overdraft_rate',
  overdraftSpread: 'overdraft_spread', termLength: 'term_length' };

/**
 * Edit an account (the reference platform's Editing Accounts). The name, notes and custom
 * field values change at any time, and the maximum balance (the reference platform's
 * maximum deposit balance) too. The terms (the account's interest rate or
 * spread, its overdraft rate or spread, and the term of a fixed deposit or
 * savings plan) change only before activation, within the product's
 * ranges; after it the rate changes through :changeInterestRate and the
 * overdraft through PUT /overdraft.
 */
async function updateAccount(c, accountId, patch = {}, { createdBy, user = null } = {}) {
  const a = await lock(c, accountId);
  const sets = {};
  if (patch.maxBalance !== undefined) {
    const v = patch.maxBalance === null || patch.maxBalance === '' ? null : round2(patch.maxBalance);
    if (v !== null && !(v >= 0)) throw err('MAX_BALANCE_IS_ZERO_OR_MORE', 400);
    sets.max_balance = v;
  }
  if (patch.notes !== undefined) sets.notes = patch.notes || null;
  Object.assign(sets, ownLimits(a, patch));
  if (patch.name !== undefined) {
    const n = patch.name === null ? null : String(patch.name).trim();
    if (n !== null && n.length > 255) throw err('NAME_IS_AT_MOST_255_CHARACTERS', 400);
    sets.name = n || null;
  }
  const terms = Object.keys(TERM_FIELDS).filter((k) => patch[k] !== undefined);
  if (terms.length) {
    if (!['PENDING_APPROVAL', 'APPROVED'].includes(a.status)) {
      throw err(`TERMS_ARE_EDITED_BEFORE_ACTIVATION: ${terms.join(', ')} on a ${a.status} account; change the rate with :changeInterestRate and the overdraft with PUT /overdraft`, 409);
    }
    const own = accountTerms(a, Object.fromEntries(terms.map((k) => [k, patch[k] === '' ? null : patch[k]])));
    for (const k of terms) sets[TERM_FIELDS[k]] = patch[k] === null || patch[k] === '' ? null : own[k];
  }
  const hasFields = patch.customFields !== undefined && patch.customFields !== null;
  const keys = Object.keys(sets);
  if (!keys.length && !hasFields) throw err(`NO_UPDATABLE_FIELDS: name, notes, maxBalance, maxWithdrawalAmount, recommendedDepositAmount, customFields, and before activation ${Object.keys(TERM_FIELDS).join(', ')}`, 400);
  let r = a;
  if (keys.length) {
    r = (await c.query(`UPDATE savings_accounts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [a.id, ...keys.map((k) => sets[k])])).rows[0];
    await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_ACCOUNT_EDITED', entity: 'savings_account', entityId: a.id, before: JSON.stringify(Object.fromEntries(keys.map((k) => [k, a[k] ?? null]))), after: JSON.stringify(sets) });
  }
  if (hasFields) {
    await customFields.setValues(c, 'SAVINGS_ACCOUNT', a.id, patch.customFields, { user, createdBy });
    r = (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [a.id])).rows[0];
  }
  return r;
}

// --------------------------------------------------------------------------
// Overdrafts
// --------------------------------------------------------------------------

async function setOverdraftLimit(c, accountId, { limit, expiryDate, interestRate, interestSpread, createdBy } = {}) {
  const a = await lock(c, accountId);
  // The reference platform adjusts overdraft terms on active accounts (and one in arrears is
  // active); before activation they are part of the account's terms.
  if (!['ACTIVE', 'IN_ARREARS', 'PENDING_APPROVAL', 'APPROVED'].includes(a.status)) {
    throw err(`OVERDRAFT_TERMS_ARE_ADJUSTED_ON_ACTIVE_ACCOUNTS: the account is ${a.status}`, 409);
  }
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
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'OVERDRAFT_LIMIT_SET', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ overdraftLimit: Number(a.overdraft_limit), overdraftExpiryDate: a.overdraft_expires_on ? S.ymd(a.overdraft_expires_on) : null }), after: JSON.stringify({ overdraftLimit: lim, overdraftExpiryDate: expires, overdraftRate: odRate, overdraftSpread: odSpread }) });
  if (await followArrears(c, a.id, await orgToday(c), { limitChanged: lim < Number(a.overdraft_limit), createdBy: createdBy || 'SYSTEM' })) {
    return (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [a.id])).rows[0];
  }
  return r;
}

/**
 * Write off an overdraft: the balance returns to zero. Under accrual the
 * portfolio (principal, applied interest and fees) and any accrued overdraft
 * interest go to the write-off expense; under cash, charges owed but never
 * recognised are simply cleared.
 */
async function writeOffOverdraft(c, accountId, { narration, createdBy, closing = false } = {}) {
  const a = await lock(c, accountId);
  if (a.status === 'LOCKED' && !closing) throw err('ACCOUNT_LOCKED: unlock it first', 409);
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
  const t = await record(c, {
    reference: ref('OW'), kind: 'OVERDRAFT_WRITE_OFF', memberId: a.member_id, savingsAccountId: a.id, amount: overdrawn,
    branchId: a.branch_id, entryId, createdBy, narration,
    // What it cleared, so that undoing a closing write-off puts it back.
    allocation: { portfolio, accruedInterest: accruedOd, cashChargesCleared: cashCharges,
      cleared: { odFeesDue: Number(a.od_fees_due), odInterestDue: Number(a.od_interest_due), odInterestAccrued: Number(a.od_interest_accrued),
        odInterestBooked: Number(a.od_interest_booked), overdraftLimit: Number(a.overdraft_limit) },
      closing, statusBefore: a.status },
  });
  if (!closing) await followArrears(c, a.id, await orgToday(c), { createdBy: createdBy || 'SYSTEM' });
  return t;
}

// --------------------------------------------------------------------------
// Reversal
// --------------------------------------------------------------------------

const REVERSIBLE = ['SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER', 'SAVINGS_FEE', 'SAVINGS_SEIZURE',
  'SAVINGS_INTEREST_APPLIED', 'SAVINGS_WITHHOLDING_TAX'];

/** Refuse a reversal that would take an account without a technical overdraft below what it may owe. */
async function assertMayLower(c, id, amt) {
  const a = await lock(c, id);
  if (!a.allow_technical_overdraft && Number(a.balance) - amt < -Number(a.overdraft_limit || 0)) {
    throw err(`REVERSAL_WOULD_OVERDRAW: ${a.account_no} would go to ${round2(Number(a.balance) - amt)}`, 409);
  }
}

/**
 * Reverse a posted deposit transaction (the reference platform's Adjusting Transactions).
 * Never edits the original. The account must be open. A deposit,
 * withdrawal, transfer, fee or seizure dated after the last interest
 * application has the interest from its date priced again. Interest
 * applied goes back to accrued, with its withholding tax; only the latest
 * application is reversed. One half of a transfer with a loan (a repayment
 * from this account, a disbursement into it) is reversed with its loan
 * transaction, which reverses both; on its own (`linked` false) it is
 * refused.
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
  // The reference platform: reversals on offset deposit accounts are not supported.
  const { rows: [off] } = await c.query(
    `SELECT l.account_no FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
      WHERE l.settlement_account_id = ANY($1::uuid[]) AND p.offset_enabled AND l.status NOT LIKE 'CLOSED%' LIMIT 1`,
    [[tx.savings_account_id, tx.allocation?.toAccountId].filter(Boolean)]);
  if (off) throw err(`REVERSAL_NOT_SUPPORTED_ON_AN_OFFSET_ACCOUNT: the account offsets loan ${off.account_no}`, 409);
  if (tx.allocation?.loanTransfer && !linked) {
    throw err(`LINKED_TO_A_LOAN_TRANSACTION: reverse ${tx.allocation.loanTransfer.reference}, which reverses both`, 409);
  }
  // The reference platform: the account must be open to adjust its transactions.
  const { rows: closed } = await c.query("SELECT account_no FROM savings_accounts WHERE id = ANY($1::uuid[]) AND status = 'CLOSED'",
    [[tx.savings_account_id, tx.allocation?.toAccountId].filter(Boolean)]);
  if (closed.length) throw err(`ACCOUNT_IS_CLOSED: ${closed.map((r) => r.account_no).join(', ')}`, 409);

  const al = tx.allocation || {};
  const amt = Number(tx.amount);
  const day = tx.value_date ? S.ymd(tx.value_date) : null;
  const extra = [];

  if (tx.kind === 'SAVINGS_INTEREST_APPLIED') {
    const { rows: [later] } = await c.query(
      `SELECT reference FROM transactions WHERE savings_account_id = $1 AND kind = 'SAVINGS_INTEREST_APPLIED' AND reversed_by IS NULL
          AND id <> $2 AND (value_date > $3 OR (value_date = $3 AND created_at > $4)) LIMIT 1`,
      [tx.savings_account_id, tx.id, tx.value_date, tx.created_at]);
    if (later) throw err(`REVERSE_THE_LATEST_INTEREST_APPLICATION_FIRST: ${later.reference}`, 409);
    await assertMayLower(c, tx.savings_account_id, amt);
  } else if (['SAVINGS_DEPOSIT'].includes(tx.kind)) {
    await assertMayLower(c, tx.savings_account_id, amt);
  } else if (tx.kind === 'SAVINGS_TRANSFER' && al.toAccountId) {
    await assertMayLower(c, al.toAccountId, amt);
  }

  const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
  let repriced = null;

  if (tx.kind === 'SAVINGS_DEPOSIT') {
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2, od_interest_due = od_interest_due + $3
       WHERE id = $4`, [amt, al.odFees || 0, al.odInterest || 0, tx.savings_account_id]);
    repriced = await repriceFrom(c, tx.savings_account_id, day, -amt, { createdBy });
  } else if (tx.kind === 'SAVINGS_WITHDRAWAL') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
    repriced = await repriceFrom(c, tx.savings_account_id, day, amt, { createdBy });
  } else if (tx.kind === 'SAVINGS_FEE') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2 WHERE id = $3',
      [amt, al.odFeesDue || 0, tx.savings_account_id]);
    repriced = await repriceFrom(c, tx.savings_account_id, day, amt, { createdBy });
  } else if (tx.kind === 'SAVINGS_TRANSFER') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
    repriced = await repriceFrom(c, tx.savings_account_id, day, amt, { createdBy });
    if (al.toAccountId) {
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2, od_interest_due = od_interest_due + $3
         WHERE id = $4`, [amt, al.to?.odFees || 0, al.to?.odInterest || 0, al.toAccountId]);
      await repriceFrom(c, al.toAccountId, day, -amt, { createdBy });
    }
  } else if (tx.kind === 'SAVINGS_SEIZURE') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
    await c.query("UPDATE savings_blocks SET seized = seized - $2, state = 'PENDING', closed_at = NULL WHERE id = $1", [al.blockId, amt]);
    repriced = await repriceFrom(c, tx.savings_account_id, day, amt, { createdBy });
  } else if (tx.kind === 'SAVINGS_WITHHOLDING_TAX') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
  } else if (tx.kind === 'SAVINGS_INTEREST_APPLIED') {
    // The interest goes back to accrued (and booked, as far as it was), to be applied again.
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, interest_accrued = interest_accrued + $1, interest_booked = interest_booked + $2,
         od_fees_due = od_fees_due + $3, od_interest_due = od_interest_due + $4 WHERE id = $5`,
      [amt, Number(al.booked || 0), al.odFees || 0, al.odInterest || 0, tx.savings_account_id]);
    // Its withholding tax is reversed with it.
    const { rows: taxes } = await c.query(
      `SELECT reference FROM transactions WHERE savings_account_id = $1 AND kind = 'SAVINGS_WITHHOLDING_TAX' AND reversed_by IS NULL
          AND (allocation->>'interestReference' = $2 OR (allocation->>'interestReference' IS NULL AND value_date = $3 AND created_at >= $4))`,
      [tx.savings_account_id, tx.reference, tx.value_date, tx.created_at]);
    for (const t of taxes) extra.push(await reverseTransaction(c, t.reference, { narration, createdBy }));
    // The account's last application moves back when nothing else was applied that day.
    const { rows: [other] } = await c.query(
      `SELECT 1 FROM transactions WHERE savings_account_id = $1 AND value_date = $2 AND reversed_by IS NULL AND id <> $3
          AND kind IN ('SAVINGS_INTEREST_APPLIED', 'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED') LIMIT 1`,
      [tx.savings_account_id, tx.value_date, tx.id]);
    if (!other) {
      const { rows: [prev] } = await c.query(
        `SELECT max(value_date)::text AS d FROM transactions WHERE savings_account_id = $1 AND reversed_by IS NULL AND id <> $2
            AND kind IN ('SAVINGS_INTEREST_APPLIED', 'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED')`, [tx.savings_account_id, tx.id]);
      await c.query(
        `UPDATE savings_accounts SET last_interest_applied_on = $2::date,
           period_started_on = COALESCE($2::date + 1, activated_on, opened_on) WHERE id = $1`, [tx.savings_account_id, prev.d]);
    }
  }

  const rev = await record(c, {
    reference: ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    savingsAccountId: tx.savings_account_id, amount: -tx.amount, branchId: tx.branch_id,
    entryId: entry.entryId, allocation: { reversalOf: tx.reference, ...(repriced ? { repricedFrom: day } : {}),
      ...(extra.length ? { alsoReversed: extra.map((x) => x.allocation.reversalOf) } : {}) }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

// --------------------------------------------------------------------------
// Blocked funds and seizures (the reference platform's Blocking Funds in Deposit Accounts)
// --------------------------------------------------------------------------

const BLOCKABLE = ['ACTIVE', 'IN_ARREARS', 'LOCKED', 'DORMANT'];
const blockOut = (b) => ({
  externalReferenceId: b.reference, accountKey: b.account_id, amount: Number(b.amount), seizedAmount: Number(b.seized),
  state: b.state, notes: b.notes, creationDate: b.created_at, closedDate: b.closed_at || null,
});

/** Block an amount (it may exceed the available balance). Interest accrues on the total balance still. */
async function blockFunds(c, accountId, { externalReferenceId = null, amount, notes = null, createdBy } = {}) {
  const a = await lock(c, accountId);
  if (!BLOCKABLE.includes(a.status)) throw err(`FUNDS_ARE_BLOCKED_ON_OPEN_ACCOUNTS: the account is ${a.status}`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT', 400);
  const refId = externalReferenceId ? String(externalReferenceId).slice(0, 64) : ref('BLK');
  const { rows: [dupe] } = await c.query('SELECT 1 FROM savings_blocks WHERE account_id = $1 AND reference = $2', [a.id, refId]);
  if (dupe) throw err(`BLOCK_REFERENCE_IN_USE: ${refId}`, 409);
  const { rows: [b] } = await c.query(
    'INSERT INTO savings_blocks (account_id, reference, amount, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [a.id, refId, amt, notes, createdBy || 'SYSTEM']);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_FUNDS_BLOCKED', entity: 'savings_account', entityId: a.id, after: JSON.stringify({ reference: refId, amount: amt, notes }) });
  return blockOut(b);
}

async function blocksOf(c, accountId) {
  const a = await lock(c, accountId);
  const { rows } = await c.query('SELECT * FROM savings_blocks WHERE account_id = $1 ORDER BY created_at', [a.id]);
  return rows.map(blockOut);
}

/** Unblock what is still blocked of a pending block (the reference platform: only a pending block, on an open account). */
async function unblockFunds(c, accountId, reference, { createdBy } = {}) {
  const a = await lock(c, accountId);
  if (!BLOCKABLE.includes(a.status)) throw err(`FUNDS_ARE_UNBLOCKED_ON_OPEN_ACCOUNTS: the account is ${a.status}`, 409);
  const { rows: [b] } = await c.query('SELECT * FROM savings_blocks WHERE account_id = $1 AND reference = $2 FOR UPDATE', [a.id, String(reference)]);
  if (!b) throw err(`BLOCK_NOT_FOUND: ${reference}`, 404);
  if (b.state !== 'PENDING') throw err(`BLOCK_IS_${b.state}`, 409);
  const { rows: [u] } = await c.query("UPDATE savings_blocks SET state = 'UNBLOCKED', closed_at = now() WHERE id = $1 RETURNING *", [b.id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_FUNDS_UNBLOCKED', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ reference: b.reference, amount: Number(b.amount), seized: Number(b.seized) }) });
  return blockOut(u);
}

/**
 * Seize blocked funds (the reference platform's seizure transaction, "Seized Amount"): all or
 * part of what a pending block still holds, no more than the balance. The
 * money leaves through the channel given (bank by default). The block is
 * SEIZED once nothing of it is left.
 */
async function seizeFunds(c, accountId, { blockId, amount, channelId = 'bank', notes = null, createdBy, user = null } = {}) {
  const a = await lock(c, accountId);
  if (!BLOCKABLE.includes(a.status)) throw err(`FUNDS_ARE_SEIZED_ON_OPEN_ACCOUNTS: the account is ${a.status}`, 409);
  const { rows: [b] } = await c.query('SELECT * FROM savings_blocks WHERE account_id = $1 AND (reference = $2 OR id::text = $2) FOR UPDATE',
    [a.id, String(blockId || '')]);
  if (!b) throw err(`BLOCK_NOT_FOUND: ${blockId}`, 404);
  if (b.state !== 'PENDING') throw err(`BLOCK_IS_${b.state}`, 409);
  const left = round2(Number(b.amount) - Number(b.seized));
  const amt = round2(amount ?? left);
  if (!(amt > 0)) throw err('INVALID_AMOUNT', 400);
  if (amt > left) throw err(`ABOVE_WHAT_THE_BLOCK_HOLDS: ${left}`, 409);
  if (amt > round2(a.balance)) throw err(`ABOVE_THE_BALANCE: ${round2(a.balance)}`, 409);
  const ch = await channels.assertUsable(c, channelId, { side: 'SAVINGS', type: 'WITHDRAWAL', amount: amt, productId: a.product_id, user });
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);
  const legs = outLegs(a, amt);
  const entryId = await postWithChannel(c, a, {
    channelGl: ch.gl_account_code, amount: amt, direction: 'OUT', productLegs: legs.debits,
    narration: notes || `Seizure ${a.account_no} (${b.reference})`, sourceType: 'SAVINGS_SEIZURE', channelId, createdBy,
  });
  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, a.id]);
  const seized = round2(Number(b.seized) + amt);
  await c.query('UPDATE savings_blocks SET seized = $2, state = $3, closed_at = CASE WHEN $3 = \'SEIZED\' THEN now() END WHERE id = $1',
    [b.id, seized, seized >= Number(b.amount) ? 'SEIZED' : 'PENDING']);
  return record(c, {
    reference: ref('SZ'), kind: 'SAVINGS_SEIZURE', memberId: a.member_id, savingsAccountId: a.id, channelId, amount: amt,
    branchId: a.branch_id, entryId, narration: notes, createdBy, allocation: { blockId: b.id, block: b.reference, ...legs.allocation },
  });
}

// --------------------------------------------------------------------------
// Transaction holds (the reference platform's Transaction Holds)
// --------------------------------------------------------------------------

const holdOut = (h) => ({
  externalReferenceId: h.external_reference_id, accountKey: h.account_id, creditDebitIndicator: h.indicator, amount: Number(h.amount),
  status: h.state, notes: h.notes, creationDate: h.created_at, closedDate: h.closed_at || null, transactionKey: h.transaction_id || null,
});

/**
 * Hold an amount (the reference platform's POST /deposits/{id}/authorizationholds): a debit
 * (DBIT) no larger than what is available, which it makes unavailable, or
 * a credit (CRDT) on its way. The external reference is unique and at most
 * 32 characters. Holds on deposit accounts do not expire.
 */
async function createHold(c, accountId, { externalReferenceId, amount, creditDebitIndicator = 'DBIT', notes = null, createdBy } = {}) {
  const a = await lock(c, accountId);
  const ind = String(creditDebitIndicator || 'DBIT').toUpperCase();
  if (!['DBIT', 'CRDT'].includes(ind)) throw err('CREDIT_DEBIT_INDICATOR_IS_DBIT_OR_CRDT', 400);
  const refId = String(externalReferenceId || '').trim();
  if (!refId || refId.length > 32) throw err('EXTERNAL_REFERENCE_ID_IS_1_TO_32_CHARACTERS', 400);
  const open = ind === 'DBIT' ? ['ACTIVE', 'IN_ARREARS', 'MATURED', 'DORMANT'] : ['ACTIVE', 'IN_ARREARS', 'APPROVED', 'DORMANT'];
  if (!open.includes(a.status)) throw err(`A_${ind}_HOLD_IS_NOT_TAKEN_ON_A_${a.status}_ACCOUNT`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT', 400);
  const { rows: [dupe] } = await c.query('SELECT 1 FROM savings_holds WHERE external_reference_id = $1', [refId]);
  if (dupe) throw err(`EXTERNAL_REFERENCE_ID_IN_USE: ${refId}`, 409);
  if (ind === 'DBIT') {
    const day = await orgToday(c);
    const hb = await heldBack(c, a.id);
    const available = round2(availableOf(onDay(a, day), await pledgedAmount(c, a.member_id)) - hb.blocked - hb.holds);
    if (amt > available) throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}, requested ${amt}`, 409);
  }
  const { rows: [h] } = await c.query(
    'INSERT INTO savings_holds (account_id, external_reference_id, indicator, amount, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [a.id, refId, ind, amt, notes, createdBy || 'SYSTEM']);
  return holdOut(h);
}

async function holdsOf(c, accountId, { status = null } = {}) {
  const a = await lock(c, accountId);
  const { rows } = await c.query('SELECT * FROM savings_holds WHERE account_id = $1 AND ($2::text IS NULL OR state = $2) ORDER BY created_at',
    [a.id, status ? String(status).toUpperCase() : null]);
  return rows.map(holdOut);
}

/** Reverse a pending hold (the reference platform: DELETE /deposits/{id}/authorizationholds/{ref}); it no longer holds anything. */
async function reverseHold(c, accountId, reference, { createdBy } = {}) {
  const a = await lock(c, accountId);
  const { rows: [h] } = await c.query('SELECT * FROM savings_holds WHERE external_reference_id = $1 AND account_id = $2 FOR UPDATE', [String(reference), a.id]);
  if (!h) throw err(`HOLD_NOT_FOUND: ${reference}`, 404);
  if (h.state !== 'PENDING') throw err(`HOLD_IS_${h.state}`, 409);
  const { rows: [u] } = await c.query("UPDATE savings_holds SET state = 'REVERSED', closed_at = now() WHERE id = $1 RETURNING *", [h.id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_HOLD_REVERSED', entity: 'savings_account', entityId: a.id, before: JSON.stringify(holdOut(h)) });
  return holdOut(u);
}

/** Pending blocks and holds keep an account open (closing it, or its holder's exit, waits for them). */
async function assertNothingPending(c, a) {
  const hb = await heldBack(c, a.id);
  if (hb.blocked > 0) throw err(`ACCOUNT_HAS_BLOCKED_FUNDS: ${hb.blocked}; unblock or seize them first`, 409);
  const { rows: [h] } = await c.query("SELECT count(*)::int AS n FROM savings_holds WHERE account_id = $1 AND state = 'PENDING'", [a.id]);
  if (h.n) throw err(`ACCOUNT_HAS_PENDING_HOLDS: ${h.n}; settle or reverse them first`, 409);
}

// --------------------------------------------------------------------------
// Withholding tax per account (the reference platform's :changeWithholdingTax)
// --------------------------------------------------------------------------

/** The withholding tax rate on interest applied on a day: the account's own source in force then, or the product's percentage. */
async function withholdingRate(c, a, date) {
  if (!a.withholding_source_id) return a.withholding_tax_percent === null || a.withholding_tax_percent === undefined ? null : Number(a.withholding_tax_percent);
  const { rows: [r] } = await c.query(
    'SELECT rate FROM index_rates WHERE source_id = $1 AND valid_from <= $2::date ORDER BY valid_from DESC LIMIT 1', [a.withholding_source_id, date]);
  return r ? Number(r.rate) : null;
}

/**
 * Give the account its own withholding tax source, from today (null goes
 * back to the product's). The change is kept (the reference platform's GET
 * /deposits/{id}/withholdingtaxes).
 */
async function changeWithholdingTax(c, accountId, { sourceId, createdBy } = {}) {
  const a = await lock(c, accountId);
  if (!OPEN.includes(a.status) && !['PENDING_APPROVAL', 'APPROVED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  const src = sourceId === null || sourceId === undefined || sourceId === '' ? null : String(sourceId).toUpperCase();
  if (src) {
    const { rows: [r] } = await c.query('SELECT kind FROM index_rate_sources WHERE id = $1', [src]);
    if (!r || r.kind !== 'WITHHOLDING') throw err(`NOT_A_WITHHOLDING_TAX_SOURCE: ${src}`, 400);
    if (books(a) && !a.gl_tax_payable) throw err(`THE_PRODUCT_HAS_NO_TAXES_PAYABLE_ACCOUNT: ${a.product_id}`, 409);
    if (!a.interest_paid_into_account) throw err('WITHHOLDING_TAX_NEEDS_INTEREST_PAID_INTO_THE_ACCOUNT', 409);
  }
  const today = await orgToday(c);
  await c.query('UPDATE savings_accounts SET withholding_source_id = $2 WHERE id = $1', [a.id, src]);
  await c.query('INSERT INTO savings_withholding_changes (account_id, source_id, valid_from, created_by) VALUES ($1,$2,$3,$4)',
    [a.id, src, today, createdBy || 'SYSTEM']);
  const u = await lock(c, a.id);
  return { accountId: a.id, withholdingTaxSourceKey: src, validFrom: today, rate: await withholdingRate(c, u, today) };
}

async function withholdingHistory(c, accountId) {
  const a = await lock(c, accountId);
  const { rows } = await c.query('SELECT source_id, valid_from::text, created_by, created_at FROM savings_withholding_changes WHERE account_id = $1 ORDER BY created_at', [a.id]);
  return rows.map((r) => ({ withholdingTaxSourceKey: r.source_id, validFrom: r.valid_from, createdBy: r.created_by, creationDate: r.created_at }));
}

// --------------------------------------------------------------------------
// Opening
// --------------------------------------------------------------------------

async function open(c, { memberId, productId = 'SAV01', accountNo, branchId = undefined, overdraftLimit = 0, openedOn = null, customFields: cf = {}, user = null,
  interestRate = undefined, interestSpread = undefined, overdraftRate = undefined, overdraftSpread = undefined, maxBalance = undefined, termLength = undefined,
  name = null, maxWithdrawalAmount = undefined, recommendedDepositAmount = undefined, overdraftExpiryDate = null }) {
  const { rows: [p] } = await c.query('SELECT * FROM savings_products WHERE id = $1', [productId]);
  if (!p) throw err('UNKNOWN_DEPOSIT_PRODUCT', 404);
  if (p.is_active === false) throw err('DEPOSIT_PRODUCT_INACTIVE', 409);
  const lim = round2(overdraftLimit || 0);
  if (lim > 0 && !p.allow_overdraft) throw err('PRODUCT_DOES_NOT_ALLOW_OVERDRAFTS', 409);
  // The overdraft expiry date at opening (the reference platform's new account overdraft settings).
  let expires = null;
  if (overdraftExpiryDate !== null && overdraftExpiryDate !== undefined && overdraftExpiryDate !== '') {
    expires = String(overdraftExpiryDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) throw err('OVERDRAFT_EXPIRY_DATE_IS_A_DATE: yyyy-MM-dd', 400);
    if (!(lim > 0)) throw err('AN_OVERDRAFT_EXPIRY_DATE_NEEDS_AN_OVERDRAFT_LIMIT', 400);
  }
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
  const limits = ownLimits(p, { maxWithdrawalAmount, recommendedDepositAmount });
  const values = await customFields.prepare(c, 'SAVINGS_ACCOUNT', { item: p.id, patch: cf || {}, user, creating: true });
  const no = accountNo || await NUMBERS.forProduct(c, p);
  // The product's initial state (the reference platform): ACTIVE, the platform's rule so far,
  // or PENDING_APPROVAL or APPROVED, which becomes ACTIVE with the first
  // transaction.
  const state = p.initial_state || 'ACTIVE';
  const { rows } = await c.query(
    `INSERT INTO savings_accounts (account_no, member_id, product_id, status, branch_id, overdraft_limit, opened_on, period_started_on, custom_fields,
       interest_rate, interest_spread, overdraft_rate, overdraft_spread, max_balance, term_length, last_activity_on, approved_on, name,
       own_max_withdrawal, own_recommended_deposit, overdraft_expires_on)
     VALUES ($1,$2,$3,$14,$4,$5,COALESCE($6::date, current_date),COALESCE($6::date, current_date),$7,$8,$9,$10,$11,$12,$13,COALESCE($6::date, current_date),
             CASE WHEN $14 = 'APPROVED' THEN COALESCE($6::date, current_date) END, $15, $16, $17, $18::date)
     RETURNING *`,
    [no, memberId, productId, branch, lim, openedOn, JSON.stringify(values),
      own.interestRate, own.interestSpread, own.overdraftRate, own.overdraftSpread, own.maxBalance, own.termLength, state,
      name === null || name === undefined || String(name).trim() === '' ? null : String(name).trim().slice(0, 255),
      limits.own_max_withdrawal ?? null, limits.own_recommended_deposit ?? null, expires]
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
  if (a.status === 'LOCKED') throw err('ACCOUNT_LOCKED: unlock it first', 409);
  if (['PENDING_APPROVAL', 'APPROVED'].includes(a.status)) throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}; reject or withdraw it instead`, 409);
  if (!['ACTIVE', 'IN_ARREARS', 'DORMANT', 'MATURED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  const left = ['balance', 'interest_accrued', 'neg_interest_accrued', 'od_interest_accrued', 'interest_booked', 'neg_interest_booked',
    'od_interest_booked', 'od_interest_due', 'od_fees_due'].filter((k) => Number(a[k] || 0) !== 0);
  if (left.length) throw err(`ACCOUNT_NOT_EMPTY: ${left.join(', ')}`, 409);
  const { rows: [l] } = await c.query(
    "SELECT account_no FROM loan_accounts WHERE settlement_account_id = $1 AND status NOT LIKE 'CLOSED%' LIMIT 1", [a.id]);
  if (l) throw err(`SETTLEMENT_ACCOUNT_OF_A_RUNNING_LOAN: ${l.account_no}`, 409);
  await assertNothingPending(c, a);
  const { rows: [out] } = await c.query(
    `UPDATE savings_accounts SET status = 'CLOSED', closed_on = current_date, notes = COALESCE($2, notes), updated_at = now()
     WHERE id = $1 RETURNING *`, [a.id, notes]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_ACCOUNT_CLOSED', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ status: a.status }), after: JSON.stringify({ status: 'CLOSED', closedOn: out.closed_on }) });
  return out;
}

// --------------------------------------------------------------------------
// The life cycle (the reference platform's Deposit Accounts: approve, reject, withdraw, lock,
// unlock, close, write off, reopen, and their undos)
// --------------------------------------------------------------------------

/** The permission each action needs, and the states it starts from. */
const ACTIONS = {
  APPROVE: { code: 'APPROVE_SAVINGS', from: ['PENDING_APPROVAL'] },
  UNDO_APPROVE: { code: 'APPROVE_SAVINGS', from: ['APPROVED'] },
  UNDO_ACTIVATE: { code: 'APPROVE_SAVINGS', from: ['ACTIVE'] },
  CLOSE_REJECT: { code: 'CLOSE_SAVINGS_ACCOUNTS', from: ['PENDING_APPROVAL'] },
  CLOSE_WITHDRAW: { code: 'CLOSE_SAVINGS_ACCOUNTS', from: ['PENDING_APPROVAL', 'APPROVED'] },
  LOCK: { code: 'LOCK_SAVINGS_ACCOUNT', from: ['ACTIVE', 'IN_ARREARS', 'DORMANT'] },
  UNLOCK: { code: 'UNLOCK_SAVINGS_ACCOUNT', from: ['LOCKED'] },
  CLOSE: { code: 'CLOSE_SAVINGS_ACCOUNTS', from: ['ACTIVE', 'IN_ARREARS', 'DORMANT', 'MATURED'] },
  CLOSE_WRITE_OFF: { code: 'CLOSE_SAVINGS_ACCOUNTS', from: ['ACTIVE', 'IN_ARREARS', 'DORMANT', 'LOCKED', 'MATURED'] },
  UNDO_CLOSE_WRITE_OFF: { code: 'REVERSE_SAVINGS_ACCOUNT_WRITE_OFF', from: ['CLOSED'] },
  REOPEN: { code: 'REOPEN_SAVINGS_ACCOUNT', from: ['CLOSED'] },
};

/** Whether anything was ever posted to the account (a transfer in is recorded on the account it came from). */
async function liveTransactions(c, id) {
  const { rows: [r] } = await c.query(
    `SELECT count(*) FILTER (WHERE reversed_by IS NULL AND kind <> 'REVERSAL')::int AS live, count(*)::int AS ever
       FROM transactions WHERE savings_account_id = $1 OR allocation->>'toAccountId' = $1::text`, [id]);
  return r;
}

async function stateAudit(c, createdBy, action, a, after, notes) {
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: `SAVINGS_ACCOUNT_${action}`, entity: 'savings_account', entityId: a.id, before: JSON.stringify({ status: a.status, closedAs: a.closed_as || null }), after: JSON.stringify({ ...after, notes: notes || null }) });
}

async function holderMayReopen(c, a) {
  const { rows: [m] } = await c.query('SELECT member_no, status FROM members WHERE id = $1', [a.member_id]);
  if (m && !['ACTIVE', 'INACTIVE'].includes(m.status)) throw err(`HOLDER_IS_${m.status}: ${m.member_no}`, 409);
}

/**
 * Change an account's state (the reference platform's POST /deposits/{id}:changeState, with
 * its actions APPROVE, UNDO_APPROVE, LOCK, UNLOCK, CLOSE, CLOSE_WITHDRAW,
 * CLOSE_REJECT and CLOSE_WRITE_OFF), and the platform's names for the reference platform's
 * console actions Undo Activate, Undo Write Off and Reopen
 * (UNDO_ACTIVATE, UNDO_CLOSE_WRITE_OFF, REOPEN).
 */
async function changeState(c, accountId, action, { notes = null, user = null, createdBy } = {}) {
  const act = String(action || '').toUpperCase();
  const rule = ACTIONS[act];
  if (!rule) throw err(`ACTION_IS_ONE_OF: ${Object.keys(ACTIONS).join(', ')}`, 400);
  need(user, rule.code);
  const a = await lock(c, accountId);
  if (!rule.from.includes(a.status)) throw err(`CANNOT_${act}_A_${a.status}_ACCOUNT`, 409);
  const today = await orgToday(c);
  const set = async (sql, vals = []) => (await c.query(`UPDATE savings_accounts SET ${sql}, updated_at = now() WHERE id = $1 RETURNING *`, [a.id, ...vals])).rows[0];
  let out;
  switch (act) {
    case 'APPROVE':
      out = await set("status = 'APPROVED', approved_on = $2", [today]);
      break;
    case 'UNDO_APPROVE':
      out = await set("status = 'PENDING_APPROVAL', approved_on = NULL");
      break;
    case 'UNDO_ACTIVATE': {
      // Only an account its first transaction activated, and only while
      // nothing stands on it (the reference platform: no transactions).
      if (!a.activated_on) throw err('NOT_ACTIVATED_FROM_APPROVED: the account opened ACTIVE', 409);
      const t = await liveTransactions(c, a.id);
      const left = ['balance', 'interest_accrued', 'neg_interest_accrued', 'od_interest_accrued'].filter((k) => Number(a[k] || 0) !== 0);
      if (t.live || left.length) throw err(`ACCOUNT_HAS_TRANSACTIONS: reverse them first${left.length ? ` (${left.join(', ')})` : ''}`, 409);
      await c.query('DELETE FROM savings_daily_balances WHERE account_id = $1', [a.id]);
      out = await set("status = 'APPROVED', activated_on = NULL, accrued_through = NULL");
      break;
    }
    case 'CLOSE_REJECT':
    case 'CLOSE_WITHDRAW': {
      const t = await liveTransactions(c, a.id);
      if (t.live || Number(a.balance) !== 0) throw err('ACCOUNT_HAS_TRANSACTIONS', 409);
      await assertNothingPending(c, a);
      out = await set("status = 'CLOSED', closed_as = $2, closed_on = $3", [act === 'CLOSE_REJECT' ? 'REJECTED' : 'WITHDRAWN', today]);
      break;
    }
    case 'LOCK':
      out = await set("status = 'LOCKED', state_before_lock = $2, locked_on = $3", [a.status, today]);
      break;
    case 'UNLOCK': {
      // Back to the state it was locked in (the reference platform); a lock from before this
      // was recorded returns to ACTIVE.
      const back = ['ACTIVE', 'IN_ARREARS', 'DORMANT'].includes(a.state_before_lock) ? a.state_before_lock : 'ACTIVE';
      out = await set('status = $2, state_before_lock = NULL, locked_on = NULL', [back]);
      await followArrears(c, a.id, today, { createdBy });
      out = (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [a.id])).rows[0];
      break;
    }
    case 'CLOSE':
      return closeAccount(c, a.id, { createdBy, notes });
    case 'CLOSE_WRITE_OFF': {
      // Close > Write Off (the reference platform): what is overdrawn is written off and the
      // account closes as CLOSED_WRITTEN_OFF. Credit interest still accrued
      // is applied or reversed first.
      if (!(Number(a.balance) < 0)) throw err('ACCOUNT_IS_NOT_OVERDRAWN: close it instead', 409);
      const left = ['interest_accrued', 'neg_interest_accrued', 'interest_booked', 'neg_interest_booked'].filter((k) => round2(a[k] || 0) !== 0);
      if (left.length) throw err(`INTEREST_ACCRUED_ON_THE_ACCOUNT: ${left.join(', ')}; apply it first`, 409);
      const { rows: [l] } = await c.query(
        "SELECT account_no FROM loan_accounts WHERE settlement_account_id = $1 AND status NOT LIKE 'CLOSED%' LIMIT 1", [a.id]);
      if (l) throw err(`SETTLEMENT_ACCOUNT_OF_A_RUNNING_LOAN: ${l.account_no}`, 409);
      await assertNothingPending(c, a);
      const t = await writeOffOverdraft(c, a.id, { createdBy, closing: true, narration: notes ? `Write-off ${a.account_no}: ${notes}` : undefined });
      out = await set("status = 'CLOSED', closed_as = 'WRITTEN_OFF', closed_on = $2, state_before_lock = NULL, locked_on = NULL", [today]);
      out.writeOff = t;
      break;
    }
    case 'UNDO_CLOSE_WRITE_OFF': {
      if (a.closed_as !== 'WRITTEN_OFF') throw err('ACCOUNT_NOT_WRITTEN_OFF', 409);
      await holderMayReopen(c, a);
      const { rows: [t] } = await c.query(
        `SELECT * FROM transactions WHERE savings_account_id = $1 AND kind = 'OVERDRAFT_WRITE_OFF' AND reversed_by IS NULL
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [a.id]);
      if (!t || !t.allocation?.closing || !t.allocation?.cleared) throw err('WRITE_OFF_NOT_UNDOABLE: it was recorded before write-offs could be undone', 409);
      const x = t.allocation.cleared;
      const entry = t.entry_id ? await acct.reverse(c, t.entry_id, 'Undo write-off', createdBy) : { entryId: null };
      const back = ['ACTIVE', 'IN_ARREARS', 'DORMANT', 'MATURED'].includes(t.allocation.statusBefore) ? t.allocation.statusBefore : 'ACTIVE';
      out = await set(`status = $2, closed_as = NULL, closed_on = NULL, balance = $3, od_fees_due = $4, od_interest_due = $5,
                       od_interest_accrued = $6, od_interest_booked = $7, overdraft_limit = $8`,
      [back, -Number(t.amount), x.odFeesDue, x.odInterestDue, x.odInterestAccrued, x.odInterestBooked, x.overdraftLimit]);
      const rev = await record(c, {
        reference: ref('REV'), kind: 'REVERSAL', memberId: t.member_id, savingsAccountId: a.id, amount: -t.amount, branchId: t.branch_id,
        entryId: entry.entryId, allocation: { reversalOf: t.reference, undoWriteOff: true }, narration: notes || 'Undo write-off', createdBy,
      });
      await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, t.id]);
      await followArrears(c, a.id, today, { createdBy });
      out = { ...(await c.query('SELECT * FROM savings_accounts WHERE id = $1', [a.id])).rows[0], reversal: rev };
      break;
    }
    case 'REOPEN': {
      // Only current and savings accounts, closed plainly (the reference platform); interest
      // runs again from today.
      if (a.closed_as) throw err(`CANNOT_REOPEN_A_${a.closed_as}_ACCOUNT${a.closed_as === 'WRITTEN_OFF' ? ': undo the write-off' : ''}`, 409);
      if (!['CURRENT_ACCOUNT', 'SAVINGS_ACCOUNT'].includes(a.product_type)) throw err(`ONLY_CURRENT_AND_SAVINGS_ACCOUNTS_REOPEN: ${a.product_type}`, 409);
      await holderMayReopen(c, a);
      out = await set(`status = 'ACTIVE', closed_on = NULL, last_activity_on = $2, accrued_through = $2::date - 1,
                       period_started_on = $2`, [today]);
      break;
    }
    default:
      throw err(`ACTION_IS_ONE_OF: ${Object.keys(ACTIONS).join(', ')}`, 400);
  }
  await stateAudit(c, createdBy, act, a, { status: out.status, closedAs: out.closed_as || null, on: today }, notes);
  return out;
}

/**
 * Delete an account nothing was ever posted to (the reference platform: only if no
 * transaction was ever made). An account a loan, a funding pledge or a
 * dividend points at stays.
 */
async function deleteAccount(c, accountId, { createdBy } = {}) {
  const a = await lock(c, accountId);
  const t = await liveTransactions(c, a.id);
  if (t.ever) throw err(`ACCOUNT_HAS_TRANSACTIONS: ${t.ever}; close it instead`, 409);
  const left = ['balance', 'interest_accrued', 'neg_interest_accrued', 'od_interest_accrued'].filter((k) => Number(a[k] || 0) !== 0);
  if (left.length) throw err(`ACCOUNT_NOT_EMPTY: ${left.join(', ')}`, 409);
  for (const [sql, what] of [
    ['SELECT 1 FROM loan_accounts WHERE settlement_account_id = $1 OR disbursement_savings_account_id = $1', 'LINKED_TO_A_LOAN'],
    ['SELECT 1 FROM loan_funding_sources WHERE savings_account_id = $1', 'FUNDS_A_LOAN'],
    ['SELECT 1 FROM dividend_allocations WHERE savings_account_id = $1', 'HAS_DIVIDENDS'],
  ]) {
    if ((await c.query(`${sql} LIMIT 1`, [a.id])).rows.length) throw err(`CANNOT_DELETE: the account ${what}`, 409);
  }
  if (a.credit_arrangement_id) throw err('CANNOT_DELETE: remove the account from its credit arrangement first', 409);
  await assertNothingPending(c, a);
  const { rows: [anyHold] } = await c.query('SELECT 1 FROM savings_holds WHERE account_id = $1 UNION ALL SELECT 1 FROM savings_blocks WHERE account_id = $1 LIMIT 1', [a.id]);
  if (anyHold) throw err('CANNOT_DELETE: the account has had blocks or holds', 409);
  await c.query('DELETE FROM savings_daily_balances WHERE account_id = $1', [a.id]);
  await c.query('DELETE FROM savings_accounts WHERE id = $1', [a.id]);
  await c.query('SELECT refresh_member_state($1)', [a.member_id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_ACCOUNT_DELETED', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ accountNo: a.account_no, memberId: a.member_id, productId: a.product_id, status: a.status }) });
  return { deleted: a.account_no, accountId: a.id };
}

module.exports = {
  blockFunds, blocksOf, unblockFunds, seizeFunds, createHold, holdsOf, reverseHold, heldBack, changeWithholdingTax, withholdingHistory,
  withholdingRate, repriceFrom, valueDay,
  changeState, deleteAccount, followArrears, apiState, OPEN, ACTIONS,
  closeAccount, lockedFunding, open, deposit, withdraw, transfer, summary, reverseTransaction, pledgedAmount, lock, record, ref,
  applyFee, applyMonthlyFees, accrueInterest, applyInterest, endOfDay, isApplicationDate,
  setOverdraftLimit, writeOffOverdraft, inLegs, outLegs, availableOf, onDay, books,
  startMaturity, undoMaturity, changeInterestRate, updateAccount, accountTerms,
};
