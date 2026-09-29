#!/usr/bin/env node
'use strict';

/**
 * Deposits > Deposit Products, after the reference platform: product types, account numbers
 * per product, interest (rate terms, the period a rate is given for, the
 * balance used, the maximum balance, the days in a year, posting dates, rate
 * changes), limits, the term and maturity of fixed deposits and savings
 * plans, dormancy, fees, overdraft interest, and managing products.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const DR = require('../src/domain/depositRules');
const PERMS = require('../src/lib/permissions');
const { orgDay, addDays } = require('./_org');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'deptest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4115;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

const tokens = {};
async function call(method, p, body, { who = 'admin' } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 400), reason: `${d?.errors?.[0]?.errorReason || ''} ${d?.errors?.[0]?.errorSource || ''}` };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}
const product = (id, body = {}) => call('POST', '/api/deposit-products', {
  id, name: id, accountingMethod: 'NONE', interestPaidIntoAccount: true, interestDayCount: 'ACTUAL_365', ...body });
const errOf = (p) => p.then(() => 'ok', (e) => e.message);

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Deposit Products SACCO', mfaRequiredRoles: [], adminEmail: 'admin@dep.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@dep.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const u = await call('POST', '/api/users', { email: 'teller@dep.local', fullName: 'The teller', password: PW, role: 'TELLER', branchId: 'HQ' });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
    tokens.teller = await login('teller@dep.local');
    const m = (await call('POST', '/api/members', { firstName: 'Wanjiru', lastName: 'Saver', branchId: 'HQ' })).body;
    const D0 = orgDay(-10);
    const today = orgDay(0);
    const open = (productId, extra = {}) => T((c) => S.open(c, { memberId: m.id, productId, openedOn: D0, ...extra }));
    const put = (id, amount, valueDate = D0) => T((c) => S.deposit(c, id, { amount, channelId: 'cash', valueDate, createdBy: 'test' }));
    const accrue = (id, date = orgDay(-1)) => T((c) => S.accrueInterest(c, id, { date }));
    const acc = async (id) => (await T((c) => c.query('SELECT * FROM savings_accounts WHERE id = $1', [id]))).rows[0];
    check('staff signed in', tokens.admin && tokens.teller);

    // ------------------------------------------------------------------------
    section('product types');
    const sav01 = (await call('GET', '/api/deposit-products/SAV01')).body;
    check('an existing product without overdrafts is a savings account', sav01.productType === 'SAVINGS_ACCOUNT' && sav01.category === 'UNCATEGORIZED', JSON.stringify(sav01?.productType));
    const cur = await product('CUR1', { allowOverdraft: true, maxOverdraftLimit: 50000, overdraftAnnualRate: 20, overdraftRateMin: 10, overdraftRateMax: 30 });
    check('a product given overdrafts is a current account', cur.status === 201 && cur.body.productType === 'CURRENT_ACCOUNT', cur.text);
    const badOd = await product('SAVOD', { productType: 'SAVINGS_ACCOUNT', allowOverdraft: true });
    check('a savings account may not have overdrafts (the reference platform)', badOd.status === 400 && /overdrafts are for CURRENT_ACCOUNT/.test(badOd.reason), badOd.text);
    const fdNoTerm = await product('FDX', { productType: 'FIXED_DEPOSIT' });
    check('a fixed deposit needs a term', fdNoTerm.status === 400 && /needs term_unit and term_default/.test(fdNoTerm.reason), fdNoTerm.text);
    const fd = await product('FD1', { productType: 'FIXED_DEPOSIT', category: 'PERSONAL_DEPOSIT', annualRate: 7.3, termUnit: 'MONTHS', termDefault: 6,
      termMin: 3, termMax: 12, minOpeningBalance: 10000, maxOpeningBalance: 50000, recommendedDepositAmount: 20000 });
    check('a fixed deposit with its term and opening balance', fd.status === 201 && fd.body.term.default === 6 && fd.body.limits.openingBalance.min === 10000, fd.text);
    check('posts interest on maturity unless told otherwise (the reference platform)', fd.body?.interest?.application === 'ON_MATURITY');
    const fdDorm = await call('PATCH', '/api/deposit-products/FD1', { dormancyDays: 30 });
    check('dormancy is not for products with a maturity date', fdDorm.status === 400 && /dormancy is not for products with a maturity date/.test(fdDorm.reason), fdDorm.text);
    const sp = await product('SP1', { productType: 'SAVINGS_PLAN', termUnit: 'WEEKS', termDefault: 4 });
    check('a savings plan', sp.status === 201 && sp.body.productType === 'SAVINGS_PLAN', sp.text);
    const onMat = await product('ONM', { interestApplication: 'ON_MATURITY' });
    check('posting on maturity is for fixed deposits and savings plans', onMat.status === 400, onMat.text);

    section('account numbers per product');
    const inc = await product('INC1', { idGeneratorType: 'INCREMENTAL_NUMBER', idPattern: '5000' });
    const incLetters = await product('INC2', { idGeneratorType: 'INCREMENTAL_NUMBER', idPattern: 'SV100' });
    check('an incremental number is digits only (the reference platform)', inc.status === 201 && incLetters.status === 400, incLetters.text);
    const n1 = await open('INC1');
    const n2 = await open('INC1');
    check('accounts count up from the starting number', n1.account_no === '5000' && n2.account_no === '5001', `${n1.account_no} ${n2.account_no}`);
    await product('RND1', { idGeneratorType: 'RANDOM_PATTERN', idPattern: 'DP-@@###' });
    const r1 = await open('RND1');
    check('a random pattern is filled', /^DP-[A-Z]{2}[0-9]{3}$/.test(r1.account_no), r1.account_no);
    const plain = await open('SAV01');
    check('a product that sets neither keeps the shared SA series', /^SA\d{6,}$/.test(plain.account_no), plain.account_no);

    // ------------------------------------------------------------------------
    section('interest: rate terms and periods');
    await product('FIX1', { annualRate: 7.3, interestRateMin: 2, interestRateMax: 8 });
    const tooHigh = await errOf(open('FIX1', { interestRate: 9 }));
    check('an account rate outside the product\'s range is refused', /INTEREST_RATE_ABOVE_THE_PRODUCT_MAXIMUM/.test(tooHigh), tooHigh);
    const f1 = await open('FIX1');
    await put(f1.id, 100000);
    await accrue(f1.id);
    check('a fixed 7.3% a year on 100,000 for 10 days is 200', near((await acc(f1.id)).interest_accrued, 200), String((await acc(f1.id)).interest_accrued));
    const f2 = await open('FIX1', { interestRate: 3.65 });
    await put(f2.id, 100000);
    await accrue(f2.id);
    check('an account\'s own rate is used', near((await acc(f2.id)).interest_accrued, 100), String((await acc(f2.id)).interest_accrued));
    await product('MON1', { annualRate: 1, interestRateFrequency: 'EVERY_MONTH' });
    const mo = await open('MON1');
    await put(mo.id, 100000);
    await accrue(mo.id);
    check('1% a month is 12% a year', near((await acc(mo.id)).interest_accrued, 100000 * 0.12 * 10 / 365), String((await acc(mo.id)).interest_accrued));
    const tiers = [{ ending: 50000, rate: 2 }, { ending: null, rate: 5 }];
    await product('TB1', { interestRateTerms: 'TIERED_BALANCE', interestRateTiers: tiers });
    await product('TD1', { interestRateTerms: 'TIERED_BANDS', interestRateTiers: tiers });
    const tb = await open('TB1'); await put(tb.id, 100000); await accrue(tb.id);
    const td = await open('TD1'); await put(td.id, 100000); await accrue(td.id);
    check('tiered per balance: the whole balance at its tier\'s rate', near((await acc(tb.id)).interest_accrued, 100000 * 0.05 * 10 / 365), String((await acc(tb.id)).interest_accrued));
    check('tiered per band: each portion at its band\'s rate', near((await acc(td.id)).interest_accrued, (50000 * 0.02 + 50000 * 0.05) * 10 / 365), String((await acc(td.id)).interest_accrued));
    await product('TP1', { interestRateTerms: 'TIERED_PERIOD', interestRateTiers: [{ ending: 30, rate: 1 }, { ending: null, rate: 9 }] });
    const tp = await open('TP1'); await put(tp.id, 100000); await accrue(tp.id);
    check('tiered per period: the tier of the account\'s age', near((await acc(tp.id)).interest_accrued, 100000 * 0.01 * 10 / 365), String((await acc(tp.id)).interest_accrued));
    const badTiers = await product('TX1', { interestRateTerms: 'TIERED_BALANCE', interestRateTiers: [{ ending: 100, rate: 1 }, { ending: 50, rate: 2 }] });
    check('tier endings must rise', badTiers.status === 400 && /endings must rise/.test(badTiers.reason), badTiers.text);
    await call('POST', '/api/index-rates', { id: 'CBR', name: 'Central Bank Rate' });
    await call('POST', '/api/index-rates/CBR/rates', { validFrom: addDays(D0, -30), rate: 4 });
    const ix = await product('IX1', { interestRateTerms: 'INDEX', interestIndexSourceId: 'CBR', interestSpreadDefault: 1.5, interestSpreadMin: 0, interestSpreadMax: 3 });
    check('an index rate needs an interest rate source', ix.status === 201, ix.text);
    const ixa = await open('IX1'); await put(ixa.id, 100000); await accrue(ixa.id);
    check('the index plus the spread (4 + 1.5)', near((await acc(ixa.id)).interest_accrued, 100000 * 0.055 * 10 / 365), String((await acc(ixa.id)).interest_accrued));

    section('interest: the balance used');
    await product('CAP1', { annualRate: 7.3, interestMaxBalance: 60000 });
    const cap = await open('CAP1'); await put(cap.id, 100000); await accrue(cap.id);
    check('the end of day balance is capped by the maximum balance', near((await acc(cap.id)).interest_accrued, 120), String((await acc(cap.id)).interest_accrued));
    const capBad = await product('CAP2', { annualRate: 7.3, interestCalcBalance: 'MINIMUM_DAILY', interestMaxBalance: 60000 });
    check('the maximum balance is for the end of day balance (the reference platform)', capBad.status === 400, capBad.text);
    // The reference platform's example day: balances 40, 35 and 60 after three movements (x 1,000), opening 50.
    const day = addDays(today, -3);
    const basisDay = async (basis) => {
      await product(`B${basis.slice(0, 3)}`, { annualRate: 36.5, interestCalcBalance: basis });
      const a = await T((c) => S.open(c, { memberId: m.id, productId: `B${basis.slice(0, 3)}`, openedOn: day }));
      await T(async (c) => {
        await c.query('UPDATE savings_accounts SET balance = 60000 WHERE id = $1', [a.id]);
        await c.query('DELETE FROM savings_intraday_balances WHERE account_id = $1', [a.id]);
        await c.query(`INSERT INTO savings_intraday_balances (account_id, day, open_balance, min_balance, sum_after, movements)
          VALUES ($1, $2, 50000, 35000, 135000, 3)`, [a.id, day]);
      });
      await T((c) => S.accrueInterest(c, a.id, { date: day }));
      return Number((await acc(a.id)).interest_accrued);
    };
    const avg = await basisDay('AVERAGE_DAILY');
    const min = await basisDay('MINIMUM_DAILY');
    const eod = await basisDay('END_OF_DAY');
    check('the reference platform\'s example: average daily 45, minimum daily 35, end of day 60 (at 36.5%, one day)', near(avg, 45) && near(min, 35) && near(eod, 60), `${avg} ${min} ${eod}`);
    const moves = await open('SAV01');
    await T((c) => S.deposit(c, moves.id, { amount: 40000, channelId: 'cash', createdBy: 'test' }));
    await T((c) => S.withdraw(c, moves.id, { amount: 5000, channelId: 'cash', createdBy: 'test' }));
    await T((c) => S.deposit(c, moves.id, { amount: 25000, channelId: 'cash', createdBy: 'test' }));
    const mv = (await T((c) => c.query('SELECT * FROM savings_intraday_balances WHERE account_id = $1', [moves.id]))).rows[0];
    check('the day\'s movements are kept for the daily minimum and average', mv && Number(mv.open_balance) === 0 && Number(mv.min_balance) === 0
      && Number(mv.sum_after) === 135000 && mv.movements === 3, JSON.stringify(mv));
    check('Actual/Actual ISDA counts 366 days in a leap year', DR.yearDays('ACTUAL_ACTUAL_ISDA', '2028-03-01') === 366 && DR.yearDays('ACTUAL_ACTUAL_ISDA', '2027-03-01') === 365);

    section('interest: posting dates');
    const acct = { opened_on: '2026-01-31', interest_fixed_dates: ['06-30', '12-31'], maturity_date: '2026-07-31' };
    const on = (freq, d) => DR.isApplicationDate(d, { ...acct, interest_application: freq });
    check('the first day of every month', on('FIRST_DAY_OF_MONTH', '2026-03-01') && !on('FIRST_DAY_OF_MONTH', '2026-03-02'));
    check('monthly from activation, clamped at month end (31 Jan, 28 Feb, 31 Mar)', on('MONTHLY_FROM_ACTIVATION', '2026-02-28') && on('MONTHLY_FROM_ACTIVATION', '2026-03-31') && !on('MONTHLY_FROM_ACTIVATION', '2026-03-28'));
    check('every three months from activation', on('QUARTERLY_FROM_ACTIVATION', '2026-04-30') && !on('QUARTERLY_FROM_ACTIVATION', '2026-03-31'));
    check('weekly and every other week from activation', on('WEEKLY', '2026-02-07') && !on('EVERY_OTHER_WEEK', '2026-02-07') && on('EVERY_OTHER_WEEK', '2026-02-14'));
    check('fixed dates and maturity', on('FIXED_DATES', '2026-06-30') && !on('FIXED_DATES', '2026-06-29') && on('ON_MATURITY', '2026-07-31'));
    check('and the calendar schedules as before', on('MONTHLY', '2026-02-28') && on('QUARTERLY', '2026-03-31') && !on('QUARTERLY', '2026-02-28'));

    section('interest: changing the rate');
    const keep = await open('FIX1');
    const toNew = await call('PATCH', '/api/deposit-products/FIX1', { annualRate: 5, applyTo: 'NEW_ACCOUNTS' });
    const afterNew = await open('FIX1');
    check('a product rate change to new accounts only: existing accounts keep theirs', toNew.status === 200
      && Number((await acc(keep.id)).interest_rate) === 7.3 && (await acc(afterNew.id)).interest_rate === null, toNew.text);
    const toAll = await call('PATCH', '/api/deposit-products/FIX1', { annualRate: 6, applyTo: 'ALL_ACCOUNTS' });
    check('to all accounts: each follows the product again', toAll.status === 200 && (await acc(keep.id)).interest_rate === null
      && (await T((c) => S.summary(c, keep.id))).interestRate === 6, toAll.text);
    const tieredNew = await call('PATCH', '/api/deposit-products/TB1', { annualRate: 1, applyTo: 'NEW_ACCOUNTS' });
    check('new accounts only is for a fixed rate', tieredNew.status === 400, tieredNew.text);
    const ch = await open('FIX1', { interestRate: 7.3 });
    await put(ch.id, 100000);
    await accrue(ch.id);
    const future = await call('POST', `/api/savings/${ch.id}:changeInterestRate`, { interestRate: 3.65, valueDate: addDays(today, 1) });
    check('an account rate change cannot be post-dated', future.status === 400 && /FUTURE/.test(future.reason), future.text);
    const back = await call('POST', `/api/savings/${ch.id}:changeInterestRate`, { interestRate: 3.65, valueDate: addDays(D0, 5) });
    check('backdated, what accrued since the value date is priced again (200 becomes 150)', back.status === 200 && near((await acc(ch.id)).interest_accrued, 150)
      && near(back.body.accruedChange, -50), `${back.text} ${(await acc(ch.id)).interest_accrued}`);
    const ixChange = await call('POST', `/api/savings/${ixa.id}/interest-rate`, { interestRate: 3 });
    check('only a fixed rate changes on the account (the reference platform)', ixChange.status === 409, ixChange.text);
    await product('LCK1', { annualRate: 7.3, collectInterestWhenLocked: false });
    const lk = await open('LCK1'); await put(lk.id, 100000);
    await T((c) => c.query("UPDATE savings_accounts SET status = 'LOCKED' WHERE id = $1", [lk.id]));
    await accrue(lk.id);
    check('a locked account earns nothing where the product does not collect interest when locked', Number((await acc(lk.id)).interest_accrued) === 0);

    // ------------------------------------------------------------------------
    section('limits');
    await product('LIM1', { maxWithdrawalAmount: 1000 });
    const lim = await open('LIM1'); await put(lim.id, 5000);
    const big = await call('POST', `/api/savings/${lim.id}/withdrawals`, { amount: 1500, channelId: 'cash' });
    const small = await call('POST', `/api/savings/${lim.id}/withdrawals`, { amount: 900, channelId: 'cash' });
    check('no more than the maximum withdrawal in one transaction', big.status === 409 && /ABOVE_THE_MAXIMUM_WITHDRAWAL/.test(big.reason) && small.status === 201, big.text);
    const setMax = await call('PATCH', `/api/savings/${lim.id}`, { maxBalance: 5000 });
    const over = await call('POST', `/api/savings/${lim.id}/deposits`, { amount: 1000, channelId: 'cash' });
    const other = await open('SAV01'); await put(other.id, 3000);
    const tIn = await call('POST', `/api/savings/${other.id}/transfers`, { toAccountId: lim.id, amount: 2000 });
    check('the account\'s maximum balance holds deposits and transfers in (MAXIMUM_DEPOSIT_BALANCE_EXCEEDED)', setMax.status === 200 && over.status === 409
      && /MAXIMUM_DEPOSIT_BALANCE_EXCEEDED/.test(over.reason) && tIn.status === 409, `${over.text} ${tIn.text}`);

    section('term and maturity');
    const f = await open('FD1');
    const dep1 = await call('POST', `/api/savings/${f.id}/deposits`, { amount: 20000, channelId: 'cash' });
    const tooMuch = await call('POST', `/api/savings/${f.id}/deposits`, { amount: 40000, channelId: 'cash' });
    check('before its term a fixed deposit takes up to the maximum opening balance', dep1.status === 201 && tooMuch.status === 409 && /MAXIMUM_OPENING_BALANCE/.test(tooMuch.reason), tooMuch.text);
    const longTerm = await call('POST', `/api/savings/${f.id}/maturity`, { termLength: 13 });
    check('the term stays within the product\'s range', longTerm.status === 400 && /ABOVE_THE_PRODUCT_MAXIMUM/.test(longTerm.reason), longTerm.text);
    const tellerStart = await call('POST', `/api/savings/${f.id}/maturity`, {}, { who: 'teller' });
    check('a teller may start the maturity (ACTIVATE_MATURITY)', tellerStart.status === 200 && tellerStart.body.maturity_date === DR.addMonths(today, 6), tellerStart.text);
    const late = await call('POST', `/api/savings/${f.id}/deposits`, { amount: 100, channelId: 'cash' });
    check('then the fixed deposit takes no more deposits', late.status === 409 && /NO_DEPOSITS_ONCE_ITS_MATURITY_HAS_STARTED/.test(late.reason), late.text);
    const early = await call('POST', `/api/savings/${f.id}/withdrawals`, { amount: 100, channelId: 'cash' }, { who: 'teller' });
    check('no withdrawal during the term without MAKE_EARLY_WITHDRAWALS', early.status === 403 && /MAKE_EARLY_WITHDRAWALS/.test(early.reason), early.text);
    const undoTeller = await call('DELETE', `/api/savings/${f.id}/maturity`, null, { who: 'teller' });
    const undo = await call('DELETE', `/api/savings/${f.id}/maturity`);
    check('undoing the maturity needs UNDO_MATURITY', undoTeller.status === 403 && undo.status === 200 && undo.body.maturity_date === null, `${undoTeller.text} ${undo.text}`);
    const low = await open('FD1');
    const notYet = await call('POST', `/api/savings/${low.id}/maturity`, {});
    check('the maturity starts once the opening balance is reached', notYet.status === 409 && /OPENING_BALANCE_NOT_REACHED/.test(notYet.reason), notYet.text);
    await call('POST', `/api/savings/${f.id}/maturity`, { termLength: 3 });
    await T((c) => c.query('UPDATE savings_accounts SET maturity_date = $2, accrued_through = NULL WHERE id = $1', [f.id, today]));
    const eodRun = await T((c) => S.endOfDay(c, { date: today, createdBy: 'EOD' }));
    const fm = await acc(f.id);
    const posted = (await T((c) => c.query("SELECT count(*)::int AS n FROM transactions WHERE savings_account_id = $1 AND kind = 'SAVINGS_INTEREST_APPLIED'", [f.id]))).rows[0].n;
    check('at its date the account matures and interest is posted on maturity', fm.status === 'MATURED' && posted === 1 && eodRun.matured >= 1, `${fm.status} ${posted}`);
    const afterDep = await call('POST', `/api/savings/${f.id}/deposits`, { amount: 10, channelId: 'cash' });
    const afterWd = await call('POST', `/api/savings/${f.id}/withdrawals`, { amount: 10, channelId: 'cash' }, { who: 'teller' });
    check('a matured account pays out and takes nothing in', afterDep.status === 409 && afterWd.status === 201, `${afterDep.text} ${afterWd.text}`);
    const plan = await open('SP1');
    await call('POST', `/api/savings/${plan.id}/deposits`, { amount: 500, channelId: 'cash' });
    await call('POST', `/api/savings/${plan.id}/maturity`, {});
    const planDep = await call('POST', `/api/savings/${plan.id}/deposits`, { amount: 500, channelId: 'cash' });
    check('a savings plan takes deposits during its term', planDep.status === 201, planDep.text);

    section('dormancy');
    await product('DOR1', { dormancyDays: 30 });
    const d = await open('DOR1'); await put(d.id, 1000);
    await T((c) => c.query('UPDATE savings_accounts SET last_activity_on = $2 WHERE id = $1', [d.id, addDays(today, -40)]));
    await T((c) => S.endOfDay(c, { date: today, createdBy: 'EOD' }));
    check('an account without activity for the product\'s days becomes dormant', (await acc(d.id)).status === 'DORMANT');
    const tellerDep = await call('POST', `/api/savings/${d.id}/deposits`, { amount: 10, channelId: 'cash' }, { who: 'teller' });
    const adminDep = await call('POST', `/api/savings/${d.id}/deposits`, { amount: 10, channelId: 'cash' });
    check('posting on it needs POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS, and makes it active again', tellerDep.status === 403 && adminDep.status === 201
      && (await acc(d.id)).status === 'ACTIVE', `${tellerDep.text} ${adminDep.text}`);

    // ------------------------------------------------------------------------
    section('fees');
    const fee1 = await call('POST', '/api/deposit-products/SAV01/fees', { code: 'MF1', name: 'Ledger fee', trigger: 'MONTHLY', amount: 10, applyDateMethod: 'FIRST_DAY_OF_MONTH' });
    const feeBad = await call('POST', '/api/deposit-products/SAV01/fees', { code: 'MF2', name: 'Bad', trigger: 'MANUAL', amount: 10, applyDateMethod: 'FIRST_DAY_OF_MONTH' });
    check('a monthly fee is dated from activation or the first of the month', fee1.status === 201 && fee1.body.apply_date_method === 'FIRST_DAY_OF_MONTH' && feeBad.status === 400, feeBad.text);
    check('when each falls due', DR.isMonthlyFeeDate('2026-03-01', 'FIRST_DAY_OF_MONTH') && DR.isMonthlyFeeDate('2026-03-15', 'MONTHLY_FROM_ACTIVATION', '2026-01-15')
      && DR.isMonthlyFeeDate('2026-03-31', 'END_OF_MONTH') && !DR.isMonthlyFeeDate('2026-03-30', 'END_OF_MONTH'));
    const delFee = await call('DELETE', '/api/deposit-products/SAV01/fees/MF1');
    check('a fee never applied is deleted', delFee.status === 204, delFee.text);
    await call('POST', '/api/deposit-products/SAV01/fees', { code: 'MAN1', name: 'Statement', trigger: 'MANUAL', amount: 5 });
    await T((c) => S.applyFee(c, plain.id, { feeCode: 'MAN1', createdBy: 'test' }).catch(() => null));
    await put(plain.id, 100, today);
    await T((c) => S.applyFee(c, plain.id, { feeCode: 'MAN1', createdBy: 'test' }));
    const delUsed = await call('DELETE', '/api/deposit-products/SAV01/fees/MAN1');
    check('one applied is not (deactivate it instead)', delUsed.status === 409 && /FEE_HAS_BEEN_APPLIED/.test(delUsed.reason), delUsed.text);
    const arbOn = await T((c) => errOf(S.applyFee(c, plain.id, { amount: 3, name: 'Photocopy', createdBy: 'test' })));
    await call('PATCH', '/api/deposit-products/SAV01', { allowArbitraryFees: false });
    const arbOff = await T((c) => errOf(S.applyFee(c, plain.id, { amount: 3, name: 'Photocopy', createdBy: 'test' })));
    check('arbitrary fees are allowed until the product turns them off', arbOn === 'ok' && /ARBITRARY_FEES_NOT_ALLOWED/.test(arbOff), `${arbOn} ${arbOff}`);

    section('overdraft interest');
    const c1 = await open('CUR1');
    const odHigh = await call('PUT', `/api/savings/${c1.id}/overdraft`, { limit: 10000, interestRate: 35 });
    const odOk = await call('PUT', `/api/savings/${c1.id}/overdraft`, { limit: 10000, interestRate: 25 });
    check('an account\'s overdraft rate stays within the product\'s range', odHigh.status === 400 && odOk.status === 200 && Number(odOk.body.overdraft_rate) === 25, `${odHigh.text} ${odOk.text}`);
    await T((c) => S.withdraw(c, c1.id, { amount: 3650, channelId: 'cash', valueDate: D0, createdBy: 'test' }));
    await accrue(c1.id);
    check('and accrues at that rate (25% on 3,650 for 10 days is 25)', near((await acc(c1.id)).od_interest_accrued, 25), String((await acc(c1.id)).od_interest_accrued));
    await product('CURT', { allowOverdraft: true, maxOverdraftLimit: 50000, overdraftRateTerms: 'TIERED_BALANCE',
      overdraftRateTiers: [{ ending: 1000, rate: 10 }, { ending: null, rate: 36.5 }] });
    const c2 = await open('CURT', { overdraftLimit: 10000 });
    await T((c) => S.withdraw(c, c2.id, { amount: 5000, channelId: 'cash', valueDate: D0, createdBy: 'test' }));
    await accrue(c2.id);
    check('a tiered overdraft rate by the amount overdrawn', near((await acc(c2.id)).od_interest_accrued, 50), String((await acc(c2.id)).od_interest_accrued));
    await product('CURI', { allowOverdraft: true, maxOverdraftLimit: 50000, overdraftRateTerms: 'INDEX', overdraftIndexSourceId: 'CBR',
      overdraftSpreadDefault: 32.5, overdraftSpreadMin: 0, overdraftSpreadMax: 40 });
    const c3 = await open('CURI', { overdraftLimit: 10000 });
    await T((c) => S.withdraw(c, c3.id, { amount: 1000, channelId: 'cash', valueDate: D0, createdBy: 'test' }));
    await accrue(c3.id);
    check('an index overdraft rate plus spread (4 + 32.5)', near((await acc(c3.id)).od_interest_accrued, 10), String((await acc(c3.id)).od_interest_accrued));
    const spread = await call('PUT', `/api/savings/${c3.id}/overdraft`, { interestSpread: 50 });
    check('and its spread per account within the range', spread.status === 400, spread.text);
    const pinned = await open('CUR1');
    await call('PATCH', '/api/deposit-products/CUR1', { overdraftAnnualRate: 15 });
    check('a product overdraft rate change reaches new accounts only (the reference platform)', Number((await acc(pinned.id)).overdraft_rate) === 20
      && Number((await T((c) => S.lock(c, pinned.id))).overdraft_annual_rate) === 20);
    await call('PATCH', '/api/deposit-products/CUR1', { allowTechnicalOverdraft: true });
    const techOff = await call('PATCH', '/api/deposit-products/CUR1', { allowTechnicalOverdraft: false });
    check('technical overdrafts are turned off only while the product has no accounts', techOff.status === 400 && /technical overdrafts can be turned off only/.test(techOff.reason), techOff.text);

    // ------------------------------------------------------------------------
    section('managing products');
    const full = await call('PATCH', '/api/deposit-products/SAV01', {
      productType: 'SAVINGS_ACCOUNT', category: 'UNCATEGORIZED', idGeneratorType: null, idPattern: null, interestRateTerms: 'FIXED',
      interestRateMin: null, interestRateMax: null, interestRateFrequency: 'ANNUALIZED', interestRateXDays: null, interestIndexSourceId: null,
      interestSpreadDefault: null, interestSpreadMin: null, interestSpreadMax: null, interestRateTiers: [], interestMaxBalance: null,
      interestFixedDates: [], collectInterestWhenLocked: true, accrueInterestAfterMaturity: false, minOpeningBalance: null,
      maxOpeningBalance: null, defaultOpeningBalance: null, recommendedDepositAmount: null, maxWithdrawalAmount: null, dormancyDays: null,
      allowArbitraryFees: true, overdraftRateTerms: 'FIXED', overdraftRateMin: null, overdraftRateMax: null, overdraftIndexSourceId: null,
      overdraftSpreadDefault: null, overdraftSpreadMin: null, overdraftSpreadMax: null, overdraftRateTiers: [], overdraftCalcBalance: 'END_OF_DAY',
      name: 'Ordinary Savings' });
    check('the console\'s whole settings form saves on a product with accounts', full.status === 200 && full.body.allowArbitraryFees === true, full.text);
    const frozen = await call('PATCH', '/api/deposit-products/FIX1', { productType: 'SAVINGS_PLAN', termUnit: 'DAYS', termDefault: 30 });
    check('the type cannot change once accounts exist', frozen.status === 400 && /product_type/.test(frozen.reason), frozen.text);
    await product('UNUSED');
    const delUnused = await call('DELETE', '/api/deposit-products/UNUSED');
    const delUsedP = await call('DELETE', '/api/deposit-products/FIX1');
    check('a product that never had accounts is deleted; one that had is not', delUnused.status === 204 && delUsedP.status === 409 && /PRODUCT_HAS_ACCOUNTS/.test(delUsedP.reason), delUsedP.text);
    const tellerDel = await call('DELETE', '/api/deposit-products/SP1', null, { who: 'teller' });
    check('deleting needs DELETE_SAVINGS_PRODUCT', tellerDel.status === 403, tellerDel.text);
    const codes = ['MAKE_EARLY_WITHDRAWALS', 'ACTIVATE_MATURITY', 'UNDO_MATURITY', 'POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS', 'DELETE_SAVINGS_PRODUCT'];
    check('the reference platform\'s deposit permissions for these are in the catalogue', codes.every((x) => PERMS.CODES.has(x)));
    await T((c) => c.query(`INSERT INTO roles (code, name, base_role, permissions) VALUES ('OLDDEP', 'Old deposits role', 'MANAGER',
      ARRAY['MAKE_DEPOSIT', 'EDIT_SAVINGS_ACCOUNT'])`));
    await pool.query("DELETE FROM platform.schema_migrations WHERE schema_name = $1 AND version LIKE '036%'", [SCHEMA]);
    await migrateAllTenants({});
    const old = (await T((c) => c.query("SELECT permissions FROM roles WHERE code = 'OLDDEP'"))).rows[0].permissions;
    check('roles holding the deposit permissions are given the matching ones, and the migration runs twice',
      ['ACTIVATE_MATURITY', 'UNDO_MATURITY', 'MAKE_EARLY_WITHDRAWALS', 'POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS'].every((x) => old.includes(x)), old.join(','));
    const direct = await T((c) => errOf(c.query("INSERT INTO savings_products (id, name, gl_liability, allow_overdraft) VALUES ('RAWOD', 'Raw', '200-100', true)")));
    const rawType = (await T((c) => c.query("SELECT product_type FROM savings_products WHERE id = 'RAWOD'"))).rows[0]?.product_type;
    check('a direct insert of an overdraft product gets the current account type', direct === 'ok' && rawType === 'CURRENT_ACCOUNT', `${direct} ${rawType}`);
  } catch (e) {
    fail++; failures.push(e.stack); console.error(e);
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
