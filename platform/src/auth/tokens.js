'use strict';

const crypto = require('crypto');
const { pool } = require('../db/pool');
const { signToken } = require('../tenancy/resolve');

/**
 * Refresh tokens with rotation and reuse detection.
 *
 * Access tokens are short (15 minutes) so a leaked one expires quickly.
 * Refresh tokens are long but single use: presenting one issues a new pair
 * and marks the old one used. If a token that has already been used comes
 * back, someone has a copy, so the whole family is revoked and both the
 * attacker and the legitimate user are logged out. That is the intended
 * outcome: a forced re-login beats a silent session hijack.
 *
 * Only the SHA-256 of the token is stored, so a database dump does not hand
 * over live sessions.
 */

const ACCESS_TTL = process.env.ACCESS_TTL || '15m';
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 30);

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const mint = () => crypto.randomBytes(48).toString('base64url');

async function issue(user, { familyId = crypto.randomUUID(), userAgent = null, ip = null } = {}) {
  const refresh = mint();
  const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000);
  await pool.query(
    `INSERT INTO platform.refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [user.id, hash(refresh), familyId, expires, userAgent, ip]
  );
  const access = signToken({
    sub: user.id, email: user.email, role: user.role, tid: user.tenant_slug, name: user.full_name,
  }, ACCESS_TTL);
  return { accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TTL, refreshExpiresAt: expires };
}

async function rotate(presented, { userAgent = null, ip = null } = {}) {
  const h = hash(presented);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL search_path TO platform, public");
    const { rows } = await client.query(
      'SELECT * FROM platform.refresh_tokens WHERE token_hash = $1 FOR UPDATE', [h]
    );
    const tok = rows[0];
    if (!tok) throw Object.assign(new Error('INVALID_REFRESH_TOKEN'), { status: 401 });

    if (tok.revoked_at) throw Object.assign(new Error('REFRESH_TOKEN_REVOKED'), { status: 401 });

    if (tok.used_at) {
      // Replay. Burn the family, not just this token.
      await client.query(
        'UPDATE platform.refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
        [tok.family_id]
      );
      await client.query(
        "INSERT INTO platform.audit_log (actor, action, detail) VALUES ($1,'REFRESH_TOKEN_REUSE_DETECTED',$2)",
        [tok.user_id, JSON.stringify({ familyId: tok.family_id, ip })]
      );
      await client.query('COMMIT');
      throw Object.assign(new Error('REFRESH_TOKEN_REUSED_FAMILY_REVOKED'), { status: 401 });
    }

    if (new Date(tok.expires_at) < new Date()) {
      await client.query('COMMIT');
      throw Object.assign(new Error('REFRESH_TOKEN_EXPIRED'), { status: 401 });
    }

    const { rows: users } = await client.query(
      `SELECT u.id, u.email, u.role, u.full_name, u.status, t.slug AS tenant_slug
       FROM platform.users u LEFT JOIN platform.tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`, [tok.user_id]
    );
    const user = users[0];
    if (!user || user.status !== 'ACTIVE') {
      await client.query('COMMIT');
      throw Object.assign(new Error('USER_INACTIVE'), { status: 401 });
    }

    await client.query('UPDATE platform.refresh_tokens SET used_at = now() WHERE id = $1', [tok.id]);

    const next = mint();
    const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000);
    await client.query(
      `INSERT INTO platform.refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user.id, hash(next), tok.family_id, expires, userAgent, ip]
    );
    await client.query('COMMIT');

    return {
      accessToken: signToken({
        sub: user.id, email: user.email, role: user.role, tid: user.tenant_slug, name: user.full_name,
      }, ACCESS_TTL),
      refreshToken: next,
      expiresIn: ACCESS_TTL,
      refreshExpiresAt: expires,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function revokeAll(userId) {
  const { rowCount } = await pool.query(
    'UPDATE platform.refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
  return rowCount;
}

async function revoke(presented) {
  const { rowCount } = await pool.query(
    'UPDATE platform.refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hash(presented)]
  );
  return rowCount;
}

/** Housekeeping: drop tokens that expired a while ago. */
async function prune(olderThanDays = 60) {
  const { rowCount } = await pool.query(
    `DELETE FROM platform.refresh_tokens WHERE expires_at < now() - ($1 || ' days')::interval`,
    [olderThanDays]
  );
  return rowCount;
}

module.exports = { issue, rotate, revoke, revokeAll, prune, ACCESS_TTL, REFRESH_TTL_DAYS };
