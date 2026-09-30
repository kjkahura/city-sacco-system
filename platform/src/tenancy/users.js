'use strict';

const crypto = require('crypto');
const { pool } = require('../db/pool');
const { withTenantRead } = require('../db/tenantContext');
const { hashPassword } = require('../auth/passwords');
const tokens = require('../auth/tokens');
const { forgetUser } = require('./resolve');
const B = require('../domain/branches');
const ROLE = require('../domain/roles');
const PERMS = require('../lib/permissions');
const passwords = require('../auth/passwordPolicy');
const { err } = require('../lib/errors');

/**
 * Staff users of one tenant (the reference platform's Users and Access Control). Credentials
 * live in the control plane (platform.users), so this module works there,
 * always filtered to the tenant; the branch is checked against the tenant's
 * own branches.
 *
 * A user has a role (built-in or the tenant's), may have permissions of
 * their own on top, an optional user type (administrator, teller, credit
 * officer), a branch and branch access, and transaction limits. As in
 * The reference platform: only an administrator creates or edits an administrator; the
 * administrator type goes with the administrator role; a teller or credit
 * officer belongs to a branch; administrator and teller do not combine.
 * Someone who is not an administrator may give a user only a role and
 * permissions they hold themselves.
 *
 * A new user, and a user whose password is reset, gets a temporary
 * password, shown once, that signs in only far enough to choose a new one.
 * Nobody may change their own role, permissions or status here, and the
 * tenant's last active administrator can be neither demoted nor suspended.
 * Suspending a user, changing their role, and resetting their password or
 * second factor end their sessions. Every change is in the platform audit log.
 */

const ROLES = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'];
const STATUSES = ['ACTIVE', 'SUSPENDED'];
const TYPES = ['ADMINISTRATOR', 'TELLER', 'CREDIT_OFFICER'];
const LIMITS = { approvalLimit: 'approval_limit', disbursementLimit: 'disbursement_limit', feeLimit: 'fee_limit',
  depositLimit: 'deposit_limit', withdrawalLimit: 'withdrawal_limit', repaymentLimit: 'repayment_limit' };

const COLUMNS = `id, email, full_name, title, language, role, role_code, permissions, user_type, status, branch_id, all_branches, branch_access,
                 other_officers_clients, phone, mfa_enabled, mfa_enrolled_at, must_change_password,
                 approval_limit, disbursement_limit, fee_limit, deposit_limit, withdrawal_limit, repayment_limit,
                 failed_logins, locked_at, locked_until, password_changed_at, custom_fields, last_login_at, created_at, created_by, updated_at, activity_types`;

/** A user row for the API, with the reference platform's state (ACTIVE, INACTIVE, LOCKED). */
function shape(u) {
  const locked = Boolean(u.locked_at) && (!u.locked_until || new Date(u.locked_until) > new Date());
  return {
    ...u,
    state: locked ? 'LOCKED' : u.status === 'SUSPENDED' ? 'INACTIVE' : 'ACTIVE',
    locked,
    accessRights: { allBranches: u.all_branches, branches: u.branch_access, otherCreditOfficersClients: u.other_officers_clients },
    activityTypes: u.activity_types ?? null,
  };
}

/** A temporary password: 16 characters people can read aloud without confusion, with a digit and a capital. */
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    const bytes = crypto.randomBytes(16);
    let s = '';
    for (const b of bytes) s += alphabet[b % alphabet.length];
    if (/[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
  }
}

async function audit(tenant, actor, action, detail) {
  await pool.query('INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
    [tenant.id, actor, action, JSON.stringify(detail)]);
}

async function list(tenant, { status = null, role = null } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM platform.users
     WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR role = $3 OR role_code = $3)
     ORDER BY lower(email)`, [tenant.id, status, role]);
  return rows.map(shape);
}

async function get(tenant, id) {
  const { rows: [u] } = await pool.query(
    `SELECT ${COLUMNS} FROM platform.users WHERE tenant_id = $1 AND (id::text = $2 OR lower(email) = lower($2))`, [tenant.id, String(id)]);
  if (!u) throw err('USER_NOT_FOUND', 404);
  return shape(u);
}

async function branchOf(tenant, branchId) {
  if (branchId === undefined) return undefined;
  if (branchId === null || branchId === '') return null;
  const b = await withTenantRead(tenant.schema_name, (c) => B.resolve(c, branchId));
  if (b.status !== 'ACTIVE') throw err('BRANCH_IS_DEACTIVATED', 409);
  return b.id;
}

async function branchesOf(tenant, list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw err('BRANCH_ACCESS_MUST_BE_A_LIST_OF_BRANCHES');
  const out = [];
  for (const b of list) out.push(await branchOf(tenant, b));
  return [...new Set(out.filter(Boolean))];
}

function limit(v, name) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!(n >= 0)) throw err(`INVALID_${name}`);
  return Math.round(n * 100) / 100;
}

/**
 * A role given as a built-in role or one of the tenant's roles: the built-in
 * role it is based on, the tenant role's code, the role's user type and its
 * permissions.
 */
async function roleOf(tenant, value) {
  const v = String(value || '');
  const code = ROLES.includes(v.toUpperCase()) ? v.toUpperCase() : v;
  const r = await withTenantRead(tenant.schema_name, async (c) => {
    const a = await ROLE.assignable(c, code);
    const full = await ROLE.find(c, code);
    return { ...a, permissions: full.permissions };
  }).catch((e) => {
    if (e.status === 404) throw err(`ROLE_MUST_BE_ONE_OF: ${ROLES.join(', ')} or one of the tenant's roles`);
    throw e;
  });
  return { role: r.role, roleCode: r.roleCode, userType: r.userType, permissions: r.permissions };
}

/** Permissions given to a user beyond their role's. */
function permissionsOf(list) {
  if (!Array.isArray(list)) throw err('PERMISSIONS_MUST_BE_A_LIST');
  const codes = [...new Set(list.map(String))];
  const bad = PERMS.unknown(codes);
  if (bad.length) throw err(`UNKNOWN_PERMISSIONS: ${bad.join(', ')}`);
  return codes;
}

/** Someone who is not an administrator may hand on only what they hold. */
function assertActorMay(actor, { role, rolePermissions = [], permissions = [], target = null }) {
  if (!actor || actor.role === 'TENANT_ADMIN') return;
  if (role === 'TENANT_ADMIN' || (target && target.role === 'TENANT_ADMIN')) {
    throw err('ONLY_AN_ADMINISTRATOR_CREATES_OR_EDITS_AN_ADMINISTRATOR', 403);
  }
  const missing = [...rolePermissions, ...permissions].filter((p) => !PERMS.can(actor, p));
  if (missing.length) throw err(`YOU_CANNOT_GIVE_PERMISSIONS_YOU_DO_NOT_HOLD: ${[...new Set(missing)].join(', ')}`, 403);
}

/** The user type as it will stand, checked against the role and branch (the reference platform's rules). */
function typeOf({ role, roleType, given, before }) {
  let t = given !== undefined ? (given ? String(given).toUpperCase() : null) : before?.user_type ?? null;
  if (t && !TYPES.includes(t)) throw err(`USER_TYPE_MUST_BE_ONE_OF: ${TYPES.join(', ')} (or null)`);
  if (role === 'TENANT_ADMIN') {
    if (t === 'TELLER') throw err('A_USER_CANNOT_BE_BOTH_ADMINISTRATOR_AND_TELLER', 409);
    t = 'ADMINISTRATOR';
  } else if (t === 'ADMINISTRATOR') {
    throw err('THE_ADMINISTRATOR_TYPE_GOES_WITH_THE_ADMINISTRATOR_ROLE', 409);
  }
  if (t === 'ADMINISTRATOR' && roleType === 'TELLER') throw err('A_USER_CANNOT_BE_BOTH_ADMINISTRATOR_AND_TELLER', 409);
  return t;
}

async function create(tenant, body, { actor, actorUser = null }) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('VALID_EMAIL_REQUIRED');
  const { rows: [taken] } = await pool.query('SELECT 1 FROM platform.users WHERE tenant_id = $1 AND lower(email) = $2', [tenant.id, email]);
  if (taken) throw err('EMAIL_ALREADY_IN_USE', 409);
  const r = await roleOf(tenant, body.role || 'TELLER');
  const permissions = permissionsOf(body.permissions || []);
  assertActorMay(actorUser, { role: r.role, rolePermissions: r.permissions, permissions });
  const branchId = await branchOf(tenant, body.branchId);
  const userType = typeOf({ role: r.role, roleType: r.userType, given: body.userType });
  const effective = userType || r.userType;
  if (['TELLER', 'CREDIT_OFFICER'].includes(effective) && !branchId) throw err(`A_${effective}_BELONGS_TO_A_BRANCH: give a branchId`);
  const access = body.accessRights || {};
  const allBranches = access.allBranches !== undefined ? Boolean(access.allBranches) : body.allBranches !== undefined ? Boolean(body.allBranches) : true;
  const branchAccess = (await branchesOf(tenant, access.branches ?? body.branchAccess)) || [];
  const otherOfficers = access.otherCreditOfficersClients ?? body.otherCreditOfficersClients;
  // A password the administrator chose is still temporary: the user replaces it.
  const given = body.password !== undefined && body.password !== null && body.password !== '';
  if (given) await passwords.check(tenant, String(body.password), { email });
  const password = given ? String(body.password) : temporaryPassword();
  const lim = Object.fromEntries(Object.entries(LIMITS).map(([k, col]) => [col, limit(body[k], k.replace(/[A-Z]/g, (x) => `_${x}`).toUpperCase()) ?? null]));
  try {
    const { rows: [u] } = await pool.query(
      `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, title, language, role, role_code, permissions, user_type, status,
          branch_id, all_branches, branch_access, other_officers_clients, phone,
          approval_limit, disbursement_limit, fee_limit, deposit_limit, withdrawal_limit, repayment_limit, must_change_password, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true,$22) RETURNING ${COLUMNS}`,
      [tenant.id, email, await hashPassword(password, { minLength: 8 }), body.fullName || null, body.title || null, body.language || 'en',
        r.role, r.roleCode, permissions, userType, branchId ?? null, allBranches, branchAccess,
        otherOfficers !== undefined ? Boolean(otherOfficers) : effective !== 'CREDIT_OFFICER', body.phone || null,
        lim.approval_limit, lim.disbursement_limit, lim.fee_limit, lim.deposit_limit, lim.withdrawal_limit, lim.repayment_limit, actor]);
    await audit(tenant, actor, 'USER_CREATED', { userId: u.id, email, role: r.role, roleCode: r.roleCode, permissions, userType, branchId });
    return { ...shape(u), ...(given ? {} : { temporaryPassword: password }) };
  } catch (e) {
    if (e.code === '23505') throw err('EMAIL_ALREADY_IN_USE', 409);
    throw e;
  }
}

async function activeAdmins(c, tenant) {
  const { rows: [r] } = await c.query(
    "SELECT count(*)::int AS n FROM platform.users WHERE tenant_id = $1 AND role = 'TENANT_ADMIN' AND status = 'ACTIVE'", [tenant.id]);
  return r.n;
}

/** How many members a credit officer has (the reference platform asks before deactivating one who has any). */
async function officerMembers(tenant, email) {
  return withTenantRead(tenant.schema_name, async (c) => {
    const { rows: [n] } = await c.query("SELECT count(*)::int AS n FROM members WHERE lower(credit_officer) = lower($1) AND status <> 'EXITED'", [email]);
    return n.n;
  }).catch(() => 0);
}

async function update(tenant, id, body, { actor, actorId, actorUser = null }) {
  const client = await pool.connect();
  let revoke = false;
  try {
    await client.query('BEGIN');
    // Serialise changes to one tenant's users, so two administrators
    // demoting each other at once cannot leave the tenant with none.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`users:${tenant.id}`]);
    const { rows: [before] } = await client.query(
      `SELECT ${COLUMNS} FROM platform.users WHERE tenant_id = $1 AND (id::text = $2 OR lower(email) = lower($2)) FOR UPDATE`,
      [tenant.id, String(id)]);
    if (!before) throw err('USER_NOT_FOUND', 404);
    assertActorMay(actorUser, { target: before });
    const sets = {};
    let r = null;
    if (body.role !== undefined) {
      r = await roleOf(tenant, body.role);
      if (r.role !== before.role) sets.role = r.role;
      if (r.roleCode !== (before.role_code || null)) sets.role_code = r.roleCode;
      if (sets.role || sets.role_code !== undefined) assertActorMay(actorUser, { role: r.role, rolePermissions: r.permissions });
    }
    if (body.permissions !== undefined) {
      const permissions = permissionsOf(body.permissions);
      if (JSON.stringify([...permissions].sort()) !== JSON.stringify([...(before.permissions || [])].sort())) {
        sets.permissions = permissions;
        assertActorMay(actorUser, { permissions: permissions.filter((p) => !(before.permissions || []).includes(p)) });
      }
    }
    if (body.status !== undefined) {
      let status = String(body.status).toUpperCase();
      if (status === 'INACTIVE' || status === 'DEACTIVATED') status = 'SUSPENDED';
      if (!STATUSES.includes(status)) throw err('STATUS_MUST_BE_ACTIVE_OR_SUSPENDED');
      if (status !== before.status) sets.status = status;
    }
    const self = before.id === actorId;
    if (self && (sets.role || sets.role_code !== undefined || sets.permissions || sets.status)) throw err('YOU_CANNOT_CHANGE_YOUR_OWN_ROLE_OR_STATUS', 409);
    const role = sets.role || before.role;
    const losesAdmin = before.role === 'TENANT_ADMIN' && before.status === 'ACTIVE'
      && ((sets.role && sets.role !== 'TENANT_ADMIN') || sets.status === 'SUSPENDED');
    if (losesAdmin && (await activeAdmins(client, tenant)) <= 1) throw err('LAST_ACTIVE_TENANT_ADMIN', 409);
    const roleType = r ? r.userType : before.role_code ? (await roleOf(tenant, before.role_code)).userType : PERMS.USER_TYPES[before.role] || null;
    const userType = typeOf({ role, roleType, given: body.userType, before: sets.role && before.user_type === 'ADMINISTRATOR' ? { user_type: null } : before });
    if (userType !== before.user_type) sets.user_type = userType;
    if (body.fullName !== undefined) sets.full_name = body.fullName || null;
    if (body.title !== undefined) sets.title = body.title || null;
    if (body.language !== undefined) sets.language = body.language || 'en';
    if (body.phone !== undefined) sets.phone = body.phone || null;
    if (body.branchId !== undefined) sets.branch_id = await branchOf(tenant, body.branchId);
    const access = body.accessRights || {};
    const all = access.allBranches ?? body.allBranches;
    if (all !== undefined) sets.all_branches = Boolean(all);
    const list = await branchesOf(tenant, access.branches ?? body.branchAccess);
    if (list !== undefined) sets.branch_access = list;
    const others = access.otherCreditOfficersClients ?? body.otherCreditOfficersClients;
    if (others !== undefined) sets.other_officers_clients = Boolean(others);
    for (const [k, col] of Object.entries(LIMITS)) {
      if (body[k] !== undefined) sets[col] = limit(body[k], k.replace(/[A-Z]/g, (x) => `_${x}`).toUpperCase());
    }
    // Checked when the type, role or branch changes, so an older branchless teller can still be edited otherwise.
    const effective = userType || roleType;
    const branch = sets.branch_id !== undefined ? sets.branch_id : before.branch_id;
    const moved = sets.user_type !== undefined || sets.role || sets.role_code !== undefined || sets.branch_id !== undefined;
    if (moved && ['TELLER', 'CREDIT_OFFICER'].includes(effective) && !branch) throw err(`A_${effective}_BELONGS_TO_A_BRANCH: give a branchId`);
    // Deactivating a credit officer who still has members needs saying so (the reference platform's confirmation).
    if (sets.status === 'SUSPENDED' && (before.user_type === 'CREDIT_OFFICER') && !body.confirmCreditOfficerMembers) {
      const n = await officerMembers(tenant, before.email);
      if (n) throw err(`CREDIT_OFFICER_HAS_MEMBERS: ${n} member(s) are assigned to ${before.email}; reassign them, or send confirmCreditOfficerMembers: true`, 409);
    }
    const keys = Object.keys(sets);
    if (!keys.length) { await client.query('ROLLBACK'); return shape(before); }
    const { rows: [after] } = await client.query(
      `UPDATE platform.users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`, [before.id, ...keys.map((k) => sets[k])]);
    await client.query('INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
      [tenant.id, actor, 'USER_UPDATED', JSON.stringify({ userId: before.id, changes: sets, before: Object.fromEntries(keys.map((k) => [k, before[k]])) })]);
    await client.query('COMMIT');
    revoke = Boolean(sets.role || sets.status === 'SUSPENDED');
    forgetUser(before.id);
    // A suspended user has no business holding a session.
    if (revoke) await tokens.revokeAll(before.id);
    return shape(after);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function resetPassword(tenant, id, { actor, actorId }) {
  const u = await get(tenant, id);
  if (u.id === actorId) throw err('CHANGE_YOUR_OWN_PASSWORD_WITH_AUTH_PASSWORD', 409);
  const password = temporaryPassword();
  // A reset also lifts a lock (the reference platform: an administrator's reset lets the user in again).
  await pool.query(
    `UPDATE platform.users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_at = NULL, locked_until = NULL,
       updated_at = now() WHERE id = $1`,
    [u.id, await hashPassword(password, { minLength: 8 })]);
  const revoked = await tokens.revokeAll(u.id);
  forgetUser(u.id);
  await audit(tenant, actor, 'USER_PASSWORD_RESET', { userId: u.id });
  return { id: u.id, email: u.email, temporaryPassword: password, sessionsRevoked: revoked };
}

/** Unlock a user locked out by failed sign-ins (the reference platform: an administrator unlocks). */
async function unlock(tenant, id, { actor, actorUser = null }) {
  const u = await get(tenant, id);
  assertActorMay(actorUser, { target: u });
  await pool.query('UPDATE platform.users SET failed_logins = 0, locked_at = NULL, locked_until = NULL, updated_at = now() WHERE id = $1', [u.id]);
  forgetUser(u.id);
  await audit(tenant, actor, 'USER_UNLOCKED', { userId: u.id, wasLocked: u.locked });
  return get(tenant, u.id);
}

async function resetMfa(tenant, id, { actor }) {
  const u = await get(tenant, id);
  await pool.query(
    `UPDATE platform.users SET mfa_enabled = false, mfa_secret = NULL, mfa_enrolled_at = NULL, mfa_last_counter = NULL, updated_at = now()
     WHERE id = $1`, [u.id]);
  await pool.query('DELETE FROM platform.mfa_recovery_codes WHERE user_id = $1', [u.id]);
  const revoked = await tokens.revokeAll(u.id);
  await audit(tenant, actor, 'USER_MFA_RESET', { userId: u.id });
  return { id: u.id, email: u.email, mfaEnabled: false, sessionsRevoked: revoked };
}

/** Change one's own profile: name, title, phone, language (the reference platform's Edit Your Profile). */
async function updateProfile(tenant, userId, body = {}) {
  const sets = {};
  if (body.fullName !== undefined) sets.full_name = body.fullName || null;
  if (body.title !== undefined) sets.title = body.title || null;
  if (body.phone !== undefined) sets.phone = body.phone || null;
  if (body.language !== undefined) sets.language = body.language || 'en';
  // The activity types the dashboard's Latest Activity shows; null or an empty list shows every type.
  if (body.activityTypes !== undefined) {
    const t = body.activityTypes;
    if (t !== null && !(Array.isArray(t) && t.every((x) => typeof x === 'string' && /^[A-Z0-9_]{1,80}$/.test(x)) && t.length <= 200)) {
      throw err('ACTIVITY_TYPES_IS_A_LIST_OF_ACTIVITY_TYPES', 400);
    }
    sets.activity_types = t && t.length ? [...new Set(t)] : null;
  }
  for (const k of ['email', 'role', 'permissions', 'status', 'branchId', 'userType']) {
    if (body[k] !== undefined) throw err(`${k.toUpperCase()}_IS_NOT_PART_OF_YOUR_PROFILE`, 400);
  }
  const keys = Object.keys(sets);
  if (keys.length) {
    await pool.query(`UPDATE platform.users SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [userId, tenant.id, ...keys.map((k) => sets[k])]);
  }
  return get(tenant, userId);
}

/** Sign-in attempts for one user (or everyone), newest first. */
async function logins(tenant, { email = null, limit: n = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT email, ip::text AS ip, succeeded, reason, user_agent, created_at FROM platform.login_attempts
     WHERE tenant_id = $1 AND ($2::text IS NULL OR lower(email) = lower($2)) ORDER BY created_at DESC LIMIT $3`,
    [tenant.id, email, Math.min(1000, Number(n) || 100)]);
  return rows;
}

/** The platform audit trail for one tenant's users. */
async function auditTrail(tenant, { limit: n = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, actor, action, detail, created_at FROM platform.audit_log
     WHERE tenant_id = $1 AND action LIKE 'USER\\_%' ORDER BY created_at DESC LIMIT $2`, [tenant.id, Math.min(500, Number(n) || 100)]);
  return rows;
}

/**
 * A credit officer given on a member or loan: an active staff user of the
 * tenant of the credit officer type (or an administrator, who holds the
 * credit officer's rights in the reference platform). Returns the email as stored, or null.
 */
async function creditOfficer(c, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const { rows: [u] } = await c.query(
    `SELECT u.email, u.status, u.role, COALESCE(u.user_type, r.user_type) AS user_type
     FROM platform.users u LEFT JOIN roles r ON r.code = u.role_code
     WHERE u.tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema()) AND lower(u.email) = lower($1)`, [String(value)]);
  if (!u || u.status !== 'ACTIVE') throw err(`CREDIT_OFFICER_NOT_AN_ACTIVE_USER: ${value}`, 400);
  if (u.role !== 'TENANT_ADMIN' && u.user_type !== 'CREDIT_OFFICER') throw err(`NOT_A_CREDIT_OFFICER: ${value} is not of the credit officer user type`, 400);
  return u.email.toLowerCase();
}

module.exports = {
  ROLES, TYPES, list, get, create, update, resetPassword, resetMfa, unlock, updateProfile, logins, auditTrail, temporaryPassword, creditOfficer,
};
