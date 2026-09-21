'use strict';

const crypto = require('crypto');
const { pool } = require('../db/pool');
const totp = require('./totp');
const { hashPassword, verifyPassword } = require('./passwords');

/**
 * MFA enrolment and verification.
 *
 * Flow at login when a second factor is required:
 *   password ok -> a short-lived ticket, not a session
 *   ticket + TOTP (or a recovery code) -> the real token pair
 *
 * The half-authenticated state lives in the database as an opaque hashed
 * ticket, so a client holding it has nothing it can use against the API.
 */

const TICKET_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const err = (code, status = 400) => Object.assign(new Error(code), { status });

/** Step 1 of enrolment: hand back a secret to scan. Not active yet. */
async function beginEnrolment(user, { issuer = 'SACCO Platform' } = {}) {
  const secret = totp.generateSecret();
  await pool.query(
    'UPDATE platform.users SET mfa_secret = $1, mfa_enabled = false WHERE id = $2',
    [secret, user.id]
  );
  return {
    secret,
    uri: totp.provisioningUri({ secret, account: user.email, issuer }),
    // The caller renders the QR. Shipping an image generator for this would
    // be a dependency for no benefit.
  };
}

/**
 * Step 2: prove the authenticator works before switching MFA on. Enabling
 * without this check is how people lock themselves out of their own SACCO.
 */
async function completeEnrolment(userId, token) {
  const { rows } = await pool.query(
    'SELECT id, mfa_secret, mfa_enabled FROM platform.users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u?.mfa_secret) throw err('MFA_ENROLMENT_NOT_STARTED', 409);
  if (u.mfa_enabled) throw err('MFA_ALREADY_ENABLED', 409);

  const res = totp.verify(token, u.mfa_secret);
  if (!res.ok) throw err('INVALID_MFA_CODE', 401);

  const recovery = Array.from({ length: 10 }, () =>
    crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE platform.users SET mfa_enabled = true, mfa_enrolled_at = now(), mfa_last_counter = $1 WHERE id = $2',
      [res.counter, userId]
    );
    await client.query('DELETE FROM platform.mfa_recovery_codes WHERE user_id = $1', [userId]);
    for (const c of recovery) {
      await client.query(
        'INSERT INTO platform.mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)',
        [userId, await hashPassword(c)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Shown exactly once. There is no endpoint to read them back.
  return { enabled: true, recoveryCodes: recovery };
}

async function disable(userId, token) {
  const { rows } = await pool.query(
    'SELECT mfa_secret, mfa_enabled FROM platform.users WHERE id = $1', [userId]);
  if (!rows[0]?.mfa_enabled) throw err('MFA_NOT_ENABLED', 409);
  if (!totp.verify(token, rows[0].mfa_secret).ok) throw err('INVALID_MFA_CODE', 401);

  await pool.query(
    `UPDATE platform.users SET mfa_enabled = false, mfa_secret = NULL,
       mfa_enrolled_at = NULL, mfa_last_counter = NULL WHERE id = $1`, [userId]);
  await pool.query('DELETE FROM platform.mfa_recovery_codes WHERE user_id = $1', [userId]);
  return { enabled: false };
}

/** Is a second factor demanded of this user by their tenant's policy? */
async function isRequired(user, tenant) {
  if (user.mfa_enabled) return true;
  const roles = tenant?.mfa_required_roles || [];
  return roles.includes(user.role);
}

async function issueChallenge(user, { ip = null } = {}) {
  const ticket = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO platform.mfa_challenges (user_id, ticket_hash, expires_at, ip)
     VALUES ($1,$2,now() + ($3 || ' milliseconds')::interval,$4)`,
    [user.id, sha(ticket), TICKET_TTL_MS, ip]
  );
  return { mfaTicket: ticket, expiresInSeconds: TICKET_TTL_MS / 1000 };
}

/**
 * Exchange ticket plus second factor for the user record, ready for the
 * caller to mint tokens. Consumes the ticket either way on success, and
 * burns it after too many wrong codes so a ticket cannot be brute-forced.
 */
async function verifyChallenge(ticket, { token, recoveryCode }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM platform.mfa_challenges WHERE ticket_hash = $1 FOR UPDATE', [sha(ticket || '')]);
    const ch = rows[0];
    if (!ch) throw err('INVALID_MFA_TICKET', 401);
    if (ch.consumed_at) throw err('MFA_TICKET_ALREADY_USED', 401);
    if (new Date(ch.expires_at) < new Date()) throw err('MFA_TICKET_EXPIRED', 401);
    if (ch.attempts >= MAX_ATTEMPTS) throw err('TOO_MANY_MFA_ATTEMPTS', 429);

    const { rows: users } = await client.query(
      `SELECT u.*, t.slug AS tenant_slug FROM platform.users u
       LEFT JOIN platform.tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [ch.user_id]);
    const user = users[0];
    if (!user || user.status !== 'ACTIVE') throw err('USER_INACTIVE', 401);

    let ok = false;
    let usedRecovery = false;

    if (token && user.mfa_secret) {
      const res = totp.verify(token, user.mfa_secret);
      // Reject a code already accepted at this counter, so an observed code
      // cannot be reused inside its 30 second life.
      if (res.ok && Number(user.mfa_last_counter) === res.counter) {
        throw err('MFA_CODE_ALREADY_USED', 401);
      }
      if (res.ok) {
        ok = true;
        await client.query('UPDATE platform.users SET mfa_last_counter = $1 WHERE id = $2',
          [res.counter, user.id]);
      }
    } else if (recoveryCode) {
      const { rows: codes } = await client.query(
        'SELECT id, code_hash FROM platform.mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
        [user.id]
      );
      for (const c of codes) {
        if (await verifyPassword(String(recoveryCode).trim().toUpperCase(), c.code_hash)) {
          await client.query('UPDATE platform.mfa_recovery_codes SET used_at = now() WHERE id = $1', [c.id]);
          ok = true;
          usedRecovery = true;
          break;
        }
      }
    }

    if (!ok) {
      await client.query('UPDATE platform.mfa_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
      await client.query('COMMIT');
      throw err('INVALID_MFA_CODE', 401);
    }

    await client.query('UPDATE platform.mfa_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);

    let remaining = null;
    if (usedRecovery) {
      const { rows: [r] } = await client.query(
        'SELECT count(*)::int AS n FROM platform.mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
        [user.id]
      );
      remaining = r.n;
      await client.query(
        "INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,'MFA_RECOVERY_CODE_USED',$3)",
        [user.tenant_id, user.email, JSON.stringify({ remaining })]
      );
    }

    await client.query('COMMIT');
    return { user, usedRecovery, recoveryCodesRemaining: remaining };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function status(userId) {
  const { rows } = await pool.query(
    `SELECT u.mfa_enabled, u.mfa_enrolled_at,
            (SELECT count(*)::int FROM platform.mfa_recovery_codes r
             WHERE r.user_id = u.id AND r.used_at IS NULL) AS recovery_codes_remaining
     FROM platform.users u WHERE u.id = $1`, [userId]);
  return rows[0] || null;
}

/** Housekeeping for expired tickets. */
async function pruneChallenges() {
  const { rowCount } = await pool.query(
    "DELETE FROM platform.mfa_challenges WHERE expires_at < now() - interval '1 day'");
  return rowCount;
}

module.exports = {
  beginEnrolment, completeEnrolment, disable, isRequired,
  issueChallenge, verifyChallenge, status, pruneChallenges,
  TICKET_TTL_MS, MAX_ATTEMPTS,
};
