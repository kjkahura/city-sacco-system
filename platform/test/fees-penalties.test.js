#!/usr/bin/env node
'use strict';

/**
 * Fees, penalties and arrears, after Mambu's "Configure fees, penalties,
 * and arrears": penalties accrued from the first late day and applied after
 * the tolerance, catching up missed days, leaving out non-working days,
 * held on a locked loan, their rate period and changing it, recalculation
 * after a backdated repayment; the arrears tolerance band, settings frozen
 * at approval, days late and days in arrears; where a manual fee goes, fees
 * outside the schedule and the custom repayment that pays them, planned
 * fees, fee amortisation, and the smaller fee rules.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const P = require('../src/domain/penalties');
const W = require('../src/domain/workflow');
const R = require('../src/domain/restructure');
const PF = require('../src/domain/plannedFees');
const FA = require('../src/domain/feeAmortization');
const WO = require('../src/domain/writeOffs');
const S = require('../src/domain/schedule');
const acct = require('../src/domain/accounting');
const eod = require('../src/ops/eod');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
async function throws(label, fn, test) {
  try { await fn(); check(label, false, 'did not throw'); } catch (e) { check(label, test(e), e.message); }
}

const SLUG = 'feepentest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4100;
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
const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200', glInterestRec: '100-300' };
const BASE = { ...GL, accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', enforceDepositMultiplier: false, maxTerm: 36,
  monthlyRate: 1, productType: 'FIXED_TERM', method: 'REDUCING', nonWorkingDays: 'DO_NOT_RESCHEDULE', glPenaltyInc: '400-200' };
const mk = (id, body = {}) => call('POST', '/api/loan-products', { id, name: id, ...BASE, ...body });
const fee = (pid, body) => call('POST', `/api/loan-products/${pid}/fees`, body);
const sched = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id])).rows);
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
const glFor = (code, memberId) => Rd(async (c) => Number((await c.query(
  `SELECT COALESCE(sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS b
   FROM journal_lines WHERE gl_code = $1 AND member_id = $2`, [code, memberId])).rows[0].b));
let seq = 0;
const member = () => T(async (c) => {
  seq += 1;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'F',$1) RETURNING *`, [`F${String(seq).padStart(4, '0')}`])).rows[0];
  await c.query("INSERT INTO savings_accounts (account_no, member_id, product_id) VALUES ($1, $2, 'SAV01')", [`SF${seq}`, m.id]);
  return m;
});
const applied = async (productId, principal, term, extra = {}) => {
  const m = await member();
  return T((c) => L.apply(c, { memberId: m.id, productId, principal, termMonths: term, createdBy: 'officer', ...extra }));
};
const approve = (id) => T((c) => L.changeState(c, id, 'APPROVE', { createdBy: 'manager' }));
const disburse = (id, amount, on, extra = {}) => T((c) => L.disburse(c, id, { amount, channelId: 'bank', valueDate: on, createdBy: 'teller', ...extra }));
const disbursed = async (productId, principal, term, on, extra = {}) => {
  const l = await applied(productId, principal, term, extra);
  await approve(l.id);
  await disburse(l.id, principal, on);
  return l;
};
const accrue = (id, on) => T((c) => L.accrueInterest(c, id, { valueDate: on, createdBy: 'eod' }));
const arrears = (on) => T((c) => L.markArrears(c, { asOf: on }));
const penalise = (id, on) => T((c) => P.accrueForLoan(c, id, { asOf: on }));
const repay = (id, amount, on, extra = {}) => call('POST', `/api/loans/${id}/repayments`, { amount, channelId: 'cash', valueDate: on, ...extra });

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Fee SACCO', mfaRequiredRoles: [], adminEmail: 'admin@feepentest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@feepentest.local', password: PASSWORD })).body.accessToken;
    await T((c) => c.query('UPDATE lending_controls SET write_off_requires_approval = false WHERE id = 1'));
    const made = await Promise.all([
      mk('PEN', { penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 0.1, penaltyRateMin: 0.05, penaltyRateMax: 0.5, penaltyToleranceDays: 5 }),
      mk('PENTOL', { penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 0.1, penaltyToleranceDays: 2, arrearsToleranceDays: 10 }),
      mk('PENNWD', { penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 0.1, arrearsNonWorkingDays: 'EXCLUDE' }),
      mk('PENOUT', { penaltyBasis: 'OUTSTANDING_PRINCIPAL', penaltyRate: 36.5, rateFrequency: 'PER_YEAR', monthlyRate: 12, dayCount: 'ACTUAL_365' }),
      mk('BAND', { arrearsToleranceDays: 3, arrearsToleranceDaysMin: 1, arrearsToleranceDaysMax: 5, penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 0.1 }),
      mk('FEES', { allowArbitraryFees: true }),
      mk('CAPF'),
      mk('TRF', { productType: 'TRANCHED', maxTranches: 2 }),
      mk('PLAN', { allowArbitraryFees: true }),
      mk('AMS'), mk('AMY'), mk('AME'), mk('AMD'), mk('AMM'), mk('AMR'),
      mk('CASHP', { accountingMethod: 'CASH', interestAccruedAccounting: 'NONE', glInterestRec: undefined }),
    ]);
    check('products', made.every((r) => r.status === 201), made.map((r) => `${r.status} ${r.source}`).join('|'));

    // ----------------------------------------------------------------------
    section('penalties accrue from the first late day and are applied after the tolerance');
    // 3,000 over three months from 1 January: 1,000 principal due 1 February.
    const pl = await disbursed('PEN', 3000, 3, '2026-01-01');
    await accrue(pl.id, '2026-02-01');
    await arrears('2026-02-04');
    let ch = await penalise(pl.id, '2026-02-04');
    check('three days late, inside the five days of tolerance: nothing applied', ch.length === 0);
    check('but the three days are accrued and shown on the loan', Number((await loanRow(pl.id)).penalty_unapplied) === 3, String((await loanRow(pl.id)).penalty_unapplied));
    ch = await penalise(pl.id, '2026-02-07');
    check('six days late: one charge for all six days since the due date (0.1% of 1,000 a day)',
      ch.length === 1 && Number(ch[0].amount) === 6 && ch[0].days_charged === 6 && S.ymd(ch[0].period_from) === '2026-02-01',
      JSON.stringify(ch.map((x) => [x.amount, x.days_charged])));
    check('and nothing is left unapplied', Number((await loanRow(pl.id)).penalty_unapplied) === 0);
    ch = await penalise(pl.id, '2026-02-10');
    check('a run three days later catches up the two days the end of day missed', ch.length === 1 && Number(ch[0].amount) === 3 && ch[0].days_charged === 3,
      JSON.stringify(ch.map((x) => [x.amount, x.days_charged])));
    check('a second run on the same day charges nothing', (await penalise(pl.id, '2026-02-10')).length === 0);
    check('penalty owed 9', Number((await loanRow(pl.id)).penalty_accrued) === 9);

    const pt = await disbursed('PENTOL', 3000, 3, '2026-01-01');
    await arrears('2026-02-06');
    check('the longer of the penalty and arrears tolerances holds: five days late under ten days of arrears tolerance',
      (await penalise(pt.id, '2026-02-06')).length === 0);
    await arrears('2026-02-12');
    ch = await penalise(pt.id, '2026-02-12');
    check('eleven days late: all eleven days charged', ch.length === 1 && ch[0].days_charged === 11 && Number(ch[0].amount) === 11);

    const nw = await disbursed('PENNWD', 3000, 3, '2026-01-02');
    // Due Monday 2 February; on Monday 9 February, seven days late of which five working days.
    await arrears('2026-02-09');
    ch = await penalise(nw.id, '2026-02-09');
    check('non-working days excluded: the weekend is neither counted nor charged', ch.length === 1 && ch[0].days_charged === 5 && Number(ch[0].amount) === 5,
      JSON.stringify(ch.map((x) => [x.amount, x.days_charged])));

    const po = await disbursed('PENOUT', 3000, 3, '2026-01-01');
    await arrears('2026-02-11');
    ch = await penalise(po.id, '2026-02-11');
    check('on outstanding principal the rate is per the interest rate period: 36.5% a year on 3,000 over 365 days is 3 a day',
      ch.length === 1 && Number(ch[0].amount) === round(3 * ch[0].days_charged), JSON.stringify(ch.map((x) => [x.amount, x.days_charged])));

    section('a locked loan keeps accruing and is charged when unlocked');
    const lk = await disbursed('PEN', 3000, 3, '2026-01-01');
    await accrue(lk.id, '2026-02-01');
    await arrears('2026-02-07');
    await penalise(lk.id, '2026-02-07');
    await T((c) => W.transition(c, lk.id, 'LOCK', { createdBy: 'manager' }));
    check('locked: nothing applied', (await penalise(lk.id, '2026-02-12')).length === 0);
    check('but accrued', Number((await loanRow(lk.id)).penalty_unapplied) === 5, String((await loanRow(lk.id)).penalty_unapplied));
    await T((c) => W.transition(c, lk.id, 'UNLOCK', { createdBy: 'manager' }));
    ch = await penalise(lk.id, '2026-02-13');
    check('unlocked: the next run charges every day since the last charge', ch.length === 1 && ch[0].days_charged === 6 && Number(ch[0].amount) === 6,
      JSON.stringify(ch.map((x) => [x.amount, x.days_charged])));

    section('the penalty rate of a running loan');
    let r = await call('POST', `/api/loans/${pl.id}/penalty-rate`, { rate: 0.2, note: 'agreed' });
    check('can change within the product band', r.status === 200 && Number(r.body.to_rate) === 0.2 && Number(r.body.from_rate) === 0.1, `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${pl.id}/penalty-rate`, { rate: 1 });
    check('not beyond it', r.status === 400 && /PENALTY_RATE_ABOVE_PRODUCT_MAXIMUM/.test(r.reason), r.reason);
    check('and every change is kept', (await call('GET', `/api/loans/${pl.id}/penalty-rate-changes`)).body.length === 1);
    ch = await penalise(pl.id, '2026-02-11');
    check('what accrues from here is at the new rate', ch.length === 1 && Number(ch[0].amount) === 2, JSON.stringify(ch.map((x) => x.amount)));
    await call('POST', `/api/loans/${pl.id}/penalty-rate`, { rate: 0.1 });

    section('a backdated repayment recalculates the penalties after its date');
    // Penalties charged: 6 (to 7 Feb), 3 (to 10 Feb), 2 (to 11 Feb). Paid on 7 Feb, the last two were never owed.
    r = await repay(pl.id, 1036, '2026-02-07');
    const bd = await loanRow(pl.id);
    const reversedCh = (await Rd((c) => c.query('SELECT * FROM penalty_charges WHERE loan_id = $1 AND reversed_at IS NOT NULL', [pl.id]))).rows;
    check('the charges after its date are taken back and it pays the six days owed then',
      r.status === 201 && reversedCh.length === 2 && r.body.allocation.penalty === 6 && Number(bd.penalty_accrued) === 6, `${r.status} ${r.reason} ${reversedCh.length} ${JSON.stringify(r.body?.allocation)} ${bd.penalty_accrued}`);
    check('the installment is paid, so nothing is charged again after it', (await sched(pl.id))[0].status === 'PAID' && Number(bd.penalty_accrued) === 6);
    check('the penalty receivable is clear', await glFor('100-320', bd.member_id) === 0, String(await glFor('100-320', bd.member_id)));
    const rv = await call('POST', `/api/loans/transactions/${r.body.reference}/reversal`, { narration: 'cheque bounced' });
    await arrears('2026-02-10');
    ch = await penalise(pl.id, '2026-02-10');
    check('reversing it: the late days since its date are charged again at the next run', rv.status === 201 && ch.length === 1 && ch[0].days_charged === 3,
      `${rv.status} ${rv.reason} ${JSON.stringify(ch.map((x) => [x.amount, x.days_charged]))}`);

    // ----------------------------------------------------------------------
    section('arrears settings');
    await throws('a loan\'s arrears tolerance must sit in the product band',
      () => applied('BAND', 1000, 3, { arrearsToleranceDays: 6 }), (e) => /ARREARS_TOLERANCE_DAYS_ABOVE_PRODUCT_MAXIMUM/.test(e.message));
    const inBand = await applied('BAND', 1000, 3, { arrearsToleranceDays: 4 });
    check('within it, accepted', Number(inBand.arrears_tolerance_days) === 4);
    check('a product default outside its own band is refused',
      (await mk('BADBAND', { arrearsToleranceDays: 9, arrearsToleranceDaysMin: 1, arrearsToleranceDaysMax: 5 })).status === 400);
    const frozenLoan = await applied('BAND', 1000, 3);
    const pendingLoan = await applied('BAND', 1000, 3);
    await approve(frozenLoan.id);
    const fl = await loanRow(frozenLoan.id);
    check('approval writes the penalty rate and tolerances onto the loan and keeps the penalty settings',
      Number(fl.penalty_rate) === 0.1 && Number(fl.arrears_tolerance_days) === 3 && fl.settings_snapshot?.penalty_basis === 'OVERDUE_PRINCIPAL', JSON.stringify(fl.settings_snapshot));
    await call('PATCH', '/api/loan-products/BAND', { penaltyRate: 0.3, penaltyBasis: 'OVERDUE_ALL', arrearsToleranceDays: 4 });
    const eff = async (id) => T(async (c) => { const x = await L.lock(c, id); return { ...L.effective(x), basis: x.penalty_basis }; });
    const ef1 = await eff(frozenLoan.id);
    const ef2 = await eff(pendingLoan.id);
    check('a product change does not reach an approved loan', ef1.penaltyRate === 0.1 && ef1.basis === 'OVERDUE_PRINCIPAL' && ef1.arrearsToleranceDays === 3, JSON.stringify(ef1));
    check('it reaches a pending one', ef2.penaltyRate === 0.3 && ef2.basis === 'OVERDUE_ALL' && ef2.arrearsToleranceDays === 4, JSON.stringify(ef2));
    await T((c) => L.changeState(c, frozenLoan.id, 'UNDO_APPROVE', { createdBy: 'manager' }));
    const ef3 = await eff(frozenLoan.id);
    check('undoing the approval lets the product reach it again', ef3.penaltyRate === 0.3 && ef3.basis === 'OVERDUE_ALL' && (await loanRow(frozenLoan.id)).settings_snapshot === null, JSON.stringify(ef3));
    const dl = await disbursed('BAND', 3000, 3, '2026-01-01', { arrearsToleranceDays: 2 });
    await arrears('2026-03-01');
    const shown = (await call('GET', `/api/loans/${dl.id}?asOf=2026-03-01`)).body;
    check('days late and days in arrears: 28 days late with two days of tolerance is 26 days in arrears',
      shown.days_late === 28 && shown.days_in_arrears === 26, `${shown.days_late} ${shown.days_in_arrears}`);

    // ----------------------------------------------------------------------
    section('fees: codes, where a manual fee goes, fees outside the schedule');
    let f1 = await fee('FEES', { name: 'Bounced cheque', feeType: 'MANUAL', calculation: 'FLAT', amount: 50 });
    const f2 = await fee('FEES', { name: 'Bounced cheque', feeType: 'MANUAL', calculation: 'FLAT', amount: 60 });
    check('a fee without a code is given one from its name, unique on the product',
      f1.status === 201 && f1.body.code === 'BOUNCED_CHEQUE' && f2.status === 201 && f2.body.code !== 'BOUNCED_CHEQUE' && /^BOUNCED/.test(f2.body.code),
      `${f1.body?.code} ${f2.body?.code} ${f1.source}`);
    check('a fee kept off the schedule must be manual',
      (await fee('FEES', { code: 'BADNS', name: 'x', feeType: 'PAYMENT_DUE', calculation: 'FLAT', amount: 5, allocation: 'NO_ALLOCATION' })).status === 400);
    const fl1 = await disbursed('FEES', 3000, 3, '2026-01-01');
    r = await call('POST', `/api/loans/${fl1.id}/fees`, { fee: 'BOUNCED_CHEQUE', valueDate: '2026-01-10' });
    const s1 = await sched(fl1.id);
    check('a manual fee goes on the next installment', r.status === 201 && Number(s1[0].fee_due) === 50 && r.body.installment_id === s1[0].id, `${r.status} ${r.reason} ${s1[0].fee_due}`);
    r = await call('POST', `/api/loans/${fl1.id}/fees`, { name: 'Legal letter', amount: 40, allocation: 'NO_ALLOCATION', valueDate: '2026-01-10' });
    let fr = await loanRow(fl1.id);
    check('a fee with no allocation goes into a balance of its own, outside the fees due',
      r.status === 201 && Number(fr.ns_fees_due) === 40 && Number(fr.fees_due) === 50 && r.body.non_scheduled === true, `${fr.ns_fees_due} ${fr.fees_due}`);
    const bal = (await call('GET', `/api/loans/${fl1.id}`)).body.balances;
    check('it counts in the loan\'s total balance', bal.nonScheduledFees === 40 && bal.total === round(3000 + 50 + 40), JSON.stringify(bal));
    await accrue(fl1.id, '2026-02-01');
    r = await repay(fl1.id, 1080, '2026-02-01');
    check('an ordinary repayment does not pay it', r.status === 201 && !r.body.allocation.nonScheduledFees && r.body.allocation.fees === 50, JSON.stringify(r.body?.allocation));
    r = await repay(fl1.id, 50, '2026-02-01', { customAllocation: { nonScheduledFee: 50 } });
    check('a custom repayment may not pay more than is owed on an item', r.status === 400 && /EXCEEDS_WHAT_IS_OWED/.test(r.reason), r.reason);
    r = await repay(fl1.id, 50, '2026-02-01', { customAllocation: { nonScheduledFee: 40 } });
    check('and must add up to the payment', r.status === 400 && /MUST_ADD_UP/.test(r.reason), r.reason);
    r = await repay(fl1.id, 45, '2026-02-01', { customAllocation: { nonScheduledFee: 40, principal: 5 } });
    fr = await loanRow(fl1.id);
    check('a custom repayment pays it, and the teller\'s split stands',
      r.status === 201 && r.body.allocation.nonScheduledFees === 40 && r.body.allocation.principal === 5 && Number(fr.ns_fees_paid) === 40, `${r.status} ${r.reason} ${JSON.stringify(r.body?.allocation)}`);
    check('the fee receivable is clear', await glFor('100-310', fr.member_id) === 0, String(await glFor('100-310', fr.member_id)));

    section('the base of a percentage fee, tranches, payment-due fees');
    await fee('CAPF', { code: 'CAP10', name: 'Capitalised', feeType: 'DISBURSEMENT_CAPITALIZED', calculation: 'PERCENT_OF_AMOUNT', percent: 10 });
    await fee('CAPF', { code: 'MAN10', name: 'Manual 10%', feeType: 'MANUAL', calculation: 'PERCENT_OF_AMOUNT', percent: 10 });
    const cf = await disbursed('CAPF', 1000, 3, '2026-01-01');
    r = await call('POST', `/api/loans/${cf.id}/fees`, { fee: 'MAN10', valueDate: '2026-01-05' });
    check('a % of disbursed amount fee after disbursement is on the loan amount plus the capitalised fee: 10% of 1,100',
      r.status === 201 && Number(r.body.amount) === 110, `${r.status} ${r.reason} ${r.body?.amount}`);
    await fee('TRF', { code: 'DED', name: 'Deducted', feeType: 'DISBURSEMENT_DEDUCTED', calculation: 'FLAT', amount: 10 });
    check('payment due fees are refused on a tranched product',
      (await fee('TRF', { code: 'PD', name: 'x', feeType: 'PAYMENT_DUE', calculation: 'FLAT', amount: 5 })).status === 400);
    const tr = await applied('TRF', 2000, 6, { tranches: [{ amount: 1000, expectedOn: '2026-01-01' }, { amount: 1000, expectedOn: '2026-02-01' }] });
    await approve(tr.id);
    const t1 = await disburse(tr.id, undefined, '2026-01-01');
    const t2 = await disburse(tr.id, undefined, '2026-02-01');
    check('a required disbursement fee is charged on the first tranche and not again unless chosen',
      t1.allocation.deducted === 10 && t2.allocation.deducted === 0, `${t1.allocation.deducted} ${t2.allocation.deducted}`);

    // ----------------------------------------------------------------------
    section('planned fees');
    await fee('PLAN', { code: 'VISIT', name: 'Field visit', feeType: 'MANUAL', calculation: 'FLAT', amount: 25 });
    const pa = await applied('PLAN', 3000, 3);
    r = await call('POST', `/api/loans/${pa.id}/planned-fees`, { installment: 3, fee: 'VISIT' });
    check('a fee can be planned on an application, by installment number', r.status === 201 && Number(r.body.amount) === 25, `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${pa.id}/planned-fees`, { installment: 9, fee: 'VISIT' });
    check('not beyond the term', r.status === 404, `${r.status} ${r.reason}`);
    await approve(pa.id);
    await disburse(pa.id, 3000, '2026-01-01');
    const p2 = await call('POST', `/api/loans/${pa.id}/planned-fees`, { installment: 2, name: 'Insurance top-up', amount: 15 });
    const p1 = await call('POST', `/api/loans/${pa.id}/planned-fees`, { installment: 1, fee: 'VISIT' });
    let ss = (await call('GET', `/api/loans/${pa.id}/schedule`)).body;
    check('the schedule shows planned fees before they apply', Number(ss[1].planned_fees) === 15 && Number(ss[2].planned_fees) === 25 && Number(ss[1].fee_due) === 0,
      ss.map((x) => x.planned_fees).join(','));
    r = await call('PATCH', `/api/loans/planned-fees/${p2.body.id}`, { amount: 20 });
    check('a planned fee can be changed until it applies', r.status === 200 && Number(r.body.amount) === 20);
    const extra = await call('POST', `/api/loans/${pa.id}/planned-fees`, { installment: 3, name: 'Mistake', amount: 5 });
    check('or deleted', (await call('DELETE', `/api/loans/planned-fees/${extra.body.id}`)).body?.status === 'DELETED');
    await accrue(pa.id, '2026-02-01');
    await repay(pa.id, 1030, '2026-02-01');
    check('(installment 1 paid on its due date)', (await sched(pa.id))[0].status === 'PAID');
    let out = await T((c) => PF.applyDue(c, { asOf: '2026-02-01' }));
    let listP = (await call('GET', `/api/loans/${pa.id}/planned-fees`)).body;
    check('on the due date a planned fee on an installment already paid is skipped', out.skipped === 1 && listP.find((x) => x.id === p1.body.id).status === 'SKIPPED', JSON.stringify(out));
    out = await T((c) => PF.applyDue(c, { asOf: '2026-03-01' }));
    listP = (await call('GET', `/api/loans/${pa.id}/planned-fees`)).body;
    ss = await sched(pa.id);
    check('and one on an unpaid installment applies to it on its due date', out.applied === 1 && Number(ss[1].fee_due) === 20
      && listP.find((x) => x.id === p2.body.id).status === 'APPLIED', `${JSON.stringify(out)} ${ss[1].fee_due}`);
    r = await call('POST', `/api/loans/${pa.id}/planned-fees/apply`, { applyOn: '2026-01-01' });
    check('apply on a date in the past is refused', r.status === 400 && /APPLY_ON_MUST_BE_AFTER_TODAY/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${pa.id}/planned-fees/apply`, {});
    ss = await sched(pa.id);
    check('a planned fee can be applied early', r.status === 200 && r.body.length === 1 && r.body[0].status === 'APPLIED' && Number(ss[2].fee_due) === 25, `${r.status} ${r.reason}`);
    check('the end of day applies planned fees before it marks arrears',
      eod.DEFAULT_JOBS.indexOf('applyPlannedFees') > -1 && eod.DEFAULT_JOBS.indexOf('applyPlannedFees') < eod.DEFAULT_JOBS.indexOf('markArrears'));

    // ----------------------------------------------------------------------
    section('fee amortisation');
    check('sum-of-years digits is for deducted fees',
      (await fee('AMS', { code: 'X', name: 'x', feeType: 'MANUAL', calculation: 'FLAT', amount: 5, amortizationProfile: 'SUM_OF_YEARS_DIGITS' })).status === 400);
    check('amortisation needs accrual accounting',
      (await fee('CASHP', { code: 'X', name: 'x', feeType: 'DISBURSEMENT_DEDUCTED', calculation: 'FLAT', amount: 5, amortizationProfile: 'STRAIGHT_LINE' })).status === 400);
    f1 = await fee('AMS', { code: 'ARR', name: 'Arrangement', feeType: 'DISBURSEMENT_DEDUCTED', calculation: 'FLAT', amount: 600, amortizationProfile: 'STRAIGHT_LINE' });
    check('a straight-line deducted fee', f1.status === 201 && f1.body.amortizationProfile === 'STRAIGHT_LINE', f1.source);
    const am = await disbursed('AMS', 12000, 12, '2026-01-01');
    const mAm = (await loanRow(am.id)).member_id;
    let plan = (await call('GET', `/api/loans/${am.id}/fee-amortization`)).body;
    check('its income waits in deferred fee income, planned in twelve equal shares on the due dates',
      await glFor('200-350', mAm) === 600 && plan.length === 12 && plan.every((x) => Number(x.amount) === 50), `${await glFor('200-350', mAm)} ${plan.length}`);
    check('and not in fee income yet', await glFor('400-200', mAm) === 0);
    out = await T((c) => FA.run(c, { asOf: '2026-02-01' }));
    check('on the first due date the first share is recognised', out.recognised === 50 && await glFor('200-350', mAm) === 550 && await glFor('400-200', mAm) === 50,
      `${JSON.stringify(out)} ${await glFor('200-350', mAm)}`);
    await accrue(am.id, '2026-02-10');
    const payoff = await repay(am.id, 20000, '2026-02-10');
    const cam = await loanRow(am.id);
    check('paying the loan off recognises what was still deferred', cam.status === 'CLOSED_REPAID' && await glFor('200-350', mAm) === 0 && await glFor('400-200', mAm) === 600,
      `${cam.status} ${await glFor('200-350', mAm)}`);
    await call('POST', `/api/loans/transactions/${payoff.body.reference}/reversal`, { narration: 'error' });
    check('reversing the payoff puts it back into deferred fee income', await glFor('200-350', mAm) === 550 && (await loanRow(am.id)).status === 'ACTIVE',
      `${await glFor('200-350', mAm)} ${(await loanRow(am.id)).status}`);

    await fee('AMY', { code: 'SYD', name: 'SYD fee', feeType: 'DISBURSEMENT_DEDUCTED', calculation: 'FLAT', amount: 780, amortizationProfile: 'SUM_OF_YEARS_DIGITS' });
    const ay = await disbursed('AMY', 12000, 12, '2026-01-01');
    plan = (await call('GET', `/api/loans/${ay.id}/fee-amortization`)).body;
    check('sum-of-years digits: 12/78 of 780 first, 1/78 last', Number(plan[0].amount) === 120 && Number(plan[11].amount) === 10, plan.map((x) => x.amount).join(','));

    await fee('AME', { code: 'EIR', name: 'EIR fee', feeType: 'DISBURSEMENT_DEDUCTED', calculation: 'FLAT', amount: 300, amortizationProfile: 'EFFECTIVE_INTEREST_RATE' });
    const ae = await disbursed('AME', 12000, 12, '2026-01-01');
    plan = (await call('GET', `/api/loans/${ae.id}/fee-amortization`)).body;
    const eirTotal = round(plan.reduce((a, x) => a + Number(x.amount), 0));
    check('effective interest rate: the shares come to the fee and fall as the balance falls',
      plan.length === 12 && eirTotal === 300 && Number(plan[0].amount) > Number(plan[11].amount), plan.map((x) => x.amount).join(','));

    await fee('AMD', { code: 'DLY', name: 'Daily', feeType: 'DISBURSEMENT_CAPITALIZED', calculation: 'FLAT', amount: 310, amortizationProfile: 'STRAIGHT_LINE',
      amortizationFrequency: 'INSTALLMENT_DUE_DATES_DAILY' });
    const ad = await disbursed('AMD', 3100, 1, '2026-01-01');
    await T((c) => FA.run(c, { asOf: '2026-01-16' }));
    check('daily booking: fifteen of the thirty-one days of the period recognised', await glFor('400-200', (await loanRow(ad.id)).member_id) === 150,
      String(await glFor('400-200', (await loanRow(ad.id)).member_id)));

    await fee('AMM', { code: 'SVC', name: 'Service', feeType: 'MANUAL', calculation: 'FLAT', amount: 90, amortizationProfile: 'STRAIGHT_LINE',
      amortizationFrequency: 'CUSTOM_INTERVAL', amortizationIntervalCount: 1, amortizationIntervalUnit: 'MONTHS', amortizationIntervals: 3 });
    const amm = await disbursed('AMM', 3000, 6, '2026-01-01');
    r = await call('POST', `/api/loans/${amm.id}/fees`, { fee: 'SVC', valueDate: '2026-01-10' });
    plan = (await call('GET', `/api/loans/${amm.id}/fee-amortization`)).body;
    check('a manual fee over a custom interval: three monthly shares from the day it is applied',
      plan.length === 3 && plan.every((x) => Number(x.amount) === 30) && S.ymd(plan[0].period_start) === '2026-01-10' && S.ymd(plan[2].period_end) === '2026-04-10',
      JSON.stringify(plan.map((x) => [x.amount, S.ymd(x.period_start), S.ymd(x.period_end)])));
    const mAmm = (await loanRow(amm.id)).member_id;
    await T((c) => FA.run(c, { asOf: '2026-02-10' }));
    await call('POST', `/api/loans/fees/${r.body.id}/waive`, { reason: 'goodwill' });
    check('waiving it after a share was recognised clears both deferred and fee income',
      await glFor('200-350', mAmm) === 0 && await glFor('400-200', mAmm) === 0 && await glFor('100-310', mAmm) === 0,
      `${await glFor('200-350', mAmm)} ${await glFor('400-200', mAmm)} ${await glFor('100-310', mAmm)}`);

    await fee('AMR', { code: 'CONT', name: 'Continues', feeType: 'DISBURSEMENT_DEDUCTED', calculation: 'FLAT', amount: 120, amortizationProfile: 'STRAIGHT_LINE',
      amortizationOnReschedule: 'CONTINUE_ON_NEW' });
    const ar1 = await disbursed('AMR', 1200, 12, '2026-01-01');
    await throws('amortisation that continues on the new loan needs the same product',
      () => T((c) => R.restructure(c, ar1.id, { kind: 'RESCHEDULE', productId: 'AMS', termMonths: 12, arrears: 'CAPITALIZE', valueDate: '2026-01-15', createdBy: 'manager' })),
      (e) => /FEE_AMORTIZATION_CONTINUES_ONLY_ON_THE_SAME_PRODUCT/.test(e.message));
    const rs = await T((c) => R.restructure(c, ar1.id, { kind: 'RESCHEDULE', termMonths: 12, arrears: 'CAPITALIZE', valueDate: '2026-01-15', createdBy: 'manager' }));
    const moved = (await Rd((c) => c.query("SELECT count(*)::int AS n FROM loan_fee_amortization WHERE loan_id = $1 AND status = 'OPEN'", [rs.newLoan.id]))).rows[0].n;
    check('under the same product the plan carries on on the new loan', moved === 12, String(moved));

    const aw = await disbursed('AMS', 12000, 12, '2026-01-01');
    await T((c) => WO.writeOff(c, aw.id, { narration: 'test', createdBy: 'manager', valueDate: '2026-01-20' }));
    check('a write-off recognises the fee income still deferred', await glFor('200-350', (await loanRow(aw.id)).member_id) === 0);
    const au = await disbursed('AMS', 12000, 12, '2026-01-01');
    await T((c) => FA.run(c, { asOf: '2026-02-01' }));
    const disbTx = (await Rd((c) => c.query("SELECT reference FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_DISBURSEMENT'", [au.id]))).rows[0];
    await call('POST', `/api/loans/transactions/${disbTx.reference}/reversal`, { narration: 'wrong account' });
    const mAu = (await loanRow(au.id)).member_id;
    check('undoing the disbursement clears deferred and fee income', await glFor('200-350', mAu) === 0 && await glFor('400-200', mAu) === 0,
      `${await glFor('200-350', mAu)} ${await glFor('400-200', mAu)}`);
    check('the end of day amortises fees', eod.DEFAULT_JOBS.includes('amortizeFees'));
    check('trial balance balances', (await Rd((c) => acct.trialBalance(c))).balanced);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const x of failures) console.log(`  - ${x}`);
    server.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
