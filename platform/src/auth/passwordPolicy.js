'use strict';

const crypto = require('crypto');
const { pool } = require('../db/pool');
const OUT = require('../lib/outbound');
const { verifyPassword } = require('./passwords');
const AP = require('../lib/accessPreferences');
const { err } = require('../lib/errors');

/**
 * The tenant's password policy (the reference platform's password requirements and access
 * preferences): length and character counts, at least a letter and a digit,
 * not the username, not one of the last few passwords, and an optional
 * expiry after which the user must choose a new one.
 */


/** Refuse a password the policy does not allow. */
/**
 * With PASSWORD_BREACH_CHECK=on, a new password is checked against the
 * breached-passwords service by k-anonymity: only the first five characters
 * of its SHA-1 leave the platform. If the service cannot be reached the
 * password is not refused for it.
 */
async function breached(password) {
  if (process.env.PASSWORD_BREACH_CHECK !== 'on') return false;
  const h = crypto.createHash('sha1').update(String(password)).digest('hex').toUpperCase();
  const r = await OUT.send({ url: `https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, method: 'GET', headers: { 'add-padding': 'true' },
    maxBytes: 2 * 1024 * 1024, timeoutMs: 3000, agent: 'sacco-platform-password-check' });
  if (r.error || r.status !== 200) return false;
  return r.body.split('\n').some((line) => { const [suffix, count] = line.trim().split(':'); return suffix === h.slice(5) && Number(count) > 0; });
}

async function check(tenant, password, { email = '', userId = null, currentHash = null } = {}) {
  const prefs = await AP.of(tenant?.id);
  const problems = AP.passwordProblems(prefs, password, { email });
  if (problems.length) throw err(`PASSWORD_POLICY: ${problems.join('; ')}`);
  if (await breached(password)) throw err('PASSWORD_POLICY: this password has appeared in a data breach; choose another');
  if (userId) {
    const n = prefs.password.history;
    if (currentHash && await verifyPassword(password, currentHash)) throw err('NEW_PASSWORD_MUST_DIFFER');
    const { rows } = await pool.query(
      'SELECT password_hash FROM platform.password_history WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, n]);
    for (const r of rows) {
      if (await verifyPassword(password, r.password_hash)) throw err(`PASSWORD_USED_BEFORE: not one of your last ${n} passwords`);
    }
  }
  return prefs;
}

/** Keep the password being replaced, so it cannot come back (ten at most). */
async function remember(userId, oldHash) {
  if (!oldHash) return;
  await pool.query('INSERT INTO platform.password_history (user_id, password_hash) VALUES ($1,$2)', [userId, oldHash]);
  await pool.query(
    `DELETE FROM platform.password_history WHERE user_id = $1 AND id NOT IN
       (SELECT id FROM platform.password_history WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10)`, [userId]);
}

/** Whether a user's password has passed the tenant's expiry. */
function expired(prefs, changedAt) {
  const days = prefs.password.expiryDays;
  if (!days || !changedAt) return false;
  return Date.now() - new Date(changedAt).getTime() > days * 86400_000;
}

module.exports = { check, remember, expired };
