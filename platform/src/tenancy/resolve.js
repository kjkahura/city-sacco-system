'use strict';

const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { TenantError } = require('../db/tenantContext');
const PERMS = require('../lib/permissions');
const requestContext = require('../lib/requestContext');

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

// Whether a staff user may still act. An access token lives 15 minutes, and a
// user suspended by their administrator (or their tenant's) should not keep
// working for the rest of it, so every staff request checks the user's
// status. Cached for a few seconds per user so a busy teller costs one query
// per window, not one per request; ../tenancy/users forgets a user the
// moment it changes them.
const userCache = new Map();
const USER_TTL_MS = 10_000;
const SCHEMA_RE = /^tenant_[a-z][a-z0-9_]{2,40}$/;

/**
 * The user's status and access: their role (a tenant role code, or the
 * built-in role), the role's permissions (the tenant's edits, or the
 * platform's defaults) and any given to the user directly. A tenant
 * administrator holds every permission.
 */
async function userState(id, schema) {
  const key = `${schema || ''}:${id}`;
  const hit = userCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.state;
  let state = null;
  if (/^[0-9a-f-]{36}$/i.test(String(id))) {
    const { rows: [u] } = await pool.query(
      'SELECT status, role, role_code, permissions, branch_id FROM platform.users WHERE id = $1', [id]);
    if (u) {
      let row = null;
      if (schema && SCHEMA_RE.test(schema)) {
        const { rows } = await pool.query(
          `SELECT code, name, base_role, user_type, permissions FROM "${schema}".roles WHERE code = $1`,
          [u.role_code || u.role]).catch(() => ({ rows: [] }));
        row = rows[0] || null;
      }
      const base = row ? row.permissions : (PERMS.DEFAULTS[u.role] || []);
      const held = u.role === 'TENANT_ADMIN' ? PERMS.CATALOG.map((p) => p.code) : [...new Set([...base, ...(u.permissions || [])])];
      state = {
        status: u.status,
        role: u.role,
        roleCode: u.role_code || u.role,
        userType: row ? row.user_type : (PERMS.USER_TYPES[u.role] || null),
        branchId: u.branch_id,
        permissions: new Set(held),
      };
    }
  }
  userCache.set(key, { state, expires: Date.now() + USER_TTL_MS });
  return state;
}
/** Forget a user's cached access (every tenant); with no id, forget everyone's. */
function forgetUser(id = null) {
  if (id === null) { userCache.clear(); return; }
  for (const k of userCache.keys()) if (k.endsWith(`:${id}`)) userCache.delete(k);
}

/** Require a signed-in user, optionally with one of the given roles. */
function requireAuth(...roles) {
  return async (req, res, next) => {
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
    if (req.auth.role === 'MEMBER') {
      if (roles.length && !roles.includes('MEMBER')) return next(new TenantError('role MEMBER is not permitted here', 403));
      return next();
    }
    let state;
    try {
      state = await userState(req.auth.sub, req.tenant?.schema_name);
    } catch (e) { return next(e); }
    if (state === null) return next(new TenantError('USER_NOT_FOUND', 401));
    if (state.status !== 'ACTIVE') return next(new TenantError(`USER_${state.status}`, 401));
    // The role as it stands, not as the token was issued with: a role an
    // administrator changed takes effect within seconds, like a suspension.
    req.auth.role = state.role;
    if (roles.length && !roles.includes(req.auth.role)) {
      return next(new TenantError(`role ${req.auth.role} is not permitted here`, 403));
    }
    req.auth.permissions = state.permissions;
    req.auth.roleCode = state.roleCode;
    req.auth.userType = state.userType;
    req.auth.branchId = state.branchId;
    // The rest of the request knows who it serves (lib/requestContext).
    return requestContext.run({
      userId: req.auth.sub, email: req.auth.email, role: req.auth.role,
      tillRequired: !PERMS.can(req.auth, 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL'),
    }, () => next());
  };
}

/**
 * Require a signed-in staff user holding at least one of the permissions
 * (lib/permissions: the reference platform's codes). A tenant administrator holds all.
 */
function requirePermission(...codes) {
  const auth = requireAuth();
  return (req, res, next) => auth(req, res, (e) => {
    if (e) return next(e);
    if (!codes.some((code) => PERMS.can(req.auth, code))) {
      return next(new TenantError(`PERMISSION_REQUIRED: ${codes.join(' or ')}`, 403));
    }
    return next();
  });
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

module.exports = { userState, resolveTenant, requireAuth, requirePermission, requireMember, signToken, tenantFromRequest, lookupTenant, invalidate, forgetUser, signingKey };
