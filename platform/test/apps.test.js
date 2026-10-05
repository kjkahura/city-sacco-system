#!/usr/bin/env node
'use strict';

/**
 * Apps after the reference platform (docs/audits/audit-apps.md): the XML
 * definition and its reader, installing from a URL or a pasted definition,
 * the App Key, the install and uninstall calls, the app's API consumer,
 * extension points by location and role, the signed request and the
 * one-time launch page, reloading, disabling, uninstalling, permissions,
 * the audit trail and the sandbox.
 */

process.env.CALLBACK_ALLOW_PRIVATE = 'true';
process.env.NOTIFY_AFTER_REQUEST = 'off';
process.env.SANDBOX_AFTER_REQUEST = 'off';
process.env.PUBLIC_BASE_URL = 'https://sacco.example.org';

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

const SLUG = 'appstest';
const PORT = 4133;
const APP_PORT = 4134;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const KEY = 'app-key-0123456789abcdef';
const T = (fn) => withTenant(`tenant_${SLUG}`, fn);
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

const tokens = {};
async function call(method, p, body, { who = 'admin', tenant = SLUG, raw = false, extra = {} } = {}) {
  const headers = { 'x-tenant': tenant, ...extra };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: raw ? text : text.slice(0, 600), reason: `${d?.errors?.[0]?.errorReason || ''}`, headers: r.headers };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return call('POST', '/api/auth/login', { email, password }, { who: 'nobody' });
}

// --- the provider's side ------------------------------------------------------------------
const calls = [];
let installAnswer = 200;
const APP = `http://localhost:${APP_PORT}`;
const definition = (over = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<!-- a test app -->
<application>
  <id>${over.id || 'score-app'}</id>
  <name>${over.name || 'Credit Score &amp; Check'}</name>
  <provider>Test Bureau</provider>
  <description><![CDATA[Scores <members> on demand]]></description>
  <installURL>${APP}/install</installURL>
  <uninstallURL>${APP}/uninstall</uninstallURL>
  <extensionpoint>
    <location>CLIENT_VIEW</location>
    <label>${over.label || 'Credit score'}</label>
    <url>${APP}/client</url>
  </extensionpoint>
  <extensionpoint>
    <location>LOAN_ACCOUNT_VIEW</location>
    <label>Loan score</label>
    <url>${APP}/loan</url>
  </extensionpoint>
  ${over.extra || ''}
</application>`;
let served = definition();
const appServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, body, type: req.headers['content-type'] });
    if (req.url === '/app.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(served); return; }
    if (req.url === '/install') { res.writeHead(installAnswer); res.end('ok'); return; }
    res.writeHead(200); res.end('ok');
  });
});
const verify = (signed, key = KEY) => {
  const [sig, data] = String(signed).split('.');
  const want = crypto.createHmac('sha256', key).update(data).digest('base64url');
  return sig === want ? JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) : null;
};
const signedOf = (body) => new URLSearchParams(body).get('signed_request');

(async () => {
  const server = app.listen(PORT);
  appServer.listen(APP_PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Apps SACCO', mfaRequiredRoles: [], adminEmail: 'admin@apps.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = (await login('admin@apps.local', PASSWORD)).body?.accessToken;
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    await call('POST', '/api/branches', { code: 'NK', name: 'Nakuru' });
    for (const [email, role, branchId] of [['teller@apps.local', 'TELLER', 'HQ'], ['far@apps.local', 'TELLER', 'NK']]) {
      const u = await call('POST', '/api/users', { email, fullName: email, password: PW, branchId, role, ...(branchId === 'NK' ? { allBranches: false, branchAccess: ['NK'] } : {}) });
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
    }
    tokens.teller = (await login('teller@apps.local')).body?.accessToken;
    tokens.far = (await login('far@apps.local')).body?.accessToken;
    const m1 = (await call('POST', '/api/members', { firstName: 'Amina', lastName: 'Otieno', branchId: 'HQ' })).body;
    check('a SACCO with staff and a member', tokens.admin && tokens.teller && tokens.far && m1?.id, JSON.stringify(m1).slice(0, 200));

    // ------------------------------------------------------------------------
    section('the definition');
    const D = require('../src/lib/appDefinition');
    const d = D.parse(definition());
    check('the reference XML is read: id, name with entities, CDATA, extension points', d.id === 'score-app' && d.name === 'Credit Score & Check'
      && d.description === 'Scores <members> on demand' && d.extensionPoints.length === 2 && d.extensionPoints[0].location === 'CLIENT_VIEW'
      && d.installUrl === `${APP}/install`, JSON.stringify(d));
    const bad = (xml) => { try { D.parse(xml); return null; } catch (e) { return e.message; } };
    check('a DOCTYPE or entity declaration is refused', /DOCTYPE/.test(bad('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><application><id>a</id></application>') || ''));
    check('an unknown location is refused', /UNKNOWN_APP_LOCATION/.test(bad(definition({ extra: `<extensionpoint><location>MOON_VIEW</location><label>x</label><url>${APP}/x</url></extensionpoint>` })) || ''));
    check('a name over 256 characters is refused', /NAME/.test(bad(definition({ name: 'x'.repeat(257) })) || ''));
    check('an extension point URL must be https (here http is allowed for tests only)', /HTTPS/.test(bad(definition({ extra: '<extensionpoint><location>BRANCH_VIEW</location><label>x</label><url>ftp://a.example/x</url></extensionpoint>' })) || ''));
    check('only the five standard entities: no prototype names, no bare &', /unknown entity/.test(bad(definition({ name: 'A &constructor; B' })) || '')
      && /bare &/.test(bad(definition({ name: 'A & B' })) || ''), String(bad(definition({ name: 'A &constructor; B' }))));
    check('a quoted > in an attribute does not end the tag', D.parse(definition().replace('<application>', '<application version="1>0">')).id === 'score-app');
    check('broken XML is refused', /INVALID_APP_DEFINITION/.test(bad('<application><id>a</id>') || ''));
    check('a definition over 64 KB is refused', /TOO_LARGE/.test(bad(`<application>${'<x>a</x>'.repeat(9000)}</application>`) || ''));

    section('signing');
    const S = D.sign({ appId: 'score-app', location: 'CLIENT_VIEW' }, KEY);
    const ctx = verify(S);
    check('a signed request is PART1.PART2: base64url HMAC-SHA256 of the base64url JSON, with the App Key', ctx?.appId === 'score-app' && ctx.algorithm === 'HMAC-SHA256', S);

    // ------------------------------------------------------------------------
    section('installing (Administration > Apps)');
    let r = await call('GET', '/api/apps', null, { who: 'teller' });
    check('a teller does not manage apps', r.status === 403, r.text);
    r = await call('POST', '/api/apps', { sourceUrl: `${APP}/app.xml` });
    check('the App Key is required', r.status === 400 && /APP_KEY/.test(r.reason), r.text);
    r = await call('POST', '/api/apps', { sourceUrl: `${APP}/app.xml`, appKey: 'x'.repeat(33) });
    check('the App Key is at most 32 characters', r.status === 400 && /APP_KEY/.test(r.reason), r.text);
    installAnswer = 500;
    r = await call('POST', '/api/apps', { sourceUrl: `${APP}/app.xml`, appKey: KEY, api: { permissions: ['VIEW_CLIENT_DETAILS'] } });
    const cons0 = await one("SELECT count(*)::int AS n FROM platform.api_consumers c JOIN platform.tenants t ON t.id = c.tenant_id WHERE t.slug = $1", [SLUG]);
    check('a failed install call cancels the install, consumer included', r.status === 502 && /APP_INSTALL_CALL_FAILED/.test(r.reason) && cons0.n === 0
      && !(await call('GET', '/api/apps')).body.length, r.text);
    installAnswer = 200;
    calls.length = 0;
    r = await call('POST', '/api/apps', { sourceUrl: `${APP}/app.xml`, appKey: KEY, api: { permissions: ['VIEW_CLIENT_DETAILS'] } });
    const inst = r.body;
    const instCall = calls.find((x) => x.path === '/install');
    const instCtx = instCall && verify(signedOf(instCall.body));
    check('installed from its URL: name, provider, extension points, enabled', r.status === 201 && inst.id === 'score-app' && inst.name === 'Credit Score & Check'
      && inst.provider === 'Test Bureau' && inst.state === 'ENABLED' && inst.extensionPoints.length === 2, r.text);
    check('the install call is a signed form post naming the tenant and the event', instCtx?.event === 'INSTALLED' && instCtx.tenantId === SLUG && instCtx.appId === 'score-app'
      && /x-www-form-urlencoded/.test(instCall.type), JSON.stringify(instCall));
    check('the app gets an API consumer with the chosen role, its key shown once', inst.apiConsumer?.id && inst.apiKey?.length >= 30 && inst.apiConsumer.permissions.includes('VIEW_CLIENT_DETAILS'), r.text);
    r = await call('GET', `/api/apps/${inst.id}`);
    check('the App Key is never returned', r.status === 200 && r.body.hasAppKey === true && !JSON.stringify(r.body).includes(KEY) && !r.body.apiKey, r.text);
    const stored = await T(async (c) => (await c.query("SELECT app_key FROM apps WHERE id = 'score-app'")).rows[0]);
    check('the App Key is stored sealed', stored.app_key && !stored.app_key.includes(KEY), stored.app_key);
    r = await call('POST', '/api/apps', { sourceUrl: `${APP}/app.xml`, appKey: KEY });
    check('the same app twice is refused', r.status === 409 && /APP_EXISTS/.test(r.reason), r.text);
    r = await call('POST', '/api/apps', { definition: definition({ id: 'hr-app', name: 'HR', extra: `<extensionpoint><location>EXTENSION_MENU</location><label>HR</label><url>${APP}/hr</url></extensionpoint>` }).replace(/<installURL>.*<\/installURL>|<uninstallURL>.*<\/uninstallURL>/g, ''), appKey: KEY, roles: ['NO_SUCH_ROLE'] });
    check('roles must exist', r.status === 404 && /ROLE_NOT_FOUND/.test(r.reason), r.text);
    r = await call('POST', '/api/apps', { definition: definition({ id: 'hr-app', name: 'HR', extra: `<extensionpoint><location>EXTENSION_MENU</location><label>HR</label><url>${APP}/hr</url></extensionpoint>` }).replace(/<installURL>.*<\/installURL>|<uninstallURL>.*<\/uninstallURL>/g, ''), appKey: KEY, roles: ['MANAGER'] });
    check('a pasted definition installs, limited to a role, with no API consumer', r.status === 201 && r.body.id === 'hr-app' && r.body.usage.allUsers === false
      && r.body.usage.roles[0] === 'MANAGER' && !r.body.apiConsumer, r.text);

    // ------------------------------------------------------------------------
    section('where apps show');
    r = await call('GET', '/api/apps/extensions?location=CLIENT_VIEW', null, { who: 'teller' });
    check('a teller sees the member page\'s extension points', r.status === 200 && r.body.length === 1 && r.body[0].label === 'Credit score' && r.body[0].appId === 'score-app'
      && !JSON.stringify(r.body).includes('/client'), r.text);
    r = await call('GET', '/api/apps/extensions?location=EXTENSION_MENU', null, { who: 'teller' });
    check('an app limited to other roles is not shown', r.status === 200 && r.body.length === 0, r.text);
    r = await call('GET', '/api/apps/extensions?location=EXTENSION_MENU');
    check('an administrator sees every app', r.body.length === 1 && r.body[0].label === 'HR', r.text);
    check('an unknown location is refused', (await call('GET', '/api/apps/extensions?location=NOPE')).status === 400);

    section('opening an app');
    r = await call('POST', '/api/apps/score-app/launch', { location: 'CLIENT_VIEW', objectId: m1.id }, { who: 'teller', extra: { 'x-forwarded-host': 'evil.example' } });
    const launch = r.body;
    check('a launch answers a one-time address, not the signed request', r.status === 200 && /^\/apps\/frame\/appstest\/[A-Za-z0-9_-]{30,}$/.test(launch.frameUrl)
      && !launch.signedRequest, r.text);
    r = await fetch(`http://localhost:${PORT}${launch.frameUrl}`);
    const html = await r.text();
    const csp = r.headers.get('content-security-policy') || '';
    const signed = (html.match(/name="signed_request" value="([^"]+)"/) || [])[1];
    const lc = verify(signed);
    check('the launch page posts the signed request to the extension point', r.status === 200 && html.includes(`action="${APP}/client"`) && /method="post"/.test(html)
      && /src="\/console\/js\/appframe\.js"/.test(html), html.slice(0, 400));
    check('its CSP lets the form go to that app only, and nothing else load', csp.includes(`form-action ${APP}`) && /default-src 'none'/.test(csp) && /script-src 'self'/.test(csp)
      && r.headers.get('cache-control') === 'no-store' && r.headers.get('referrer-policy') === 'no-referrer', csp);
    const now = Math.floor(Date.now() / 1000);
    check('the context: app, tenant, location, record, user, issued, expiry in five minutes, nonce', lc?.appId === 'score-app' && lc.tenantId === SLUG && lc.location === 'CLIENT_VIEW'
      && lc.objectType === 'CLIENT' && lc.objectId === m1.id && lc.userEmail === 'teller@apps.local' && lc.userId && Math.abs(lc.issuedAt - now) < 5
      && lc.expiresAt - lc.issuedAt === 300 && lc.nonce?.length >= 16 && lc.apiBaseUrl === 'https://sacco.example.org/api', JSON.stringify(lc));
    const kept = await T(async (c) => (await c.query('SELECT signed_request FROM app_launches WHERE used_at IS NOT NULL')).rows);
    check('a used launch keeps no signed request', kept.length >= 1 && kept.every((x) => x.signed_request === null), JSON.stringify(kept).slice(0, 200));
    r = await fetch(`http://localhost:${PORT}${launch.frameUrl}`);
    check('the launch page opens once', r.status === 404);
    r = await call('POST', '/api/apps/score-app/launch', { location: 'CLIENT_VIEW', objectId: m1.id }, { who: 'far' });
    check('a user who cannot see the member cannot open the app on it', r.status === 404, r.text);
    r = await call('POST', '/api/apps/score-app/launch', { location: 'BRANCH_VIEW', objectId: m1.id }, { who: 'teller' });
    check('only at a location the app has', r.status === 404 && /APP_EXTENSION_POINT_NOT_FOUND/.test(r.reason), r.text);
    r = await call('POST', '/api/apps/hr-app/launch', { location: 'EXTENSION_MENU' }, { who: 'teller' });
    check('an app limited to other roles does not open', r.status === 404, r.text);
    r = await call('POST', '/api/apps/hr-app/launch', { location: 'EXTENSION_MENU' });
    check('a menu app opens with no record', r.status === 200 && r.body.frameUrl, r.text);
    await T((c) => c.query("UPDATE app_launches SET expires_at = now() - interval '1 second' WHERE used_at IS NULL"));
    r = await fetch(`http://localhost:${PORT}${(await call('POST', '/api/apps/score-app/launch', { location: 'CLIENT_VIEW', objectId: m1.id })).body.frameUrl}`);
    check('a launch page is good for a minute', r.status === 200);
    await T((c) => c.query("UPDATE app_launches SET expires_at = now() - interval '1 second' WHERE used_at IS NULL"));
    const late = (await call('POST', '/api/apps/score-app/launch', { location: 'CLIENT_VIEW', objectId: m1.id })).body.frameUrl;
    await T((c) => c.query("UPDATE app_launches SET expires_at = now() - interval '1 second' WHERE used_at IS NULL"));
    check('an expired launch page does not open', (await fetch(`http://localhost:${PORT}${late}`)).status === 404);
    const opened = await T(async (c) => (await c.query("SELECT * FROM audit_log WHERE action = 'APP_OPENED' ORDER BY id")).rows);
    check('each opening is in the audit trail', opened.length >= 3 && opened.some((a) => a.actor === 'teller@apps.local'), String(opened.length));
    r = await fetch(`http://localhost:${PORT}/console/`);
    check('the console allows HTTPS frames and still posts forms only to itself', /frame-src 'self' https:/.test(r.headers.get('content-security-policy') || '')
      && /form-action 'self'/.test(r.headers.get('content-security-policy') || ''), r.headers.get('content-security-policy'));

    // ------------------------------------------------------------------------
    const ck = inst.apiKey;
    const byKey = async (method, p, body) => {
      const x = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'x-tenant': SLUG, apikey: ck, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: x.status, text: await x.text() };
    };
    const k1 = await byKey('POST', '/api/apps/hr-app/launch', { location: 'EXTENSION_MENU' });
    const k2 = await byKey('GET', '/api/apps/extensions?location=CLIENT_VIEW');
    check('an API key does not open apps or list them (apps are for staff in the console)', k1.status === 403 && /APPS_ARE_FOR_STAFF/.test(k1.text) && k2.status === 403, `${k1.status} ${k1.text} ${k2.status}`);
    await call('POST', '/api/roles', { code: 'APPMGR', name: 'App manager', baseRole: 'MANAGER', permissions: ['MANAGE_APPS'] });
    const am = await call('POST', '/api/users', { email: 'apps@apps.local', fullName: 'Apps manager', password: PW, branchId: 'HQ', role: 'APPMGR' });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [am.body?.id]);
    tokens.am = (await login('apps@apps.local')).body?.accessToken;
    const perms = (await call('GET', `/api/users/${am.body?.id}`)).body;
    const lacks = !JSON.stringify(perms || {}).includes('CREATE_API_CONSUMERS_AND_KEYS');
    r = await call('POST', '/api/apps', { definition: definition({ id: 'm-app', name: 'M app' }).replace(/<installURL>.*<\/installURL>|<uninstallURL>.*<\/uninstallURL>/g, ''), appKey: KEY,
      api: { permissions: ['VIEW_CLIENT_DETAILS'] } }, { who: 'am' });
    check('making an app\'s API consumer needs the permission to make consumers', lacks && r.status === 403 && /CREATE_API_CONSUMERS_AND_KEYS/.test(r.reason), `${lacks} ${r.text}`);
    r = await call('POST', '/api/apps', { definition: definition({ id: 'm-app', name: 'M app' }).replace(/<installURL>.*<\/installURL>|<uninstallURL>.*<\/uninstallURL>/g, ''), appKey: KEY }, { who: 'am' });
    check('MANAGE_APPS alone installs an app without API access', r.status === 201, r.text);
    await call('DELETE', '/api/apps/m-app', null, { who: 'am' });

    section('changing, reloading, disabling');
    r = await call('PATCH', '/api/apps/score-app', { state: 'DISABLED' });
    check('an app is disabled', r.status === 200 && r.body.state === 'DISABLED', r.text);
    check('a disabled app shows nowhere and does not open', (await call('GET', '/api/apps/extensions?location=CLIENT_VIEW', null, { who: 'teller' })).body.length === 0
      && (await call('POST', '/api/apps/score-app/launch', { location: 'CLIENT_VIEW', objectId: m1.id })).status === 409);
    r = await call('PATCH', '/api/apps/score-app', { state: 'ENABLED', appKey: 'a-new-key' });
    const nl = (await call('POST', '/api/apps/score-app/launch', { location: 'CLIENT_VIEW', objectId: m1.id })).body;
    const nh = await (await fetch(`http://localhost:${PORT}${nl.frameUrl}`)).text();
    check('enabled again with a new App Key, which signs from then on', r.status === 200 && verify((nh.match(/name="signed_request" value="([^"]+)"/) || [])[1], 'a-new-key'), r.text);
    served = definition({ label: 'Credit score v2', extra: `<extensionpoint><location>GROUP_VIEW</location><label>Group score</label><url>${APP}/group</url></extensionpoint>` });
    r = await call('POST', '/api/apps/score-app:reload');
    check('reloading reads the definition again (a new version)', r.status === 200 && r.body.extensionPoints.length === 3
      && r.body.extensionPoints.some((x) => x.label === 'Credit score v2'), r.text);
    served = definition({ id: 'other-app' });
    r = await call('POST', '/api/apps/score-app:reload');
    check('a reloaded definition must keep the app\'s id', r.status === 409 && /APP_ID_CHANGED/.test(r.reason), r.text);
    process.env.CALLBACK_ALLOW_PRIVATE = 'false';
    r = await call('POST', '/api/apps', { sourceUrl: 'https://169.254.169.254/latest/meta-data', appKey: KEY });
    const r2 = await call('POST', '/api/apps', { sourceUrl: `${APP}/app.xml`, appKey: KEY });
    process.env.CALLBACK_ALLOW_PRIVATE = 'true';
    check('a source URL goes through the outbound guard: public HTTPS addresses only', r.status === 400 && /APP_SOURCE_URL_MUST_BE_PUBLIC/.test(r.reason)
      && r2.status === 400 && /APP_SOURCE_URL_MUST_BE_HTTPS/.test(r2.reason), `${r.text} ${r2.text}`);

    // ------------------------------------------------------------------------
    section('the sandbox');
    const SB = require('../src/tenancy/sandbox');
    await SB.request(SLUG, 'CLONE', { actor: 'admin@apps.local', adminEmail: 'admin@apps.local', anonymize: true });
    await SB.runPending();
    const sbxApps = await withTenant(`tenant_${SLUG}_sbx`, async (c) => (await c.query('SELECT state, app_key, consumer_id FROM apps')).rows);
    const sbxLaunch = await withTenant(`tenant_${SLUG}_sbx`, async (c) => (await c.query('SELECT count(*)::int AS n FROM app_launches')).rows[0].n);
    check('a cloned sandbox has the apps disabled, with no App Key or consumer, and no launches', sbxApps.length === 2
      && sbxApps.every((a) => a.state === 'DISABLED' && !a.app_key && !a.consumer_id) && sbxLaunch === 0, JSON.stringify(sbxApps));
    await SB.request(SLUG, 'DELETE', { actor: 'admin@apps.local' });
    await SB.runPending();

    // ------------------------------------------------------------------------
    section('uninstalling');
    calls.length = 0;
    r = await call('DELETE', '/api/apps/score-app');
    const un = calls.find((x) => x.path === '/uninstall');
    const cons = await one('SELECT status FROM platform.api_consumers WHERE id = $1', [inst.apiConsumer.id]);
    check('uninstalling calls the provider, signed, and removes the app', r.status === 200 && verify(signedOf(un?.body), 'a-new-key')?.event === 'UNINSTALLED'
      && (await call('GET', '/api/apps/score-app')).status === 404, r.text);
    check('the app\'s API consumer is deactivated', cons?.status === 'INACTIVE' && r.body.apiConsumerDeactivated === true, JSON.stringify(cons));
    check('its key no longer works', (await byKey('GET', '/api/members')).status === 401);
    const trail = await T(async (c) => (await c.query("SELECT action FROM audit_log WHERE entity = 'app' ORDER BY id")).rows.map((x) => x.action));
    check('installs, changes, reloads and uninstalls are in the audit trail', ['APP_INSTALLED', 'APP_UPDATED', 'APP_RELOADED', 'APP_UNINSTALLED'].every((a) => trail.includes(a)), trail.join(','));
    const DD = require('../src/domain/dataDictionary');
    const dict = await T((c) => DD.build(c));
    check('the data dictionary describes the apps tables', !dict.missing.some((x) => /^app/.test(x)), dict.missing.join(', '));
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server.close();
    appServer.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
