'use strict';

/**
 * Deposit accounts: states, the posting record, legs across the GL and the product rules for money in and out.
 */

const DR = require('../depositRules');
const { can } = require('../../lib/permissions');
const { orgToday } = require('../../lib/orgDate');
const acct = require('../accounting');
const S = require('../schedule');
const PA = require('../productAccounting');
const { recordAudit } = require('../../lib/auditLog');
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
 * than in ../funding because savings sits below the loan modules.
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
// Interest
// --------------------------------------------------------------------------

const DAY = 86400000;
const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);

/**
 * The first day a movement may be dated and priced again: the day after the
 * last interest application, or the day the account started earning
 * (The reference platform reposts applied interest too; here what was applied stays).
 */
function repriceFloor(a) {
  if (a.last_interest_applied_on) return addDays(S.ymd(a.last_interest_applied_on), 1);
  return S.ymd(a.activated_on || a.opened_on);
}

Object.assign(module.exports, {
  PRODUCT_COLUMNS, OPEN, apiState, lock, channel, books, accrues, pledgedAmount, lockedFunding, onDay, availableOf, summary, ref, record, inLegs, outLegs, postWithChannel, maxWithdrawal, need, inTerm, assertMayCredit, assertMayDebit, touch, followArrears, valueDay, assertBackdatedFloor, heldBack, holdToSettle, settleHold, DAY, addDays, repriceFloor,
});
