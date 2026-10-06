'use strict';

const crypto = require('crypto');
const { apiError } = require('./http');
const store = require('./ratestore');

/**
 * Rate limiting and per-tenant concurrency.
 *
 * Rate counters go through ratestore, which is Redis-backed when REDIS_URL
 * is set and in-process otherwise. With Redis the limit is fleet-wide;
 * without it, it is per-node and the effective limit is N times looser.
 *
 * Concurrency gates are deliberately still per-process. They protect this
 * node's connection pool, which is a local resource, so a local counter is
 * the correct scope rather than a limitation.
 */

// --------------------------------------------------------------------------
// Rate limiting
// --------------------------------------------------------------------------

function windowKey(prefix, id, windowMs) {
  // Bucketing the key by window start keeps Redis keys self-expiring and
  // makes the window behave the same on both backends.
  return `rl:${prefix}:${id}:${Math.floor(Date.now() / windowMs)}`;
}

/** General API limiter, keyed by tenant plus caller. */
function rateLimit({ limit = 600, windowMs = 60_000, keyFn } = {}) {
  return async (req, res, next) => {
    try {
      const max = req.tenant?.rate_limit_per_min || limit;
      const id = keyFn ? keyFn(req) : `${req.tenant?.slug || 'anon'}:${req.auth?.sub || req.ip}`;
      const r = await store.incr(windowKey('api', id, windowMs), windowMs);
      res.set('x-ratelimit-limit', String(max));
      res.set('x-ratelimit-remaining', String(Math.max(0, max - r.count)));
      if (r.count > max) {
        res.set('retry-after', String(Math.ceil(r.resetMs / 1000)));
        return apiError(res, 429, 429, 'RATE_LIMIT_EXCEEDED');
      }
      next();
    } catch (e) { next(e); }
  };
}

/**
 * Login limiter. Keyed on the account as well as the IP, so spraying one
 * password across many accounts from one address is caught, and so is
 * hammering one account from many addresses.
 */
// Each route says what its account is: the staff email, the member's phone or
// number, a hash of the refresh token or MFA ticket, the signed-in user. A
// request that names no account is limited by its address only, never put in
// one shared bucket (which anyone could fill to lock a whole SACCO out).
const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, '');
const hashed = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 32) : '');
const KEYS = {
  email: (req) => norm(req.body?.email),
  phone: (req) => norm(req.body?.phone),
  memberNo: (req) => norm(req.body?.memberNo),
  refreshToken: (req) => hashed(req.body?.refreshToken),
  mfaTicket: (req) => hashed(req.body?.mfaTicket),
  user: (req) => norm(req.auth?.sub),
};

function loginRateLimit({ perIp = 20, perAccount = 8, windowMs = 900_000, key = 'email' } = {}) {
  const keyOf = typeof key === 'function' ? key : KEYS[key];
  return async (req, res, next) => {
    try {
      const account = keyOf(req);
      const tenant = req.tenant?.slug || 'unknown';
      const [byIp, byAccount] = await Promise.all([
        store.incr(windowKey('login:ip', req.ip, windowMs), windowMs),
        account ? store.incr(windowKey('login:acct', `${tenant}:${account}`, windowMs), windowMs) : { count: 0, resetMs: 0 },
      ]);
      if (byIp.count > perIp || byAccount.count > perAccount) {
        res.set('retry-after', String(Math.ceil(Math.max(byIp.resetMs, byAccount.resetMs) / 1000)));
        return apiError(res, 429, 429, 'TOO_MANY_LOGIN_ATTEMPTS');
      }
      next();
    } catch (e) { next(e); }
  };
}

/** Clear the account counter after a success, so one fat-fingered password
 *  does not count against the user for the next fifteen minutes. */
async function clearLoginAttempts(req, { windowMs = 900_000, key = 'email' } = {}) {
  const email = (typeof key === 'function' ? key : KEYS[key])(req);
  if (!email) return;
  const tenant = req.tenant?.slug || 'unknown';
  await store.reset(windowKey('login:acct', `${tenant}:${email}`, windowMs));
}

// --------------------------------------------------------------------------
// Per-tenant concurrency
// --------------------------------------------------------------------------

/**
 * A counting semaphore per tenant, sized from tenants.max_concurrent_queries.
 *
 * Without this, one SACCO running a heavy report can hold every connection
 * in the shared pool and every other tenant sees timeouts.
 */
const gates = new Map();

function gateFor(slug, size) {
  let g = gates.get(slug);
  if (!g) { g = { size, active: 0, queue: [] }; gates.set(slug, g); }
  g.size = size;          // pick up limit changes without a restart
  return g;
}

function acquire(slug, size, timeoutMs = 10_000) {
  const g = gateFor(slug, size);
  if (g.active < g.size) { g.active += 1; return Promise.resolve(() => release(g)); }
  // A bounded wait list: past four times the slots, a request is refused at once rather than parked.
  if (g.queue.length >= g.size * 4) return Promise.reject(Object.assign(new Error('TENANT_BUSY: too many requests waiting'), { status: 503 }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = g.queue.indexOf(entry);
      if (i !== -1) g.queue.splice(i, 1);
      reject(Object.assign(new Error('TENANT_CONCURRENCY_LIMIT_TIMEOUT'), { status: 503 }));
    }, timeoutMs);
    const entry = { resolve, timer };
    g.queue.push(entry);
  });
}

function release(g) {
  const next = g.queue.shift();
  if (next) { clearTimeout(next.timer); next.resolve(() => release(g)); }
  else g.active = Math.max(0, g.active - 1);
}

function tenantConcurrency({ timeoutMs = 10_000 } = {}) {
  return async (req, res, next) => {
    if (!req.tenant) return next();
    let rel;
    try {
      rel = await acquire(req.tenant.slug, req.tenant.max_concurrent_queries || 6, timeoutMs);
    } catch (e) {
      return apiError(res, 503, 503, e.message);
    }
    let released = false;
    const done = () => { if (!released) { released = true; rel(); } };
    res.on('finish', done);
    res.on('close', done);
    // A long-lived answer (an event stream) gives its slot back once it starts waiting.
    req.releaseGate = done;
    next();
  };
}

const stats = () => ({
  rateStore: store.health(),
  gates: [...gates].map(([slug, g]) => ({ slug, size: g.size, active: g.active, queued: g.queue.length })),
});

module.exports = { rateLimit, loginRateLimit, clearLoginAttempts, tenantConcurrency, acquire, stats, store };
