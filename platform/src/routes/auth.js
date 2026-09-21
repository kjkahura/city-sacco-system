'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { verifyPassword, hashPassword } = require('../auth/passwords');
const tokens = require('../auth/tokens');
const { requireAuth } = require('../tenancy/resolve');
const { apiError } = require('../lib/http');
const { loginRateLimit, clearLoginAttempts } = require('../lib/limits');

const router = express.Router();

async function recordAttempt(req, email, ok) {
  await pool.query(
    'INSERT INTO platform.login_attempts (tenant_id, email, ip, succeeded) VALUES ($1,$2,$3,$4)',
    [req.tenant?.id || null, email, req.ip, ok]
  ).catch(() => {});
}

/**
 * Login is tenant-scoped: the same email can exist in two SACCOs, so the
 * credential check must only ever consider one of them.
 */
router.post('/login', loginRateLimit(), async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return apiError(res, 400, 400, 'EMAIL_AND_PASSWORD_REQUIRED');

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.role, u.status, u.full_name, t.slug AS tenant_slug
       FROM platform.users u
       JOIN platform.tenants t ON t.id = u.tenant_id
       WHERE u.tenant_id = $1 AND lower(u.email) = lower($2)`,
      [req.tenant.id, email]
    );
    const user = rows[0];

    // Always verify, even with no user, so response time does not reveal
    // whether the email exists in this tenant.
    const ok = await verifyPassword(
      password,
      user?.password_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'
    );
    if (!user || !ok || user.status !== 'ACTIVE') {
      await recordAttempt(req, email, false);
      return apiError(res, 401, 401, 'INVALID_CREDENTIALS');
    }

    clearLoginAttempts(req);
    await recordAttempt(req, email, true);
    await pool.query('UPDATE platform.users SET last_login_at = now() WHERE id = $1', [user.id]);

    const pair = await tokens.issue(user, {
      userAgent: req.get('user-agent'), ip: req.ip,
    });
    res.json({
      ...pair,
      user: { id: user.id, email: user.email, role: user.role, name: user.full_name },
      tenant: { slug: req.tenant.slug, name: req.tenant.name, currency: req.tenant.currency_code },
    });
  } catch (e) { next(e); }
});

/**
 * Rotation. The presented token is spent and a new pair issued. Presenting
 * a token that has already been used revokes the whole family, on the
 * assumption that a copy is in someone else's hands.
 */
router.post('/refresh', loginRateLimit({ perIp: 60, perAccount: 60 }), async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return apiError(res, 400, 400, 'REFRESH_TOKEN_REQUIRED');
    const pair = await tokens.rotate(refreshToken, {
      userAgent: req.get('user-agent'), ip: req.ip,
    });
    res.json(pair);
  } catch (e) {
    if (e.status === 401) return apiError(res, 401, 401, e.message);
    next(e);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken, allSessions } = req.body || {};
    if (allSessions && req.auth) {
      return res.json({ revoked: await tokens.revokeAll(req.auth.sub) });
    }
    if (!refreshToken) return apiError(res, 400, 400, 'REFRESH_TOKEN_REQUIRED');
    res.json({ revoked: await tokens.revoke(refreshToken) });
  } catch (e) { next(e); }
});

router.get('/me', requireAuth(), (req, res) =>
  res.json({ ...req.auth, tenant: req.tenant?.slug }));

router.get('/sessions', requireAuth(), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, family_id, issued_at, expires_at, used_at, revoked_at, user_agent, ip
       FROM platform.refresh_tokens
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY issued_at DESC`,
      [req.auth.sub]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/password', requireAuth(), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return apiError(res, 400, 400, 'BOTH_PASSWORDS_REQUIRED');
    if (String(newPassword).length < 12) return apiError(res, 400, 400, 'PASSWORD_TOO_SHORT');

    const { rows } = await pool.query(
      'SELECT password_hash FROM platform.users WHERE id = $1', [req.auth.sub]);
    if (!rows.length || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
      return apiError(res, 401, 401, 'INVALID_CREDENTIALS');
    }
    await pool.query('UPDATE platform.users SET password_hash = $1 WHERE id = $2',
      [await hashPassword(newPassword), req.auth.sub]);

    // Changing a password ends every other session. That is the point of
    // changing it.
    const revoked = await tokens.revokeAll(req.auth.sub);
    res.json({ changed: true, sessionsRevoked: revoked });
  } catch (e) { next(e); }
});

module.exports = router;
