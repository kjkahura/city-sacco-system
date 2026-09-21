'use strict';

const crypto = require('crypto');

/**
 * TOTP, RFC 6238. Implemented directly on node:crypto rather than pulling a
 * dependency: it is about forty lines, and an authentication primitive is
 * not somewhere to inherit someone else's supply chain.
 *
 * SHA-1 with 6 digits and a 30 second step, because that is what Google
 * Authenticator, Authy and Microsoft Authenticator actually implement. The
 * algorithm choice is interoperability, not a security preference.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('INVALID_BASE32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 bytes, the RFC 4226 recommended secret length for SHA-1. */
const generateSecret = () => base32Encode(crypto.randomBytes(20));

function code(secret, { step = 30, digits = 6, at = Date.now(), algorithm = 'sha1' } = {}) {
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac(algorithm, base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * Verify with a small window, since phone clocks drift. Returns the matched
 * counter offset so the caller can reject a code that was already used at
 * that counter, which is what stops a shoulder-surfed code being replayed
 * within its 30 second life.
 */
function verify(token, secret, { window = 1, step = 30, digits = 6, at = Date.now() } = {}) {
  const given = String(token || '').replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(given)) return { ok: false };
  for (let w = -window; w <= window; w += 1) {
    const expected = code(secret, { step, digits, at: at + w * step * 1000 });
    // Constant time within the window; length is fixed so this is safe.
    if (expected.length === given.length
      && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
      return { ok: true, counter: Math.floor((at + w * step * 1000) / 1000 / step) };
    }
  }
  return { ok: false };
}

/** otpauth:// URI for the QR code the user scans. */
function provisioningUri({ secret, account, issuer = 'SACCO Platform', digits = 6, period = 30 }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, code, verify, provisioningUri, base32Encode, base32Decode };
