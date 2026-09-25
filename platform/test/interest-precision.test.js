#!/usr/bin/env node
'use strict';

/**
 * Interest precision and non-working days, after Mambu's "Truncating and
 * rounding interest" and "Installments on Non-Working Days": accruals keep
 * the fraction of a cent between runs so daily accrual never drifts from the
 * interest earned, and a product decides what happens to an installment
 * that falls on a weekend or holiday.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/schedule');
const acct = require('../src/domain/accounting');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'precisiontest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4095;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;
const addDays = (iso, n) => S.isoDate(S.addDays(iso, n));

let server;
let token;
async function call(method, p, body) {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, reason: d?.errors?.[0]?.errorReason || '', source: d?.errors?.[0]?.errorSource || '' };
}

const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
let seq = 0;
async function disbursed(productId, principal, term, on) {
  return T(async (c) => {
    seq += 1;
    const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'P',$1) RETURNING *`, [`P${String(seq).padStart(4, '0')}`])).rows[0];
    const l = await L.apply(c, { memberId: m.id, productId, principal, termMonths: term, createdBy: 'officer' });
    await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
    await L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: on, createdBy: 'teller' });
    return l;
  });
}
const preview = (productId, disbursedOn, termMonths = 6) => T((c) => L.previewSchedule(c, { productId, principal: 60000, termMonths, disbursedOn }));

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Precision SACCO', mfaRequiredRoles: [], adminEmail: 'admin@precisiontest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@precisiontest.local', password: PASSWORD })).body.accessToken;
    const mk = (id, body) => call('POST', '/api/loan-products', { id, name: id, ...GL, enforceDepositMultiplier: false, maxTerm: 36, ...body });
    const made = await Promise.all([
      mk('DYN', { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1 }),
      mk('A365', { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1.37, dayCount: 'ACTUAL_365' }),
      mk('CMP', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', interestType: 'COMPOUND', rateFrequency: 'PER_YEAR', monthlyRate: 13 }),
      mk('FIX', { productType: 'FIXED_TERM', method: 'REDUCING', monthlyRate: 1.1 }),
    ]);
    check('products created', made.every((r) => r.status === 201), made.map((r) => `${r.status} ${r.source}`).join(' | '));

    // ----------------------------------------------------------------------
    section('daily accrual adds up to the interest earned');
    // 10,000 at 1% a month on 30/360 earns 3.3333... a day. Rounded every
    // day that was 3.33 x 30 = 99.90 for April; April earns 100.00.
    const start = '2026-04-01';
    const daily = await disbursed('DYN', 10000, 12, start);
    const once = await disbursed('DYN', 10000, 12, start);
    for (let d = 1; d <= 30; d += 1) await T((c) => L.accrueInterest(c, daily.id, { valueDate: addDays(start, d), createdBy: 'eod' }));
    await T((c) => L.accrueInterest(c, once.id, { valueDate: addDays(start, 30), createdBy: 'eod' }));
    const dRow = await loanRow(daily.id);
    const oRow = await loanRow(once.id);
    check('thirty daily runs accrue 100.00, not 99.90', Number(dRow.interest_accrued) === 100, String(dRow.interest_accrued));
    check('the same as one run over the thirty days', Number(oRow.interest_accrued) === Number(dRow.interest_accrued));
    check('what is left over is under a cent', Math.abs(Number(dRow.interest_accrual_carry)) < 0.01, String(dRow.interest_accrual_carry));
    const posted = await Rd(async (c) => (await c.query(
      "SELECT COALESCE(sum(amount),0)::float8 AS t, count(*)::int AS n FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_INTEREST_ACCRUAL'", [daily.id])).rows[0]);
    check('the accrual transactions posted add up to it too', round(posted.t) === 100 && posted.n === 30, JSON.stringify(posted));
    const days = await Rd(async (c) => (await c.query(
      "SELECT amount::float8 AS a FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_INTEREST_ACCRUAL' ORDER BY created_at", [daily.id])).rows.map((r) => r.a));
    check('most days post 3.33 and every third day 3.34', days.filter((a) => a === 3.34).length === 10 && days.filter((a) => a === 3.33).length === 20, days.join(','));

    const odd = await disbursed('A365', 12345.67, 12, start);
    let expected = 0;
    for (let d = 1; d <= 90; d += 1) {
      await T((c) => L.accrueInterest(c, odd.id, { valueDate: addDays(start, d), createdBy: 'eod' }));
    }
    const oddRow = await loanRow(odd.id);
    expected = S.interestBetween(12345.67, { rate: 1.37, convention: 'ACTUAL_365' }, start, addDays(start, 90), { exact: true });
    check('ninety days on Actual/365 accrue the unrounded interest for ninety days, rounded once',
      Number(oddRow.interest_accrued) === round(expected), `${oddRow.interest_accrued} vs ${expected}`);

    const cmp = await disbursed('CMP', 7777, 12, start);
    for (let d = 1; d <= 31; d += 1) await T((c) => L.accrueInterest(c, cmp.id, { valueDate: addDays(start, d), createdBy: 'eod' }));
    const cmpExact = S.interestBetween(7777, { rate: 13, frequency: 'PER_YEAR', interestType: 'COMPOUND' }, start, addDays(start, 31), { exact: true });
    check('compound daily accruals match compound interest for the period', Math.abs(Number((await loanRow(cmp.id)).interest_accrued) - round(cmpExact)) <= 0.01,
      `${(await loanRow(cmp.id)).interest_accrued} vs ${cmpExact}`);

    const fix = await disbursed('FIX', 9999, 6, start);
    for (let d = 1; d <= 30; d += 1) await T((c) => L.accrueInterest(c, fix.id, { valueDate: addDays(start, d), createdBy: 'eod' }));
    const first = await Rd(async (c) => (await c.query('SELECT interest_due FROM loan_installments WHERE loan_id = $1 ORDER BY number LIMIT 1', [fix.id])).rows[0]);
    check('a fixed-term loan accrues exactly its first installment\'s interest over the first period',
      Number((await loanRow(fix.id)).interest_accrued) === Number(first.interest_due), `${(await loanRow(fix.id)).interest_accrued} vs ${first.interest_due}`);
    const tb = await Rd((c) => acct.trialBalance(c));
    check('trial balance balances', tb.balanced);

    // ----------------------------------------------------------------------
    section('installments on non-working days');
    // Disbursed Saturday 17 January 2026, monthly: the fourth installment's
    // date, 17 May 2026, is a Sunday.
    const d0 = '2026-01-17';
    const rules = await Promise.all(['DO_NOT_RESCHEDULE', 'MOVE_FORWARD', 'MOVE_BACKWARD', 'EXTEND_SCHEDULE'].map((rule, i) =>
      mk(`NW${i}`, { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, nonWorkingDays: rule })));
    check('a product takes each of Mambu\'s four rules', rules.every((r) => r.status === 201 && r.body.nonWorkingDays), rules.map((r) => r.source).join('|'));
    const bad = await mk('NWBAD', { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, nonWorkingDays: 'SOMETIMES' });
    check('and refuses anything else', bad.status === 400);
    const due = (sched) => sched.installments.map((i) => i.dueDate);
    const keep = await preview('NW0', d0);
    check('do not reschedule: the installment stays on Sunday 17 May', due(keep)[3] === '2026-05-17', due(keep).join(','));
    const fwd = await preview('NW1', d0);
    check('move forward: Monday 18 May', due(fwd)[3] === '2026-05-18' && fwd.installments[3].nominalDue === '2026-05-17', due(fwd).join(','));
    const back = await preview('NW2', d0);
    check('move backward: Friday 15 May', due(back)[3] === '2026-05-15', due(back).join(','));
    const ext = await preview('NW3', d0);
    check('extend schedule: May is skipped and the rest move a month on, still six installments',
      due(ext).join(',') === '2026-02-17,2026-03-17,2026-04-17,2026-06-17,2026-07-17,2026-08-17', due(ext).join(','));
    check('and the installment after the gap carries two months of interest',
      ext.installments[3].interest === round(2 * fwd.installments[3].interest), `${ext.installments[3].interest} vs one month ${fwd.installments[3].interest}`);
    check('existing products keep moving forward', (await Rd(async (c) => (await c.query("SELECT non_working_days FROM loan_products WHERE id = 'DYN'")).rows[0].non_working_days)) === 'MOVE_FORWARD');

    await T((c) => c.query("INSERT INTO holidays (holiday_date, name) VALUES ('2026-06-17', 'Test holiday'), ('2026-04-17', 'Another')"));
    const fwdH = await preview('NW1', d0);
    check('a holiday counts as a non-working day: 17 June moves to 18 June', due(fwdH)[4] === '2026-06-18', due(fwdH).join(','));
    const extH = await preview('NW3', d0);
    check('and extend skips it too', due(extH).join(',') === '2026-02-17,2026-03-17,2026-07-17,2026-08-17,2026-09-17,2026-11-17', due(extH).join(','));
    const backH = await preview('NW2', d0);
    check('move backward steps over a holiday too: 17 April (holiday, Friday) goes to Thursday 16 April', due(backH)[2] === '2026-04-16', due(backH).join(','));
    const nwLoan = await disbursed('NW3', 6000, 6, d0);
    const saved = await Rd(async (c) => (await c.query('SELECT due_date::text AS d, nominal_due::text AS n FROM loan_installments WHERE loan_id = $1 ORDER BY number', [nwLoan.id])).rows);
    check('a disbursed loan is saved with the extended dates', saved.map((x) => x.d).join(',') === due(extH).join(',') && saved.every((x) => x.d === x.n), saved.map((x) => x.d).join(','));
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
