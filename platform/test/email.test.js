#!/usr/bin/env node
'use strict';

/**
 * Email after the reference platform (docs/audits/audit-email.md): each
 * SACCO's SMTP settings and the test, templates of type EMAIL with
 * recipients and subscriptions, delivery and its outcomes, manual email,
 * and subscriptions changed by staff and by members in the portal.
 *
 * Mail goes to SMTP servers run inside this test (smtp-server), over
 * STARTTLS and implicit TLS with a test-only certificate, so nothing leaves
 * the machine.
 */

const path = require('path');
const fs = require('fs');

process.env.CALLBACK_ALLOW_PRIVATE = 'true';
process.env.NOTIFY_AFTER_REQUEST = 'off';
process.env.SMTP_ALLOWED_PORTS = '465,587,2465,2587';
process.env.SMTP_EXTRA_CA_FILE = path.join(__dirname, 'fixtures', 'smtp-test-cert.pem');
process.env.SMTP_TIMEOUT_MS = '4000';

const { SMTPServer } = require('smtp-server');
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

const SLUG = 'emtest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4129;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// --- the SMTP servers -----------------------------------------------------------
const inbox = [];
let mode = 'ok'; // ok | temp | perm
const SMTP_USER = 'sacco-mailer';
const SMTP_PASS = 'smtp secret 2026';
function smtp(port, secure) {
  const server = new SMTPServer({
    secure, key: fs.readFileSync(path.join(__dirname, 'fixtures', 'smtp-test-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'smtp-test-cert.pem')),
    authMethods: ['PLAIN', 'LOGIN'], logger: false, disabledCommands: [],
    onAuth(auth, session, cb) {
      if (!session.secure) return cb(new Error('TLS first'));
      if (auth.username === SMTP_USER && auth.password === SMTP_PASS) return cb(null, { user: auth.username });
      return cb(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
    },
    onRcptTo(address, session, cb) {
      if (mode === 'temp') return cb(Object.assign(new Error('Mailbox busy, try later'), { responseCode: 451 }));
      if (mode === 'perm') return cb(Object.assign(new Error('No such mailbox'), { responseCode: 550 }));
      return cb();
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('end', () => {
        inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), from: session.envelope.mailFrom.address, raw: Buffer.concat(chunks).toString('utf8'), secure: session.secure, port });
        cb();
      });
    },
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}
const header = (raw, name) => (new RegExp(`^${name}: (.*(?:\\r?\\n[ \\t].*)*)`, 'mi').exec(raw)?.[1] || '').replace(/\r?\n[ \t]/g, ' ');
// Quoted-printable and soft breaks undone, enough to search a body.
const textOf = (raw) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const tokens = {};
async function call(method, p, body, { who = 'admin', token = null } = {}) {
  const headers = { 'x-tenant': SLUG };
  const tok = token || tokens[who];
  if (tok) headers.authorization = `Bearer ${tok}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
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
  const starttls = await smtp(2587, false);
  const implicit = await smtp(2465, true);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Mail SACCO', mfaRequiredRoles: [], adminEmail: 'admin@em.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@em.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@em.local`, fullName: `The ${who}`, password: PW, branchId: 'HQ', ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@em.local`);
    };
    await mk('manager', { role: 'MANAGER' });
    await mk('teller', { role: 'TELLER' });
    await mk('sender', { role: 'TELLER', permissions: ['SEND_MANUAL_EMAIL'] });
    await mk('officer', { role: 'TELLER', userType: 'CREDIT_OFFICER' });
    const m1 = (await call('POST', '/api/members', { firstName: 'Amina', lastName: 'Otieno', branchId: 'HQ', email: 'amina@members.test',
      phone: '0712345678', nationalId: '12345678', creditOfficer: 'officer@em.local' })).body;
    const m2 = (await call('POST', '/api/members', { firstName: 'Baraka', lastName: 'NoMail', branchId: 'HQ' })).body;
    const sav1 = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    const sav2 = (await call('POST', '/api/savings', { memberId: m2.id, productId: 'SAV01' })).body;
    check('members and deposit accounts', m1?.id && m2?.id && sav1?.id && sav2?.id, JSON.stringify(m1));
    const D = require('../src/domain/notifications/dispatch');
    const run = () => D.runTenant(SCHEMA);
    const deposit = (sav, amount) => call('POST', `/api/savings/${sav.id}/deposits`, { amount, channelId: 'cash' });
    const messages = async () => (await T((c) => c.query("SELECT * FROM notification_messages WHERE type = 'EMAIL' ORDER BY created_at, id"))).rows;

    // ------------------------------------------------------------------------
    section('settings (/api/notificationsettings/email)');
    let r = await call('GET', '/api/notificationsettings/email');
    check('the settings start empty and switched off', r.status === 200 && r.body.enabled === false && !r.body.host && r.body.passwordSet === false
      && r.body.pacePerMinute === 60, r.text);
    const good = { enabled: false, fromName: 'Mail SACCO', fromEmail: 'noreply@mail-sacco.test', replyTo: 'help@mail-sacco.test', host: 'localhost',
      port: 2587, encryption: 'STARTTLS', username: SMTP_USER, password: SMTP_PASS };
    r = await call('PUT', '/api/notificationsettings/email', { ...good, port: 25 });
    check('a port other than 465 or 587 is refused', r.status === 400 && /SMTP_PORT/.test(r.reason), r.text);
    r = await call('PUT', '/api/notificationsettings/email', { ...good, encryption: 'NONE' });
    check('mail without TLS is refused', r.status === 400 && /ENCRYPTION/.test(r.reason), r.text);
    r = await call('PUT', '/api/notificationsettings/email', { ...good, fromEmail: 'not an address' });
    check('a From Email that is not an address is refused', r.status === 400 && /FROM_EMAIL/.test(r.reason), r.text);
    r = await call('PUT', '/api/notificationsettings/email', good);
    check('the settings are saved; the password is never returned', r.status === 200 && r.body.passwordSet === true && !('password' in r.body)
      && !r.text.includes(SMTP_PASS) && r.body.host === 'localhost', r.text);
    const { rows: [ch] } = await T((c) => c.query("SELECT * FROM notification_channels WHERE channel = 'EMAIL'"));
    check('the password is stored sealed', ch && /^v1:/.test(ch.secret || '') && !JSON.stringify(ch.settings).includes(SMTP_PASS), JSON.stringify(ch));
    r = await call('PUT', '/api/notificationsettings/email', { ...good, password: undefined, fromName: 'Mail SACCO Ltd' });
    check('a save without a password keeps the stored one', r.status === 200 && r.body.passwordSet === true && r.body.fromName === 'Mail SACCO Ltd', r.text);

    r = await call('POST', '/api/notificationsettings/email:test', { to: 'admin@mail-sacco.test' });
    const t1 = inbox.pop();
    check('a test email over STARTTLS', r.status === 200 && r.body.ok === true && t1?.to[0] === 'admin@mail-sacco.test' && t1.secure
      && /Mail SACCO Ltd/.test(header(t1.raw, 'From')) && /noreply@mail-sacco.test/.test(header(t1.raw, 'From'))
      && /help@mail-sacco.test/.test(header(t1.raw, 'Reply-To')), `${r.text} ${JSON.stringify(t1)}`);
    r = await call('POST', '/api/notificationsettings/email:test', { to: 'admin@mail-sacco.test', settings: { port: 2465, encryption: 'SSL_TLS', password: SMTP_PASS } });
    const t2 = inbox.pop();
    check('a test with unsaved settings, over implicit TLS, saves nothing', r.status === 200 && r.body.ok && t2?.port === 2465
      && (await call('GET', '/api/notificationsettings/email')).body.port === 2587, r.text);
    r = await call('POST', '/api/notificationsettings/email:test', { to: 'admin@mail-sacco.test', settings: { password: 'wrong one' } });
    check('a refused sign-in is named', r.status === 200 && r.body.ok === false && r.body.failureReason === 'INVALID_SMTP_CREDENTIALS', r.text);
    process.env.CALLBACK_ALLOW_PRIVATE = 'false';
    r = await call('POST', '/api/notificationsettings/email:test', { to: 'admin@mail-sacco.test', settings: { host: '127.0.0.1', password: SMTP_PASS } });
    const r2 = await call('POST', '/api/notificationsettings/email:test', { to: 'admin@mail-sacco.test', settings: { host: 'localhost', password: SMTP_PASS } });
    process.env.CALLBACK_ALLOW_PRIVATE = 'true';
    check('an SMTP host on a private address is refused, by address or by name', r.body?.ok === false && /PRIVATE|PUBLIC/.test(r.body.failureCause || r.reason)
      && r2.body?.ok === false && /PRIVATE|PUBLIC/.test(r2.body.failureCause || r2.reason), `${r.text} ${r2.text}`);
    r = await call('POST', '/api/notificationsettings/email:test', { to: 'admin@mail-sacco.test', settings: { host: 'mx.elsewhere.test' } });
    const r4 = await call('PUT', '/api/notificationsettings/email', { ...good, password: undefined, host: 'mx.elsewhere.test' });
    const r5 = await call('PUT', '/api/notificationsettings/email', { ...good, password: undefined, username: 'someone-else' });
    check('the stored password goes to no other server: a new host or username needs it typed again', r.status === 400 && /PASSWORD_REQUIRED/.test(r.reason)
      && r4.status === 400 && /PASSWORD_REQUIRED/.test(r4.reason) && r5.status === 400, `${r.text} ${r4.text} ${r5.text}`);
    check('a manager reads the settings; a teller does not', (await call('GET', '/api/notificationsettings/email', null, { who: 'manager' })).status === 200
      && (await call('GET', '/api/notificationsettings/email', null, { who: 'teller' })).status === 403);
    check('only an administrator changes or tests them', (await call('PUT', '/api/notificationsettings/email', good, { who: 'manager' })).status === 403
      && (await call('POST', '/api/notificationsettings/email:test', { to: 'x@y.test' }, { who: 'manager' })).status === 403);

    // ------------------------------------------------------------------------
    section('rendering');
    const R = require('../src/domain/notifications/render');
    check('an HTML body escapes its values', R.fill('<p>{{X}}</p>', { X: '<script>alert(1)</script> & "q"' }, 'HTML') === '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p>');
    check('a subject has no line breaks once filled', R.subject('Hi {{X}}', { X: 'a\r\nBcc: evil@x.test' }) === 'Hi a Bcc: evil@x.test');
    let threw = null;
    try { R.textOf('<p>&#x110000; &#99999999999; &#xD800; &#65;</p>'); } catch (e) { threw = e; }
    check('a character reference to no character does not stop the plain-text part', !threw && R.textOf('&#x110000;&#65;') === '\ufffdA', String(threw));
    check('a plain-text part is made from the HTML', R.textOf('<p>Dear <b>Amina</b>,</p><p>Paid &amp; done</p>').trim() === 'Dear Amina,\n\nPaid & done');

    // ------------------------------------------------------------------------
    section('templates of type EMAIL');
    const tplBody = { name: 'Deposit receipt', type: 'EMAIL', event: 'SAVINGS_DEPOSIT', recipient: 'CLIENT',
      subject: 'Deposit of {{TRANSACTION_AMOUNT}} for {{FIRST_NAME}}', body: '<p>Dear {{FIRST_NAME}},</p><p>We received {{TRANSACTION_AMOUNT}} on {{ACCOUNT_ID}}.</p>' };
    r = await call('POST', '/api/templates', { ...tplBody, subject: '' });
    check('an email needs a subject', r.status === 400 && /SUBJECT_REQUIRED/.test(r.reason), r.text);
    r = await call('POST', '/api/templates', { ...tplBody, recipient: 'EVERYONE' });
    check('an unknown recipient is refused', r.status === 400 && /RECIPIENT/.test(r.reason), r.text);
    r = await call('POST', '/api/templates', { ...tplBody, recipient: 'GROUP_ROLE' });
    check('a group role recipient needs the role', r.status === 400 && /RECIPIENT_ROLE/.test(r.reason), r.text);
    r = await call('POST', '/api/templates', { ...tplBody, subject: 'x'.repeat(256) });
    check('a subject is at most 255 characters', r.status === 400 && /SUBJECT/.test(r.reason), r.text);
    r = await call('POST', '/api/templates', { ...tplBody, event: 'END_OF_DAY_PROCESSING_COMPLETED' });
    check('an email is for an event with a member, group or account', r.status === 400 && /TARGET/.test(r.reason), r.text);
    r = await call('POST', '/api/templates', { ...tplBody, body: '<p title={{FIRST_NAME}}>x</p>' });
    const r6 = await call('POST', '/api/templates', { ...tplBody, body: '<a href="{{EMAIL_ADDRESS}}">x</a>' });
    check('a placeholder in an unquoted attribute, or starting a link, is refused', r.status === 400 && /QUOTED/.test(r.reason) && r6.status === 400 && /LINK/.test(r6.reason), `${r.text} ${r6.text}`);
    r = await call('POST', '/api/templates', tplBody);
    const receipt = r.body;
    check('an EMAIL template: subject, recipient, HTML body, no URL or signing secret', r.status === 201 && receipt.type === 'EMAIL' && receipt.subject === tplBody.subject
      && receipt.recipient === 'CLIENT' && receipt.contentType === 'HTML' && !receipt.signingSecret && !receipt.url, r.text);
    r = await call('GET', '/api/templates?type=EMAIL');
    check('listed by type', r.status === 200 && r.body.length === 1 && r.body[0].id === receipt.id, r.text);
    r = await call('PATCH', `/api/templates/${receipt.id}`, [{ op: 'REPLACE', path: '/subject', value: 'Deposit {{TRANSACTION_AMOUNT}} received, {{FIRST_NAME}}' }]);
    check('the subject is patched', r.status === 200 && /received/.test(r.body.subject), r.text);
    const officerTpl = (await call('POST', '/api/templates', { name: 'Officer copy', type: 'EMAIL', event: 'SAVINGS_DEPOSIT', recipient: 'CREDIT_OFFICER',
      subject: '{{CLIENT_NAME}} deposited', body: '<p>{{CLIENT_NAME}} deposited {{TRANSACTION_AMOUNT}}</p>' })).body;
    check('a template for the credit officer', officerTpl?.recipient === 'CREDIT_OFFICER', JSON.stringify(officerTpl));

    section('delivery');
    await deposit(sav1, 1000);
    await run();
    let msgs = await messages();
    check('nothing is sent while the switch is off: the messages fail with the reason', msgs.length === 2 && msgs.every((m) => m.state === 'FAILED'
      && m.failure_reason === 'EMAIL_SERVICE_NOT_ENABLED') && inbox.length === 0, JSON.stringify(msgs.map((m) => [m.state, m.failure_reason])));
    await call('PUT', '/api/notificationsettings/email', { ...good, password: undefined, enabled: true });
    await T((c) => c.query('DELETE FROM notification_messages'));
    await deposit(sav1, 2000);
    await run();
    msgs = await messages();
    const toMember = inbox.find((x) => x.to[0] === 'amina@members.test');
    const toOfficer = inbox.find((x) => x.to[0] === 'officer@em.local');
    check('a deposit emails the member, with the subject and body filled', toMember && header(toMember.raw, 'Subject') === 'Deposit 2000.00 received, Amina'
      && /We received 2000.00 on/.test(textOf(toMember.raw)) && /text\/plain/.test(toMember.raw) && /text\/html/.test(toMember.raw), JSON.stringify(inbox.map((x) => x.to)));
    check('and the credit officer', toOfficer && header(toOfficer.raw, 'Subject') === 'Amina Otieno deposited', JSON.stringify(inbox.map((x) => x.to)));
    check('the log has both as EMAIL messages, sent, with destination and subject', msgs.length === 2 && msgs.every((m) => m.state === 'SENT' && m.content_type === 'HTML')
      && msgs.some((m) => m.destination === 'amina@members.test' && /received/.test(m.subject)), JSON.stringify(msgs.map((m) => [m.state, m.destination, m.failure_reason, m.failure_cause])));
    r = await call('POST', '/api/communications/messages:search?detailsLevel=FULL', [{ field: 'type', operator: 'EQUALS', value: 'EMAIL' }]);
    check('the communication log shows them with the subject', r.status === 200 && r.body.length === 2 && r.body.every((m) => m.type === 'EMAIL' && m.subject), r.text);
    inbox.length = 0;

    await deposit(sav2, 500);
    await run();
    msgs = (await messages()).filter((m) => m.member_id === m2.id);
    check('a member with no address: failed as MISSING_EMAIL_RECIPIENT, nothing sent', msgs.some((m) => m.state === 'FAILED' && m.failure_reason === 'MISSING_EMAIL_RECIPIENT')
      && !inbox.some((x) => x.to[0] !== 'officer@em.local'), JSON.stringify(msgs.map((m) => [m.state, m.failure_reason])));
    inbox.length = 0;

    section('subscriptions');
    r = await call('GET', `/api/clients/${m1.id}/notification-subscriptions`);
    const subRow = r.body?.find?.((x) => x.templateKey === receipt.id);
    check('a member\'s subscriptions: each email template with its option, subscribed by default when opt-out', r.status === 200 && subRow?.subscribed === true
      && subRow.subscriptionOption === 'OPT_OUT' && subRow.channel === 'EMAIL' && !r.body.some((x) => x.templateKey === officerTpl.id), r.text);
    r = await call('PUT', `/api/clients/${m1.id}/notification-subscriptions/${receipt.id}`, { subscribed: false });
    check('staff unsubscribe a member', r.status === 200 && r.body.subscribed === false, r.text);
    await deposit(sav1, 3000);
    await run();
    check('an unsubscribed member gets no automatic email; the officer still does', !inbox.some((x) => x.to[0] === 'amina@members.test')
      && inbox.some((x) => x.to[0] === 'officer@em.local'), JSON.stringify(inbox.map((x) => x.to)));
    inbox.length = 0;
    const optIn = (await call('POST', '/api/templates', { name: 'Large deposits', type: 'EMAIL', event: 'SAVINGS_DEPOSIT', recipient: 'CLIENT', subscriptionOption: 'OPT_IN',
      subject: 'Large deposit', body: '<p>{{TRANSACTION_AMOUNT}}</p>' })).body;
    await deposit(sav1, 4000);
    await run();
    check('an opt-in template sends only to those subscribed', !inbox.some((x) => header(x.raw, 'Subject') === 'Large deposit'));
    await call('PUT', `/api/clients/${m1.id}/notification-subscriptions/${optIn.id}`, { subscribed: true });
    inbox.length = 0;
    await deposit(sav1, 5000);
    await run();
    check('and does once the member is subscribed', inbox.some((x) => header(x.raw, 'Subject') === 'Large deposit' && x.to[0] === 'amina@members.test'), JSON.stringify(inbox.map((x) => header(x.raw, 'Subject'))));
    check('a group\'s subscriptions are not reached through /clients, nor a member\'s through /groups', (await call('GET', `/api/groups/${m1.id}/notification-subscriptions`)).status === 404);
    check('a teller does not change subscriptions', (await call('PUT', `/api/clients/${m1.id}/notification-subscriptions/${optIn.id}`, { subscribed: false }, { who: 'teller' })).status === 403);
    inbox.length = 0;

    section('group roles');
    await call('POST', '/api/group-role-names', { id: 'chair', name: 'Chairperson' });
    const grp = (await call('POST', '/api/groups', { groupName: 'Umoja', assignedBranchKey: 'HQ', groupMembers: [{ clientKey: m1.id, roles: [{ groupRoleNameKey: 'chair' }] }, { clientKey: m2.id }] })).body;
    await T((c) => c.query("UPDATE savings_products SET available_for = ARRAY['INDIVIDUALS', 'GROUPS'] WHERE id = 'SAV01'"));
    const gsav = (await call('POST', '/api/savings', { memberId: grp?.encodedKey, productId: 'SAV01' })).body;
    check('a group with a chairperson, and its deposit account', grp?.encodedKey && gsav?.id, `${JSON.stringify(grp)} ${JSON.stringify(gsav)}`);
    r = await call('POST', '/api/templates', { name: 'Group deposits', type: 'EMAIL', event: 'SAVINGS_DEPOSIT', recipient: 'GROUP_ROLE', recipientRole: 'nobody',
      subject: 'Group deposit', body: '<p>{{GROUP_NAME}}: {{TRANSACTION_AMOUNT}}</p>' });
    check('an unknown group role is refused', r.status === 400 && /RECIPIENT_ROLE/.test(r.reason), r.text);
    r = await call('POST', '/api/templates', { name: 'Group deposits', type: 'EMAIL', event: 'SAVINGS_DEPOSIT', recipient: 'GROUP_ROLE', recipientRole: 'chair',
      subject: 'Group deposit', body: '<p>{{GROUP_NAME}}: {{TRANSACTION_AMOUNT}}</p>' });
    check('a template for the group\'s chairperson', r.status === 201 && r.body.recipientRole === 'chair', r.text);
    await deposit(gsav, 700);
    await run();
    const g = inbox.filter((x) => header(x.raw, 'Subject') === 'Group deposit');
    check('a group\'s deposit emails the members holding the role, and no one else', g.length === 1 && g[0].to[0] === 'amina@members.test' && /Umoja: 700.00/.test(textOf(g[0].raw)),
      JSON.stringify(inbox.map((x) => [x.to, header(x.raw, 'Subject')])));
    inbox.length = 0;
    await T((c) => c.query("UPDATE notification_templates SET activated = false WHERE name IN ('Group deposits', 'Large deposits')"));
    await call('PUT', `/api/clients/${m1.id}/notification-subscriptions/${receipt.id}`, { subscribed: true });

    section('failures, retries and pace');
    await T((c) => c.query('DELETE FROM notification_messages'));
    mode = 'temp';
    await deposit(sav1, 6000);
    await run();
    msgs = await messages();
    check('a temporary refusal (4xx) is retried later', msgs.length === 2 && msgs.every((m) => m.state === 'QUEUED' && m.num_retries === 1 && m.failure_reason === 'MESSAGING_EXCEPTION'
      && /451/.test(m.failure_cause) && new Date(m.next_attempt_at) > new Date()), JSON.stringify(msgs.map((m) => [m.state, m.num_retries, m.failure_reason, m.failure_cause])));
    mode = 'perm';
    await T((c) => c.query("UPDATE notification_messages SET next_attempt_at = now() WHERE state = 'QUEUED'"));
    await run();
    msgs = await messages();
    check('a permanent refusal (5xx) fails at once', msgs.every((m) => m.state === 'FAILED' && /550/.test(m.failure_cause)), JSON.stringify(msgs.map((m) => [m.state, m.failure_cause])));
    mode = 'ok';
    await T((c) => c.query("UPDATE notification_channels SET secret = $1 WHERE channel = 'EMAIL'", [require('../src/domain/notifications/secrets').seal('wrong')]));
    await T((c) => c.query('DELETE FROM notification_messages'));
    await deposit(sav1, 6500);
    await run();
    msgs = await messages();
    check('a refused sign-in fails at once as INVALID_SMTP_CREDENTIALS', msgs.length === 2 && msgs.every((m) => m.state === 'FAILED' && m.failure_reason === 'INVALID_SMTP_CREDENTIALS'),
      JSON.stringify(msgs.map((m) => [m.state, m.failure_reason, m.failure_cause])));
    r = await call('POST', '/api/notificationsettings/email:test', { to: 'admin@mail-sacco.test', settings: { password: SMTP_PASS } });
    await call('PUT', '/api/notificationsettings/email', { ...good, enabled: true });
    r = await call('POST', '/api/communications/messages:resend', { messages: msgs.map((m) => m.id) });
    await D.runTenant(SCHEMA);
    msgs = await messages();
    check('once the password is fixed, failed emails are resent', r.status < 300 && msgs.every((m) => m.state === 'SENT'), JSON.stringify(msgs.map((m) => [m.state, m.failure_reason])));
    inbox.length = 0;
    await call('PUT', '/api/notificationsettings/email', { ...good, password: undefined, enabled: true, pacePerMinute: 3 });
    await T((c) => c.query('DELETE FROM notification_messages'));
    await deposit(sav1, 100); await deposit(sav1, 200);
    await run();
    msgs = await messages();
    check('at most pacePerMinute emails go out in a minute; the rest wait', msgs.filter((m) => m.state === 'SENT').length === 3
      && msgs.filter((m) => m.state === 'QUEUED').length === 1 && inbox.length === 3, JSON.stringify(msgs.map((m) => m.state)));
    await call('PUT', '/api/notificationsettings/email', { ...good, password: undefined, enabled: true, pacePerMinute: 60 });
    await T((c) => c.query('DELETE FROM notification_messages'));
    await T((c) => c.query("UPDATE notification_templates SET activated = false WHERE type = 'EMAIL'"));
    inbox.length = 0;

    // ------------------------------------------------------------------------
    section('manual email (/api/communications/messages:sendEmail)');
    await call('PUT', `/api/clients/${m1.id}/notification-subscriptions/${receipt.id}`, { subscribed: false });
    r = await call('POST', '/api/communications/messages:sendEmail', { clientKey: m1.id, subject: 'Your statement', body: '<p>Hello {{FIRST_NAME}}</p>' });
    let got = inbox.pop();
    check('free text to a member, filled, sent at once, logged', r.status === 201 && r.body.type === 'EMAIL' && r.body.state === 'SENT' && got?.to[0] === 'amina@members.test'
      && header(got.raw, 'Subject') === 'Your statement' && /Hello Amina/.test(textOf(got.raw)), `${r.text}`);
    r = await call('POST', '/api/communications/messages:sendEmail', { depositAccountKey: sav1.id, templateKey: receipt.id });
    got = inbox.pop();
    check('a template from a deposit account, addressed to its holder, whatever the subscription', r.status === 201 && r.body.state === 'SENT' && got?.to[0] === 'amina@members.test'
      && new RegExp(sav1.account_no || sav1.accountNo || 'SV').test(textOf(got.raw)), `${r.text} ${got && textOf(got.raw).slice(-300)}`);
    r = await call('POST', '/api/communications/messages:sendEmail', { groupKey: grp.encodedKey, subject: 'Meeting', body: '<p>Meeting on Friday</p>' });
    check('to a group without an address: refused, nothing sent', r.status === 400 && /MISSING_EMAIL_RECIPIENT/.test(r.reason), r.text);
    r = await call('POST', '/api/communications/messages:sendEmail', { clientKey: m1.id, subject: 'x' }, { who: 'teller' });
    check('a teller without SEND_MANUAL_EMAIL is refused', r.status === 403, r.text);
    r = await call('POST', '/api/communications/messages:sendEmail', { clientKey: m1.id, templateKey: receipt.id, subject: 'Changed' }, { who: 'sender' });
    check('changing a template\'s text before sending needs EDIT_COMMUNICATION_TEMPLATES', r.status === 403, r.text);
    r = await call('POST', '/api/communications/messages:sendEmail', { clientKey: m1.id, subject: 'From the sender', body: '<p>Hi &#x110000;</p>' }, { who: 'sender' });
    check('a user with SEND_MANUAL_EMAIL sends free text (a bad character reference does not stop it)', r.status === 201 && r.body.state === 'SENT', r.text);
    await T((c) => c.query('UPDATE notification_templates SET activated = true WHERE id = $1', [receipt.id]));
    r = await call('GET', '/api/communications/email-templates', null, { who: 'sender' });
    check('a sender lists the active email templates, and only those', r.status === 200 && r.body.some((x) => x.id === receipt.id) && r.body.every((x) => !('url' in x)), r.text);
    check('a sender does not read the other templates', (await call('GET', '/api/templates', null, { who: 'sender' })).status === 403);
    await call('PUT', '/api/notificationsettings/email', { ...good, password: undefined, enabled: false });
    r = await call('POST', '/api/communications/messages:sendEmail', { clientKey: m1.id, subject: 'Off', body: '<p>x</p>' });
    check('with email switched off, a manual email is refused', r.status === 409 && /EMAIL_SERVICE_NOT_ENABLED/.test(r.reason), r.text);
    await call('PUT', '/api/notificationsettings/email', { ...good, password: undefined, enabled: true });
    inbox.length = 0;

    // ------------------------------------------------------------------------
    section('anonymized members');
    const MSG = require('../src/domain/notifications/messages');
    const { rows: [mm] } = await T((c) => c.query("SELECT id FROM notification_messages WHERE member_id = $1 AND type = 'EMAIL' LIMIT 1", [m1.id]));
    await T((c) => c.query("UPDATE notification_messages SET state = 'FAILED' WHERE id = $1", [mm.id]));
    await T((c) => MSG.forgetMember(c, m1.id));
    const { rows: [after] } = await T((c) => c.query('SELECT destination, body, subject FROM notification_messages WHERE id = $1', [mm.id]));
    r = await call('POST', '/api/communications/messages:resend', { messages: [mm.id] });
    check('an anonymized member\'s messages keep no address or content, and are not resent', after.destination === null && after.body === null && after.subject === null
      && r.status === 400, `${JSON.stringify(after)} ${r.text}`);

    section('the member portal (/api/portal/notifications)');
    await T((c) => c.query("UPDATE notification_templates SET activated = true WHERE name IN ('Deposit receipt', 'Large deposits')"));
    let a = await call('POST', '/api/portal/auth/activate', { memberNo: m1.member_no || m1.memberNo, nationalId: '12345678', phone: '0712345678', pin: '2580' }, { who: 'nobody' });
    if (a.status >= 300) check('portal activation', false, a.text);
    a = await call('POST', '/api/portal/auth/login', { phone: '0712345678', pin: '2580' }, { who: 'nobody' });
    const MT = a.body?.accessToken;
    check('the member signs in to the portal', !!MT, a.text);
    r = await call('GET', '/api/portal/notifications', null, { token: MT });
    const pr = r.body?.find?.((x) => x.templateKey === receipt.id);
    check('the member sees the active email templates with their subscription', r.status === 200 && pr?.subscribed === false && pr.name === 'Deposit receipt'
      && !r.body.some((x) => x.templateKey === officerTpl.id), r.text);
    r = await call('PUT', `/api/portal/notifications/${receipt.id}`, { subscribed: true }, { token: MT });
    check('and subscribes again', r.status === 200 && r.body.subscribed === true, r.text);
    const { rows: [srow] } = await T((c) => c.query('SELECT * FROM notification_subscriptions WHERE template_id = $1 AND member_id = $2', [receipt.id, m1.id]));
    check('the change is recorded as the member\'s', srow?.subscribed === true && /portal/i.test(srow.changed_by), JSON.stringify(srow));
    r = await call('PUT', `/api/portal/notifications/${officerTpl.id}`, { subscribed: false }, { token: MT });
    const wh = (await call('POST', '/api/templates', { name: 'A hook', event: 'SAVINGS_DEPOSIT', url: 'https://example.org/h', body: '{}' })).body;
    const r3 = await call('PUT', `/api/portal/notifications/${wh.id}`, { subscribed: false }, { token: MT });
    check('a member cannot change a staff template or a webhook', r.status === 404 && r3.status === 404, `${r.status} ${r3.status}`);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server.close(); starttls.close(); implicit.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
