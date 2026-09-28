'use strict';

const { pool } = require('../db/pool');
const { verifyPassword } = require('./passwords');
const AP = require('../lib/accessPreferences');

/**
 * The tenant's password policy (the reference platform's password requirements and access
 * preferences): length and character counts, at least a letter and a digit,
 * not the username, not one of the last few passwords, and an optional
 * expiry after which the user must choose a new one.
 */

const err = (m, status = 400) => Object.assign(new Error(m), { status });

/** Refuse a password the policy does not allow. */
async function check(tenant, password, { email = '', userId = null, currentHash = null } = {}) {
  const prefs = await AP.of(tenant?.id);
  const problems = AP.passwordProblems(prefs, password, { email });
  if (problems.length) throw err(`PASSWORD_POLICY: ${problems.join('; ')}`);
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
