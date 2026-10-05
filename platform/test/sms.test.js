#!/usr/bin/env node
'use strict';

/**
 * SMS after the reference platform (docs/audits/audit-sms.md): pluggable
 * providers with the generic HTTPS gateway built in, phone numbers and
 * segments, templates of type SMS, delivery and its outcomes, delivery
 * reports, manual SMS and subscriptions.
 *
 * The gateway is an HTTP server run inside this test (CALLBACK_ALLOW_PRIVATE
 * lets the outbound guard reach it), so nothing leaves the machine.
 */

process.env.CALLBACK_ALLOW_PRIVATE = 'true';
process.env.NOTIFY_AFTER_REQUEST = 'off';
process.env.NOTIFY_TIMEOUT_MS = '2000';

const http = require('http');
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

const SLUG = 'smstest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4130;
const GW = 4131;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);

// --- the gateway ---------------------------------------------------------------
const outbox = [];
let answer = { status: 200 };
let nextId = 1;
const gateway = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    outbox.push({ method: req.method, url: req.url, headers: req.headers, raw, body });
    const id = `gw-${nextId++}`;
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body || { data: { id, status: 'queued' } }));
  });
});

const tokens = {};
async function call(method, p, body, { who = 'admin', token = null, form = false } = {}) {
  const headers = { 'x-tenant': SLUG };
  const tok = token || tokens[who];
  if (tok) headers.authorization = `Bearer ${tok}`;
  let payload;
  if (body !== undefined && body !== null) {
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    else { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 600), reason: `${d?.errors?.[0]?.errorReason || ''}` };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}

(async () => {
  const server = app.listen(PORT);
  await new Promise((ok) => gateway.listen(GW, '127.0.0.1', ok));
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Text SACCO', mfaRequiredRoles: [], adminEmail: 'admin@sms.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@sms.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@sms.local`, fullName: `The ${who}`, password: PW, branchId: 'HQ', ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@sms.local`);
    };
    await mk('manager', { role: 'MANAGER' });
    await mk('teller', { role: 'TELLER' });
    await mk('sender', { role: 'TELLER', permissions: ['SEND_MANUAL_SMS'] });
    const m1 = (await call('POST', '/api/members', { firstName: 'Amina', lastName: 'Otieno', branchId: 'HQ', phone: '0712 345 678', nationalId: '12345678' })).body;
    const m2 = (await call('POST', '/api/members', { firstName: 'Baraka', lastName: 'NoPhone', branchId: 'HQ' })).body;
    const sav1 = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    const sav2 = (await call('POST', '/api/savings', { memberId: m2.id, productId: 'SAV01' })).body;
    check('members and deposit accounts', m1?.id && m2?.id && sav1?.id && sav2?.id, JSON.stringify(m1));
    const D = require('../src/domain/notifications/dispatch');
    const run = () => D.runTenant(SCHEMA);
    const deposit = (sav, amount) => call('POST', `/api/savings/${sav.id}/deposits`, { amount, channelId: 'cash' });
    const messages = async () => (await T((c) => c.query("SELECT * FROM notification_messages WHERE type = 'SMS' ORDER BY created_at, id"))).rows;

    // ------------------------------------------------------------------------
    section('phone numbers and segments');
    const SMS = require('../src/domain/notifications/channels/sms');
    check('local Kenyan numbers become E.164', SMS.toE164('0712 345 678', 'KE') === '+254712345678' && SMS.toE164('254712345678', 'KE') === '+254712345678'
      && SMS.toE164('712345678', 'KE') === '+254712345678' && SMS.toE164('0110 123456', 'KE') === '+254110123456');
    check('international numbers are kept; other countries use their code', SMS.toE164('+256 772 000 000', 'KE') === '+256772000000'
      && SMS.toE164('0772000000', 'UG') === '+256772000000' && SMS.toE164('00255 712 000 000', 'KE') === '+255712000000');
    check('digits that start with another country\'s code and have its length are that country\'s', SMS.toE164('256772123456', 'KE') === '+256772123456'
      && SMS.toE164('255712000000', 'KE') === '+255712000000');
    check('a national number must have the country\'s length; a tenant country not listed reads international numbers only',
      SMS.toE164('07123456789', 'KE') === null && SMS.toE164('0712345678', 'XX') === null && SMS.toE164('+254712345678', 'XX') === '+254712345678');
    check('a number that cannot be read is null', SMS.toE164('12', 'KE') === null && SMS.toE164('call me', 'KE') === null && SMS.toE164('', 'KE') === null);
    check('GSM-7: 160 characters is one segment, 161 two', SMS.segments('a'.repeat(160)).count === 1 && SMS.segments('a'.repeat(161)).count === 2
      && SMS.segments('a'.repeat(161)).encoding === 'GSM-7');
    check('the euro sign counts twice; any other character makes it UCS-2', SMS.segments('€'.repeat(80)).count === 1 && SMS.segments('€'.repeat(81)).count === 2
      && SMS.segments('ł'.repeat(70)).count === 1 && SMS.segments('ł'.repeat(71)).count === 2 && SMS.segments('ł').encoding === 'UCS-2');
    check('a character that takes two places is not split across segments', SMS.segments('😀'.repeat(35)).count === 1 && SMS.segments('😀'.repeat(201)).count === 7
      && SMS.segments('€'.repeat(80) + 'a').count === 2, String(SMS.segments('😀'.repeat(201)).count));

    // ------------------------------------------------------------------------
    section('settings (/api/notificationsettings/sms)');
    let r = await call('GET', '/api/notificationsettings/sms/providers');
    const httpProvider = r.body?.find?.((p) => p.id === 'HTTP');
    check('the providers are listed with their fields', r.status === 200 && httpProvider && httpProvider.fields.some((f) => f.name === 'url')
      && httpProvider.fields.some((f) => f.name === 'apiKey' && f.secret), r.text);
    r = await call('GET', '/api/notificationsettings/sms');
    check('SMS starts switched off with no provider', r.status === 200 && r.body.enabled === false && !r.body.provider && r.body.apiKeySet === false, r.text);
    const good = { provider: 'HTTP', senderId: 'CITYSACCO', url: `http://localhost:${GW}/send`, method: 'POST', contentType: 'JSON', apiKeyHeader: 'X-Api-Key',
      bodyTemplate: '{"to": "{{to}}", "message": "{{text}}", "from": "{{from}}", "ref": "{{id}}"}', messageIdPath: 'data.id', apiKey: 'k-123' };
    r = await call('PUT', '/api/notificationsettings/sms', { ...good, provider: 'NOPE' });
    check('an unknown provider is refused', r.status === 400 && /PROVIDER/.test(r.reason), r.text);
    r = await call('PUT', '/api/notificationsettings/sms', { ...good, url: 'ftp://gateway.test/x' });
    check('a gateway address that is not https is refused', r.status === 400 && /URL/.test(r.reason), r.text);
    r = await call('PUT', '/api/notificationsettings/sms', { ...good, senderId: 'A SENDER THAT IS FAR TOO LONG' });
    check('a sender ID is at most 11 letters or 15 digits', r.status === 400 && /SENDER_ID/.test(r.reason), r.text);
    r = await call('PUT', '/api/notificationsettings/sms', { ...good, url: `http://localhost:${GW}/send#x` });
    const r0 = await call('PUT', '/api/notificationsettings/sms', { ...good, apiKey: 'line one\nline two' });
    check('a gateway URL with a fragment, or an API key with control characters, is refused', r.status === 400 && /FRAGMENT/.test(r.reason)
      && r0.status === 400 && /API_KEY/.test(r0.reason), `${r.text} ${r0.text}`);
    r = await call('PUT', '/api/notificationsettings/sms', { ...good, bodyTemplate: '{"to": {{to}} "x"}' });
    check('a JSON body template must stay JSON once filled', r.status === 400 && /BODY_TEMPLATE/.test(r.reason), r.text);
    r = await call('PUT', '/api/notificationsettings/sms', { ...good, bodyTemplate: '{"to": "+254700000000"}' });
    check('a body template needs {{to}} and {{text}}', r.status === 400 && /BODY_TEMPLATE/.test(r.reason), r.text);
    r = await call('PUT', '/api/notificationsettings/sms', good);
    check('the settings are saved; the API key is never returned', r.status === 200 && r.body.apiKeySet === true && !r.text.includes('k-123')
      && r.body.provider === 'HTTP' && r.body.url === good.url && r.body.senderId === 'CITYSACCO', r.text);
    r = await call('POST', '/api/notificationsettings/sms:test', { to: '0712 000 111' });
    let sent = outbox.pop();
    check('a test SMS reaches the gateway in its shape: E.164, sender, key in the header', r.status === 200 && r.body.ok === true && sent?.body?.to === '+254712000111'
      && sent.body.from === 'CITYSACCO' && sent.headers['x-api-key'] === 'k-123' && /Test SMS/.test(sent.body.message), `${r.text} ${JSON.stringify(sent)}`);
    r = await call('POST', '/api/notificationsettings/sms:test', { to: '0712 000 111', settings: { url: 'https://gateway.elsewhere.test/send' } });
    const r2 = await call('PUT', '/api/notificationsettings/sms', { ...good, apiKey: undefined, url: 'https://gateway.elsewhere.test/send' });
    check('the stored key goes to no other gateway: a new address needs it again', r.status === 400 && /REQUIRED/.test(r.reason) && r2.status === 400, `${r.text} ${r2.text}`);
    answer = { status: 401, body: { error: 'bad key' } };
    r = await call('POST', '/api/notificationsettings/sms:test', { to: '0712000111' });
    check('a refused key is named', r.body?.ok === false && r.body.failureReason === 'INVALID_SMS_GATEWAY_CREDENTIALS', r.text);
    answer = { status: 200 };
    process.env.CALLBACK_ALLOW_PRIVATE = 'false';
    r = await call('POST', '/api/notificationsettings/sms:test', { to: '0712000111', settings: { url: 'https://127.0.0.1/send', apiKey: 'k-123' } });
    process.env.CALLBACK_ALLOW_PRIVATE = 'true';
    check('a gateway on a private address is refused', (r.status === 400 && /PUBLIC/.test(r.reason)) || (r.body?.ok === false && /PRIVATE|PUBLIC/.test(r.body.failureCause)), r.text);
    check('a manager reads the settings; a teller does not; only an administrator changes them',
      (await call('GET', '/api/notificationsettings/sms', null, { who: 'manager' })).status === 200
      && (await call('GET', '/api/notificationsettings/sms', null, { who: 'teller' })).status === 403
      && (await call('PUT', '/api/notificationsettings/sms', good, { who: 'manager' })).status === 403);
    outbox.length = 0;

    // ------------------------------------------------------------------------
    section('templates of type SMS');
    const tpl = { name: 'Deposit SMS', type: 'SMS', event: 'SAVINGS_DEPOSIT', recipient: 'CLIENT', body: 'Dear {{FIRST_NAME}}, we received KES {{TRANSACTION_AMOUNT}} on {{ACCOUNT_ID}}.' };
    r = await call('POST', '/api/templates', { ...tpl, recipient: 'CREDIT_OFFICER' });
    check('an SMS does not go to credit officers (no phone on record)', r.status === 400 && /RECIPIENT/.test(r.reason), r.text);
    r = await call('POST', '/api/templates', { ...tpl, body: 'x'.repeat(919) });
    check('an SMS longer than six segments is refused', r.status === 400 && /SMS_TEXT_TOO_LONG/.test(r.reason), r.text);
    r = await call('POST', '/api/templates', tpl);
    const smsTpl = r.body;
    check('an SMS template: plain text, its segments shown', r.status === 201 && smsTpl.type === 'SMS' && smsTpl.contentType === 'PLAIN_TEXT' && smsTpl.segments >= 1
      && !smsTpl.subject && !smsTpl.signingSecret, r.text);

    section('delivery');
    await deposit(sav1, 1000);
    await run();
    let msgs = await messages();
    check('with SMS off, the message fails with the reason', msgs.length === 1 && msgs[0].state === 'FAILED' && msgs[0].failure_reason === 'SMS_SERVICE_NOT_ENABLED' && !outbox.length,
      JSON.stringify(msgs.map((m) => [m.state, m.failure_reason])));
    await call('PUT', '/api/notificationsettings/sms', { ...good, apiKey: undefined, enabled: true });
    await T((c) => c.query('DELETE FROM notification_messages'));
    await deposit(sav1, 2000);
    await run();
    msgs = await messages();
    sent = outbox.pop();
    check('a deposit texts the member, filled, to the number in E.164', sent?.body?.to === '+254712345678' && /Dear Amina, we received KES 2000.00 on/.test(sent.body.message)
      && sent.body.ref === msgs[0]?.idempotency_key, JSON.stringify(sent?.body));
    check('the message is SENT with the gateway\'s message ID and its segments', msgs.length === 1 && msgs[0].state === 'SENT' && /^gw-/.test(msgs[0].provider_message_id || '')
      && msgs[0].segments === 1 && msgs[0].destination === '+254712345678', JSON.stringify(msgs[0]));
    const pmid = msgs[0].provider_message_id;
    await deposit(sav2, 500);
    await run();
    msgs = (await messages()).filter((m) => m.member_id === m2.id);
    check('no phone number: MISSING_SMS_RECIPIENT, nothing sent', msgs.length === 1 && msgs[0].failure_reason === 'MISSING_SMS_RECIPIENT' && !outbox.length,
      JSON.stringify(msgs.map((m) => [m.state, m.failure_reason])));
    await T((c) => c.query("UPDATE members SET phone = '12' WHERE id = $1", [m2.id]));
    await deposit(sav2, 600);
    await run();
    msgs = (await messages()).filter((m) => m.member_id === m2.id);
    check('a number that cannot be read: UNDEFINED_DESTINATION', msgs.some((m) => m.failure_reason === 'UNDEFINED_DESTINATION'), JSON.stringify(msgs.map((m) => m.failure_reason)));
    await call('PUT', `/api/clients/${m1.id}/notification-subscriptions/${smsTpl.id}`, { subscribed: false });
    await deposit(sav1, 3000);
    await run();
    check('an unsubscribed member gets no SMS', !outbox.length);
    await call('PUT', `/api/clients/${m1.id}/notification-subscriptions/${smsTpl.id}`, { subscribed: true });
    await T((c) => c.query('DELETE FROM notification_messages'));
    answer = { status: 503, body: { error: 'busy' } };
    await deposit(sav1, 4000);
    await run();
    msgs = await messages();
    check('a gateway error (5xx) is retried later', msgs.length === 1 && msgs[0].state === 'QUEUED' && msgs[0].failure_reason === 'SMS_GATEWAY_ERROR' && msgs[0].num_retries === 1,
      JSON.stringify(msgs.map((m) => [m.state, m.failure_reason, m.failure_cause])));
    answer = { status: 400, body: { error: 'invalid number' } };
    await T((c) => c.query("UPDATE notification_messages SET next_attempt_at = now() WHERE state = 'QUEUED'"));
    await run();
    msgs = await messages();
    check('a refused request (4xx) fails at once', msgs[0].state === 'FAILED' && /400/.test(msgs[0].failure_cause), JSON.stringify(msgs.map((m) => [m.state, m.failure_cause])));
    answer = { status: 200, body: { data: { status: 'rejected' } } };
    await call('PUT', '/api/notificationsettings/sms', { ...good, apiKey: undefined, enabled: true, successPath: 'data.status', successValue: 'queued' });
    await T((c) => c.query('DELETE FROM notification_messages'));
    await deposit(sav1, 4500);
    await run();
    msgs = await messages();
    check('a 2xx answer without the success value is a failure', msgs[0]?.state === 'FAILED' && msgs[0].failure_reason === 'SMS_GATEWAY_ERROR', JSON.stringify(msgs.map((m) => [m.state, m.failure_cause])));
    answer = { status: 200 };
    outbox.length = 0;

    section('delivery reports');
    await T((c) => c.query('DELETE FROM notification_messages'));
    await deposit(sav1, 5000); await deposit(sav1, 5100);
    await run();
    msgs = await messages();
    const [a1, a2] = msgs.map((m) => m.provider_message_id);
    check('two messages sent with their gateway IDs', msgs.length === 2 && a1 && a2 && a1 !== a2, JSON.stringify(msgs.map((m) => m.provider_message_id)));
    r = await call('POST', '/api/notificationsettings/sms:callbackToken');
    const cb = r.body?.callbackUrl || '';
    check('an administrator makes the delivery report address, shown once, over https', r.status === 200 && new RegExp(`^https://[^/]+/hooks/sms/${SLUG}/[A-Za-z0-9_-]{30,}$`).test(cb), r.text);
    check('a manager does not', (await call('POST', '/api/notificationsettings/sms:callbackToken', null, { who: 'manager' })).status === 403);
    r = await call('GET', '/api/notificationsettings/sms');
    check('the settings say a report address is set, not what it is', r.body.deliveryReportsEnabled === true && !r.text.includes(cb.split('/').pop()), r.text);
    await call('PUT', '/api/notificationsettings/sms', { ...good, apiKey: undefined, enabled: true, dlrIdPath: 'id', dlrStatusPath: 'status',
      deliveredValues: 'DELIVERED, DeliveredToTerminal', undeliveredValues: 'FAILED, Rejected' });
    const path = new URL(cb).pathname;
    // The address is https for the gateway; this test calls the server here directly.
    const hook = (body, { form = false, p = path } = {}) => fetch(`http://localhost:${PORT}${p}`, {
      method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }).then((x) => x.status);
    let s1 = await hook({ id: a1, status: 'DeliveredToTerminal' });
    let s2 = await hook({ id: a2, status: 'Rejected', reason: 'absent subscriber' }, { form: true });
    msgs = await messages();
    const byId = Object.fromEntries(msgs.map((m) => [m.provider_message_id, m]));
    check('a JSON report marks a message delivered', s1 === 200 && byId[a1].delivery_status === 'DELIVERED' && byId[a1].delivered_at, `${s1} ${JSON.stringify(byId[a1])}`);
    check('a form report marks one undelivered', s2 === 200 && byId[a2].delivery_status === 'UNDELIVERED', `${s2} ${JSON.stringify(byId[a2])}`);
    s1 = await hook({ id: 'gw-unknown', status: 'DELIVERED' });
    check('a report for an unknown message is accepted and ignored', s1 === 200);
    s1 = await hook({ id: a2, status: 'DELIVERED' }, { p: path.replace(/[^/]+$/, 'not-the-token-at-all-xxxxxxxxxxxxxxxxxx') });
    msgs = await messages();
    check('a report with a wrong token is refused and changes nothing', s1 === 404 && msgs.find((m) => m.provider_message_id === a2).delivery_status === 'UNDELIVERED', String(s1));
    r = await call('POST', '/api/communications/messages:search?detailsLevel=FULL', [{ field: 'type', operator: 'EQUALS', value: 'SMS' }]);
    check('the communication log shows the delivery status', r.status === 200 && r.body.some((m) => m.deliveryStatus === 'DELIVERED') && r.body.some((m) => m.deliveryStatus === 'UNDELIVERED'), r.text);
    r = await call('POST', '/api/notificationsettings/sms:callbackToken');
    s1 = await hook({ id: a1, status: 'DELIVERED' });
    check('a new report address retires the old one', r.status === 200 && s1 === 404, String(s1));
    outbox.length = 0;

    // ------------------------------------------------------------------------
    section('manual SMS (/api/communications/messages:sendSms)');
    r = await call('POST', '/api/communications/messages:sendSms', { clientKey: m1.id, body: 'Hello {{FIRST_NAME}}, your statement is ready.' });
    sent = outbox.pop();
    check('free text to a member, filled, sent at once', r.status === 201 && r.body.type === 'SMS' && r.body.state === 'SENT' && sent?.body?.message === 'Hello Amina, your statement is ready.', r.text);
    r = await call('POST', '/api/communications/messages:sendSms', { depositAccountKey: sav1.id, templateKey: smsTpl.id });
    sent = outbox.pop();
    check('a template from a deposit account, to the holder', r.status === 201 && /Dear Amina/.test(sent?.body?.message || ''), r.text);
    r = await call('POST', '/api/communications/messages:sendSms', { clientKey: m2.id, body: 'Hi' });
    check('a holder whose number cannot be read is refused', r.status === 400 && /UNDEFINED_DESTINATION|MISSING_SMS_RECIPIENT/.test(r.reason), r.text);
    r = await call('POST', '/api/communications/messages:sendSms', { clientKey: m1.id, body: 'x'.repeat(1000) });
    check('a manual SMS over six segments is refused', r.status === 400 && /SMS_TEXT_TOO_LONG/.test(r.reason), r.text);
    check('a teller without SEND_MANUAL_SMS is refused', (await call('POST', '/api/communications/messages:sendSms', { clientKey: m1.id, body: 'x' }, { who: 'teller' })).status === 403);
    r = await call('POST', '/api/communications/messages:sendSms', { clientKey: m1.id, body: 'From the sender' }, { who: 'sender' });
    check('a user with SEND_MANUAL_SMS sends', r.status === 201 && r.body.state === 'SENT', r.text);
    r = await call('POST', '/api/communications/messages:sendSms', { clientKey: m1.id, templateKey: smsTpl.id, body: 'changed' }, { who: 'sender' });
    check('changing a template\'s text before sending needs EDIT_COMMUNICATION_TEMPLATES', r.status === 403, r.text);
    r = await call('GET', '/api/communications/sms-templates', null, { who: 'sender' });
    check('a sender lists the active SMS templates with their segments', r.status === 200 && r.body.some((x) => x.id === smsTpl.id && x.segments >= 1), r.text);

    // ------------------------------------------------------------------------
    section('resends and GET gateways');
    const long = await T((c) => D.queueSms(c, { e: { event: 'MANUAL_SMS', member_id: m1.id }, to: '0712345678', text: 'x'.repeat(1000), manual: true, actor: 'test' }));
    check('a text over six segments is failed when queued', long.state === 'FAILED' && long.failure_reason === 'MAX_MESSAGE_SIZE_LIMIT_EXCEEDED');
    r = await call('POST', '/api/communications/messages:resend', { messages: [long.id] });
    outbox.length = 0;
    await run();
    const { rows: [again] } = await T((c) => c.query('SELECT * FROM notification_messages WHERE id = $1', [long.id]));
    check('resent, it is checked again and not sent', r.status < 300 && again.state === 'FAILED' && again.failure_reason === 'MAX_MESSAGE_SIZE_LIMIT_EXCEEDED' && !outbox.length,
      `${r.text} ${again.state} ${again.failure_reason}`);
    await call('PUT', '/api/notificationsettings/sms', { ...good, apiKey: undefined, enabled: true, method: 'GET', bodyTemplate: 'to={{to}}&msg={{text}}&from={{from}}' });
    r = await call('POST', '/api/communications/messages:sendSms', { clientKey: m1.id, body: 'ł'.repeat(400) });
    sent = outbox.pop();
    check('a GET gateway takes a six-segment UCS-2 text in its query', r.status === 201 && r.body.state === 'SENT' && sent?.method === 'GET'
      && new URL(sent.url, 'http://x').searchParams.get('msg') === 'ł'.repeat(400) && new URL(sent.url, 'http://x').searchParams.get('to') === '+254712345678', `${r.text}`);
    await call('PUT', '/api/notificationsettings/sms', { ...good, apiKey: undefined, enabled: true });

    section('the member portal');
    await call('POST', '/api/portal/auth/activate', { memberNo: m1.member_no || m1.memberNo, nationalId: '12345678', phone: '0712345678', pin: '2580' }, { who: 'nobody' });
    const MT = (await call('POST', '/api/portal/auth/login', { phone: '0712345678', pin: '2580' }, { who: 'nobody' })).body?.accessToken;
    r = await call('GET', '/api/portal/notifications', null, { token: MT });
    check('the member sees the SMS template, marked as SMS', r.status === 200 && r.body.some((x) => x.templateKey === smsTpl.id && x.channel === 'SMS'), r.text);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server.close(); gateway.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
