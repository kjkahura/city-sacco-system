'use strict';

const PERMS = require('../lib/permissions');

const acct = require('./accounting');
const { recordAudit } = require('../lib/auditLog');
const { err, round2 } = acct;

/**
 * The tenant's lending controls (the reference platform "Internal Controls"): exposure caps,
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
  payOffRoles: 'pay_off_roles', loanAdjustmentRoles: 'loan_adjustment_roles', collectSecuritiesRoles: 'collect_securities_roles',
};
// Role lists where NULL means "any role that may do the underlying action".
const NULLABLE_ROLE_LISTS = ['custom_allocation_roles', 'disbursement_conditions_roles', 'pay_off_roles', 'loan_adjustment_roles',
  'collect_securities_roles'];
const BUILTIN_ROLES = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'];

async function updateControls(c, patch, { actor } = {}) {
  const before = await controls(c);
  const sets = [];
  const vals = [];
  // Built-in roles and the tenant's own.
  const ROLES = [...BUILTIN_ROLES, ...(await c.query('SELECT code FROM roles WHERE NOT builtin')).rows.map((r) => r.code)];
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
  await recordAudit(c, { actor: actor || 'SYSTEM', action: 'LENDING_CONTROLS_CHANGED', entity: 'lending_controls', entityId: '1', before: JSON.stringify(before), after: JSON.stringify(after) });
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
      "SELECT COALESCE(SUM(balance),0) AS t FROM savings_accounts WHERE member_id = $1 AND status IN ('ACTIVE', 'IN_ARREARS')", [memberId]);
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

/**
 * The signed-in user's limits (the reference platform's transaction limits on a user), when
 * the caller told us who they are. The reference platform offers them for users who are not
 * administrators; here a limit set on an administrator holds too.
 */
async function userLimits(c, user) {
  const none = { approval: null, disbursement: null, fee: null, deposit: null, withdrawal: null, repayment: null, email: user?.email || null, daily: {} };
  // An API consumer's limits are its own (platform migration 017), per transaction and per day.
  if (user?.apiConsumer) {
    if (!user.consumerId) return none;
    const { rows: [k] } = await c.query(
      `SELECT deposit_limit, withdrawal_limit, repayment_limit, daily_deposit_limit, daily_withdrawal_limit, daily_repayment_limit
       FROM platform.api_consumers WHERE id = $1`, [user.consumerId]);
    if (!k) return none;
    return { ...none, deposit: k.deposit_limit ?? null, withdrawal: k.withdrawal_limit ?? null, repayment: k.repayment_limit ?? null,
      daily: { deposit: k.daily_deposit_limit ?? null, withdrawal: k.daily_withdrawal_limit ?? null, repayment: k.daily_repayment_limit ?? null },
      key: `consumer:${user.consumerId}` };
  }
  if (!user?.sub) return none;
  const { rows: [u] } = await c.query(
    `SELECT email, approval_limit, disbursement_limit, fee_limit, deposit_limit, withdrawal_limit, repayment_limit,
            daily_deposit_limit, daily_withdrawal_limit, daily_repayment_limit
     FROM platform.users WHERE id = $1`, [user.sub]);
  if (!u) return none;
  return {
    approval: u.approval_limit ?? null, disbursement: u.disbursement_limit ?? null, fee: u.fee_limit ?? null,
    deposit: u.deposit_limit ?? null, withdrawal: u.withdrawal_limit ?? null, repayment: u.repayment_limit ?? null, email: u.email,
    daily: { deposit: u.daily_deposit_limit ?? null, withdrawal: u.daily_withdrawal_limit ?? null, repayment: u.daily_repayment_limit ?? null },
    key: `user:${user.sub}`,
  };
}

// What counts towards a daily limit: money in, money out (transfers included) and repayments taken today.
const DAILY_KINDS = { deposit: ['SAVINGS_DEPOSIT'], withdrawal: ['SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER'], repayment: ['LOAN_REPAYMENT'] };

const LIMIT_NAMES = { fee: 'FEE_APPLICATION', deposit: 'DEPOSIT', withdrawal: 'WITHDRAWAL', repayment: 'REPAYMENT' };
/** Refuse an amount above the user's limit for fees, deposits, withdrawals or repayments. */
async function assertWithinLimit(c, user, kind, amount) {
  const all = await userLimits(c, user);
  const lim = all[kind];
  if (lim !== null && lim !== undefined && Number(amount) > Number(lim)) {
    throw err(`ABOVE_YOUR_${LIMIT_NAMES[kind]}_LIMIT: limit ${Number(lim)}, amount ${Number(amount)}`, 403);
  }
  const day = all.daily?.[kind];
  if (day !== null && day !== undefined && DAILY_KINDS[kind] && all.email) {
    // One posting at a time per user for this check, so two at once cannot both fit under the limit.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`daily-limit:${all.key}:${kind}`]);
    const { rows: [s] } = await c.query(
      `SELECT COALESCE(sum(amount), 0) AS n FROM transactions
        WHERE lower(created_by) = lower($1) AND kind = ANY($2) AND reversed_by IS NULL AND created_at >= current_date`,
      [all.email, DAILY_KINDS[kind]]);
    if (Number(s.n) + Number(amount) > Number(day)) {
      throw err(`ABOVE_YOUR_DAILY_${LIMIT_NAMES[kind]}_LIMIT: limit ${Number(day)} a day, already ${Number(s.n)} today, amount ${Number(amount)}`, 403);
    }
  }
}

async function assertMayApprove(c, l, { user }) {
  const lim = await userLimits(c, user);
  if (lim.approval !== null && Number(l.principal) > Number(lim.approval)) {
    throw err(`ABOVE_YOUR_APPROVAL_LIMIT: limit ${Number(lim.approval)}, loan ${Number(l.principal)}`, 403);
  }
}

async function assertMayDisburse(c, l, { actor, amount, user = null }) {
  const ctl = await controls(c);
  if (ctl.two_man_rule && l.approved_by && actor && String(l.approved_by).toLowerCase() === String(actor).toLowerCase()) {
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
  if (user && !PERMS.can(user, 'POST_TRANSACTIONS_ON_LOCKED_LOAN_ACCOUNTS')) {
    throw err('PERMISSION_REQUIRED: POST_TRANSACTIONS_ON_LOCKED_LOAN_ACCOUNTS', 403);
  }
  if (!user || !listed(roles, user)) {
    throw err(`LOAN_IS_LOCKED: posting on a locked loan needs one of ${roles.length ? roles.join(', ') : 'the roles the tenant allows (none set)'}`, 409);
  }
}

/**
 * The reference platform's permission to post repayments with a custom allocation: the roles
 * the tenant lists, or anyone who may post repayments when it lists none.
 */
async function assertMayAllocateCustom(c, { user = null } = {}) {
  if (user && !PERMS.can(user, 'PERFORM_REPAYMENTS_WITH_CUSTOM_AMOUNTS_ALLOCATION')) {
    throw err('PERMISSION_REQUIRED: PERFORM_REPAYMENTS_WITH_CUSTOM_AMOUNTS_ALLOCATION', 403);
  }
  const roles = (await controls(c)).custom_allocation_roles;
  if (roles === null || roles === undefined) return;
  if (!user || !listed(roles, user)) {
    throw err(`CUSTOM_ALLOCATION_NOT_PERMITTED: needs one of ${roles.length ? roles.join(', ') : 'the roles the tenant allows (none set)'}`, 403);
  }
}

// The reference platform permission behind each role list on the controls. The lists
// narrow it further (a tenant's own rule); they name built-in roles or the
// tenant's roles.
const PERMISSION_OF = { pay_off_roles: 'PAY_OFF_LOAN', loan_adjustment_roles: 'APPLY_LOAN_ADJUSTMENTS', collect_securities_roles: 'COLLECT_GUARANTIES' };
const listed = (roles, user) => roles.includes(user.role) || (user.roleCode && roles.includes(user.roleCode));

/**
 * A permission kept as a role list on the controls: the roles listed, or
 * any role the route allows when the list is NULL.
 */
async function assertRole(c, col, user, code) {
  if (user && PERMISSION_OF[col] && !PERMS.can(user, PERMISSION_OF[col])) throw err(`PERMISSION_REQUIRED: ${PERMISSION_OF[col]}`, 403);
  const roles = (await controls(c))[col];
  if (roles === null || roles === undefined) return;
  if (!user || !listed(roles, user)) {
    throw err(`${code}_NOT_PERMITTED: needs one of ${roles.length ? roles.join(', ') : 'the roles the tenant allows (none set)'}`, 403);
  }
}
/** The reference platform's Pay Off Loan Accounts permission. */
const assertMayPayOff = (c, { user = null } = {}) => assertRole(c, 'pay_off_roles', user, 'PAY_OFF');
/** The reference platform's Apply Loan Adjustments: writing charges off in a pay-off, reducing a balance. */
const assertMayAdjust = (c, { user = null } = {}) => assertRole(c, 'loan_adjustment_roles', user, 'LOAN_ADJUSTMENT');
/** The reference platform's Collect Securities, on a write-off. */
const assertMayCollectSecurities = (c, { user = null } = {}) => assertRole(c, 'collect_securities_roles', user, 'COLLECT_SECURITIES');

/** The reference platform's Set Disbursement Conditions permission, the same way. */
async function assertMaySetDisbursementConditions(c, { user = null } = {}) {
  if (user && !PERMS.can(user, 'SET_DISBURSEMENT_CONDITIONS')) throw err('PERMISSION_REQUIRED: SET_DISBURSEMENT_CONDITIONS', 403);
  const roles = (await controls(c)).disbursement_conditions_roles;
  if (roles === null || roles === undefined) return;
  if (!user || !listed(roles, user)) {
    throw err(`DISBURSEMENT_CONDITIONS_NOT_PERMITTED: needs one of ${roles.length ? roles.join(', ') : 'the roles the tenant allows (none set)'}`, 403);
  }
}

/** The tenant's staff with their approval and disbursement limits (the reference platform's transaction limits on a user). */
const LIMIT_COLS = { approvalLimit: 'approval_limit', disbursementLimit: 'disbursement_limit', feeLimit: 'fee_limit',
  depositLimit: 'deposit_limit', withdrawalLimit: 'withdrawal_limit', repaymentLimit: 'repayment_limit',
  dailyDepositLimit: 'daily_deposit_limit', dailyWithdrawalLimit: 'daily_withdrawal_limit', dailyRepaymentLimit: 'daily_repayment_limit' };
const limitsOf = (u) => Object.fromEntries(Object.entries(LIMIT_COLS).map(([k, col]) => [k, u[col] === null ? null : Number(u[col])]));

async function staffLimits(c, tenantId) {
  const { rows } = await c.query(
    `SELECT id, email, full_name, role, status, ${Object.values(LIMIT_COLS).join(', ')} FROM platform.users
     WHERE tenant_id = $1 AND role <> 'MEMBER' ORDER BY role, email`, [tenantId]);
  return rows.map((u) => ({ id: u.id, email: u.email, name: u.full_name, role: u.role, status: u.status, ...limitsOf(u) }));
}

/**
 * Set a user's limits (the reference platform's six transaction limits). Null lifts a limit;
 * a number is the most they may approve or disburse, or post at once as a
 * fee, deposit, withdrawal or repayment. Administrators have none.
 */
async function setUserLimits(c, tenantId, userId, body = {}, { actor } = {}) {
  const { rows: [u] } = await c.query(
    `SELECT id, email, ${Object.values(LIMIT_COLS).join(', ')} FROM platform.users WHERE id::text = $1 AND tenant_id = $2 FOR UPDATE`, [userId, tenantId]);
  if (!u) throw err('USER_NOT_FOUND', 404);
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(LIMIT_COLS)) {
    const given = body[k];
    if (given === undefined) continue;
    if (given !== null && !(Number(given) >= 0)) throw err(`${col.toUpperCase()}_MUST_BE_ZERO_OR_MORE`, 400);
    vals.push(given === null ? null : round2(given));
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) throw err('NO_UPDATABLE_FIELDS', 400);
  vals.push(u.id);
  const { rows: [after] } = await c.query(
    `UPDATE platform.users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, email, ${Object.values(LIMIT_COLS).join(', ')}`, vals);
  await recordAudit(c, { actor: actor || 'SYSTEM', action: 'USER_LIMITS_CHANGED', entity: 'user', entityId: String(u.id), before: JSON.stringify(limitsOf(u)), after: JSON.stringify(limitsOf(after)) });
  return (await staffLimits(c, tenantId)).find((x) => x.id === u.id);
}

module.exports = {
  controls, updateControls, exposure, userLimits, assertMayApprove, assertMayDisburse, assertMayPostOnLocked, CONTROL_FIELDS,
  assertMayAllocateCustom, assertMaySetDisbursementConditions, assertMayPayOff, assertMayAdjust, assertMayCollectSecurities,
  staffLimits, setUserLimits, assertWithinLimit,
};
