#!/usr/bin/env node
'use strict';

/**
 * The member portal API: activation, PIN sign-in with lockout, member
 * tokens that staff routes refuse, and endpoints that never show one member
 * another member's money.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const SH = require('../src/domain/shares');
const L = require('../src/domain/loans');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'pttest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4096;
const T = (fn) => withTenant(SCHEMA, fn);

let server;

async function call(method, p, { token, body } = {}) {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORT}${p}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, err: d?.errors?.[0]?.errorReason, total: Number(r.headers.get('items-total')) };
}

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Portal Test SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@pttest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});

    const { a, b, savA1, savA2, savB } = await T(async (c) => {
      const a = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name, national_id, phone)
         VALUES ('M1','Amina','Otieno','12345678','0712345678') RETURNING *`)).rows[0];
      const b = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name, national_id)
         VALUES ('M2','Brian','Kamau','87654321') RETURNING *`)).rows[0];
      const savA1 = await S.open(c, { memberId: a.id });
      const savA2 = await S.open(c, { memberId: a.id });
      const savB = await S.open(c, { memberId: b.id });
      await S.deposit(c, savA1.id, { amount: 50000, channelId: 'cash', createdBy: 'test' });
      await S.deposit(c, savA2.id, { amount: 10000, channelId: 'mpesa', createdBy: 'test' });
      await S.deposit(c, savB.id, { amount: 5000, channelId: 'cash', createdBy: 'test' });
      const sh = await SH.open(c, { memberId: a.id });
      await SH.purchase(c, sh.id, { units: 20, channelId: 'cash', createdBy: 'test' });
      const loan = await L.apply(c, { memberId: a.id, productId: 'NL01', principal: 30000, termMonths: 6, createdBy: 'test' });
      await L.changeState(c, loan.id, 'APPROVE', { createdBy: 'test' });
      await L.disburse(c, loan.id, { amount: 30000, channelId: 'bank', createdBy: 'test' });
      return { a, b, savA1, savA2, savB };
    });

    section('activation claims an existing record, it does not create one');
    const wrong = await call('POST', '/api/portal/auth/activate',
      { body: { memberNo: 'M1', nationalId: '00000000', phone: '0712345678', pin: '1234' } });
    check('a wrong national ID is refused', wrong.status === 404 && wrong.err === 'MEMBER_DETAILS_DO_NOT_MATCH',
      `${wrong.status} ${wrong.err}`);
    const wrongPhone = await call('POST', '/api/portal/auth/activate',
      { body: { memberNo: 'M1', nationalId: '12345678', phone: '0799999999', pin: '1234' } });
    check('a phone that does not match the record is refused with the same error',
      wrongPhone.status === 404 && wrongPhone.err === 'MEMBER_DETAILS_DO_NOT_MATCH', `${wrongPhone.status} ${wrongPhone.err}`);
    const badPin = await call('POST', '/api/portal/auth/activate',
      { body: { memberNo: 'M1', nationalId: '12345678', phone: '0712345678', pin: 'abcd' } });
    check('a PIN has to be digits', badPin.status === 400, String(badPin.status));

    const okA = await call('POST', '/api/portal/auth/activate',
      { body: { memberNo: 'M1', nationalId: '12345678', phone: '+254 712 345 678', pin: '1234' } });
    check('the right details activate, whatever the phone formatting',
      okA.status === 201 && okA.body.phone === '254712345678', JSON.stringify(okA.body));
    const twice = await call('POST', '/api/portal/auth/activate',
      { body: { memberNo: 'M1', nationalId: '12345678', phone: '0712345678', pin: '1234' } });
    check('activating twice is refused', twice.status === 409, String(twice.status));

    const okB = await call('POST', '/api/portal/auth/activate',
      { body: { memberNo: 'M2', nationalId: '87654321', phone: '0722000111', pin: '5678' } });
    check('a member with no phone on file gets the presented one recorded', okB.status === 201, String(okB.status));
    const bPhone = await T(async (c) => (await c.query('SELECT phone FROM members WHERE id = $1', [b.id])).rows[0].phone);
    check('and it is written back to the member record', bPhone === '254722000111', bPhone);

    section('sign-in and lockout');
    for (let i = 1; i <= 4; i += 1) {
      const r = await call('POST', '/api/portal/auth/login', { body: { phone: '0712345678', pin: '0000' } });
      check(`wrong PIN attempt ${i} is refused and counted`, r.status === 401, String(r.status));
    }
    const fifth = await call('POST', '/api/portal/auth/login', { body: { phone: '0712345678', pin: '0000' } });
    check('the fifth wrong attempt locks the credential', fifth.status === 423, `${fifth.status} ${fifth.err}`);
    const lockedOut = await call('POST', '/api/portal/auth/login', { body: { phone: '0712345678', pin: '1234' } });
    check('the right PIN is refused while locked, so the lockout survived the failed transaction',
      lockedOut.status === 423, `${lockedOut.status} ${lockedOut.err}`);
    const attempts = await T(async (c) => (await c.query(
      'SELECT count(*)::int AS n FROM member_login_attempts WHERE succeeded = false')).rows[0].n);
    check('every failed attempt is on the record', attempts === 6, String(attempts));

    await T((c) => c.query("UPDATE member_credentials SET locked_until = NULL, status = 'ACTIVE'"));
    const login = await call('POST', '/api/portal/auth/login', { body: { phone: '0712345678', pin: '1234' } });
    check('once unlocked, the right PIN signs in', login.status === 200 && login.body.accessToken,
      `${login.status} ${login.err}`);
    check('the response names the member and the SACCO',
      login.body.member?.firstName === 'Amina' && login.body.tenant?.slug === SLUG, JSON.stringify(login.body.member));
    const tokA = login.body.accessToken;
    let refreshA = login.body.refreshToken;

    const loginB = await call('POST', '/api/portal/auth/login', { body: { phone: '0722000111', pin: '5678' } });
    const tokB = loginB.body.accessToken;

    section('a member token is not a staff token');
    const staffRoute = await call('GET', '/api/members', { token: tokA });
    check('the member list refuses a member token', staffRoute.status === 403, `${staffRoute.status} ${staffRoute.err}`);
    const staffLoans = await call('GET', '/api/loans', { token: tokA });
    check('so does the loan list', staffLoans.status === 403, String(staffLoans.status));
    const reports = await call('GET', '/api/reports/balance-sheet', { token: tokA });
    check('and the reports', reports.status === 403, String(reports.status));

    const staffLogin = await call('POST', '/api/auth/login',
      { body: { email: 'admin@pttest.local', password: 'a sufficiently long passphrase' } });
    const staffTok = staffLogin.body.accessToken;
    const staffOnPortal = await call('GET', '/api/portal/accounts', { token: staffTok });
    check('and a staff token is not a member token either', staffOnPortal.status === 403, String(staffOnPortal.status));

    section('a member sees their own accounts and nothing else');
    const accts = await call('GET', '/api/portal/accounts', { token: tokA });
    const types = (accts.body.accounts || []).map((x) => x.accountType).sort();
    check('savings, shares and the loan all appear', JSON.stringify(types) === '["LOAN","SAVINGS","SAVINGS","SHARES"]',
      JSON.stringify(types));
    const loanAcct = accts.body.accounts.find((x) => x.accountType === 'LOAN');
    check('the loan carries what is owed', loanAcct.balance >= 30000, String(loanAcct.balance));

    const acctsB = await call('GET', '/api/portal/accounts', { token: tokB });
    check('the other member sees only their own', acctsB.body.accounts.length === 1
      && acctsB.body.accounts[0].accountNumber === savB.account_no, JSON.stringify(acctsB.body.accounts.map((x) => x.accountNumber)));

    const txA = await call('GET', `/api/portal/accounts/${savA1.account_no}/transactions?limit=10`, { token: tokA });
    check('own transactions are paged', txA.status === 200 && txA.body.length === 1 && txA.total === 1,
      `${txA.status} ${txA.body?.length}`);
    const txStolen = await call('GET', `/api/portal/accounts/${savB.account_no}/transactions`, { token: tokA });
    check('another member\'s account number yields nothing', txStolen.status === 200 && txStolen.body.length === 0,
      `${txStolen.status} ${txStolen.body?.length}`);
    const sched = await call('GET', `/api/portal/loans/${loanAcct.accountNumber}/schedule`, { token: tokA });
    check('the loan schedule is readable by its owner', sched.status === 200 && sched.body.schedule.length === 6,
      String(sched.status));
    const schedStolen = await call('GET', `/api/portal/loans/${loanAcct.accountNumber}/schedule`, { token: tokB });
    check('and 404 to anyone else', schedStolen.status === 404, String(schedStolen.status));

    const stats = await call('GET', '/api/portal/stats', { token: tokA });
    check('the dashboard totals are the member\'s own', stats.body.stats.totalDeposits === 60000,
      JSON.stringify(stats.body.stats));

    section('transfers');
    const own = await call('POST', '/api/portal/transfers/own',
      { token: tokA, body: { fromAccountId: savA1.account_no, toAccountId: savA2.account_no, amount: 5000 } });
    check('a transfer between own accounts posts', own.status === 201 && own.body.reference, `${own.status} ${own.err}`);
    const notMine = await call('POST', '/api/portal/transfers/own',
      { token: tokA, body: { fromAccountId: savB.account_no, toAccountId: savA2.account_no, amount: 100 } });
    check('a transfer out of someone else\'s account is refused', notMine.status === 404, `${notMine.status} ${notMine.err}`);

    const lookup = await call('GET', '/api/portal/transfers/lookup?phone=0722000111', { token: tokA });
    check('a recipient lookup returns a first name and a masked account',
      lookup.body.beneficiary?.name === 'Brian K.' && /\*\*\*\*/.test(lookup.body.beneficiary.accountNumber),
      JSON.stringify(lookup.body));
    const self = await call('GET', '/api/portal/transfers/lookup?phone=0712345678', { token: tokA });
    check('looking yourself up finds nothing', self.status === 404, String(self.status));

    const internal = await call('POST', '/api/portal/transfers/internal',
      { token: tokA, body: { recipientPhone: '0722000111', amount: 2500, description: 'rent share' } });
    check('a transfer to another member by phone posts', internal.status === 201, `${internal.status} ${internal.err}`);
    const bAfter = await T(async (c) => (await c.query(
      'SELECT balance FROM savings_accounts WHERE id = $1', [savB.id])).rows[0].balance);
    check('and lands in their primary savings account', Number(bAfter) === 7500, String(bAfter));
    const tooMuch = await call('POST', '/api/portal/transfers/internal',
      { token: tokB, body: { recipientPhone: '0712345678', amount: 1000000 } });
    check('a transfer beyond the available balance is refused by the savings rules',
      tooMuch.status === 409 && /INSUFFICIENT/.test(tooMuch.err), `${tooMuch.status} ${tooMuch.err}`);

    section('beneficiaries');
    const ben = await call('POST', '/api/portal/beneficiaries',
      { token: tokA, body: { name: 'Brian', mobilePhone: '0722000111', relationship: 'Brother' } });
    check('a beneficiary who is a member comes back verified', ben.status === 201 && ben.body.beneficiary.isVerified === true,
      JSON.stringify(ben.body));
    const ben2 = await call('POST', '/api/portal/beneficiaries',
      { token: tokA, body: { name: 'Landlord', accountNumber: '0011223344', relationship: 'Other' } });
    check('one who is not is saved unverified', ben2.status === 201 && ben2.body.beneficiary.isVerified === false);
    const list = await call('GET', '/api/portal/beneficiaries', { token: tokA });
    check('both are listed', list.body.beneficiaries.length === 2, String(list.body.beneficiaries.length));
    const listB = await call('GET', '/api/portal/beneficiaries', { token: tokB });
    check('and only to their owner', listB.body.beneficiaries.length === 0);
    const delOther = await call('DELETE', `/api/portal/beneficiaries/${ben.body.beneficiary.id}`, { token: tokB });
    check('another member cannot delete them', delOther.status === 404, String(delOther.status));
    const del = await call('DELETE', `/api/portal/beneficiaries/${ben2.body.beneficiary.id}`, { token: tokA });
    check('the owner can', del.status === 200);

    section('refresh rotation');
    const rot1 = await call('POST', '/api/portal/auth/refresh', { body: { refreshToken: refreshA } });
    check('a refresh token rotates into a new pair', rot1.status === 200 && rot1.body.refreshToken !== refreshA,
      `${rot1.status} ${rot1.err}`);
    const replay = await call('POST', '/api/portal/auth/refresh', { body: { refreshToken: refreshA } });
    check('replaying the spent token is refused', replay.status === 401 && /REUSED/.test(replay.err), `${replay.status} ${replay.err}`);
    const burned = await call('POST', '/api/portal/auth/refresh', { body: { refreshToken: rot1.body.refreshToken } });
    check('and the replay burned the whole family, so the fresh token is dead too',
      burned.status === 401, `${burned.status} ${burned.err}`);

    section('changing the PIN');
    const relogin = await call('POST', '/api/portal/auth/login', { body: { phone: '0712345678', pin: '1234' } });
    refreshA = relogin.body.refreshToken;
    const wrongOld = await call('POST', '/api/portal/auth/pin',
      { token: relogin.body.accessToken, body: { currentPin: '9999', newPin: '4321' } });
    check('the current PIN is required', wrongOld.status === 401, String(wrongOld.status));
    const changed = await call('POST', '/api/portal/auth/pin',
      { token: relogin.body.accessToken, body: { currentPin: '1234', newPin: '4321' } });
    check('a PIN change succeeds with the right current PIN', changed.status === 201, `${changed.status} ${changed.err}`);
    const afterChange = await call('POST', '/api/portal/auth/refresh', { body: { refreshToken: refreshA } });
    check('and signs out every other device', afterChange.status === 401, String(afterChange.status));
    // By now this test has made more sign-in calls than the per-IP window
    // allows, which is the limiter doing its job; check the new PIN at the
    // domain level instead.
    const MA = require('../src/auth/memberAuth');
    const newPin = await T((c) => MA.login(c, { phone: '0712345678', pin: '4321', tenantSlug: SLUG }));
    check('the new PIN works', Boolean(newPin.accessToken) && !newPin.failure, JSON.stringify(newPin.failure || 'ok'));
    const oldPin = await T((c) => MA.login(c, { phone: '0712345678', pin: '1234', tenantSlug: SLUG }));
    check('and the old one does not', oldPin.failure?.code === 'INVALID_CREDENTIALS', JSON.stringify(oldPin.failure));
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server?.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
