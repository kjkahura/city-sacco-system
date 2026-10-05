'use strict';

const crypto = require('crypto');
const { err } = require('../lib/errors');
const { recordAudit } = require('../lib/auditLog');
const S = require('./notifications/secrets');

/**
 * Events streaming (the reference platform's Streaming API): subscriptions
 * to topics, streams of batches, cursor commits and statistics. Streaming
 * templates publish to topics (./notifications/dispatch); this is the
 * reading side.
 *
 * A topic has one partition, "0", and a subscription is read by one stream
 * at a time. An offset is the published event's id, zero-padded to 18
 * digits. A cursor token is an HMAC of the subscription, stream, topic and
 * offset, so a commit can only be for what that stream was sent.
 */

const pad = (n) => String(n).padStart(18, '0');
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
const STALE_SECONDS = 10;
const token = (subId, streamId, topic, offset) => S.sign(`${subId}|${streamId}|${topic}|${pad(offset)}`);

function out(s) {
  return {
    id: s.id, owning_application: s.owning_application, event_types: s.event_types, consumer_group: s.consumer_group,
    read_from: s.read_from, created_at: iso(s.created_at), updated_at: iso(s.updated_at),
  };
}

/**
 * A subscription belongs to the API consumer or user that made it (`who`:
 * { owner, admin }). Others get 404, as if it did not exist; administrators
 * reach every one. Without `who` (the console's list, checks) there is no
 * owner check.
 */
const mine = (s, who) => !who || who.admin || s.owner_id === who.owner;

async function row(c, id, who = null) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw err('SUBSCRIPTION_NOT_FOUND', 404);
  const { rows: [s] } = await c.query('SELECT * FROM stream_subscriptions WHERE id = $1', [id]);
  if (!s || !mine(s, who)) throw err('SUBSCRIPTION_NOT_FOUND', 404);
  return s;
}

/** Create a subscription, or return the one with the same application, group and topics. */
async function create(c, b, { actor, who = null }) {
  const app = String(b?.owning_application || '').trim();
  if (!app || app.length > 255) throw err('OWNING_APPLICATION_REQUIRED', 422);
  const group = String(b.consumer_group || 'default').trim() || 'default';
  const types = [...new Set(Array.isArray(b.event_types) ? b.event_types.map(String) : [])].sort();
  if (!types.length) throw err('EVENT_TYPES_REQUIRED', 422);
  if (types.length > 33) throw err('AT_MOST_33_EVENT_TYPES', 422);
  const { rows: known } = await c.query("SELECT topic FROM notification_templates WHERE type = 'EVENT_STREAM' AND topic = ANY($1::text[])", [types]);
  const missing = types.filter((t) => !known.some((k) => k.topic === t));
  if (missing.length) throw err(`UNKNOWN_EVENT_TYPES: ${missing.join(', ')}`, 422);
  const readFrom = String(b.read_from || 'end').toLowerCase();
  if (!['begin', 'end', 'cursors'].includes(readFrom)) throw err('READ_FROM_IS_BEGIN_END_OR_CURSORS', 422);
  const existing = async () => {
    const { rows: [x] } = await c.query(
      'SELECT * FROM stream_subscriptions WHERE owning_application = $1 AND consumer_group = $2 AND event_types = $3::text[]', [app, group, types]);
    if (x && !mine(x, who)) throw err('SUBSCRIPTION_HELD_BY_ANOTHER_CONSUMER: choose another owning_application or consumer_group', 409);
    return x;
  };
  const before = await existing();
  if (before) return { subscription: out(before), created: false };
  // Two identical requests at once: the second finds the first's row instead of failing on the unique key.
  const { rows: [s] } = await c.query(
    `INSERT INTO stream_subscriptions (owning_application, consumer_group, event_types, read_from, created_by, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (owning_application, consumer_group, event_types) DO NOTHING RETURNING *`,
    [app, group, types, readFrom, actor, who?.owner ?? null]);
  if (!s) return { subscription: out(await existing()), created: false };
  const initial = Array.isArray(b.initial_cursors) ? b.initial_cursors : [];
  for (const t of types) {
    let at = 0;
    if (readFrom === 'end') {
      at = Number((await c.query('SELECT COALESCE(max(id), 0) AS n FROM stream_events WHERE topic = $1', [t])).rows[0].n);
    } else if (readFrom === 'cursors') {
      const ic = initial.find((x) => x.event_type === t);
      if (!ic) throw err(`INITIAL_CURSOR_REQUIRED: ${t}`, 422);
      at = Number(ic.offset);
      if (!Number.isSafeInteger(at) || at < 0) throw err(`INVALID_OFFSET: ${ic.offset}`, 422);
    }
    await c.query('INSERT INTO stream_cursors (subscription_id, topic, committed) VALUES ($1, $2, $3)', [s.id, t, at]);
  }
  await recordAudit(c, { actor, action: 'STREAM_SUBSCRIPTION_CREATED', entity: 'stream_subscription', entityId: s.id, after: JSON.stringify(out(s)) });
  return { subscription: out(s), created: true };
}

/** The subscriptions, each with its committed offsets, unread events and whether a stream holds it (for the console). */
async function list(c, { who = null } = {}) {
  const { rows } = await c.query(
    `SELECT s.*, (ss.open AND ss.last_seen_at >= now() - make_interval(secs => $1)) AS live,
            COALESCE((SELECT json_agg(json_build_object('event_type', k.topic, 'offset', k.committed,
                        'unconsumed_events', (SELECT count(*) FROM stream_events e WHERE e.topic = k.topic AND e.id > k.committed)) ORDER BY k.topic)
                      FROM stream_cursors k WHERE k.subscription_id = s.id), '[]') AS cursors
     FROM stream_subscriptions s LEFT JOIN stream_sessions ss ON ss.subscription_id = s.id
     ORDER BY s.created_at DESC`, [STALE_SECONDS]);
  return rows.filter((s) => mine(s, who)).map((s) => ({
    ...out(s),
    state: s.live ? 'assigned' : 'unassigned',
    cursors: s.cursors.map((k) => ({ event_type: k.event_type, offset: pad(k.offset), unconsumed_events: Number(k.unconsumed_events) })),
  }));
}

async function remove(c, id, { actor, who = null }) {
  const s = await row(c, id, who);
  await c.query('DELETE FROM stream_subscriptions WHERE id = $1', [s.id]);
  await recordAudit(c, { actor, action: 'STREAM_SUBSCRIPTION_DELETED', entity: 'stream_subscription', entityId: s.id, before: JSON.stringify(out(s)) });
}

// --- the stream ---------------------------------------------------------------

/** Take the subscription's one slot; null when another stream holds it. */
async function openSession(c, id, who = null) {
  const s = await row(c, id, who);
  const streamId = crypto.randomUUID();
  const { rows: [got] } = await c.query(
    `INSERT INTO stream_sessions (subscription_id, stream_id) VALUES ($1, $2)
     ON CONFLICT (subscription_id) DO UPDATE SET stream_id = EXCLUDED.stream_id, open = true, started_at = now(), last_seen_at = now()
       WHERE NOT stream_sessions.open OR stream_sessions.last_seen_at < now() - make_interval(secs => $3)
     RETURNING stream_id`, [s.id, streamId, STALE_SECONDS]);
  return got ? { subscription: s, streamId } : null;
}

const heartbeat = (c, id, streamId) => c.query('UPDATE stream_sessions SET last_seen_at = now() WHERE subscription_id = $1 AND stream_id = $2', [id, streamId]);
const closeSession = (c, id, streamId) => c.query('UPDATE stream_sessions SET open = false, last_seen_at = now() WHERE subscription_id = $1 AND stream_id = $2', [id, streamId]);

async function committed(c, id) {
  const { rows } = await c.query('SELECT topic, committed FROM stream_cursors WHERE subscription_id = $1 ORDER BY topic', [id]);
  return Object.fromEntries(rows.map((r) => [r.topic, Number(r.committed)]));
}

/** Events sent but not committed, across the subscription's topics (one query). */
async function uncommitted(c, cursors, delivered) {
  const open = Object.entries(cursors).filter(([topic, at]) => (delivered[topic] || 0) > at);
  if (!open.length) return 0;
  const { rows: [r] } = await c.query(
    `SELECT count(*)::int AS n FROM unnest($1::text[], $2::bigint[], $3::bigint[]) AS k(topic, after, upto)
       JOIN stream_events e ON e.topic = k.topic AND e.id > k.after AND e.id <= k.upto`,
    [open.map(([t]) => t), open.map(([, at]) => at), open.map(([t]) => delivered[t])]);
  return r.n;
}

/** The next batch: up to `limit` events of the topic whose next event is oldest. */
async function nextBatch(c, cursors, delivered, limit) {
  const topics = Object.keys(cursors);
  const { rows: [next] } = await c.query(
    `SELECT k.topic, k.after FROM unnest($1::text[], $2::bigint[]) AS k(topic, after)
       CROSS JOIN LATERAL (SELECT id FROM stream_events e WHERE e.topic = k.topic AND e.id > k.after ORDER BY id LIMIT 1) n
     ORDER BY n.id LIMIT 1`,
    [topics, topics.map((t) => Math.max(cursors[t], delivered[t] || 0))]);
  if (!next) return null;
  const { rows } = await c.query('SELECT * FROM stream_events WHERE topic = $1 AND id > $2 ORDER BY id LIMIT $3', [next.topic, next.after, limit]);
  return rows.length ? { topic: next.topic, rows } : null;
}

function batchOf(subId, streamId, topic, offset, rows = null) {
  const cursor = { partition: '0', offset: pad(offset), event_type: topic, cursor_token: token(subId, streamId, topic, offset) };
  if (!rows) return { cursor };
  return {
    cursor,
    events: rows.map((e) => ({
      metadata: { eid: e.eid, event_type: e.topic, occurred_at: iso(e.occurred_at), content_type: e.content_type, category: e.category },
      body: e.body, template_name: e.template_name,
    })),
  };
}

// --- commits and statistics ------------------------------------------------------

async function commit(c, id, streamId, items, who = null) {
  const s = await row(c, id, who);
  const { rows: [session] } = await c.query('SELECT stream_id FROM stream_sessions WHERE subscription_id = $1', [s.id]);
  if (!session || session.stream_id !== streamId) throw err('UNKNOWN_STREAM_ID: commit with the X-Stream-Id of the latest stream', 422);
  if (!Array.isArray(items) || !items.length) throw err('ITEMS_REQUIRED', 422);
  const results = [];
  for (const it of items) {
    const offset = Number(it?.offset);
    if (!s.event_types.includes(it?.event_type) || String(it?.partition) !== '0' || !Number.isSafeInteger(offset)) throw err('INVALID_CURSOR', 422);
    const expected = token(s.id, streamId, it.event_type, offset);
    const given = String(it.cursor_token || '');
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw err('INVALID_CURSOR_TOKEN', 422);
    const { rowCount } = await c.query(
      'UPDATE stream_cursors SET committed = $3, committed_at = now() WHERE subscription_id = $1 AND topic = $2 AND committed < $3', [s.id, it.event_type, offset]);
    results.push({ cursor: { partition: '0', offset: pad(offset), event_type: it.event_type, cursor_token: given }, result: rowCount ? 'committed' : 'outdated' });
  }
  await heartbeat(c, s.id, streamId);
  return results;
}

async function stats(c, id, { showTimeLag = false, who = null } = {}) {
  const s = await row(c, id, who);
  const cursors = await committed(c, s.id);
  const { rows: [session] } = await c.query(
    `SELECT stream_id, open AND last_seen_at >= now() - make_interval(secs => $2) AS live FROM stream_sessions WHERE subscription_id = $1`, [s.id, STALE_SECONDS]);
  const items = [];
  for (const topic of s.event_types) {
    const { rows: [u] } = await c.query(
      `SELECT count(*)::int AS n, EXTRACT(EPOCH FROM now() - min(occurred_at))::int AS lag FROM stream_events WHERE topic = $1 AND id > $2`, [topic, cursors[topic] || 0]);
    items.push({
      event_type: topic,
      partitions: [{
        partition: '0', state: session?.live ? 'assigned' : 'unassigned', unconsumed_events: u.n,
        ...(showTimeLag ? { consumer_lag_seconds: u.lag || 0 } : {}), stream_id: session?.live ? session.stream_id : '',
      }],
    });
  }
  return { items };
}

module.exports = { create, list, remove, row, openSession, heartbeat, closeSession, committed, uncommitted, nextBatch, batchOf, commit, stats };
