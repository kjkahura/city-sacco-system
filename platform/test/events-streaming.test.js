#!/usr/bin/env node
'use strict';

/**
 * Events streaming after the reference platform (docs/audits/audit-events-streaming.md):
 * streaming templates and their topics (migration 046), publishing, and the
 * subscriptions API: streams read over real HTTP, cursor commits, stats.
 */

process.env.CALLBACK_ALLOW_PRIVATE = 'true';
// The checks run the dispatcher themselves; one turns the run after requests back on.
process.env.NOTIFY_AFTER_REQUEST = 'off';
process.env.NOTIFY_TIMEOUT_MS = '400';

const http = require('http');
const crypto = require('crypto');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return new RegExp(code).test(e.message); } };

const SLUG = 'estest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4128;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);

const tokens = {};
async function call(method, p, body, { who = 'admin' } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 500), reason: `${d?.errors?.[0]?.errorReason || ''}`, total: r.headers.get('items-total') };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}

// A stream read over HTTP: the batches, the stream ID and the status.
async function stream(key, subId, query = '', { abortAfterMs = null } = {}) {
  const ctl = new AbortController();
  if (abortAfterMs) setTimeout(() => ctl.abort(), abortAfterMs);
  const auth = String(key).startsWith('Bearer ') ? { authorization: key } : { apikey: key };
  const r = await fetch(`http://localhost:${PORT}/api/v1/subscriptions/${subId}/events${query}`, { headers: { 'x-tenant': SLUG, ...auth }, signal: ctl.signal });
  const out = { status: r.status, streamId: r.headers.get('x-stream-id'), type: r.headers.get('content-type'), batches: [], text: '' };
  try { out.text = await r.text(); } catch { /* aborted */ }
  out.batches = out.text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
  return out;
}
const asKey = (key, method, p, body, headers = {}) => fetch(`http://localhost:${PORT}${p}`, {
  method, headers: { 'x-tenant': SLUG, ...(String(key).startsWith('Bearer ') ? { authorization: key } : { apikey: key }), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => { const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch {} return { status: r.status, body: b, text: t.slice(0, 400) }; });

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Stream SACCO', mfaRequiredRoles: [], adminEmail: 'admin@es.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@es.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const m1 = (await call('POST', '/api/members', { firstName: 'Neema', lastName: 'Stream', branchId: 'HQ' })).body;
    const sav = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    check('a member and a deposit account', m1?.id && sav?.id);
    const D = require('../src/domain/notifications/dispatch');
    const publish = () => D.runTenant(SCHEMA);
    const deposit = (amount) => call('POST', `/api/savings/${sav.id}/deposits`, { amount, channelId: 'cash' });

    // ------------------------------------------------------------------------
    section('streaming templates and publishing (migration 046)');
    let r = await call('POST', '/api/templates', { name: 'Deposits Stream', type: 'EVENT_STREAM', target: 'SAVINGS', event: 'SAVINGS_DEPOSIT',
      body: '{"account": "{{ACCOUNT_ID}}", "amount": {{TRANSACTION_AMOUNT}}}' });
    const tpl = r.body;
    const TOPIC = 'sacco.event.estest.streamingapi.deposits_stream';
    check('a streaming template needs no URL and gets its topic', r.status === 201 && tpl.type === 'EVENT_STREAM' && tpl.topic === TOPIC && !tpl.signingSecret, r.text);
    r = await call('PATCH', `/api/templates/${tpl.id}`, [{ op: 'REPLACE', path: '/name', value: 'Deposits renamed' }]);
    check('renaming it keeps the topic', r.status === 200 && r.body.topic === TOPIC, r.text);
    await deposit(1000);
    await publish();
    const { rows: published } = await T((c) => c.query('SELECT * FROM stream_events WHERE topic = $1 ORDER BY id', [TOPIC]));
    check('a deposit publishes one event with its body, metadata and template name', published.length === 1 && JSON.parse(published[0].body).amount === 1000
      && published[0].event === 'SAVINGS_DEPOSIT' && published[0].template_name === 'Deposits renamed' && published[0].content_type === 'application/json'
      && published[0].eid, JSON.stringify(published));
    const { rows: [logged] } = await T((c) => c.query('SELECT count(*)::int AS n FROM notification_messages'));
    check('no communication log rows for streamed events', logged.n === 0);

    // ------------------------------------------------------------------------
    section('subscriptions (/api/v1/subscriptions)');
    const con = (await call('POST', '/api/consumers', { name: 'Ledger reader', access: { permissions: ['CONSUME_EVENT_STREAMS'] } })).body;
    const KEY = (await call('POST', `/api/consumers/${con?.id}/keys`, {})).body?.apiKey;
    const other = (await call('POST', '/api/consumers', { name: 'Reports only', access: { permissions: ['VIEW_REPORTS'] } })).body;
    const NOKEY = (await call('POST', `/api/consumers/${other?.id}/keys`, {})).body?.apiKey;
    check('an API consumer with CONSUME_EVENT_STREAMS, and one without', KEY && NOKEY, JSON.stringify(con));
    const subBody = { owning_application: 'ledger', event_types: [TOPIC], consumer_group: 'default', read_from: 'begin' };
    r = await asKey(KEY, 'POST', '/api/v1/subscriptions', subBody);
    const sub = r.body;
    check('a subscription is created (201)', r.status === 201 && /^[0-9a-f-]{36}$/.test(sub?.id || '') && sub.read_from === 'begin' && sub.event_types[0] === TOPIC, r.text);
    r = await asKey(KEY, 'POST', '/api/v1/subscriptions', subBody);
    check('the same subscription again is returned (200)', r.status === 200 && r.body.id === sub.id, r.text);
    r = await asKey(KEY, 'POST', '/api/v1/subscriptions', { ...subBody, event_types: ['sacco.event.estest.streamingapi.nothing'] });
    check('an unknown topic is refused (422)', r.status === 422, r.text);
    r = await asKey(NOKEY, 'POST', '/api/v1/subscriptions', subBody);
    check('a consumer without CONSUME_EVENT_STREAMS is refused', r.status === 403, r.text);

    section('streams');
    const s1 = await stream(KEY, sub.id, '?batch_limit=1&stream_timeout=2&batch_flush_timeout=1');
    const first = s1.batches.find((b) => b.events);
    const ev = first?.events?.[0];
    check('a stream of newline-separated JSON batches, with its stream ID', s1.status === 200 && /x-json-stream/.test(s1.type || '') && /^[0-9a-f-]{36}$/.test(s1.streamId || ''), `${s1.status} ${s1.text}`);
    check('a batch: its cursor with a token, and the event with its metadata, body and template', first && first.cursor.partition === '0' && /^\d{18}$/.test(first.cursor.offset)
      && first.cursor.event_type === TOPIC && first.cursor.cursor_token && ev.metadata.event_type === TOPIC && /^[0-9a-f-]{36}$/.test(ev.metadata.eid)
      && ev.metadata.occurred_at && ev.metadata.content_type === 'application/json' && ev.metadata.category === 'SAVINGS'
      && JSON.parse(ev.body).amount === 1000 && ev.template_name === 'Deposits renamed', JSON.stringify(first));
    check('keep-alive batches when there is nothing to send', s1.batches.some((b) => !b.events && b.cursor), s1.text);
    const commit = (sid, cursors, key = KEY) => asKey(key, 'POST', `/api/v1/subscriptions/${sub.id}/cursors`, { items: cursors }, { 'x-stream-id': sid });
    r = await commit(s1.streamId, [first.cursor]);
    check('a commit (204)', r.status === 204, `${r.status} ${r.text}`);
    r = await commit(s1.streamId, [first.cursor]);
    check('committing the same cursor again is outdated (200)', r.status === 200 && r.body.items[0].result === 'outdated', r.text);
    r = await commit('00000000-0000-0000-0000-000000000000', [first.cursor]);
    check('a commit with another stream\'s ID is refused', r.status === 422, r.text);
    r = await commit(s1.streamId, [{ ...first.cursor, offset: '000000000000099999' }]);
    check('a forged cursor is refused', r.status === 422, r.text);

    await deposit(2000); await deposit(3000); await publish();
    const s2 = await stream(KEY, sub.id, '?batch_limit=5&stream_timeout=2&batch_flush_timeout=1');
    const got2 = s2.batches.flatMap((b) => b.events || []).map((e) => JSON.parse(e.body).amount);
    check('the next stream resumes after the committed cursor, several events to a batch', got2.join() === '2000,3000'
      && s2.batches.find((b) => b.events).events.length === 2, got2.join());

    await deposit(4000); await deposit(5000); await publish();
    const s3 = await stream(KEY, sub.id, '?batch_limit=1&max_uncommitted_events=1&stream_timeout=2&batch_flush_timeout=1');
    const got3 = s3.batches.flatMap((b) => b.events || []).map((e) => JSON.parse(e.body).amount);
    check('with nothing committed, no more than max_uncommitted_events are sent', got3.join() === '2000', got3.join());

    let t0 = Date.now();
    const s4 = await stream(KEY, sub.id, '?batch_limit=1&commit_timeout=1&stream_timeout=8&batch_flush_timeout=1');
    check('a stream whose batch is not committed in commit_timeout is closed', s4.status === 200 && Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
    t0 = Date.now();
    const s5 = await stream(KEY, sub.id, '?batch_limit=1&stream_limit=1&stream_timeout=8');
    check('stream_limit ends the stream after that many events', s5.batches.flatMap((b) => b.events || []).length === 1 && Date.now() - t0 < 3000, `${Date.now() - t0}ms`);

    const held = stream(KEY, sub.id, '?stream_timeout=8&batch_flush_timeout=1', { abortAfterMs: 1500 });
    await new Promise((ok) => setTimeout(ok, 400));
    const busy = await stream(KEY, sub.id, '?stream_timeout=1');
    check('one stream at a time: a second gets 409', busy.status === 409, `${busy.status} ${busy.text}`);
    await held;
    await new Promise((ok) => setTimeout(ok, 400));
    const after = await stream(KEY, sub.id, '?stream_timeout=1&batch_flush_timeout=1');
    check('a stream that disconnects frees its slot at once', after.status === 200, `${after.status} ${after.text}`);

    r = await asKey(KEY, 'GET', `/api/v1/subscriptions/${sub.id}/stats?show_time_lag=true`);
    const part = r.body?.items?.[0]?.partitions?.[0];
    check('stats: unconsumed events, lag, and whether a stream holds it', r.status === 200 && r.body.items[0].event_type === TOPIC && part.partition === '0'
      && part.unconsumed_events === 4 && typeof part.consumer_lag_seconds === 'number' && part.state === 'unassigned', r.text);

    r = await asKey(KEY, 'POST', '/api/v1/subscriptions', { ...subBody, consumer_group: 'late', read_from: 'end' });
    const late = await stream(KEY, r.body.id, '?stream_timeout=1&batch_flush_timeout=1');
    check('read_from end starts after what was already published', r.status === 201 && late.status === 200 && late.batches.every((b) => !b.events), late.text);

    // ------------------------------------------------------------------------
    section('the final review');
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const tplRow = (await T((c) => c.query('SELECT * FROM notification_templates WHERE id = $1', [tpl.id]))).rows[0];
    const fake = { event: 'SAVINGS_DEPOSIT', target: 'SAVINGS', branch_id: null };
    let release;
    const gate = new Promise((ok) => { release = ok; });
    const p1 = T(async (c) => { await D.publish(c, tplRow, fake, {}); await gate; });
    await sleep(200);
    let secondDone = false;
    const p2 = T((c) => D.publish(c, tplRow, fake, {})).then(() => { secondDone = true; });
    await sleep(400);
    check('a second publisher waits until the first commits, so offsets become visible in order', !secondDone);
    release(); await p1; await p2;
    check('and then publishes', secondDone);

    const con2 = (await call('POST', '/api/consumers', { name: 'Another reader', access: { permissions: ['CONSUME_EVENT_STREAMS'] } })).body;
    const KEY2 = (await call('POST', `/api/consumers/${con2?.id}/keys`, {})).body?.apiKey;
    r = await asKey(KEY2, 'GET', `/api/v1/subscriptions/${sub.id}/stats`);
    check('another consumer does not see a subscription it did not make', r.status === 404, `${r.status} ${r.text}`);
    r = await asKey(KEY2, 'POST', `/api/v1/subscriptions/${sub.id}/cursors`, { items: [] }, { 'x-stream-id': s1.streamId });
    const notMine = await stream(KEY2, sub.id, '?stream_timeout=1');
    check('nor reads or commits it', r.status === 404 && notMine.status === 404, `${r.status} ${notMine.status}`);
    r = await asKey(KEY2, 'DELETE', `/api/v1/subscriptions/${sub.id}`);
    check('nor deletes it', r.status === 404, `${r.status} ${r.text}`);
    r = await asKey(KEY2, 'POST', '/api/v1/subscriptions', subBody);
    check('the same application, group and topics held by another consumer is refused (409)', r.status === 409, `${r.status} ${r.text}`);
    r = await asKey(KEY2, 'GET', '/api/v1/subscriptions');
    check('a consumer lists only its own subscriptions', r.status === 200 && r.body.length === 0, r.text);
    r = await call('GET', `/api/v1/subscriptions/${sub.id}/stats`);
    check('an administrator sees every subscription', r.status === 200, r.text);

    const twin = { owning_application: 'twins', event_types: [TOPIC], read_from: 'end' };
    const [ta, tb] = await Promise.all([asKey(KEY, 'POST', '/api/v1/subscriptions', twin), asKey(KEY, 'POST', '/api/v1/subscriptions', twin)]);
    check('two identical creates at once give one subscription, not an error', [ta.status, tb.status].sort().join() === '200,201' && ta.body.id === tb.body.id, `${ta.status} ${tb.status} ${tb.text}`);

    r = await call('POST', '/api/templates', { name: 'Loose Feed', type: 'EVENT_STREAM', target: 'SAVINGS', event: 'SAVINGS_DEPOSIT', body: '{}' });
    const loose = r.body;
    await asKey(KEY, 'POST', '/api/v1/subscriptions', { owning_application: 'loose', event_types: [loose.topic] });
    r = await call('PATCH', `/api/templates/${loose.id}`, [{ op: 'REPLACE', path: '/activated', value: false }]);
    const { rows: acts } = await T((c) => c.query('SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id', [loose.id]));
    check('streaming templates are audited as such', acts.map((a) => a.action).join() === 'STREAM_TEMPLATE_CREATED,STREAM_TEMPLATE_EDITED', acts.map((a) => a.action).join());
    await call('DELETE', `/api/templates/${loose.id}`);
    r = await call('POST', '/api/templates', { name: 'Loose Feed', type: 'EVENT_STREAM', target: 'SAVINGS', event: 'SAVINGS_DEPOSIT', body: '{}' });
    check('a deleted template\'s topic is not given to a new one while a subscription still reads it', r.status === 201 && r.body.topic !== loose.topic, `${loose.topic} ${r.body?.topic}`);

    await call('POST', '/api/branches', { code: 'NKR', name: 'Nakuru' });
    const m2 = (await call('POST', '/api/members', { firstName: 'Baraka', lastName: 'Nakuru', branchId: 'NKR' })).body;
    const sav2 = (await call('POST', '/api/savings', { memberId: m2.id, productId: 'SAV01' })).body;
    const u = await call('POST', '/api/users', { email: 'hq@es.local', fullName: 'HQ only', password: PW, role: 'MANAGER', branchId: 'HQ',
      accessRights: { allBranches: false }, permissions: ['CONSUME_EVENT_STREAMS'] });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
    const HQ = `Bearer ${await login('hq@es.local')}`;
    r = await asKey(HQ, 'POST', '/api/v1/subscriptions', { owning_application: 'hq-feed', event_types: [TOPIC], read_from: 'end' });
    check('a branch-limited user subscribes', r.status === 201, r.text);
    await deposit(7000);
    await call('POST', `/api/savings/${sav2.id}/deposits`, { amount: 8000, channelId: 'cash' });
    await publish();
    const hqs = await stream(HQ, r.body.id, '?batch_limit=10&stream_timeout=2&batch_flush_timeout=1');
    const hqGot = hqs.batches.flatMap((b) => b.events || []).map((e) => JSON.parse(e.body).amount);
    check('a branch-limited reader gets only its branches\' events', hqs.status === 200 && hqGot.join() === '7000', `${hqs.status} ${hqGot.join()} ${hqs.text}`);

    r = await asKey(KEY, 'DELETE', `/api/v1/subscriptions/${sub.id}`);
    check('a subscription is deleted', r.status === 204 && (await asKey(KEY, 'GET', `/api/v1/subscriptions/${sub.id}/stats`)).status === 404, `${r.status} ${r.text}`);

    // FURTHER SECTIONS
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
