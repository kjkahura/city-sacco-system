'use strict';

const { pool } = require('../db/pool');
const { withTenantRead } = require('../db/tenantContext');
const keys = require('../auth/apiKeys');
const AP = require('../lib/accessPreferences');
const PERMS = require('../lib/permissions');
const ROLE = require('../domain/roles');
const { err } = require('../lib/errors');

/**
 * API consumers (the reference platform's API Consumers): an abstraction like an OAuth
 * client whose purpose is to make API keys. A consumer's access is a role,
 * permissions of its own, or the administrator type, and its keys inherit
 * it. A key is shown once, in clear, when made; afterwards only its id and a
 * six-character prefix. A key may carry a time to live. A secret key (one
 * per consumer) authenticates rotating a key: the old key keeps working for
 * the tenant's grace period and the replacement comes back with a new
 * secret. A consumer whose keys have been used cannot be deleted (its
 * activity stays in the audit trail).
 */


function shape(c, list = []) {
  return {
    id: c.id, name: c.name, access: { administrator: c.administrator, role: c.role_code, permissions: c.permissions },
    status: c.status, notes: c.notes, hasSecretKey: Boolean(c.secret_hash), secretKeyCreatedAt: c.secret_created_at,
    keys: list.filter((k) => k.consumer_id === c.id).map((k) => ({
      id: k.id, prefix: k.prefix, expiresAt: k.expires_at, rotatedAt: k.rotated_at, validUntil: k.grace_until, lastUsedAt: k.last_used_at,
      createdAt: k.created_at, createdBy: k.created_by,
      state: k.rotated_at ? (k.grace_until && new Date(k.grace_until) > new Date() ? 'ROTATED_IN_GRACE' : 'ROTATED')
        : k.expires_at && new Date(k.expires_at) <= new Date() ? 'EXPIRED' : 'ACTIVE',
    })),
    createdBy: c.created_by, createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

async function list(tenant) {
  const { rows } = await pool.query('SELECT * FROM platform.api_consumers WHERE tenant_id = $1 ORDER BY lower(name)', [tenant.id]);
  const { rows: ks } = await pool.query('SELECT * FROM platform.api_keys WHERE tenant_id = $1 ORDER BY created_at', [tenant.id]);
  return rows.map((c) => shape(c, ks));
}

async function find(tenant, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw err('API_CONSUMER_NOT_FOUND', 404);
  const { rows: [c] } = await pool.query('SELECT * FROM platform.api_consumers WHERE tenant_id = $1 AND id = $2', [tenant.id, id]);
  if (!c) throw err('API_CONSUMER_NOT_FOUND', 404);
  return c;
}

async function get(tenant, id) {
  const c = await find(tenant, id);
  const { rows: ks } = await pool.query('SELECT * FROM platform.api_keys WHERE consumer_id = $1 ORDER BY created_at', [c.id]);
  return shape(c, ks);
}

/** The access a consumer is given, checked the way a user's is. */
async function accessOf(tenant, body = {}, before = null, actor = null) {
  const a = body.access || body;
  const administrator = a.administrator !== undefined ? Boolean(a.administrator) : before ? before.administrator : false;
  const role = a.role !== undefined ? (a.role || null) : before ? before.role_code : null;
  const permissions = a.permissions !== undefined ? a.permissions : before ? before.permissions : [];
  if (!Array.isArray(permissions)) throw err('PERMISSIONS_MUST_BE_A_LIST');
  const bad = PERMS.unknown(permissions);
  if (bad.length) throw err(`UNKNOWN_PERMISSIONS: ${bad.join(', ')}`);
  let rolePerms = [];
  if (role) {
    const r = await withTenantRead(tenant.schema_name, (c) => ROLE.get(c, role)).catch((e) => {
      if (e.status === 404) throw err(`ROLE_NOT_FOUND: ${role}`, 404);
      throw e;
    });
    if (!r.accessRights.api) throw err(`API_ACCESS_NOT_ALLOWED: role ${role} has no API access`, 409);
    rolePerms = r.permissions;
    if (r.baseRole === 'TENANT_ADMIN' && actor && actor.role !== 'TENANT_ADMIN') throw err('ONLY_AN_ADMINISTRATOR_GIVES_ADMINISTRATOR_ACCESS', 403);
  }
  if (actor && actor.role !== 'TENANT_ADMIN') {
    if (administrator) throw err('ONLY_AN_ADMINISTRATOR_GIVES_ADMINISTRATOR_ACCESS', 403);
    const missing = [...rolePerms, ...permissions].filter((p) => !PERMS.can(actor, p));
    if (missing.length) throw err(`YOU_CANNOT_GIVE_PERMISSIONS_YOU_DO_NOT_HOLD: ${[...new Set(missing)].join(', ')}`, 403);
  }
  if (!administrator && !role && !permissions.length) throw err('ACCESS_REQUIRED: a role, permissions, or the administrator type');
  return { administrator, role, permissions: [...new Set(permissions)] };
}

async function audit(tenant, actor, action, detail) {
  await pool.query('INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
    [tenant.id, actor, action, JSON.stringify(detail)]);
}

async function create(tenant, body = {}, { actor, actorUser }) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 255) throw err('NAME_IS_1_TO_255_CHARACTERS');
  const a = await accessOf(tenant, body, null, actorUser);
  try {
    const { rows: [c] } = await pool.query(
      `INSERT INTO platform.api_consumers (tenant_id, name, administrator, role_code, permissions, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [tenant.id, name, a.administrator, a.role, a.permissions, body.notes || null, actor]);
    await audit(tenant, actor, 'API_CONSUMER_CREATED', { consumerId: c.id, name, ...a });
    return shape(c);
  } catch (e) {
    if (e.code === '23505') throw err(`API_CONSUMER_EXISTS: ${name}`, 409);
    throw e;
  }
}

async function update(tenant, id, body = {}, { actor, actorUser }) {
  const before = await find(tenant, id);
  const a = await accessOf(tenant, body, before, actorUser);
  const name = body.name !== undefined ? String(body.name || '').trim() : before.name;
  if (!name || name.length > 255) throw err('NAME_IS_1_TO_255_CHARACTERS');
  const status = body.status !== undefined ? String(body.status).toUpperCase() : before.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw err('STATUS_IS_ACTIVE_OR_INACTIVE');
  const { rows: [c] } = await pool.query(
    `UPDATE platform.api_consumers SET name = $3, administrator = $4, role_code = $5, permissions = $6, status = $7,
       notes = $8, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenant.id, before.id, name, a.administrator, a.role, a.permissions, status, body.notes !== undefined ? body.notes || null : before.notes]);
  keys.forget();
  await audit(tenant, actor, 'API_CONSUMER_UPDATED', { consumerId: c.id, before: { name: before.name, status: before.status }, after: { name, status, ...a } });
  return get(tenant, c.id);
}

async function remove(tenant, id, { actor }) {
  const c = await find(tenant, id);
  const { rows: [used] } = await pool.query('SELECT 1 FROM platform.api_keys WHERE consumer_id = $1 AND last_used_at IS NOT NULL LIMIT 1', [c.id]);
  if (used) throw err('API_CONSUMER_HAS_BEEN_USED: its activity is kept for the audit trail; set it INACTIVE instead', 409);
  await pool.query('DELETE FROM platform.api_consumers WHERE id = $1', [c.id]);
  keys.forget();
  await audit(tenant, actor, 'API_CONSUMER_DELETED', { consumerId: c.id, name: c.name });
  return { deleted: c.id };
}

function ttlOf(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 60) throw err('EXPIRATION_TIME_IS_WHOLE_SECONDS_OF_AT_LEAST_60');
  return n;
}

async function insertKey(client, c, { ttl, actor }) {
  const key = keys.mint();
  const { rows: [k] } = await client.query(
    `INSERT INTO platform.api_keys (consumer_id, tenant_id, key_hash, prefix, expires_at, created_by)
     VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(secs => $5::int) END, $6) RETURNING *`,
    [c.id, c.tenant_id, keys.hash(key), key.slice(0, 6), ttl, actor]);
  return { key, k };
}

/** Make a key. It is in the answer once, and never again. */
async function createKey(tenant, id, body = {}, { actor, actorUser = null }) {
  const c = await find(tenant, id);
  // A key carries its consumer's access: making one needs the same right as giving that access.
  await accessOf(tenant, {}, c, actorUser);
  if (c.status !== 'ACTIVE') throw err('API_CONSUMER_INACTIVE', 409);
  const { key, k } = await insertKey(pool, c, { ttl: ttlOf(body.expirationTime ?? body.ttl), actor });
  await audit(tenant, actor, 'API_KEY_CREATED', { consumerId: c.id, keyId: k.id, prefix: k.prefix, expiresAt: k.expires_at });
  return { id: k.id, apiKey: key, prefix: k.prefix, expiresAt: k.expires_at };
}

async function deleteKey(tenant, id, keyId, { actor }) {
  const c = await find(tenant, id);
  const { rowCount } = await pool.query('DELETE FROM platform.api_keys WHERE consumer_id = $1 AND id::text = $2', [c.id, String(keyId)]);
  if (!rowCount) throw err('API_KEY_NOT_FOUND', 404);
  keys.forget();
  await audit(tenant, actor, 'API_KEY_DELETED', { consumerId: c.id, keyId });
  return { deleted: keyId };
}

/** A secret key, for rotating keys. One per consumer; a new one replaces the old at once. */
async function createSecret(tenant, id, { actor, actorUser = null }) {
  const c = await find(tenant, id);
  await accessOf(tenant, {}, c, actorUser);
  const secret = keys.mint();
  await pool.query(
    'UPDATE platform.api_consumers SET secret_hash = $2, secret_created_at = now(), prev_secret_hash = NULL, prev_secret_until = NULL WHERE id = $1',
    [c.id, keys.hash(secret)]);
  await audit(tenant, actor, 'API_SECRET_KEY_CREATED', { consumerId: c.id });
  return { secretKey: secret };
}

/**
 * Rotate a key with the consumer's secret key (the reference platform's API key rotation):
 * the old key stays good for the grace period, the new one expires after
 * the tenant's automatic expiry when one is set (it overrides the one asked
 * for), and a new secret key comes back with it.
 */
async function rotate(tenant, secret, body = {}) {
  if (!secret) throw err('SECRET_KEY_REQUIRED: send it in the secretKey header', 401);
  const h = keys.hash(secret);
  const { rows: [c] } = await pool.query(
    `SELECT * FROM platform.api_consumers WHERE tenant_id = $1 AND status = 'ACTIVE'
       AND (secret_hash = $2 OR (prev_secret_hash = $2 AND prev_secret_until > now()))`, [tenant.id, h]);
  if (!c) throw err('INVALID_SECRET_KEY', 401);
  const { rows: [old] } = await pool.query(
    'SELECT * FROM platform.api_keys WHERE consumer_id = $1 AND key_hash = $2 AND rotated_at IS NULL', [c.id, keys.hash(String(body.apiKey || ''))]);
  if (!old) throw err('API_KEY_NOT_FOUND_FOR_THIS_CONSUMER', 404);
  const prefs = await AP.of(tenant.id);
  const grace = prefs.apiKeys.rotationGraceSeconds;
  const ttl = prefs.apiKeys.rotatedKeyExpirySeconds ?? ttlOf(body.expirationTime ?? body.ttl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { key, k } = await insertKey(client, c, { ttl, actor: `api:${c.name}` });
    await client.query('UPDATE platform.api_keys SET rotated_at = now(), grace_until = now() + make_interval(secs => $2::int), replaced_by = $3 WHERE id = $1',
      [old.id, grace, k.id]);
    const nextSecret = keys.mint();
    await client.query(
      `UPDATE platform.api_consumers SET prev_secret_hash = secret_hash, prev_secret_until = now() + make_interval(secs => $2::int),
         secret_hash = $3, secret_created_at = now() WHERE id = $1`, [c.id, grace, keys.hash(nextSecret)]);
    await client.query('INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
      [tenant.id, `api:${c.name}`, 'API_KEY_ROTATED', JSON.stringify({ consumerId: c.id, from: old.id, to: k.id, graceSeconds: grace })]);
    await client.query('COMMIT');
    keys.forget();
    return { id: k.id, apiKey: key, prefix: k.prefix, expiresAt: k.expires_at, secretKey: nextSecret, previousKeyValidForSeconds: grace };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Addresses blocked for bad API keys, and resetting them. */
async function blockedIps(tenant) {
  const { rows } = await pool.query(
    'SELECT ip, failures, blocked_at, updated_at FROM platform.ip_blocks WHERE tenant_id = $1 ORDER BY blocked_at DESC NULLS LAST, updated_at DESC', [tenant.id]);
  return rows;
}
async function resetIps(tenant, ips, { actor }) {
  if (!Array.isArray(ips) || !ips.length) throw err('IPS_REQUIRED: a list of addresses');
  const { rowCount } = await pool.query('DELETE FROM platform.ip_blocks WHERE tenant_id = $1 AND ip = ANY($2::text[])', [tenant.id, ips.map(String)]);
  await audit(tenant, actor, 'BLOCKED_IPS_RESET', { ips });
  return { reset: rowCount };
}

module.exports = { list, get, create, update, remove, createKey, deleteKey, createSecret, rotate, blockedIps, resetIps };
