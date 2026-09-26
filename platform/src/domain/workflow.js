'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * The loan's life cycle, after Mambu's "Loan Account Life Cycle and States":
 *
 *   PARTIAL_APPLICATION  --REQUEST_APPROVAL-->  PENDING_APPROVAL  --APPROVE-->  APPROVED  --disburse-->  ACTIVE
 *          ^                                        |                              |                        |
 *          +-------------SET_INCOMPLETE-------------+           UNDO_APPROVE       |          late payments |
 *                                                                                  v                        v
 *   REJECT / WITHDRAW close an application (and can be undone);           IN_ARREARS <---> ACTIVE, LOCK/UNLOCK
 *   write-off, payoff, reschedule and refinance close a running loan.
 *
 * Every change is a row in loan_state_history, so "who approved this, and
 * when, and who sent it back" is a query rather than an archaeology.
 *
 * Approval is one step (Mambu-style), guarded by:
 *   - the product's eligibility rules and the tenant's exposure controls
 *   - the approving user's approval limit (platform.users.approval_limit)
 * Disbursement is guarded by the user's disbursement limit and, when the
 * tenant turns it on, the two-man rule: the approver may not disburse.
 */

const ledger = require('./ledger');
const G = require('./eodGuard');
const eligibility = require('./eligibility');
const tranches = require('./tranches');
const funding = require('./funding');
const securities = require('./securities');
const {
  controls, updateControls, exposure, userLimits, assertMayApprove, assertMayDisburse, assertMaySetDisbursementConditions,
} = require('./controls');

const OPEN = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL'];
const RUNNING = ['ACTIVE', 'IN_ARREARS'];

const ACTIONS = {
  REQUEST_APPROVAL: { from: ['PARTIAL_APPLICATION'], to: 'PENDING_APPROVAL' },
  SET_INCOMPLETE:   { from: ['PENDING_APPROVAL'], to: 'PARTIAL_APPLICATION' },
  APPROVE:          { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  UNDO_APPROVE:     { from: ['APPROVED'], to: 'PENDING_APPROVAL' },
  REJECT:           { from: OPEN, to: 'CLOSED_REJECTED' },
  UNDO_REJECT:      { from: ['CLOSED_REJECTED'], to: 'PREVIOUS' },
  WITHDRAW:         { from: [...OPEN, 'APPROVED'], to: 'CLOSED_WITHDRAWN' },
  UNDO_WITHDRAW:    { from: ['CLOSED_WITHDRAWN'], to: 'PREVIOUS' },
  LOCK:             { from: RUNNING, to: 'LOCKED' },
  UNLOCK:           { from: ['LOCKED'], to: 'PREVIOUS' },
  // A revolving loan does not close itself when its balance reaches zero,
  // since the member may draw again; closing it is a decision.
  CLOSE:            { from: ['ACTIVE'], to: 'CLOSED_REPAID' },
};
// Names the first API used; kept so nothing that learned them breaks.
const ALIASES = { SUBMIT: 'REQUEST_APPROVAL', UNAPPROVE: 'UNDO_APPROVE' };

async function history(c, loanId, { from, to, action, actor, note = null }) {
  await c.query(
    `INSERT INTO loan_state_history (loan_id, from_status, to_status, action, actor, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [loanId, from || null, to, action, actor || 'SYSTEM', note]);
}

async function historyOf(c, loanId) {
  const { rows } = await c.query(
    `SELECT h.* FROM loan_state_history h JOIN loan_accounts l ON l.id = h.loan_id
     WHERE l.id::text = $1 OR l.account_no = $1 ORDER BY h.at, h.id`, [loanId]);
  return rows;
}

/** The state before the last change that landed in `current`. */
async function previousState(c, loanId, current) {
  const { rows: [h] } = await c.query(
    `SELECT from_status FROM loan_state_history WHERE loan_id = $1 AND to_status = $2 ORDER BY at DESC, id DESC LIMIT 1`,
    [loanId, current]);
  return h?.from_status || null;
}

// Controls live in ./controls; re-exported below for callers that know them here.


async function assertMayWriteOff(c, l) {
  const ctl = await controls(c);
  const min = Number(ctl.min_arrears_days_before_writeoff || 0);
  if (min > 0) {
    const days = daysInArrears(l);
    if (days < min) throw err(`WRITE_OFF_REQUIRES_${min}_DAYS_IN_ARREARS: ${days} so far`, 409);
  }
}

// --------------------------------------------------------------------------
// Transitions
// --------------------------------------------------------------------------

/**
 * A top-up application is approved only while the loan it refinances is
 * still running and the approved principal still leaves something to pay
 * the member once that loan is settled.
 */
async function assertTopUpStands(c, application) {
  const old = await ledger.lock(c, application.refinance_of);
  if (!['ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(old.status)) {
    throw err(`REFINANCED_LOAN_NOT_RUNNING: ${old.account_no} is ${old.status}`, 409);
  }
  const s = await ledger.settlementPlan(c, old, {
    arrears: application.refinance_arrears || 'CAPITALIZE', capitalize: application.refinance_capitalize, carryFees: application.refinance_carry_fees !== false,
  });
  if (!(Number(application.principal) > s.amount)) {
    throw err(`NO_TOP_UP_LEFT: principal ${Number(application.principal)}, settlement of ${old.account_no} ${s.amount}`, 409);
  }
  return { old, settlement: s };
}

async function transition(c, loanId, action, { createdBy, note = null, user = null, reason = null } = {}) {
  const name = ALIASES[String(action).toUpperCase()] || String(action).toUpperCase();
  const t = ACTIONS[name];
  if (!t) throw err(`UNSUPPORTED_ACTION: ${action}`);
  const l = await ledger.lock(c, loanId);
  if (!t.from.includes(l.status)) throw err(`INVALID_STATE_TRANSITION: ${l.status} -> ${name}`, 409);

  let to = t.to;
  const sets = [];
  const vals = [];
  const set = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

  if (name === 'APPROVE') {
    // Approval is where the rules bite. Applying is a request and a teller
    // may record one for any amount; approving it is the credit decision.
    await eligibility.enforceEligibility(c, l);
    await assertMayApprove(c, l, { user });
    if (l.refinance_of) await assertTopUpStands(c, l);
    await tranches.assertPlanned(c, l);
    await funding.assertFundedForApproval(c, l);
    set('approved_on', new Date().toISOString().slice(0, 10));
    set('approved_by', createdBy || null);
  }
  if (name === 'UNDO_APPROVE') { set('approved_on', null); set('approved_by', null); }
  if (to === 'PREVIOUS') {
    to = await previousState(c, l.id, l.status);
    if (name === 'UNLOCK') {
      if (l.locked_reason === 'CAPPED') {
        // A cap lock lifts when the charges are paid or the loan is out of
        // arrears; otherwise it would relock at the next EOD.
        const b = ledger.balances(l);
        const charges = round2(b.interest + b.fees + b.penalty);
        const { rows: [o] } = await c.query(
          "SELECT count(*)::int AS n FROM loan_installments WHERE loan_id = $1 AND status = 'OVERDUE'", [l.id]);
        if (charges > 0 && o.n > 0) throw err('CAP_LOCK_HOLDS_UNTIL_CHARGES_PAID_OR_ARREARS_CLEARED', 409);
      }
      to = l.status_before_lock || to || 'ACTIVE';
      set('locked_at', null); set('locked_reason', null); set('status_before_lock', null);
      // A cap lock lifted: the count of charges since arrears starts again,
      // so what accrued while locked is applied up to the cap (Mambu applies
      // the charges a locked loan accrued once it is unlocked).
      if (l.locked_reason === 'CAPPED') set('charges_since_arrears', 0);
    }
    if (!to) throw err('NO_PREVIOUS_STATE_RECORDED', 409);
    if (['UNDO_REJECT', 'UNDO_WITHDRAW'].includes(name)) {
      const ctl = await controls(c);
      if (ctl.max_days_undo_close !== null && l.closed_on) {
        const days = Math.floor((Date.now() - new Date(l.closed_on).getTime()) / 86400000);
        if (days > Number(ctl.max_days_undo_close)) throw err(`UNDO_WINDOW_CLOSED: ${ctl.max_days_undo_close} days`, 409);
      }
      set('closed_on', null);
    }
  }
  if (name === 'CLOSE') {
    const b = ledger.balances(l);
    if (b.total > 0) throw err(`LOAN_HAS_A_BALANCE: ${b.total}`, 409);
    if (Number(l.credit_balance) > 0) throw err(`LOAN_HAS_A_CREDIT_BALANCE: ${l.credit_balance}; it must be drawn or refunded first`, 409);
    set('closed_on', new Date().toISOString().slice(0, 10));
    await eligibility.releaseGuarantors(c, l.id);
    await securities.onClose(c, l.id);
  }
  if (name === 'LOCK') {
    set('locked_at', new Date()); set('locked_reason', reason && ['MANUAL', 'CAPPED', 'ARREARS'].includes(reason) ? reason : 'MANUAL');
    set('status_before_lock', l.status);
  }
  if (['REJECT', 'WITHDRAW'].includes(name)) set('closed_on', new Date().toISOString().slice(0, 10));

  set('status', to);
  vals.push(l.id);
  const { rows } = await c.query(
    `UPDATE loan_accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);

  if (['CLOSED_REJECTED', 'CLOSED_WITHDRAWN'].includes(to)) await eligibility.releaseGuarantors(c, l.id);
  if (name === 'APPROVE') await freezeSettings(c, l.id);
  if (name === 'UNDO_APPROVE') await thawSettings(c, l.id);
  await history(c, l.id, { from: l.status, to, action: name, actor: createdBy, note });
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,$2,'loan_account',$3,$4,$5)`,
    [createdBy || 'SYSTEM', `LOAN_${name}`, l.id,
      JSON.stringify({ status: l.status }), JSON.stringify({ status: to, note })]);
  return rows[0];
}

// --------------------------------------------------------------------------
// Settings frozen at approval
// --------------------------------------------------------------------------

// The overrides a loan leaves to its product (INHERIT) that approval fixes.
const FROZEN_OVERRIDES = ['penaltyRate', 'arrearsToleranceDays', 'arrearsTolerancePercent'];

/**
 * At approval the loan keeps the product's penalty and arrears settings as
 * they stand (Mambu: a change to the product reaches only pending
 * accounts). The penalty rate and arrears tolerances the loan left to the
 * product are written onto it; the penalty method and tolerance and the
 * arrears floor and counting rules go into settings_snapshot, which
 * ledger.lock lays over the product's. Undoing the approval undoes this.
 */
async function freezeSettings(c, loanId) {
  const l = await ledger.lock(c, loanId);
  if (l.settings_snapshot) return l.settings_snapshot;
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [l.product_id]);
  const snap = Object.fromEntries(ledger.SNAPSHOT_SETTINGS.map((k) => [k, p[k] ?? null]));
  const filled = [];
  for (const key of FROZEN_OVERRIDES) {
    const o = ledger.OVERRIDES[key];
    if (l[o.column] === null || l[o.column] === undefined) {
      if (p[o.column] !== null && p[o.column] !== undefined) {
        await c.query(`UPDATE loan_accounts SET ${o.column} = $1 WHERE id = $2`, [p[o.column], l.id]);
        filled.push(o.column);
      }
    }
  }
  snap._filled = filled;
  await c.query('UPDATE loan_accounts SET settings_snapshot = $1 WHERE id = $2', [JSON.stringify(snap), l.id]);
  return snap;
}

async function thawSettings(c, loanId) {
  const { rows: [l] } = await c.query('SELECT id, settings_snapshot FROM loan_accounts WHERE id = $1', [loanId]);
  const snap = l?.settings_snapshot;
  if (!snap) return;
  for (const col of snap._filled || []) {
    if (FROZEN_OVERRIDES.some((k) => ledger.OVERRIDES[k].column === col)) await c.query(`UPDATE loan_accounts SET ${col} = NULL WHERE id = $1`, [l.id]);
  }
  await c.query('UPDATE loan_accounts SET settings_snapshot = NULL WHERE id = $1', [l.id]);
}

/**
 * Mambu's two counters: days late from the oldest installment still
 * unpaid after its due date, and days in arrears from the date the loan's
 * arrears count from, less the arrears tolerance (so a loan 87 days late
 * with two days' tolerance is 85 days in arrears). Provisioning and the
 * portfolio-at-risk figures stay on days past due, as SASRA classifies.
 */
async function arrearsIndicators(c, l, asOf = null) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const { rows: [o] } = await c.query(
    `SELECT min(due_date) AS d FROM loan_installments WHERE loan_id = $1 AND status NOT IN ('PAID', 'GRACE') AND due_date < $2::date`,
    [l.id, date]);
  const days = (from) => Math.max(0, Math.floor((new Date(`${date}T00:00:00Z`) - new Date(`${ymd(from)}T00:00:00Z`)) / 86400000));
  const daysLate = o?.d ? days(o.d) : 0;
  let inArrears = 0;
  if (l.arrears_since && ['IN_ARREARS', 'LOCKED'].includes(l.status)) {
    const tol = Number(ledger.effective(l).arrearsToleranceDays || 0);
    inArrears = days(await toleranceDeadline(c, l.arrears_since, tol, l.arrears_non_working_days === 'EXCLUDE'));
  }
  return { daysLate, daysInArrears: inArrears, asOf: date };
}

// --------------------------------------------------------------------------
// Amendments: what may change, in which state
// --------------------------------------------------------------------------

// The loan's own terms (principal, installments) and every override the
// product allows (ledger.OVERRIDES) may change while the application is
// open. After approval only the narrative fields may (Mambu: name, notes,
// custom fields); to change the terms, undo the approval first.
const CORE_FIELDS = { principal: 'principal', termMonths: 'term_months' };
const TERM_FIELDS = [...Object.keys(CORE_FIELDS), ...Object.keys(ledger.OVERRIDES)];
const NARRATIVE_FIELDS = ['purpose', 'notes'];
const COLUMN = {
  ...CORE_FIELDS,
  ...Object.fromEntries(Object.entries(ledger.OVERRIDES).map(([k, o]) => [k, o.column])),
  purpose: 'purpose', notes: 'notes',
};

// --------------------------------------------------------------------------
// Disbursement details
// --------------------------------------------------------------------------

const DISBURSEMENT_FIELDS = {
  expectedDisbursementDate: 'expected_disbursement_date', firstRepaymentDate: 'first_repayment_date',
  disbursementChannelId: 'disbursement_channel_id', disbursementSavingsAccountId: 'disbursement_savings_account_id',
};
const INACTIVE = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED'];
const isoOrNull = (v, label) => {
  if (v === null || v === '') return null;
  const d = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw err(`INVALID_DATE: ${label}`, 400);
  return d;
};

/**
 * Set or change an application's disbursement details (Mambu's
 * Disbursement Details): the anticipated disbursement date, the first
 * repayment date, and the channel or the member's own deposit account the
 * money will go to. Only on an inactive loan (an application or an approved
 * loan), only by a user with the tenant's Set Disbursement Conditions
 * permission when it restricts it, and every change is kept
 * (loan_disbursement_detail_changes).
 */
async function setDisbursementDetails(c, loanId, patch, { actor, user = null, fresh = false } = {}) {
  const keys = Object.keys(patch || {}).filter((k) => DISBURSEMENT_FIELDS[k] && patch[k] !== undefined);
  if (!keys.length) return null;
  const l = await ledger.lock(c, loanId);
  if (!INACTIVE.includes(l.status)) throw err(`DISBURSEMENT_DETAILS_NOT_EDITABLE_IN_STATE_${l.status}`, 409);
  await assertMaySetDisbursementConditions(c, { user });
  const next = {};
  for (const k of Object.keys(DISBURSEMENT_FIELDS)) {
    const v = patch[k] !== undefined ? patch[k] : l[DISBURSEMENT_FIELDS[k]];
    next[k] = v instanceof Date ? ymd(v) : v;
  }
  next.expectedDisbursementDate = next.expectedDisbursementDate ? isoOrNull(next.expectedDisbursementDate, 'expectedDisbursementDate') : null;
  next.firstRepaymentDate = next.firstRepaymentDate ? isoOrNull(next.firstRepaymentDate, 'firstRepaymentDate') : null;
  if (next.expectedDisbursementDate && next.firstRepaymentDate && next.firstRepaymentDate <= next.expectedDisbursementDate) {
    throw err('FIRST_REPAYMENT_DATE_MUST_BE_AFTER_THE_DISBURSEMENT_DATE', 400);
  }
  if (next.disbursementChannelId) {
    const { rows: [ch] } = await c.query('SELECT gl_account_code FROM transaction_channels WHERE id = $1 AND is_active', [next.disbursementChannelId]);
    if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${next.disbursementChannelId}`, 400);
  }
  if (next.disbursementSavingsAccountId) {
    const { rows: [a] } = await c.query(
      `SELECT a.id, a.member_id, a.status, p.is_funding_account FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
       WHERE a.id::text = $1 OR a.account_no = $1`, [String(next.disbursementSavingsAccountId)]);
    if (!a) throw err('SAVINGS_ACCOUNT_NOT_FOUND', 404);
    if (a.member_id !== l.member_id) throw err('DISBURSEMENT_ACCOUNT_BELONGS_TO_ANOTHER_MEMBER', 409);
    if (a.status !== 'ACTIVE' || a.is_funding_account) throw err('DISBURSEMENT_ACCOUNT_MUST_BE_AN_ACTIVE_DEPOSIT_ACCOUNT', 409);
    next.disbursementSavingsAccountId = a.id;
  }
  if (next.disbursementChannelId && next.disbursementSavingsAccountId && keys.includes('disbursementChannelId') && keys.includes('disbursementSavingsAccountId')) {
    throw err('DISBURSE_THROUGH_A_CHANNEL_OR_INTO_A_DEPOSIT_ACCOUNT_NOT_BOTH', 400);
  }
  // The later of the two wins when only one is given.
  if (keys.includes('disbursementSavingsAccountId') && next.disbursementSavingsAccountId && !keys.includes('disbursementChannelId')) next.disbursementChannelId = null;
  if (keys.includes('disbursementChannelId') && next.disbursementChannelId && !keys.includes('disbursementSavingsAccountId')) next.disbursementSavingsAccountId = null;
  const before = Object.fromEntries(Object.entries(DISBURSEMENT_FIELDS).map(([k, col]) => [k, l[col] instanceof Date ? ymd(l[col]) : l[col] ?? null]));
  const { rows: [out] } = await c.query(
    `UPDATE loan_accounts SET expected_disbursement_date = $2::date, first_repayment_date = $3::date,
       disbursement_channel_id = $4, disbursement_savings_account_id = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [l.id, next.expectedDisbursementDate, next.firstRepaymentDate, next.disbursementChannelId || null, next.disbursementSavingsAccountId || null]);
  await c.query(
    'INSERT INTO loan_disbursement_detail_changes (loan_id, before, after, changed_by) VALUES ($1,$2,$3,$4)',
    [l.id, JSON.stringify(fresh ? {} : before), JSON.stringify(next), actor || 'SYSTEM']);
  return out;
}

async function disbursementDetails(c, loanId) {
  const l = await ledger.read(c, loanId);
  const { rows } = await c.query('SELECT * FROM loan_disbursement_detail_changes WHERE loan_id = $1 ORDER BY changed_at, id', [l.id]);
  return {
    loanId: l.id,
    expectedDisbursementDate: l.expected_disbursement_date ? ymd(l.expected_disbursement_date) : null,
    firstRepaymentDate: l.first_repayment_date ? ymd(l.first_repayment_date) : null,
    disbursementChannelId: l.disbursement_channel_id || null,
    disbursementSavingsAccountId: l.disbursement_savings_account_id || null,
    changes: rows,
  };
}

async function amend(c, loanId, patch, { actor, user = null } = {}) {
  // Disbursement details have their own rules and audit trail.
  const detailKeys = Object.keys(patch || {}).filter((k) => DISBURSEMENT_FIELDS[k]);
  if (detailKeys.length) {
    await setDisbursementDetails(c, loanId, Object.fromEntries(detailKeys.map((k) => [k, patch[k]])), { actor, user });
    const rest = Object.fromEntries(Object.entries(patch).filter(([k]) => !DISBURSEMENT_FIELDS[k]));
    if (!Object.keys(rest).filter((k) => COLUMN[k]).length) return (await c.query('SELECT * FROM loan_accounts WHERE id::text = $1 OR account_no = $1', [loanId])).rows[0];
    patch = rest;
  }
  const l = await ledger.lock(c, loanId);
  const keys = Object.keys(patch || {}).filter((k) => COLUMN[k]);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const allowed = OPEN.includes(l.status) ? [...TERM_FIELDS, ...NARRATIVE_FIELDS] : NARRATIVE_FIELDS;
  const refused = keys.filter((k) => !allowed.includes(k));
  if (refused.length) throw err(`NOT_EDITABLE_IN_STATE_${l.status}: ${refused.join(', ')}`, 409);

  // Terms are validated as a set: a shorter term can break a grace period
  // or amortisation that was fine before, even if neither is in the patch.
  const values = {};
  if (keys.some((k) => TERM_FIELDS.includes(k))) {
    const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [l.product_id]);
    const principal = patch.principal ?? l.principal;
    if (!(round2(principal) > 0)) throw err('INVALID_PRINCIPAL', 400);
    ledger.within('PRINCIPAL', principal, p.min_principal, p.max_principal);
    const term = Number(patch.termMonths ?? l.term_months);
    if (!(Number.isInteger(term) && term > 0)) throw err('INVALID_TERM', 400);
    if (term > p.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${p.max_term}`, 400);
    ledger.within('TERM', term, p.min_term, null);
    const given = Object.fromEntries(keys.filter((k) => ledger.OVERRIDES[k]).map((k) => [k, patch[k]]));
    Object.assign(values, ledger.resolveOverrides(p, given, { term, current: l }));
  }

  const sets = [];
  const vals = [];
  for (const k of keys) {
    vals.push(Object.prototype.hasOwnProperty.call(values, COLUMN[k]) ? values[COLUMN[k]] : patch[k]);
    sets.push(`${COLUMN[k]} = $${vals.length}`);
  }
  vals.push(l.id);
  const { rows } = await c.query(
    `UPDATE loan_accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
  // A schedule edited on the application was for the old amount and term.
  if (l.custom_schedule && (keys.includes('principal') || keys.includes('termMonths'))) {
    await c.query('UPDATE loan_accounts SET custom_schedule = NULL WHERE id = $1', [l.id]);
    rows[0].custom_schedule = null;
  }
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'LOAN_AMENDED','loan_account',$2,$3,$4)`,
    [actor || 'SYSTEM', l.id,
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, l[COLUMN[k]]]))),
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, patch[k]])))]);
  return rows[0];
}

// --------------------------------------------------------------------------
// Arrears
// --------------------------------------------------------------------------

const ymd = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).slice(0, 10));

function daysInArrears(l, asOf = null) {
  if (!l.arrears_since) return 0;
  const to = asOf ? new Date(`${asOf}T00:00:00Z`) : new Date();
  const from = new Date(`${ymd(l.arrears_since)}T00:00:00Z`);
  return Math.max(0, Math.floor((to - from) / 86400000));
}

/**
 * The date an installment due on `due` may still be paid without being
 * late: due plus the tolerance days, counting only working days when the
 * product says to exclude non-working ones.
 */
async function toleranceDeadline(c, due, days, excludeNonWorking) {
  if (!(days > 0)) return ymd(due);
  if (!excludeNonWorking) {
    const { rows: [r] } = await c.query('SELECT ($1::date + $2::int) AS d', [ymd(due), days]);
    return ymd(r.d);
  }
  const { rows: [r] } = await c.query(
    `WITH RECURSIVE d(day, n) AS (
       SELECT $1::date, 0
       UNION ALL
       SELECT day + 1,
              CASE WHEN EXTRACT(dow FROM day + 1) IN (0, 6)
                     OR EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = day + 1) THEN n ELSE n + 1 END
       FROM d WHERE n < $2::int
     ) SELECT max(day) AS d FROM d`, [ymd(due), days]);
  return ymd(r.d);
}

/**
 * Mark overdue installments and flip loans into arrears, per product:
 * tolerance days (working days only, if so set), and a tolerance amount as
 * a percentage of the outstanding principal with a floor, below which a
 * shortfall is a partial payment rather than arrears.
 */
async function markArrears(c, { asOf = null, loanId = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const { rows: cands } = await c.query(
    `SELECT i.*, l.account_no, l.status AS loan_status, l.arrears_since, l.principal_disbursed, l.principal_capitalized, l.principal_paid,
            ${ledger.overrideSql('arrearsToleranceDays')} AS tol_days,
            ${ledger.overrideSql('arrearsTolerancePercent')} AS tol_pct,
            ${ledger.settingSql('arrears_tolerance_floor')} AS tol_floor,
            ${ledger.settingSql('arrears_non_working_days')} AS arrears_non_working_days,
            ${ledger.settingSql('arrears_count_from')} AS arrears_count_from
     FROM loan_installments i
     JOIN loan_accounts l ON l.id = i.loan_id
     JOIN loan_products p ON p.id = l.product_id
     WHERE i.status IN ('PENDING','PARTIALLY_PAID') AND i.due_date < $1::date
       AND l.status IN ('ACTIVE','IN_ARREARS') AND ${G.EXCLUDED_SQL('l')}
       AND ($2::uuid IS NULL OR l.id = $2::uuid)
     ORDER BY i.loan_id, i.number`, [date, loanId]);

  // Loan by loan, each on its own (./eodGuard).
  const byLoan = new Map();
  for (const i of cands) {
    if (!byLoan.has(i.loan_id)) byLoan.set(i.loan_id, []);
    byLoan.get(i.loan_id).push(i);
  }
  const out = [];
  out.guard = await G.eachLoan(c, { job: 'markArrears', date }, [...byLoan.keys()], async (loanId) => {
    let f = null;
    for (const i of byLoan.get(loanId)) {
      const deadline = await toleranceDeadline(c, i.due_date, Number(i.tol_days), i.arrears_non_working_days === 'EXCLUDE');
      if (date <= deadline) continue;
      const shortfall = round2((i.principal_due - i.principal_paid) + (i.interest_due - i.interest_paid) + (i.fee_due - i.fee_paid));
      if (shortfall <= 0) continue;
      if (i.tol_pct !== null || i.tol_floor !== null) {
        const outstanding = round2(Number(i.principal_disbursed) + Number(i.principal_capitalized) - Number(i.principal_paid));
        const tolerance = Math.max(i.tol_pct !== null ? outstanding * Number(i.tol_pct) / 100 : 0, Number(i.tol_floor || 0));
        if (shortfall <= tolerance) continue;
      }
      await c.query("UPDATE loan_installments SET status = 'OVERDUE' WHERE id = $1", [i.id]);
      if (!f) f = { account_no: i.account_no, status: i.loan_status, since: ymd(i.due_date), countFrom: i.arrears_count_from, arrears_since: i.arrears_since };
    }
    if (!f) return;

    // Oldest currently-late installment is the arrears date under
    // OLDEST_LATE; under FIRST_ARREARS the date the loan first went into
    // arrears stands until it is back in good standing.
    const { rows: [o] } = await c.query(
      "SELECT min(due_date) AS d FROM loan_installments WHERE loan_id = $1 AND status = 'OVERDUE'", [loanId]);
    const since = f.countFrom === 'FIRST_ARREARS' && f.arrears_since ? ymd(f.arrears_since) : ymd(o.d);
    if (f.status === 'ACTIVE') {
      await c.query(
        `UPDATE loan_accounts SET status = 'IN_ARREARS', arrears_since = $2::date, charges_since_arrears = 0, updated_at = now() WHERE id = $1`,
        [loanId, since]);
      await history(c, loanId, { from: 'ACTIVE', to: 'IN_ARREARS', action: 'LATE_PAYMENT', actor: 'EOD', note: `installment due ${f.since}` });
      out.push({ id: loanId, account_no: f.account_no });
    } else {
      await c.query('UPDATE loan_accounts SET arrears_since = $2::date WHERE id = $1', [loanId, since]);
    }
  });
  return out;
}

/** After a repayment: is the loan back in good standing? */
async function refreshArrears(c, l, asOf) {
  const { rows: [o] } = await c.query(
    "SELECT count(*)::int AS n, min(due_date) AS oldest FROM loan_installments WHERE loan_id = $1 AND status = 'OVERDUE'", [l.id]);
  if (o.n === 0) {
    await c.query(
      "UPDATE loan_accounts SET status = 'ACTIVE', arrears_since = NULL, charges_since_arrears = 0, updated_at = now() WHERE id = $1 AND status = 'IN_ARREARS'",
      [l.id]);
    await history(c, l.id, { from: 'IN_ARREARS', to: 'ACTIVE', action: 'ARREARS_CLEARED', actor: 'SYSTEM', note: `repayment ${asOf}` });
    return 'ACTIVE';
  }
  if (l.arrears_count_from !== 'FIRST_ARREARS') {
    await c.query('UPDATE loan_accounts SET arrears_since = $2::date WHERE id = $1', [l.id, ymd(o.oldest)]);
  }
  return 'IN_ARREARS';
}

// --------------------------------------------------------------------------
// Cap on charges, auto-lock, auto-close: the EOD controls
// --------------------------------------------------------------------------

function capLimit(l) {
  if (l.charge_cap_percent === null || l.charge_cap_percent === undefined) return null;
  const base = l.charge_cap_base === 'ORIGINAL_PRINCIPAL' ? Number(l.principal) : ledger.principalOutstanding(l);
  return round2(base * Number(l.charge_cap_percent) / 100);
}

/**
 * How much of a charge of `amount` may be applied to a loan in arrears
 * under its cap. Uncapped, or not in arrears: all of it. Under a HARD cap
 * nothing beyond the limit is applied; under a SOFT cap the charge that
 * crosses the line is applied whole. Either way the loan is locked once
 * the limit is reached (see enforceControls); the lock here is immediate
 * so the next charge in the same run is refused too.
 */
async function capAllows(c, l, amount) {
  const limit = capLimit(l);
  if (limit === null || !['IN_ARREARS', 'LOCKED'].includes(l.status)) return round2(amount);
  if (l.status === 'LOCKED') return 0;
  const charged = Number(l.charges_since_arrears || 0);
  if (charged >= limit) { await lockForCap(c, l); return 0; }
  if (charged + amount <= limit) return round2(amount);
  if (l.charge_cap_mode === 'SOFT') { await lockForCap(c, l, { after: true }); return round2(amount); }
  await lockForCap(c, l);
  return round2(Math.max(0, limit - charged));
}

async function lockForCap(c, l) {
  await c.query(
    `UPDATE loan_accounts SET status = 'LOCKED', locked_at = now(), locked_reason = 'CAPPED', status_before_lock = status, updated_at = now()
     WHERE id = $1 AND status IN ('ACTIVE','IN_ARREARS')`, [l.id]);
  await history(c, l.id, { from: l.status, to: 'LOCKED', action: 'LOCK', actor: 'EOD', note: `charge cap ${l.charge_cap_percent}% of ${l.charge_cap_base} reached` });
  l.status = 'LOCKED';
}

/**
 * The nightly controls: lock loans whose charges have hit the cap or that
 * have sat in arrears past the product's limit, and close paid-off loans
 * the product says to close after N days.
 */
async function enforceControls(c, { asOf = null, loanId = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const out = { capped: 0, lockedForArrears: 0, closed: 0 };
  // Close dormant accounts (Mambu): a running loan that owes nothing and
  // holds no credit balance closes itself the product's number of days
  // after its last transaction. Fixed and dynamic loans close when paid;
  // this is for revolving loans at nothing and anything else left at zero.
  const { rows: idle } = await c.query(
    `SELECT l.id, p.auto_close_paid_off_days AS days,
            (SELECT max(t.value_date) FROM transactions t WHERE t.loan_account_id = l.id AND t.reversed_by IS NULL) AS last
     FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
     WHERE l.status = 'ACTIVE' AND p.auto_close_paid_off_days IS NOT NULL AND l.principal_disbursed > 0
       AND l.credit_balance = 0 AND ${G.EXCLUDED_SQL('l')} AND ($1::uuid IS NULL OR l.id = $1::uuid)
       AND l.principal_disbursed + l.principal_capitalized - l.principal_paid + l.interest_accrued - l.interest_paid
           + l.fees_due - l.fees_paid + l.penalty_accrued - l.penalty_paid + l.ns_fees_due - l.ns_fees_paid <= 0`, [loanId]);
  for (const r of idle) {
    if (!r.last) continue;
    const since = Math.floor((new Date(`${date}T00:00:00Z`) - new Date(`${ymd(r.last)}T00:00:00Z`)) / 86400000);
    if (since < Number(r.days)) continue;
    await c.query("UPDATE loan_accounts SET status = 'CLOSED_REPAID', closed_on = $2::date, updated_at = now() WHERE id = $1", [r.id, date]);
    await eligibility.releaseGuarantors(c, r.id);
    await securities.onClose(c, r.id);
    await history(c, r.id, { from: 'ACTIVE', to: 'CLOSED_REPAID', action: 'AUTO_CLOSE', actor: 'EOD', note: `nothing owed for ${since} day(s)` });
    out.closed += 1;
  }
  const { rows } = await c.query(
    `SELECT l.id FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
     WHERE l.status = 'IN_ARREARS' AND (p.charge_cap_percent IS NOT NULL OR p.auto_lock_arrears_days IS NOT NULL) AND ${G.EXCLUDED_SQL('l')}
       AND ($1::uuid IS NULL OR l.id = $1::uuid)`, [loanId]);
  const run = await G.eachLoan(c, { job: 'enforceControls', date }, rows, async (id) => {
    const l = await ledger.lock(c, id);
    if (l.status !== 'IN_ARREARS') return;
    const limit = capLimit(l);
    // With cap_includes_accrued, charges accrued and not yet applied count too.
    const charges = Number(l.charges_since_arrears) + (l.cap_includes_accrued ? Number(l.penalty_unapplied || 0) : 0);
    if (limit !== null && charges >= limit) { await lockForCap(c, l); out.capped += 1; return; }
    if (l.auto_lock_arrears_days !== null && daysInArrears(l, date) >= Number(l.auto_lock_arrears_days)) {
      await c.query(
        `UPDATE loan_accounts SET status = 'LOCKED', locked_at = now(), locked_reason = 'ARREARS', status_before_lock = status, updated_at = now() WHERE id = $1`, [l.id]);
      await history(c, l.id, { from: 'IN_ARREARS', to: 'LOCKED', action: 'LOCK', actor: 'EOD', note: `${l.auto_lock_arrears_days} days in arrears` });
      out.lockedForArrears += 1;
    }
  });
  return { ...out, ...G.summary(run) };
}

module.exports = {
  assertTopUpStands,
  ACTIONS, ALIASES, OPEN, RUNNING, transition, history, historyOf, previousState,
  controls, updateControls, exposure, userLimits, assertMayApprove, assertMayDisburse, assertMayWriteOff,
  amend, TERM_FIELDS, NARRATIVE_FIELDS, setDisbursementDetails, disbursementDetails, DISBURSEMENT_FIELDS,
  markArrears, refreshArrears, daysInArrears, toleranceDeadline, freezeSettings, thawSettings, arrearsIndicators,
  capLimit, capAllows, enforceControls,
};
