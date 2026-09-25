#!/usr/bin/env node
'use strict';

/**
 * Paying ahead and scheduling ahead, after Mambu:
 *   - interest taken in advance on a fixed-term loan and held in the
 *     deferred interest account until it is earned
 *   - postdated payments, applied by the end of day on their value date
 *   - a schedule edited on an application and drawn at disbursement
 *   - the endpoint the console's schedule editor reads
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/schedule');
const WO = require('../src/domain/writeOffs');
const PDP = require('../src/domain/postdated');
const acct = require('../src/domain/accounting');
const eod = require('../src/ops/eod');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'advancetest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4099;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const inDays = (n) => iso(new Date(Date.now() + n * 86400000));

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
const ACCRUAL = { accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY' };
const mk = (id, body) => call('POST', '/api/loan-products', { id, name: id, ...GL, ...ACCRUAL, enforceDepositMultiplier: false, maxTerm: 36, monthlyRate: 1, ...body });
const sched = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id])).rows);
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
// What a GL account holds for one member (credit minus debit).
const glFor = (code, memberId) => Rd(async (c) => Number((await c.query(
  `SELECT COALESCE(sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS b
   FROM journal_lines WHERE gl_code = $1 AND member_id = $2`, [code, memberId])).rows[0].b));
let seq = 0;
const member = () => T(async (c) => {
  seq += 1;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'A',$1) RETURNING *`, [`A${String(seq).padStart(4, '0')}`])).rows[0];
  await c.query("INSERT INTO savings_accounts (account_no, member_id, product_id) VALUES ($1, $2, 'SAV01')", [`SA${seq}`, m.id]);
  return m;
});
const applied = async (productId, principal, term) => {
  const m = await member();
  return T((c) => L.apply(c, { memberId: m.id, productId, principal, termMonths: term, createdBy: 'officer' }));
};
const disbursed = async (productId, principal, term, on) => {
  const l = await applied(productId, principal, term);
  await T(async (c) => {
    await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
    await L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: on, createdBy: 'teller' });
  });
  return l;
};
const accrue = (id, on) => T((c) => L.accrueInterest(c, id, { valueDate: on, createdBy: 'eod' }));
const repay = (id, amount, on) => call('POST', `/api/loans/${id}/repayments`, { amount, channelId: 'cash', valueDate: on });

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Advance SACCO', mfaRequiredRoles: [], adminEmail: 'admin@advancetest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@advancetest.local', password: PASSWORD })).body.accessToken;
    const made = await Promise.all([
      mk('PLAIN', { productType: 'FIXED_TERM', method: 'REDUCING' }),
      mk('NEXT', { productType: 'FIXED_TERM', method: 'REDUCING', interestPrepayment: 'NEXT_INSTALLMENT' }),
      mk('ALL', { productType: 'FIXED_TERM', method: 'REDUCING', interestPrepayment: 'ALL_INSTALLMENTS' }),
      mk('CASHN', { productType: 'FIXED_TERM', method: 'REDUCING', interestPrepayment: 'NEXT_INSTALLMENT', accountingMethod: 'CASH', interestAccruedAccounting: 'NONE', glInterestRec: undefined }),
      mk('PDP', { productType: 'FIXED_TERM', method: 'REDUCING', allowPostdatedPayments: true, nonWorkingDays: 'DO_NOT_RESCHEDULE' }),
      mk('EDITF', { productType: 'FIXED_TERM', method: 'REDUCING', scheduleEditing: ['PAYMENT_DATES', 'PRINCIPAL', 'INTEREST'] }),
      mk('EDITP', { productType: 'FIXED_TERM', method: 'REDUCING', scheduleEditing: ['PRINCIPAL'] }),
      mk('EDITD', { productType: 'DYNAMIC_TERM', method: 'REDUCING', scheduleEditing: ['PAYMENT_DATES', 'PRINCIPAL'] }),
    ]);
    check('products with each option', made.every((r) => r.status === 201), made.map((r) => `${r.status} ${r.source}`).join('|'));
    check('the product shows the options and the deferred interest account',
      made[1].body.interestPrepayment === 'NEXT_INSTALLMENT' && made[1].body.gl.deferredInterest === '200-340' && made[4].body.allowPostdatedPayments === true,
      JSON.stringify(made[1].body?.gl));
    check('interest prepayment is refused on a dynamic product',
      (await mk('B1', { productType: 'DYNAMIC_TERM', method: 'REDUCING', interestPrepayment: 'NEXT_INSTALLMENT' })).status === 400);
    check('and when interest is posted on disbursement',
      (await mk('B2', { productType: 'FIXED_TERM', method: 'FLAT', interestPosting: 'ON_DISBURSEMENT', interestPrepayment: 'ALL_INSTALLMENTS' })).status === 400);
    check('postdated payments are refused on a dynamic product',
      (await mk('B3', { productType: 'DYNAMIC_TERM', method: 'REDUCING', allowPostdatedPayments: true })).status === 400);
    check('the chart has the deferred interest liability',
      (await Rd((c) => c.query("SELECT type FROM gl_accounts WHERE code = '200-340'"))).rows[0]?.type === 'LIABILITY');

    // ----------------------------------------------------------------------
    section('interest taken in advance: the next installment');
    // 3,000 over three months at 1% a month, reducing: 1,000 principal a
    // month, interest 30, 20, 10 (30/360).
    const plain = await disbursed('PLAIN', 3000, 3, '2026-01-01');
    const nx = await disbursed('NEXT', 3000, 3, '2026-01-01');
    for (const x of [plain, nx]) await accrue(x.id, '2026-01-16');
    const s0 = await sched(nx.id);
    const firstDue = round(Number(s0[0].principal_due) + Number(s0[0].interest_due));
    check('the first installment is 1,000 and 30', firstDue === 1030, String(firstDue));
    const rp = await repay(plain.id, firstDue, '2026-01-16');
    const rn = await repay(nx.id, firstDue, '2026-01-16');
    check('without the option: the fifteen days earned, and the rest to principal',
      rp.status === 201 && rp.body.allocation.interest === 15 && rp.body.allocation.principal === 1015 && !rp.body.allocation.prepaidInterest,
      JSON.stringify(rp.body?.allocation));
    check('with it: the fifteen days earned, the fifteen still to be earned held in advance, then the principal',
      rn.status === 201 && rn.body.allocation.interest === 15 && rn.body.allocation.prepaidInterest === 15 && rn.body.allocation.principal === 1000,
      JSON.stringify(rn.body?.allocation));
    check('so the first installment is paid, where without it it is not',
      (await sched(nx.id))[0].status === 'PAID' && (await sched(plain.id))[0].status === 'PARTIALLY_PAID');
    const mNx = (await loanRow(nx.id)).member_id;
    check('the loan holds 15 of interest paid in advance, and so does the deferred interest account',
      Number((await loanRow(nx.id)).interest_prepaid) === 15 && await glFor('200-340', mNx) === 15);
    await accrue(nx.id, '2026-02-01');
    const after = await loanRow(nx.id);
    check('as the interest is earned it is settled from the deferred account',
      Number(after.interest_prepaid) === 0 && Number(after.interest_accrued) === 30 && Number(after.interest_paid) === 30 && await glFor('200-340', mNx) === 0,
      `${after.interest_prepaid} ${after.interest_accrued} ${after.interest_paid}`);
    check('and the receivable it was earned into is cleared', await glFor('100-300', mNx) === 0, String(await glFor('100-300', mNx)));
    check('the loan page shows it', (await call('GET', `/api/loans/${nx.id}`)).body.interest_prepayment === 'NEXT_INSTALLMENT');

    section('every installment the payment reaches');
    const al = await disbursed('ALL', 3000, 3, '2026-01-01');
    await accrue(al.id, '2026-01-16');
    const ra = await repay(al.id, 2050, '2026-01-16');
    check('two installments paid ahead: 15 earned, 15 + 20 in advance, 2,000 principal',
      ra.status === 201 && ra.body.allocation.interest === 15 && ra.body.allocation.prepaidInterest === 35 && ra.body.allocation.principal === 2000,
      JSON.stringify(ra.body?.allocation));
    const sa = await sched(al.id);
    check('both installments are paid', sa[0].status === 'PAID' && sa[1].status === 'PAID' && sa[2].status === 'PENDING', sa.map((x) => x.status).join(','));
    const nxOnly = await disbursed('NEXT', 3000, 3, '2026-01-01');
    await accrue(nxOnly.id, '2026-01-16');
    const rno = await repay(nxOnly.id, 2050, '2026-01-16');
    check('the next-installment option takes only the next one\'s interest; the rest is principal',
      rno.status === 201 && rno.body.allocation.prepaidInterest === 15 && rno.body.allocation.principal === 2020, JSON.stringify(rno.body?.allocation));

    section('reversing a payment that took interest in advance');
    await accrue(al.id, '2026-02-01');
    const beforeRev = await loanRow(al.id);
    check('by the first due date 15 of the 35 has been earned', Number(beforeRev.interest_prepaid) === 20, String(beforeRev.interest_prepaid));
    const rev = await call('POST', `/api/loans/transactions/${ra.body.reference}/reversal`, { narration: 'bounced' });
    const ar = await loanRow(al.id);
    check('after the reversal nothing is held in advance and the interest earned is owed again',
      rev.status === 201 && Number(ar.interest_prepaid) === 0 && Number(ar.interest_paid) === 0 && Number(ar.interest_accrued) === 30 && Number(ar.principal_paid) === 0,
      `${rev.status} ${rev.reason} ${ar.interest_prepaid} ${ar.interest_paid} ${ar.principal_paid}`);
    const mAl = ar.member_id;
    check('the deferred account is back to nothing and the receivable holds the 30 owed',
      await glFor('200-340', mAl) === 0 && await glFor('100-300', mAl) === -30, `${await glFor('200-340', mAl)} ${await glFor('100-300', mAl)}`);
    check('the installments are unpaid again', (await sched(al.id)).every((x) => x.status === 'PENDING'));

    section('paying off early with the next installment\'s interest in advance');
    const po = await disbursed('NEXT', 3000, 3, '2026-01-01');
    await accrue(po.id, '2026-01-16');
    const rpo = await repay(po.id, 3030, '2026-01-16');
    const cpo = await loanRow(po.id);
    check('the payoff is the principal, the interest earned and the rest of the next installment\'s',
      rpo.status === 201 && rpo.body.allocation.prepaidInterest === 15 && rpo.body.allocation.principal === 3000 && rpo.body.allocation.surplus === 0,
      JSON.stringify(rpo.body?.allocation));
    check('the loan closes and what was held in advance is recognised as income on the day',
      cpo.status === 'CLOSED_REPAID' && Number(cpo.interest_prepaid) === 0 && Number(cpo.interest_accrued) === 30 && await glFor('200-340', cpo.member_id) === 0,
      `${cpo.status} ${cpo.interest_prepaid} ${cpo.interest_accrued}`);
    const closure = (await Rd((c) => c.query("SELECT * FROM transactions WHERE loan_account_id = $1 AND allocation->>'method' = 'PREPAID_AT_CLOSURE'", [po.id]))).rows;
    check('with its own transaction', closure.length === 1 && Number(closure[0].amount) === 15);
    const rv2 = await call('POST', `/api/loans/transactions/${rpo.body.reference}/reversal`, { narration: 'error' });
    const opo = await loanRow(po.id);
    check('reversing the payoff reopens the loan and takes the recognition back',
      rv2.status === 201 && opo.status === 'ACTIVE' && Number(opo.interest_accrued) === 15 && Number(opo.interest_paid) === 0 && Number(opo.interest_prepaid) === 0
      && await glFor('200-340', opo.member_id) === 0, `${rv2.reason} ${opo.status} ${opo.interest_accrued} ${opo.interest_paid}`);

    section('under cash accounting');
    const ca = await disbursed('CASHN', 3000, 3, '2026-01-01');
    await accrue(ca.id, '2026-01-16');
    const rca = await repay(ca.id, 1030, '2026-01-16');
    const mCa = (await loanRow(ca.id)).member_id;
    check('the earned half is income at once and the rest is held in advance',
      rca.status === 201 && await glFor('400-100', mCa) === 15 && await glFor('200-340', mCa) === 15, `${await glFor('400-100', mCa)} ${await glFor('200-340', mCa)}`);
    await accrue(ca.id, '2026-02-01');
    check('and becomes income as it is earned', await glFor('400-100', mCa) === 30 && await glFor('200-340', mCa) === 0);

    section('writing off a loan with interest held in advance');
    const wo = await disbursed('ALL', 3000, 3, '2026-01-01');
    await accrue(wo.id, '2026-01-16');
    await repay(wo.id, 2050, '2026-01-16');
    await T((c) => c.query('UPDATE lending_controls SET write_off_requires_approval = false WHERE id = 1'));
    await T((c) => WO.writeOff(c, wo.id, { narration: 'test', createdBy: 'manager', valueDate: '2026-01-16' }));
    const w = await loanRow(wo.id);
    check('what was held in advance goes to the principal before the write-off',
      w.status === 'CLOSED_WRITTEN_OFF' && Number(w.interest_prepaid) === 0 && Number(w.written_off_amount) === 965 && await glFor('200-340', w.member_id) === 0,
      `${w.status} ${w.interest_prepaid} ${w.written_off_amount}`);
    check('trial balance balances', (await Rd((c) => acct.trialBalance(c))).balanced);

    // ----------------------------------------------------------------------
    section('postdated payments');
    const pd = await disbursed('PDP', 3000, 3, '2026-01-01');
    let r = await call('POST', `/api/loans/${plain.id}/postdated-payments`, { amount: 100, valueDate: '2026-03-01', asOf: '2026-01-10' });
    check('refused where the product does not accept them', r.status === 409 && /PRODUCT_DOES_NOT_ALLOW_POSTDATED/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${pd.id}/postdated-payments`, { amount: 100, valueDate: '2026-01-05', asOf: '2026-01-10' });
    check('a value date that is not later is refused', r.status === 400 && /VALUE_DATE_NOT_IN_THE_FUTURE/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${pd.id}/postdated-payments`, { installments: true, channelId: 'bank', reference: 'CHQ', asOf: '2026-01-10' });
    const s1 = await sched(pd.id);
    check('one per remaining installment, for what it owes, on its due date',
      r.status === 201 && r.body.length === 3 && r.body.every((p, k) => Number(p.amount) === round(Number(s1[k].principal_due) + Number(s1[k].interest_due))
        && S.ymd(p.value_date) === S.ymd(s1[k].due_date) && p.reference === `CHQ-${k + 1}` && p.status === 'PENDING'),
      `${r.status} ${r.reason} ${JSON.stringify(r.body?.map?.((p) => [p.amount, p.value_date, p.reference]))}`);
    const again = await call('POST', `/api/loans/${pd.id}/postdated-payments`, { amount: 5, valueDate: '2026-02-20', asOf: '2026-01-10' });
    check('together they may not come to more than the schedule owes', again.status === 409 && /EXCEED/.test(again.reason), again.reason);
    const third = r.body[2];
    check('a pending one can be cancelled', (await call('POST', `/api/loans/postdated-payments/${third.id}/cancel`, { reason: 'cheque returned' })).body?.status === 'CANCELLED');
    check('once', (await call('POST', `/api/loans/postdated-payments/${third.id}/cancel`, {})).status === 409);
    check('nothing has moved yet', Number((await loanRow(pd.id)).principal_paid) === 0);
    const firstPdDue = S.ymd(s1[0].due_date);
    check('the first installment falls due on its nominal date', firstPdDue === '2026-02-01', firstPdDue);
    let out = await T((c) => PDP.applyDue(c, { asOf: '2026-01-31' }));
    check('nothing is applied before its value date', out.due === 0, JSON.stringify(out));
    await accrue(pd.id, firstPdDue);
    out = (await call('POST', '/api/loans/postdated-payments/run', { asOf: firstPdDue })).body;
    const list = (await call('GET', `/api/loans/${pd.id}/postdated-payments`)).body;
    const txn = (await Rd((c) => c.query("SELECT * FROM transactions WHERE reference = $1", [list[0].transaction_ref]))).rows[0];
    check('on its date it is applied as a repayment dated that day', out.applied === 1 && list[0].status === 'APPLIED' && txn?.kind === 'LOAN_REPAYMENT'
      && S.ymd(txn.value_date) === firstPdDue, `${JSON.stringify(out)} ${list[0].status}`);
    check('and settles the installment in full', (await sched(pd.id))[0].status === 'PAID');
    check('the others wait', list[1].status === 'PENDING' && list[2].status === 'CANCELLED');
    // A payment that can no longer be applied fails on its own, with the reason.
    await repay(pd.id, 2100, '2026-02-10');
    const failed = await loanRow(pd.id);
    check('(the loan is paid off early)', failed.status === 'CLOSED_REPAID', failed.status);
    out = await T((c) => PDP.applyDue(c, { asOf: '2026-03-02' }));
    const list2 = (await call('GET', `/api/loans/${pd.id}/postdated-payments`)).body;
    check('one due on a closed loan is marked FAILED with the reason', out.failed === 1 && list2[1].status === 'FAILED' && /LOAN_NOT_ACTIVE/.test(list2[1].failure),
      `${JSON.stringify(out)} ${list2[1].status} ${list2[1].failure}`);
    check('the end of day applies them after the interest and before arrears',
      eod.DEFAULT_JOBS.indexOf('applyPostdatedPayments') > eod.DEFAULT_JOBS.indexOf('accrueInterest')
      && eod.DEFAULT_JOBS.indexOf('applyPostdatedPayments') < eod.DEFAULT_JOBS.indexOf('markArrears'), eod.DEFAULT_JOBS.join(','));

    // ----------------------------------------------------------------------
    section('a schedule edited on the application');
    const ap = await applied('EDITF', 3000, 3);
    let a = await call('GET', `/api/loans/${ap.id}/application-schedule`);
    check('an application shows the schedule it would be drawn with', a.status === 200 && a.body.custom === false && a.body.installments.length === 3, `${a.status} ${a.reason}`);
    const D1 = inDays(20); const D2 = inDays(50); const D3 = inDays(110);
    r = await call('PUT', `/api/loans/${ap.id}/schedule`, { installments: [{ dueDate: D1, principal: 500 }, { dueDate: D2, principal: 1000 }, { dueDate: D3, principal: 1400 }] });
    check('principal that does not add up to the loan is refused', r.status === 400 && /PRINCIPAL_MUST_ADD_UP/.test(r.reason), r.reason);
    r = await call('PUT', `/api/loans/${ap.id}/schedule`, { installments: [{ dueDate: D2, principal: 500 }, { dueDate: D1, principal: 1000 }, { dueDate: D3, principal: 1500 }] });
    check('dates that do not rise are refused', r.status === 400 && /DUE_DATES_MUST_RISE/.test(r.reason), r.reason);
    r = await call('PUT', `/api/loans/${ap.id}/schedule`, { installments: [{ dueDate: D1, principal: 500 }, { dueDate: D2, principal: 1000 }, { dueDate: D3, principal: 1500, interest: 12.5 }], note: 'harvest' });
    check('dates, principal and a fixed-term interest figure are kept on the application',
      r.status === 200 && r.body.application === true && r.body.custom === true && r.body.after.map((x) => x.dueDate).join() === [D1, D2, D3].join()
      && r.body.after[2].interest === 12.5, `${r.status} ${r.reason} ${JSON.stringify(r.body?.after)}`);
    check('the edit is on the register', (await call('GET', `/api/loans/${ap.id}/schedule-edits`)).body.some((e) => e.kind === 'APPLICATION' && e.note === 'harvest'));
    check('the editor endpoint sees an application', (await call('GET', `/api/loans/${ap.id}/schedule/editable`)).body.application === true);
    await T((c) => L.changeState(c, ap.id, 'APPROVE', { createdBy: 'manager' }));
    const late = await call('POST', `/api/loans/${ap.id}/disbursements`, { amount: 3000, channelId: 'bank', valueDate: inDays(25) });
    check('disbursing after the first edited date is refused, to be edited first', late.status === 409 && /APPLICATION_SCHEDULE_DATES_DO_NOT_FIT/.test(late.reason), late.reason);
    const today = inDays(0);
    const dis = await call('POST', `/api/loans/${ap.id}/disbursements`, { amount: 3000, channelId: 'bank', valueDate: today });
    const sx = await sched(ap.id);
    const terms = { rate: 1, convention: 'THIRTY_360' };
    const i1 = round(S.interestBetween(3000, terms, today, D1, { exact: true }));
    const i2 = round(S.interestBetween(2500, terms, D1, D2, { exact: true }));
    check('the loan is drawn with it: the dates and principal as edited',
      dis.status === 201 && sx.length === 3 && sx.map((x) => S.ymd(x.due_date)).join() === [D1, D2, D3].join()
      && sx.map((x) => Number(x.principal_due)).join() === '500,1000,1500', `${dis.status} ${dis.reason} ${sx.map((x) => `${S.ymd(x.due_date)}:${x.principal_due}`)}`);
    check('interest worked out on each period and balance, and the figure given kept',
      Number(sx[0].interest_due) === i1 && Number(sx[1].interest_due) === i2 && Number(sx[2].interest_due) === 12.5,
      `${sx.map((x) => x.interest_due)} vs ${i1},${i2}`);

    section('rights, term and resets on an application');
    const ap2 = await applied('EDITP', 3000, 3);
    r = await call('PUT', `/api/loans/${ap2.id}/schedule`, { installments: [{ dueDate: D1 }, {}, {}] });
    check('a date change needs the product to allow it', r.status === 409 && /PRODUCT_DOES_NOT_ALLOW_PAYMENT_DATES_EDITING/.test(r.reason), r.reason);
    r = await call('PUT', `/api/loans/${ap2.id}/schedule`, { installments: [{ principal: 1500 }, { principal: 1000 }, { principal: 500 }] });
    check('principal alone may move where only that is allowed', r.status === 200 && r.body.after.map((x) => x.principal).join() === '1500,1000,500', `${r.status} ${r.reason}`);
    check('dates left alone stay the product\'s', r.body.after.map((x) => x.dueDate).join() === r.body.before.map((x) => x.dueDate).join());
    r = await call('PUT', `/api/loans/${ap2.id}/schedule`, { installments: [{ principal: 1000 }, { principal: 1000 }, { principal: 500 }, { principal: 500 }] });
    check('an application may take more installments within the product\'s term', r.status === 200 && r.body.after.length === 4
      && Number((await loanRow(ap2.id)).term_months) === 4, `${r.status} ${r.reason}`);
    const am = await call('PATCH', `/api/loans/${ap2.id}`, { principal: 4000 });
    check('amending the amount drops the edited schedule', am.status === 200 && (await loanRow(ap2.id)).custom_schedule === null, `${am.status} ${am.reason}`);
    await call('PUT', `/api/loans/${ap2.id}/schedule`, { installments: [{ principal: 2000 }, { principal: 1000 }, { principal: 500 }, { principal: 500 }] });
    r = await call('DELETE', `/api/loans/${ap2.id}/application-schedule`);
    check('and it can go back to the product\'s', r.status === 200 && r.body.custom === false && (await loanRow(ap2.id)).custom_schedule === null, `${r.status} ${r.reason}`);
    const ap3 = await applied('EDITD', 3000, 3);
    r = await call('PUT', `/api/loans/${ap3.id}/schedule`, { installments: [{ interest: 5 }, {}, {}] });
    check('a dynamic application\'s interest is not edited', r.status === 409 && /FOLLOWS_ITS_BALANCE/.test(r.reason), r.reason);
    r = await call('PUT', `/api/loans/${ap3.id}/schedule`, { installments: [{ dueDate: D1, principal: 1000 }, { dueDate: D2, principal: 1000 }, { dueDate: D3, principal: 1000 }] });
    check('its dates and principal are', r.status === 200 && r.body.after[0].dueDate === D1, `${r.status} ${r.reason}`);

    section('the console\'s editor endpoint on a running loan');
    const run = await call('GET', `/api/loans/${ap.id}/schedule/editable`);
    check('a running loan: the installments that can change and the rights', run.status === 200 && run.body.application === false
      && run.body.installments.length === 3 && run.body.allowed.includes('INTEREST') && run.body.fixedTerm === true, `${run.status} ${run.reason}`);
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
