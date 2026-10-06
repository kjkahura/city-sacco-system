'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { TenantError } = require('../db/tenantContext');

/**
 * The platform control plane (/admin): provisioning, backups, keys and
 * sandboxes for every SACCO. It is off unless ADMIN_API=on, and it takes
 * only tokens signed with ADMIN_JWT_SECRET (its own key, at least 32 bytes,
 * never the staff and member key), with audience "platform-admin", at most
 * an hour long. ADMIN_ALLOWED_IPS (comma separated) limits where they come
 * from. Tokens are made on the server with `cli admin:token --email`. Every
 * request is written to platform.audit_log with its outcome.
 */

const AUD = 'platform-admin';
const enabled = () => process.env.ADMIN_API === 'on';
function key() {
  const k = process.env.ADMIN_JWT_SECRET;
  if (!k || Buffer.byteLength(k) < 32) throw new TenantError('ADMIN_API_NOT_CONFIGURED: set ADMIN_JWT_SECRET (at least 32 bytes)', 503);
  if (k === process.env.JWT_SECRET) throw new TenantError('ADMIN_JWT_SECRET_MUST_DIFFER_FROM_JWT_SECRET', 503);
  return k;
}

function mint(email, minutes = 60) {
  const m = Math.min(Math.max(Number(minutes) || 60, 1), 60);
  return jwt.sign({ sub: String(email).toLowerCase(), email: String(email).toLowerCase(), role: 'PLATFORM_ADMIN', jti: crypto.randomUUID() },
    key(), { algorithm: 'HS256', audience: AUD, expiresIn: `${m}m` });
}

const record = (actor, req, status, extra = {}) => pool.query(
  'INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES (NULL, $1, $2, $3)',
  [actor, 'ADMIN_REQUEST', JSON.stringify({ method: req.method, path: req.originalUrl.split('?')[0], status, ip: req.ip, ...extra })])
  .catch((e) => console.error('[audit-write-failed] admin', req.method, req.originalUrl, e.message));

function requirePlatformAdmin() {
  return (req, res, next) => {
    if (!enabled()) return next(new TenantError('ROUTE_NOT_FOUND', 404));
    // A refused request is recorded too (who tried, from where, why).
    const refuse = (e) => { record(null, req, e.status || 401, { refused: e.message }); return next(e); };
    const allowed = String(process.env.ADMIN_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(req.ip)) return refuse(new TenantError('ADMIN_ADDRESS_NOT_ALLOWED', 403));
    const h = req.get('authorization') || '';
    if (!h.startsWith('Bearer ')) return refuse(new TenantError('authentication required', 401));
    let payload;
    try {
      payload = jwt.verify(h.slice(7), key(), { algorithms: ['HS256'], audience: AUD, maxAge: '61m' });
    } catch (e) {
      return refuse(e instanceof TenantError ? e : new TenantError(`invalid admin token: ${e.message}`, 401));
    }
    if (payload.role !== 'PLATFORM_ADMIN') return refuse(new TenantError('PLATFORM_ADMIN_REQUIRED', 403));
    req.auth = payload;
    // Recorded when the answer is sent, or when the client goes away first.
    let done = false;
    const once = () => { if (!done) { done = true; record(payload.email, req, res.writableFinished ? res.statusCode : 'ABORTED', { jti: payload.jti }); } };
    res.on('finish', once);
    res.on('close', once);
    return next();
  };
}

module.exports = { requirePlatformAdmin, mint, AUD };
