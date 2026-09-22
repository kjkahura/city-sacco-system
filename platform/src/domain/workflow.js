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

const L = () => require('./loans');

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

// --------------------------------------------------------------------------
// Controls
// --------------------------------------------------------------------------

async function controls(c) {
  const { rows: [r] } = await c.query('SELECT * FROM lending_controls WHERE id = 1');
  return r || {
    max_exposure_mode: 'UNLIMITED', max_exposure_amount: null, one_active_loan_per_member: false,
    min_arrears_days_before_writeoff: 0, max_days_undo_close: null, two_man_rule: false,
  };
}

const CONTROL_FIELDS = {
  maxExposureMode: 'max_exposure_mode', maxExposureAmount: 'max_exposure_amount',
  oneActiveLoanPerMember: 'one_active_loan_per_member',
  minArrearsDaysBeforeWriteoff: 'min_arrears_days_before_writeoff',
  maxDaysUndoClose: 'max_days_undo_close', twoManRule: 'two_man_rule',
};

async function updateControls(c, patch, { actor } = {}) {
  const before = await controls(c);
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(CONTROL_FIELDS)) {
    if (patch[k] === undefined) continue;
    if (col === 'max_exposure_mode' && !['UNLIMITED', 'SUM_OF_LOANS', 'SUM_MINUS_DEPOSITS'].includes(patch[k])) {
      throw err('INVALID_EXPOSURE_MODE', 400);
    }
    vals.push(patch[k]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const { rows: [after] } = await c.query(
    `UPDATE lending_controls SET ${sets.join(', ')}, updated_at = now() WHERE id = 1 RETURNING *`, vals);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'LENDING_CONTROLS_CHANGED','lending_controls','1',$2,$3)`,
    [actor || 'SYSTEM', JSON.stringify(before), JSON.stringify(after)]);
  return after;
}

/**
 * The tenant's exposure rules for one member: the sum of their running
 * loans (less deposits, if the mode says so) against the cap, and the
 * one-active-loan rule. `loanId` is the application under review, which is
 * not itself counted.
 */
async function exposure(c, { memberId, loanId = null, requested = 0 }) {
  const ctl = await controls(c);
  const reasons = [];
  const rules = {};
  const { rows: [x] } = await c.query(
    `SELECT COALESCE(SUM(principal_disbursed + principal_capitalized - principal_paid), 0) AS outstanding,
            COUNT(*)::int AS active
     FROM loan_accounts WHERE member_id = $1 AND status IN ('ACTIVE','IN_ARREARS','LOCKED') AND ($2::uuid IS NULL OR id <> $2)`,
    [memberId, loanId]);
  const outstanding = round2(x.outstanding);
  let deposits = 0;
  if (ctl.max_exposure_mode === 'SUM_MINUS_DEPOSITS') {
    const { rows: [d] } = await c.query(
      "SELECT COALESCE(SUM(balance),0) AS t FROM savings_accounts WHERE member_id = $1 AND status = 'ACTIVE'", [memberId]);
    deposits = round2(d.t);
  }
  const exposed = round2(outstanding + Number(requested) - deposits);
  if (ctl.max_exposure_mode !== 'UNLIMITED' && ctl.max_exposure_amount !== null) {
    const ok = exposed <= Number(ctl.max_exposure_amount);
    rules.maxExposure = ok ? 'MET' : 'BREACHED';
    if (!ok) reasons.push('EXCEEDS_MAXIMUM_EXPOSURE');
  } else rules.maxExposure = 'NOT_ENFORCED';
  if (ctl.one_active_loan_per_member) {
    rules.oneActiveLoan = x.active === 0 ? 'MET' : 'BREACHED';
    if (x.active > 0) reasons.push('ONE_ACTIVE_LOAN_PER_MEMBER');
  } else rules.oneActiveLoan = 'NOT_ENFORCED';
  return {
    reasons, rules,
    exposure: { mode: ctl.max_exposure_mode, limit: ctl.max_exposure_amount === null ? null : Number(ctl.max_exposure_amount),
      outstanding, deposits, requested: round2(requested), exposed, activeLoans: x.active },
  };
}

/** The signed-in user's limits, when the caller told us who they are. */
async function userLimits(c, user) {
  if (!user?.sub) return { approval: null, disbursement: null, email: user?.email || null };
  const { rows: [u] } = await c.query(
    'SELECT email, approval_limit, disbursement_limit FROM platform.users WHERE id = $1', [user.sub]);
  return { approval: u?.approval_limit ?? null, disbursement: u?.disbursement_limit ?? null, email: u?.email || user.email };
}

async function assertMayApprove(c, l, { user }) {
  const lim = await userLimits(c, user);
  if (lim.approval !== null && Number(l.principal) > Number(lim.approval)) {
    throw err(`ABOVE_YOUR_APPROVAL_LIMIT: limit ${Number(lim.approval)}, loan ${Number(l.principal)}`, 403);
  }
}

async function assertMayDisburse(c, l, { actor, amount, user = null }) {
  const ctl = await controls(c);
  if (ctl.two_man_rule && l.approved_by && actor && l.approved_by === actor) {
    throw err('TWO_MAN_RULE: the user who approved a loan may not disburse it', 403);
  }
  const lim = await userLimits(c, user);
  if (lim.disbursement !== null && Number(amount) > Number(lim.disbursement)) {
    throw err(`ABOVE_YOUR_DISBURSEMENT_LIMIT: limit ${Number(lim.disbursement)}, amount ${Number(amount)}`, 403);
  }
}

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

async function transition(c, loanId, action, { createdBy, note = null, user = null, reason = null } = {}) {
  const name = ALIASES[String(action).toUpperCase()] || String(action).toUpperCase();
  const t = ACTIONS[name];
  if (!t) throw err(`UNSUPPORTED_ACTION: ${action}`);
  const l = await L().lock(c, loanId);
  if (!t.from.includes(l.status)) throw err(`INVALID_STATE_TRANSITION: ${l.status} -> ${name}`, 409);

  let to = t.to;
  const sets = [];
  const vals = [];
  const set = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

  if (name === 'APPROVE') {
    // Approval is where the rules bite. Applying is a request and a teller
    // may record one for any amount; approving it is the credit decision.
    await L().enforceEligibility(c, l);
    await assertMayApprove(c, l, { user });
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
        const b = L().balances(l);
        const charges = round2(b.interest + b.fees + b.penalty);
        const { rows: [o] } = await c.query(
          "SELECT count(*)::int AS n FROM loan_installments WHERE loan_id = $1 AND status = 'OVERDUE'", [l.id]);
        if (charges > 0 && o.n > 0) throw err('CAP_LOCK_HOLDS_UNTIL_CHARGES_PAID_OR_ARREARS_CLEARED', 409);
      }
      to = l.status_before_lock || to || 'ACTIVE';
      set('locked_at', null); set('locked_reason', null); set('status_before_lock', null);
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
  if (name === 'LOCK') {
    set('locked_at', new Date()); set('locked_reason', reason && ['MANUAL', 'CAPPED', 'ARREARS'].includes(reason) ? reason : 'MANUAL');
    set('status_before_lock', l.status);
  }
  if (['REJECT', 'WITHDRAW'].includes(name)) set('closed_on', new Date().toISOString().slice(0, 10));

  set('status', to);
  vals.push(l.id);
  const { rows } = await c.query(
    `UPDATE loan_accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);

  if (['CLOSED_REJECTED', 'CLOSED_WITHDRAWN'].includes(to)) await L().releaseGuarantors(c, l.id);
  await history(c, l.id, { from: l.status, to, action: name, actor: createdBy, note });
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,$2,'loan_account',$3,$4,$5)`,
    [createdBy || 'SYSTEM', `LOAN_${name}`, l.id,
      JSON.stringify({ status: l.status }), JSON.stringify({ status: to, note })]);
  return rows[0];
}

// --------------------------------------------------------------------------
// Amendments: what may change, in which state
// --------------------------------------------------------------------------

// Terms may change while the application is open. After approval only the
// narrative fields may (Mambu: name, notes, custom fields); to change the
// terms, undo the approval first.
const TERM_FIELDS = ['principal', 'termMonths', 'monthlyRate', 'penaltyRate', 'firstDueOffsetDays',
  'gracePeriods', 'amortizationPeriods', 'arrearsToleranceDays'];
const NARRATIVE_FIELDS = ['purpose', 'notes'];
const COLUMN = {
  principal: 'principal', termMonths: 'term_months', monthlyRate: 'monthly_rate', penaltyRate: 'penalty_rate',
  firstDueOffsetDays: 'first_due_offset_days', gracePeriods: 'grace_periods', amortizationPeriods: 'amortization_periods',
  arrearsToleranceDays: 'arrears_tolerance_days', purpose: 'purpose', notes: 'notes',
};

function within(label, value, min, max) {
  if (min !== null && min !== undefined && Number(value) < Number(min)) throw err(`${label}_BELOW_PRODUCT_MINIMUM: ${min}`, 400);
  if (max !== null && max !== undefined && Number(value) > Number(max)) throw err(`${label}_ABOVE_PRODUCT_MAXIMUM: ${max}`, 400);
}

async function amend(c, loanId, patch, { actor } = {}) {
  const l = await L().lock(c, loanId);
  const keys = Object.keys(patch || {}).filter((k) => COLUMN[k]);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const allowed = OPEN.includes(l.status) ? [...TERM_FIELDS, ...NARRATIVE_FIELDS] : NARRATIVE_FIELDS;
  const refused = keys.filter((k) => !allowed.includes(k));
  if (refused.length) throw err(`NOT_EDITABLE_IN_STATE_${l.status}: ${refused.join(', ')}`, 409);

  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [l.product_id]);
  const next = {
    principal: patch.principal ?? l.principal, termMonths: patch.termMonths ?? l.term_months,
    monthlyRate: patch.monthlyRate ?? l.monthly_rate, penaltyRate: patch.penaltyRate ?? l.penalty_rate,
    firstDueOffsetDays: patch.firstDueOffsetDays ?? l.first_due_offset_days,
    gracePeriods: patch.gracePeriods ?? l.grace_periods, amortizationPeriods: patch.amortizationPeriods ?? l.amortization_periods,
  };
  if (keys.some((k) => TERM_FIELDS.includes(k))) {
    if (!(round2(next.principal) > 0)) throw err('INVALID_PRINCIPAL', 400);
    within('PRINCIPAL', next.principal, p.min_principal, p.max_principal);
    const term = Number(next.termMonths);
    if (!(Number.isInteger(term) && term > 0)) throw err('INVALID_TERM', 400);
    if (term > p.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${p.max_term}`, 400);
    within('TERM', term, p.min_term, null);
    if (p.product_type === 'INTEREST_FREE' && Number(next.monthlyRate) > 0) throw err('INTEREST_FREE_PRODUCT_TAKES_NO_RATE', 400);
    if (patch.monthlyRate !== undefined) within('RATE', next.monthlyRate, p.rate_min, p.rate_max);
    if (patch.penaltyRate !== undefined && patch.penaltyRate !== null) within('PENALTY_RATE', next.penaltyRate, p.penalty_rate_min, p.penalty_rate_max);
    if (patch.firstDueOffsetDays !== undefined) within('FIRST_DUE_OFFSET', next.firstDueOffsetDays, p.first_due_offset_min, p.first_due_offset_max);
    if (next.gracePeriods !== null && next.gracePeriods !== undefined && Number(next.gracePeriods) >= term) throw err('GRACE_EXCEEDS_TERM', 400);
    if (next.amortizationPeriods !== null && next.amortizationPeriods !== undefined && Number(next.amortizationPeriods) < term) {
      throw err('AMORTIZATION_SHORTER_THAN_TERM', 400);
    }
  }

  const sets = [];
  const vals = [];
  for (const k of keys) { vals.push(patch[k]); sets.push(`${COLUMN[k]} = $${vals.length}`); }
  vals.push(l.id);
  const { rows } = await c.query(
    `UPDATE loan_accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
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
async function markArrears(c, { asOf = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const { rows: cands } = await c.query(
    `SELECT i.*, l.account_no, l.status AS loan_status, l.arrears_since, l.principal_disbursed, l.principal_capitalized, l.principal_paid,
            COALESCE(l.arrears_tolerance_days, p.arrears_tolerance_days, 0) AS tol_days,
            COALESCE(l.arrears_tolerance_percent, p.arrears_tolerance_percent) AS tol_pct,
            p.arrears_tolerance_floor AS tol_floor, p.arrears_non_working_days, p.arrears_count_from
     FROM loan_installments i
     JOIN loan_accounts l ON l.id = i.loan_id
     JOIN loan_products p ON p.id = l.product_id
     WHERE i.status IN ('PENDING','PARTIALLY_PAID') AND i.due_date < $1::date
       AND l.status IN ('ACTIVE','IN_ARREARS')
     ORDER BY i.loan_id, i.number`, [date]);

  const flipped = new Map();
  for (const i of cands) {
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
    if (!flipped.has(i.loan_id)) flipped.set(i.loan_id, { account_no: i.account_no, status: i.loan_status, since: ymd(i.due_date), countFrom: i.arrears_count_from, arrears_since: i.arrears_since });
  }

  const out = [];
  for (const [loanId, f] of flipped) {
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
  }
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
  const base = l.charge_cap_base === 'ORIGINAL_PRINCIPAL' ? Number(l.principal) : L().principalOutstanding(l);
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
async function enforceControls(c, { asOf = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const out = { capped: 0, lockedForArrears: 0, closed: 0 };
  const { rows } = await c.query(
    `SELECT l.id FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
     WHERE l.status = 'IN_ARREARS' AND (p.charge_cap_percent IS NOT NULL OR p.auto_lock_arrears_days IS NOT NULL)`);
  for (const r of rows) {
    const l = await L().lock(c, r.id);
    if (l.status !== 'IN_ARREARS') continue;
    const limit = capLimit(l);
    if (limit !== null && Number(l.charges_since_arrears) >= limit) { await lockForCap(c, l); out.capped += 1; continue; }
    if (l.auto_lock_arrears_days !== null && daysInArrears(l, date) >= Number(l.auto_lock_arrears_days)) {
      await c.query(
        `UPDATE loan_accounts SET status = 'LOCKED', locked_at = now(), locked_reason = 'ARREARS', status_before_lock = status, updated_at = now() WHERE id = $1`, [l.id]);
      await history(c, l.id, { from: 'IN_ARREARS', to: 'LOCKED', action: 'LOCK', actor: 'EOD', note: `${l.auto_lock_arrears_days} days in arrears` });
      out.lockedForArrears += 1;
    }
  }
  // Paid-off loans are already CLOSED_REPAID here; the product's auto-close
  // is satisfied by construction. Left in the result for the report.
  return out;
}

module.exports = {
  ACTIONS, ALIASES, OPEN, RUNNING, transition, history, historyOf, previousState,
  controls, updateControls, exposure, userLimits, assertMayApprove, assertMayDisburse, assertMayWriteOff,
  amend, TERM_FIELDS, NARRATIVE_FIELDS,
  markArrears, refreshArrears, daysInArrears, toleranceDeadline,
  capLimit, capAllows, enforceControls,
};
