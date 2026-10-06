'use strict';

const crypto = require('crypto');

/**
 * Secrets the platform must send but never show: a webhook's basic
 * authentication password and its signing secret.
 *
 * AES-256-GCM with a random IV per value. The key is SECRETS_KEY (any
 * string; it is hashed to 32 bytes) or, when that is not set, a key derived
 * from JWT_SECRET for this purpose only. Set SECRETS_KEY in production:
 * with the fallback, rotating JWT_SECRET would make stored secrets
 * unreadable, and webhooks would have to be given them again.
 *
 * Stored form: "v1:" + base64(iv | tag | ciphertext).
 */

function key() {
  const own = process.env.SECRETS_KEY;
  // In production the key is its own, and long enough: no fallback tying it to JWT_SECRET.
  if (process.env.NODE_ENV === 'production' && (!own || Buffer.byteLength(own) < 32)) {
    throw new Error('SECRETS_KEY_NOT_CONFIGURED: set SECRETS_KEY to at least 32 random bytes in production');
  }
  if (own) return crypto.createHash('sha256').update(own).digest();
  const jwt = process.env.JWT_SECRET;
  if (!jwt) throw new Error('SECRETS_KEY_NOT_CONFIGURED: set SECRETS_KEY (or JWT_SECRET)');
  return Buffer.from(crypto.hkdfSync('sha256', jwt, 'sacco-platform', 'stored-secrets-v1', 32));
}

function seal(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

function open(stored) {
  if (!stored) return null;
  const raw = Buffer.from(String(stored).replace(/^v1:/, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

const newSigningSecret = () => crypto.randomBytes(32).toString('hex');

/** An HMAC of the text under the same key, for tokens the platform hands out and checks (stream cursors). */
const sign = (text) => crypto.createHmac('sha256', key()).update(String(text)).digest('base64url');

module.exports = { seal, open, newSigningSecret, sign };
