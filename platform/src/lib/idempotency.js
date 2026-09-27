'use strict';

const crypto = require('crypto');

/**
 * Idempotency keys (the reference platform's Idempotency-Key header). A request sent again
 * with the same key, after a timeout or a dropped connection, gets the first
 * response back instead of acting twice. The key is kept with a hash of the
 * request, so the same key on a different request is refused. It runs in the
 * caller's transaction: the action and the record of it commit together.
 *
 * `fn` returns { status, body }; so does once().
 */
async function once(c, req, route, fn) {
  const key = req.get('idempotency-key');
  if (!key) return fn();
  if (String(key).length > 128) throw Object.assign(new Error('IDEMPOTENCY_KEY_TOO_LONG: at most 128 characters'), { status: 400 });
  const hash = crypto.createHash('sha256').update(JSON.stringify([route, req.body || null])).digest('hex');
  // One request per key at a time: a second copy waits for the first.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`idem:${key}`]);
  const { rows: [seen] } = await c.query('SELECT * FROM api_idempotency WHERE key = $1', [key]);
  if (seen) {
    if (seen.request_hash !== hash || seen.route !== route) {
      throw Object.assign(new Error('IDEMPOTENCY_KEY_REUSED: this key was used for a different request'), { status: 409 });
    }
    return { status: seen.status, body: seen.response, replayed: true };
  }
  const out = await fn();
  await c.query(
    'INSERT INTO api_idempotency (key, route, request_hash, status, response, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [key, route, hash, out.status, JSON.stringify(out.body ?? null), req.auth?.email || null]);
  return out;
}

module.exports = { once };
