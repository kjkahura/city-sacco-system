#!/usr/bin/env node
'use strict';

/**
 * Shares, dividends, and the operational machinery: refresh rotation,
 * rate limiting, per-tenant concurrency, backup and restore, and the
 * idempotent end-of-day run.
 */

const fs = require('fs');
const path = require('path');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const SH = require('../src/domain/shares');
const S = require('../src/domain/savings');
const L = require('../src/domain/loans');
const acct = require('../src/domain/accounting');
const tokens = require('../src/auth/tokens');
const eod = require('../src/ops/eod');
const backup = require('../src/ops/backup');
const limits = require('../src/lib/limits');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
async function throws(label, fn, matcher) {
  try { await fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, matcher ? matcher(e) : true, e.message.slice(0, 140)); }
}
const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const SLUG = 'opstest';
const SCHEMA = `tenant_${SLUG}`;
const T = (fn) => withTenant(SCHEMA, fn);
const R = (fn) => withTenantRead(SCHEMA, fn);
const BACKUP_DIR = path.join(__dirname, '..', '.tmp-backups');

async function assertBalanced(label) {
  const tb = await R((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced,
    `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}

const PORT = 4098;
let server;
async function call(method, p, { token, tenant = SLUG, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant'] = tenant;
  const r = await fetch(`http://localhost:${PORT}${p}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d };
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
      slug: SLUG, name: 'Ops Test SACCO',
      mfaRequiredRoles: [],  // this SACCO has not turned MFA on yet
      adminEmail: 'admin@opstest.local', adminPassword: 'a sufficiently long passphrase',
    });
    const mig = await migrateAllTenants({ concurrency: 4 });
    check('migrate:all applied 002 to the fleet', mig.every((m) => m.ok), JSON.stringify(mig).slice(0, 160));

    const hasShares = await R(async (c) => (await c.query(
      "SELECT to_regclass('share_movements') IS NOT NULL AS ok")).rows[0].ok);
    check('share_movements table exists after migration', hasShares);

    section('migration runner safety');
    const lock = await pool.connect();
    await lock.query('SELECT pg_advisory_lock(41777)');
    await throws('second concurrent migrate run refuses to start',
      () => migrateAllTenants({}), (e) => /advisory lock/.test(e.message));
    await lock.query('SELECT pg_advisory_unlock(41777)');
    lock.release();

    section('shares');
    const { m1, m2, sh1, sh2, sav1, sav2 } = await T(async (c) => {
      const a = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name) VALUES ('M1','Grace','Njeri') RETURNING *`)).rows[0];
      const b = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name) VALUES ('M2','Peter','Otieno') RETURNING *`)).rows[0];
      return {
        m1: a, m2: b,
        sh1: await SH.open(c, { memberId: a.id }),
        sh2: await SH.open(c, { memberId: b.id }),
        sav1: await S.open(c, { memberId: a.id }),
        sav2: await S.open(c, { memberId: b.id }),
      };
    });

    await T((c) => SH.purchase(c, sh1.id, { units: 300, channelId: 'cash', createdBy: 'test' }));
    await T((c) => SH.purchase(c, sh2.id, { units: 100, channelId: 'cash', createdBy: 'test' }));
    const equity = await R((c) => acct.balance(c, '300-100'));
    check('share purchase credits share capital', equity === -40000, String(equity));
    await assertBalanced('share purchase');

    const reg = await R((c) => SH.register(c, {}));
    check('share register shows both holders',
      reg.holders.length === 2 && reg.holders[0].units === 300 && reg.totalHolders === 2,
      JSON.stringify(reg.holders.map((r) => [r.member_no, r.units])));
    check('share register totals units over the whole register', reg.totalUnits === 400,
      String(reg.totalUnits));

    await throws('cannot transfer more units than held', () =>
      T((c) => SH.transfer(c, sh2.id, { toAccountId: sh1.id, units: 5000, createdBy: 'test' })),
      (e) => /INSUFFICIENT_UNITS/.test(e.message));

    await T((c) => SH.transfer(c, sh1.id, { toAccountId: sh2.id, units: 50, createdBy: 'test' }));
    const after = await R((c) => SH.register(c, {}));
    const byNo = Object.fromEntries(after.holders.map((r) => [r.member_no, Number(r.units)]));
    check('transfer moved units without touching equity', byNo.M1 === 250 && byNo.M2 === 150,
      JSON.stringify(byNo));
    const equity2 = await R((c) => acct.balance(c, '300-100'));
    check('share capital unchanged by a transfer', equity2 === equity, String(equity2));

    section('dividend cycle');
    await T((c) => SH.declare(c, {
      financialYear: 2026, ratePercent: 8, basis: 'UNITS', createdBy: 'test' }));
    await throws('cannot declare twice for one year', () =>
      T((c) => SH.declare(c, { financialYear: 2026, ratePercent: 5, createdBy: 'test' })),
      (e) => /ALREADY_DECLARED/.test(e.message));

    await throws('cannot pay before allocating', () =>
      T((c) => SH.pay(c, 2026, { createdBy: 'test' })),
      (e) => /NOT_ALLOCATED/.test(e.message));

    const alloc = await T((c) => SH.allocate(c, 2026, { createdBy: 'test' }));
    // 400 units at 100 each, 8% => 3200 total.
    check('allocation total is rate x holding', alloc.total === 3200, String(alloc.total));
    check('allocated to both holders', alloc.holders === 2, String(alloc.holders));
    const payable = await R((c) => acct.balance(c, '200-200'));
    check('dividends payable credited', payable === -3200, String(payable));
    await assertBalanced('dividend allocation');

    await throws('cannot allocate twice', () =>
      T((c) => SH.allocate(c, 2026, { createdBy: 'test' })),
      (e) => /ALREADY_ALLOCATED/.test(e.message));

    const before1 = (await T((c) => S.summary(c, sav1.id))).balance;
    const paid = await T((c) => SH.pay(c, 2026, { createdBy: 'test' }));
    check('payout cleared the payable', paid.status === 'PAID' && paid.paidTotal === 3200,
      JSON.stringify(paid));
    const after1 = (await T((c) => S.summary(c, sav1.id))).balance;
    check('dividend landed in savings', round(after1 - before1) === 2000, `${before1} -> ${after1}`);
    const payable2 = await R((c) => acct.balance(c, '200-200'));
    check('payable back to zero', payable2 === 0, String(payable2));
    await assertBalanced('dividend payout');

    section('dividend with a shareholder who has no savings account');
    await T(async (c) => {
      const m3 = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name) VALUES ('M3','No','Savings') RETURNING *`)).rows[0];
      const sh3 = await SH.open(c, { memberId: m3.id });
      await SH.purchase(c, sh3.id, { units: 100, channelId: 'cash', createdBy: 'test' });
    });
    await T((c) => SH.declare(c, { financialYear: 2027, ratePercent: 10, createdBy: 'test' }));
    await T((c) => SH.allocate(c, 2027, { createdBy: 'test' }));
    const paid27 = await T((c) => SH.pay(c, 2027, { createdBy: 'test' }));
    check('member without savings is reported, not silently skipped',
      paid27.skipped.length === 1 && paid27.skipped[0].reason === 'NO_ACTIVE_SAVINGS_ACCOUNT',
      JSON.stringify(paid27.skipped));
    check('dividend stays ALLOCATED while anyone is unpaid', paid27.status === 'ALLOCATED');
    await assertBalanced('partial dividend payout');

    section('REDUCING balance schedule');
    await T((c) => c.query(
      `INSERT INTO loan_products (id, name, method, monthly_rate, max_term, processing_fee,
                                  gl_portfolio, gl_interest_inc, gl_fee_inc, enforce_deposit_multiplier)
       VALUES ('RB01','Reducing Balance Loan','REDUCING',2.000,12,0,'100-100','400-100','400-200', false)
       ON CONFLICT DO NOTHING`));
    // This member holds 4,500 in deposits and is about to borrow 120,000; the
    // product above switches the multiplier rule off because the point of
    // this section is the schedule shape, not eligibility. Eligibility has
    // its own suite.
    const rbLoan = await T(async (c) => {
      const l = await L.apply(c, {
        memberId: m1.id, productId: 'RB01', principal: 120000, termMonths: 12, createdBy: 'test' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'test' });
      await L.disburse(c, l.id, { amount: 120000, channelId: 'bank', createdBy: 'test' });
      return l;
    });
    const rbSched = await R(async (c) => (await c.query(
      'SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [rbLoan.id])).rows);
    check('reducing schedule has 12 installments', rbSched.length === 12, String(rbSched.length));
    check('reducing interest falls each period',
      rbSched[0].interest_due > rbSched[11].interest_due
      && rbSched.every((r, i, a) => i === 0 || r.interest_due <= a[i - 1].interest_due),
      `first ${rbSched[0].interest_due} last ${rbSched[11].interest_due}`);
    check('first period interest is 2% of full principal',
      rbSched[0].interest_due === 2400, String(rbSched[0].interest_due));
    check('reducing total interest is below the flat equivalent',
      round(rbSched.reduce((s, r) => s + r.interest_due, 0)) < 2400 * 12);
    await assertBalanced('reducing disbursement');

    section('end of day is idempotent');
    const tenantRow = (await pool.query('SELECT * FROM platform.tenants WHERE slug=$1', [SLUG])).rows[0];
    // Business dates after disbursement, since accrual now counts days.
    const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const day = plus(10);
    const run1 = await eod.runJob(tenantRow, 'accrueInterest', { businessDate: day });
    check('first accrual run does work', run1.accrued > 0, JSON.stringify(run1));
    const accrued1 = await R(async (c) => (await c.query(
      'SELECT SUM(interest_accrued) AS t FROM loan_accounts')).rows[0].t);

    const run2 = await eod.runJob(tenantRow, 'accrueInterest', { businessDate: day });
    check('second run for the same date is refused', run2.skipped === 'ALREADY_RUN', JSON.stringify(run2));
    const accrued2 = await R(async (c) => (await c.query(
      'SELECT SUM(interest_accrued) AS t FROM loan_accounts')).rows[0].t);
    check('interest was not accrued twice', accrued1 === accrued2, `${accrued1} vs ${accrued2}`);

    const run3 = await eod.runJob(tenantRow, 'accrueInterest', { businessDate: plus(11) });
    check('a new business date does run', run3.accrued > 0, JSON.stringify(run3));
    await assertBalanced('eod accrual');

    const arrears = await eod.runJob(tenantRow, 'markArrears', { businessDate: day });
    check('arrears job runs', !arrears.error, JSON.stringify(arrears));

    section('refresh token rotation and reuse detection');
    const login = await call('POST', '/api/auth/login', {
      body: { email: 'admin@opstest.local', password: 'a sufficiently long passphrase' } });
    check('login returns an access and refresh pair',
      login.status === 200 && !!login.body.accessToken && !!login.body.refreshToken);
    const first = login.body.refreshToken;

    const r1 = await call('POST', '/api/auth/refresh', { body: { refreshToken: first } });
    check('refresh rotates to a new token',
      r1.status === 200 && r1.body.refreshToken && r1.body.refreshToken !== first);

    const replay = await call('POST', '/api/auth/refresh', { body: { refreshToken: first } });
    check('replaying a spent token is rejected', replay.status === 401, String(replay.status));
    check('replay names family revocation',
      /FAMILY_REVOKED/.test(JSON.stringify(replay.body)), JSON.stringify(replay.body).slice(0, 120));

    const afterBurn = await call('POST', '/api/auth/refresh', { body: { refreshToken: r1.body.refreshToken } });
    check('the whole family is dead after a replay', afterBurn.status === 401, String(afterBurn.status));

    const login2 = await call('POST', '/api/auth/login', {
      body: { email: 'admin@opstest.local', password: 'a sufficiently long passphrase' } });
    const sessions = await call('GET', '/api/auth/sessions', { token: login2.body.accessToken });
    check('sessions lists only live tokens', sessions.status === 200 && sessions.body.length >= 1,
      String(sessions.body?.length));

    section('login rate limiting');
    let limited = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await call('POST', '/api/auth/login', {
        body: { email: 'admin@opstest.local', password: 'wrong password entirely' } });
      if (r.status === 429) { limited = true; break; }
    }
    check('repeated bad passwords get rate limited', limited);

    section('per-tenant concurrency gate');
    const gate = [];
    const release = [];
    for (let i = 0; i < 3; i += 1) release.push(await limits.acquire('gatetest', 2, 500).catch((e) => e));
    check('third acquire past a size-2 gate times out',
      release[2] instanceof Error && /CONCURRENCY_LIMIT/.test(release[2].message),
      String(release[2]?.message));
    release.slice(0, 2).forEach((r) => typeof r === 'function' && r());
    const afterRelease = await limits.acquire('gatetest', 2, 500);
    check('gate frees up after release', typeof afterRelease === 'function');
    afterRelease();

    section('backup, restore and verify');
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    const b = await backup.backupTenant(SLUG, { dir: BACKUP_DIR });
    check('backup produced a non-empty dump', b.bytes > 0 && fs.existsSync(b.file), JSON.stringify(b));
    check('backup recorded a sha256', /^[0-9a-f]{64}$/.test(b.sha256));

    const logged = await pool.query(
      "SELECT status FROM platform.backup_runs WHERE path = $1", [b.file]);
    check('backup run logged as succeeded', logged.rows[0]?.status === 'SUCCEEDED');

    const memberCountBefore = await R(async (c) => (await c.query(
      'SELECT count(*)::int AS n FROM members')).rows[0].n);
    const verified = await backup.verifyLatest(SLUG, { dir: BACKUP_DIR });
    check('restore of the newest dump succeeds', verified.ok && verified.tablesRestored > 0,
      JSON.stringify(verified));
    const memberCountAfter = await R(async (c) => (await c.query(
      'SELECT count(*)::int AS n FROM members')).rows[0].n);
    check('tenant is intact after the verify round trip',
      memberCountBefore === memberCountAfter, `${memberCountBefore} vs ${memberCountAfter}`);

    for (let i = 0; i < 3; i += 1) await backup.backupTenant(SLUG, { dir: BACKUP_DIR });
    const pruned = await backup.prune({ dir: BACKUP_DIR, keep: 2 });
    const left = fs.readdirSync(path.join(BACKUP_DIR, SLUG)).filter((f) => f.endsWith('.dump'));
    check('retention keeps only the newest N', left.length === 2 && pruned.length >= 1,
      `kept ${left.length}, pruned ${pruned.length}`);

    section('cleanup');
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query("DELETE FROM platform.users WHERE email = 'admin@opstest.local'");
    await pool.query('DELETE FROM platform.tenants WHERE slug = $1', [SLUG]);
    check('tenant removed', true);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`); console.error(e);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
  server.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
