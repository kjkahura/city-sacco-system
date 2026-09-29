#!/usr/bin/env node
'use strict';

/**
 * Users and Access Control, after the reference platform: every route behind a permission
 * (and a route with no rule behind the administrator), the fixes from the
 * audit (role editors, tenant membership, access rights on roles, credit
 * officers, till permissions), user types and branch access, transaction
 * limits, the access preferences (password policy, lockout, session
 * timeout, IP allowlist, re-authentication, two-factor policy), API
 * consumers and keys, the audit trail, and a user's own profile.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const { signToken } = require('../src/tenancy/resolve');
const S = require('../src/domain/savings');
const RP = require('../src/lib/routePermissions');
const PERMS = require('../src/lib/permissions');
const AP = require('../src/lib/accessPreferences');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'uactest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4111;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);
const q1 = async (sql, p = []) => (await pool.query(sql, p)).rows[0];

const tokens = {};
async function call(method, p, body, { who = 'admin', headers: extra = {}, token = undefined } = {}) {
  const headers = { 'x-tenant': SLUG, ...extra };
  const tok = token !== undefined ? token : tokens[who];
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text, reason: d?.errors?.[0]?.errorReason || '' };
}
// The sign-in limiter (20 a quarter hour from one address) is the security suite's; this one signs in often.
const store = require('../src/lib/ratestore');
async function clearLimiter() {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
}
const login = async (email, password = PW) => { await clearLimiter(); return call('POST', '/api/auth/login', { email, password }, { token: null }); };
const apiKey = (key, method, p, body) => call(method, p, body, { token: null, headers: { apikey: key } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Access Control SACCO', mfaRequiredRoles: [], adminEmail: 'admin@uac.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    const tenant = await q1('SELECT id FROM platform.tenants WHERE slug = $1', [SLUG]);
    tokens.admin = (await login('admin@uac.local', PASSWORD)).body.accessToken;
    const hq = (await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' })).body;
    const nth = (await call('POST', '/api/branches', { code: 'NTH', name: 'North' })).body;
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@uac.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = (await login(`${who}@uac.local`)).body?.accessToken;
      return u.body;
    };
    const users = {};
    users.manager = await mk('manager', { role: 'MANAGER', branchId: 'HQ' });
    users.teller = await mk('teller', { role: 'TELLER', branchId: 'HQ' });
    users.auditor = await mk('auditor', { role: 'AUDITOR' });
    check('staff signed in', tokens.manager && tokens.teller && tokens.auditor);

    // ------------------------------------------------------------------------
    section('every route has a rule, and a route with none is for administrators');
    const unknown = await call('GET', '/api/no-such-thing', null, { who: 'manager' });
    check('a path with no rule is refused to everyone but an administrator', unknown.status === 403 && /ADMINISTRATOR_ONLY/.test(unknown.reason), unknown.text);
    check('an administrator gets the 404', (await call('GET', '/api/no-such-thing')).status === 404);
    check('the table names only catalogued permissions', RP.codes().every((c) => PERMS.CODES.has(c)), RP.codes().filter((c) => !PERMS.CODES.has(c)).join(','));
    const approveRule = RP.ruleFor('POST', '/loans/L1/approve');
    check('the most specific rule wins', approveRule.rule === 'APPROVE_LOANS' && RP.ruleFor('GET', '/loans/controls/users').rule === 'VIEW_USER_DETAILS'
      && RP.ruleFor('GET', '/loans/L1').rule === 'VIEW_LOAN_ACCOUNT_DETAILS');
    check('and the built-in roles keep what they could do: a teller deposits, an auditor does not',
      PERMS.DEFAULTS.TELLER.includes('MAKE_DEPOSIT') && !PERMS.DEFAULTS.AUDITOR.includes('MAKE_DEPOSIT') && PERMS.DEFAULTS.MANAGER.includes('APPROVE_LOANS'));

    // ------------------------------------------------------------------------
    section('a token is good only for its own tenant');
    const { rows: [otherAdmin] } = await pool.query("SELECT u.id FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id WHERE t.slug <> $1 AND u.role = 'TENANT_ADMIN' LIMIT 1", [SLUG]);
    if (otherAdmin) {
      const noTid = signToken({ sub: otherAdmin.id, email: 'x@y.z', role: 'TENANT_ADMIN' });
      const r = await call('GET', '/api/members', null, { token: noTid });
      check('another tenant\'s administrator, with no tenant in the token, is refused', r.status === 403 || r.status === 401, `${r.status} ${r.reason}`);
      const forged = signToken({ sub: otherAdmin.id, email: 'x@y.z', role: 'TENANT_ADMIN', tid: SLUG });
      const r2 = await call('GET', '/api/members', null, { token: forged });
      check('and naming this tenant does not make them a user of it', r2.status === 401 && /USER_NOT_FOUND/.test(r2.reason), `${r2.status} ${r2.reason}`);
    } else check('another tenant exists to test with', false);

    // ------------------------------------------------------------------------
    section('roles: nobody but an administrator raises access through them');
    const uaRole = await call('POST', '/api/roles', { code: 'USER_ADMIN', name: 'User administrator', baseRole: 'AUDITOR',
      permissions: [...PERMS.DEFAULTS.AUDITOR, 'VIEW_ROLE', 'CREATE_ROLE', 'EDIT_ROLE', 'CREATE_USER', 'EDIT_USER', 'VIEW_USER_DETAILS'] });
    check('an access administrator role (the reference platform\'s example), made by the administrator', uaRole.status === 201, uaRole.text);
    users.ua = await mk('ua', { role: 'USER_ADMIN' });
    const selfRole = await call('PATCH', '/api/roles/USER_ADMIN', { permissions: [...uaRole.body.permissions, 'APPROVE_LOANS'] }, { who: 'ua' });
    check('they cannot change the role they hold', selfRole.status === 403 && /ROLE_YOU_HOLD/.test(selfRole.reason), selfRole.text);
    const give = await call('POST', '/api/roles', { code: 'CLERK', name: 'Clerk', baseRole: 'TELLER', permissions: ['MAKE_DEPOSIT'] }, { who: 'ua' });
    check('nor give a role a permission they do not hold', give.status === 403 && /MAKE_DEPOSIT/.test(give.reason), give.text);
    const adminRole = await call('POST', '/api/roles', { code: 'SUPER', name: 'Super', baseRole: 'TENANT_ADMIN', permissions: [] }, { who: 'ua' });
    check('nor make an administrator role', adminRole.status === 403 && /ADMINISTRATOR/.test(adminRole.reason), adminRole.text);
    const reader = await call('POST', '/api/roles', { code: 'READER', name: 'Reader', baseRole: 'AUDITOR', permissions: ['VIEW_CLIENT_DETAILS', 'VIEW_REPORTS'] }, { who: 'ua' });
    check('within what they hold, they make roles', reader.status === 201, reader.text);
    const upBase = await call('PATCH', '/api/roles/READER', { baseRole: 'TENANT_ADMIN' }, { who: 'ua' });
    check('but cannot move one onto the administrator', upBase.status === 403, upBase.text);
    const adminUser = await call('POST', '/api/users', { email: 'boss@uac.local', role: 'TENANT_ADMIN' }, { who: 'ua' });
    check('nor create an administrator user', adminUser.status === 403 && /ADMINISTRATOR/.test(adminUser.reason), adminUser.text);
    const mgrUser = await call('POST', '/api/users', { email: 'mgr2@uac.local', role: 'MANAGER', branchId: 'HQ' }, { who: 'ua' });
    check('nor a user whose role holds more than they do', mgrUser.status === 403 && /DO_NOT_HOLD/.test(mgrUser.reason), mgrUser.text);
    const extraUser = await call('POST', '/api/users', { email: 'rd@uac.local', role: 'READER', permissions: ['DIBURSE_LOANS'] }, { who: 'ua' });
    check('nor give extra permissions they do not hold', extraUser.status === 403 && /DIBURSE_LOANS/.test(extraUser.reason), extraUser.text);
    const okUser = await call('POST', '/api/users', { email: 'rd@uac.local', role: 'READER' }, { who: 'ua' });
    check('a user of a role within their own access is fine', okUser.status === 201, okUser.text);
    const editAdmin = await call('PATCH', `/api/users/${(await q1("SELECT id FROM platform.users WHERE email = 'admin@uac.local'")).id}`, { fullName: 'X' }, { who: 'ua' });
    check('and they do not edit an administrator', editAdmin.status === 403, editAdmin.text);
    const reset = await call('POST', `/api/users/${okUser.body.id}/reset-password`, null, { who: 'ua' });
    check('only an administrator resets someone else\'s password (the reference platform)', reset.status === 403 && /ADMINISTRATOR_ONLY/.test(reset.reason), reset.text);

    // ------------------------------------------------------------------------
    section('user types, with the reference platform\'s rules');
    const noBranch = await call('POST', '/api/users', { email: 'nb@uac.local', role: 'TELLER' });
    check('a teller belongs to a branch', noBranch.status === 400 && /BELONGS_TO_A_BRANCH/.test(noBranch.reason), noBranch.text);
    const adminTeller = await call('POST', '/api/users', { email: 'at@uac.local', role: 'TENANT_ADMIN', userType: 'TELLER', branchId: 'HQ' });
    check('an administrator is not also a teller', adminTeller.status === 409, adminTeller.text);
    const typeOnly = await call('POST', '/api/users', { email: 'ta@uac.local', role: 'MANAGER', userType: 'ADMINISTRATOR' });
    check('the administrator type goes with the administrator role', typeOnly.status === 409, typeOnly.text);
    users.officer = await mk('officer', { role: 'MANAGER', userType: 'CREDIT_OFFICER', branchId: 'HQ', accessRights: { otherCreditOfficersClients: true } });
    check('a credit officer, in a branch', users.officer?.user_type === 'CREDIT_OFFICER' && users.officer.state === 'ACTIVE');
    // The reference platform's default: a credit officer sees only their own members until given the others'.
    users.officer2 = await mk('officer2', { role: 'MANAGER', userType: 'CREDIT_OFFICER', branchId: 'HQ' });

    // ------------------------------------------------------------------------
    section('credit officers are credit officer users');
    const m1 = await call('POST', '/api/members', { firstName: 'Amina', lastName: 'Hassan', branchId: 'HQ', creditOfficer: 'officer@uac.local' });
    check('a member is given a credit officer', m1.status === 201 && m1.body.credit_officer === 'officer@uac.local', m1.text);
    const m1b = await call('POST', '/api/members', { firstName: 'Baraka', lastName: 'Mwangi', branchId: 'HQ', creditOfficer: 'teller@uac.local' });
    check('a teller is not a credit officer', m1b.status === 400 && /NOT_A_CREDIT_OFFICER/.test(m1b.reason), m1b.text);
    const m1c = await call('POST', '/api/members', { firstName: 'Chege', lastName: 'Kamau', branchId: 'HQ', creditOfficer: 'nobody@uac.local' });
    check('nor is someone who is not a user', m1c.status === 400 && /NOT_AN_ACTIVE_USER/.test(m1c.reason), m1c.text);
    const m2 = await call('POST', '/api/members', { firstName: 'Dalia', lastName: 'Njeri', branchId: 'HQ', creditOfficer: 'officer2@uac.local' });
    const m3 = await call('POST', '/api/members', { firstName: 'Esther', lastName: 'Atieno', branchId: 'NTH' });
    const m4 = await call('POST', '/api/members', { firstName: 'Faith', lastName: 'Wanjiru', branchId: 'HQ' });
    const deact = await call('PATCH', `/api/users/${users.officer.id}`, { status: 'SUSPENDED' });
    check('deactivating a credit officer who has members asks first (the reference platform)', deact.status === 409 && /CREDIT_OFFICER_HAS_MEMBERS: 1/.test(deact.reason), deact.text);

    // ------------------------------------------------------------------------
    section('branch access');
    users.north = await mk('north', { role: 'MANAGER', branchId: 'NTH', accessRights: { allBranches: false } });
    const seen = await call('GET', '/api/members?limit=50', null, { who: 'north' });
    check('a manager limited to North sees North\'s members only', seen.status === 200 && seen.body.length === 1 && seen.body[0].member_no === m3.body.member_no, seen.text.slice(0, 200));
    const other = await call('GET', `/api/members/${m1.body.id}`, null, { who: 'north' });
    check('a member of another branch is not found for them', other.status === 404, other.text.slice(0, 100));
    const into = await call('POST', '/api/members', { firstName: 'Grace', lastName: 'Achieng', branchId: 'HQ' }, { who: 'north' });
    check('and they cannot put a member into another branch', into.status === 403 && /OUTSIDE_YOUR_BRANCH_ACCESS/.test(into.reason), into.text);
    const view = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo'] }, { who: 'north' });
    check('custom views show their branch only', view.status === 200 && view.body.items.length === 1, view.text.slice(0, 200));
    const eod = await call('POST', '/api/loans/arrears/run', {}, { who: 'north' });
    check('work on the whole organization needs every branch', eod.status === 403 && /ALL_BRANCH_ACCESS_REQUIRED/.test(eod.reason), eod.text);
    await call('PATCH', `/api/users/${users.north.id}`, { accessRights: { branches: ['HQ'] } });
    const both = await call('GET', '/api/members?limit=50', null, { who: 'north' });
    check('given Head office too, they see both branches', both.body.length === 4, String(both.body?.length));
    const own = await call('GET', '/api/members?limit=50', null, { who: 'officer2' });
    const nos = own.body.map((x) => x.member_no).sort();
    check('a credit officer without "other credit officers\' clients" sees their own members and those with none',
      own.status === 200 && nos.includes(m2.body.member_no) && nos.includes(m4.body.member_no) && !nos.includes(m1.body.member_no), JSON.stringify(nos));
    const all = await call('GET', '/api/members?limit=50', null, { who: 'officer' });
    check('one with it sees them all', all.body.length === 4);

    // ------------------------------------------------------------------------
    section('permissions, not base roles, decide the routes');
    const acct = await T(async (c) => { const a = await S.open(c, { memberId: m4.body.id }); await S.deposit(c, a.id, { amount: 10000, channelId: 'bank', createdBy: 'test' }); return a; });
    check('an auditor cannot deposit', (await call('POST', `/api/savings/${acct.id}/deposits`, { amount: 10, channelId: 'bank' }, { who: 'auditor' })).status === 403);
    await call('PATCH', `/api/users/${users.auditor.id}`, { permissions: ['MAKE_DEPOSIT'] });
    const dep = await call('POST', `/api/savings/${acct.id}/deposits`, { amount: 10, channelId: 'bank' }, { who: 'auditor' });
    check('given MAKE_DEPOSIT, the auditor deposits: the route checks the permission, not the role', dep.status === 201, dep.text);
    await call('PATCH', `/api/users/${users.auditor.id}`, { permissions: [] });
    await call('POST', '/api/roles', { code: 'NO_MEMBERS', name: 'No members', baseRole: 'MANAGER', permissions: ['VIEW_LOAN_ACCOUNT_DETAILS'] });
    users.nm = await mk('nm', { role: 'NO_MEMBERS' });
    const nmList = await call('GET', '/api/members', null, { who: 'nm' });
    check('a role without VIEW_CLIENT_DETAILS does not list members, whatever its base role', nmList.status === 403 && /VIEW_CLIENT_DETAILS/.test(nmList.reason), nmList.text);

    // ------------------------------------------------------------------------
    section('access rights on a role (the reference platform and API)');
    await call('POST', '/api/roles', { code: 'API_ONLY', name: 'API only', baseRole: 'AUDITOR', permissions: ['VIEW_CLIENT_DETAILS'], accessRights: { console: false, api: true } });
    await call('POST', '/api/users', { email: 'robot@uac.local', role: 'API_ONLY', password: PW });
    await pool.query("UPDATE platform.users SET must_change_password = false WHERE email = 'robot@uac.local'");
    const robot = await login('robot@uac.local');
    check('a role without the reference platform access does not sign in to the back office', robot.status === 403 && /NO_BACK_OFFICE_ACCESS/.test(robot.reason), robot.text);
    await call('POST', '/api/roles', { code: 'UI_ONLY', name: 'UI only', baseRole: 'AUDITOR', permissions: ['VIEW_CLIENT_DETAILS'], accessRights: { console: true, api: false } });
    const noApi = await call('POST', '/api/consumers', { name: 'ui only', access: { role: 'UI_ONLY' } });
    check('and one without API access is not given to an API consumer', noApi.status === 409 && /API_ACCESS_NOT_ALLOWED/.test(noApi.reason), noApi.text);

    // ------------------------------------------------------------------------
    section('transaction limits');
    const lim = await call('PATCH', `/api/users/${users.teller.id}`, { depositLimit: 1000, withdrawalLimit: 500, repaymentLimit: 2000, feeLimit: 50 });
    check('the four limits the reference platform has beyond approval and disbursement', lim.status === 200 && Number(lim.body.deposit_limit) === 1000 && Number(lim.body.fee_limit) === 50, lim.text);
    const overDep = await call('POST', `/api/savings/${acct.id}/deposits`, { amount: 1500, channelId: 'bank' }, { who: 'teller' });
    check('a deposit above the limit is refused', overDep.status === 403 && /ABOVE_YOUR_DEPOSIT_LIMIT/.test(overDep.reason), overDep.text);
    check('one within it is not', (await call('POST', `/api/savings/${acct.id}/deposits`, { amount: 900, channelId: 'bank' }, { who: 'teller' })).status === 201);
    const overWd = await call('POST', `/api/savings/${acct.id}/withdrawals`, { amount: 600, channelId: 'bank' }, { who: 'teller' });
    check('so is a withdrawal above it', overWd.status === 403 && /ABOVE_YOUR_WITHDRAWAL_LIMIT/.test(overWd.reason), overWd.text);
    const listed = (await call('GET', '/api/loans/controls/users')).body.find((u) => u.email === 'teller@uac.local');
    check('the staff limits list shows all six', listed && listed.depositLimit === 1000 && listed.withdrawalLimit === 500 && listed.repaymentLimit === 2000 && listed.feeLimit === 50);

    // ------------------------------------------------------------------------
    section('tills: posting through one is ADD_CASH and REMOVE_CASH');
    await call('POST', '/api/roles', { code: 'CASHIER', name: 'Cashier', baseRole: 'TELLER', userType: 'TELLER',
      permissions: PERMS.DEFAULTS.TELLER.filter((p) => p !== 'ADD_CASH') });
    users.cashier = await mk('cashier', { role: 'CASHIER', branchId: 'HQ' });
    const till = await call('POST', '/api/tills', { tellerEmail: 'cashier@uac.local', openingAmount: 1000 });
    check('a till is opened for a cashier', till.status === 201, till.text);
    const noAdd = await call('POST', `/api/savings/${acct.id}/deposits`, { amount: 100, channelId: 'cash' }, { who: 'cashier' });
    check('without ADD_CASH their cash deposit through the till is refused', noAdd.status === 403 && /ADD_CASH/.test(noAdd.reason), noAdd.text);
    const wdOk = await call('POST', `/api/savings/${acct.id}/withdrawals`, { amount: 100, channelId: 'cash' }, { who: 'cashier' });
    check('with REMOVE_CASH their withdrawal goes through it', wdOk.status === 201 && wdOk.body.till_id === till.body.id, wdOk.text);
    const tellerClose = await call('POST', `/api/tills/${till.body.id}/close`, {}, { who: 'cashier' });
    check('closing is a supervisor\'s CLOSE_TILL', tellerClose.status === 403);
    check('the manager closes it', (await call('POST', `/api/tills/${till.body.id}/close`, {}, { who: 'manager' })).status === 200);

    // ------------------------------------------------------------------------
    section('role lists name tenant roles');
    check('lending controls take a tenant role', (await call('PATCH', '/api/loans/controls', { lockedPostingRoles: ['TENANT_ADMIN', 'CASHIER'] })).status === 200);
    const cfSet = await call('POST', '/api/custom-fields/sets', { id: '_acc', name: 'Access', entity: 'MEMBER' });
    const cfDef = await call('POST', '/api/custom-fields/definitions', { id: 'acc_note', name: 'Note', setId: '_acc', type: 'FREE_TEXT', entity: 'MEMBER', editRoles: ['CASHIER'] });
    check('custom field rights take a tenant role', cfSet.status === 201 && cfDef.status === 201, cfDef.text);
    const cfBad = await call('POST', '/api/custom-fields/definitions', { id: 'acc_bad', name: 'Bad', setId: '_acc', type: 'FREE_TEXT', entity: 'MEMBER', editRoles: ['NOT_A_ROLE'] });
    check('and refuse one that does not exist', cfBad.status === 400 && /UNKNOWN_ROLES/.test(cfBad.reason), cfBad.text);

    // ------------------------------------------------------------------------
    section('access preferences');
    const prefs0 = await call('GET', '/api/access-preferences');
    check('the defaults: 30 minutes, 12 characters with a digit, history 4, 5 tries, no allowlist', prefs0.status === 200
      && prefs0.body.sessionTimeoutMinutes === 30 && prefs0.body.password.minLength === 12 && prefs0.body.password.history === 4
      && prefs0.body.lockout.maxFailedLogins === 5 && !prefs0.body.ipAllowlist.enabled, prefs0.text);
    check('only with MANAGE_ACCESS_PREFERENCES', (await call('GET', '/api/access-preferences', null, { who: 'manager' })).status === 403);
    check('lockout is 3 to 6 tries, as in the reference platform', (await call('PATCH', '/api/access-preferences', { lockout: { maxFailedLogins: 9 } })).status === 400);
    check('a bad allowlist entry is refused', (await call('PATCH', '/api/access-preferences', { ipAllowlist: { entries: ['10.0.0.300'] } })).status === 400);

    // password policy
    const tellerPw = (pw, cur = PW) => call('POST', '/api/auth/password', { currentPassword: cur, newPassword: pw }, { who: 'teller' });
    let r = await tellerPw('no digits here at all');
    check('a new password needs a digit', r.status === 400 && /digit/.test(r.reason), r.text);
    r = await tellerPw('teller password 2026');
    check('and may not contain the username', r.status === 400 && /username/.test(r.reason), r.text);
    await call('PATCH', '/api/access-preferences', { password: { minUppercase: 2, minSpecial: 1 } });
    r = await tellerPw('Only one capital 2026');
    check('capitals and symbols, when the tenant asks for them', r.status === 400 && /capital/.test(r.reason) && /symbol/.test(r.reason), r.text);
    await call('PATCH', '/api/access-preferences', { password: { minUppercase: 0, minSpecial: 0 } });
    r = await tellerPw('Second password 2026');
    check('a good one is taken', r.status === 200, r.text);
    tokens.teller = (await login('teller@uac.local', 'Second password 2026')).body.accessToken;
    r = await tellerPw(PW, 'Second password 2026');
    check('a previous password comes back refused (history)', r.status === 400 && /USED_BEFORE/.test(r.reason), r.text);
    await pool.query("UPDATE platform.users SET password_changed_at = now() - interval '40 days' WHERE email = 'teller@uac.local'");
    await call('PATCH', '/api/access-preferences', { password: { expiryDays: 30 } });
    r = await login('teller@uac.local', 'Second password 2026');
    check('an expired password signs in only to be changed', r.status === 403 && r.body.errors[0].errorReason === 'PASSWORD_EXPIRED' && r.body.passwordChangeToken, r.text);
    await call('PATCH', '/api/access-preferences', { password: { expiryDays: null } });

    // lockout
    await call('PATCH', '/api/access-preferences', { lockout: { maxFailedLogins: 3, lockMinutes: null } });
    for (let i = 0; i < 3; i += 1) await login('auditor@uac.local', 'wrong password 1');
    const locked = await q1("SELECT failed_logins, locked_at, locked_until FROM platform.users WHERE email = 'auditor@uac.local'");
    check('three wrong passwords lock the user, until an administrator unlocks them', locked.failed_logins === 3 && locked.locked_at && locked.locked_until === null, JSON.stringify(locked));
    r = await login('auditor@uac.local');
    check('the right password is then told the account is locked', r.status === 401 && /USER_LOCKED/.test(r.reason), r.text);
    const wrongNow = await login('auditor@uac.local', 'still wrong 2');
    check('a wrong one is told nothing more', wrongNow.status === 401 && wrongNow.reason === 'INVALID_CREDENTIALS');
    const listedLocked = (await call('GET', '/api/users')).body.find((u) => u.email === 'auditor@uac.local');
    check('the users list shows the state LOCKED', listedLocked.state === 'LOCKED');
    const aud = await call('GET', '/api/members', null, { who: 'auditor' });
    check('a locked user\'s open session stops too', aud.status === 401 && /LOCKED/.test(aud.reason), aud.text);
    const un = await call('POST', `/api/users/${users.auditor.id}/unlock`);
    check('an administrator unlocks them', un.status === 200 && un.body.state === 'ACTIVE' && un.body.failed_logins === 0, un.text);
    r = await login('auditor@uac.local');
    check('and they sign in again', r.status === 200, r.text);
    tokens.auditor = r.body.accessToken;
    await call('PATCH', '/api/access-preferences', { lockout: { maxFailedLogins: 5, lockMinutes: 60 } });

    // session timeout
    await call('PATCH', '/api/access-preferences', { sessionTimeoutMinutes: 5 });
    const sess = await login('manager@uac.local');
    check('an access token lives no longer than the timeout', sess.body.expiresIn === 300, String(sess.body.expiresIn));
    await pool.query("UPDATE platform.refresh_tokens SET last_seen_at = now() - interval '10 minutes', issued_at = now() - interval '10 minutes' WHERE family_id = $1", [sess.body.sessionId]);
    const ref = await call('POST', '/api/auth/refresh', { refreshToken: sess.body.refreshToken }, { token: null });
    check('a session idle past the timeout is not renewed', ref.status === 401 && /SESSION_TIMED_OUT/.test(ref.reason), ref.text);
    const fresh = await login('manager@uac.local');
    await sleep(50);
    const ref2 = await call('POST', '/api/auth/refresh', { refreshToken: fresh.body.refreshToken }, { token: null });
    check('an active one is', ref2.status === 200, ref2.text);
    await call('PATCH', '/api/access-preferences', { sessionTimeoutMinutes: 30 });

    // IP allowlist
    const lockSelf = await call('PATCH', '/api/access-preferences', { ipAllowlist: { enabled: true, entries: ['10.0.0.0/8'], applyTo: ['ADMINS', 'USERS'] } });
    check('an allowlist that would shut out the person saving it is refused', lockSelf.status === 409 && /LOCK_YOU_OUT/.test(lockSelf.reason), lockSelf.text);
    const users2 = await call('PATCH', '/api/access-preferences', { ipAllowlist: { enabled: true, entries: ['10.0.0.0/8', '192.168.1.1-20'], applyTo: ['USERS'] } });
    check('an allowlist for back-office users (not administrators)', users2.status === 200, users2.text);
    const blockedTeller = await call('GET', '/api/members', null, { who: 'manager' });
    check('a user from an address not on it is refused', blockedTeller.status === 403 && /IP_ADDRESS_NOT_ALLOWED/.test(blockedTeller.reason), blockedTeller.text);
    check('and cannot sign in from it', (await login('officer@uac.local')).status === 403);
    check('the administrator still can', (await call('GET', '/api/members')).status === 200);
    await call('PATCH', '/api/access-preferences', { ipAllowlist: { entries: ['127.0.0.1', '10.0.0.*'] } });
    check('with this address on it, the user is let in', (await call('GET', '/api/members', null, { who: 'manager' })).status === 200);
    await call('PATCH', '/api/access-preferences', { ipAllowlist: { enabled: false, entries: [] } });
    check('the address forms: static, wildcard, byte range, CIDR', AP.ipAllowed(['10.0.0.*'], '10.0.0.7') && AP.ipAllowed(['192.168.0.1-25'], '192.168.0.25')
      && !AP.ipAllowed(['192.168.0.1-25'], '192.168.0.26') && AP.ipAllowed(['172.16.0.0/12'], '172.31.255.255') && !AP.ipAllowed(['172.16.0.0/12'], '172.32.0.1')
      && AP.ipAllowed(['127.0.0.1'], '::ffff:127.0.0.1'));

    // re-authentication
    await call('PATCH', '/api/access-preferences', { reauthenticate: true });
    const noRe = await call('PATCH', `/api/users/${users.teller.id}`, { title: 'Senior teller' });
    check('with re-authentication on, a critical action asks for the password again', noRe.status === 403 && /REAUTHENTICATION_REQUIRED/.test(noRe.reason), noRe.text);
    check('not a routine one', (await call('GET', '/api/users')).status === 200);
    check('a wrong password gets no token', (await call('POST', '/api/auth/reauth', { password: 'nope' })).status === 401);
    const re = await call('POST', '/api/auth/reauth', { password: PASSWORD });
    const withRe = await call('PATCH', `/api/users/${users.teller.id}`, { title: 'Senior teller' }, { headers: { 'x-reauth-token': re.body.reauthToken } });
    check('with the token from POST /auth/reauth it goes through', re.status === 200 && withRe.status === 200 && withRe.body.title === 'Senior teller', withRe.text);
    const reOther = await call('PATCH', `/api/users/${users.teller.id}`, { title: 'x' }, { who: 'ua', headers: { 'x-reauth-token': re.body.reauthToken } });
    check('another user\'s token does not count', reOther.status === 403 && /REAUTHENTICATION/.test(reOther.reason), reOther.text);
    await call('PATCH', '/api/access-preferences', { reauthenticate: false }, { headers: { 'x-reauth-token': re.body.reauthToken } });

    // two-factor policy
    const mfaPol = await call('PATCH', '/api/access-preferences', { mfaRequiredRoles: ['READER'] });
    check('the tenant sets which roles need a second factor, tenant roles too', mfaPol.status === 200 && mfaPol.body.mfaRequiredRoles.includes('READER'), mfaPol.text);
    await pool.query("UPDATE platform.users SET must_change_password = false, password_hash = (SELECT password_hash FROM platform.users WHERE email = 'teller@uac.local') WHERE email = 'rd@uac.local'");
    const rd = await login('rd@uac.local', 'Second password 2026');
    check('a user of that role is asked to enrol', rd.status === 403 && rd.body.errors[0].errorReason === 'MFA_ENROLMENT_REQUIRED', rd.text);
    await call('PATCH', '/api/access-preferences', { mfaRequiredRoles: [] });

    // ------------------------------------------------------------------------
    section('API consumers and keys');
    const con = await call('POST', '/api/consumers', { name: 'Warehouse', access: { role: 'READER' } });
    check('an API consumer with a role', con.status === 201 && con.body.access.role === 'READER', con.text);
    check('only with CREATE_API_CONSUMERS_AND_KEYS', (await call('POST', '/api/consumers', { name: 'x', access: { permissions: ['VIEW_REPORTS'] } }, { who: 'manager' })).status === 403);
    const k1 = await call('POST', `/api/consumers/${con.body.id}/keys`, {});
    check('a key, shown once in clear', k1.status === 201 && k1.body.apiKey.length >= 40 && k1.body.prefix === k1.body.apiKey.slice(0, 6), k1.text);
    const listed2 = await call('GET', `/api/consumers/${con.body.id}`);
    check('afterwards only its id and prefix', listed2.body.keys.length === 1 && !JSON.stringify(listed2.body).includes(k1.body.apiKey) && listed2.body.keys[0].prefix === k1.body.prefix);
    const viaKey = await apiKey(k1.body.apiKey, 'GET', '/api/members?limit=50');
    check('the key reads what its role may', viaKey.status === 200 && viaKey.body.length === 4, viaKey.text.slice(0, 100));
    check('and not what it may not', (await apiKey(k1.body.apiKey, 'POST', '/api/members', { firstName: 'A', lastName: 'B' })).status === 403);
    const adminCon = await call('POST', '/api/consumers', { name: 'Integration', access: { administrator: true } }, { who: 'ua' });
    check('only an administrator makes an administrator consumer', adminCon.status === 403, adminCon.text);
    const kShort = await call('POST', `/api/consumers/${con.body.id}/keys`, { expirationTime: 60 });
    await pool.query("UPDATE platform.api_keys SET expires_at = now() - interval '1 second' WHERE id = $1", [kShort.body.id]);
    const expired = await apiKey(kShort.body.apiKey, 'GET', '/api/members');
    check('a key past its time to live stops working', expired.status === 401 && /INVALID_API_KEY/.test(expired.reason), expired.text);
    const sec = await call('POST', `/api/consumers/${con.body.id}/secret-key`);
    const rot = await call('POST', '/api/consumers/keys/rotation', { apiKey: k1.body.apiKey }, { token: null, headers: { secretkey: sec.body.secretKey } });
    check('a key rotated with the secret key: a new key and a new secret', rot.status === 200 && rot.body.apiKey && rot.body.secretKey && rot.body.secretKey !== sec.body.secretKey, rot.text);
    check('the new key works', (await apiKey(rot.body.apiKey, 'GET', '/api/members')).status === 200);
    check('the old one still does, for the grace period', (await apiKey(k1.body.apiKey, 'GET', '/api/members')).status === 200);
    await pool.query("UPDATE platform.api_keys SET grace_until = now() - interval '1 second' WHERE key_hash = encode(sha256($1::bytea), 'hex')", [k1.body.apiKey]);
    require('../src/auth/apiKeys').forget();
    check('and not after it', (await apiKey(k1.body.apiKey, 'GET', '/api/members')).status === 401);
    check('a wrong secret rotates nothing', (await call('POST', '/api/consumers/keys/rotation', { apiKey: rot.body.apiKey }, { token: null, headers: { secretkey: 'nope' } })).status === 401);
    const delUsed = await call('DELETE', `/api/consumers/${con.body.id}`);
    check('a consumer whose keys were used is not deleted (the audit trail keeps it)', delUsed.status === 409, delUsed.text);
    for (let i = 0; i < 10; i += 1) await apiKey(`bad-key-${i}`, 'GET', '/api/members');
    const blocked = await apiKey(rot.body.apiKey, 'GET', '/api/members');
    check('ten requests with bad keys block the address, even for a good key', blocked.status === 403 && /IP_ADDRESS_BLOCKED/.test(blocked.reason), blocked.text);
    const ips = await call('GET', '/api/access-preferences/blocked-ips');
    check('the administrator sees the blocked addresses', ips.status === 200 && ips.body.some((x) => x.blocked_at), ips.text);
    await call('POST', '/api/access-preferences/blocked-ips/reset', { ips: ips.body.map((x) => x.ip) });
    check('and resets them', (await apiKey(rot.body.apiKey, 'GET', '/api/members')).status === 200);

    // ------------------------------------------------------------------------
    section('the audit trail');
    await sleep(300);
    const ev = await call('GET', `/api/audit-trail/events?username[eq]=teller@uac.local&size=500`);
    check('every request is in the audit trail, with the reference platform\'s fields', ev.status === 200 && ev.body.totalItemsCount > 5
      && ev.body.events.every((e) => e.event_source === 'UI' && e.username === 'teller@uac.local') && 'client_ip' in ev.body.events[0] && 'response_code' in ev.body.events[0], ev.text.slice(0, 300));
    const api = await call('GET', '/api/audit-trail/events?event_source[eq]=API&response_code[eq]=401');
    check('API key requests are there as API, and can be filtered by response code', api.body.events.length >= 2 && api.body.events.every((e) => e.response_code === 401));
    const pw = await call('GET', `/api/audit-trail/events?resource[eq]=auth&request_uri[contains]=password&size=50`);
    check('passwords are taken out of what is kept', pw.body.events.length && pw.body.events.every((e) => !e.request_payload || (!e.request_payload.includes('Second password') && e.request_payload.includes('***'))),
      JSON.stringify(pw.body.events.map((e) => e.request_payload)).slice(0, 300));
    const named = await call('GET', `/api/audit-trail/events?request_uri[eq]=/api/members&request_method[eq]=POST&size=50`);
    check('and so are personal details', named.body.events.some((e) => /"firstName":"\*\*\*"/.test(e.request_payload || '')), JSON.stringify(named.body.events.map((e) => e.request_payload)).slice(0, 300));
    check('from and size stay within 10,000', (await call('GET', '/api/audit-trail/events?from=9990&size=20')).status === 400);
    check('only with MANAGE_AUDIT_TRAIL', (await call('GET', '/api/audit-trail/events', null, { who: 'manager' })).status === 403);

    // ------------------------------------------------------------------------
    section('your own profile and sign-in history');
    const prof = await call('PATCH', '/api/profile', { title: 'Branch manager', phone: '0712345678' }, { who: 'manager' });
    check('a user edits their own name, title, phone and language', prof.status === 200 && prof.body.title === 'Branch manager', prof.text);
    check('not their role', (await call('PATCH', '/api/profile', { role: 'TENANT_ADMIN' }, { who: 'manager' })).status === 400);
    const mine = await call('GET', '/api/auth/logins', null, { who: 'auditor' });
    check('their own sign-in history, failures and why', mine.status === 200 && mine.body.some((x) => x.reason === 'WRONG_PASSWORD') && mine.body.some((x) => x.reason === 'LOCKED'), mine.text.slice(0, 200));
    const theirs = await call('GET', `/api/users/${users.auditor.id}/logins`);
    check('and an administrator sees anyone\'s', theirs.status === 200 && theirs.body.length >= 5);
    const me = await call('GET', '/api/auth/me', null, { who: 'north' });
    check('/auth/me carries the user type and branch access', me.body.branches && me.body.branches.length === 2 && Array.isArray(me.body.permissions), me.text.slice(0, 200));

    // ------------------------------------------------------------------------
    section('roles saved before this build keep what their users could do');
    await T((c) => c.query(`INSERT INTO roles (code, name, base_role, permissions) VALUES
      ('OLD_MGR', 'Old manager role', 'MANAGER', ARRAY['VIEW_REPORTS', 'VIEW_CLIENT_DETAILS']),
      ('OLD_TLR', 'Old teller role', 'TELLER', ARRAY['VIEW_CLIENT_DETAILS', 'CLOSE_TILL'])`));
    const sql = require('fs').readFileSync(require('path').join(__dirname, '../src/db/migrations/tenant/032_access_control.sql'), 'utf8');
    const backfill = sql.split('\n').filter((l) => /^UPDATE roles SET permissions/.test(l) || /^ WHERE base_role/.test(l)).join('\n');
    await T((c) => c.query(backfill));
    const old = Object.fromEntries((await T((c) => c.query("SELECT code, permissions FROM roles WHERE code IN ('OLD_MGR', 'OLD_TLR')"))).rows.map((x) => [x.code, x.permissions]));
    check('the migration gives a saved manager role the permissions its base role now needs', old.OLD_MGR.includes('APPROVE_LOANS') && old.OLD_MGR.includes('MANAGE_EOD_PROCESSING')
      && old.OLD_MGR.includes('EDIT_CLIENT') && old.OLD_MGR.includes('VIEW_REPORTS'), JSON.stringify(old.OLD_MGR));
    check('and a saved teller role posts through a till (ADD_CASH, REMOVE_CASH) but no longer closes one', old.OLD_TLR.includes('ADD_CASH') && old.OLD_TLR.includes('REMOVE_CASH')
      && !old.OLD_TLR.includes('CLOSE_TILL') && old.OLD_TLR.includes('MAKE_DEPOSIT'), JSON.stringify(old.OLD_TLR));

    // ------------------------------------------------------------------------
    section('the dictionary');
    const dict = await call('GET', '/api/data-dictionary');
    const missing = dict.body.missing || dict.body.undescribed || [];
    check('the new table and columns are described', dict.status === 200 && !JSON.stringify(missing).includes('audit_events') && !JSON.stringify(missing).includes('console_access'), JSON.stringify(missing).slice(0, 200));
    void tenant;
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(e);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(f);
    server.close();
    await sleep(200);
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
