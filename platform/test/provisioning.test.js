#!/usr/bin/env node
'use strict';

/**
 * Loan loss provisioning by PAR bucket.
 *
 * The rates used here are test fixtures chosen to make the arithmetic easy
 * to check by hand. They are not a regulator's rates and nothing in the
 * shipped migration carries a rate at all.
 */

const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/savings');
const PV = require('../src/domain/provisioning');
const acct = require('../src/domain/accounting');
const eod = require('../src/ops/eod');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
async function throws(label, fn, matcher) {
  try { await fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, matcher ? matcher(e) : true, e.message.slice(0, 160)); }
}

const SLUG = 'pvtest';
const SCHEMA = `tenant_${SLUG}`;
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const daysOn = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function assertBalanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced,
    `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}

/** Credit balance of the allowance, which is what "provision held" means. */
const allowanceHeld = () => Rd(async (c) => -(await acct.balance(c, PV.GL_ALLOWANCE)));

(async () => {
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Provisioning Test SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@pvtest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});

    const allowance = await Rd(async (c) => (await c.query(
      "SELECT * FROM gl_accounts WHERE code = $1", [PV.GL_ALLOWANCE])).rows[0]);
    check('allowance account exists as a contra-asset in the portfolio class',
      allowance && allowance.type === 'ASSET' && allowance.regulatory_class === 'LOAN_PORTFOLIO',
      JSON.stringify(allowance));

    section('nothing is provisioned until someone sets the rates');
    const seeded = await Rd((c) => PV.bands(c));
    check('bands are seeded', seeded.length === 5, String(seeded.length));
    check('no band ships with a rate', seeded.every((b) => b.rate_percent === null),
      JSON.stringify(seeded.map((b) => [b.code, b.rate_percent])));

    await throws('computing refuses while any rate is unset',
      () => Rd((c) => PV.compute(c, {})),
      (e) => /PROVISION_RATES_NOT_CONFIGURED/.test(e.message));
    await throws('running refuses while any rate is unset',
      () => T((c) => PV.run(c, {})),
      (e) => /PROVISION_RATES_NOT_CONFIGURED/.test(e.message));

    section('the nightly job while nothing is configured');
    const tenantRow = (await pool.query(
      'SELECT id, slug, schema_name FROM platform.tenants WHERE slug=$1', [SLUG])).rows[0];
    const nightly = await eod.runJob(tenantRow, 'provision', { businessDate: daysAgo(400) });
    check('the EOD job records a skip rather than a failure while rates are unset',
      nightly.skipped === 'RATES_NOT_CONFIGURED', JSON.stringify(nightly));
    const jr = (await pool.query(
      `SELECT status FROM platform.job_runs WHERE schema_name=$1 AND job='provision'
       ORDER BY started_at DESC LIMIT 1`, [tenantRow.schema_name])).rows[0];
    check('so the job run is SUCCEEDED, not FAILED', jr.status === 'SUCCEEDED', jr.status);
    check('provisioning is in the default daily sequence, after arrears',
      eod.DEFAULT_JOBS.indexOf('provision') > eod.DEFAULT_JOBS.indexOf('markArrears'),
      eod.DEFAULT_JOBS.join(','));

    section('the database refuses overlapping bands');
    await throws('a band that overlaps another is rejected',
      () => T((c) => PV.setBand(c, 'WATCH', { maxDays: 200, createdBy: 'test' })),
      (e) => /provision_bands_no_overlap|exclusion/i.test(e.message));

    section('rates, set by hand');
    const RATES = { PERFORMING: 1, WATCH: 5, SUBSTANDARD: 25, DOUBTFUL: 50, LOSS: 100 };
    await T(async (c) => {
      for (const [code, rate] of Object.entries(RATES)) {
        await PV.setBand(c, code, { ratePercent: rate, sourceNote: 'test fixture', createdBy: 'test' });
      }
    });
    const audited = await Rd(async (c) => (await c.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action='PROVISION_BAND_CHANGED'")).rows[0].n);
    check('every rate change is audited', audited === 5, String(audited));

    section('a performing book provisions at the performing rate');
    const { m1, loan } = await T(async (c) => {
      const m = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name)
         VALUES ('M1','Alice','Wanjiku') RETURNING *`)).rows[0];
      const sav = await S.open(c, { memberId: m.id });
      await S.deposit(c, sav.id, { amount: 500000, channelId: 'cash', createdBy: 'test' });
      const l = await L.apply(c, {
        memberId: m.id, productId: 'NL01', principal: 120000, termMonths: 12, createdBy: 'test' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'test' });
      await L.disburse(c, l.id, { amount: 120000, channelId: 'bank', createdBy: 'test' });
      return { m1: m, loan: l };
    });

    const p1 = await Rd((c) => PV.compute(c, {}));
    const performing = p1.lines.find((l) => l.band === 'PERFORMING');
    check('the whole portfolio is performing on day one',
      performing.loans === 1 && performing.outstanding === 120000, JSON.stringify(performing));
    check('required provision is 1% of it', p1.requiredTotal === 1200, String(p1.requiredTotal));
    check('nothing is held yet', p1.heldTotal === 0, String(p1.heldTotal));

    // The first run goes through the nightly job, the way it will in
    // production, with today as the business date.
    const r1 = await eod.runJob(tenantRow, 'provision', { businessDate: daysAgo(0) });
    check('once configured, the nightly job posts the movement',
      r1.movement === 1200 && r1.entryId, JSON.stringify({ movement: r1.movement, skipped: r1.skipped }));
    check('the allowance now holds it', (await allowanceHeld()) === 1200);
    const expense = await Rd((c) => acct.balance(c, PV.GL_EXPENSE));
    check('the charge is in the provision expense account', expense === 1200, String(expense));
    await assertBalanced('first provision run');

    section('a rerun for the same date does nothing');
    const again = await T((c) => PV.run(c, { createdBy: 'test' }));
    check('second run for the same date is refused by the index',
      again.skipped === 'ALREADY_RUN', JSON.stringify(again.skipped));
    check('and the allowance is unchanged', (await allowanceHeld()) === 1200);

    section('arrears move the loan to a worse band and only the delta is posted');
    await T((c) => c.query(
      `UPDATE loan_installments SET due_date = $1::date WHERE loan_id = $2 AND number = 1`,
      [daysAgo(45), loan.id]));

    const p2 = await Rd((c) => PV.compute(c, {}));
    const sub = p2.lines.find((l) => l.band === 'SUBSTANDARD');
    check('45 days late lands in the 31-180 band',
      sub.loans === 1 && sub.outstanding === 120000, JSON.stringify(sub));
    check('required provision is now 25% of it', p2.requiredTotal === 30000, String(p2.requiredTotal));
    check('the movement is the difference, not the whole balance',
      p2.movement === 28800, String(p2.movement));

    const r2 = await T((c) => PV.run(c, { asAt: daysOn(1), createdBy: 'test' }));
    check('the second run posts only the delta', r2.movement === 28800, String(r2.movement));
    check('the allowance holds the required amount, not the sum of runs',
      (await allowanceHeld()) === 30000, String(await allowanceHeld()));
    await assertBalanced('second provision run');

    section('a recovering book releases the provision');
    await T((c) => c.query(
      "UPDATE loan_accounts SET status = 'CLOSED_REPAID' WHERE id = $1", [loan.id]));
    const r3 = await T((c) => PV.run(c, { asAt: daysOn(2), createdBy: 'test' }));
    check('the release is a negative movement', r3.movement === -30000, String(r3.movement));
    check('the allowance is back to zero', (await allowanceHeld()) === 0, String(await allowanceHeld()));
    const expenseAfter = await Rd((c) => acct.balance(c, PV.GL_EXPENSE));
    check('the release credits the same expense account rather than income',
      expenseAfter === 0, String(expenseAfter));
    await assertBalanced('provision release');

    section('a run can be reversed');
    const rev = await T((c) => PV.reverseRun(c, r3.runId, { reason: 'posted in error', createdBy: 'test' }));
    check('reversing reports the run it undid', rev.reversed === true);
    check('the allowance returns to what it was before that run',
      (await allowanceHeld()) === 30000, String(await allowanceHeld()));
    await throws('a reversed run cannot be reversed twice',
      () => T((c) => PV.reverseRun(c, r3.runId, { reason: 'again', createdBy: 'test' })),
      (e) => /ALREADY_REVERSED/.test(e.message));
    await assertBalanced('provision reversal');

    section('history');
    const hist = await Rd((c) => PV.history(c, {}));
    check('every run is on the record, including the reversed one',
      hist.length === 3 && hist.filter((h) => h.status === 'REVERSED').length === 1,
      JSON.stringify(hist.map((h) => [String(h.as_at).slice(0, 10), h.status, h.movement])));
    check('each run kept its band detail',
      hist.every((h) => Array.isArray(h.lines) && h.lines.length === 5),
      JSON.stringify(hist.map((h) => h.lines.length)));

    section('the allowance nets against the portfolio in reporting');
    await T((c) => PV.run(c, { asAt: daysOn(3), createdBy: 'test' }));  // back to zero required
    const R = require('../src/domain/reports');
    const bs = await Rd((c) => R.balanceSheet(c, {}));
    check('the balance sheet still balances with an allowance in it', bs.balances,
      `difference ${bs.difference}`);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
