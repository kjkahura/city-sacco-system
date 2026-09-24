'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * The tenant's lending controls (Mambu "Internal Controls"): exposure caps,
 * one active loan per member, the write-off and undo windows, the two-man
 * rule, whether a write-off needs a second person's approval, and each
 * user's approval and disbursement limits.
 *
 * Read by eligibility (exposure), by workflow (approval, undo windows,
 * write-off) and by disbursement. Depends on nothing but the database.
 */

async function controls(c) {
  const { rows: [r] } = await c.query('SELECT * FROM lending_controls WHERE id = 1');
  return r || {
    max_exposure_mode: 'UNLIMITED', max_exposure_amount: null, one_active_loan_per_member: false,
    min_arrears_days_before_writeoff: 0, max_days_undo_close: null, two_man_rule: false, write_off_requires_approval: true,
  };
}

const CONTROL_FIELDS = {
  maxExposureMode: 'max_exposure_mode', maxExposureAmount: 'max_exposure_amount',
  oneActiveLoanPerMember: 'one_active_loan_per_member',
  minArrearsDaysBeforeWriteoff: 'min_arrears_days_before_writeoff',
  maxDaysUndoClose: 'max_days_undo_close', twoManRule: 'two_man_rule',
  writeOffRequiresApproval: 'write_off_requires_approval',
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
 * not itself counted, and `refinancing` the running loan a top-up
 * application will settle, which is not counted either: the application's
 * principal already includes what it owes.
 */
async function exposure(c, { memberId, loanId = null, refinancing = null, requested = 0 }) {
  const ctl = await controls(c);
  const reasons = [];
  const rules = {};
  const { rows: [x] } = await c.query(
    `SELECT COALESCE(SUM(principal_disbursed + principal_capitalized - principal_paid), 0) AS outstanding,
            COUNT(*)::int AS active
     FROM loan_accounts WHERE member_id = $1 AND status IN ('ACTIVE','IN_ARREARS','LOCKED') AND NOT (id = ANY($2::uuid[]))`,
    [memberId, [loanId, refinancing].filter(Boolean)]);
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

module.exports = {
  controls, updateControls, exposure, userLimits, assertMayApprove, assertMayDisburse, CONTROL_FIELDS,
};
