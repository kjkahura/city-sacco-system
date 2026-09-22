'use strict';

const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { TenantError } = require('../db/tenantContext');

const SECRET = process.env.JWT_SECRET;
if (!SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}
const signingKey = SECRET || 'dev-only-insecure-secret-do-not-ship';

// Small cache so every request does not hit platform.tenants. Tenant records
// change rarely; 60s of staleness on a status flip is acceptable and a
// suspended tenant is re-checked within a minute.
const cache = new Map();
const TTL_MS = 60_000;

async function lookupTenant(slug) {
  const hit = cache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.tenant;
  // Select every policy column the request path reads. An earlier version
  // listed columns by hand and silently dropped mfa_required_roles,
  // max_concurrent_queries and rate_limit_per_min, so per-tenant limits
  // quietly fell back to the global defaults.
  const { rows } = await pool.query(
    `SELECT id, slug, schema_name, name, status, currency_code, timezone,
            max_concurrent_queries, rate_limit_per_min, mfa_required_roles
     FROM platform.tenants WHERE slug = $1`,
    [slug]
  );
  const tenant = rows[0] || null;
  cache.set(slug, { tenant, expires: Date.now() + TTL_MS });
  return tenant;
}

const invalidate = (slug) => cache.delete(slug);

/**
 * Where the tenant comes from, in priority order:
 *
 *  1. The JWT's tid claim. Authoritative: it was signed by us at login.
 *  2. Subdomain, e.g. citysacco.core.example.com -> citysacco.
 *  3. X-Tenant header, for server-to-server callers and tests.
 *
 * When a token is present, its claim wins and any mismatched host or header
 * is rejected rather than ignored. A teller whose token says citysacco must
 * not be able to read another SACCO by changing a header.
 */
function tenantFromRequest(req) {
  const header = req.get('x-tenant') || null;

  let host = (req.hostname || '').toLowerCase();
  let sub = null;
  const parts = host.split('.');
  if (parts.length > 2 && !['www', 'api', 'admin'].includes(parts[0])) sub = parts[0];

  let claim = null;
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), signingKey, { algorithms: ['HS256'] });
      req.auth = payload;
      claim = payload.tid || null;
    } catch (e) {
      throw new TenantError(`invalid token: ${e.message}`, 401);
    }
  }

  if (claim) {
    if (sub && sub !== claim) throw new TenantError('token tenant does not match host', 403);
    if (header && header !== claim) throw new TenantError('token tenant does not match X-Tenant', 403);
    return claim;
  }
  return sub || header || null;
}

/** Express middleware. Populates req.tenant. */
function resolveTenant({ required = true } = {}) {
  return async (req, res, next) => {
    try {
      const slug = tenantFromRequest(req);
      if (!slug) {
        if (!required) return next();
        throw new TenantError('tenant not specified (subdomain, X-Tenant header, or token)', 400);
      }
      const tenant = await lookupTenant(slug);
      if (!tenant) throw new TenantError(`unknown tenant: ${slug}`, 404);
      if (tenant.status !== 'ACTIVE') throw new TenantError(`tenant ${slug} is ${tenant.status}`, 403);
      req.tenant = tenant;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Require a signed-in user, optionally with one of the given roles. */
function requireAuth(...roles) {
  return (req, res, next) => {
    if (!req.auth) return next(new TenantError('authentication required', 401));
    // A scoped token (currently only mfa_enrolment) is not a session. It
    // exists so a user who must enrol can reach the enrolment endpoints and
    // nothing else.
    if (req.auth.scope) {
      return next(new TenantError(`token is scoped to ${req.auth.scope} and cannot be used here`, 403));
    }
    if (req.tenant && req.auth.tid && req.auth.tid !== req.tenant.slug) {
      return next(new TenantError('token tenant mismatch', 403));
    }
    // A member token never satisfies a staff route. Many staff routes call
    // requireAuth() with no role list, meaning "any signed-in staff"; if
    // MEMBER slipped through that, a member could list every other member.
    // Members reach the portal through requireMember and nothing else.
    if (req.auth.role === 'MEMBER' && !roles.includes('MEMBER')) {
      return next(new TenantError('member tokens cannot use staff endpoints', 403));
    }
    if (roles.length && !roles.includes(req.auth.role)) {
      return next(new TenantError(`role ${req.auth.role} is not permitted here`, 403));
    }
    next();
  };
}

/** Require a signed-in member. Populates req.member = { id, memberNo }. */
function requireMember() {
  return (req, res, next) => {
    if (!req.auth) return next(new TenantError('authentication required', 401));
    if (req.auth.scope) return next(new TenantError('scoped token cannot be used here', 403));
    if (req.auth.role !== 'MEMBER' || !req.auth.mid) {
      return next(new TenantError('member sign-in required', 403));
    }
    if (req.tenant && req.auth.tid !== req.tenant.slug) {
      return next(new TenantError('token tenant mismatch', 403));
    }
    req.member = { id: req.auth.mid, memberNo: req.auth.memberNo, name: req.auth.name };
    next();
  };
}

const signToken = (payload, expiresIn = '12h') =>
  jwt.sign(payload, signingKey, { algorithm: 'HS256', expiresIn });

module.exports = { resolveTenant, requireAuth, requireMember, signToken, tenantFromRequest, lookupTenant, invalidate, signingKey };
