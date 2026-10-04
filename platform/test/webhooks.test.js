#!/usr/bin/env node
'use strict';

/**
 * Webhooks after the reference platform (docs/audits/audit-webhooks.md):
 * the shared outbound guard, events captured with their change (migration
 * 045), templates, delivery with retries, signatures and the circuit
 * breaker, the communication log and resend, and the tenant-wide switch.
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
const OUT = require('../src/lib/outbound');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return new RegExp(code).test(e.message); } };

const SLUG = 'whtest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4125;
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

// A receiver: records each request and answers as told (status, delay).
const received = [];
let answer = { status: 200, delayMs: 0 };
const receiver = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const a = typeof answer === 'function' ? answer() : answer;
    setTimeout(() => {
      if (a.status >= 300 && a.status < 400) res.setHeader('location', 'http://localhost:1/elsewhere');
      res.writeHead(a.status); res.end(a.body || 'ok');
    }, a.delayMs || 0);
  });
});
const RECEIVER = 4126;
const hookUrl = (p = '/hook') => `http://localhost:${RECEIVER}${p}`;

(async () => {
  const server = app.listen(PORT);
  receiver.listen(RECEIVER);
  try {
    // ------------------------------------------------------------------------
    section('the outbound guard (src/lib/outbound)');
    process.env.CALLBACK_ALLOW_PRIVATE = 'false';
    check('http is refused', throwsCode(() => OUT.checkUrl('http://example.org/x', { prefix: 'WEBHOOK' }), 'WEBHOOK_URL_MUST_BE_HTTPS'));
    check('credentials in the URL are refused', throwsCode(() => OUT.checkUrl('https://u:p@example.org/x', { prefix: 'WEBHOOK' }), 'MUST_NOT_CARRY_CREDENTIALS'));
    check('localhost, private and metadata addresses are refused', ['https://localhost/x', 'https://10.0.0.1/x', 'https://169.254.169.254/latest', 'https://[::1]/x']
      .every((u) => throwsCode(() => OUT.checkUrl(u, { prefix: 'WEBHOOK' }), 'MUST_BE_PUBLIC')));
    check('a public https URL is accepted', OUT.checkUrl('https://example.org/x', { prefix: 'WEBHOOK' }) === 'https://example.org/x');
    const blocked = await OUT.send({ url: `http://localhost:${RECEIVER}/x` });
    check('a request to a private address is stopped at the connection', !!blocked.error && received.length === 0, JSON.stringify(blocked));
    process.env.CALLBACK_ALLOW_PRIVATE = 'true';
    answer = { status: 302 };
    const redirect = await OUT.send({ url: hookUrl('/r'), body: '{}' });
    check('a redirect is an answer, not followed', redirect.status === 302 && received.length === 1, JSON.stringify(redirect));
    answer = { status: 200, delayMs: 1500 };
    const slow = await OUT.send({ url: hookUrl('/slow'), body: '{}', timeoutMs: 300 });
    check('a slow receiver times out', slow.error === 'TIMED_OUT', JSON.stringify(slow));
    answer = { status: 200 };
    received.length = 0;

    // ------------------------------------------------------------------------
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Hooks SACCO', mfaRequiredRoles: [], adminEmail: 'admin@wh.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@wh.local', PASSWORD);
    const hq = (await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' })).body;
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@wh.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@wh.local`);
    };
    await mk('manager', { role: 'MANAGER', branchId: 'HQ' });
    await mk('teller', { role: 'TELLER', branchId: 'HQ' });
    const m1 = (await call('POST', '/api/members', { firstName: 'Wanjiru', lastName: 'O"Hook\nline', branchId: 'HQ', phone: '0700000001' })).body;
    const sav = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    check('a member and a deposit account', m1?.id && sav?.id, JSON.stringify(sav).slice(0, 200));
    const events = (ev) => T(async (c) => (await c.query('SELECT * FROM notification_events WHERE ($1::text IS NULL OR event = $1) ORDER BY id', [ev || null])).rows);

    // ------------------------------------------------------------------------
    section('events are captured with their change (migration 045)');
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 50000, channelId: 'cash' });
    check('with no template a deposit raises no event', (await events()).length === 0);
    await T((c) => c.query(`INSERT INTO notification_templates (name, type, target, event, body, url, content_type)
      VALUES ('raw deposit', 'WEB_HOOK', 'SAVINGS', 'SAVINGS_DEPOSIT', '{}', $1, 'JSON'), ('raw approval', 'WEB_HOOK', 'LOANS', 'LOAN_APPROVAL', '{}', $1, 'JSON'),
             ('raw reversal', 'WEB_HOOK', 'SAVINGS', 'SAVINGS_DEPOSIT_REVERSAL', '{}', $1, 'JSON')`, [hookUrl()]));
    const dep = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 2500, channelId: 'cash' });
    const evs = await events('SAVINGS_DEPOSIT');
    check('with an active template a deposit raises one event with its records', evs.length === 1 && evs[0].savings_account_id === sav.id && evs[0].member_id === m1.id
      && evs[0].transaction_id && evs[0].branch_id === hq.id && evs[0].target === 'SAVINGS', `${dep.text} ${JSON.stringify(evs)}`);
    const { rows: [tx] } = await T((c) => c.query('SELECT reference FROM transactions WHERE id = $1', [evs[0].transaction_id]));
    const rev = await call('POST', `/api/savings/transactions/${tx.reference}/reversal`, { notes: 'test' });
    check('a reversal raises SAVINGS_DEPOSIT_REVERSAL', rev.status < 300 && (await events('SAVINGS_DEPOSIT_REVERSAL')).length === 1, rev.text);
    const loan = (await call('POST', '/api/loans', { memberId: m1.id, productId: 'NL01', principal: 12000, termMonths: 6 })).body;
    const appr = await call('POST', `/api/loans/${loan.id}/approve`, {});
    const ap = await events('LOAN_APPROVAL');
    check('a loan approval raises LOAN_APPROVAL', ap.length === 1 && ap[0].loan_id === loan.id && ap[0].member_id === m1.id, `${appr.text} ${JSON.stringify(ap)}`);
    await T(async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO transactions (reference, kind, member_id, savings_account_id, amount, created_by) VALUES ('ROLLED-BACK', 'SAVINGS_DEPOSIT', $1, $2, 5, 'test')`, [m1.id, sav.id]);
      await c.query('ROLLBACK');
    }).catch(() => {});
    check('a change rolled back leaves no event', (await events('SAVINGS_DEPOSIT')).length === 1);
    await T((c) => c.query("UPDATE notification_templates SET activated = false WHERE name LIKE 'raw %'"));
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 10, channelId: 'cash' });
    check('a deactivated template raises nothing new', (await events('SAVINGS_DEPOSIT')).length === 1);
    await T((c) => c.query("DELETE FROM notification_events; DELETE FROM notification_templates WHERE name LIKE 'raw %'"));

    // ------------------------------------------------------------------------
    section('templates (/api/templates)');
    const BODY = '{"event": "{{EVENT}}", "client": "{{CLIENT_NAME}}", "account": "{{ACCOUNT_ID}}", "amount": {{TRANSACTION_AMOUNT}}, "tx": "{{TRANSACTION_ID}}"}';
    const base = { name: 'Deposits to the ledger', type: 'WEB_HOOK', target: 'SAVINGS', event: 'SAVINGS_DEPOSIT', url: hookUrl('/deposits'),
      requestType: 'POST', contentType: 'JSON', body: BODY, headers: [{ key: 'x-team', value: 'treasury' }] };
    let r = await call('POST', '/api/templates', base);
    const tpl = r.body;
    check('a webhook is created, with its signing secret shown once', r.status === 201 && tpl.id && tpl.signingEnabled === true && /^[0-9a-f]{64}$/.test(tpl.signingSecret || '')
      && tpl.state === 'NOT_IN_USE' && tpl.activated === true, r.text);
    const secret = tpl.signingSecret;
    r = await call('GET', `/api/templates/${tpl.id}`);
    check('read back, without any secret', r.status === 200 && r.body.name === base.name && r.body.signingSecret === undefined && !JSON.stringify(r.body).includes(secret)
      && r.body.headers[0].key === 'x-team', r.text);
    r = await call('GET', '/api/templates');
    check('listed', r.status === 200 && r.body.length === 1 && r.body[0].id === tpl.id, r.text);
    const bad = async (patch, code) => {
      const x = await call('POST', '/api/templates', { ...base, name: `x${Math.random()}`, ...patch });
      return x.status === 400 && new RegExp(code).test(x.reason) ? true : `${x.status} ${x.text}`;
    };
    for (const [label, patch, code] of [
      ['a duplicate name', { name: base.name }, 'NAME_ALREADY_USED'],
      ['a name over 255 characters', { name: 'n'.repeat(256) }, 'NAME'],
      ['an unknown event', { event: 'CARDS_AUTHORISATION_HOLD_CREATED' }, 'UNKNOWN_EVENT|EVENT_NOT_SUPPORTED'],
      ['an event of another target', { target: 'LOANS' }, 'EVENT_NOT_FOR_TARGET'],
      ['a request type other than POST, PUT or PATCH', { requestType: 'GET' }, 'REQUEST_TYPE'],
      ['a URL with a quotation mark', { url: `${hookUrl('/a')}"` }, 'URL'],
      ['a JSON body that is not JSON once filled', { body: '{"a": {{CLIENT_NAME}' }, 'INVALID_JSON_BODY'],
      ['an XML body that is not well formed', { contentType: 'XML', body: '<a><b>{{CLIENT_NAME}}</a>' }, 'INVALID_XML_BODY'],
      ['an unknown placeholder', { body: '{"a": "{{NOT_A_PLACEHOLDER}}"}' }, 'UNKNOWN_PLACEHOLDER'],
      ['basic authorization without a username', { authorization: { type: 'BASIC', password: 'x' } }, 'USERNAME'],
    ]) { const v = await bad(patch, code); check(`refused: ${label}`, v === true, v); }
    const trimmed = await call('POST', '/api/templates', { ...base, name: '  Spaced name  ', authorization: { type: 'BASIC', username: 'hook', password: 'pa55' }, signingEnabled: false });
    check('a name is trimmed; a basic password is kept but never returned; signing can be off', trimmed.status === 201 && trimmed.body.name === 'Spaced name'
      && trimmed.body.authorization.type === 'BASIC' && trimmed.body.authorization.username === 'hook' && !JSON.stringify(trimmed.body).includes('pa55')
      && trimmed.body.signingSecret === undefined, trimmed.text);
    const { rows: [stored] } = await T((c) => c.query('SELECT auth_secret, signing_secret FROM notification_templates WHERE id = $1', [tpl.id]));
    const { rows: [stored2] } = await T((c) => c.query('SELECT auth_secret FROM notification_templates WHERE id = $1', [trimmed.body.id]));
    check('secrets are stored encrypted', stored.signing_secret && !stored.signing_secret.includes(secret) && stored2.auth_secret && !stored2.auth_secret.includes('pa55'));
    r = await call('PATCH', `/api/templates/${trimmed.body.id}`, [{ op: 'REPLACE', path: '/activated', value: false }, { op: 'ADD', path: '/headers/-', value: { key: 'x-b', value: '2' } }]);
    check('JSON Patch changes a template', r.status === 200 && r.body.activated === false && r.body.headers.length === 2, r.text);
    r = await call('POST', `/api/templates/${trimmed.body.id}:rotateSecret`);
    check('rotating the secret turns signing on and shows the new secret once', r.status === 200 && /^[0-9a-f]{64}$/.test(r.body.signingSecret || '') && r.body.signingEnabled === true, r.text);
    r = await call('DELETE', `/api/templates/${trimmed.body.id}`);
    check('deleted', r.status === 204 && (await call('GET', `/api/templates/${trimmed.body.id}`)).status === 404);
    r = await call('POST', '/api/templates', { ...base, name: 'by teller' }, { who: 'teller' });
    const r2 = await call('GET', '/api/templates', null, { who: 'teller' });
    check('a teller may not create or see webhooks', r.status === 403 && r2.status === 403, `${r.status} ${r2.status}`);
    r = await call('POST', '/api/templates', { ...base, name: 'by manager', activated: false }, { who: 'manager' });
    check('a manager may (CREATE_COMMUNICATION_TEMPLATES)', r.status === 201, r.text);
    await call('DELETE', `/api/templates/${r.body?.id}`);

    // ------------------------------------------------------------------------
    section('delivery');
    const D = require('../src/domain/notifications/dispatch');
    const runNow = () => D.runTenant(SCHEMA);
    await call('PATCH', `/api/templates/${tpl.id}`, [{ op: 'REPLACE', path: '/activated', value: false }]);
    const msgs = () => T(async (c) => (await c.query('SELECT * FROM notification_messages ORDER BY created_at, id')).rows);
    const hook = (await call('POST', '/api/templates', { ...base, name: 'Ledger feed', filtersLinkingOperator: 'MATCH_ALL',
      filterConstraints: [{ field: 'TRANSACTION_AMOUNT', filterElement: 'MORE_THAN', value: '100' }] })).body;
    check('a webhook with a condition', hook?.id && hook.signingSecret, JSON.stringify(hook).slice(0, 200));
    received.length = 0;
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 2500, channelId: 'cash' });
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 50, channelId: 'cash' });
    await runNow();
    check('one request: the deposit over 100, not the one under', received.length === 1, String(received.length));
    const got = received[0] || { headers: {} };
    let parsed = null; try { parsed = JSON.parse(got.body); } catch {}
    check('sent as defined: method, path, content type and the custom header', got.method === 'POST' && got.url === '/deposits'
      && /application\/json/.test(got.headers['content-type']) && got.headers['x-team'] === 'treasury', JSON.stringify(got.headers));
    check('the body is valid JSON with the member\'s name escaped', parsed && parsed.client === 'Wanjiru O"Hook\nline' && parsed.amount === 2500
      && parsed.event === 'SAVINGS_DEPOSIT' && parsed.account === sav.account_no, got.body);
    const [tPart, vPart] = String(got.headers['x-sacco-signature'] || '').split(',');
    const expected = crypto.createHmac('sha256', hook.signingSecret).update(`${tPart?.slice(2)}.${got.body}`).digest('hex');
    check('signed: x-sacco-signature verifies with the secret', vPart === `v1=${expected}`, got.headers['x-sacco-signature']);
    check('an idempotency key is sent', /^[0-9a-f-]{36}$/.test(got.headers['x-notifications-idempotency-key'] || ''));
    let log = await msgs();
    check('logged as SENT; the template is now in use', log.length === 1 && log[0].state === 'SENT' && log[0].response_status === 200
      && (await call('GET', `/api/templates/${hook.id}`)).body.state === 'IN_USE', JSON.stringify(log.map((m) => m.state)));

    answer = { status: 500 };
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 300, channelId: 'cash' });
    await runNow();
    log = await msgs();
    const retry = log[log.length - 1];
    check('a 500 is not delivered: queued to retry after a minute', retry.state === 'QUEUED' && retry.num_retries === 1 && retry.failure_reason === 'INVALID_HTTP_RESPONSE'
      && /500/.test(retry.failure_cause) && new Date(retry.next_attempt_at) - Date.now() > 50_000, JSON.stringify(retry));
    answer = { status: 200 };
    await T((c) => c.query('UPDATE notification_messages SET next_attempt_at = now() WHERE id = $1', [retry.id]));
    await runNow();
    const again = (await msgs()).find((m) => m.id === retry.id);
    const keys = received.slice(-2).map((x) => x.headers['x-notifications-idempotency-key']);
    check('the retry is delivered with the same idempotency key', again.state === 'SENT' && keys[0] === keys[1], JSON.stringify(keys));

    answer = { status: 302 };
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 301, channelId: 'cash' });
    await runNow();
    const redirected = (await msgs()).pop();
    check('a redirect is a failure, not followed', redirected.failure_reason === 'INVALID_HTTP_RESPONSE' && /302/.test(redirected.failure_cause), JSON.stringify(redirected));
    answer = { status: 200, delayMs: 1500 };
    await T((c) => c.query("UPDATE notification_messages SET next_attempt_at = now() WHERE state = 'QUEUED'"));
    await runNow();
    const slowMsg = (await msgs()).pop();
    check('a slow receiver times out: HTTP_ERROR_WHILE_SENDING', slowMsg.failure_reason === 'HTTP_ERROR_WHILE_SENDING' && /TIMED_OUT/.test(slowMsg.failure_cause), JSON.stringify(slowMsg));
    answer = { status: 500 };
    await T((c) => c.query("UPDATE notification_messages SET next_attempt_at = now(), num_retries = 9 WHERE state = 'QUEUED'"));
    await runNow();
    const failed = (await msgs()).pop();
    check('after the last retry the message is FAILED', failed.state === 'FAILED' && failed.num_retries === 10, JSON.stringify(failed));
    await new Promise((r) => setTimeout(r, 1200));

    answer = { status: 500 };
    await T((c) => c.query('UPDATE notification_templates SET consecutive_failures = 19 WHERE id = $1', [hook.id]));
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 400, channelId: 'cash' });
    await runNow();
    const { rows: [open] } = await T((c) => c.query('SELECT consecutive_failures, circuit_open_until FROM notification_templates WHERE id = $1', [hook.id]));
    check('20 failures in a row open the circuit for 10 minutes', open.consecutive_failures === 20 && new Date(open.circuit_open_until) - Date.now() > 9 * 60_000, JSON.stringify(open));
    const before = received.length;
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 401, channelId: 'cash' });
    await T((c) => c.query("UPDATE notification_messages SET next_attempt_at = now() WHERE state IN ('QUEUED', 'WAITING')"));
    await runNow();
    const waiting = (await msgs()).filter((m) => m.state === 'WAITING');
    check('while it is open nothing is sent; messages wait for the circuit to close', received.length === before && waiting.length === 2
      && waiting.every((m) => m.waiting_reason === 'WAIT_FOR_CLOSE_CIRCUIT'), JSON.stringify(waiting.map((m) => [m.state, m.waiting_reason])));
    answer = { status: 200 };
    await T((c) => c.query("UPDATE notification_templates SET circuit_open_until = now() - interval '1 second' WHERE id = $1", [hook.id]));
    await runNow();
    check('after 10 minutes one message is tried; its success closes the circuit', received.length === before + 1
      && (await T((c) => c.query('SELECT circuit_open_until FROM notification_templates WHERE id = $1', [hook.id]))).rows[0].circuit_open_until === null);
    await runNow();
    check('and the rest follow', received.length === before + 2 && (await msgs()).filter((m) => m.state === 'WAITING').length === 0);

    received.length = 0;
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 500, channelId: 'cash' });
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 501, channelId: 'cash' });
    await Promise.all([runNow(), runNow(), runNow()]);
    check('three dispatchers at once send each message once', received.length === 2, String(received.length));

    process.env.NOTIFY_AFTER_REQUEST = 'on';
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 502, channelId: 'cash' });
    for (let i = 0; i < 30 && received.length < 3; i += 1) await new Promise((r) => setTimeout(r, 100));
    check('after a request that raised an event, it is sent without waiting for the job', received.length === 3, String(received.length));
    process.env.NOTIFY_AFTER_REQUEST = 'off';
    await new Promise((r) => setTimeout(r, 300));

    r = await call('POST', `/api/templates/${hook.id}:test`);
    check(':test sends a sample now and gives the outcome', r.status === 200 && r.body.state === 'SENT' && received.length === 4
      && JSON.parse(received[3].body).client === 'Jane Sample', r.text);

    // Reminders: due in triggerDays days, sent once per installment.
    await call('POST', `/api/loans/${loan.id}/disbursements`, { channelId: 'cash' });
    const { rows: [due] } = await T((c) => c.query('SELECT number, due_date FROM loan_installments WHERE loan_id = $1 ORDER BY number LIMIT 1', [loan.id]));
    const today = await T((c) => require('../src/lib/orgDate').orgToday(c));
    const days = Math.round((Date.parse(String(due.due_date instanceof Date ? due.due_date.toISOString().slice(0, 10) : due.due_date).slice(0, 10)) - Date.parse(today)) / 86400000);
    const rem = await call('POST', '/api/templates', { name: 'Reminder', target: 'LOANS', event: 'REPAYMENT_REMINDER', triggerDays: days, url: hookUrl('/remind'),
      body: '{"due": "{{INSTALLMENT_DUE_DATE}}", "amount": "{{INSTALLMENT_DUE_AMOUNT}}", "n": {{INSTALLMENT_NUMBER}}}' });
    received.length = 0;
    await T((c) => c.query('UPDATE notification_settings SET last_reminder_day = NULL'));
    await runNow();
    await runNow();
    const reminders = received.filter((x) => x.url === '/remind');
    check('a repayment reminder is sent for the installment due in triggerDays days, once', rem.status === 201 && reminders.length === 1
      && JSON.parse(reminders[0].body).n === due.number, `${rem.text} ${received.map((x) => x.url)}`);

    await T((c) => c.query("UPDATE notification_messages SET created_at = now() - interval '200 days' WHERE id = (SELECT id FROM notification_messages ORDER BY created_at LIMIT 1)"));
    await T((c) => c.query('UPDATE notification_settings SET last_purge_day = NULL'));
    await runNow();
    const { rows: [old] } = await T((c) => c.query('SELECT body, body_cleared_at, state FROM notification_messages ORDER BY created_at LIMIT 1'));
    check('bodies older than 180 days are cleared; the record stays', old.body === null && old.body_cleared_at && old.state === 'SENT', JSON.stringify(old));

    // ------------------------------------------------------------------------
    section('the communication log (/api/communications/messages) and the switch');
    r = await call('POST', '/api/communications/messages:search?paginationDetails=ON', [{ field: 'state', operator: 'EQUALS', value: 'FAILED' }]);
    const failedKey = r.body?.[0]?.encodedKey;
    check('search by state, with the count', r.status === 200 && r.body.length >= 1 && r.body.every((m) => m.state === 'FAILED' && m.type === 'WEB_HOOK')
      && Number(r.total) === r.body.length && r.body[0].body === undefined, r.text);
    r = await call('POST', '/api/communications/messages:searchSorted?detailsLevel=FULL', { filterCriteria: [{ field: 'event', operator: 'EQUALS', value: 'SAVINGS_DEPOSIT' }],
      sortingCriteria: { field: 'creationDate', order: 'ASC' } });
    check('sorted search, with bodies at FULL', r.status === 200 && r.body.length >= 3 && 'body' in r.body[0] && r.body.some((m) => m.body) && new Date(r.body[0].creationDate) <= new Date(r.body[1].creationDate), r.text);
    r = await call('GET', `/api/communications/messages/${failedKey}`);
    check('one message, with its outcome', r.status === 200 && r.body.encodedKey === failedKey && r.body.failureReason && r.body.numRetries >= 1, r.text);
    const sentKey = (await call('POST', '/api/communications/messages:search', [{ field: 'state', operator: 'EQUALS', value: 'SENT' }])).body[0].encodedKey;
    r = await call('POST', '/api/communications/messages:resend', { messages: [sentKey] });
    check('only a failed message is resent', r.status === 400 && /ONLY_FAILED/.test(r.reason), r.text);
    received.length = 0;
    answer = { status: 200 };
    const oldKey = (await T((c) => c.query('SELECT idempotency_key FROM notification_messages WHERE id = $1', [failedKey]))).rows[0].idempotency_key;
    r = await call('POST', '/api/communications/messages:resend', { messages: [failedKey] });
    await runNow();
    const resent = (await call('GET', `/api/communications/messages/${failedKey}`)).body;
    check('a failed message is resent with a new idempotency key', r.status === 202 && resent.state === 'SENT' && received.length === 1
      && received[0].headers['x-notifications-idempotency-key'] !== oldKey, `${r.status} ${r.text} ${JSON.stringify(resent)}`);
    r = await call('POST', '/api/notifications/messages/search', { filterConstraints: [{ filterSelection: 'STATE', filterElement: 'EQUALS', value: 'SENT' }] });
    check('the v1 search', r.status === 200 && r.body.length >= 1 && r.body.every((m) => m.state === 'SENT'), r.text);
    r = await call('POST', '/api/notifications/messages', { action: 'resend', identifiers: ['00000000-0000-0000-0000-000000000000'] });
    check('the v1 resend answers NO_MESSAGE_FOUND for an unknown key', r.status === 404 && /NO_MESSAGE_FOUND/.test(r.reason), r.text);
    r = await call('POST', '/api/communications/messages:search', [], { who: 'teller' });
    const r3 = await call('POST', '/api/communications/messages:resend', { messages: [failedKey] }, { who: 'teller' });
    check('a teller may not read the log or resend', r.status === 403 && r3.status === 403, `${r.status} ${r3.status}`);
    r = await call('POST', '/api/communications/messages:search', [], { who: 'manager' });
    check('a manager may (VIEW_COMMUNICATION_HISTORY)', r.status === 200, r.text);

    r = await call('PUT', '/api/notificationsettings/webhook', { state: 'DISABLED' }, { who: 'manager' });
    check('only an administrator switches webhooks off', r.status === 403, r.text);
    r = await call('PUT', '/api/notificationsettings/webhook', { state: 'DISABLED' });
    check('switched off', r.status === 200 && r.body.state === 'DISABLED' && (await call('GET', '/api/notificationsettings/webhook')).body.state === 'DISABLED', r.text);
    received.length = 0;
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 600, channelId: 'cash' });
    await runNow();
    const off = (await msgs()).pop();
    check('while off, a message fails with WEBHOOK_NOTIFICATIONS_DISABLED and nothing is sent', off.state === 'FAILED' && off.failure_reason === 'WEBHOOK_NOTIFICATIONS_DISABLED' && received.length === 0, JSON.stringify(off));
    await call('PUT', '/api/notificationsettings/webhook', { state: 'ENABLED' });
    r = await call('POST', '/api/communications/messages:resendAsyncByDate', { startDate: new Date(Date.now() - 60_000).toISOString(), endDate: new Date().toISOString(), templateTypes: ['WEB_HOOK'] });
    await runNow();
    check('switched on, failed messages are resent by date', r.status === 200 && received.length === 1, `${r.status} ${r.text} ${received.length}`);

    // FURTHER SECTIONS
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server.close();
    receiver.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
