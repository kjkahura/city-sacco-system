'use strict';

const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { TenantError } = require('../db/tenantContext');
const PERMS = require('../lib/permissions');
const requestContext = require('../lib/requestContext');
const AP = require('../lib/accessPreferences');
const RP = require('../lib/routePermissions');
const apiKeys = require('../auth/apiKeys');

// The signing key fails closed: only a development or test run may use the
// built-in key, and a production key must be long enough not to be guessed.
const SECRET = process.env.JWT_SECRET;
const DEV = ['development', 'test'].includes(process.env.NODE_ENV);
if (!SECRET && !DEV) throw new Error('JWT_SECRET must be set (only NODE_ENV=development or test runs without it)');
if (SECRET && process.env.NODE_ENV === 'production' && Buffer.byteLength(SECRET) < 32) {
  throw new Error('JWT_SECRET must be at least 32 bytes in production');
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
            max_concurrent_queries, rate_limit_per_min, mfa_required_roles, environment
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

async function roleRow(schema, code) {
  if (!schema || !SCHEMA_RE.test(schema) || !code) return null;
  const { rows } = await pool.query(
    `SELECT code, name, base_role, user_type, permissions, console_access, api_access FROM "${schema}".roles WHERE code = $1`,
    [code]).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

/**
 * The user's status and access in one tenant: their role (a tenant role
 * code, or the built-in role), the role's permissions (the tenant's edits,
 * or the platform's defaults) and any given to the user directly, their user
 * type and their branch access. A tenant administrator holds every
 * permission. A user who is not the tenant's is null: a token for another
 * tenant, or one with no tenant, is not a way in.
 */
async function userState(id, schema, tenantId = null) {
  const key = `${schema || ''}:${id}`;
  const hit = userCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.state;
  let state = null;
  if (/^[0-9a-f-]{36}$/i.test(String(id))) {
    const { rows: [u] } = await pool.query(
      `SELECT u.tenant_id, u.status, u.role, u.role_code, u.permissions, u.branch_id, u.user_type, u.all_branches, u.branch_access,
              u.other_officers_clients, u.locked_at, u.locked_until, u.email
       FROM platform.users u WHERE u.id = $1`, [id]);
    const tid = tenantId || (schema ? (await pool.query('SELECT id FROM platform.tenants WHERE schema_name = $1', [schema])).rows[0]?.id : null);
    if (u && (!schema || (tid && u.tenant_id === tid))) {
      const row = await roleRow(schema, u.role_code || u.role);
      const base = row ? row.permissions : (PERMS.DEFAULTS[u.role] || []);
      const admin = u.role === 'TENANT_ADMIN';
      const held = admin ? PERMS.CATALOG.map((p) => p.code) : [...new Set([...base, ...(u.permissions || [])])];
      const userType = admin ? 'ADMINISTRATOR' : (u.user_type || (row ? row.user_type : null) || PERMS.USER_TYPES[u.role] || null);
      const branches = admin || u.all_branches ? null : [...new Set([u.branch_id, ...(u.branch_access || [])].filter(Boolean))];
      state = {
        status: u.status,
        locked: Boolean(u.locked_at) && (!u.locked_until || new Date(u.locked_until) > new Date()),
        role: u.role,
        roleCode: u.role_code || u.role,
        userType,
        branchId: u.branch_id,
        branches,
        officer: userType === 'CREDIT_OFFICER' && !u.other_officers_clients ? String(u.email).toLowerCase() : null,
        consoleAccess: row ? row.console_access !== false : true,
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

// Session activity, for the inactivity timeout: the last request of each
// signed-in session, written at most once a minute per session.
const seen = new Map();
function touchSession(sid) {
  if (!sid) return;
  const last = seen.get(sid) || 0;
  if (Date.now() - last < 60_000) return;
  seen.set(sid, Date.now());
  if (seen.size > 50_000) seen.clear();
  pool.query('UPDATE platform.refresh_tokens SET last_seen_at = now() WHERE family_id = $1 AND revoked_at IS NULL AND used_at IS NULL', [sid])
    .catch(() => {});
}

/** The API key on a request (the reference platform's apiKey header), as the principal it stands for. */
async function apiKeyPrincipal(req) {
  const key = req.get('apikey');
  if (!key || !req.tenant) return null;
  const out = await apiKeys.authenticate(req.tenant, key, req.ip);
  const row = out.consumer.role_code ? await roleRow(req.tenant.schema_name, out.consumer.role_code) : null;
  if (out.consumer.role_code && (!row || row.api_access === false)) {
    throw new TenantError(`API_ACCESS_NOT_ALLOWED: role ${out.consumer.role_code} has no API access`, 403);
  }
  const admin = out.consumer.administrator || (row && row.base_role === 'TENANT_ADMIN');
  const held = admin ? PERMS.CATALOG.map((p) => p.code) : [...new Set([...(row ? row.permissions : []), ...(out.consumer.permissions || [])])];
  return {
    sub: out.consumer.id, email: `api:${out.consumer.name}`, name: out.consumer.name, tid: req.tenant.slug,
    role: admin ? 'TENANT_ADMIN' : (row ? row.base_role : 'API_CONSUMER'), roleCode: row ? row.code : null,
    userType: admin ? 'ADMINISTRATOR' : null, permissions: new Set(held), branches: null, officer: null,
    apiConsumer: true, consumerId: out.consumer.id, keyId: out.keyId,
  };
}

/**
 * Require a signed-in user. `roles` is honoured only for PLATFORM_ADMIN (the
 * control plane) and MEMBER (the portal): what a tenant's staff may do is
 * decided by permissions (requirePermission, and the route table in
 * lib/routePermissions), not by the built-in role.
 */
function requireAuth(...roles) {
  return async (req, res, next) => {
    try {
      if (!req.auth && req.get('apikey') && !roles.includes('PLATFORM_ADMIN') && !roles.includes('MEMBER')) {
        req.auth = await apiKeyPrincipal(req);
      }
    } catch (e) { return next(e); }
    if (!req.auth) return next(new TenantError('authentication required', 401));
    // A scoped token (mfa_enrolment, password_change, reauth) is not a session.
    if (req.auth.scope) {
      return next(new TenantError(`token is scoped to ${req.auth.scope} and cannot be used here`, 403));
    }
    if (roles.includes('PLATFORM_ADMIN')) {
      if (req.auth.role !== 'PLATFORM_ADMIN') return next(new TenantError(`role ${req.auth.role} is not permitted here`, 403));
      return next();
    }
    if (req.tenant && req.auth.tid !== req.tenant.slug) {
      return next(new TenantError('token tenant mismatch', 403));
    }
    // A member token never satisfies a staff route. Members reach the portal
    // through requireMember and nothing else.
    if (req.auth.role === 'MEMBER' && !roles.includes('MEMBER')) {
      return next(new TenantError('member tokens cannot use staff endpoints', 403));
    }
    if (req.auth.role === 'MEMBER') return next();
    if (!req.tenant) return next(new TenantError('tenant not specified', 400));
    let state;
    try {
      state = req.auth.apiConsumer ? req.auth : await userState(req.auth.sub, req.tenant.schema_name, req.tenant.id);
    } catch (e) { return next(e); }
    if (state === null) return next(new TenantError('USER_NOT_FOUND', 401));
    if (!req.auth.apiConsumer) {
      if (state.status !== 'ACTIVE') return next(new TenantError(`USER_${state.status}`, 401));
      if (state.locked) return next(new TenantError('USER_LOCKED', 401));
      if (!state.consoleAccess) return next(new TenantError('ROLE_HAS_NO_BACK_OFFICE_ACCESS', 403));
      // The role as it stands, not as the token was issued with.
      req.auth.role = state.role;
      req.auth.permissions = state.permissions;
      req.auth.roleCode = state.roleCode;
      req.auth.userType = state.userType;
      req.auth.branchId = state.branchId;
      req.auth.branches = state.branches;
      req.auth.officer = state.officer;
    }
    try {
      const prefs = await AP.of(req.tenant.id);
      if (!AP.allowlistPasses(prefs, req.ip, { admin: req.auth.role === 'TENANT_ADMIN', api: Boolean(req.auth.apiConsumer) })) {
        return next(new TenantError('IP_ADDRESS_NOT_ALLOWED', 403));
      }
    } catch (e) { return next(e); }
    touchSession(req.auth.sid);
    // The rest of the request knows who it serves (lib/requestContext).
    const limited = req.auth.branches ? (req.auth.branches.length ? req.auth.branches.join(',') : 'none') : '';
    return requestContext.run({
      userId: req.auth.sub, email: req.auth.email, role: req.auth.role,
      tillRequired: !PERMS.can(req.auth, 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL'),
      tillAdd: PERMS.can(req.auth, 'ADD_CASH'), tillRemove: PERMS.can(req.auth, 'REMOVE_CASH'),
      branches: limited, officer: req.auth.officer || '',
      ip: req.ip || '', channel: req.auth.apiConsumer || req.get('apikey') ? 'API' : 'UI',
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

/**
 * The route table (lib/routePermissions) applied to every tenant API request
 * before its route: the permission it needs, administrators only, any staff,
 * or none (sign-in, the portal). A route the table does not list is refused
 * to all but administrators. A user limited to some branches may not run
 * what works on the whole organization. With re-authentication on, a
 * critical action needs a fresh password (POST /auth/reauth).
 */
function permissionGate() {
  const auth = requireAuth();
  return (req, res, next) => {
    const t = RP.ruleFor(req.method, req.path);
    if (t && t.rule === RP.NONE) return next();
    return auth(req, res, async (e) => {
      if (e) return next(e);
      try {
        const rule = t ? t.rule : RP.ADMIN;
        const u = req.auth;
        if (rule === RP.ADMIN) {
          if (u.role !== 'TENANT_ADMIN') throw new TenantError(t ? 'ADMINISTRATOR_ONLY' : `ADMINISTRATOR_ONLY: ${req.method} ${req.path} has no permission rule`, 403);
        } else if (rule !== RP.OPEN) {
          const need = typeof rule === 'string' ? [rule] : Array.isArray(rule) ? rule : rule.all;
          const ok = rule.all ? need.every((c) => PERMS.can(u, c)) : need.some((c) => PERMS.can(u, c));
          if (!ok) throw new TenantError(`PERMISSION_REQUIRED: ${need.join(rule.all ? ' and ' : ' or ')}`, 403);
          if (u.branches && need.some((c) => RP.ORG_WIDE.has(c))) throw new TenantError('ALL_BRANCH_ACCESS_REQUIRED: this works on the whole organization', 403);
        }
        if (!u.apiConsumer && RP.isCritical(req.method, req.path)) {
          const prefs = await AP.of(req.tenant.id);
          if (prefs.reauthenticate) {
            const tok = req.get('x-reauth-token');
            let ok = false;
            if (tok) {
              try {
                const p = jwt.verify(tok, signingKey, { algorithms: ['HS256'] });
                ok = p.scope === 'reauth' && p.sub === u.sub && p.tid === req.tenant.slug;
              } catch { ok = false; }
            }
            if (!ok) throw new TenantError('REAUTHENTICATION_REQUIRED: enter your password again (POST /api/auth/reauth)', 403);
          }
        }
        return next();
      } catch (err) { return next(err); }
    });
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

module.exports = { userState, resolveTenant, requireAuth, requirePermission, permissionGate, requireMember, signToken, tenantFromRequest, lookupTenant, invalidate, forgetUser, signingKey };
