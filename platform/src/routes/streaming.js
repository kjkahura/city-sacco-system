'use strict';

const express = require('express');
const H = require('../lib/handlers');
const { err } = require('../lib/errors');
const { requireAuth } = require('../tenancy/resolve');
const { withTenant } = require('../db/tenantContext');
const STR = require('../domain/streaming');
const { acquire } = require('../lib/limits');
const PERMS = require('../lib/permissions');

/**
 * Events streaming, after the reference platform's Streaming API
 * (docs/audits/audit-events-streaming.md):
 *
 *   POST   /api/v1/subscriptions               create, or return the same subscription (200)
 *   GET    /api/v1/subscriptions               the subscriptions (for the console)
 *   GET    /api/v1/subscriptions/:id/events    the stream: newline-separated JSON batches
 *   POST   /api/v1/subscriptions/:id/cursors   commit cursors (header X-Stream-Id)
 *   GET    /api/v1/subscriptions/:id/stats     unconsumed events and lag per topic
 *   DELETE /api/v1/subscriptions/:id
 *
 * The permission (CONSUME_EVENT_STREAMS) is in lib/routePermissions.
 *
 * A stream is read from the database every TICK_MS. It ends at
 * stream_timeout (capped by STREAM_MAX_SECONDS, 55 by default, so it fits
 * the hosting's 60-second request limit), at stream_limit events, after
 * stream_keep_alive_limit keep-alives in a row, when a sent batch is not
 * committed within commit_timeout, or when the client goes away. The client
 * reconnects and reads on from its committed cursor.
 */

const TICK_MS = 250;
const HEARTBEAT_MS = 1000;
const maxSeconds = () => Math.max(1, Number(process.env.STREAM_MAX_SECONDS) || 55);

function intParam(q, name, { def, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (q[name] === undefined || q[name] === '') return def;
  const n = Number(q[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw err(`INVALID_PARAMETER: ${name} must be a whole number from ${min} to ${max}`, 422);
  return n;
}

function streamParams(q) {
  const cap = maxSeconds();
  return {
    batchLimit: intParam(q, 'batch_limit', { def: 1, min: 1, max: 1000 }),
    streamLimit: intParam(q, 'stream_limit', { def: 0 }),
    flushSeconds: intParam(q, 'batch_flush_timeout', { def: 30, min: 1, max: 4200 }),
    // Asked-for timeouts beyond the cap are shortened, not refused: clients written for longer streams still work.
    timeoutSeconds: Math.min(intParam(q, 'stream_timeout', { def: cap, min: 0, max: 4200 }) || cap, cap),
    maxUncommitted: intParam(q, 'max_uncommitted_events', { def: 10, min: 1, max: 1000 }),
    keepAliveLimit: intParam(q, 'stream_keep_alive_limit', { def: 0 }),
    commitSeconds: intParam(q, 'commit_timeout', { def: 60, min: 1, max: 60 }),
  };
}

const router = express.Router();

// Whose subscriptions a caller reaches: its own, or every one for an administrator (../domain/streaming).
const whoOf = (req) => ({ owner: String(req.auth?.sub ?? req.auth?.email ?? ''), admin: req.auth?.role === 'TENANT_ADMIN' });

router.post('/', ...H.run(async (c, req, res, { actor }) => {
  const { subscription, created } = await STR.create(c, req.body, { actor, who: whoOf(req) });
  res.status(created ? 201 : 200);
  return subscription;
}, { write: true, keepStatus: true }));

// Staff who see the streaming templates see every subscription (Administration > Events Streaming).
const seesAll = (req) => ['CREATE_COMMUNICATION_TEMPLATES', 'EDIT_COMMUNICATION_TEMPLATES', 'MANAGE_GENERAL_SETUP'].some((p) => PERMS.can(req.auth, p));
router.get('/', ...H.run((c, req) => STR.list(c, { who: seesAll(req) ? null : whoOf(req) })));

router.get('/:id/stats', ...H.run((c, req) => STR.stats(c, req.params.id, { showTimeLag: String(req.query.show_time_lag) === 'true', who: whoOf(req) })));

router.post('/:id/cursors', ...H.run(async (c, req, res) => {
  const results = await STR.commit(c, req.params.id, String(req.get('x-stream-id') || ''), req.body?.items, whoOf(req));
  if (results.every((x) => x.result === 'committed')) { res.status(204).end(); return undefined; }
  return { items: results };
}, { write: true }));

router.delete('/:id', ...H.run(async (c, req, res, { actor }) => {
  await STR.remove(c, req.params.id, { actor, who: whoOf(req) });
  res.status(204).end();
}, { write: true }));

router.get('/:id/events', requireAuth(), async (req, res, next) => {
  const schema = req.tenant.schema_name;
  let p, opened;
  try {
    p = streamParams(req.query);
    opened = await withTenant(schema, (c) => STR.openSession(c, req.params.id, whoOf(req)));
  } catch (e) { return next(e); }
  if (!opened) return next(err('SUBSCRIPTION_BUSY: another stream is reading this subscription; retry after it ends', 409));

  const subId = opened.subscription.id;
  const { streamId } = opened;
  const topics = opened.subscription.event_types;
  // A stream should not hold one of the tenant's request slots (lib/limits) for its whole life;
  // it takes one for each read of the database instead.
  if (typeof req.releaseGate === 'function') req.releaseGate();
  const slot = () => acquire(req.tenant.slug, req.tenant.max_concurrent_queries || 6, 10_000);

  res.status(200);
  res.set({ 'content-type': 'application/x-json-stream', 'x-stream-id': streamId, 'cache-control': 'no-store' });
  res.flushHeaders();

  let gone = false;
  req.on('close', () => { gone = true; });
  res.on('close', () => { gone = true; });

  const start = Date.now();
  const delivered = {};
  // Batches sent and not yet committed, oldest first: { topic, offset, at }.
  let waiting = [];
  let sent = 0;
  let keepAlives = 0;
  let lastWrite = Date.now();
  let lastBeat = 0;
  // A client that does not read is not written to faster than it reads.
  const write = async (batch) => {
    lastWrite = Date.now();
    if (res.write(`${JSON.stringify(batch)}\n`)) return;
    await new Promise((ok) => { res.once('drain', ok); res.once('close', ok); });
  };

  try {
    while (!gone) {
      if (Date.now() - start >= p.timeoutSeconds * 1000) break;
      const rel = await slot();
      let step;
      try {
        step = await withTenant(schema, async (c) => {
          if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            const { rowCount } = await c.query(
              'UPDATE stream_sessions SET last_seen_at = now() WHERE subscription_id = $1 AND stream_id = $2 AND open', [subId, streamId]);
            // Another stream took the subscription over (this one was not heard from): stop.
            if (!rowCount) return { end: true };
            lastBeat = Date.now();
          }
          const cursors = await STR.committed(c, subId);
          // The commit timeout runs from each batch's sending until it is committed.
          waiting = waiting.filter((w) => w.offset > (cursors[w.topic] ?? 0));
          if (waiting.length && Date.now() - waiting[0].at >= p.commitSeconds * 1000) return { end: true };
          const pending = await STR.uncommitted(c, cursors, delivered);
          let room = p.maxUncommitted - pending;
          if (p.streamLimit) room = Math.min(room, p.streamLimit - sent);
          if (room <= 0) return { cursors };
          return { cursors, batch: await STR.nextBatch(c, cursors, delivered, Math.min(p.batchLimit, room)) };
        });
      } finally { rel(); }
      if (step.end || gone) break;
      if (step.batch) {
        const { topic, rows } = step.batch;
        const last = Number(rows[rows.length - 1].id);
        delivered[topic] = last;
        sent += rows.length;
        keepAlives = 0;
        waiting.push({ topic, offset: last, at: Date.now() });
        await write(STR.batchOf(subId, streamId, topic, last, rows));
        if (p.streamLimit && sent >= p.streamLimit) break;
        continue;
      }
      if (Date.now() - lastWrite >= p.flushSeconds * 1000) {
        if (p.keepAliveLimit && keepAlives >= p.keepAliveLimit) break;
        const topic = topics[0];
        keepAlives++;
        await write(STR.batchOf(subId, streamId, topic, Math.max(step.cursors?.[topic] || 0, delivered[topic] || 0)));
      }
      await new Promise((ok) => setTimeout(ok, TICK_MS));
    }
  } catch (e) {
    console.error(`[stream ${streamId}] ${e.message}`);
  } finally {
    try { await withTenant(schema, (c) => STR.closeSession(c, subId, streamId)); } catch (e) { console.error(`[stream ${streamId}] close: ${e.message}`); }
    if (!res.writableEnded) res.end();
  }
  return undefined;
});

module.exports = { router, streamParams };
