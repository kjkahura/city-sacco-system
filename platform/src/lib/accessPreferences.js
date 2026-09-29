'use strict';

const { pool } = require('../db/pool');

/**
 * Access preferences (the reference platform's Administration > Access > Preferences): the
 * rules for how every user of one tenant signs in and stays signed in.
 * Stored as one document on platform.tenants; what is not set takes the
 * default. MANAGE_ACCESS_PREFERENCES changes them (routes/access).
 *
 *   sessionTimeoutMinutes  sign out after this long without a request
 *   password               minLength, minDigits, minUppercase, minSpecial,
 *                          history (previous passwords refused), expiryDays
 *   lockout                maxFailedLogins (3 to 6), lockMinutes (null: until
 *                          an administrator unlocks)
 *   ipAllowlist            enabled, entries, applyTo (ADMINS, USERS, API)
 *   reauthenticate         ask for the password again on critical actions
 *   apiKeys                rotationGraceSeconds, rotatedKeyExpirySeconds
 *   auditRetentionDays     how long the audit trail keeps requests
 *   requireUserAgent       refuse a request without a User-Agent header (the reference platform's
 *                          audit trail rule); off by default
 *   mfaRequiredRoles       roles that must use a second factor (a column of
 *                          its own, kept there for the sign-in path)
 */

const DEFAULTS = {
  sessionTimeoutMinutes: 30,
  password: { minLength: 12, minDigits: 1, minUppercase: 0, minSpecial: 0, history: 4, expiryDays: null },
  lockout: { maxFailedLogins: 5, lockMinutes: 60 },
  ipAllowlist: { enabled: false, entries: [], applyTo: ['ADMINS', 'USERS', 'API'] },
  reauthenticate: false,
  apiKeys: { rotationGraceSeconds: 1800, rotatedKeyExpirySeconds: null },
  auditRetentionDays: 365,
  requireUserAgent: false,
};

const err = (m, status = 400) => Object.assign(new Error(m), { status });
const cache = new Map();
const TTL_MS = 10_000;

function merge(stored = {}) {
  return {
    sessionTimeoutMinutes: stored.sessionTimeoutMinutes ?? DEFAULTS.sessionTimeoutMinutes,
    password: { ...DEFAULTS.password, ...(stored.password || {}) },
    lockout: { ...DEFAULTS.lockout, ...(stored.lockout || {}) },
    ipAllowlist: { ...DEFAULTS.ipAllowlist, ...(stored.ipAllowlist || {}) },
    reauthenticate: stored.reauthenticate ?? DEFAULTS.reauthenticate,
    apiKeys: { ...DEFAULTS.apiKeys, ...(stored.apiKeys || {}) },
    auditRetentionDays: stored.auditRetentionDays ?? DEFAULTS.auditRetentionDays,
    requireUserAgent: stored.requireUserAgent ?? DEFAULTS.requireUserAgent,
  };
}

/** A tenant's preferences (by id), cached for ten seconds. */
async function of(tenantId) {
  if (!tenantId) return merge();
  const hit = cache.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit.prefs;
  const { rows: [t] } = await pool.query('SELECT access_preferences, mfa_required_roles FROM platform.tenants WHERE id = $1', [tenantId]);
  const prefs = { ...merge(t?.access_preferences || {}), mfaRequiredRoles: t?.mfa_required_roles || [] };
  cache.set(tenantId, { prefs, expires: Date.now() + TTL_MS });
  return prefs;
}

const forget = (tenantId) => (tenantId ? cache.delete(tenantId) : cache.clear());

// --- IP addresses --------------------------------------------------------------

/** An IPv4 address as a number, or null (IPv6 is not supported, as in the reference platform). */
function ipNum(ip) {
  let s = String(ip || '').trim();
  if (s === '::1') s = '127.0.0.1';
  if (s.startsWith('::ffff:')) s = s.slice(7);
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * One allowlist entry as a range [from, to]: a static address, a wildcard
 * (192.168.0.*), a byte range in the last place (192.168.0.1-25) or CIDR
 * (192.168.0.0/24). Null when the entry is not one of those.
 */
function rangeOf(entry) {
  const e = String(entry || '').trim();
  let m = e.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/);
  if (m) {
    const a = ipNum(`${m[1]}.${m[2]}`); const b = ipNum(`${m[1]}.${m[3]}`);
    return a !== null && b !== null && a <= b ? [a, b] : null;
  }
  m = e.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (m) {
    const base = ipNum(m[1]); const bits = Number(m[2]);
    if (base === null || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const lo = (base & mask) >>> 0;
    return [lo, (lo + (2 ** (32 - bits)) - 1) >>> 0];
  }
  if (e.includes('*')) {
    const parts = e.split('.');
    if (parts.length !== 4 || !parts.every((p) => p === '*' || /^\d{1,3}$/.test(p))) return null;
    const lo = ipNum(parts.map((p) => (p === '*' ? '0' : p)).join('.'));
    const hi = ipNum(parts.map((p) => (p === '*' ? '255' : p)).join('.'));
    return lo !== null && hi !== null ? [lo, hi] : null;
  }
  const n = ipNum(e);
  return n === null ? null : [n, n];
}

function ipAllowed(list, ip) {
  const n = ipNum(ip);
  if (n === null) return false;
  return list.some((e) => { const r = rangeOf(e); return r && n >= r[0] && n <= r[1]; });
}

/**
 * Whether the allowlist lets a caller in: `kind` is 'ADMIN', 'USER' (the back
 * office) or 'API' (an API key). An API key of an administrator consumer is
 * held to both the API and the administrator lists, as in the reference platform.
 */
function allowlistPasses(prefs, ip, { admin = false, api = false } = {}) {
  const a = prefs.ipAllowlist;
  if (!a.enabled || !a.entries.length) return true;
  const applies = (api && a.applyTo.includes('API')) || (admin && a.applyTo.includes('ADMINS'))
    || (!api && !admin && a.applyTo.includes('USERS'));
  return !applies || ipAllowed(a.entries, ip);
}

// --- passwords ----------------------------------------------------------------------

/** The problems with a new password under the tenant's policy (empty: none). */
function passwordProblems(prefs, password, { email = '' } = {}) {
  const p = prefs.password;
  const s = String(password || '');
  const out = [];
  if (s.length < p.minLength) out.push(`at least ${p.minLength} characters`);
  if (!/[A-Za-z]/.test(s)) out.push('at least one letter');
  if ((s.match(/[0-9]/g) || []).length < Math.max(1, p.minDigits)) out.push(`at least ${Math.max(1, p.minDigits)} digit(s)`);
  if ((s.match(/[A-Z]/g) || []).length < p.minUppercase) out.push(`at least ${p.minUppercase} capital letter(s)`);
  if ((s.match(/[^A-Za-z0-9\s]/g) || []).length < p.minSpecial) out.push(`at least ${p.minSpecial} symbol(s)`);
  const user = String(email).split('@')[0].toLowerCase();
  if (user.length >= 3 && s.toLowerCase().includes(user)) out.push('not the username');
  return out;
}

// --- validation and saving ---------------------------------------------------------------

const int = (v, name, lo, hi, { nullable = false } = {}) => {
  if (v === null && nullable) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw err(`${name}_MUST_BE_A_WHOLE_NUMBER_FROM_${lo}_TO_${hi}${nullable ? '_OR_NULL' : ''}`);
  return n;
};

/** Check a change and return the new stored document. */
function validate(current, body = {}) {
  const next = merge(current);
  if (body.sessionTimeoutMinutes !== undefined) next.sessionTimeoutMinutes = int(body.sessionTimeoutMinutes, 'SESSION_TIMEOUT_MINUTES', 5, 1440);
  if (body.password) {
    const b = body.password;
    if (b.minLength !== undefined) next.password.minLength = int(b.minLength, 'MIN_LENGTH', 8, 128);
    if (b.minDigits !== undefined) next.password.minDigits = int(b.minDigits, 'MIN_DIGITS', 1, 64);
    if (b.minUppercase !== undefined) next.password.minUppercase = int(b.minUppercase, 'MIN_UPPERCASE', 0, 64);
    if (b.minSpecial !== undefined) next.password.minSpecial = int(b.minSpecial, 'MIN_SPECIAL', 0, 64);
    if (b.history !== undefined) next.password.history = int(b.history, 'HISTORY', 1, 10);
    if (b.expiryDays !== undefined) next.password.expiryDays = int(b.expiryDays, 'EXPIRY_DAYS', 1, 3650, { nullable: true });
    const p = next.password;
    if (p.minDigits + p.minUppercase + p.minSpecial > p.minLength) throw err('CHARACTER_COUNTS_EXCEED_THE_MINIMUM_LENGTH');
  }
  if (body.lockout) {
    if (body.lockout.maxFailedLogins !== undefined) next.lockout.maxFailedLogins = int(body.lockout.maxFailedLogins, 'MAX_FAILED_LOGINS', 3, 6);
    if (body.lockout.lockMinutes !== undefined) next.lockout.lockMinutes = int(body.lockout.lockMinutes, 'LOCK_MINUTES', 15, 10080, { nullable: true });
  }
  if (body.ipAllowlist) {
    const a = body.ipAllowlist;
    if (a.enabled !== undefined) next.ipAllowlist.enabled = Boolean(a.enabled);
    if (a.entries !== undefined) {
      if (!Array.isArray(a.entries)) throw err('IP_ENTRIES_MUST_BE_A_LIST');
      const bad = a.entries.filter((e) => !rangeOf(e));
      if (bad.length) throw err(`INVALID_IP_ENTRIES: ${bad.join(', ')} (IPv4, a wildcard, a range in the last place, or CIDR)`);
      next.ipAllowlist.entries = [...new Set(a.entries.map((e) => String(e).trim()))];
    }
    if (a.applyTo !== undefined) {
      const ok = ['ADMINS', 'USERS', 'API'];
      if (!Array.isArray(a.applyTo) || !a.applyTo.length || a.applyTo.some((x) => !ok.includes(x))) throw err('APPLY_TO_IS_ONE_OR_MORE_OF: ADMINS, USERS, API');
      next.ipAllowlist.applyTo = [...new Set(a.applyTo)];
    }
  }
  if (body.reauthenticate !== undefined) next.reauthenticate = Boolean(body.reauthenticate);
  if (body.apiKeys) {
    if (body.apiKeys.rotationGraceSeconds !== undefined) next.apiKeys.rotationGraceSeconds = int(body.apiKeys.rotationGraceSeconds, 'ROTATION_GRACE_SECONDS', 0, 604800);
    if (body.apiKeys.rotatedKeyExpirySeconds !== undefined) {
      next.apiKeys.rotatedKeyExpirySeconds = int(body.apiKeys.rotatedKeyExpirySeconds, 'ROTATED_KEY_EXPIRY_SECONDS', 300, 31536000 * 5, { nullable: true });
    }
  }
  if (body.auditRetentionDays !== undefined) next.auditRetentionDays = int(body.auditRetentionDays, 'AUDIT_RETENTION_DAYS', 30, 3650);
  if (body.requireUserAgent !== undefined) {
    if (typeof body.requireUserAgent !== 'boolean') throw err('REQUIRE_USER_AGENT_IS_TRUE_OR_FALSE');
    next.requireUserAgent = body.requireUserAgent;
  }
  return next;
}

async function save(tenantId, doc, mfaRequiredRoles) {
  await pool.query(
    `UPDATE platform.tenants SET access_preferences = $2, mfa_required_roles = COALESCE($3::text[], mfa_required_roles) WHERE id = $1`,
    [tenantId, JSON.stringify(doc), mfaRequiredRoles || null]);
  forget(tenantId);
  return of(tenantId);
}

module.exports = { DEFAULTS, of, forget, validate, save, passwordProblems, allowlistPasses, ipAllowed, ipNum, rangeOf, merge };
