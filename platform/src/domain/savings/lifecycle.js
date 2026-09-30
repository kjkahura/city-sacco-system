'use strict';

/**
 * Deposit accounts: opening, the life cycle (approve, reject, withdraw, lock, close) and deletion.
 */

const NUMBERS = require('../accountNumbers');
const { orgToday } = require('../../lib/orgDate');
const acct = require('../accounting');
const customFields = require('../customFields');
const { recordAudit } = require('../../lib/auditLog');
const { err, round2 } = acct;
const core = require('./core');
const funds = require('./funds');
const terms = require('./terms');

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
  const own = terms.accountTerms(p, { interestRate, interestSpread, overdraftRate, overdraftSpread, maxBalance, termLength });
  const limits = terms.ownLimits(p, { maxWithdrawalAmount, recommendedDepositAmount });
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

/**
 * Close a deposit account (the reference platform's Close), which a member's exit needs. Only
 * an account with nothing in it and nothing owed on it closes: a zero
 * balance, no interest accrued or booked, no overdraft interest or fees due,
 * and not the settlement account of a running loan. Closing a member's last
 * open account makes the member INACTIVE (tenant migration 033).
 */
async function closeAccount(c, accountId, { createdBy, notes = null } = {}) {
  const a = await core.lock(c, accountId);
  if (a.status === 'LOCKED') throw err('ACCOUNT_LOCKED: unlock it first', 409);
  if (['PENDING_APPROVAL', 'APPROVED'].includes(a.status)) throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}; reject or withdraw it instead`, 409);
  if (!['ACTIVE', 'IN_ARREARS', 'DORMANT', 'MATURED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  const left = ['balance', 'interest_accrued', 'neg_interest_accrued', 'od_interest_accrued', 'interest_booked', 'neg_interest_booked',
    'od_interest_booked', 'od_interest_due', 'od_fees_due'].filter((k) => Number(a[k] || 0) !== 0);
  if (left.length) throw err(`ACCOUNT_NOT_EMPTY: ${left.join(', ')}`, 409);
  const { rows: [l] } = await c.query(
    "SELECT account_no FROM loan_accounts WHERE settlement_account_id = $1 AND status NOT LIKE 'CLOSED%' LIMIT 1", [a.id]);
  if (l) throw err(`SETTLEMENT_ACCOUNT_OF_A_RUNNING_LOAN: ${l.account_no}`, 409);
  await funds.assertNothingPending(c, a);
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
  core.need(user, rule.code);
  const a = await core.lock(c, accountId);
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
      await funds.assertNothingPending(c, a);
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
      await core.followArrears(c, a.id, today, { createdBy });
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
      await funds.assertNothingPending(c, a);
      const t = await terms.writeOffOverdraft(c, a.id, { createdBy, closing: true, narration: notes ? `Write-off ${a.account_no}: ${notes}` : undefined });
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
      const rev = await core.record(c, {
        reference: core.ref('REV'), kind: 'REVERSAL', memberId: t.member_id, savingsAccountId: a.id, amount: -t.amount, branchId: t.branch_id,
        entryId: entry.entryId, allocation: { reversalOf: t.reference, undoWriteOff: true }, narration: notes || 'Undo write-off', createdBy,
      });
      await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, t.id]);
      await core.followArrears(c, a.id, today, { createdBy });
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
  const a = await core.lock(c, accountId);
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
  await funds.assertNothingPending(c, a);
  const { rows: [anyHold] } = await c.query('SELECT 1 FROM savings_holds WHERE account_id = $1 UNION ALL SELECT 1 FROM savings_blocks WHERE account_id = $1 LIMIT 1', [a.id]);
  if (anyHold) throw err('CANNOT_DELETE: the account has had blocks or holds', 409);
  await c.query('DELETE FROM savings_daily_balances WHERE account_id = $1', [a.id]);
  await c.query('DELETE FROM savings_accounts WHERE id = $1', [a.id]);
  await c.query('SELECT refresh_member_state($1)', [a.member_id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_ACCOUNT_DELETED', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ accountNo: a.account_no, memberId: a.member_id, productId: a.product_id, status: a.status }) });
  return { deleted: a.account_no, accountId: a.id };
}

Object.assign(module.exports, {
  open, closeAccount, ACTIONS, liveTransactions, stateAudit, holderMayReopen, changeState, deleteAccount,
});
