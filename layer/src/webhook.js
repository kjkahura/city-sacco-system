'use strict';

const crypto = require('crypto');

/**
 * Checks the platform's webhook signature: `x-sacco-signature: t=<unix seconds>,v1=<hex>`,
 * the HMAC-SHA256 of "<t>.<body>" with the webhook's signing secret. A signature
 * older than `toleranceSeconds` is refused, so a captured request cannot be replayed later.
 */
function verify(secret, header, body, { now = Date.now(), toleranceSeconds = 300 } = {}) {
  if (!secret) return { ok: false, reason: 'WEBHOOK_SECRET_NOT_SET' };
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(parts.v1 || '')) return { ok: false, reason: 'SIGNATURE_MISSING' };
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return { ok: false, reason: 'SIGNATURE_TOO_OLD' };
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${body}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: 'SIGNATURE_INVALID' };
}

module.exports = { verify };
