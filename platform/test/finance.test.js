#!/usr/bin/env node
'use strict';

/**
 * Penalties, share purchase reversal, financial statements, prudential
 * ratios, backup key rotation and offsite pull.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_A = crypto.randomBytes(48).toString('base64');
const KEY_B = crypto.randomBytes(48).toString('base64');
process.env.BACKUP_ENCRYPTION_KEY = KEY_A;

const OFFSITE = path.join(__dirname, '..', '.tmp-offsite-fin');
const LOCAL = path.join(__dirname, '..', '.tmp-backups-fin');
process.env.BACKUP_OFFSITE = `dir:${OFFSITE}`;

const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/savings');
const SH = require('../src/domain/shares');
const P = require('../src/domain/penalties');
const R = require('../src/domain/reports');
const acct = require('../src/domain/accounting');
const crypt = require('../src/ops/crypt');
const offsite = require('../src/ops/offsite');
const backup = require('../src/ops/backup');
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
  catch (e) { check(label, matcher ? matcher(e) : true, e.message.slice(0, 150)); }
}
const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const SLUG = 'fintest';
const SCHEMA = `tenant_${SLUG}`;
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);

async function assertBalanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced,
    `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

(async () => {
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Finance Test SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@fintest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});

    const tagged = await Rd(async (c) => (await c.query(
      "SELECT count(*)::int AS n FROM gl_accounts WHERE regulatory_class IS NOT NULL")).rows[0].n);
    check('chart of accounts is tagged for reporting', tagged >= 12, String(tagged));

    const { m1, m2, sav1, sav2, sh1 } = await T(async (c) => {
      const a = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name) VALUES ('M1','Grace','Njeri') RETURNING *`)).rows[0];
      const b = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name) VALUES ('M2','Peter','Otieno') RETURNING *`)).rows[0];
      return { m1: a, m2: b,
        sav1: await S.open(c, { memberId: a.id }), sav2: await S.open(c, { memberId: b.id }),
        sh1: await SH.open(c, { memberId: a.id }) };
    });
    await T((c) => S.deposit(c, sav1.id, { amount: 200000, channelId: 'cash', createdBy: 'test' }));
    await T((c) => S.deposit(c, sav2.id, { amount: 100000, channelId: 'mpesa', createdBy: 'test' }));

    section('penalties');
    await T((c) => c.query(
      `INSERT INTO loan_products (id, name, method, monthly_rate, max_term, processing_fee,
         penalty_rate, penalty_basis, penalty_tolerance_days,
         gl_portfolio, gl_interest_inc, gl_fee_inc, gl_penalty_inc)
       VALUES ('PL01','Penalty Loan','FLAT',1.000,12,0, 0.500,'OVERDUE_ALL',3,
               '100-100','400-100','400-200','400-200')`));

    const loan = await T(async (c) => {
      const l = await L.apply(c, {
        memberId: m1.id, productId: 'PL01', principal: 120000, termMonths: 12, createdBy: 'test' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'test' });
      await L.disburse(c, l.id, { amount: 120000, channelId: 'bank', createdBy: 'test' });
      return l;
    });

    // Nothing overdue yet.
    const none = await T((c) => P.accrueForLoan(c, loan.id, {}));
    check('no penalty while nothing is overdue', none.length === 0, String(none.length));

    // Backdate installment 1 so it is two days late, inside the 3 day grace.
    await T((c) => c.query(
      'UPDATE loan_installments SET due_date = $1::date WHERE loan_id = $2 AND number = 1',
      [daysAgo(2), loan.id]));
    const graced = await T((c) => P.accrueForLoan(c, loan.id, {}));
    check('grace period suppresses the charge', graced.length === 0, String(graced.length));

    // Now ten days late, past grace.
    await T((c) => c.query(
      'UPDATE loan_installments SET due_date = $1::date WHERE loan_id = $2 AND number = 1',
      [daysAgo(10), loan.id]));
    const charged = await T((c) => P.accrueForLoan(c, loan.id, {}));
    check('penalty charged past the grace period', charged.length === 1, String(charged.length));

    const inst1 = await Rd(async (c) => (await c.query(
      'SELECT * FROM loan_installments WHERE loan_id = $1 AND number = 1', [loan.id])).rows[0]);
    const arrears = round(inst1.principal_due + inst1.interest_due + inst1.fee_due);
    // The first charge after the grace covers all ten late days.
    check('penalty is the rate on the overdue amount, not the whole loan, for each late day since the due date',
      Number(charged[0].amount) === round(arrears * 0.005 * 10) && Number(charged[0].days_charged) === 10,
      `${charged[0].amount} vs ${round(arrears * 0.005 * 10)} on arrears ${arrears}`);
    check('days late recorded', charged[0].days_late === 10, String(charged[0].days_late));
    await assertBalanced('penalty accrual');

    const again = await T((c) => P.accrueForLoan(c, loan.id, {}));
    check('rerunning the same day charges nothing more', again.length === 0, String(again.length));
    const totalPenalty = await T(async (c) => (await L.lock(c, loan.id)).penalty_accrued);
    check('penalty accrued once only', Number(totalPenalty) === Number(charged[0].amount),
      `${totalPenalty} vs ${charged[0].amount}`);

    section('penalty is repaid before anything else');
    const rep = await T((c) => L.repay(c, loan.id, { amount: 2000, createdBy: 'test' }));
    check('allocation takes penalty first',
      rep.allocation.penalty === Number(charged[0].amount), JSON.stringify(rep.allocation));
    await assertBalanced('penalty repayment');

    section('waiving a penalty reverses it rather than deleting it');
    await T((c) => c.query(
      'UPDATE loan_installments SET due_date = $1::date WHERE loan_id = $2 AND number = 2',
      [daysAgo(20), loan.id]));
    const second = await T((c) => P.accrueForLoan(c, loan.id, {}));
    check('second installment penalised', second.length === 1, String(second.length));

    const waived = await T((c) => P.waive(c, second[0].id, { reason: 'goodwill', createdBy: 'test' }));
    check('waive reports the amount', waived.amount === Number(second[0].amount));
    const stillThere = await Rd(async (c) => (await c.query(
      'SELECT waived_at, waived_by FROM penalty_charges WHERE id = $1', [second[0].id])).rows[0]);
    check('the charge record survives the waiver', !!stillThere.waived_at && !!stillThere.waived_by);
    await throws('cannot waive twice',
      () => T((c) => P.waive(c, second[0].id, { createdBy: 'test' })),
      (e) => /ALREADY_WAIVED/.test(e.message));
    await assertBalanced('penalty waiver');

    section('EOD runs penalties idempotently');
    const tenantRow = (await pool.query('SELECT * FROM platform.tenants WHERE slug=$1', [SLUG])).rows[0];
    const day = '2026-07-01';
    const r1 = await eod.runJob(tenantRow, 'accruePenalties', { businessDate: day });
    const r2 = await eod.runJob(tenantRow, 'accruePenalties', { businessDate: day });
    check('second penalty run for the same date is refused', r2.skipped === 'ALREADY_RUN',
      JSON.stringify(r2));
    check('first run reported its work', typeof r1.chargesCreated === 'number', JSON.stringify(r1));

    section('share purchase reversal');
    const buy = await T((c) => SH.purchase(c, sh1.id, { units: 200, channelId: 'cash', createdBy: 'test' }));
    const equityBefore = await Rd((c) => acct.balance(c, '300-100'));
    check('purchase credited share capital', equityBefore === -20000, String(equityBefore));

    const rev = await T((c) => SH.reversePurchase(c, buy.reference, { createdBy: 'test' }));
    check('reversal recorded', rev.kind === 'REVERSAL');
    const equityAfter = await Rd((c) => acct.balance(c, '300-100'));
    check('share capital unwound', equityAfter === 0, String(equityAfter));
    const unitsAfter = await Rd(async (c) => (await c.query(
      'SELECT units FROM share_accounts WHERE id = $1', [sh1.id])).rows[0].units);
    check('units removed', Number(unitsAfter) === 0, String(unitsAfter));
    await throws('cannot reverse twice',
      () => T((c) => SH.reversePurchase(c, buy.reference, { createdBy: 'test' })),
      (e) => /ALREADY_REVERSED/.test(e.message));
    await assertBalanced('share reversal');

    section('reversal is refused when it would go negative or break a dividend');
    const buy2 = await T((c) => SH.purchase(c, sh1.id, { units: 100, channelId: 'cash', createdBy: 'test' }));
    const sh2b = await T((c) => SH.open(c, { memberId: m2.id }));
    // Leave exactly the 10 unit minimum holding: transferring more would be
    // refused by the product rule, which is a different test.
    await T((c) => SH.transfer(c, sh1.id, { toAccountId: sh2b.id, units: 90, createdBy: 'test' }));
    await throws('refused when the units have been transferred away',
      () => T((c) => SH.reversePurchase(c, buy2.reference, { createdBy: 'test' })),
      (e) => /NO_LONGER_HELD/.test(e.message));

    const buy3 = await T((c) => SH.purchase(c, sh2b.id, { units: 50, channelId: 'cash', createdBy: 'test' }));
    await T((c) => SH.declare(c, { financialYear: 2030, ratePercent: 5, createdBy: 'test' }));
    await T((c) => SH.allocate(c, 2030, { createdBy: 'test' }));
    await throws('refused once a dividend was allocated on that holding',
      () => T((c) => SH.reversePurchase(c, buy3.reference, { createdBy: 'test' })),
      (e) => /DIVIDEND_2030_ALREADY_ALLOCATED/.test(e.message));

    section('financial statements');
    const is = await Rd((c) => R.incomeStatement(c, {}));
    check('income statement has income lines', is.income.length > 0, JSON.stringify(is.income).slice(0, 120));
    check('surplus is income minus expenses',
      is.surplus === round(is.totalIncome - is.totalExpenses), JSON.stringify(is));

    const bs = await Rd((c) => R.balanceSheet(c, {}));
    check('balance sheet balances', bs.balances === true,
      `assets ${bs.totalAssets} vs liabilities ${bs.totalLiabilities} + equity ${bs.totalEquity}, diff ${bs.difference}`);
    check('unclosed surplus is shown as its own equity line',
      bs.equity.some((e) => /Surplus for the period/.test(e.name)),
      JSON.stringify(bs.equity.map((e) => e.name)));
    check('balance sheet surplus matches the income statement',
      bs.equity.find((e) => /Surplus/.test(e.name))?.amount === is.surplus);

    section('prudential ratios');
    const pr = await Rd((c) => R.prudentialRatios(c, {}));
    const byCode = Object.fromEntries(pr.measures.map((m) => [m.code, m]));
    check('total assets equals the balance sheet', pr.inputs.totalAssets === bs.totalAssets,
      `${pr.inputs.totalAssets} vs ${bs.totalAssets}`);
    check('member deposits picked up from the tagged account',
      pr.inputs.memberDeposits > 0, String(pr.inputs.memberDeposits));
    check('liquidity ratio computed',
      typeof byCode.LIQUIDITY_RATIO.value === 'number', JSON.stringify(byCode.LIQUIDITY_RATIO));
    check('each measure carries its threshold and compliance flag',
      pr.measures.every((m) => m.minimum !== null && m.compliant !== undefined));
    check('thresholds are flagged as needing confirmation',
      pr.measures.some((m) => /UNVERIFIED/.test(m.sourceNote || '')),
      'no UNVERIFIED note found');
    check('report carries the disclaimer', /confirmed against the current SASRA/.test(pr.disclaimer));

    // The thresholds live in data, so a SACCO can correct them.
    await T((c) => c.query(
      "UPDATE prudential_limits SET minimum = 99 WHERE code = 'LIQUIDITY_RATIO'"));
    const pr2 = await Rd((c) => R.prudentialRatios(c, {}));
    const liq2 = pr2.measures.find((m) => m.code === 'LIQUIDITY_RATIO');
    check('changing the limit changes the compliance verdict', liq2.minimum === 99,
      String(liq2.minimum));

    section('portfolio at risk');
    const par = await Rd((c) => R.portfolioAtRisk(c, {}));
    check('PAR buckets returned', par.buckets.length > 0, JSON.stringify(par.buckets));
    check('PAR percent is a number between 0 and 100',
      par.parPercent >= 0 && par.parPercent <= 100, String(par.parPercent));
    check('the overdue loan shows in a risk bucket',
      par.buckets.some((b) => b.bucket !== 'CURRENT' && b.loans > 0),
      JSON.stringify(par.buckets));

    section('backup key rotation');
    fs.rmSync(LOCAL, { recursive: true, force: true });
    fs.rmSync(OFFSITE, { recursive: true, force: true });

    const b1 = await backup.backupTenant(SLUG, { dir: LOCAL });
    const meta1 = crypt.inspect(b1.file);
    check('file records which key encrypted it',
      meta1.version === 2 && meta1.keyId === crypt.keyId(KEY_A), JSON.stringify(meta1));

    // Rotate: new key current, old key retained for reading.
    process.env.BACKUP_ENCRYPTION_KEY = KEY_B;
    process.env.BACKUP_ENCRYPTION_KEYS_OLD = KEY_A;

    const readOld = await crypt.decryptFile(b1.file, path.join(LOCAL, 'old.dump'));
    check('an old backup still decrypts after rotation',
      readOld.keyId === crypt.keyId(KEY_A), JSON.stringify(readOld));
    fs.unlinkSync(path.join(LOCAL, 'old.dump'));

    const rek = await backup.rekeyAll({ dir: LOCAL, slug: SLUG });
    check('rekey re-encrypted the old file',
      rek.files.some((f) => f.ok && f.to === crypt.keyId(KEY_B)), JSON.stringify(rek.files));
    const meta2 = crypt.inspect(b1.file);
    check('file now names the new key', meta2.keyId === crypt.keyId(KEY_B), JSON.stringify(meta2));

    // Now the old key alone must fail, proving the rekey really happened.
    const savedOld = process.env.BACKUP_ENCRYPTION_KEYS_OLD;
    process.env.BACKUP_ENCRYPTION_KEY = KEY_A;
    delete process.env.BACKUP_ENCRYPTION_KEYS_OLD;
    await throws('the retired key alone can no longer read it',
      () => crypt.decryptFile(b1.file, path.join(LOCAL, 'nope.dump')),
      (e) => /authentication/i.test(e.message));
    process.env.BACKUP_ENCRYPTION_KEY = KEY_B;
    process.env.BACKUP_ENCRYPTION_KEYS_OLD = savedOld;

    const rek2 = await backup.rekeyAll({ dir: LOCAL, slug: SLUG });
    check('rekey skips files already on the current key',
      rek2.files.every((f) => f.skipped === 'ALREADY_CURRENT_KEY'), JSON.stringify(rek2.files));

    const report = backup.keyReport({ dir: LOCAL });
    check('key report lists every stored backup', report.length >= 1, JSON.stringify(report));

    section('offsite pull, both drivers');
    const b2 = await backup.backupTenant(SLUG, { dir: LOCAL });
    const shipped = offsite.list({ slug: SLUG });
    check('shipped offsite', shipped.length >= 1, String(shipped.length));

    const pulledDir = path.join(LOCAL, 'pull-dir.enc');
    await offsite.fetch(path.basename(b2.file), { slug: SLUG, to: pulledDir });
    check('dir driver pulls back', fs.existsSync(pulledDir)
      && fs.statSync(pulledDir).size === b2.bytes);

    // command driver, using cp as the stand-in for aws s3 cp / rclone.
    const cmdStore = path.join(OFFSITE, SLUG);
    const pulledCmd = path.join(LOCAL, 'pull-cmd.enc');
    await offsite.fetch(path.basename(b2.file), {
      target: 'cmd:/bin/true',
      pull: `cmd:/bin/cp ${cmdStore}/{name} {dest}`,
      slug: SLUG, to: pulledCmd,
    });
    check('command driver pulls back', fs.existsSync(pulledCmd)
      && fs.statSync(pulledCmd).size === b2.bytes, String(fs.existsSync(pulledCmd)));

    const roundTrip = await crypt.decryptFile(pulledCmd, path.join(LOCAL, 'cmd.dump'));
    check('the pulled copy decrypts', roundTrip.bytes > 0, JSON.stringify(roundTrip));

    await throws('a command pull with no pull command configured says so',
      () => offsite.fetch('x.enc', { target: 'cmd:/bin/true', pull: null, slug: SLUG,
        to: path.join(LOCAL, 'x.enc') }),
      (e) => /BACKUP_OFFSITE_PULL/.test(e.message));

    section('cleanup');
    fs.rmSync(LOCAL, { recursive: true, force: true });
    fs.rmSync(OFFSITE, { recursive: true, force: true });
    await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query("DELETE FROM platform.users WHERE email = 'admin@fintest.local'");
    await pool.query('DELETE FROM platform.tenants WHERE slug = $1', [SLUG]);
    check('tenant removed', true);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`); console.error(e);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
