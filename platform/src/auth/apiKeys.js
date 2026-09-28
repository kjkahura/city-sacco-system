'use strict';

const crypto = require('crypto');
const { pool } = require('../db/pool');

/**
 * API keys (the reference platform's API Consumers): a key is sent in the apiKey header and
 * stands for its consumer. Only a hash is stored; the key is shown once.
 * A key may expire; a rotated key keeps working for the tenant's grace
 * period. An address that sends ten requests with a bad key is blocked for
 * API keys until an administrator resets it (whitelisted or not, as in
 * The reference platform). Keys are cached for a few seconds after a success.
 */

const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const mint = () => crypto.randomBytes(32).toString('base64url');
const BLOCK_AFTER = 10;
const TTL_MS = 10_000;
const cache = new Map();

const fail = (m, status = 401) => Object.assign(new Error(m), { status });

async function badKey(tenant, ip) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO platform.ip_blocks (tenant_id, ip, failures) VALUES ($1,$2,1)
     ON CONFLICT (tenant_id, ip) DO UPDATE SET failures = platform.ip_blocks.failures + 1, updated_at = now(),
       blocked_at = CASE WHEN platform.ip_blocks.failures + 1 >= $3 THEN COALESCE(platform.ip_blocks.blocked_at, now()) ELSE platform.ip_blocks.blocked_at END
     RETURNING failures, blocked_at`, [tenant.id, String(ip), BLOCK_AFTER]);
  return b;
}

async function blocked(tenant, ip) {
  const { rows: [b] } = await pool.query('SELECT blocked_at FROM platform.ip_blocks WHERE tenant_id = $1 AND ip = $2', [tenant.id, String(ip)]);
  return Boolean(b?.blocked_at);
}

/** The consumer behind a key, or a 401 (403 for a blocked address). */
async function authenticate(tenant, key, ip) {
  if (await blocked(tenant, ip)) throw fail('IP_ADDRESS_BLOCKED: ten requests with a bad API key; an administrator can reset it', 403);
  const h = hash(key);
  const hit = cache.get(h);
  if (hit && hit.expires > Date.now() && hit.tenantId === tenant.id) return hit.out;
  const { rows: [k] } = await pool.query(
    `SELECT k.id, k.expires_at, k.grace_until, k.rotated_at, c.id AS consumer_id, c.name, c.administrator, c.role_code,
            c.permissions, c.status
     FROM platform.api_keys k JOIN platform.api_consumers c ON c.id = k.consumer_id
     WHERE k.key_hash = $1 AND k.tenant_id = $2`, [h, tenant.id]);
  const now = new Date();
  const usable = k && k.status === 'ACTIVE' && (!k.expires_at || new Date(k.expires_at) > now)
    && (!k.rotated_at || (k.grace_until && new Date(k.grace_until) > now));
  if (!usable) {
    const b = await badKey(tenant, ip);
    throw fail(b.blocked_at ? 'IP_ADDRESS_BLOCKED: ten requests with a bad API key; an administrator can reset it' : 'INVALID_API_KEY', b.blocked_at ? 403 : 401);
  }
  pool.query('UPDATE platform.api_keys SET last_used_at = now() WHERE id = $1', [k.id]).catch(() => {});
  const out = {
    keyId: k.id,
    consumer: { id: k.consumer_id, name: k.name, administrator: k.administrator, role_code: k.role_code, permissions: k.permissions },
  };
  cache.set(h, { out, tenantId: tenant.id, expires: Date.now() + TTL_MS });
  return out;
}

const forget = () => cache.clear();

module.exports = { authenticate, hash, mint, forget, blocked };
