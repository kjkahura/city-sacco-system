'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { verifyPassword, hashPassword } = require('../auth/passwords');
const tokens = require('../auth/tokens');
const mfa = require('../auth/mfa');
const { requireAuth, signToken } = require('../tenancy/resolve');
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
      `SELECT u.id, u.email, u.password_hash, u.role, u.status, u.full_name,
              u.mfa_enabled, t.slug AS tenant_slug
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

    await clearLoginAttempts(req);
    await recordAttempt(req, email, true);

    // A correct password is the first factor. When the tenant's policy or
    // the user's own enrolment demands a second, hand back a short-lived
    // ticket rather than a session.
    if (await mfa.isRequired(user, req.tenant)) {
      if (!user.mfa_enabled) {
        // Requiring MFA without a way in would lock a fresh tenant out of
        // its own admin account: you cannot enrol without a session, and
        // you cannot get a session without enrolling. Issue a token scoped
        // to the enrolment endpoints and nothing else.
        return res.status(403).json({
          errors: [{ errorCode: 403, errorReason: 'MFA_ENROLMENT_REQUIRED' }],
          enrolmentRequired: true,
          enrolmentToken: signToken({
            sub: user.id, email: user.email, role: user.role,
            tid: user.tenant_slug, scope: 'mfa_enrolment',
          }, '10m'),
        });
      }
      const challenge = await mfa.issueChallenge(user, { ip: req.ip });
      return res.json({ mfaRequired: true, ...challenge });
    }

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

// --- second factor --------------------------------------------------------

/** Exchange an MFA ticket plus a code for a real session. */
router.post('/mfa/verify', loginRateLimit({ perIp: 30, perAccount: 30 }), async (req, res, next) => {
  try {
    const { mfaTicket, code, recoveryCode } = req.body || {};
    if (!mfaTicket) return apiError(res, 400, 400, 'MFA_TICKET_REQUIRED');
    if (!code && !recoveryCode) return apiError(res, 400, 400, 'CODE_OR_RECOVERY_CODE_REQUIRED');

    const { user, usedRecovery, recoveryCodesRemaining } =
      await mfa.verifyChallenge(mfaTicket, { token: code, recoveryCode });

    await pool.query('UPDATE platform.users SET last_login_at = now() WHERE id = $1', [user.id]);
    const pair = await tokens.issue(user, { userAgent: req.get('user-agent'), ip: req.ip });

    res.json({
      ...pair,
      user: { id: user.id, email: user.email, role: user.role, name: user.full_name },
      ...(usedRecovery ? { usedRecoveryCode: true, recoveryCodesRemaining } : {}),
    });
  } catch (e) {
    if (e.status) return apiError(res, e.status, e.status, e.message);
    next(e);
  }
});

router.get('/mfa', requireAuth(), async (req, res, next) => {
  try { res.json(await mfa.status(req.auth.sub)); } catch (e) { next(e); }
});

/** Step 1: get a secret to scan. MFA is not on yet. */
const allowEnrolmentScope = (req, res, next) => {
  if (!req.auth) return apiError(res, 401, 401, 'AUTHENTICATION_REQUIRED');
  if (req.auth.scope && req.auth.scope !== 'mfa_enrolment') {
    return apiError(res, 403, 403, 'WRONG_TOKEN_SCOPE');
  }
  next();
};

router.post('/mfa/enrol', allowEnrolmentScope, async (req, res, next) => {
  try {
    res.json(await mfa.beginEnrolment(
      { id: req.auth.sub, email: req.auth.email },
      { issuer: req.tenant?.name || 'SACCO Platform' }
    ));
  } catch (e) { next(e); }
});

/** Step 2: prove the authenticator works, then it switches on. */
router.post('/mfa/confirm', allowEnrolmentScope, async (req, res, next) => {
  try {
    if (!req.body?.code) return apiError(res, 400, 400, 'CODE_REQUIRED');
    res.json(await mfa.completeEnrolment(req.auth.sub, req.body.code));
  } catch (e) {
    if (e.status) return apiError(res, e.status, e.status, e.message);
    next(e);
  }
});

router.post('/mfa/disable', requireAuth(), async (req, res, next) => {
  try {
    if (!req.body?.code) return apiError(res, 400, 400, 'CODE_REQUIRED');
    const out = await mfa.disable(req.auth.sub, req.body.code);
    await tokens.revokeAll(req.auth.sub);
    res.json(out);
  } catch (e) {
    if (e.status) return apiError(res, e.status, e.status, e.message);
    next(e);
  }
});

module.exports = router;
