#!/usr/bin/env node
'use strict';

/**
 * Index interest rates and Adjustable Interest Rates, after Mambu: index
 * sources with dated values, INDEX products (index plus spread within a
 * floor and ceiling, reviewed on a frequency), adjustable rate periods on a
 * loan, and what a change of rate does to interest and the schedule.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const R = require('../src/domain/rates');
const acct = require('../src/domain/accounting');

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

const SLUG = 'ratestest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4096;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;

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
const mk = (id, body) => call('POST', '/api/loan-products', { id, name: id, ...GL, enforceDepositMultiplier: false, maxTerm: 48, ...body });
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
const sched = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id])).rows);
let seq = 0;
async function member(c) {
  seq += 1;
  return (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'R',$1) RETURNING *`, [`R${String(seq).padStart(4, '0')}`])).rows[0];
}
const approved = (productId, principal, term, extra = {}) => T(async (c) => {
  const m = await member(c);
  const l = await L.apply(c, { memberId: m.id, productId, principal, termMonths: term, createdBy: 'officer', ...extra });
  await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
  return l;
});
const disburse = (id, date, extra = {}) => T((c) => L.disburse(c, id, { channelId: 'bank', valueDate: date, createdBy: 'teller', ...extra }));
const review = (id, date) => T((c) => R.reviewLoan(c, id, { date, createdBy: 'test' }));

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Rates SACCO', mfaRequiredRoles: [], adminEmail: 'admin@ratestest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@ratestest.local', password: PASSWORD })).body.accessToken;

    // ----------------------------------------------------------------------
    section('index rate sources');
    const src = await call('POST', '/api/index-rates', { id: 'CBR', name: 'Central Bank Rate' });
    check('an index source is created', src.status === 201, `${src.status} ${src.source}`);
    for (const [validFrom, rate] of [['2022-01-01', 5], ['2023-02-01', 6]]) {
      const r = await call('POST', '/api/index-rates/CBR/rates', { validFrom, rate });
      check(`CBR is ${rate}% from ${validFrom}`, r.status === 201, r.source);
    }
    await call('POST', '/api/index-rates', { id: 'FX', name: 'Other index' });
    await call('POST', '/api/index-rates/FX/rates', { validFrom: '2022-01-01', rate: 4 });
    await call('POST', '/api/index-rates/FX/rates', { validFrom: '2023-01-05', rate: 5 });
    const list = await call('GET', '/api/index-rates');
    check('sources list with their current rate', list.status === 200 && Number(list.body.find((x) => x.id === 'CBR').current_rate) === 6);
    check('the value in force on a date is the latest dated on or before it',
      (await Rd((c) => R.indexRateOn(c, 'CBR', '2023-01-31'))) === 5 && (await Rd((c) => R.indexRateOn(c, 'CBR', '2023-02-01'))) === 6);

    section('INDEX products');
    let r = await mk('BAD1', { productType: 'DYNAMIC_TERM', method: 'REDUCING', interestRateSource: 'INDEX', monthlyRate: 2, rateReviewCount: 1, rateReviewUnit: 'MONTHS' });
    check('an INDEX product needs a source', r.status === 400, r.source);
    r = await mk('BAD2', { productType: 'FIXED_TERM', method: 'FLAT', interestRateSource: 'INDEX', indexSourceId: 'CBR', monthlyRate: 2, rateReviewCount: 1, rateReviewUnit: 'MONTHS' });
    check('and cannot be FLAT, as in Mambu', r.status === 400, r.source);
    r = await mk('BAD3', { productType: 'DYNAMIC_TERM', method: 'REDUCING', interestRateSource: 'INDEX', indexSourceId: 'NOPE', monthlyRate: 2, rateReviewCount: 1, rateReviewUnit: 'MONTHS' });
    check('nor name a source that does not exist', r.status === 400, r.source);
    const ix = await mk('IX', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', rateFrequency: 'PER_YEAR',
      interestRateSource: 'INDEX', indexSourceId: 'CBR', monthlyRate: 2, rateMin: 0, rateMax: 10, rateReviewCount: 1, rateReviewUnit: 'MONTHS' });
    check('an INDEX product: CBR plus a 2% spread, reviewed monthly', ix.status === 201 && ix.body.interestRateSource === 'INDEX', ix.source);

    // ----------------------------------------------------------------------
    section('Mambu\'s example: 5% index + 2% spread, the index rises to 6% on 1 February');
    const a = await approved('IX', 1000, 12);
    check('the application carries one INDEX period with the 2% spread', (await Rd((c) => R.historyOf(c, a.id))).periods.length === 1);
    await disburse(a.id, '2022-12-13');
    let row = await loanRow(a.id);
    check('disbursed on 13 December 2022 at 7%', Number(row.monthly_rate) === 7, String(row.monthly_rate));
    let s1 = await sched(a.id);
    check('the second installment is priced at 7%', Number(s1[1].interest_due) === round((1000 - Number(s1[0].principal_due)) * 0.07 / 12), `${s1[1].interest_due}`);
    await T((c) => L.repay(c, a.id, { amount: Number(s1[0].principal_due) + Number(s1[0].interest_due), channelId: 'cash', valueDate: '2023-01-13', createdBy: 'teller' }));
    check('the January review finds 5% + 2%: no change', (await review(a.id, '2023-01-13')) === null && Number((await loanRow(a.id)).monthly_rate) === 7);
    s1 = await sched(a.id);
    await T((c) => L.repay(c, a.id, { amount: Number(s1[1].principal_due) + Number(s1[1].interest_due), channelId: 'cash', valueDate: '2023-02-13', createdBy: 'teller' }));
    const change = await review(a.id, '2023-02-13');
    check('the February review picks up 6% + 2% = 8%, effective 13 February', change && change.newRate === 8 && change.effectiveFrom === '2023-02-13' && change.redrawn,
      JSON.stringify(change));
    const s2 = await sched(a.id);
    const outstanding = round(1000 - Number(s2[0].principal_due) - Number(s2[1].principal_due));
    check('the third installment (13 March) is priced at 8%, as in Mambu', Number(s2[2].interest_due) === round(outstanding * 0.08 / 12),
      `${s2[2].interest_due} vs ${round(outstanding * 0.08 / 12)}`);
    check('and the remaining installments share a new equal payment', new Set(s2.slice(2, 11).map((x) => round(Number(x.principal_due) + Number(x.interest_due)))).size === 1,
      s2.slice(2).map((x) => round(Number(x.principal_due) + Number(x.interest_due))).join(','));
    check('a second review the same day changes nothing', (await review(a.id, '2023-02-20')) === null);
    const hist = await call('GET', `/api/loans/${a.id}/rates`);
    check('the loan\'s rate history shows the disbursement and the review, with index and spread',
      hist.status === 200 && hist.body.changes.length === 2 && hist.body.changes[1].reason === 'INDEX_REVIEW'
      && Number(hist.body.changes[1].index_rate) === 6 && Number(hist.body.changes[1].spread) === 2, JSON.stringify(hist.body?.changes?.map((x) => x.reason)));

    // ----------------------------------------------------------------------
    section('floor and ceiling (Mambu\'s table: floor 10, ceiling 20)');
    check('10 + 5 = 15', R.clampRate(10, 5, 10, 20) === 15);
    check('10 + 17 = 37, held at the ceiling of 20', R.clampRate(10, 17, 10, 20) === 20);
    check('5 + 3 = 8, held at the floor of 10', R.clampRate(5, 3, 10, 20) === 10);
    const fc = await mk('IXFC', { productType: 'DYNAMIC_TERM', method: 'REDUCING', rateFrequency: 'PER_YEAR', interestRateSource: 'INDEX',
      indexSourceId: 'CBR', monthlyRate: 3, rateFloor: 10, rateCeiling: 20, rateReviewCount: 1, rateReviewUnit: 'MONTHS' });
    const fl = await approved('IXFC', 5000, 12);
    await disburse(fl.id, '2023-03-01');
    check('a loan on a product with a floor of 10 lends at 10 when the index and spread make 9', fc.status === 201 && Number((await loanRow(fl.id)).monthly_rate) === 10);

    // ----------------------------------------------------------------------
    section('a fixed-term loan changes rate at its next due date');
    await mk('IXF', { productType: 'FIXED_TERM', method: 'REDUCING', rateFrequency: 'PER_YEAR', interestRateSource: 'INDEX',
      indexSourceId: 'FX', monthlyRate: 2, rateReviewCount: 10, rateReviewUnit: 'DAYS' });
    const f = await approved('IXF', 12000, 6);
    await disburse(f.id, '2023-01-01');
    check('disbursed at 4% + 2% = 6%', Number((await loanRow(f.id)).monthly_rate) === 6);
    const fs0 = await sched(f.id);
    check('the review on 11 January sees 5% but the change waits for the next due date', (await review(f.id, '2023-01-20')) === null
      && Number((await loanRow(f.id)).monthly_rate) === 6);
    const fch = await review(f.id, '2023-02-01');
    const fs1 = await sched(f.id);
    check('on 1 February the rate becomes 7%', fch && fch.newRate === 7 && fch.effectiveFrom === '2023-02-01', JSON.stringify(fch));
    check('January\'s installment keeps the interest it was drawn with, and accrued exactly that',
      Number(fs1[0].interest_due) === Number(fs0[0].interest_due) && Number((await loanRow(f.id)).interest_accrued) === Number(fs0[0].interest_due),
      `${fs1[0].interest_due} ${(await loanRow(f.id)).interest_accrued}`);
    check('February\'s is priced at 7%', Number(fs1[1].interest_due) === round((12000 - Number(fs1[0].principal_due)) * 0.07 / 12), String(fs1[1].interest_due));

    // ----------------------------------------------------------------------
    section('adjustable interest rates');
    const air = await mk('AIR', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', rateFrequency: 'PER_YEAR',
      monthlyRate: 10, rateMin: 1, rateMax: 20, adjustableRates: true, allowedIndexSources: ['CBR'], allowNegativeRate: true,
      rateReviewCount: 1, rateReviewUnit: 'MONTHS' });
    check('a product with adjustable rates, CBR allowed', air.status === 201, air.source);
    const periods = [
      { validFrom: '2021-01-01', source: 'FIXED', rate: 10 },
      { validFrom: '2023-01-01', source: 'INDEX', indexSourceId: 'CBR', spread: 3 },
    ];
    await throws('periods on a product without adjustable rates are refused',
      () => approved('IX', 1000, 12, { ratePeriods: periods }), (e) => /PRODUCT_DOES_NOT_TAKE_ADJUSTABLE_RATES/.test(e.message));
    await throws('periods out of date order are refused',
      () => approved('AIR', 1000, 36, { ratePeriods: [periods[1], periods[0]] }), (e) => /DATE_ORDER/.test(e.message));
    await throws('a fixed rate outside the product\'s band is refused',
      () => approved('AIR', 1000, 36, { ratePeriods: [{ validFrom: '2021-01-01', source: 'FIXED', rate: 25 }] }), (e) => /RATE_ABOVE_PRODUCT_MAXIMUM/.test(e.message));
    await throws('an index the product does not allow is refused',
      () => approved('AIR', 1000, 36, { ratePeriods: [{ validFrom: '2021-01-01', source: 'INDEX', indexSourceId: 'FX', spread: 1 }] }),
      (e) => /INDEX_SOURCE_NOT_ALLOWED/.test(e.message));
    const k1 = await approved('AIR', 10000, 36, { ratePeriods: periods });
    check('a loan fixed at 10% for two years, then CBR + 3%', Number((await loanRow(k1.id)).monthly_rate) === 10 && (await loanRow(k1.id)).rate_plan === 'ADJUSTABLE');
    await throws('disbursing on another day than the first period without saying what to do is refused',
      () => disburse(k1.id, '2021-01-15'), (e) => /ADJUSTABLE_RATE_PERIODS_START_ON_2021-01-01/.test(e.message));
    await disburse(k1.id, '2021-01-15', { shiftAdjustableInterestPeriods: true });
    const kp = (await Rd((c) => R.historyOf(c, k1.id))).periods.map((x) => x.valid_from instanceof Date ? x.valid_from.toISOString().slice(0, 10) : String(x.valid_from).slice(0, 10));
    const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const kpLocal = (await Rd((c) => R.historyOf(c, k1.id))).periods.map((x) => ymd(x.valid_from));
    check('with shiftAdjustableInterestPeriods the periods move with the disbursement: 15 Jan 2021 and 15 Jan 2023',
      kpLocal.join(',') === '2021-01-15,2023-01-15', `${kpLocal.join(',')} (${kp.join(',')})`);
    check('the rate in force is the fixed 10%', Number((await loanRow(k1.id)).monthly_rate) === 10);
    check('a review before the index period changes nothing', (await review(k1.id, '2022-06-15')) === null);
    const k1a = await review(k1.id, '2023-01-15');
    check('on 15 January 2023 the loan moves to CBR 5% + 3% = 8%', k1a && k1a.newRate === 8 && k1a.source === 'INDEX', JSON.stringify(k1a));
    const k1b = await review(k1.id, '2023-02-15');
    check('and at the next monthly review to 6% + 3% = 9%', k1b && k1b.newRate === 9 && k1b.effectiveFrom === '2023-02-15', JSON.stringify(k1b));
    const k2 = await approved('AIR', 5000, 36, { ratePeriods: periods });
    await disburse(k2.id, '2021-01-20', { shiftAdjustableInterestPeriods: false });
    check('told not to shift, the periods stay as opened', (await Rd((c) => R.historyOf(c, k2.id))).periods.map((x) => ymd(x.valid_from)).join(',') === '2021-01-01,2023-01-01');
    const neg = await approved('AIR', 5000, 24, { ratePeriods: [{ validFrom: '2023-03-01', source: 'INDEX', indexSourceId: 'CBR', spread: -0.5 }] });
    await disburse(neg.id, '2023-03-01');
    check('a negative spread lowers the index: 6% - 0.5% = 5.5%', Number((await loanRow(neg.id)).monthly_rate) === 5.5, String((await loanRow(neg.id)).monthly_rate));
    await mk('AIRN', { productType: 'DYNAMIC_TERM', method: 'REDUCING', rateFrequency: 'PER_YEAR', monthlyRate: 10, adjustableRates: true,
      allowedIndexSources: ['CBR'], rateReviewCount: 1, rateReviewUnit: 'MONTHS' });
    await throws('without allowNegativeRate a negative spread is refused',
      () => approved('AIRN', 5000, 24, { ratePeriods: [{ validFrom: '2023-03-01', source: 'INDEX', indexSourceId: 'CBR', spread: -0.5 }] }),
      (e) => /NEGATIVE_SPREAD_NOT_ALLOWED/.test(e.message));

    section('the end of day reviews every loan');
    await call('POST', '/api/index-rates/CBR/rates', { validFrom: '2023-03-10', rate: 6.5 });
    const all = await call('POST', '/api/loans/rates/review', { asOf: '2023-04-01' });
    check('a review run finds the loans with rate periods and changes those whose rate moved', all.status === 200 && all.body.loans >= 5 && all.body.changed >= 1,
      JSON.stringify({ loans: all.body?.loans, changed: all.body?.changed }));
    const eod = require('../src/ops/eod');
    check('rate review runs before interest accrual in the daily sequence', eod.DEFAULT_JOBS.indexOf('reviewRates') > -1
      && eod.DEFAULT_JOBS.indexOf('reviewRates') < eod.DEFAULT_JOBS.indexOf('accrueInterest'));
    check('trial balance balances', (await Rd((c) => acct.trialBalance(c))).balanced);
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
