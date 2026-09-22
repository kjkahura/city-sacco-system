#!/usr/bin/env node
'use strict';

/**
 * Loan product types and interest calculation methods, after Mambu.
 *
 * The question this suite answers: does the interest a loan is charged
 * depend on the kind of product it is under, or only on the schedule shape?
 * A FIXED_TERM loan owes the interest on its schedule however it is paid. A
 * DYNAMIC_TERM loan owes interest on the actual balance for the actual days,
 * and its schedule is redrawn when it prepays, the way the product says.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const SCH = require('../src/domain/schedule');
const S = require('../src/domain/savings');
const acct = require('../src/domain/accounting');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'pttest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4093;
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;
const sum = (xs, f) => round(xs.reduce((s, x) => s + Number(f(x)), 0));

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
    `INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'Type',$1) RETURNING *`, [no])).rows[0];
  const sav = await S.open(c, { memberId: m.id });
  if (deposit) await S.deposit(c, sav.id, { amount: deposit, channelId: 'cash', createdBy: 'test' });
  return { m, sav };
}

async function disbursedLoan(c, memberId, productId, principal, term, on) {
  const l = await L.apply(c, { memberId, productId, principal, termMonths: term, createdBy: 'test' });
  await L.changeState(c, l.id, 'APPROVE', { createdBy: 'test' });
  await L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: on, createdBy: 'test' });
  return l;
}

const schedule = (loanId) => Rd(async (c) => (await c.query(
  'SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [loanId])).rows);
const balancesOf = (loanId) => T(async (c) => L.balances(await L.lock(c, loanId)));
const accrue = (loanId, valueDate) => T((c) => L.accrueInterest(c, loanId, { valueDate, createdBy: 'test' }));
const repay = (loanId, amount, valueDate) => T((c) => L.repay(c, loanId, { amount, channelId: 'cash', valueDate, createdBy: 'test' }));

// Products, by SQL so each section states exactly what it is testing. The
// multiplier rule is off because eligibility has its own suite.
const PRODUCT_SQL = `
  INSERT INTO loan_products (id, name, product_type, method, prepayment_recalculation, accrue_late_interest,
                             monthly_rate, max_term, processing_fee, gl_portfolio, gl_interest_inc, gl_fee_inc,
                             enforce_deposit_multiplier)
  VALUES
    ('FXR01', 'Fixed, reducing',                    'FIXED_TERM',   'REDUCING',                    'NONE',                          true,  1.000, 24, 0, '100-100', '400-100', '400-200', false),
    ('DYN01', 'Dynamic, reducing, smaller lines',   'DYNAMIC_TERM', 'REDUCING',                    'REDUCE_INSTALLMENT_AMOUNT',     true,  1.000, 24, 0, '100-100', '400-100', '400-200', false),
    ('DYN02', 'Dynamic, equal installments, fewer', 'DYNAMIC_TERM', 'REDUCING_EQUAL_INSTALLMENTS', 'REDUCE_NUMBER_OF_INSTALLMENTS', true,  1.000, 24, 0, '100-100', '400-100', '400-200', false),
    ('DYN03', 'Dynamic, no late interest',          'DYNAMIC_TERM', 'REDUCING',                    'REDUCE_INSTALLMENT_AMOUNT',     false, 1.000, 24, 0, '100-100', '400-100', '400-200', false)`;

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Product Types SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@pttest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login',
      { email: 'admin@pttest.local', password: 'a sufficiently long passphrase' })).body.accessToken;
    await T((c) => c.query(PRODUCT_SQL));

    const seeded = await Rd(async (c) => (await c.query("SELECT * FROM loan_products WHERE id = 'NL01'")).rows[0]);
    check('the seeded product became FIXED_TERM, which is how it has always behaved',
      seeded.product_type === 'FIXED_TERM' && seeded.method === 'FLAT');

    section('the arithmetic');
    check('a month after the 31st of January is the 28th of February, not the 3rd of March',
      L.addMonths('2026-01-31', 1).toISOString().slice(0, 10) === '2026-02-28'
      && L.addMonths('2026-03-31', 1).toISOString().slice(0, 10) === '2026-04-30'
      && L.addMonths('2026-01-31', 13).toISOString().slice(0, 10) === '2027-02-28');
    check('the annuity payment on 120,000 at 1% over twelve months is 10,661.85',
      L.annuityPayment(120000, 0.01, 12) === 10661.85, String(L.annuityPayment(120000, 0.01, 12)));

    const terms = { rate: 1, frequency: 'PER_MONTH', convention: 'THIRTY_360', interestType: 'SIMPLE' };
    const draw = (method) => SCH.draftSchedule({ start: '2026-01-12', count: 12, principal: 120000, terms, method });
    const flat = draw('FLAT');
    const red = draw('REDUCING');
    const eq = draw('REDUCING_EQUAL_INSTALLMENTS');
    check('flat: the same interest every period, on the original principal',
      flat.length === 12 && flat.every((x) => x.interest === 1200) && sum(flat, (x) => x.principal) === 120000);
    check('reducing: equal principal, interest falling from 1,200 to 100',
      red.length === 12 && red.every((x) => x.principal === 10000) && red[0].interest === 1200 && red[11].interest === 100
      && sum(red, (x) => x.interest) === 7800);
    const payments = eq.map((x) => round(x.principal + x.interest));
    check('equal installments: the same payment every period, principal rising as interest falls',
      eq.length === 12 && payments.slice(0, 11).every((p) => p === 10661.85)
      && eq[0].principal < eq[11].principal && eq[0].interest === 1200 && sum(eq, (x) => x.principal) === 120000,
      JSON.stringify(payments));
    check('equal installments carry more interest than reducing, because principal is repaid later',
      sum(eq, (x) => x.interest) > sum(red, (x) => x.interest), `${sum(eq, (x) => x.interest)} vs 7800`);

    section('product rules on the API');
    const flatDynamic = await call('POST', '/api/loan-products', {
      id: 'BADFD', name: 'Flat dynamic', productType: 'DYNAMIC_TERM', method: 'FLAT',
      glPortfolio: '100-100', glInterestInc: '400-100' });
    check('a dynamic product cannot charge flat interest', flatDynamic.status === 400
      && /FLAT/.test(flatDynamic.err?.errorSource || ''), `${flatDynamic.status} ${flatDynamic.err?.errorSource}`);
    const created = await call('POST', '/api/loan-products', {
      id: 'API_DYN', name: 'API dynamic', productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS',
      prepaymentRecalculation: 'REDUCE_NUMBER_OF_INSTALLMENTS', accrueLateInterest: false,
      glPortfolio: '100-100', glInterestInc: '400-100' });
    check('a dynamic product is created with its type, method and prepayment rule',
      created.status === 201 && created.body.productType === 'DYNAMIC_TERM'
      && created.body.prepaymentRecalculation === 'REDUCE_NUMBER_OF_INSTALLMENTS' && created.body.accrueLateInterest === false,
      `${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    const retype = await call('PATCH', '/api/loan-products/API_DYN', { productType: 'FIXED_TERM' });
    check('the type cannot be changed once the product exists', retype.status === 400
      && /product_type cannot be changed/.test(retype.err?.errorSource || ''), `${retype.status}`);
    const toFlat = await call('PATCH', '/api/loan-products/API_DYN', { method: 'FLAT' });
    check('nor can a dynamic product be switched to flat', toFlat.status === 400);
    const sameType = await call('PATCH', '/api/loan-products/API_DYN', { productType: 'DYNAMIC_TERM', monthlyRate: 1.2 });
    check('sending the unchanged type back is fine', sameType.status === 200 && sameType.body.monthlyRate === 1.2);
    const listed = await call('GET', '/api/loan-products');
    check('the list carries the type', listed.body.some((p) => p.id === 'DYN02' && p.productType === 'DYNAMIC_TERM'));

    // 2026-01-12 is a Monday; the first two due dates land on weekdays.
    const D0 = '2026-01-12', D1 = '2026-02-12', D2 = '2026-03-12';

    section('fixed term: interest follows the schedule, not the balance');
    const F = await T((c) => newMember(c, 'F1', 0));
    const fixed = await T((c) => disbursedLoan(c, F.m.id, 'FXR01', 120000, 12, D0));
    const fs = await schedule(fixed.id);
    check('a fixed reducing loan is drawn with declining interest', fs.length === 12 && Number(fs[0].interest_due) === 1200
      && Number(fs[1].interest_due) === 1100 && sum(fs, (x) => x.interest_due) === 7800);
    check('the loan carries its type', (await T((c) => L.lock(c, fixed.id))).product_type === 'FIXED_TERM');
    await accrue(fixed.id, D1);
    check('one month in, one month of the schedule has accrued', (await balancesOf(fixed.id)).interest === 1200);
    const fRep = await repay(fixed.id, 61200, D1);
    check('the member pays the installment plus 50,000 of principal early',
      fRep.allocation.interest === 1200 && fRep.allocation.principal === 60000, JSON.stringify(fRep.allocation));
    check('the balance is 60,000', (await balancesOf(fixed.id)).principal === 60000);
    await accrue(fixed.id, D2);
    check('but the next month still accrues 1,100, the schedule\'s figure on 110,000, not 600 on the balance',
      (await balancesOf(fixed.id)).interest === 1100, String((await balancesOf(fixed.id)).interest));
    check('and the schedule is untouched: still twelve lines', (await schedule(fixed.id)).length === 12);
    await accrue(fixed.id, '2028-01-12');
    const fAll = await balancesOf(fixed.id);
    check('left running two years, interest stops at the schedule\'s total; a fixed-term loan\'s interest is fixed',
      round(fAll.interest + 1200) === 7800, String(fAll.interest));
    await assertBalanced('fixed term');

    section('dynamic term, reduce installment amount');
    const A = await T((c) => newMember(c, 'A1', 0));
    const dyn = await T((c) => disbursedLoan(c, A.m.id, 'DYN01', 120000, 12, D0));
    await accrue(dyn.id, D1);
    check('one month in, one month has accrued on the balance', (await balancesOf(dyn.id)).interest === 1200);
    const dRep = await repay(dyn.id, 41200, D1);
    check('the member pays the installment plus 30,000 early',
      dRep.allocation.interest === 1200 && dRep.allocation.principal === 40000
      && dRep.allocation.rescheduled?.recalculation === 'REDUCE_INSTALLMENT_AMOUNT', JSON.stringify(dRep.allocation));
    const ds = await schedule(dyn.id);
    check('installment one is paid', ds[0].status === 'PAID' && Number(ds[0].principal_due) === 10000);
    check('the other eleven are redrawn over the 80,000 that remains: same count, smaller lines',
      ds.length === 12 && ds.slice(1).every((x) => Math.abs(Number(x.principal_due) - 7272.73) < 0.05)
      && sum(ds.slice(1), (x) => x.principal_due) === 80000,
      ds.slice(1).map((x) => x.principal_due).join(','));
    check('the next line\'s interest is 1% of 80,000, the new balance', Number(ds[1].interest_due) === 800, String(ds[1].interest_due));
    check('the due dates did not move', ds[1].due_date.toISOString().slice(0, 10) === D2);
    await accrue(dyn.id, D2);
    check('and a month later 800 has accrued, against the fixed loan\'s 1,100',
      (await balancesOf(dyn.id)).interest === 800, String((await balancesOf(dyn.id)).interest));
    const flag = await Rd(async (c) => (await c.query(
      'SELECT reschedule_count, rescheduled_at FROM loan_accounts WHERE id = $1', [dyn.id])).rows[0]);
    check('the loan says it was rescheduled once', flag.reschedule_count === 1 && flag.rescheduled_at !== null);
    await assertBalanced('dynamic prepayment');

    section('reversing the prepayment puts the schedule back');
    await T((c) => L.reverseTransaction(c, dRep.reference, { createdBy: 'test' }));
    const rs = await schedule(dyn.id);
    check('twelve lines of 10,000 again, none paid',
      rs.length === 12 && rs.every((x) => Number(x.principal_due) === 10000 && x.status !== 'PAID'),
      rs.map((x) => `${x.principal_due}/${x.status}`).join(','));
    check('the balance is 120,000 again', (await balancesOf(dyn.id)).principal === 120000);
    await assertBalanced('reversal');

    section('dynamic term, reduce number of installments, equal installments');
    const B = await T((c) => newMember(c, 'B1', 0));
    const eqLoan = await T((c) => disbursedLoan(c, B.m.id, 'DYN02', 120000, 12, D0));
    const es0 = await schedule(eqLoan.id);
    check('drawn as twelve equal payments of 10,661.85',
      es0.length === 12 && es0.slice(0, 11).every((x) => round(Number(x.principal_due) + Number(x.interest_due)) === 10661.85));
    await accrue(eqLoan.id, D1);
    const eRep = await repay(eqLoan.id, 41200, D1);
    check('installment one and 30,538.15 of prepayment',
      eRep.allocation.principal === 40000 && eRep.allocation.rescheduled?.recalculation === 'REDUCE_NUMBER_OF_INSTALLMENTS',
      JSON.stringify(eRep.allocation));
    const es = await schedule(eqLoan.id);
    check('the payment stays 10,661.85 and the loan ends early: nine lines instead of twelve',
      es.length === 9 && es[0].status === 'PAID' && eRep.allocation.rescheduled.dropped === 3
      && es.slice(1, 8).every((x) => round(Number(x.principal_due) + Number(x.interest_due)) === 10661.85),
      `${es.length} lines; payments ${es.map((x) => round(Number(x.principal_due) + Number(x.interest_due))).join(',')}`);
    check('the redrawn lines still sum to the 80,000 outstanding', sum(es.slice(1), (x) => x.principal_due) === 80000);
    check('the last line is the smaller remainder', Number(es[8].principal_due) + Number(es[8].interest_due) < 10661.85);
    await assertBalanced('reduce number of installments');

    section('paying a dynamic loan off closes it and clears the schedule');
    const B2 = await T((c) => newMember(c, 'B2', 0));
    const off = await T((c) => disbursedLoan(c, B2.m.id, 'DYN01', 50000, 6, D0));
    await accrue(off.id, '2026-01-27');
    const owed = await balancesOf(off.id);
    check('fifteen days of interest is owed', owed.interest === 250, String(owed.interest));
    await repay(off.id, owed.total, '2026-01-27');
    const offStatus = await Rd(async (c) => (await c.query('SELECT status FROM loan_accounts WHERE id = $1', [off.id])).rows[0].status);
    check('the loan is closed as repaid', offStatus === 'CLOSED_REPAID', offStatus);
    check('and no unpaid lines are left on the schedule', (await schedule(off.id)).every((x) => x.status === 'PAID')
      && (await schedule(off.id)).length === 0);
    await assertBalanced('payoff');

    section('late interest');
    const C = await T((c) => newMember(c, 'C1', 0));
    const stops = await T((c) => disbursedLoan(c, C.m.id, 'DYN03', 120000, 2, D0));
    const keeps = await T((c) => disbursedLoan(c, C.m.id, 'DYN01', 120000, 2, D0));
    await accrue(stops.id, '2026-06-30');
    await accrue(keeps.id, '2026-06-30');
    check('a product that does not accrue late interest stops at maturity: two months, 2,400',
      (await balancesOf(stops.id)).interest === 2400, String((await balancesOf(stops.id)).interest));
    check('one that does keeps going: five and a half months',
      (await balancesOf(keeps.id)).interest === 6720, String((await balancesOf(keeps.id)).interest));
    const again = await accrue(stops.id, '2026-07-31');
    check('and nothing more is booked on the stopped one', again === null && (await balancesOf(stops.id)).interest === 2400);
    await assertBalanced('late interest');
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
