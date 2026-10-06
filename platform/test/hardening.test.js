#!/usr/bin/env node
'use strict';

/**
 * The security review of October 2026 (docs/audits/security-assessment-2026-10.md):
 * one check per weakness fixed, so none comes back. Each check names its
 * finding (IAM-n, BIZ-n, INP-n, CFG-n).
 */

process.env.NOTIFY_AFTER_REQUEST = 'off';
process.env.SANDBOX_AFTER_REQUEST = 'off';

const fs = require('fs');
const os = require('os');
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

const SLUG = 'hardentest';
const PORT = 4135;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(`tenant_${SLUG}`, fn);
const tokens = {};

async function call(method, p, body, { who = 'admin', headers: extra = {}, bearer = null } = {}) {
  const headers = { 'x-tenant': SLUG, ...extra };
  const tok = bearer || tokens[who];
  if (tok) headers.authorization = `Bearer ${tok}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 500), reason: `${d?.errors?.[0]?.errorReason || ''}`, headers: r.headers };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  await store.reset(`rl:login:acct:${SLUG}:${email}:${b}`);
  return call('POST', '/api/auth/login', { email, password }, { who: 'nobody' });
}
async function user(email, body) {
  const u = await call('POST', '/api/users', { email, fullName: email, password: PW, ...body });
  await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
  tokens[email] = (await login(email)).body?.accessToken;
  return u.body;
}

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Hardening SACCO', mfaRequiredRoles: [], adminEmail: 'admin@harden.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = (await login('admin@harden.local', PASSWORD)).body?.accessToken;
    const HQ = (await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' })).body;
    const NK = (await call('POST', '/api/branches', { code: 'NK', name: 'Nakuru' })).body;
    await call('POST', '/api/roles', { name: 'Branch user admin', code: 'BRANCH_UADMIN', baseRole: 'MANAGER',
      permissions: [...require('../src/lib/permissions').DEFAULTS.TELLER, 'VIEW_USER_DETAILS', 'CREATE_USER', 'EDIT_USER'] });
    await call('POST', '/api/roles', { name: 'Key maker', code: 'KEYMAKER', baseRole: 'MANAGER',
      permissions: ['VIEW_API_CONSUMERS_AND_KEYS', 'CREATE_API_CONSUMERS_AND_KEYS'] });
    await call('POST', '/api/roles', { name: 'No members', code: 'NO_MEMBERS', baseRole: 'MANAGER', permissions: ['VIEW_REPORTS'] });
    const ua = await user('ua@harden.local', { role: 'BRANCH_UADMIN', branchId: 'NK', allBranches: false, branchAccess: ['NK'], withdrawalLimit: 1000 });
    await user('keys@harden.local', { role: 'KEYMAKER' });
    await user('nomem@harden.local', { role: 'NO_MEMBERS' });
    await user('nk@harden.local', { role: 'TELLER', branchId: 'NK', allBranches: false, branchAccess: ['NK'] });
    await user('limited@harden.local', { role: 'TELLER', branchId: 'HQ', withdrawalLimit: 100 });
    const m1 = (await call('POST', '/api/members', { firstName: 'Amina', lastName: 'Otieno', branchId: 'HQ' })).body;
    const sav = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    const sav2 = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 5000, channelId: 'bank' });
    check('a SACCO with branches, custom roles, users, a member and accounts', HQ?.id && NK?.id && ua?.id && sav?.id && sav2?.id
      && Object.keys(tokens).length >= 6, JSON.stringify({ ua, sav }).slice(0, 300));

    // ------------------------------------------------------------------------
    section('identity and access');
    let r = await call('POST', '/api/users', { email: 'wide@harden.local', fullName: 'Wide', role: 'TELLER', branchId: 'NK', allBranches: true }, { who: 'ua@harden.local' });
    check('IAM-1: a branch-limited user cannot make a user for every branch', r.status === 403 && /EVERY_BRANCH/.test(r.reason), r.text);
    r = await call('POST', '/api/users', { email: 'hq@harden.local', fullName: 'HQ', role: 'TELLER', branchId: 'HQ', allBranches: false }, { who: 'ua@harden.local' });
    check('IAM-1: nor one in a branch they do not have', r.status === 403 && /BRANCHES_YOU_DO_NOT_HAVE/.test(r.reason), r.text);
    r = await call('POST', '/api/users', { email: 'rich@harden.local', fullName: 'Rich', role: 'TELLER', branchId: 'NK', allBranches: false, withdrawalLimit: 5000 }, { who: 'ua@harden.local' });
    check('IAM-1: nor give a higher limit than their own', r.status === 403 && /HIGHER_LIMIT/.test(r.reason), r.text);
    r = await call('POST', '/api/users', { email: 'ok@harden.local', fullName: 'OK', role: 'TELLER', branchId: 'NK', allBranches: false, withdrawalLimit: 500 }, { who: 'ua@harden.local' });
    check('IAM-1: inside their branch and limits, they can', r.status === 201, r.text);
    r = await call('POST', '/api/users', { email: 'plain@harden.local', fullName: 'Plain', role: 'TELLER', branchId: 'NK' }, { who: 'ua@harden.local' });
    check('IAM-1: a user made without saying gets the maker\'s branch limits and limits (the console\'s form)', r.status === 201 && r.body.all_branches === false
      && Number(r.body.withdrawal_limit) === 1000, r.text);
    const meBefore = (await call('GET', `/api/users/${ua.id}`)).body;
    r = await call('PATCH', `/api/users/${ua.id}`, { fullName: 'Renamed self', branchId: meBefore.branch_id, accessRights: { allBranches: false, branches: meBefore.branch_access },
      withdrawalLimit: Number(meBefore.withdrawal_limit) }, { who: 'ua@harden.local' });
    check('IAM-1: editing one\'s own name with the form\'s unchanged access and limits is allowed', r.status === 200, r.text);
    r = await call('PATCH', `/api/users/${ua.id}`, { allBranches: true, withdrawalLimit: null }, { who: 'ua@harden.local' });
    check('IAM-1: nobody changes their own branch access or limits', r.status === 409 && /OWN_ACCESS_OR_LIMITS/.test(r.reason), r.text);
    const limited = (await pool.query("SELECT id FROM platform.users WHERE email = 'limited@harden.local'")).rows[0];
    r = await call('PATCH', `/api/users/${limited.id}`, { fullName: 'Renamed' }, { who: 'ua@harden.local' });
    check('IAM-1: nor edits a user of another branch', r.status === 403, r.text);
    const adminConsumer = (await call('POST', '/api/consumers', { name: 'Integration admin', access: { administrator: true } })).body;
    r = await call('POST', `/api/consumers/${adminConsumer.id}/keys`, {}, { who: 'keys@harden.local' });
    const r2 = await call('POST', `/api/consumers/${adminConsumer.id}/secret-key`, {}, { who: 'keys@harden.local' });
    check('IAM-2: making a key for an administrator consumer needs an administrator', r.status === 403 && r2.status === 403, `${r.text} ${r2.text}`);
    const RP = require('../src/lib/routePermissions');
    check('IAM-2: key and secret creation are critical actions (re-authentication)', RP.isCritical('POST', '/consumers/x/keys') && RP.isCritical('POST', '/consumers/x/secret-key'));
    const en = await call('POST', '/api/auth/mfa/enrol', {});
    const totp = require('../src/auth/totp');
    const sealed = (await pool.query("SELECT mfa_secret FROM platform.users WHERE email = 'admin@harden.local'")).rows[0].mfa_secret;
    check('CFG-4: the second factor secret is stored sealed', en.status === 200 && /^v1:/.test(sealed) && !sealed.includes(en.body.secret), sealed);
    const code = totp.code(en.body.secret);
    const conf = code ? await call('POST', '/api/auth/mfa/confirm', { code }) : { status: 0 };
    r = await call('POST', '/api/auth/mfa/enrol', {});
    check('IAM-3: with a second factor on, enrolling again with a session is refused', conf.status === 200 && r.status === 409 && /MFA_ALREADY_ENABLED/.test(r.reason), `${conf.status} ${r.text}`);
    await pool.query("UPDATE platform.users SET mfa_enabled = false, mfa_secret = NULL WHERE email = 'admin@harden.local'");
    const admin = (await pool.query("SELECT id FROM platform.users WHERE email = 'admin@harden.local'")).rows[0];
    r = await call('POST', `/api/users/${admin.id}/reset-mfa`, {});
    check('IAM-8: nobody resets their own second factor', r.status === 409 && /OWN_SECOND_FACTOR/.test(r.reason), r.text);
    r = await call('GET', '/api/shares', null, { who: 'nomem@harden.local' });
    check('IAM-9: reading share holdings needs the member permission', r.status === 403, r.text);

    // ------------------------------------------------------------------------
    section('money and limits');
    const future = new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
    r = await call('POST', `/api/savings/${sav.id}/interest`, { date: '9999-12-31' });
    const r3 = await call('POST', `/api/savings/${sav.id}/interest`, { date: 'tomorrow' });
    check('BIZ-1: interest is not brought up to a future or malformed date', r.status === 400 && /FUTURE/.test(r.reason) && r3.status === 400 && /INVALID_DATE/.test(r3.reason), `${r.text} ${r3.text}`);
    r = await call('POST', `/api/savings/${sav.id}/fees`, { amount: 10, name: 'Card', valueDate: future });
    check('BIZ-10: a fee is not dated in the future', r.status === 400 && /FUTURE/.test(r.reason), r.text);
    r = await call('POST', '/api/loans/fees/run', { asOf: future });
    check('BIZ-1: the loan fee run is not dated in the future', r.status === 400, r.text);
    const key = `dep-${Date.now()}`;
    const d1 = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 250, channelId: 'bank' }, { headers: { 'idempotency-key': key } });
    const d2 = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 250, channelId: 'bank' }, { headers: { 'idempotency-key': key } });
    const d3 = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 999, channelId: 'bank' }, { headers: { 'idempotency-key': key } });
    const n = await T(async (c) => (await c.query("SELECT count(*)::int AS n FROM transactions WHERE amount = 250 AND kind = 'SAVINGS_DEPOSIT'")).rows[0].n);
    check('BIZ-3: a deposit sent twice with one Idempotency-Key posts once and answers the same', d1.status === 201 && d2.status === 201
      && d2.headers.get('idempotent-replayed') === 'true' && d1.body?.reference && d2.body?.reference === d1.body.reference && n === 1,
      `${d1.status} ${d2.status} ${n} ${d2.headers.get('idempotent-replayed')} ${d1.body?.reference} ${d2.body?.reference}`);
    check('BIZ-3: the same key on a different request is refused', d3.status === 409 && /IDEMPOTENCY_KEY_REUSED/.test(d3.reason), d3.text);
    r = await call('POST', `/api/savings/${sav.id}/transfers`, { toAccountId: sav2.id, amount: 500 }, { who: 'limited@harden.local' });
    check('BIZ-6: a transfer is held to the user\'s withdrawal limit', r.status === 403, r.text);
    r = await call('POST', '/api/savings/transactions/reversals', { references: Array.from({ length: 1001 }, (_, i) => `R${i}`) });
    check('BIZ-11: bulk reversals are capped', r.status === 400 && /1000/.test(r.reason), r.text);
    const fn = await T(async (c) => (await c.query("SELECT prosrc FROM pg_proc WHERE proname = 'transactions_till_link' AND pronamespace = current_schema()::regnamespace")).rows[0].prosrc);
    check('BIZ-9: the till check locks the till row', /FOR UPDATE/.test(fn));
    const L = require('../src/lib/limits');
    const gate = Array.from({ length: 30 }, () => L.acquire('gate-test', 1, 200).then((rel) => rel, (e) => e));
    const outs = await Promise.all(gate);
    check('BIZ-5: the per-tenant wait list is bounded', outs.some((x) => x instanceof Error && /TENANT_BUSY/.test(x.message)));
    for (const x of outs) if (typeof x === 'function') x();

    // ------------------------------------------------------------------------
    section('follow-up: sessions, passwords, backdating, limits, four eyes');
    const lg = await login('nk@harden.local');
    const before = await call('GET', '/api/members', null, { bearer: lg.body.accessToken });
    await call('POST', '/api/auth/logout', { refreshToken: lg.body.refreshToken }, { bearer: lg.body.accessToken });
    const after = await call('GET', '/api/members', null, { bearer: lg.body.accessToken });
    check('IAM-10: signing out ends the access token at once, not when it expires', before.status === 200 && after.status === 401 && /SESSION_ENDED/.test(after.reason), `${before.status} ${after.text}`);
    const PWH = require('../src/auth/passwords');
    const oldHash = await (async () => {
      const crypto = require('crypto');
      const salt = crypto.randomBytes(16);
      const key = await new Promise((ok, no) => crypto.scrypt('Old-password-99', salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? no(e) : ok(k))));
      return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    })();
    const time = async (h) => { const t = process.hrtime.bigint(); await PWH.verifyPassword('wrong-password-1', h); return Number(process.hrtime.bigint() - t) / 1e6; };
    const tOld = await time(oldHash);
    const tNew = await time('scrypt$16384$8$5$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    check('IAM-12: a hash with the old parameters costs as much to check as an unknown account', PWH.needsRehash(oldHash) && tOld > tNew * 0.6, `${tOld.toFixed(0)}ms vs ${tNew.toFixed(0)}ms`);
    const AP = require('../src/lib/accessPreferences');
    const prefs = await AP.of((await pool.query('SELECT id FROM platform.tenants WHERE slug = $1', [SLUG])).rows[0].id);
    check('IAM-12: common and over-long passwords are refused; no letter is required', AP.passwordProblems(prefs, 'Password1234').some((x) => /commonly used/.test(x))
      && AP.passwordProblems(prefs, `${'a1'.repeat(70)}`).some((x) => /128/.test(x)) && AP.passwordProblems(prefs, '2468 1357 9753 1').length === 0, JSON.stringify(AP.passwordProblems(prefs, '2468 1357 9753 1')));
    const PWD = require('../src/auth/passwords');
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16);
    const weak = `scrypt$16384$8$1$${salt.toString('base64')}$${crypto.scryptSync(PW, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    await pool.query("UPDATE platform.users SET password_hash = $1 WHERE email = 'nk@harden.local'", [weak]);
    const relog = await login('nk@harden.local');
    const rehashed = (await pool.query("SELECT password_hash FROM platform.users WHERE email = 'nk@harden.local'")).rows[0].password_hash;
    check('IAM-12: a hash with the old parameters is replaced at sign-in with the stronger ones', relog.status === 200 && PWD.needsRehash(weak) && /^scrypt\$16384\$8\$5\$/.test(rehashed) && !PWD.needsRehash(rehashed), rehashed.slice(0, 20));
    await call('POST', '/api/roles', { name: 'Shares no backdate', code: 'SHARE_NOBACK', baseRole: 'MANAGER', permissions: ['VIEW_CLIENT_DETAILS', 'BUY_SHARES'] });
    await user('shares@harden.local', { role: 'SHARE_NOBACK' });
    const shr = await call('POST', '/api/shares', { memberId: m1.id });
    const past = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    r = await call('POST', `/api/shares/${shr.body?.id}/purchases`, { units: 1, channelId: 'bank', valueDate: past }, { who: 'shares@harden.local' });
    const r4 = await call('POST', `/api/shares/${shr.body?.id}/purchases`, { units: 1, channelId: 'bank', valueDate: past });
    check('BIZ-2: a past-dated share purchase needs the backdating permission', shr.status === 201 && r.status === 403 && /BACKDATE_SHARE_TRANSACTIONS/.test(r.reason) && r4.status === 201, `${shr.text} ${r.text} ${r4.text}`);
    const PERMS = require('../src/lib/permissions');
    check('BIZ-2: the built-in front-office roles keep backdating loans and shares', PERMS.DEFAULTS.TELLER.includes('BACKDATE_LOAN_TRANSACTIONS') && PERMS.DEFAULTS.TELLER.includes('BACKDATE_SHARE_TRANSACTIONS'));
    await user('daily@harden.local', { role: 'TELLER', branchId: 'HQ', dailyWithdrawalLimit: 300 });
    const w1 = await call('POST', `/api/savings/${sav.id}/withdrawals`, { amount: 200, channelId: 'bank' }, { who: 'daily@harden.local' });
    const w2 = await call('POST', `/api/savings/${sav.id}/withdrawals`, { amount: 200, channelId: 'bank' }, { who: 'daily@harden.local' });
    check('BIZ-6: a daily withdrawal limit adds up the day\'s withdrawals', w1.status === 201 && w2.status === 403 && /DAILY_WITHDRAWAL_LIMIT/.test(w2.reason), `${w1.text} ${w2.text}`);
    const cl = await call('GET', '/api/loans/controls/users');
    check('BIZ-6: the limits page shows the daily limits', (cl.body || []).some((u) => u.email === 'daily@harden.local' && u.dailyWithdrawalLimit === 300), cl.text.slice(0, 200));
    const kc = (await call('POST', '/api/consumers', { name: 'Payments gateway', access: { permissions: ['VIEW_SAVINGS_ACCOUNT_DETAILS', 'MAKE_WITHDRAWAL', 'VIEW_CLIENT_DETAILS'] } })).body;
    await call('PATCH', `/api/consumers/${kc.id}`, { limits: { withdrawalLimit: 50 } });
    const badK = await call('PATCH', `/api/consumers/${kc.id}`, { name: 'Renamed gateway', limits: { withdrawalLimit: -1 } });
    const kAfter = await call('GET', `/api/consumers/${kc.id}`);
    check('BIZ-6: a bad consumer limit is refused before anything changes', badK.status === 400 && kAfter.body?.name === 'Payments gateway', `${badK.text} ${kAfter.text}`);
    const kk = (await call('POST', `/api/consumers/${kc.id}/keys`, {})).body.apiKey;
    const kw = await fetch(`http://localhost:${PORT}/api/savings/${sav.id}/withdrawals`, { method: 'POST', headers: { 'x-tenant': SLUG, apikey: kk, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 100, channelId: 'bank' }) });
    const kwt = await kw.text();
    check('BIZ-6: an API consumer has transaction limits too', kw.status === 403 && /WITHDRAWAL_LIMIT/.test(kwt), `${kw.status} ${kwt}`);
    await call('PATCH', '/api/loans/controls', { twoManRule: true });
    const LOANS = require('../src/domain/loans');
    let fe = null;
    try {
      await T(async (c) => {
        const l = await LOANS.apply(c, { memberId: m1.id, productId: 'NL01', principal: 1000, termMonths: 3, createdBy: 'admin@harden.local' });
        await LOANS.changeState(c, l.id, 'APPROVE', { createdBy: 'admin@harden.local' });
      });
    } catch (e) { fe = e.message; }
    check('BIZ-7: with four eyes on, whoever applied for a loan does not approve it', /TWO_MAN_RULE/.test(fe || ''), fe);
    await call('PATCH', '/api/loans/controls', { twoManRule: false });
    const ik = `mem-${Date.now()}`;
    const mA = await call('POST', '/api/members', { firstName: 'Twice', lastName: 'Sent', branchId: 'HQ' }, { headers: { 'idempotency-key': ik } });
    const mB = await call('POST', '/api/members', { firstName: 'Twice', lastName: 'Sent', branchId: 'HQ' }, { headers: { 'idempotency-key': ik } });
    const twice = await T(async (c) => (await c.query("SELECT count(*)::int AS n FROM members WHERE first_name = 'Twice'")).rows[0].n);
    check('BIZ-3: a member created twice with one Idempotency-Key is created once', mA.status === 201 && mB.status === 201 && mB.body?.id === mA.body?.id && twice === 1, `${mA.status} ${mB.status} ${twice}`);
    await call('POST', '/api/id-templates', { id: 'PP', idType: 'Passport', issuingAuthority: 'Immigration', mask: '@#######', allowAttachments: true });
    r = await call('POST', `/api/members/${m1.id}/identifications`, { templateId: 'PP', documentId: 'A1234567', attachment: { name: 'x.png', type: 'image/png', data: Buffer.from('<html>not a picture</html>').toString('base64') } });
    check('INP-8: an ID document file is checked by its content, not by the type it claims', r.status === 415, r.text);

    const arch = fs.mkdtempSync(path.join(os.tmpdir(), 'harden-audit-'));
    const today = new Date().toISOString().slice(0, 10);
    const exported = await require('../src/ops/auditArchive').exportDay(today, { target: `dir:${arch}` });
    const mine = exported.filter((x) => x.slug === SLUG);
    const archived = fs.readdirSync(path.join(arch, 'audit', SLUG));
    check('CFG-8: a day\'s audit trail is copied out as gzipped JSON lines, for write-once storage', mine.length === 2 && mine.every((x) => x.shipped && x.rows > 0)
      && archived.some((f) => /changes-.*\.jsonl\.gz$/.test(f)), JSON.stringify(mine));
    fs.rmSync(arch, { recursive: true, force: true });
    const OFF = require('../src/ops/offsite');
    check('CFG-8: offsite copies can go to Cloud Storage directly (no gcloud in the image)', JSON.stringify(OFF.parse('gcs:city-sacco-audit/x')) === JSON.stringify({ driver: 'gcs', bucket: 'city-sacco-audit', prefix: 'x' }));

    // ------------------------------------------------------------------------
    section('input and output');
    const csv = require('../src/lib/csv');
    check('INP-2: exported text that would be a formula is neutralised; numbers are not', csv.exportCell('=HYPERLINK("x")') === '"\'=HYPERLINK(""x"")"'
      && csv.exportCell('+1') === "'+1" && csv.exportCell('-100.50') === '-100.50' && csv.exportCell(-5) === '-5', csv.exportCell('=HYPERLINK("x")'));
    const X = require('../src/lib/xlsx');
    const { zip, unzip } = require('../src/lib/zip');
    const files = unzip(X.write([{ name: 'S', rows: [['a']] }]));
    const sheetName = [...files.keys()].find((f) => /worksheets\/sheet1\.xml$/.test(f));
    files.set(sheetName, Buffer.from(String(files.get(sheetName)).replace(/<row r="1"/, '<row r="50000000"').replace(/r="A1"/, 'r="A50000000"')));
    const started = Date.now();
    let xe = null;
    try { X.read(zip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })))); } catch (e) { xe = e.message; }
    const many = unzip(X.write([{ name: 'S', rows: [['a']] }]));
    many.set(sheetName, Buffer.from(String(many.get(sheetName)).replace(/<sheetData>[\s\S]*<\/sheetData>/,
      `<sheetData>${Array.from({ length: 400 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}" t="inlineStr"><is><t>x</t></is></c></row>`).join('')}</sheetData>`)));
    let me = null;
    try { X.read(zip([...many].map(([name, data]) => ({ name, data: Buffer.from(data) })))); } catch (e) { me = e.message; }
    check('INP-1: rows filled out to the last column count against a cell budget', /too many cells/.test(me || ''), me);
    check('INP-1: a workbook asking for row 50,000,000 is refused at once', /INVALID_WORKBOOK/.test(xe || '') && Date.now() - started < 2000, `${xe} ${Date.now() - started}ms`);
    const SC = require('../src/lib/searchCriteria');
    let se = null;
    try { SC.build({ filterCriteria: [{ field: 'constructor', operator: 'EQUALS', value: 'x' }] }, { name: 'm.first_name' }); } catch (e) { se = e; }
    check('INP-4: a built-in object name is not a field', se && se.status === 400, se && se.message);
    let ye = null;
    try { require('../src/lib/yaml').parse('__proto__:\n  required: true\n'); } catch (e) { ye = e.message; }
    check('INP-5: a YAML key that reaches the prototype is refused', /YAML_KEY_NOT_ALLOWED/.test(ye || ''), ye);
    const OUT = require('../src/lib/outbound');
    const prev = process.env.CALLBACK_ALLOW_PRIVATE;
    process.env.CALLBACK_ALLOW_PRIVATE = 'false';
    const o1 = await OUT.send({ url: 'https://127.0.0.1:9/x' });
    const o2 = await OUT.send({ url: 'http://example.org/x' });
    process.env.CALLBACK_ALLOW_PRIVATE = prev;
    check('INP-6: every outbound request refuses private IP literals and plain http, whatever its caller checked', /EPRIVATE/.test(o1.error || '') && /EPRIVATE/.test(o2.error || ''), JSON.stringify([o1, o2]));
    const PD = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'productDocuments.js'), 'utf8');
    check('INP-3: generated documents post no forms and are sandboxed', /form-action 'none'/.test(PD) && /sandbox/.test(PD));

    // ------------------------------------------------------------------------
    section('configuration, errors and the control plane');
    r = await call('GET', '/api/members');
    check('CFG-11: API answers are not cached, sniffed or framed', r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('cache-control') === 'no-store'
      && /frame-ancestors 'none'/.test(r.headers.get('content-security-policy') || ''), [...r.headers].join(' '));
    r = await call('GET', '/api/savings/not-a-number-at-all/transactions?offset=abc');
    check('CFG-3: an error answer carries a code, not the database\'s text', !/syntax|relation|constraint|column/i.test(r.text), r.text);
    r = await fetch(`http://localhost:${PORT}/admin/tenants`, { headers: { authorization: `Bearer ${tokens.admin}` } });
    check('IAM-5: the control plane is off unless ADMIN_API=on', r.status === 404, String(r.status));
    process.env.ADMIN_API = 'on';
    process.env.ADMIN_JWT_SECRET = 'an admin signing key that is long enough 0123456789';
    const AA = require('../src/tenancy/adminAuth');
    const { signToken } = require('../src/tenancy/resolve');
    const forged = signToken({ sub: 'x', email: 'x@y.z', role: 'PLATFORM_ADMIN' });
    const bad = await fetch(`http://localhost:${PORT}/admin/tenants`, { headers: { authorization: `Bearer ${forged}` } });
    const good = await fetch(`http://localhost:${PORT}/admin/tenants`, { headers: { authorization: `Bearer ${AA.mint('ops@harden.local', 5)}` } });
    await new Promise((ok) => setTimeout(ok, 200));
    const logged = (await pool.query("SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'ADMIN_REQUEST' AND actor = 'ops@harden.local'")).rows[0].n;
    check('IAM-5: a staff-key token with the admin role is refused; an admin-key token works and is audited', bad.status === 401 && good.status === 200 && logged >= 1,
      `${bad.status} ${good.status} ${logged}`);
    const refusedLogged = (await pool.query("SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'ADMIN_REQUEST' AND detail->>'refused' IS NOT NULL")).rows[0].n;
    check('IAM-5: a refused control-plane request is recorded too', refusedLogged >= 1, String(refusedLogged));
    delete process.env.ADMIN_API;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harden-bk-'));
    const keep = { key: process.env.BACKUP_ENCRYPTION_KEY, off: process.env.BACKUP_OFFSITE };
    delete process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_OFFSITE = `dir:${path.join(dir, 'offsite')}`;
    const B = require('../src/ops/backup');
    let bk = null;
    try { bk = await B.backupTenant(SLUG, { dir }); } catch (e) { bk = { error: e.message }; }
    const shippedFiles = fs.existsSync(path.join(dir, 'offsite')) ? fs.readdirSync(path.join(dir, 'offsite'), { recursive: true }).filter((f) => /\.dump$/.test(f)) : [];
    if (keep.key) process.env.BACKUP_ENCRYPTION_KEY = keep.key;
    if (keep.off) process.env.BACKUP_OFFSITE = keep.off; else delete process.env.BACKUP_OFFSITE;
    check('CFG-1: without an encryption key, no plain dump is copied offsite', shippedFiles.length === 0 && /ENCRYPTION_KEY_REQUIRED/.test(JSON.stringify(bk)), JSON.stringify(bk).slice(0, 300));
    fs.rmSync(dir, { recursive: true, force: true });
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
