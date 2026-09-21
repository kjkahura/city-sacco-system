'use strict';

const { apiError } = require('./http');

/**
 * Rate limiting and per-tenant concurrency.
 *
 * Both are in-process. On one node that is exactly right; across several you
 * want Redis, and the counters here become per-node. Said plainly rather
 * than pretended otherwise: with N nodes the effective limit is N times the
 * configured one.
 */

// --------------------------------------------------------------------------
// Sliding-window rate limiter
// --------------------------------------------------------------------------

const buckets = new Map();

function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  return { allowed: b.count <= limit, count: b.count, resetMs: b.start + windowMs - now };
}

// Bounded cleanup so the map cannot grow without limit under key churn.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 600_000) buckets.delete(k);
}, 60_000).unref();

/** General API limiter, keyed by tenant plus caller. */
function rateLimit({ limit = 600, windowMs = 60_000, keyFn } = {}) {
  return (req, res, next) => {
    const perTenant = req.tenant?.rate_limit_per_min || limit;
    const key = keyFn ? keyFn(req)
      : `${req.tenant?.slug || 'anon'}:${req.auth?.sub || req.ip}`;
    const r = hit(key, perTenant, windowMs);
    res.set('x-ratelimit-limit', String(perTenant));
    res.set('x-ratelimit-remaining', String(Math.max(0, perTenant - r.count)));
    if (!r.allowed) {
      res.set('retry-after', String(Math.ceil(r.resetMs / 1000)));
      return apiError(res, 429, 429, 'RATE_LIMIT_EXCEEDED');
    }
    next();
  };
}

/**
 * Login limiter. Tighter, and keyed on the account as well as the IP so
 * spraying one password across many accounts from one address is caught,
 * and so is hammering one account from many addresses.
 */
function loginRateLimit({ perIp = 20, perAccount = 8, windowMs = 900_000 } = {}) {
  return (req, res, next) => {
    const email = String(req.body?.email || '').toLowerCase();
    const tenant = req.tenant?.slug || 'unknown';
    const byIp = hit(`login:ip:${req.ip}`, perIp, windowMs);
    const byAccount = hit(`login:acct:${tenant}:${email}`, perAccount, windowMs);
    if (!byIp.allowed || !byAccount.allowed) {
      const worst = Math.max(byIp.resetMs, byAccount.resetMs);
      res.set('retry-after', String(Math.ceil(worst / 1000)));
      return apiError(res, 429, 429, 'TOO_MANY_LOGIN_ATTEMPTS');
    }
    next();
  };
}

/** Reset a key after a successful login, so one fat-fingered password
 *  does not count against the user for the next fifteen minutes. */
function clearLoginAttempts(req) {
  const email = String(req.body?.email || '').toLowerCase();
  buckets.delete(`login:acct:${req.tenant?.slug || 'unknown'}:${email}`);
}

// --------------------------------------------------------------------------
// Per-tenant concurrency
// --------------------------------------------------------------------------

/**
 * A counting semaphore per tenant, sized from tenants.max_concurrent_queries.
 *
 * Without this, one SACCO running a heavy report can hold every connection
 * in the shared pool and every other tenant sees timeouts. With it, that
 * SACCO queues against itself and everyone else is unaffected.
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
  if (next) {
    clearTimeout(next.timer);
    next.resolve(() => release(g));
  } else {
    g.active = Math.max(0, g.active - 1);
  }
}

/** Express middleware wrapping the request in the tenant's gate. */
function tenantConcurrency({ timeoutMs = 10_000 } = {}) {
  return async (req, res, next) => {
    if (!req.tenant) return next();
    const size = req.tenant.max_concurrent_queries || 6;
    let rel;
    try {
      rel = await acquire(req.tenant.slug, size, timeoutMs);
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
  rateBuckets: buckets.size,
  gates: [...gates].map(([slug, g]) => ({ slug, size: g.size, active: g.active, queued: g.queue.length })),
});

module.exports = { rateLimit, loginRateLimit, clearLoginAttempts, tenantConcurrency, acquire, stats, hit };
