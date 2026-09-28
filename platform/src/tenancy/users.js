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

/**
 * Staff users of one tenant (the reference platform's Users and Access Control, for the
 * roles this platform has): a tenant administrator lists them, creates
 * them, changes their role, branch, limits and status, and resets their
 * password or second factor. Credentials live in the control plane
 * (platform.users), so this module works there, always filtered to the
 * tenant; the branch is checked against the tenant's own branches.
 *
 * A new user, and a user whose password is reset, gets a temporary
 * password, shown once, that signs in only far enough to choose a new one.
 * Nobody may change their own role or status here, and the tenant's last
 * active administrator can be neither demoted nor suspended, so a tenant
 * cannot lock itself out. Suspending a user, changing their role, and
 * resetting their password or second factor end their sessions; a
 * suspended user's access token stops working within seconds (the status
 * check in ./resolve). Every change is in the platform audit log.
 */

const ROLES = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'];
const STATUSES = ['ACTIVE', 'SUSPENDED'];
const err = (m, status = 400) => Object.assign(new Error(m), { status });

const COLUMNS = `id, email, full_name, role, role_code, permissions, status, branch_id, phone, mfa_enabled, mfa_enrolled_at, must_change_password,
                 approval_limit, disbursement_limit, custom_fields, last_login_at, created_at, created_by, updated_at`;

/** A temporary password: 16 characters people can read aloud without confusion. */
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

async function audit(tenant, actor, action, detail) {
  await pool.query('INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
    [tenant.id, actor, action, JSON.stringify(detail)]);
}

async function list(tenant, { status = null, role = null } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM platform.users
     WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR role = $3)
     ORDER BY lower(email)`, [tenant.id, status, role]);
  return rows;
}

async function get(tenant, id) {
  const { rows: [u] } = await pool.query(
    `SELECT ${COLUMNS} FROM platform.users WHERE tenant_id = $1 AND (id::text = $2 OR lower(email) = lower($2))`, [tenant.id, String(id)]);
  if (!u) throw err('USER_NOT_FOUND', 404);
  return u;
}

async function branchOf(tenant, branchId) {
  if (branchId === undefined) return undefined;
  if (branchId === null || branchId === '') return null;
  const b = await withTenantRead(tenant.schema_name, (c) => B.resolve(c, branchId));
  if (b.status !== 'ACTIVE') throw err('BRANCH_IS_DEACTIVATED', 409);
  return b.id;
}

function limit(v, name) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!(n >= 0)) throw err(`INVALID_${name}`);
  return Math.round(n * 100) / 100;
}

async function create(tenant, body, { actor }) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('VALID_EMAIL_REQUIRED');
  const { role, roleCode } = await roleOf(tenant, body.role || 'TELLER');
  const permissions = permissionsOf(body.permissions || []);
  const branchId = await branchOf(tenant, body.branchId);
  // A password the administrator chose is still temporary: the user replaces it.
  const given = body.password !== undefined && body.password !== null && body.password !== '';
  if (given && String(body.password).length < 12) throw err('PASSWORD_TOO_SHORT: at least 12 characters');
  const password = given ? String(body.password) : temporaryPassword();
  try {
    const { rows: [u] } = await pool.query(
      `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role, role_code, permissions, status, branch_id, phone,
          approval_limit, disbursement_limit, must_change_password, created_by)
       VALUES ($1,$2,$3,$4,$5,$11,$12,'ACTIVE',$6,$7,$8,$9,true,$10) RETURNING ${COLUMNS}`,
      [tenant.id, email, await hashPassword(password, { minLength: 12 }), body.fullName || null, role, branchId ?? null,
        body.phone || null, limit(body.approvalLimit, 'APPROVAL_LIMIT') ?? null, limit(body.disbursementLimit, 'DISBURSEMENT_LIMIT') ?? null, actor,
        roleCode, permissions]);
    await audit(tenant, actor, 'USER_CREATED', { userId: u.id, email, role, roleCode, permissions, branchId });
    return { ...u, ...(given ? {} : { temporaryPassword: password }) };
  } catch (e) {
    if (e.code === '23505') throw err('EMAIL_ALREADY_IN_USE', 409);
    throw e;
  }
}

/**
 * A role given as a built-in role or one of the tenant's roles: the built-in
 * role it is based on (what the token carries) and the tenant role's code.
 */
async function roleOf(tenant, value) {
  const v = String(value || '');
  if (ROLES.includes(v.toUpperCase())) return { role: v.toUpperCase(), roleCode: null };
  const r = await withTenantRead(tenant.schema_name, (c) => ROLE.assignable(c, v)).catch((e) => {
    if (e.status === 404) throw err(`ROLE_MUST_BE_ONE_OF: ${ROLES.join(', ')} or one of the tenant's roles`);
    throw e;
  });
  return { role: r.role, roleCode: r.roleCode };
}

/** Permissions given to a user beyond their role's. */
function permissionsOf(list) {
  if (!Array.isArray(list)) throw err('PERMISSIONS_MUST_BE_A_LIST');
  const codes = [...new Set(list.map(String))];
  const bad = PERMS.unknown(codes);
  if (bad.length) throw err(`UNKNOWN_PERMISSIONS: ${bad.join(', ')}`);
  return codes;
}

async function activeAdmins(c, tenant) {
  const { rows: [r] } = await c.query(
    "SELECT count(*)::int AS n FROM platform.users WHERE tenant_id = $1 AND role = 'TENANT_ADMIN' AND status = 'ACTIVE'", [tenant.id]);
  return r.n;
}

async function update(tenant, id, body, { actor, actorId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise changes to one tenant's users, so two administrators
    // demoting each other at once cannot leave the tenant with none.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`users:${tenant.id}`]);
    const { rows: [before] } = await client.query(
      `SELECT ${COLUMNS} FROM platform.users WHERE tenant_id = $1 AND (id::text = $2 OR lower(email) = lower($2)) FOR UPDATE`,
      [tenant.id, String(id)]);
    if (!before) throw err('USER_NOT_FOUND', 404);
    const sets = {};
    if (body.role !== undefined) {
      const { role, roleCode } = await roleOf(tenant, body.role);
      if (role !== before.role) sets.role = role;
      if (roleCode !== (before.role_code || null)) sets.role_code = roleCode;
    }
    if (body.permissions !== undefined) {
      const permissions = permissionsOf(body.permissions);
      if (JSON.stringify([...permissions].sort()) !== JSON.stringify([...(before.permissions || [])].sort())) sets.permissions = permissions;
    }
    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase();
      if (!STATUSES.includes(status)) throw err('STATUS_MUST_BE_ACTIVE_OR_SUSPENDED');
      if (status !== before.status) sets.status = status;
    }
    const self = before.id === actorId;
    if (self && (sets.role || sets.role_code !== undefined || sets.permissions || sets.status)) throw err('YOU_CANNOT_CHANGE_YOUR_OWN_ROLE_OR_STATUS', 409);
    const losesAdmin = before.role === 'TENANT_ADMIN' && before.status === 'ACTIVE'
      && ((sets.role && sets.role !== 'TENANT_ADMIN') || sets.status === 'SUSPENDED');
    if (losesAdmin && (await activeAdmins(client, tenant)) <= 1) throw err('LAST_ACTIVE_TENANT_ADMIN', 409);
    if (body.fullName !== undefined) sets.full_name = body.fullName || null;
    if (body.phone !== undefined) sets.phone = body.phone || null;
    if (body.branchId !== undefined) sets.branch_id = await branchOf(tenant, body.branchId);
    if (body.approvalLimit !== undefined) sets.approval_limit = limit(body.approvalLimit, 'APPROVAL_LIMIT');
    if (body.disbursementLimit !== undefined) sets.disbursement_limit = limit(body.disbursementLimit, 'DISBURSEMENT_LIMIT');
    const keys = Object.keys(sets);
    if (!keys.length) { await client.query('ROLLBACK'); return before; }
    const { rows: [after] } = await client.query(
      `UPDATE platform.users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`, [before.id, ...keys.map((k) => sets[k])]);
    await client.query('INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
      [tenant.id, actor, 'USER_UPDATED', JSON.stringify({ userId: before.id, changes: sets, before: Object.fromEntries(keys.map((k) => [k, before[k]])) })]);
    await client.query('COMMIT');
    forgetUser(before.id);
    // A token carries its role; a suspended user has no business holding one.
    if (sets.role || sets.status === 'SUSPENDED') await tokens.revokeAll(before.id);
    return after;
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
  await pool.query('UPDATE platform.users SET password_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1',
    [u.id, await hashPassword(password, { minLength: 12 })]);
  const revoked = await tokens.revokeAll(u.id);
  forgetUser(u.id);
  await audit(tenant, actor, 'USER_PASSWORD_RESET', { userId: u.id });
  return { id: u.id, email: u.email, temporaryPassword: password, sessionsRevoked: revoked };
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

/** The platform audit trail for one tenant's users. */
async function auditTrail(tenant, { limit: n = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, actor, action, detail, created_at FROM platform.audit_log
     WHERE tenant_id = $1 AND action LIKE 'USER\\_%' ORDER BY created_at DESC LIMIT $2`, [tenant.id, Math.min(500, Number(n) || 100)]);
  return rows;
}

module.exports = { ROLES, list, get, create, update, resetPassword, resetMfa, auditTrail, temporaryPassword };
