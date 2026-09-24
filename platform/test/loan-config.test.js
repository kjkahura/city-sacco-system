#!/usr/bin/env node
'use strict';

/**
 * The full loan product configuration and the loan workflow, after Mambu:
 * account numbering, interest types, schedule shapes, fees of every type,
 * penalty bases, arrears tolerance, the cap on charges, accounting switched
 * off, the life cycle with its undo steps, amendments by state, approval
 * and disbursement limits, the two-man rule, and exposure controls.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const { hashPassword } = require('../src/auth/passwords');
const L = require('../src/domain/loans');
const F = require('../src/domain/fees');
const W = require('../src/domain/workflow');
const P = require('../src/domain/penalties');
const S = require('../src/domain/savings');
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

const SLUG = 'cfgtest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4092;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;
const sum = (xs, f) => round(xs.reduce((s, x) => s + Number(f(x)), 0));
const bal = (code) => Rd((c) => acct.balance(c, code));
const plus = (n, from = new Date()) => new Date(from.getTime() + n * 86400000).toISOString().slice(0, 10);

let server;
let tokens = {};
async function call(method, p, body, who = 'admin') {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  const r = await fetch(`http://localhost:${PORT}${p}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, err: d?.errors?.[0], reason: d?.errors?.[0]?.errorReason, source: d?.errors?.[0]?.errorSource };
}
async function login(email) {
  return (await call('POST', '/api/auth/login', { email, password: PASSWORD }, null)).body.accessToken;
}

async function assertBalanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced, `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}

let memberSeq = 0;
async function newMember(c, deposit = 0) {
  memberSeq += 1;
  const no = `C${String(memberSeq).padStart(4, '0')}`;
  const m = (await c.query(
    `INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'Config',$1) RETURNING *`, [no])).rows[0];
  const sav = await S.open(c, { memberId: m.id });
  if (deposit) await S.deposit(c, sav.id, { amount: deposit, channelId: 'cash', createdBy: 'test' });
  return { m, sav };
}
async function disbursedLoan(c, memberId, productId, principal, term, on, extra = {}) {
  const l = await L.apply(c, { memberId, productId, principal, termMonths: term, createdBy: 'officer', ...extra });
  if (l.status === 'PARTIAL_APPLICATION') await L.changeState(c, l.id, 'REQUEST_APPROVAL', { createdBy: 'officer' });
  await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
  await L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: on, createdBy: 'teller', fees: extra.fees || [] });
  return l;
}
const schedule = (loanId) => Rd(async (c) => (await c.query(
  'SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [loanId])).rows);
const loanRow = (loanId) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [loanId])).rows[0]);
const balancesOf = (loanId) => T(async (c) => L.balances(await L.lock(c, loanId)));
const accrue = (loanId, valueDate) => T((c) => L.accrueInterest(c, loanId, { valueDate, createdBy: 'test' }));
const repay = (loanId, amount, valueDate) => T((c) => L.repay(c, loanId, { amount, channelId: 'cash', valueDate, createdBy: 'teller' }));

const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };
const product = (id, body) => call('POST', '/api/loan-products', { id, name: id, enforceDepositMultiplier: false, ...GL, ...body });

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Configuration SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@cfgtest.local', adminPassword: PASSWORD,
    });
    await migrateAllTenants({});
    const tenant = (await pool.query('SELECT * FROM platform.tenants WHERE slug=$1', [SLUG])).rows[0];
    const hash = await hashPassword(PASSWORD);
    for (const [email, role, approval, disbursement] of [
      ['junior@cfgtest.local', 'MANAGER', 50000, 50000], ['senior@cfgtest.local', 'MANAGER', null, null]]) {
      await pool.query(
        `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role, approval_limit, disbursement_limit)
         VALUES ($1,$2,$3,$2,$4,$5,$6)`, [tenant.id, email, hash, role, approval, disbursement]);
    }
    tokens.admin = await login('admin@cfgtest.local');
    tokens.junior = await login('junior@cfgtest.local');
    tokens.senior = await login('senior@cfgtest.local');
    check('three staff signed in', tokens.admin && tokens.junior && tokens.senior);

    // ----------------------------------------------------------------------
    section('account numbers follow the product pattern');
    const rnd = await product('RND01', { idPattern: 'PL@@####', idMode: 'RANDOM', monthlyRate: 1, maxTerm: 12 });
    const inc = await product('INC01', { idPattern: 'EM-######', idMode: 'INCREMENTAL', monthlyRate: 1, maxTerm: 12 });
    check('products created with their patterns', rnd.status === 201 && inc.status === 201 && inc.body.idPattern === 'EM-######',
      `${rnd.status} ${rnd.source || ''} ${inc.status} ${inc.source || ''}`);
    const bad = await product('BADID', { idPattern: 'NOPLACEHOLDER', monthlyRate: 1, maxTerm: 12 });
    check('a pattern with no placeholder is refused', bad.status === 400 && /placeholder/.test(bad.source || ''));
    const { m: mA } = await T((c) => newMember(c));
    const r1 = await T((c) => L.apply(c, { memberId: mA.id, productId: 'RND01', principal: 10000, termMonths: 6, createdBy: 't' }));
    const i1 = await T((c) => L.apply(c, { memberId: mA.id, productId: 'INC01', principal: 10000, termMonths: 6, createdBy: 't' }));
    const i2 = await T((c) => L.apply(c, { memberId: mA.id, productId: 'INC01', principal: 10000, termMonths: 6, createdBy: 't' }));
    check('a random pattern draws letters and digits where it says', /^PL[A-HJ-NP-Z]{2}\d{4}$/.test(r1.account_no), r1.account_no);
    check('an incremental pattern counts', i1.account_no === 'EM-000001' && i2.account_no === 'EM-000002', `${i1.account_no} ${i2.account_no}`);
    const nl = await T((c) => L.apply(c, { memberId: mA.id, productId: 'NL01', principal: 10000, termMonths: 6, createdBy: 't' }));
    check('the seeded product continues the LN series', /^LN\d{6}$/.test(nl.account_no), nl.account_no);
    check('fillPattern pads and carries', L.fillPattern('LN####', 7) === 'LN0007' && L.fillPattern('LN##', 123) === 'LN123');

    // ----------------------------------------------------------------------
    section('interest types');
    // Mambu's worked example: 1,000 at 10% a year, five monthly installments, 30E/360.
    const cmp = await product('CMP01', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', interestType: 'COMPOUND',
      rateFrequency: 'PER_YEAR', monthlyRate: 10, maxTerm: 60 });
    check('a compound product is created', cmp.status === 201 && cmp.body.annualRate === 10, `${cmp.status} ${cmp.source || ''}`);
    const { m: mC } = await T((c) => newMember(c));
    const cl = await T((c) => disbursedLoan(c, mC.id, 'CMP01', 1000, 5, '2020-01-01'));
    const cs = await schedule(cl.id);
    check('compound: payment 204.81, interest 7.97, principal 196.84 (Mambu\'s figures)',
      round(Number(cs[0].principal_due) + Number(cs[0].interest_due)) === 204.81 && Number(cs[0].interest_due) === 7.97
      && Number(cs[0].principal_due) === 196.84, cs.slice(0, 1).map((x) => `${x.principal_due}/${x.interest_due}`).join());
    const smp = await product('SMP01', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', rateFrequency: 'PER_YEAR', monthlyRate: 10, maxTerm: 60 });
    const sl = await T((c) => disbursedLoan(c, mC.id, 'SMP01', 1000, 5, '2020-01-01'));
    const ss = await schedule(sl.id);
    check('simple: payment 205.03, interest 8.33 (Mambu\'s figures)',
      round(Number(ss[0].principal_due) + Number(ss[0].interest_due)) === 205.03 && Number(ss[0].interest_due) === 8.33);
    check('and a rate quoted per year is stored as such', smp.body.rateFrequency === 'PER_YEAR' && smp.body.annualRate === 10);

    const cap = await product('CAP01', { productType: 'DYNAMIC_TERM', method: 'REDUCING', interestType: 'CAPITALIZED', monthlyRate: 1, maxTerm: 24 });
    check('a capitalising product is created', cap.status === 201, `${cap.status} ${cap.source || ''}`);
    const capFixed = await product('CAPBAD', { productType: 'FIXED_TERM', method: 'REDUCING', interestType: 'CAPITALIZED', monthlyRate: 1, maxTerm: 24 });
    check('capitalised interest needs a dynamic product', capFixed.status === 400);
    const { m: mK } = await T((c) => newMember(c));
    const kl = await T((c) => disbursedLoan(c, mK.id, 'CAP01', 100000, 12, '2026-01-12'));
    const portfolioBefore = await bal('100-100');
    await accrue(kl.id, '2026-02-12');
    const kb = await balancesOf(kl.id);
    const krow = await loanRow(kl.id);
    check('on the due date the month\'s interest is capitalised: interest 0, principal 101,000',
      kb.interest === 0 && kb.principal === 101000 && Number(krow.principal_capitalized) === 1000, JSON.stringify(kb));
    check('booked Dr Portfolio Cr Interest Income', round((await bal('100-100')) - portfolioBefore) === 1000);
    await accrue(kl.id, '2026-02-20');
    check('and interest now runs on the capitalised balance: 8 days on 101,000',
      (await balancesOf(kl.id)).interest === round(101000 * 0.01 * 8 / 30), String((await balancesOf(kl.id)).interest));
    await assertBalanced('capitalised interest');

    const pai = await product('PAI01', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', simpleBase: 'PRINCIPAL_AND_INTEREST', monthlyRate: 1, maxTerm: 24 });
    check('principal-and-interest base is accepted on a dynamic equal-installment product', pai.status === 201, pai.source || '');
    const paiBad = await product('PAIBAD', { productType: 'FIXED_TERM', method: 'FLAT', simpleBase: 'PRINCIPAL_AND_INTEREST', monthlyRate: 1, maxTerm: 24 });
    check('and refused elsewhere', paiBad.status === 400);
    const pl = await T((c) => disbursedLoan(c, mK.id, 'PAI01', 100000, 12, '2026-01-12'));
    await accrue(pl.id, '2026-02-12');
    await accrue(pl.id, '2026-03-12');
    check('unpaid interest earns interest: second month on 101,000, not 100,000',
      (await balancesOf(pl.id)).interest === 2010, String((await balancesOf(pl.id)).interest));

    const upf = await product('UPF01', { productType: 'FIXED_TERM', method: 'FLAT', interestPosting: 'ON_DISBURSEMENT', monthlyRate: 1, maxTerm: 24 });
    check('posting on disbursement is a fixed-term setting', upf.status === 201);
    const upfBad = await product('UPFBAD', { productType: 'DYNAMIC_TERM', method: 'REDUCING', interestPosting: 'ON_DISBURSEMENT', monthlyRate: 1, maxTerm: 24 });
    check('and refused on a dynamic one', upfBad.status === 400);
    const ul = await T((c) => disbursedLoan(c, mK.id, 'UPF01', 12000, 12, '2026-01-12'));
    check('the whole term\'s interest is due on day one: 1,440', (await balancesOf(ul.id)).interest === 1440, String((await balancesOf(ul.id)).interest));
    check('and nothing more accrues', (await accrue(ul.id, '2026-06-30')) === null && (await balancesOf(ul.id)).interest === 1440);

    const free = await product('FREE01', { productType: 'INTEREST_FREE', method: 'REDUCING', maxTerm: 12 });
    check('an interest-free product is created with no rate', free.status === 201 && free.body.monthlyRate === 0, free.source || '');
    const freeBad = await product('FREEBAD', { productType: 'INTEREST_FREE', method: 'REDUCING', monthlyRate: 2, maxTerm: 12 });
    check('and refuses a rate', freeBad.status === 400);
    const fl = await T((c) => disbursedLoan(c, mK.id, 'FREE01', 9000, 3, '2026-01-12'));
    const fs = await schedule(fl.id);
    check('its schedule carries no interest', fs.length === 3 && fs.every((x) => Number(x.interest_due) === 0) && sum(fs, (x) => x.principal_due) === 9000);
    check('and accrual books nothing', (await accrue(fl.id, '2026-03-12')) === null && (await balancesOf(fl.id)).interest === 0);
    await throws('a loan under it cannot ask for a rate',
      () => T((c) => L.apply(c, { memberId: mK.id, productId: 'FREE01', principal: 1000, termMonths: 2, monthlyRate: 1, createdBy: 't' })),
      (e) => /INTEREST_FREE_PRODUCT_TAKES_NO_RATE/.test(e.message));

    // ----------------------------------------------------------------------
    section('schedule shapes, previewed from the product');
    const preview = (id, body) => call('POST', `/api/loan-products/${id}/schedule-preview`, body);
    await product('WK01', { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, maxTerm: 52, repaymentIntervalUnit: 'WEEKS', repaymentIntervalCount: 2 });
    let pv = await preview('WK01', { principal: 80000, termMonths: 8, disbursedOn: '2026-01-12' });
    check('a fortnightly product falls every fourteen days',
      pv.status === 200 && pv.body.installments[0].nominalDue === '2026-01-26' && pv.body.installments[1].nominalDue === '2026-02-09',
      JSON.stringify(pv.body?.installments?.slice(0, 2)));
    check('with a fortnight\'s interest on each line', pv.body.installments[0].interest === round(80000 * 0.12 * 14 / 360));

    await product('PAY01', { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, maxTerm: 24, fixedDaysOfMonth: [1, 15], shortMonthHandling: 'LAST_DAY' });
    pv = await preview('PAY01', { principal: 40000, termMonths: 4, disbursedOn: '2026-01-12' });
    check('a payday product falls on the 1st and 15th',
      pv.body.installments.map((x) => x.nominalDue).join() === '2026-01-15,2026-02-01,2026-02-15,2026-03-01', pv.body.installments.map((x) => x.nominalDue).join());
    await product('OFF01', { monthlyRate: 1, maxTerm: 24, firstDueOffsetDays: 10, firstDueOffsetMin: 0, firstDueOffsetMax: 20 });
    pv = await preview('OFF01', { principal: 12000, termMonths: 3, disbursedOn: '2026-01-12' });
    check('a first due date offset moves the whole schedule', pv.body.installments[0].nominalDue === '2026-02-22' && pv.body.installments[1].nominalDue === '2026-03-22');
    await throws('and an offset outside the product band is refused',
      () => T((c) => L.apply(c, { memberId: mK.id, productId: 'OFF01', principal: 1000, termMonths: 2, firstDueOffsetDays: 45, createdBy: 't' })),
      (e) => /FIRST_DUE_OFFSET_ABOVE_PRODUCT_MAXIMUM/.test(e.message));

    await product('GRP01', { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, maxTerm: 24, graceType: 'PRINCIPAL', gracePeriods: 2 });
    pv = await preview('GRP01', { principal: 120000, termMonths: 6, disbursedOn: '2026-01-12' });
    check('principal grace: two interest-only lines, then the principal over four',
      pv.body.installments[0].principal === 0 && pv.body.installments[1].principal === 0 && pv.body.installments[0].interest === 1200
      && pv.body.installments[2].principal === 30000 && sum(pv.body.installments, (x) => x.principal) === 120000);
    await product('GRU01', { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, maxTerm: 24, graceType: 'PURE', gracePeriods: 2 });
    pv = await preview('GRU01', { principal: 120000, termMonths: 6, disbursedOn: '2026-01-12' });
    check('pure grace: nothing due for two lines, their interest spread over the rest',
      pv.body.installments[0].interest === 0 && pv.body.installments[1].principal === 0
      && sum(pv.body.installments, (x) => x.interest) === 5400 && pv.body.installments[2].interest === 1800,
      pv.body.installments.map((x) => `${x.principal}/${x.interest}`).join(' '));
    const { m: mG } = await T((c) => newMember(c));
    const gl = await T((c) => disbursedLoan(c, mG.id, 'GRU01', 120000, 6, '2026-01-12'));
    const gs = await schedule(gl.id);
    check('pure grace lines are stored as GRACE, so they never go overdue', gs[0].status === 'GRACE' && gs[2].status === 'PENDING');

    await product('BAL01', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', monthlyRate: 1, maxTerm: 36, amortizationPeriods: 240 });
    pv = await preview('BAL01', { principal: 1000000, termMonths: 36, disbursedOn: '2026-01-12' });
    const last = pv.body.installments[35];
    check('balloon: 35 payments as if over 240 months, the balance on the last',
      pv.body.installments.length === 36 && round(pv.body.installments[0].principal + pv.body.installments[0].interest) === 11010.86
      && last.principal > 900000 && sum(pv.body.installments, (x) => x.principal) === 1000000,
      `first ${pv.body.installments[0].principal}+${pv.body.installments[0].interest} last ${last.principal}`);
    await product('RND02', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', monthlyRate: 1, maxTerm: 24, rounding: 'WHOLE' });
    pv = await preview('RND02', { principal: 100000, termMonths: 4, disbursedOn: '2026-01-12' });
    check('rounding to the whole unit: 25,628 three times, remainder on the last',
      pv.body.installments.slice(0, 3).every((x) => round(x.principal + x.interest) === 25628) && sum(pv.body.installments, (x) => x.principal) === 100000);

    // ----------------------------------------------------------------------
    section('fees of every type');
    const feeP = await product('FEE01', { productType: 'FIXED_TERM', method: 'FLAT', monthlyRate: 1, maxTerm: 24 });
    check('fee product created', feeP.status === 201);
    const addFee = (body) => call('POST', '/api/loan-products/FEE01/fees', body);
    const fees = await Promise.all([
      addFee({ code: 'DEDUCT', name: 'Appraisal fee', feeType: 'DISBURSEMENT_DEDUCTED', calculation: 'PERCENT_OF_AMOUNT', percent: 2 }),
      addFee({ code: 'INSURE', name: 'Credit life insurance', feeType: 'DISBURSEMENT_CAPITALIZED', calculation: 'FLAT', amount: 500 }),
      addFee({ code: 'ADMIN', name: 'Administration fee', feeType: 'DISBURSEMENT_UPFRONT', calculation: 'PERCENT_OF_AMOUNT', percent: 1 }),
      addFee({ code: 'LEDGER', name: 'Ledger fee', feeType: 'PAYMENT_DUE', calculation: 'FLAT', amount: 50 }),
      addFee({ code: 'LATE', name: 'Late payment fee', feeType: 'LATE_REPAYMENT', calculation: 'FLAT', amount: 200 }),
      addFee({ code: 'CHEQUE', name: 'Bounced cheque', feeType: 'MANUAL', calculation: 'FLAT', amount: 300 }),
      addFee({ code: 'OPT', name: 'Optional statement fee', feeType: 'DISBURSEMENT_UPFRONT', calculation: 'FLAT', amount: 150, required: false }),
    ]);
    check('seven fees defined', fees.every((f) => f.status === 201), fees.map((f) => `${f.status} ${f.source || ''}`).join(' | '));
    const badCalc = await addFee({ code: 'BAD', name: 'x', feeType: 'LATE_REPAYMENT', calculation: 'FLAT_PER_INSTALLMENT', amount: 1 });
    check('a calculation that does not fit the fee type is refused', badCalc.status === 400 && /LATE_REPAYMENT fees may be/.test(badCalc.source));
    const noFig = await addFee({ code: 'NOFIG', name: 'x', feeType: 'DISBURSEMENT_UPFRONT', calculation: 'FLAT' });
    check('a flat fee without an amount is refused unless it is manual', noFig.status === 400);
    const listed = await call('GET', '/api/loan-products/FEE01');
    check('the product lists its fees', listed.body.fees.length === 7 && listed.body.fees.some((f) => f.code === 'LEDGER'));

    const { m: mF } = await T((c) => newMember(c));
    const feeIncBefore = -(await bal('400-200'));
    const bankBefore = await bal('100-200').catch(() => 0);
    const fl1 = await T((c) => disbursedLoan(c, mF.id, 'FEE01', 100000, 12, '2026-01-12', { fees: ['OPT'] }));
    const fRow = await loanRow(fl1.id);
    const fb = await balancesOf(fl1.id);
    check('deducted 2,000, capitalised 500: the member repays 100,500',
      fb.principal === 100500 && Number(fRow.principal_capitalized) === 500, JSON.stringify(fb));
    const disb = await Rd(async (c) => (await c.query(
      "SELECT allocation FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_DISBURSEMENT'", [fl1.id])).rows[0].allocation);
    check('the member received 98,000', disb.paidOut === 98000 && disb.deducted === 2000 && disb.capitalized === 500 && disb.upfront === 1150, JSON.stringify(disb));
    check('upfront 1,000 + optional 150 and twelve ledger fees of 50 are due: 1,750', fb.fees === 1750, String(fb.fees));
    const feeRows = await T((c) => F.forLoan(c, fl1.id));
    check('every fee is on the record with its status',
      feeRows.filter((f) => f.status === 'PAID').length === 2 && feeRows.filter((f) => f.fee_type === 'PAYMENT_DUE').length === 12
      && feeRows.filter((f) => f.fee_type === 'DISBURSEMENT_UPFRONT').length === 2, feeRows.map((f) => `${f.fee_type}:${f.status}`).join());
    check('fee income recognised: 2,000 + 500 at once, 1,150 upfront, 600 on the schedule = 4,250',
      round(-(await bal('400-200')) - feeIncBefore) === 4250, String(round(-(await bal('400-200')) - feeIncBefore)));
    const fsched = await schedule(fl1.id);
    check('the first installment carries the upfront fees plus its ledger fee', Number(fsched[0].fee_due) === 1200 && Number(fsched[1].fee_due) === 50);
    await assertBalanced('disbursement with fees');

    const manual = await call('POST', `/api/loans/${fl1.id}/fees`, { fee: 'CHEQUE', note: 'cheque 4471 bounced' });
    check('a manual fee is applied by code', manual.status === 201 && Number(manual.body.amount) === 300, `${manual.status} ${manual.source || ''}`);
    check('and is now due', (await balancesOf(fl1.id)).fees === 2050);
    const arb = await call('POST', `/api/loans/${fl1.id}/fees`, { name: 'Courier', amount: 80 });
    check('an arbitrary fee is refused until the product allows it', arb.status === 409 && /ARBITRARY/.test(arb.reason));
    await call('PATCH', '/api/loan-products/FEE01', { allowArbitraryFees: true });
    const arb2 = await call('POST', `/api/loans/${fl1.id}/fees`, { name: 'Courier', amount: 80 });
    check('then accepted', arb2.status === 201 && (await balancesOf(fl1.id)).fees === 2130);
    const waived = await call('POST', `/api/loans/fees/${manual.body.id}/waive`, { reason: 'bank error' });
    check('a fee can be waived, reversing its posting', waived.status === 200 && (await balancesOf(fl1.id)).fees === 1830, `${waived.status}`);
    const rep = await repay(fl1.id, 1830, '2026-01-20');
    check('a repayment settles fees first (default order) and the fee rows show it',
      rep.allocation.fees === 1830 && (await T((c) => F.forLoan(c, fl1.id))).filter((f) => f.status === 'DUE').length === 0);
    await assertBalanced('fees paid');

    const delUsed = await call('DELETE', '/api/loan-products/FEE01/fees/LEDGER');
    check('a fee that has been applied cannot be deleted', delUsed.status === 409);
    const retype = await call('PATCH', '/api/loan-products/FEE01/fees/LEDGER', { feeType: 'MANUAL' });
    check('nor retyped', retype.status === 400);
    const deact = await call('PATCH', '/api/loan-products/FEE01/fees/LEDGER', { isActive: false, amount: 75 });
    check('but it can be deactivated and its figure changed', deact.status === 200 && deact.body.isActive === false && deact.body.amount === 75);
    await addFee({ code: 'TMP', name: 'Created by mistake', feeType: 'MANUAL', calculation: 'FLAT', amount: 10 });
    const delNew = await call('DELETE', '/api/loan-products/FEE01/fees/TMP');
    check('an unused fee can be deleted', delNew.status === 204, String(delNew.status));

    // Late fees on a loan whose installments have gone overdue.
    const fl2 = await T((c) => disbursedLoan(c, mF.id, 'FEE01', 60000, 6, plus(-70)));
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    const late1 = await T(async (c) => F.applyLateFees(c, await L.lock(c, fl2.id), plus(0)));
    const late2 = await T(async (c) => F.applyLateFees(c, await L.lock(c, fl2.id), plus(0)));
    check('two installments overdue: two late fees, and not again on a rerun', late1 === 2 && late2 === 0, `${late1} ${late2}`);
    await assertBalanced('late fees');

    // Dynamic payment-due fees fall due installment by installment.
    await product('DFEE01', { productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, maxTerm: 24 });
    await call('POST', '/api/loan-products/DFEE01/fees', { code: 'LEDGER', name: 'Ledger fee', feeType: 'PAYMENT_DUE', calculation: 'FLAT_PER_INSTALLMENT', amount: 600 });
    const dl = await T((c) => disbursedLoan(c, mF.id, 'DFEE01', 60000, 6, '2026-01-12'));
    check('on a dynamic loan the schedule shows 100 a line but nothing is due yet',
      Number((await schedule(dl.id))[0].fee_due) === 100 && (await balancesOf(dl.id)).fees === 0);
    await T(async (c) => F.applyPaymentDueFees(c, await L.lock(c, dl.id), '2026-02-12'));
    check('the first falls due on its date', (await balancesOf(dl.id)).fees === 100);

    // ----------------------------------------------------------------------
    section('penalty bases and tolerance');
    const mkPen = (id, basis, extra = {}) => product(id, { monthlyRate: 1, maxTerm: 12, penaltyRate: 0.5, penaltyBasis: basis, penaltyToleranceDays: 3, glPenaltyInc: '400-200', ...extra });
    check('four penalty products', (await Promise.all([
      mkPen('PN_P', 'OVERDUE_PRINCIPAL'), mkPen('PN_PI', 'OVERDUE_PRINCIPAL_INTEREST'),
      mkPen('PN_ALL', 'OVERDUE_ALL', { maxTerm: 36 }), mkPen('PN_OUT', 'OUTSTANDING_PRINCIPAL')])).every((r) => r.status === 201));
    const { m: mP } = await T((c) => newMember(c));
    const penLoan = async (pid, extra) => {
      const l = await T((c) => disbursedLoan(c, mP.id, pid, 120000, 12, plus(-40), extra));
      await accrue(l.id, plus(0));
      await T((c) => L.markArrears(c, { asOf: plus(0) }));
      const charges = await T((c) => P.accrueForLoan(c, l.id, { asOf: plus(0) }));
      return { l, charge: charges[0] };
    };
    const pP = await penLoan('PN_P');
    const pPI = await penLoan('PN_PI');
    const pAll = await penLoan('PN_ALL');
    const pOut = await penLoan('PN_OUT');
    check('OVERDUE_PRINCIPAL: 0.5% a day of the 10,000 principal due', Number(pP.charge.amount) === 50, String(pP.charge?.amount));
    check('OVERDUE_PRINCIPAL_INTEREST: on 11,200', Number(pPI.charge.amount) === 56, String(pPI.charge?.amount));
    check('OVERDUE_ALL: the same here, no fees', Number(pAll.charge.amount) === 56);
    check('OUTSTANDING_PRINCIPAL: on the whole 120,000', Number(pOut.charge.amount) === 600, String(pOut.charge?.amount));
    const tolLoan = await T((c) => disbursedLoan(c, mP.id, 'PN_P', 120000, 12, plus(-32)));
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    const tolCharges = await T((c) => P.accrueForLoan(c, tolLoan.id, { asOf: plus(0) }));
    check('within the penalty tolerance nothing is charged', tolCharges.length === 0);
    const ovr = await T((c) => disbursedLoan(c, mP.id, 'PN_P', 120000, 12, plus(-40), { penaltyRate: 0.1 }));
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    const ovrCharges = await T((c) => P.accrueForLoan(c, ovr.id, { asOf: plus(0) }));
    check('a loan carries its own penalty rate within the product band', Number(ovrCharges[0].amount) === 10, String(ovrCharges[0]?.amount));
    await product('PN_BAND', { monthlyRate: 1, maxTerm: 12, penaltyRate: 0.5, penaltyRateMin: 0.2, penaltyRateMax: 1, penaltyBasis: 'OVERDUE_ALL' });
    await throws('and a rate outside the band is refused',
      () => T((c) => L.apply(c, { memberId: mP.id, productId: 'PN_BAND', principal: 1000, termMonths: 2, penaltyRate: 2, createdBy: 't' })),
      (e) => /PENALTY_RATE_ABOVE_PRODUCT_MAXIMUM/.test(e.message));
    await assertBalanced('penalties');

    // ----------------------------------------------------------------------
    section('arrears tolerance');
    await product('TOL01', { monthlyRate: 1, maxTerm: 12, arrearsToleranceDays: 5 });
    const { m: mT } = await T((c) => newMember(c));
    const tl = await T((c) => disbursedLoan(c, mT.id, 'TOL01', 120000, 12, plus(-40)));
    const due1 = new Date((await schedule(tl.id))[0].due_date);
    await T((c) => L.markArrears(c, { asOf: plus(5, due1) }));
    check('five days past due, within the five days of tolerance: still ACTIVE', (await loanRow(tl.id)).status === 'ACTIVE', (await loanRow(tl.id)).status);
    await T((c) => L.markArrears(c, { asOf: plus(6, due1) }));
    const tlRow = await loanRow(tl.id);
    check('six days past due: IN_ARREARS, counted from the due date',
      tlRow.status === 'IN_ARREARS' && tlRow.arrears_since && W.daysInArrears(tlRow, plus(6, due1)) === 6, `${tlRow.status} ${tlRow.arrears_since}`);
    await accrue(tl.id, plus(6, due1));
    await repay(tl.id, 11200, plus(6, due1));
    check('paying the installment clears the arrears', (await loanRow(tl.id)).status === 'ACTIVE' && (await loanRow(tl.id)).arrears_since === null);

    await product('TOL02', { monthlyRate: 1, maxTerm: 12, arrearsTolerancePercent: 5, arrearsToleranceFloor: 500 });
    const t2 = await T((c) => disbursedLoan(c, mT.id, 'TOL02', 120000, 12, plus(-33)));
    await accrue(t2.id, plus(-2));
    await repay(t2.id, 10900, plus(-2));   // 300 short of the 11,200 due
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    check('a shortfall under the tolerance floor is a partial payment, not arrears',
      (await loanRow(t2.id)).status === 'ACTIVE' && (await schedule(t2.id))[0].status === 'PARTIALLY_PAID');

    // ----------------------------------------------------------------------
    section('the cap on charges');
    await product('CAPH', { monthlyRate: 1, maxTerm: 12, penaltyRate: 1, penaltyBasis: 'OUTSTANDING_PRINCIPAL', glPenaltyInc: '400-200',
      chargeCapPercent: 2, chargeCapBase: 'OUTSTANDING_PRINCIPAL', chargeCapMode: 'HARD' });
    const { m: mH } = await T((c) => newMember(c));
    const hl = await T((c) => disbursedLoan(c, mH.id, 'CAPH', 100000, 12, plus(-40)));
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    // 1% a day of 100,000 is 1,000 a day; the cap is 2% of 100,000 = 2,000.
    const c1 = await T((c) => P.accrueForLoan(c, hl.id, { asOf: plus(0) }));
    const c2 = await T((c) => P.accrueForLoan(c, hl.id, { asOf: plus(1) }));
    const c3 = await T((c) => P.accrueForLoan(c, hl.id, { asOf: plus(2) }));
    const hRow = await loanRow(hl.id);
    check('two days of penalties reach the cap; the third is refused and the loan is locked',
      c1.length === 1 && c2.length === 1 && c3.length === 0 && hRow.status === 'LOCKED' && hRow.locked_reason === 'CAPPED'
      && Number(hRow.charges_since_arrears) === 2000, `${c1.length} ${c2.length} ${c3.length} ${hRow.status} ${hRow.charges_since_arrears}`);
    const unlock = await call('POST', `/api/loans/${hl.id}/unlock`, {});
    check('a cap lock cannot be lifted while the charges are unpaid and the loan is in arrears',
      unlock.status === 409 && /CAP_LOCK/.test(unlock.reason), `${unlock.status} ${unlock.reason}`);
    check('interest stops accruing on a locked loan', (await accrue(hl.id, plus(5))) === null);
    await product('CAPS', { monthlyRate: 1, maxTerm: 12, penaltyRate: 1, penaltyBasis: 'OUTSTANDING_PRINCIPAL', glPenaltyInc: '400-200',
      chargeCapPercent: 1.5, chargeCapBase: 'OUTSTANDING_PRINCIPAL', chargeCapMode: 'SOFT' });
    const sl2 = await T((c) => disbursedLoan(c, mH.id, 'CAPS', 100000, 12, plus(-40)));
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    await T((c) => P.accrueForLoan(c, sl2.id, { asOf: plus(0) }));
    const s2 = await T((c) => P.accrueForLoan(c, sl2.id, { asOf: plus(1) }));
    check('a soft cap applies the charge that crosses the line, then locks',
      s2.length === 1 && Number(s2[0].amount) === 1000 && (await loanRow(sl2.id)).status === 'LOCKED', `${s2.length} ${(await loanRow(sl2.id)).status}`);
    const capped = await call('GET', '/api/loan-products/NL01');
    check('the seeded product ships with no cap', capped.body.chargeCapPercent === null);
    await assertBalanced('cap');

    // ----------------------------------------------------------------------
    section('a product not linked to accounting');
    const noMap = await product('NOAC0', { accountingMethod: 'NONE', monthlyRate: 1, maxTerm: 12, glPortfolio: undefined, glInterestInc: undefined });
    check('a mapping sent for a product not linked to accounting is refused', noMap.status === 400 && /NOT_REQUIRED_ACCOUNTING_RULE: feeIncome/.test(noMap.source || ''), noMap.source);
    const none = await product('NOACC', { accountingMethod: 'NONE', monthlyRate: 1, maxTerm: 12, glPortfolio: undefined, glInterestInc: undefined, glFeeInc: undefined });
    check('needs no GL accounts', none.status === 201 && none.body.accountingMethod === 'NONE', `${none.status} ${none.source || none.reason || ''}`);
    const loanGls = ['100-100', '100-300', '100-310', '100-320', '400-100', '400-200'];
    const onLoanGls = () => Rd(async (c) => (await c.query('SELECT count(*)::int AS n FROM journal_lines WHERE gl_code = ANY($1)', [loanGls])).rows[0].n);
    const linesBefore = await onLoanGls();
    const suspenseBefore = await bal('290-900');
    const { m: mN } = await T((c) => newMember(c));
    const nlo = await T((c) => disbursedLoan(c, mN.id, 'NOACC', 50000, 5, '2026-01-12'));
    await accrue(nlo.id, '2026-02-12');
    await repay(nlo.id, 10500, '2026-02-12');
    const linesAfter = await onLoanGls();
    check('disbursement, accrual and repayment touched none of the loan accounts', linesAfter === linesBefore, `${linesBefore} -> ${linesAfter}`);
    check('the cash moved against suspense: 50,000 out, 10,500 back', (await bal('290-900')) - suspenseBefore === 39500, String((await bal('290-900')) - suspenseBefore));
    check('but the loan keeps its balances', (await balancesOf(nlo.id)).principal === 40000 && (await balancesOf(nlo.id)).interest === 0);
    await assertBalanced('unlinked product');

    // ----------------------------------------------------------------------
    section('the life cycle, with undo');
    await product('WF01', { monthlyRate: 1, maxTerm: 24, initialState: 'PARTIAL_APPLICATION', rateMin: 0.5, rateMax: 2 });
    const { m: mW } = await T((c) => newMember(c, 500000));
    const wf = (await call('POST', '/api/loans', { memberId: mW.id, productId: 'WF01', principal: 120000, termMonths: 12, purpose: 'school fees' })).body;
    check('an application under the product starts PARTIAL_APPLICATION', wf.status === 'PARTIAL_APPLICATION' && wf.purpose === 'school fees', wf.status);
    const early = await call('POST', `/api/loans/${wf.id}/approve`, {});
    check('it cannot be approved from there', early.status === 409);
    check('requesting approval moves it on', (await call('POST', `/api/loans/${wf.id}/request-approval`, {})).body.status === 'PENDING_APPROVAL');
    check('and it can be sent back for documents', (await call('POST', `/api/loans/${wf.id}/set-incomplete`, { note: 'payslip missing' })).body.status === 'PARTIAL_APPLICATION');
    await call('POST', `/api/loans/${wf.id}/request-approval`, {});
    const amended = await call('PATCH', `/api/loans/${wf.id}`, { principal: 100000, monthlyRate: 1.5, notes: 'reduced at counter' });
    check('the terms can be amended while pending', amended.status === 200 && Number(amended.body.principal) === 100000 && Number(amended.body.monthly_rate) === 1.5, `${amended.status} ${amended.source || ''}`);
    const outOfBand = await call('PATCH', `/api/loans/${wf.id}`, { monthlyRate: 3 });
    check('but not outside the product band', outOfBand.status === 400 && /RATE_ABOVE/.test(outOfBand.reason));
    const rejected = await call('POST', `/api/loans/${wf.id}/reject`, { note: 'CRB listing' });
    check('rejected closes it', rejected.body.status === 'CLOSED_REJECTED');
    const unrejected = await call('POST', `/api/loans/${wf.id}/undo-reject`, {});
    check('undo reject returns it to where it was', unrejected.body.status === 'PENDING_APPROVAL', unrejected.body?.status || unrejected.reason);
    const approved = await call('POST', `/api/loans/${wf.id}/approve`, {}, 'senior');
    check('approved, recording who', approved.status === 200 && approved.body.approved_by === 'senior@cfgtest.local', `${approved.status} ${approved.reason || ''}`);
    const afterApproval = await call('PATCH', `/api/loans/${wf.id}`, { principal: 90000 });
    check('after approval the terms are frozen', afterApproval.status === 409 && /NOT_EDITABLE_IN_STATE_APPROVED/.test(afterApproval.reason));
    check('only the narrative may change', (await call('PATCH', `/api/loans/${wf.id}`, { notes: 'call before disbursing' })).status === 200);
    check('undo approve reopens the terms', (await call('POST', `/api/loans/${wf.id}/undo-approve`, {})).body.status === 'PENDING_APPROVAL'
      && (await call('PATCH', `/api/loans/${wf.id}`, { principal: 90000 })).status === 200);
    await call('POST', `/api/loans/${wf.id}/approve`, {}, 'senior');
    const withdrawn = await call('POST', `/api/loans/${wf.id}/withdraw`, {});
    const unwithdrawn = await call('POST', `/api/loans/${wf.id}/undo-withdraw`, {});
    check('withdraw and undo withdraw, from APPROVED back to APPROVED', withdrawn.body.status === 'CLOSED_WITHDRAWN' && unwithdrawn.body.status === 'APPROVED');
    const hist = (await call('GET', `/api/loans/${wf.id}/history`)).body;
    check('every step is in the history',
      hist.map((h) => h.action).join() === 'APPLY,REQUEST_APPROVAL,SET_INCOMPLETE,REQUEST_APPROVAL,REJECT,UNDO_REJECT,APPROVE,UNDO_APPROVE,APPROVE,WITHDRAW,UNDO_WITHDRAW',
      hist.map((h) => h.action).join());
    check('with the note that sent it back', hist.find((h) => h.action === 'SET_INCOMPLETE').note === 'payslip missing');

    section('approval and disbursement limits, and the two-man rule');
    const tooBig = await call('POST', `/api/loans/${wf.id}/undo-approve`, {}).then(() => call('POST', `/api/loans/${wf.id}/approve`, {}, 'junior'));
    check('a manager with a 50,000 approval limit cannot approve 90,000', tooBig.status === 403 && /ABOVE_YOUR_APPROVAL_LIMIT/.test(tooBig.reason), `${tooBig.status} ${tooBig.reason}`);
    const seniorOk = await call('POST', `/api/loans/${wf.id}/approve`, {}, 'senior');
    check('one without a limit can', seniorOk.status === 200);
    const juniorDisb = await call('POST', `/api/loans/${wf.id}/disbursements`, { channelId: 'bank' }, 'junior');
    check('nor may the junior disburse above their disbursement limit', juniorDisb.status === 403 && /DISBURSEMENT_LIMIT/.test(juniorDisb.reason));
    const ctl = await call('PATCH', '/api/loans/controls', { twoManRule: true });
    check('the two-man rule is a tenant control', ctl.status === 200 && ctl.body.two_man_rule === true, `${ctl.status}`);
    const sameHands = await call('POST', `/api/loans/${wf.id}/disbursements`, { channelId: 'bank' }, 'senior');
    check('the approver may not disburse', sameHands.status === 403 && /TWO_MAN_RULE/.test(sameHands.reason));
    const otherHands = await call('POST', `/api/loans/${wf.id}/disbursements`, { channelId: 'bank' }, 'admin');
    check('someone else may', otherHands.status === 201, `${otherHands.status} ${otherHands.reason || ''}`);
    check('and the loan records both names', (await loanRow(wf.id)).approved_by === 'senior@cfgtest.local' && (await loanRow(wf.id)).disbursed_by === 'admin@cfgtest.local');
    await call('PATCH', '/api/loans/controls', { twoManRule: false });

    section('exposure controls');
    await call('PATCH', '/api/loans/controls', { maxExposureMode: 'SUM_OF_LOANS', maxExposureAmount: 100000 });
    const second = (await call('POST', '/api/loans', { memberId: mW.id, productId: 'NL01', principal: 20000, termMonths: 6 })).body;
    const overExposed = await call('POST', `/api/loans/${second.id}/approve`, {}, 'senior');
    check('with 90,000 out and a 100,000 cap, 20,000 more is refused at approval',
      overExposed.status === 409 && /EXCEEDS_MAXIMUM_EXPOSURE/.test(overExposed.reason), `${overExposed.status} ${overExposed.reason}`);
    const elig = (await call('GET', `/api/loans/${second.id}/eligibility`)).body;
    check('the eligibility picture says why', elig.rules.maxExposure === 'BREACHED' && elig.exposure.exposed === 110000, JSON.stringify(elig.exposure));
    await call('PATCH', '/api/loans/controls', { maxExposureMode: 'UNLIMITED', oneActiveLoanPerMember: true });
    const oneLoan = await call('POST', '/api/loans', { memberId: mW.id, productId: 'NL01', principal: 5000, termMonths: 3 });
    check('one active loan per member refuses a second application', oneLoan.status === 409 && /ALREADY_HAS_AN_ACTIVE_LOAN/.test(oneLoan.reason));
    await call('PATCH', '/api/loans/controls', { oneActiveLoanPerMember: false, minArrearsDaysBeforeWriteoff: 90 });
    const wo = await call('POST', `/api/loans/${wf.id}/write-off`, { reason: 'test' });
    check('a write-off before the minimum days in arrears is refused', wo.status === 409 && /WRITE_OFF_REQUIRES_90_DAYS/.test(wo.reason));
    await call('PATCH', '/api/loans/controls', { minArrearsDaysBeforeWriteoff: 0 });

    section('lock and unlock by hand');
    const locked = await call('POST', `/api/loans/${wf.id}/lock`, { note: 'dispute' });
    check('a running loan can be locked', locked.body.status === 'LOCKED' && locked.body.locked_reason === 'MANUAL');
    check('a locked loan takes no repayment', (await call('POST', `/api/loans/${wf.id}/repayments`, { amount: 100, channelId: 'cash' })).status === 409);
    check('and unlocks to where it was', (await call('POST', `/api/loans/${wf.id}/unlock`, {})).body.status === 'ACTIVE');

    section('reschedule and refinance');
    const { m: mR } = await T((c) => newMember(c, 300000));
    const guarantor = await T((c) => newMember(c, 100000));
    const rl = await T(async (c) => {
      const l = await L.apply(c, { memberId: mR.id, productId: 'PN_ALL', principal: 120000, termMonths: 12, createdBy: 'officer' });
      await L.addGuarantor(c, l.id, { memberId: guarantor.m.id, amount: 40000 });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
      await L.disburse(c, l.id, { amount: 120000, channelId: 'bank', valueDate: plus(-70), createdBy: 'teller' });
      return l;
    });
    await accrue(rl.id, plus(0));
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    await T((c) => P.accrueForLoan(c, rl.id, { asOf: plus(0) }));
    const before = await balancesOf(rl.id);
    check('a loan two months in arrears owes interest and a penalty', before.interest > 0 && before.penalty > 0 && before.principal === 120000, JSON.stringify(before));
    const portfolioPre = await bal('100-100');
    const res = await call('POST', `/api/loans/${rl.id}/reschedule`, { termMonths: 18, arrears: 'CAPITALIZE', note: 'job loss, agreed with committee' });
    check('rescheduled: the old loan closes, a new one opens', res.status === 201 && res.body.oldLoan.status === 'CLOSED_RESCHEDULED'
      && res.body.newLoan.status === 'ACTIVE' && res.body.newLoan.parent_loan_id === rl.id, `${res.status} ${res.reason || ''}`);
    const nb = await balancesOf(res.body.newLoan.id);
    check('its principal is the old balance plus the capitalised charges, over eighteen installments',
      nb.principal === round(before.principal + before.interest + before.fees + before.penalty) && nb.interest === 0
      && (await schedule(res.body.newLoan.id)).length === 18, JSON.stringify(nb));
    check('the old loan is settled to zero', (await balancesOf(rl.id)).total === 0);
    check('the portfolio grew by exactly the capitalised charges', round((await bal('100-100')) - portfolioPre) === round(before.interest + before.fees + before.penalty));
    const newGs = await Rd(async (c) => (await c.query("SELECT * FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED'", [res.body.newLoan.id])).rows);
    const oldGs = await Rd(async (c) => (await c.query("SELECT status FROM loan_guarantors WHERE loan_id = $1", [rl.id])).rows);
    check('the guarantor\'s pledge moved to the new loan', newGs.length === 1 && Number(newGs[0].pledged_amount) === 40000 && oldGs[0].status === 'RELEASED');
    check('both loans carry the step in their history',
      (await call('GET', `/api/loans/${rl.id}/history`)).body.at(-1).action === 'RESCHEDULE'
      && (await call('GET', `/api/loans/${res.body.newLoan.id}/history`)).body.at(-1).note === `from ${res.body.oldLoan.accountNo}`);
    await assertBalanced('reschedule');

    const rl2 = await T((c) => disbursedLoan(c, mR.id, 'PN_ALL', 60000, 6, plus(-70)));
    await accrue(rl2.id, plus(0));
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    const b2 = await balancesOf(rl2.id);
    const woExpPre = await bal('500-310');
    const bankPre = await bal((await Rd(async (c) => (await c.query("SELECT gl_account_code FROM transaction_channels WHERE id = 'bank'")).rows[0].gl_account_code)));
    // A top-up is an application: requested, approved, then disbursed (test/top-up.test.js has the controls).
    const rq = await call('POST', `/api/loans/${rl2.id}/refinance`, { termMonths: 12, topUp: 25000, arrears: 'WRITE_OFF' });
    check('a top-up opens an application for approval', rq.status === 201 && rq.body.application.refinance_of === rl2.id
      && Number(rq.body.application.principal) === 85000 && rq.body.quote.topUp === 25000, `${rq.status} ${rq.reason || ''}`);
    await call('POST', `/api/loans/${rq.body.application.id}/approve`, {});
    const rf = await call('POST', `/api/loans/${rq.body.application.id}/disbursements`, { channelId: 'bank' });
    check('refinanced with a 25,000 top-up, arrears written off', rf.status === 201 && rf.body.oldLoan.status === 'CLOSED_REFINANCED'
      && (await balancesOf(rf.body.newLoan.id)).principal === 85000, `${rf.status} ${rf.reason || ''} ${JSON.stringify(rf.body?.newLoan && (await balancesOf(rf.body.newLoan.id)))}`);
    check('the written-off interest hit the write-off expense', round((await bal('500-310')) - woExpPre) === b2.interest, `${round((await bal('500-310')) - woExpPre)} vs ${b2.interest}`);
    check('and the top-up left the bank', round(bankPre - (await bal((await Rd(async (c) => (await c.query("SELECT gl_account_code FROM transaction_channels WHERE id = 'bank'")).rows[0].gl_account_code))))) === 25000);
    const noTop = await call('POST', `/api/loans/${rf.body.newLoan.id}/refinance`, { termMonths: 12, arrears: 'CAPITALIZE' });
    check('a refinance without a top-up is refused', noTop.status === 400);
    const closedAgain = await call('POST', `/api/loans/${rl2.id}/reschedule`, { termMonths: 6 });
    check('a closed loan cannot be restructured again', closedAgain.status === 409);
    await assertBalanced('refinance');

    section('product settings frozen once loans exist');
    const frozen = await call('PATCH', '/api/loan-products/WF01', { method: 'REDUCING' });
    check('the interest method cannot change under running loans', frozen.status === 400 && /cannot change while/.test(frozen.source), frozen.source);
    check('the rate still can', (await call('PATCH', '/api/loan-products/WF01', { monthlyRate: 1.2 })).status === 200);
    await assertBalanced('everything');
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
