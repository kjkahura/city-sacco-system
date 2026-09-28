'use strict';

const PERMS = require('../lib/permissions');

/**
 * Roles (the reference platform's Administration > Access > Roles). A role is a named set of
 * permissions. The five built-in roles (TENANT_ADMIN, MANAGER, ACCOUNTANT,
 * TELLER, AUDITOR) start with the platform's defaults (lib/permissions) and
 * can have their permissions edited, except TENANT_ADMIN, which holds every
 * permission. A tenant adds roles of its own; each is based on a built-in
 * role, which is what the routes not yet moved to permissions check, and may
 * carry a user type (administrator, teller, credit officer) as in the reference platform.
 *
 * A role in use cannot be deleted, nor can a built-in role (the reference platform).
 */

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

const BUILTIN_NAMES = { TENANT_ADMIN: 'Administrator', MANAGER: 'Manager', ACCOUNTANT: 'Accountant', TELLER: 'Teller', AUDITOR: 'Auditor' };
const TYPE_BASE = { ADMINISTRATOR: 'TENANT_ADMIN', TELLER: 'TELLER' };
const USER_TYPES = ['ADMINISTRATOR', 'TELLER', 'CREDIT_OFFICER'];

async function tenantId(c) {
  const { rows: [t] } = await c.query('SELECT id FROM platform.tenants WHERE schema_name = current_schema()');
  return t.id;
}

async function usage(c) {
  const { rows } = await c.query(
    `SELECT COALESCE(role_code, role) AS code, count(*)::int AS n FROM platform.users
     WHERE tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema()) GROUP BY 1`);
  return new Map(rows.map((r) => [r.code, r.n]));
}

function shape(r, users = 0) {
  return {
    code: r.code, name: r.name, baseRole: r.base_role, userType: r.user_type, apiAccess: r.api_access,
    permissions: [...r.permissions].sort(), notes: r.notes, builtin: r.builtin, users,
    edited: Boolean(r.edited), createdAt: r.created_at || null, updatedAt: r.updated_at || null,
  };
}

function builtinRow(code, row = null) {
  return {
    code, name: row?.name || BUILTIN_NAMES[code], base_role: code, user_type: PERMS.USER_TYPES[code] || null,
    api_access: row ? row.api_access : true,
    permissions: code === 'TENANT_ADMIN' ? PERMS.CATALOG.map((p) => p.code) : (row ? row.permissions : PERMS.DEFAULTS[code]),
    notes: row?.notes || null, builtin: true, edited: Boolean(row), created_at: row?.created_at, updated_at: row?.updated_at,
  };
}

async function list(c) {
  const { rows } = await c.query('SELECT * FROM roles ORDER BY builtin DESC, lower(name)');
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const used = await usage(c);
  const out = PERMS.BASE_ROLES.map((code) => shape(builtinRow(code, byCode.get(code)), used.get(code) || 0));
  for (const r of rows) if (!PERMS.BASE_ROLES.includes(r.code)) out.push(shape(r, used.get(r.code) || 0));
  return out;
}

async function find(c, code) {
  const k = String(code || '');
  if (PERMS.BASE_ROLES.includes(k.toUpperCase())) {
    const { rows: [r] } = await c.query('SELECT * FROM roles WHERE code = $1', [k.toUpperCase()]);
    return builtinRow(k.toUpperCase(), r);
  }
  const { rows: [r] } = await c.query('SELECT * FROM roles WHERE code = $1', [k]);
  if (!r) throw err(`ROLE_NOT_FOUND: ${code}`, 404);
  return r;
}

async function get(c, code) {
  const r = await find(c, code);
  return shape(r, (await usage(c)).get(r.code) || 0);
}

function permissionsOf(list) {
  if (!Array.isArray(list)) throw err('PERMISSIONS_MUST_BE_A_LIST');
  const codes = [...new Set(list.map(String))];
  const bad = PERMS.unknown(codes);
  if (bad.length) throw err(`UNKNOWN_PERMISSIONS: ${bad.join(', ')}`);
  return codes;
}

async function create(c, body = {}, { createdBy } = {}) {
  const name = String(body.name || '').trim();
  if (!name) throw err('ROLE_NAME_REQUIRED');
  if (name.length > 255) throw err('ROLE_NAME_TOO_LONG: at most 255 characters');
  const code = body.code ? String(body.code) : name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) throw err('ROLE_CODE_INVALID: letters, digits, dashes and underscores');
  if (PERMS.BASE_ROLES.includes(code.toUpperCase())) throw err(`ROLE_CODE_TAKEN: ${code} is a built-in role`, 409);
  const userType = body.userType ? String(body.userType).toUpperCase() : null;
  if (userType && !USER_TYPES.includes(userType)) throw err(`USER_TYPE_MUST_BE_ONE_OF: ${USER_TYPES.join(', ')}`);
  const baseRole = String(body.baseRole || TYPE_BASE[userType] || '').toUpperCase();
  if (!PERMS.BASE_ROLES.includes(baseRole)) throw err(`BASE_ROLE_REQUIRED: one of ${PERMS.BASE_ROLES.join(', ')}`);
  if (userType === 'ADMINISTRATOR' && baseRole !== 'TENANT_ADMIN') throw err('AN_ADMINISTRATOR_ROLE_IS_BASED_ON_TENANT_ADMIN');
  if (userType === 'TELLER' && baseRole === 'TENANT_ADMIN') throw err('A_ROLE_CANNOT_BE_BOTH_ADMINISTRATOR_AND_TELLER');
  const permissions = permissionsOf(body.permissions ?? PERMS.DEFAULTS[baseRole]);
  const { rows: [r] } = await c.query(
    `INSERT INTO roles (code, name, base_role, user_type, api_access, permissions, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *`,
    [code, name, baseRole, userType, body.apiAccess !== false, permissions, body.notes || null, createdBy || null]);
  if (!r) throw err(`ROLE_EXISTS: a role with code ${code} or name ${name} exists`, 409);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'ROLE_CREATED','role',$2,$3)`,
    [createdBy || 'SYSTEM', code, JSON.stringify(r)]);
  return shape(r);
}

/**
 * Change a role. A built-in role takes new permissions, name and notes; a
 * tenant role any of its fields. Moving a role to another base role moves
 * its users, and ends their sessions (their tokens carry the base role).
 * Returns the role and the users whose access changed, for the caller to
 * forget (../tenancy/resolve) and, when the base role moved, sign out.
 */
async function update(c, code, body = {}, { createdBy } = {}) {
  const before = await find(c, code);
  if (before.builtin) {
    if (before.code === 'TENANT_ADMIN' && body.permissions !== undefined) throw err('THE_ADMINISTRATOR_ROLE_HOLDS_EVERY_PERMISSION', 409);
    if (body.baseRole !== undefined || body.userType !== undefined || body.code !== undefined) throw err('A_BUILT_IN_ROLE_KEEPS_ITS_TYPE', 409);
    const permissions = body.permissions !== undefined ? permissionsOf(body.permissions) : before.permissions;
    const name = body.name !== undefined ? String(body.name || '').trim() : before.name;
    if (!name) throw err('ROLE_NAME_REQUIRED');
    const { rows: [r] } = await c.query(
      `INSERT INTO roles (code, name, base_role, user_type, api_access, permissions, notes, builtin, created_by)
       VALUES ($1,$2,$1,$3,$4,$5,$6,true,$7)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, api_access = EXCLUDED.api_access,
         permissions = EXCLUDED.permissions, notes = EXCLUDED.notes RETURNING *`,
      [before.code, name, before.user_type, body.apiAccess !== undefined ? body.apiAccess !== false : before.api_access,
        permissions, body.notes !== undefined ? body.notes || null : before.notes, createdBy || null]);
    await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'ROLE_UPDATED','role',$2,$3,$4)`,
      [createdBy || 'SYSTEM', before.code, JSON.stringify(before), JSON.stringify(r)]);
    return { role: shape(builtinRow(before.code, r)), baseMoved: false };
  }
  const name = body.name !== undefined ? String(body.name || '').trim() : before.name;
  if (!name) throw err('ROLE_NAME_REQUIRED');
  const userType = body.userType !== undefined ? (body.userType ? String(body.userType).toUpperCase() : null) : before.user_type;
  if (userType && !USER_TYPES.includes(userType)) throw err(`USER_TYPE_MUST_BE_ONE_OF: ${USER_TYPES.join(', ')}`);
  const baseRole = body.baseRole !== undefined ? String(body.baseRole).toUpperCase() : before.base_role;
  if (!PERMS.BASE_ROLES.includes(baseRole)) throw err(`BASE_ROLE_MUST_BE_ONE_OF: ${PERMS.BASE_ROLES.join(', ')}`);
  if (userType === 'ADMINISTRATOR' && baseRole !== 'TENANT_ADMIN') throw err('AN_ADMINISTRATOR_ROLE_IS_BASED_ON_TENANT_ADMIN');
  if (userType === 'TELLER' && baseRole === 'TENANT_ADMIN') throw err('A_ROLE_CANNOT_BE_BOTH_ADMINISTRATOR_AND_TELLER');
  const permissions = body.permissions !== undefined ? permissionsOf(body.permissions) : before.permissions;
  const { rows: [clash] } = await c.query('SELECT 1 FROM roles WHERE lower(name) = lower($1) AND code <> $2', [name, before.code]);
  if (clash) throw err(`ROLE_NAME_TAKEN: ${name}`, 409);
  const { rows: [r] } = await c.query(
    `UPDATE roles SET name = $2, base_role = $3, user_type = $4, api_access = $5, permissions = $6, notes = $7
     WHERE code = $1 RETURNING *`,
    [before.code, name, baseRole, userType, body.apiAccess !== undefined ? body.apiAccess !== false : before.api_access,
      permissions, body.notes !== undefined ? body.notes || null : before.notes]);
  let moved = [];
  if (baseRole !== before.base_role) {
    const tid = await tenantId(c);
    if (baseRole !== 'TENANT_ADMIN' && before.base_role === 'TENANT_ADMIN') {
      const { rows: [n] } = await c.query(
        `SELECT count(*)::int AS n FROM platform.users WHERE tenant_id = $1 AND role = 'TENANT_ADMIN' AND status = 'ACTIVE'
           AND COALESCE(role_code, role) <> $2`, [tid, before.code]);
      if (n.n === 0) throw err('LAST_ACTIVE_TENANT_ADMIN', 409);
    }
    ({ rows: moved } = await c.query(
      'UPDATE platform.users SET role = $3, updated_at = now() WHERE tenant_id = $1 AND role_code = $2 RETURNING id',
      [tid, before.code, baseRole]));
  }
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'ROLE_UPDATED','role',$2,$3,$4)`,
    [createdBy || 'SYSTEM', before.code, JSON.stringify(before), JSON.stringify(r)]);
  return { role: shape(r), baseMoved: moved.map((u) => u.id) };
}

async function remove(c, code, { createdBy } = {}) {
  const r = await find(c, code);
  if (r.builtin) throw err('A_BUILT_IN_ROLE_CANNOT_BE_DELETED', 409);
  const used = (await usage(c)).get(r.code) || 0;
  if (used) throw err(`ROLE_IN_USE: ${used} user(s) hold it; give them another role first`, 409);
  await c.query('DELETE FROM roles WHERE code = $1', [r.code]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'ROLE_DELETED','role',$2,$3)`,
    [createdBy || 'SYSTEM', r.code, JSON.stringify(r)]);
  return { deleted: r.code };
}

/**
 * A role given to a user: { role (the built-in role it is based on),
 * roleCode (null for a built-in role), userType }.
 */
async function assignable(c, code) {
  const r = await find(c, String(code || ''));
  return { role: r.base_role, roleCode: r.builtin ? null : r.code, userType: r.user_type };
}

/** Role codes a view, menu item or report may be shared with. */
async function codes(c) {
  const { rows } = await c.query('SELECT code FROM roles WHERE NOT builtin');
  return [...PERMS.BASE_ROLES, ...rows.map((r) => r.code)];
}

function catalog() {
  return PERMS.GROUPS.map(([group, list]) => ({ group, permissions: list }));
}

module.exports = { list, get, find, create, update, remove, assignable, codes, catalog, USER_TYPES };
