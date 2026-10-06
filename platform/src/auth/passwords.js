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
// OWASP's equivalent of N=2^17, r=8, p=1 that needs 16 MB rather than 128 MB a hash
// (Password Storage Cheat Sheet): N=2^14, r=8, p=5. Older hashes (p=1) are
// replaced at the next successful sign-in (needsRehash).
const N = 16384;   // CPU/memory cost
const r = 8;       // block size
const p = 5;       // parallelisation
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
    // A hash made with older, cheaper parameters (p=1) is topped up to the current cost, so a
    // sign-in for an account not yet rehashed takes as long as one for an unknown account.
    const short = p - Number(pp);
    if (Number(n) === N && Number(rr) === r && short > 0) {
      await scrypt(plain, salt, KEYLEN, { N, r, p: short, maxmem: MAXMEM });
    }
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

/** Whether a stored hash is weaker than the current parameters. */
function needsRehash(stored) {
  const [scheme, n, rr, pp] = String(stored || '').split('$');
  return scheme === 'scrypt' && (Number(n) * Number(rr) * Number(pp) < N * r * p);
}

module.exports = { hashPassword, verifyPassword, hashPin, needsRehash };
