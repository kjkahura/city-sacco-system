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
  lockedPostingRoles: 'locked_posting_roles',
  customAllocationRoles: 'custom_allocation_roles',
  disbursementConditionsRoles: 'disbursement_conditions_roles',
};
// Role lists where NULL means "any role that may do the underlying action".
const NULLABLE_ROLE_LISTS = ['custom_allocation_roles', 'disbursement_conditions_roles'];
const ROLES = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'];

async function updateControls(c, patch, { actor } = {}) {
  const before = await controls(c);
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(CONTROL_FIELDS)) {
    if (patch[k] === undefined) continue;
    if (col === 'max_exposure_mode' && !['UNLIMITED', 'SUM_OF_LOANS', 'SUM_MINUS_DEPOSITS'].includes(patch[k])) {
      throw err('INVALID_EXPOSURE_MODE', 400);
    }
    if (col === 'locked_posting_roles' && (!Array.isArray(patch[k]) || patch[k].some((r) => !ROLES.includes(r)))) {
      throw err(`LOCKED_POSTING_ROLES_LIST_ANY_OF: ${ROLES.join(', ')}`, 400);
    }
    if (NULLABLE_ROLE_LISTS.includes(col) && patch[k] !== null
      && (!Array.isArray(patch[k]) || patch[k].some((r) => !ROLES.includes(r)))) {
      throw err(`${col.toUpperCase()}_LIST_ANY_OF: ${ROLES.join(', ')} (or null for any)`, 400);
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

/**
 * Posting a repayment on a locked loan needs a role the tenant allows
 * (lending_controls.locked_posting_roles). With no user (the end of day, a
 * settlement transfer) it is refused like any posting on a locked loan.
 */
async function assertMayPostOnLocked(c, { user = null } = {}) {
  const ctl = await controls(c);
  const roles = ctl.locked_posting_roles || [];
  if (!user || !roles.includes(user.role)) {
    throw err(`LOAN_IS_LOCKED: posting on a locked loan needs one of ${roles.length ? roles.join(', ') : 'the roles the tenant allows (none set)'}`, 409);
  }
}

/**
 * Mambu's permission to post repayments with a custom allocation: the roles
 * the tenant lists, or anyone who may post repayments when it lists none.
 */
async function assertMayAllocateCustom(c, { user = null } = {}) {
  const roles = (await controls(c)).custom_allocation_roles;
  if (roles === null || roles === undefined) return;
  if (!user || !roles.includes(user.role)) {
    throw err(`CUSTOM_ALLOCATION_NOT_PERMITTED: needs one of ${roles.length ? roles.join(', ') : 'the roles the tenant allows (none set)'}`, 403);
  }
}

/** Mambu's Set Disbursement Conditions permission, the same way. */
async function assertMaySetDisbursementConditions(c, { user = null } = {}) {
  const roles = (await controls(c)).disbursement_conditions_roles;
  if (roles === null || roles === undefined) return;
  if (!user || !roles.includes(user.role)) {
    throw err(`DISBURSEMENT_CONDITIONS_NOT_PERMITTED: needs one of ${roles.length ? roles.join(', ') : 'the roles the tenant allows (none set)'}`, 403);
  }
}

/** The tenant's staff with their approval and disbursement limits (Mambu's transaction limits on a user). */
async function staffLimits(c, tenantId) {
  const { rows } = await c.query(
    `SELECT id, email, full_name, role, status, approval_limit, disbursement_limit FROM platform.users
     WHERE tenant_id = $1 AND role <> 'MEMBER' ORDER BY role, email`, [tenantId]);
  return rows.map((u) => ({
    id: u.id, email: u.email, name: u.full_name, role: u.role, status: u.status,
    approvalLimit: u.approval_limit === null ? null : Number(u.approval_limit),
    disbursementLimit: u.disbursement_limit === null ? null : Number(u.disbursement_limit),
  }));
}

/**
 * Set a user's limits. Null lifts a limit (the user's role then decides);
 * a number is the largest loan they may approve, or disburse at once.
 */
async function setUserLimits(c, tenantId, userId, { approvalLimit, disbursementLimit } = {}, { actor } = {}) {
  const { rows: [u] } = await c.query(
    'SELECT id, email, approval_limit, disbursement_limit FROM platform.users WHERE id::text = $1 AND tenant_id = $2 FOR UPDATE', [userId, tenantId]);
  if (!u) throw err('USER_NOT_FOUND', 404);
  const sets = [];
  const vals = [];
  for (const [given, col] of [[approvalLimit, 'approval_limit'], [disbursementLimit, 'disbursement_limit']]) {
    if (given === undefined) continue;
    if (given !== null && !(Number(given) >= 0)) throw err(`${col.toUpperCase()}_MUST_BE_ZERO_OR_MORE`, 400);
    vals.push(given === null ? null : round2(given));
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) throw err('NO_UPDATABLE_FIELDS', 400);
  vals.push(u.id);
  const { rows: [after] } = await c.query(
    `UPDATE platform.users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, email, approval_limit, disbursement_limit`, vals);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'USER_LIMITS_CHANGED','user',$2,$3,$4)`,
    [actor || 'SYSTEM', String(u.id), JSON.stringify({ approvalLimit: u.approval_limit, disbursementLimit: u.disbursement_limit }),
      JSON.stringify({ approvalLimit: after.approval_limit, disbursementLimit: after.disbursement_limit })]);
  return (await staffLimits(c, tenantId)).find((x) => x.id === u.id);
}

module.exports = {
  controls, updateControls, exposure, userLimits, assertMayApprove, assertMayDisburse, assertMayPostOnLocked, CONTROL_FIELDS,
  assertMayAllocateCustom, assertMaySetDisbursementConditions,
  staffLimits, setUserLimits,
};
