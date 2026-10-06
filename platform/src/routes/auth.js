'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { verifyPassword, hashPassword } = require('../auth/passwords');
const tokens = require('../auth/tokens');
const mfa = require('../auth/mfa');
const { requireAuth, signToken } = require('../tenancy/resolve');
const { apiError } = require('../lib/http');
const { loginRateLimit, clearLoginAttempts } = require('../lib/limits');
const AP = require('../lib/accessPreferences');
const policy = require('../auth/passwordPolicy');
const U = require('../tenancy/users');

const router = express.Router();

async function recordAttempt(req, email, ok, reason = null) {
  await pool.query(
    'INSERT INTO platform.login_attempts (tenant_id, email, ip, succeeded, reason, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.tenant?.id || null, email, req.ip, ok, reason, req.get('user-agent') || null]
  ).catch(() => {});
}

const locked = (u) => Boolean(u.locked_at) && (!u.locked_until || new Date(u.locked_until) > new Date());

/**
 * A wrong password counts against the user; at the tenant's limit (the reference platform's
 * Lock User After Failed Logins) the user is locked, for the cooldown or
 * until an administrator unlocks them.
 */
async function countFailure(user, prefs) {
  const { rows: [u] } = await pool.query(
    `UPDATE platform.users SET failed_logins = failed_logins + 1,
       locked_at = CASE WHEN failed_logins + 1 >= $2 THEN now() ELSE locked_at END,
       locked_until = CASE WHEN failed_logins + 1 >= $2 THEN (CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END)
                           ELSE locked_until END
     WHERE id = $1 RETURNING failed_logins, locked_at`, [user.id, prefs.lockout.maxFailedLogins, prefs.lockout.lockMinutes]);
  if (u?.locked_at && u.failed_logins === prefs.lockout.maxFailedLogins) {
    await pool.query("INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,'SYSTEM','USER_LOCKED',$2)",
      [user.tenant_id, JSON.stringify({ userId: user.id, email: user.email, failedLogins: u.failed_logins })]).catch(() => {});
  }
}

/** The role's back-office access (the reference platform's Access Rights: the reference platform). */
async function consoleAccess(tenant, user) {
  const code = user.role_code || user.role;
  const { rows } = await pool.query(`SELECT console_access FROM "${tenant.schema_name}".roles WHERE code = $1`, [code]).catch(() => ({ rows: [] }));
  return rows[0] ? rows[0].console_access !== false : true;
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
      `SELECT u.id, u.tenant_id, u.email, u.password_hash, u.role, u.role_code, u.status, u.full_name,
              u.mfa_enabled, u.must_change_password, u.locked_at, u.locked_until, u.password_changed_at, t.slug AS tenant_slug
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
    const prefs = await AP.of(req.tenant.id);
    if (user && locked(user)) {
      await recordAttempt(req, email, false, 'LOCKED');
      // Only someone who knows the password learns the account is locked.
      return ok ? apiError(res, 401, 401, 'USER_LOCKED: too many failed sign-ins; an administrator can unlock you')
        : apiError(res, 401, 401, 'INVALID_CREDENTIALS');
    }
    if (!user || !ok || user.status !== 'ACTIVE') {
      if (user && !ok && user.status === 'ACTIVE') await countFailure(user, prefs);
      await recordAttempt(req, email, false, !user ? 'UNKNOWN_USER' : !ok ? 'WRONG_PASSWORD' : 'INACTIVE');
      return apiError(res, 401, 401, 'INVALID_CREDENTIALS');
    }
    if (!AP.allowlistPasses(prefs, req.ip, { admin: user.role === 'TENANT_ADMIN' })) {
      await recordAttempt(req, email, false, 'IP_NOT_ALLOWED');
      return apiError(res, 403, 403, 'IP_ADDRESS_NOT_ALLOWED');
    }
    if (!(await consoleAccess(req.tenant, user))) {
      await recordAttempt(req, email, false, 'NO_BACK_OFFICE_ACCESS');
      return apiError(res, 403, 403, 'ROLE_HAS_NO_BACK_OFFICE_ACCESS');
    }

    await clearLoginAttempts(req);
    await pool.query('UPDATE platform.users SET failed_logins = 0 WHERE id = $1 AND failed_logins > 0', [user.id]);
    await recordAttempt(req, email, true);
    const expiredPassword = policy.expired(prefs, user.password_changed_at);

    // A temporary password (a new user, or one an administrator reset)
    // signs in only far enough to choose a new one: a token scoped to
    // POST /auth/password and nothing else.
    if (user.must_change_password || expiredPassword) {
      return res.status(403).json({
        errors: [{ errorCode: 403, errorReason: expiredPassword && !user.must_change_password ? 'PASSWORD_EXPIRED' : 'PASSWORD_CHANGE_REQUIRED' }],
        passwordChangeRequired: true,
        passwordPolicy: prefs.password,
        passwordChangeToken: signToken({
          sub: user.id, email: user.email, role: user.role,
          tid: user.tenant_slug, scope: 'password_change',
        }, '10m'),
      });
    }

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
      tenant: { slug: req.tenant.slug, name: req.tenant.name, currency: req.tenant.currency_code, timezone: req.tenant.timezone, environment: req.tenant.environment || 'PRODUCTION' },
    });
  } catch (e) { next(e); }
});

/**
 * Rotation. The presented token is spent and a new pair issued. Presenting
 * a token that has already been used revokes the whole family, on the
 * assumption that a copy is in someone else's hands.
 */
router.post('/refresh', loginRateLimit({ perIp: 60, perAccount: 60, key: 'refreshToken' }), async (req, res, next) => {
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
  res.json({ ...req.auth, permissions: [...(req.auth.permissions || [])].sort(), tenant: req.tenant?.slug }));

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

/**
 * Critical actions (access preferences): the password again, for a token
 * good for five minutes that the critical request carries as X-Reauth-Token.
 */
router.post('/reauth', requireAuth(), loginRateLimit({ perIp: 30, perAccount: 10, key: 'user' }), async (req, res, next) => {
  try {
    const { rows: [u] } = await pool.query('SELECT password_hash FROM platform.users WHERE id = $1', [req.auth.sub]);
    if (!u || !(await verifyPassword(String(req.body?.password || ''), u.password_hash))) {
      return apiError(res, 401, 401, 'INVALID_CREDENTIALS');
    }
    res.json({ reauthToken: signToken({ sub: req.auth.sub, tid: req.tenant.slug, scope: 'reauth' }, '5m'), expiresIn: 300 });
  } catch (e) { next(e); }
});

/** Your own sign-in history. */
router.get('/logins', requireAuth(), async (req, res, next) => {
  try { res.json(await U.logins(req.tenant, { email: req.auth.email, limit: req.query.limit })); } catch (e) { next(e); }
});

// A session, or the scoped token a temporary password signs in with.
const sessionOrPasswordChange = (req, res, next) => {
  if (req.auth?.scope === 'password_change') {
    if (req.tenant && req.auth.tid !== req.tenant.slug) return apiError(res, 403, 403, 'TOKEN_TENANT_MISMATCH');
    return next();
  }
  return requireAuth()(req, res, next);
};

router.post('/password', sessionOrPasswordChange, loginRateLimit({ perIp: 30, perAccount: 10, key: 'user' }), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return apiError(res, 400, 400, 'BOTH_PASSWORDS_REQUIRED');
    if (newPassword === currentPassword) return apiError(res, 400, 400, 'NEW_PASSWORD_MUST_DIFFER');

    const { rows } = await pool.query(
      'SELECT password_hash, email FROM platform.users WHERE id = $1', [req.auth.sub]);
    if (!rows.length || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
      return apiError(res, 401, 401, 'INVALID_CREDENTIALS');
    }
    try {
      await policy.check(req.tenant, String(newPassword), { email: rows[0].email, userId: req.auth.sub, currentHash: rows[0].password_hash });
    } catch (e) { return apiError(res, 400, 400, e.message); }
    await policy.remember(req.auth.sub, rows[0].password_hash);
    await pool.query(
      'UPDATE platform.users SET password_hash = $1, must_change_password = false, password_changed_at = now(), updated_at = now() WHERE id = $2',
      [await hashPassword(String(newPassword)), req.auth.sub]);

    // Changing a password ends every other session. That is the point of
    // changing it.
    const revoked = await tokens.revokeAll(req.auth.sub);
    res.json({ changed: true, sessionsRevoked: revoked });
  } catch (e) { next(e); }
});

// --- second factor --------------------------------------------------------

/** Exchange an MFA ticket plus a code for a real session. */
router.post('/mfa/verify', loginRateLimit({ perIp: 30, perAccount: 30, key: 'mfaTicket' }), async (req, res, next) => {
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
  // A session token (no scope) goes through the full check: the user active, of this tenant, not locked.
  if (!req.auth.scope) return requireAuth()(req, res, next);
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
