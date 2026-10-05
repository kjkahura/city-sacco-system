#!/usr/bin/env node
'use strict';

/**
 * Getting Started and Sandbox after the reference platform
 * (docs/audits/audit-getting-started-and-sandbox.md): a sandbox tenant per
 * SACCO (create, reset, clone anonymized or with production data, delete),
 * what a clone leaves out and switches off, the environment marking, the
 * setup checklist, the health check and the developer guide.
 */

process.env.NOTIFY_AFTER_REQUEST = 'off';
process.env.SANDBOX_AFTER_REQUEST = 'off';

const fs = require('fs');
const path = require('path');
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

const SLUG = 'sbxtest';
const SBX = 'sbxtest_sbx';
const PORT = 4132;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const P = (fn) => withTenant(`tenant_${SLUG}`, fn);
const X = (fn) => withTenant(`tenant_${SBX}`, fn);
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

const tokens = {};
async function call(method, p, body, { who = 'admin', tenant = SLUG, token = null } = {}) {
  const headers = { 'x-tenant': tenant };
  const tok = token || tokens[who];
  if (tok) headers.authorization = `Bearer ${tok}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 600), reason: `${d?.errors?.[0]?.errorReason || ''}`, env: r.headers.get('x-environment') };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW, tenant = SLUG) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  const r = await call('POST', '/api/auth/login', { email, password }, { who: 'nobody', tenant });
  return r;
}

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const SB = require('../src/tenancy/sandbox');
    for (const s of [SBX, SLUG]) {
      if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [s])).rowCount) await provision.deprovisionTenant(s, { confirm: s });
      await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [s]);
    }
    await pool.query(`DROP SCHEMA IF EXISTS tenant_${SBX} CASCADE`);
    await provision.provisionTenant({ slug: SLUG, name: 'Sand SACCO', mfaRequiredRoles: [], adminEmail: 'admin@sbx.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = (await login('admin@sbx.local', PASSWORD)).body?.accessToken;
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const u = await call('POST', '/api/users', { email: 'teller@sbx.local', fullName: 'The teller', password: PW, branchId: 'HQ', role: 'TELLER' });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
    tokens.teller = (await login('teller@sbx.local')).body?.accessToken;
    const m1 = (await call('POST', '/api/members', { firstName: 'Amina', lastName: 'Otieno', branchId: 'HQ', email: 'amina@members.test',
      phone: '0712345678', nationalId: '12345678', notes: 'Prefers mornings' })).body;
    const sav = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 7000, channelId: 'cash' });
    await P((c) => c.query(`UPDATE members SET custom_fields = '{"secret": {"pet": "Simba"}}' WHERE id = $1`, [m1.id]));
    const CH = require('../src/domain/notifications/channels');
    await P((c) => CH.save(c, 'EMAIL', { enabled: true, fromName: 'Sand', fromEmail: 'noreply@sand.test', host: 'smtp.sand.test', port: 587,
      encryption: 'STARTTLS', username: 'mailer', password: 'smtp secret' }, { actor: 'test' }));
    const hook = await call('POST', '/api/templates', { name: 'Deposit hook', event: 'SAVINGS_DEPOSIT', url: 'https://example.org/h', body: '{"a": 1}' });
    const mail = await call('POST', '/api/templates', { name: 'Deposit mail', type: 'EMAIL', event: 'SAVINGS_DEPOSIT', subject: 'Deposit', body: '<p>Thanks</p>' });
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 300, channelId: 'cash' });
    await P((c) => c.query("INSERT INTO tasks (title, description, member_id) VALUES ('Call Amina Otieno', 'About Otieno family', $1)", [m1.id]));
    await P((c) => c.query("UPDATE savings_accounts SET name = 'Otieno savings', notes = 'Otieno' WHERE id = $1", [sav.id]));
    await pool.query("UPDATE platform.users SET phone = '0799000111', custom_fields = '{\"next_of_kin\": \"Otieno\"}' WHERE email = 'teller@sbx.local'");
    await pool.query(`UPDATE platform.tenants SET access_preferences = access_preferences || '{"sessionTimeoutMinutes": 17}' WHERE slug = $1`, [SLUG]);
    const con = (await call('POST', '/api/consumers', { name: 'Ledger reader', access: { permissions: ['VIEW_CLIENT_DETAILS'] } })).body;
    await call('POST', `/api/consumers/${con?.id}/keys`, {});
    const prodCounts = await P(async (c) => ({
      members: (await c.query('SELECT count(*)::int AS n FROM members')).rows[0].n,
      tx: (await c.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n,
      lines: (await c.query('SELECT count(*)::int AS n FROM journal_lines')).rows[0].n,
      events: (await c.query('SELECT count(*)::int AS n FROM notification_events')).rows[0].n,
      balance: (await c.query('SELECT balance FROM savings_accounts WHERE id = $1', [sav.id])).rows[0].balance,
    }));
    check('production: a member with personal data, a deposit account, notifications, an API consumer', m1?.id && sav?.id && hook.status === 201 && mail.status === 201
      && prodCounts.events > 0 && Number(prodCounts.balance) === 7300, JSON.stringify(prodCounts));

    // ------------------------------------------------------------------------
    section('getting started');
    let r = await call('GET', '/api/setup-checklist');
    const step = (k) => r.body?.steps?.find((s) => s.key === k);
    check('the checklist lists the setup steps with their state and screen', r.status === 200 && step('branches')?.state === 'DONE' && step('holidays')?.state === 'TODO'
      && step('loanProducts')?.state === 'DEFAULT' && step('users')?.state === 'DONE' && step('members')?.state === 'DONE' && step('branches').screen, r.text);
    check('seeded currencies and accounting settings count as defaults, not as done', step('currencies')?.state === 'DEFAULT' && step('accounting')?.state === 'DEFAULT'
      && r.body.done === r.body.steps.filter((x) => !x.optional && x.state === 'DONE').length, r.text);
    check('every step has a title and says whether it is optional', r.body.steps.length >= 10 && r.body.steps.every((s) => s.title && typeof s.optional === 'boolean'), r.text);
    check('a teller does not read it', (await call('GET', '/api/setup-checklist', null, { who: 'teller' })).status === 403);
    r = await fetch(`http://localhost:${PORT}/healthcheck`).then(async (x) => ({ status: x.status, body: await x.json() }));
    check('GET /healthcheck answers UP', r.status === 200 && r.body.status === 'UP', JSON.stringify(r));
    const guide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'developer-guide.md'), 'utf8');
    check('the developer guide covers tenants, keys, environments and the sandbox', /apikey/.test(guide) && /X-Tenant/.test(guide) && /X-Environment/.test(guide)
      && /sandbox/i.test(guide) && /Idempotency-Key/.test(guide) && !/—/.test(guide));

    let refused = null;
    try { await provision.provisionTenant({ slug: 'other_sbx', name: 'x', adminEmail: 'a@x.test', adminPassword: PASSWORD }); } catch (e) { refused = e.message; }
    check('a production tenant cannot take a sandbox name', /SLUG_RESERVED/.test(refused || ''), refused);

    // ------------------------------------------------------------------------
    section('a sandbox (/api/sandbox)');
    r = await call('GET', '/api/sandbox');
    check('no sandbox yet', r.status === 200 && r.body.exists === false && r.env === 'PRODUCTION', `${r.text} ${r.env}`);
    check('a teller does not manage it', (await call('POST', '/api/sandbox', {}, { who: 'teller' })).status === 403);
    r = await call('POST', '/api/sandbox', {});
    const created = r.body;
    check('an administrator creates an empty sandbox: queued, with a temporary password shown once', r.status === 202 && created?.operation?.kind === 'CREATE'
      && created.operation.state === 'QUEUED' && created.sandbox.slug === SBX && created.adminEmail === 'admin@sbx.local' && created.temporaryPassword?.length >= 16, r.text);
    r = await call('POST', '/api/sandbox:clone', { anonymize: true });
    check('one operation at a time', r.status === 409 && /SANDBOX_BUSY/.test(r.reason), r.text);
    await SB.runPending();
    r = await call('GET', '/api/sandbox');
    check('the sandbox is ready', r.body.exists === true && r.body.state === 'READY' && r.body.slug === SBX && r.body.lastOperation?.state === 'DONE', r.text);
    let t = await one('SELECT * FROM platform.tenants WHERE slug = $1', [SBX]);
    check('it is a tenant of its own, marked SANDBOX and linked to production', t?.environment === 'SANDBOX' && t.status === 'ACTIVE'
      && t.production_tenant_id === (await one('SELECT id FROM platform.tenants WHERE slug = $1', [SLUG])).id, JSON.stringify(t));
    let lg = await login('admin@sbx.local', created.temporaryPassword, SBX);
    check('the administrator signs in with the temporary password and must change it', lg.status === 403 && /PASSWORD_CHANGE_REQUIRED/.test(lg.reason), lg.text);
    await pool.query("UPDATE platform.users SET must_change_password = false WHERE email = 'admin@sbx.local' AND tenant_id = $1", [t.id]);
    lg = await login('admin@sbx.local', created.temporaryPassword, SBX);
    tokens.sbx = lg.body?.accessToken;
    check('signed in, the session says it is the sandbox', lg.status === 200 && lg.body.tenant?.environment === 'SANDBOX', lg.text);
    r = await call('GET', '/api/members', null, { who: 'sbx', tenant: SBX });
    check('the empty sandbox has no members, and answers X-Environment: SANDBOX', r.status === 200 && r.body.length === 0 && r.env === 'SANDBOX', `${r.text} ${r.env}`);
    check('the empty sandbox has the seeded products and chart of accounts', (await X((c) => c.query("SELECT 1 FROM savings_products WHERE id = 'SAV01'"))).rowCount === 1);
    r = await call('POST', '/api/sandbox', {}, { who: 'sbx', tenant: SBX });
    check('a sandbox has no sandbox of its own', r.status === 409 && /SANDBOX/.test(r.reason), r.text);
    check('a production session cannot reach the sandbox by header', (await call('GET', '/api/members', null, { tenant: SBX })).status === 403);

    section('clone, anonymized');
    r = await call('POST', '/api/sandbox:clone', { anonymize: true });
    const cloned = r.body;
    check('a clone is queued, anonymized by default', r.status === 202 && cloned.operation.kind === 'CLONE' && cloned.operation.anonymize === true && cloned.temporaryPassword, r.text);
    r = await call('GET', '/api/members', null, { who: 'sbx', tenant: SBX });
    await SB.runPending();
    r = await call('GET', '/api/sandbox');
    check('the clone is done', r.body.state === 'READY' && r.body.lastOperation?.kind === 'CLONE' && r.body.lastOperation.state === 'DONE', r.text);
    t = await one('SELECT * FROM platform.tenants WHERE slug = $1', [SBX]);
    const sbx = await X(async (c) => ({
      members: (await c.query('SELECT * FROM members ORDER BY member_no')).rows,
      tx: (await c.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n,
      lines: (await c.query('SELECT count(*)::int AS n FROM journal_lines')).rows[0].n,
      balance: (await c.query('SELECT balance FROM savings_accounts WHERE id = $1', [sav.id])).rows[0]?.balance,
      events: (await c.query('SELECT count(*)::int AS n FROM notification_events')).rows[0].n,
      msgs: (await c.query('SELECT count(*)::int AS n FROM notification_messages')).rows[0].n,
      channel: (await c.query("SELECT * FROM notification_channels WHERE channel = 'EMAIL'")).rows[0],
      settings: (await c.query('SELECT * FROM notification_settings')).rows[0],
      hook: (await c.query('SELECT * FROM notification_templates WHERE id = $1', [hook.body.id])).rows[0],
      subs: (await c.query('SELECT * FROM notification_subscriptions WHERE member_id = $1', [m1.id])).rows,
      ids: (await c.query('SELECT count(*)::int AS n FROM member_identifications')).rows[0].n,
      audit: (await c.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n,
    }));
    const am = sbx.members.find((m) => m.id === m1.id);
    check('the books are copied: members, transactions, journal lines, balances', sbx.members.length === prodCounts.members && sbx.tx === prodCounts.tx
      && sbx.lines === prodCounts.lines && Number(sbx.balance) === 7300, JSON.stringify({ ...sbx, members: sbx.members.length }));
    check('members are anonymized: no names, contacts, IDs, notes or custom fields', am && am.first_name === 'Client' && am.last_name === am.member_no && !am.email && !am.phone
      && !am.national_id && !am.notes && JSON.stringify(am.custom_fields) === '{}' && sbx.ids === 0, JSON.stringify(am));
    check('the audit trail, which holds personal data, is not copied', sbx.audit === 0, String(sbx.audit));
    check('members are unsubscribed from email and SMS templates', sbx.subs.some((s) => s.template_id === mail.body.id && s.subscribed === false), JSON.stringify(sbx.subs));
    check('no notification events or messages are copied', sbx.events === 0 && sbx.msgs === 0, JSON.stringify([sbx.events, sbx.msgs]));
    check('email is off and its password is not copied; webhooks are off and their secrets dropped', sbx.channel && sbx.channel.enabled === false && !sbx.channel.secret
      && sbx.settings.webhook_state === 'DISABLED' && !sbx.hook.signing_secret && sbx.hook.url === 'https://example.org/h', JSON.stringify([sbx.channel, sbx.hook?.signing_secret]));
    const leaks = await X(async (c) => {
      const { rows: cols } = await c.query(`SELECT table_name, column_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')`);
      const found = [];
      for (const { table_name: tb, column_name: cn } of cols) {
        const q = await c.query(`SELECT count(*)::int AS n FROM "${tb}" WHERE "${cn}"::text ~* '(otieno|amina|0712345678|12345678|simba|mornings)'`);
        if (q.rows[0].n) found.push(`${tb}.${cn}`);
      }
      return found;
    });
    check('no production personal data is left anywhere in the anonymized book', leaks.length === 0, JSON.stringify(leaks));
    check('webhooks are switched off one by one, so switching them on sends nothing to production\'s receivers', sbx.hook.activated === false, JSON.stringify(sbx.hook?.activated));
    const sbxRow = await one('SELECT access_preferences FROM platform.tenants WHERE slug = $1', [SBX]);
    check('the sandbox keeps production\'s access preferences', sbxRow.access_preferences?.sessionTimeoutMinutes === 17, JSON.stringify(sbxRow));
    const staff = await one('SELECT phone, custom_fields FROM platform.users WHERE tenant_id = $1 AND email = $2', [t.id, 'teller@sbx.local']);
    check('staff contact details are not copied into an anonymized clone', staff && !staff.phone && JSON.stringify(staff.custom_fields || {}) === '{}', JSON.stringify(staff));
    check('production is untouched', (await P((c) => c.query('SELECT email FROM members WHERE id = $1', [m1.id]))).rows[0].email === 'amina@members.test'
      && (await P((c) => c.query("SELECT enabled FROM notification_channels WHERE channel = 'EMAIL'"))).rows[0].enabled === true);
    const keys = await one('SELECT count(*)::int AS n FROM platform.api_consumers WHERE tenant_id = $1', [t.id]);
    check('API consumers and keys are not copied', keys.n === 0, JSON.stringify(keys));
    const teller = await one('SELECT * FROM platform.users WHERE tenant_id = $1 AND email = $2', [t.id, 'teller@sbx.local']);
    lg = await login('teller@sbx.local', PW, SBX);
    check('staff users are copied with their roles, but not their passwords', teller?.role === 'TELLER' && lg.status === 401 && !teller.mfa_enabled, `${JSON.stringify(teller?.role)} ${lg.status}`);
    await pool.query("UPDATE platform.users SET must_change_password = false WHERE email = 'admin@sbx.local' AND tenant_id = $1", [t.id]);
    tokens.sbx = (await login('admin@sbx.local', cloned.temporaryPassword, SBX)).body?.accessToken;
    r = await call('POST', '/api/members', { firstName: 'New', lastName: 'Member', branchId: 'HQ' }, { who: 'sbx', tenant: SBX });
    check('new records in the sandbox take numbers after the copied ones', r.status === 201 && !sbx.members.some((m) => m.member_no === r.body.member_no), r.text);
    r = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 100, channelId: 'cash' }, { who: 'sbx', tenant: SBX });
    check('the sandbox posts to its own copy only', r.status < 300 && Number((await P((c) => c.query('SELECT balance FROM savings_accounts WHERE id = $1', [sav.id]))).rows[0].balance) === 7300, r.text);

    section('clone with production data');
    r = await call('POST', '/api/sandbox:clone', { anonymize: false });
    await SB.runPending();
    const raw = (await X((c) => c.query('SELECT * FROM members WHERE id = $1', [m1.id]))).rows[0];
    check('a clone with production data keeps the members as they are', r.status === 202 && raw?.email === 'amina@members.test' && raw.first_name === 'Amina', JSON.stringify(raw));
    check('the outbound channels are still off', (await X((c) => c.query("SELECT enabled, secret FROM notification_channels WHERE channel = 'EMAIL'"))).rows[0].enabled === false);

    section('reset and delete');
    r = await call('POST', '/api/sandbox:reset', {});
    await SB.runPending();
    const after = await X(async (c) => (await c.query('SELECT count(*)::int AS n FROM members')).rows[0].n);
    const users = await pool.query('SELECT email FROM platform.users WHERE tenant_id = $1', [t.id]);
    check('a reset empties the sandbox and leaves only the administrator', r.status === 202 && after === 0 && users.rows.length === 1 && users.rows[0].email === 'admin@sbx.local', JSON.stringify(users.rows));
    const B = require('../src/ops/backup');
    const targets = await B.backupTargets();
    check('sandboxes are left out of backups', targets.includes(SLUG) && !targets.includes(SBX), JSON.stringify(targets));
    let bk = null;
    try { await B.backupTenant(SBX); } catch (e) { bk = e.message; }
    check('a sandbox is not backed up even when asked by name', /SANDBOX/.test(bk || ''), bk);
    await pool.query(`UPDATE platform.tenants SET access_preferences = access_preferences || '{"reauthenticate": true}' WHERE slug = $1`, [SLUG]);
    require('../src/lib/accessPreferences').forget?.(t.production_tenant_id);
    r = await call('POST', '/api/sandbox:clone', { anonymize: false });
    check('with re-authentication on, sandbox operations ask for the password again', r.status === 403 && /REAUTHENTICATION_REQUIRED/.test(r.reason), r.text);
    await pool.query(`UPDATE platform.tenants SET access_preferences = access_preferences - 'reauthenticate' WHERE slug = $1`, [SLUG]);
    require('../src/lib/accessPreferences').forget?.(t.production_tenant_id);
    // A runner that died mid-operation leaves it RUNNING with no one holding it.
    await pool.query(`INSERT INTO platform.sandbox_operations (production_tenant_id, kind, state, requested_by, started_at, admin_email)
      VALUES ($1, 'RESET', 'RUNNING', 'test', now(), 'admin@sbx.local')`, [t.production_tenant_id]);
    const recovered = await SB.runPending();
    r = await call('GET', '/api/sandbox');
    check('an operation left running by a runner that stopped is marked failed, and the SACCO can go on', recovered.some((x) => x.state === 'FAILED' && /INTERRUPTED/.test(x.detail))
      && r.body.lastOperation?.state === 'FAILED', JSON.stringify(recovered));
    r = await call('DELETE', '/api/sandbox');
    await SB.runPending();
    r = await call('GET', '/api/sandbox');
    const schema = await one("SELECT 1 AS x FROM information_schema.schemata WHERE schema_name = $1", [`tenant_${SBX}`]);
    const closed = await one('SELECT status FROM platform.tenants WHERE slug = $1', [SBX]);
    const left = await one('SELECT count(*)::int AS n FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id WHERE t.slug = $1', [SBX]);
    check('a deleted sandbox is gone: schema dropped, users removed, its tenant closed', r.body.exists === false && !schema && closed?.status === 'CLOSED' && left.n === 0, r.text);

    section('platform administrators and the CLI');
    const op = await SB.request(SLUG, 'CREATE', { actor: 'platform-admin@test', adminEmail: 'admin@sbx.local' });
    await SB.runPending();
    check('the platform side creates a sandbox for a tenant', op.operation.state === 'QUEUED' && (await SB.status(SLUG)).state === 'READY');
    await SB.request(SLUG, 'DELETE', { actor: 'platform-admin@test' });
    await SB.runPending();
    check('and deletes it', (await SB.status(SLUG)).exists === false);
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
