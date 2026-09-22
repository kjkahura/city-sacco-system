'use strict';

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
// Staff sign in with an email, members with a phone, activation with a
// member number. Whichever the body carries is the account key.
const accountKey = (req) => String(
  req.body?.memberNo || req.body?.email || req.body?.phone || '').toLowerCase().replace(/\s+/g, '');

function loginRateLimit({ perIp = 20, perAccount = 8, windowMs = 900_000 } = {}) {
  return async (req, res, next) => {
    try {
      const email = accountKey(req);
      const tenant = req.tenant?.slug || 'unknown';
      const [byIp, byAccount] = await Promise.all([
        store.incr(windowKey('login:ip', req.ip, windowMs), windowMs),
        store.incr(windowKey('login:acct', `${tenant}:${email}`, windowMs), windowMs),
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
async function clearLoginAttempts(req, { windowMs = 900_000 } = {}) {
  const email = accountKey(req);
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
    next();
  };
}

const stats = () => ({
  rateStore: store.health(),
  gates: [...gates].map(([slug, g]) => ({ slug, size: g.size, active: g.active, queued: g.queue.length })),
});

module.exports = { rateLimit, loginRateLimit, clearLoginAttempts, tenantConcurrency, acquire, stats, store };
