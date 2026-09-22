'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

/**
 * scrypt from node:crypto rather than bcrypt.
 *
 * bcrypt needs a native build, which breaks on slim deploy images and on
 * Node upgrades. scrypt is memory-hard, in the standard library, and needs
 * no toolchain. Parameters below are the interactive-login profile.
 */
const N = 16384;   // CPU/memory cost
const r = 8;       // block size
const p = 1;       // parallelisation
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

async function hashPassword(plain, { minLength = 8 } = {}) {
  if (typeof plain !== 'string' || plain.length < minLength) {
    throw new Error(`password must be at least ${minLength} characters`);
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(plain, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(plain, stored) {
  try {
    const [scheme, n, rr, pp, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scrypt(plain, salt, expected.length, {
      N: Number(n), r: Number(rr), p: Number(pp), maxmem: MAXMEM,
    });
    // Constant-time: a length check first, since timingSafeEqual throws on
    // mismatched lengths and that throw would itself leak length.
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A member PIN is four to six digits, which no hash can make strong. The
 * same scrypt is used so a dump of member_credentials costs as much to
 * attack per guess as a dump of staff passwords, but the real control is the
 * lockout in memberAuth, and the digit rule is enforced there.
 */
const hashPin = (pin) => hashPassword(String(pin), { minLength: 4 });

module.exports = { hashPassword, verifyPassword, hashPin };
