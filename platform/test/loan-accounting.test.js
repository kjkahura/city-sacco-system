#!/usr/bin/env node
'use strict';

/**
 * Loan product accounting, on the rules Mambu publishes for accrual and cash
 * products. Each section here is a test that would have caught one of the
 * three findings from the loan product review: interest and penalties
 * recognised twice, a month of interest booked every night, and eligibility
 * that was reported but never enforced.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/savings');
const P = require('../src/domain/penalties');
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

const SLUG = 'latest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4094;
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const bal = (code) => Rd((c) => acct.balance(c, code));
const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const today = plus(0);

let server;
let token;
async function call(method, p, body) {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORT}${p}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, err: d?.errors?.[0] };
}

async function assertBalanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced, `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}

async function newMember(c, no, deposit) {
  const m = (await c.query(
    `INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'Test',$1) RETURNING *`, [no])).rows[0];
  const sav = await S.open(c, { memberId: m.id });
  if (deposit) await S.deposit(c, sav.id, { amount: deposit, channelId: 'cash', createdBy: 'test' });
  return { m, sav };
}

async function disbursedLoan(c, memberId, productId, principal, term, on = today) {
  const l = await L.apply(c, { memberId, productId, principal, termMonths: term, createdBy: 'test' });
  await L.changeState(c, l.id, 'APPROVE', { createdBy: 'test' });
  await L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: on, createdBy: 'test' });
  return l;
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
      slug: SLUG, name: 'Loan Accounting SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@latest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login',
      { email: 'admin@latest.local', password: 'a sufficiently long passphrase' })).body.accessToken;

    const seeded = await Rd(async (c) => (await c.query("SELECT * FROM loan_products WHERE id = 'NL01'")).rows[0]);
    check('the seeded product is accrual, daily, 30E/360 and carries its receivables',
      seeded.accounting_method === 'ACCRUAL' && seeded.interest_accrual === 'DAILY'
      && seeded.day_count === 'THIRTY_360' && seeded.gl_interest_rec === '100-300'
      && seeded.gl_fee_rec === '100-310' && seeded.gl_penalty_rec === '100-320',
      JSON.stringify([seeded.accounting_method, seeded.interest_accrual, seeded.day_count]));

    section('day count arithmetic');
    check('30E/360: any calendar month is thirty days',
      L.dayCount('2027-01-31', '2027-02-28', 'THIRTY_360') === 30
      && L.dayCount('2026-09-22', '2026-10-22', 'THIRTY_360') === 30
      && L.dayCount('2026-03-01', '2026-04-01', 'THIRTY_360') === 30);
    check('Actual: counts the days that passed',
      L.dayCount('2026-02-01', '2026-03-01', 'ACTUAL_365') === 28
      && L.dayCount('2028-02-01', '2028-03-01', 'ACTUAL_360') === 29);
    check('1% a month on 120,000 for thirty days under 30E/360 is exactly 1,200',
      L.interestFor(120000, 1, '2026-09-22', '2026-10-22', 'THIRTY_360') === 1200);
    check('the same under Actual/365 is less, because twelve months of 30 is not a year',
      L.interestFor(120000, 1, '2026-09-22', '2026-10-22', 'ACTUAL_365') === 1183.56,
      String(L.interestFor(120000, 1, '2026-09-22', '2026-10-22', 'ACTUAL_365')));
    check('a full year is twelve months\' interest under both 30E/360 and Actual/Actual',
      L.interestFor(120000, 1, '2026-01-01', '2027-01-01', 'THIRTY_360') === 14400
      && L.interestFor(120000, 1, '2027-12-31', '2028-12-31', 'ACTUAL_ACTUAL') === 14400);

    // ---------------------------------------------------------------------
    section('finding 1: interest is recognised once, not twice');
    const A = await T((c) => newMember(c, 'A1', 500000));
    const loanA = await T((c) => disbursedLoan(c, A.m.id, 'NL01', 120000, 12));

    const incomeBefore = -(await bal('400-100'));
    await T((c) => L.accrueInterest(c, loanA.id, { valueDate: plus(30), createdBy: 'test' }));
    check('accrual debits the interest receivable', (await bal('100-300')) === 1200, String(await bal('100-300')));
    check('and credits interest income once', -(await bal('400-100')) - incomeBefore === 1200);

    check('the processing fee sits in fees receivable until paid', (await bal('100-310')) === 1000, String(await bal('100-310')));
    check('and was recognised as fee income at disbursement', -(await bal('400-200')) === 1000, String(-(await bal('400-200'))));

    // Default order pays the fee before the interest, so one payment covers both.
    const rep = await T((c) => L.repay(c, loanA.id, { amount: 2200, channelId: 'cash', createdBy: 'test' }));
    check('the repayment is allocated fee first, then interest',
      rep.allocation.fees === 1000 && rep.allocation.interest === 1200 && rep.allocation.principal === 0,
      JSON.stringify(rep.allocation));
    check('paying the interest clears its receivable', (await bal('100-300')) === 0, String(await bal('100-300')));
    check('paying the fee clears its receivable', (await bal('100-310')) === 0, String(await bal('100-310')));
    check('interest income is still 1,200, not 2,400', -(await bal('400-100')) - incomeBefore === 1200,
      String(-(await bal('400-100')) - incomeBefore));
    check('fee income is still 1,000', -(await bal('400-200')) === 1000, String(-(await bal('400-200'))));
    await assertBalanced('interest and fee repayment');

    section('finding 1, continued: penalties go through a receivable too');
    await T((c) => c.query(
      `UPDATE loan_products SET penalty_rate = 0.5, penalty_basis = 'OVERDUE_ALL', gl_penalty_inc = '400-200' WHERE id = 'NL01'`));
    // A running loan keeps the penalty settings it was approved with, so this one is given them directly.
    await T((c) => c.query(
      `UPDATE loan_accounts SET penalty_rate = 0.5, settings_snapshot = settings_snapshot || '{"penalty_basis":"OVERDUE_ALL"}'::jsonb WHERE id = $1`, [loanA.id]));
    await T((c) => c.query(
      'UPDATE loan_installments SET due_date = $1::date WHERE loan_id = $2 AND number = 1', [plus(-10), loanA.id]));
    const pen = await T((c) => P.accrueForLoan(c, loanA.id, { asOf: today }));
    check('a penalty is charged', pen.length === 1 && Number(pen[0].amount) > 0, JSON.stringify(pen.map((x) => x.amount)));
    const penAmt = Number(pen[0].amount);
    check('into penalties receivable, not the loan portfolio',
      (await bal('100-320')) === penAmt && (await bal('100-100')) === 120000,
      `pen rec ${await bal('100-320')}, portfolio ${await bal('100-100')}`);
    const feeIncBefore = -(await bal('400-200'));
    const penPay = await T((c) => L.repay(c, loanA.id, { amount: penAmt, channelId: 'cash', createdBy: 'test' }));
    check('paying the penalty clears the receivable and leaves income where it was',
      penPay.allocation.penalty === penAmt && (await bal('100-320')) === 0
      && -(await bal('400-200')) === feeIncBefore, `rec ${await bal('100-320')}`);
    await assertBalanced('fee and penalty');

    // ---------------------------------------------------------------------
    section('finding 2: interest accrues per day, once per day');
    const B = await T((c) => newMember(c, 'B1', 500000));
    const loanB = await T((c) => disbursedLoan(c, B.m.id, 'NL01', 120000, 12));
    const interestOf = async () => Number((await Rd(async (c) =>
      (await c.query('SELECT interest_accrued FROM loan_accounts WHERE id = $1', [loanB.id])).rows[0])).interest_accrued);

    await T((c) => L.accrueInterest(c, loanB.id, { valueDate: plus(1), createdBy: 'test' }));
    check('one night accrues one day of interest, 40 not 1,200', (await interestOf()) === 40, String(await interestOf()));
    await T((c) => L.accrueInterest(c, loanB.id, { valueDate: plus(1), createdBy: 'test' }));
    check('the same night again accrues nothing', (await interestOf()) === 40, String(await interestOf()));
    await T((c) => L.accrueInterest(c, loanB.id, { valueDate: plus(2), createdBy: 'test' }));
    await T((c) => L.accrueInterest(c, loanB.id, { valueDate: plus(3), createdBy: 'test' }));
    check('three nights, three days', (await interestOf()) === 120, String(await interestOf()));
    await T((c) => L.accrueInterest(c, loanB.id, { valueDate: plus(30), createdBy: 'test' }));
    check('a gap is caught up, and thirty days is one month exactly', (await interestOf()) === 1200, String(await interestOf()));
    const marker = await Rd(async (c) => (await c.query(
      'SELECT accrued_through FROM loan_accounts WHERE id = $1', [loanB.id])).rows[0].accrued_through);
    check('the loan remembers how far it has accrued', String(marker).slice(0, 10) === plus(30) || new Date(marker).toISOString().slice(0, 10) === plus(30),
      String(marker));

    section('monthly accrual books the month on its last day');
    await T((c) => c.query(
      `INSERT INTO loan_products (id, name, method, monthly_rate, max_term, processing_fee, interest_accrual,
         gl_portfolio, gl_interest_inc, gl_fee_inc)
       VALUES ('MO01','Monthly Accrual','FLAT',1.000,12,0,'MONTHLY','100-100','400-100','400-200')`));
    const C = await T((c) => newMember(c, 'C1', 500000));
    const loanC = await T((c) => disbursedLoan(c, C.m.id, 'MO01', 60000, 6, '2026-01-10'));
    const interestC = async () => Number((await Rd(async (c) =>
      (await c.query('SELECT interest_accrued FROM loan_accounts WHERE id = $1', [loanC.id])).rows[0])).interest_accrued);
    const mid = await T((c) => L.accrueInterest(c, loanC.id, { valueDate: '2026-01-20', createdBy: 'test' }));
    check('a mid-month run books nothing', mid === null && (await interestC()) === 0);
    await T((c) => L.accrueInterest(c, loanC.id, { valueDate: '2026-01-31', createdBy: 'test' }));
    check('the month-end books one month', (await interestC()) === 600, String(await interestC()));
    await T((c) => L.accrueInterest(c, loanC.id, { valueDate: '2026-03-31', createdBy: 'test' }));
    check('a missed month-end is caught up at the next one', (await interestC()) === 1800, String(await interestC()));

    section('cash accounting books nothing until paid');
    await T((c) => c.query(
      `INSERT INTO loan_products (id, name, method, monthly_rate, max_term, processing_fee, accounting_method,
         gl_portfolio, gl_interest_inc, gl_fee_inc)
       VALUES ('CA01','Cash Basis','FLAT',2.000,12,500,'CASH','100-100','400-100','400-200')`));
    const D = await T((c) => newMember(c, 'D1', 500000));
    const recBefore = await bal('100-300');
    const feeRecBefore = await bal('100-310');
    const incBefore = -(await bal('400-100'));
    const loanD = await T((c) => disbursedLoan(c, D.m.id, 'CA01', 50000, 10));
    check('a cash product books no fee receivable at disbursement', (await bal('100-310')) === feeRecBefore);
    await T((c) => L.accrueInterest(c, loanD.id, { valueDate: plus(30), createdBy: 'test' }));
    const owedD = await T(async (c) => L.balances(await L.lock(c, loanD.id)));
    check('interest is still tracked as owed on the loan', owedD.interest === 1000, String(owedD.interest));
    check('but nothing is booked to the receivable or to income',
      (await bal('100-300')) === recBefore && -(await bal('400-100')) === incBefore);
    await T((c) => L.repay(c, loanD.id, { amount: 1500, channelId: 'cash', createdBy: 'test' }));
    check('paying it recognises income then, once',
      -(await bal('400-100')) - incBefore === 1000 && (await bal('100-300')) === recBefore,
      String(-(await bal('400-100')) - incBefore));
    await assertBalanced('cash product');

    // ---------------------------------------------------------------------
    section('finding 3: eligibility is enforced at approval');
    const E = await T((c) => newMember(c, 'E1', 20000));    // 3x = 60,000 ceiling
    const big = await T((c) => L.apply(c, { memberId: E.m.id, productId: 'NL01', principal: 90000, termMonths: 12, createdBy: 'test' }));
    check('an application above the ceiling can still be recorded', big.status === 'PENDING_APPROVAL');
    await throws('but approving it is refused',
      () => T((c) => L.changeState(c, big.id, 'APPROVE', { createdBy: 'test' })),
      (e) => /LOAN_EXCEEDS_DEPOSIT_MULTIPLIER/.test(e.message));
    const view = await Rd((c) => L.checkEligibility(c, {
      memberId: E.m.id, productId: 'NL01', principal: 90000, loanId: big.id }));
    check('the eligibility view says the same thing approval will',
      view.approvable === false && view.reasons[0] === 'LOAN_EXCEEDS_DEPOSIT_MULTIPLIER' && view.ceiling === 60000,
      JSON.stringify(view.reasons));

    await T((c) => c.query(
      `INSERT INTO loan_products (id, name, method, monthly_rate, max_term, processing_fee, max_multiplier,
         require_guarantor_cover, min_cover_percent, gl_portfolio, gl_interest_inc, gl_fee_inc)
       VALUES ('GC01','Guaranteed','FLAT',1.000,24,0,5,true,100,'100-100','400-100','400-200')`));
    const covered = await T((c) => L.apply(c, { memberId: E.m.id, productId: 'GC01', principal: 50000, termMonths: 12, createdBy: 'test' }));
    await throws('a loan that needs guarantor cover is refused until it has it',
      () => T((c) => L.changeState(c, covered.id, 'APPROVE', { createdBy: 'test' })),
      (e) => /INSUFFICIENT_GUARANTOR_COVER/.test(e.message));
    const G = await T((c) => newMember(c, 'G1', 100000));
    await T((c) => L.addGuarantor(c, covered.id, { memberId: G.m.id, amount: 30000 }));
    const approved = await T((c) => L.changeState(c, covered.id, 'APPROVE', { createdBy: 'test' }));
    check('deposits 20,000 plus a 30,000 pledge cover 50,000, and it approves', approved.status === 'APPROVED');

    await T((c) => c.query("UPDATE loan_products SET enforce_deposit_multiplier = false WHERE id = 'NL01'"));
    const relaxed = await T((c) => L.changeState(c, big.id, 'APPROVE', { createdBy: 'test' }));
    check('a product that does not enforce the multiplier approves the same loan', relaxed.status === 'APPROVED');
    await T((c) => c.query("UPDATE loan_products SET enforce_deposit_multiplier = true WHERE id = 'NL01'"));

    // ---------------------------------------------------------------------
    section('allocation order comes from the product');
    await T((c) => c.query(
      `INSERT INTO loan_products (id, name, method, monthly_rate, max_term, processing_fee,
         allocation_order, gl_portfolio, gl_interest_inc, gl_fee_inc)
       VALUES ('PF01','Principal First','FLAT',1.000,12,1000, ARRAY['PRINCIPAL','INTEREST','FEE','PENALTY'],
               '100-100','400-100','400-200')`));
    const F = await T((c) => newMember(c, 'F1', 500000));
    const loanF = await T((c) => disbursedLoan(c, F.m.id, 'PF01', 60000, 12));
    await T((c) => L.accrueInterest(c, loanF.id, { valueDate: plus(30), createdBy: 'test' }));
    const partial = await T((c) => L.repay(c, loanF.id, { amount: 2000, channelId: 'cash', createdBy: 'test' }));
    check('a partial payment follows the product\'s order: principal before interest and fee',
      partial.allocation.principal === 2000 && partial.allocation.interest === 0 && partial.allocation.fees === 0,
      JSON.stringify(partial.allocation));
    await throws('the database refuses an allocation order missing a component',
      () => T((c) => c.query("UPDATE loan_products SET allocation_order = ARRAY['PRINCIPAL','INTEREST'] WHERE id = 'PF01'")),
      (e) => /allocation_complete/.test(e.message));

    // ---------------------------------------------------------------------
    section('write-off clears every receivable against the write-off expense');
    const W = await T((c) => newMember(c, 'W1', 500000));
    const loanW = await T((c) => disbursedLoan(c, W.m.id, 'NL01', 30000, 6));
    await T((c) => L.accrueInterest(c, loanW.id, { valueDate: plus(30), createdBy: 'test' }));
    const owedW = await T(async (c) => L.balances(await L.lock(c, loanW.id)));
    const portBefore = await bal('100-100');
    const intRecBefore = await bal('100-300');
    const feeRecBefore2 = await bal('100-310');
    const woBefore = await bal('500-310');
    await T((c) => L.writeOff(c, loanW.id, { createdBy: 'test' }));
    check('principal leaves the portfolio', portBefore - (await bal('100-100')) === owedW.principal);
    check('accrued interest leaves the receivable', intRecBefore - (await bal('100-300')) === owedW.interest);
    check('the fee leaves its receivable', feeRecBefore2 - (await bal('100-310')) === owedW.fees);
    check('and the whole thing lands in the write-off expense', (await bal('500-310')) - woBefore === owedW.total,
      `${(await bal('500-310')) - woBefore} vs ${owedW.total}`);
    await assertBalanced('write-off');

    // ---------------------------------------------------------------------
    section('the product API');
    const list = await call('GET', '/api/loan-products');
    check('products are listed with their accounting settings',
      list.status === 200 && list.body.some((p) => p.id === 'NL01' && p.accountingMethod === 'ACCRUAL' && p.gl.interestReceivable === '100-300'));

    const badGl = await call('POST', '/api/loan-products', {
      id: 'BAD1', name: 'Bad GL', glPortfolio: '400-100', glInterestInc: '400-100' });
    check('a portfolio account that is not an asset is refused',
      badGl.status === 400 && /gl_portfolio\) 400-100 is INCOME/.test(badGl.err?.errorSource || ''),
      `${badGl.status} ${badGl.err?.errorSource}`);
    const badEnum = await call('POST', '/api/loan-products', {
      id: 'BAD2', name: 'Bad enum', glPortfolio: '100-100', glInterestInc: '400-100', dayCount: 'ACTUAL_364' });
    check('an unknown day count is refused', badEnum.status === 400);

    const created = await call('POST', '/api/loan-products', {
      id: 'dev01', name: 'Development Loan', method: 'REDUCING', monthlyRate: 1.25, maxTerm: 48,
      processingFee: 2500, maxMultiplier: 4, dayCount: 'ACTUAL_365', requireGuarantorCover: true,
      glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200',
    });
    check('a valid product is created, id upper-cased, defaults filled',
      created.status === 201 && created.body.id === 'DEV01' && created.body.accountingMethod === 'ACCRUAL'
      && created.body.gl.interestReceivable === '100-300' && created.body.annualRate === 15,
      `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
    const dup = await call('POST', '/api/loan-products', { id: 'DEV01', name: 'x', glPortfolio: '100-100', glInterestInc: '400-100' });
    check('a duplicate id is refused', dup.status === 409);

    const patched = await call('PATCH', '/api/loan-products/DEV01', { monthlyRate: 1.5, allocationOrder: ['FEE', 'PENALTY', 'INTEREST', 'PRINCIPAL'] });
    check('a product can be changed', patched.status === 200 && patched.body.monthlyRate === 1.5
      && patched.body.allocationOrder[0] === 'FEE', `${patched.status}`);
    const audited = await Rd(async (c) => (await c.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action IN ('LOAN_PRODUCT_CREATED','LOAN_PRODUCT_CHANGED')")).rows[0].n);
    check('and both are audited', audited === 2, String(audited));

    const usesNew = await T(async (c) => {
      const { m } = await newMember(c, 'N1', 400000);
      const l = await L.apply(c, { memberId: m.id, productId: 'DEV01', principal: 100000, termMonths: 12, createdBy: 'test' });
      return l;
    });
    check('a loan on the new product copies the changed rate', Number(usesNew.monthly_rate) === 1.5, String(usesNew.monthly_rate));

    const memberOnly = await call('GET', '/api/loan-products/NL01');
    check('a product can be read by id', memberOnly.status === 200 && memberOnly.body.id === 'NL01');
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
