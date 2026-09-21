'use strict';

/**
 * Rate-limit counter store.
 *
 * Redis when REDIS_URL is set, in-process otherwise. The interface is the
 * same either way so nothing downstream cares, and a single-node deployment
 * needs no extra infrastructure.
 *
 * If Redis is configured but unreachable, requests are allowed rather than
 * blocked. That is a deliberate choice: a rate limiter is a guard rail, and
 * failing closed would turn a Redis blip into a total outage for every
 * SACCO. The degradation is logged and surfaced on /health.
 */

let client = null;
let ready = false;
let lastError = null;
let degradedSince = null;

const local = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of local) if (v.expires < now) local.delete(k);
}, 60_000).unref();

async function connect({ url = process.env.REDIS_URL, log = console.warn } = {}) {
  if (!url) return { backend: 'memory' };
  const { createClient } = require('redis');
  client = createClient({ url, socket: { reconnectStrategy: (n) => Math.min(n * 200, 5000) } });
  client.on('error', (e) => {
    if (ready || !degradedSince) {
      lastError = e.message;
      degradedSince = degradedSince || Date.now();
      log(`[ratestore] redis degraded, failing open: ${e.message}`);
    }
    ready = false;
  });
  client.on('ready', () => {
    if (degradedSince) log('[ratestore] redis recovered');
    ready = true; degradedSince = null; lastError = null;
  });
  try {
    await client.connect();
    ready = true;
    return { backend: 'redis', url: url.replace(/:[^:@/]*@/, ':***@') };
  } catch (e) {
    lastError = e.message;
    degradedSince = Date.now();
    log(`[ratestore] redis unavailable at startup, using memory: ${e.message}`);
    return { backend: 'memory', error: e.message };
  }
}

async function disconnect() {
  if (client) { try { await client.quit(); } catch {} client = null; ready = false; }
}

/**
 * Increment a fixed window and return the count.
 *
 * INCR plus a conditional PEXPIRE is atomic enough here: the INCR creates
 * the key, and the expiry is only set on the first hit, so the window
 * starts when the first request in it arrives.
 */
async function incr(key, windowMs) {
  if (client && ready) {
    try {
      const multi = client.multi();
      multi.incr(key);
      multi.pTTL(key);
      const [count, ttl] = await multi.exec();
      if (ttl < 0) await client.pExpire(key, windowMs);
      return { count: Number(count), resetMs: ttl > 0 ? Number(ttl) : windowMs, backend: 'redis' };
    } catch (e) {
      lastError = e.message;
      degradedSince = degradedSince || Date.now();
      // Fall through to memory rather than rejecting the request.
    }
  }

  const now = Date.now();
  let b = local.get(key);
  if (!b || b.expires <= now) { b = { count: 0, expires: now + windowMs }; local.set(key, b); }
  b.count += 1;
  return { count: b.count, resetMs: b.expires - now, backend: 'memory' };
}

async function reset(key) {
  local.delete(key);
  if (client && ready) { try { await client.del(key); } catch {} }
}

const health = () => ({
  backend: client ? (ready ? 'redis' : 'redis-degraded') : 'memory',
  degradedSince: degradedSince ? new Date(degradedSince).toISOString() : null,
  lastError,
  localKeys: local.size,
});

module.exports = { connect, disconnect, incr, reset, health };
