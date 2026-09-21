'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { verifyPassword } = require('../auth/passwords');
const { signToken } = require('../tenancy/resolve');
const { apiError } = require('../lib/http');

const router = express.Router();

/**
 * Login is tenant-scoped. The tenant must already be resolved from the
 * subdomain or X-Tenant header, because the same email can exist in two
 * SACCOs and the credential check must only consider one of them.
 */
router.post('/login', async (req, res, next) => {
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

    // Always run a verify, even with no user, so response time does not
    // reveal whether the email exists in this tenant.
    const ok = await verifyPassword(
      password,
      user?.password_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'
    );
    if (!user || !ok || user.status !== 'ACTIVE') {
      return apiError(res, 401, 401, 'INVALID_CREDENTIALS');
    }

    await pool.query('UPDATE platform.users SET last_login_at = now() WHERE id = $1', [user.id]);

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      tid: user.tenant_slug,     // the tenant claim every request is checked against
      name: user.full_name,
    });
    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, name: user.full_name },
      tenant: { slug: req.tenant.slug, name: req.tenant.name, currency: req.tenant.currency_code },
    });
  } catch (e) { next(e); }
});

router.get('/me', (req, res) => {
  if (!req.auth) return apiError(res, 401, 401, 'AUTHENTICATION_REQUIRED');
  res.json({ ...req.auth, tenant: req.tenant?.slug });
});

module.exports = router;
