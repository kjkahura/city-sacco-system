#!/usr/bin/env node
'use strict';

/**
 * Working with loan accounts, after Mambu's pages of that name: the end of
 * day that leaves a broken loan out and brings it back; pay-off with charges
 * written off; terminate and undo; disbursement details and disbursing into
 * a deposit account; the repayment rules (no backdating before a later
 * repayment, newest reversed first, custom allocation by product and
 * permission) and repayments from deposit accounts; bulk collection; fee and
 * penalty adjustments and balance reductions; rate changes on running loans;
 * payment holiday options; revolving installments added by hand; guarantors
 * on running loans; the member's loan history; attachments; interest from
 * arrears; and reschedule and refinance with partial capitalisation, a
 * reduced principal, fees carried across, the account number kept, and undo.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const P = require('../src/domain/penalties');
const SV = require('../src/domain/savings');
const RV = require('../src/domain/revolving');
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

const SLUG = 'loanacct';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4102;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;

let server;
let token;
async function call(method, p, body, { raw = null, type = null } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw) { headers['content-type'] = type || 'application/octet-stream'; payload = raw; }
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text, headers: r.headers, reason: d?.errors?.[0]?.errorReason || '', source: d?.errors?.[0]?.errorSource || '' };
}
const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200', glInterestRec: '100-300', glPenaltyInc: '400-200' };
const BASE = { ...GL, accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', enforceDepositMultiplier: false, maxTerm: 36,
  monthlyRate: 1, productType: 'FIXED_TERM', method: 'REDUCING', nonWorkingDays: 'DO_NOT_RESCHEDULE' };
const mk = (id, body = {}) => call('POST', '/api/loan-products', { id, name: id, ...BASE, ...body });
const fee = (pid, body) => call('POST', `/api/loan-products/${pid}/fees`, body);
const sched = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id])).rows);
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
const savRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [id])).rows[0]);
const txs = (id) => Rd(async (c) => (await c.query('SELECT * FROM transactions WHERE loan_account_id = $1 ORDER BY created_at', [id])).rows);
const glTotal = (code) => Rd(async (c) => Number((await c.query(
  `SELECT COALESCE(sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS b FROM journal_lines WHERE gl_code = $1`, [code])).rows[0].b));
const bal = (l) => L.balances(l);
let seq = 0;
const member = ({ deposit = 0, accounts = 1 } = {}) => T(async (c) => {
  seq += 1;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'A',$1) RETURNING *`,
    [`A${String(seq).padStart(4, '0')}`])).rows[0];
  const opened = [];
  for (let k = 0; k < accounts; k += 1) {
    const a = await SV.open(c, { memberId: m.id, productId: 'SAV01' });
    if (deposit > 0 && k === 0) await SV.deposit(c, a.id, { amount: deposit, channelId: 'cash', valueDate: '2025-12-01', createdBy: 'test' });
    opened.push(a);
  }
  return { m, accounts: opened };
});
const apply = (memberId, productId, principal, term, extra = {}) =>
  T((c) => L.apply(c, { memberId, productId, principal, termMonths: term, createdBy: 'officer', ...extra }));
const approve = (id) => T((c) => L.changeState(c, id, 'APPROVE', { createdBy: 'manager' }));
const disburse = (id, amount, on) => T((c) => L.disburse(c, id, { amount, channelId: 'bank', valueDate: on, createdBy: 'teller' }));
const disbursed = async (memberId, productId, principal, term, on, extra = {}) => {
  const l = await apply(memberId, productId, principal, term, extra);
  await approve(l.id);
  await disburse(l.id, principal, on);
  return l;
};
const accrue = (id, on) => T((c) => L.accrueInterest(c, id, { valueDate: on, createdBy: 'eod' }));
const repay = (id, amount, on, extra = {}) => call('POST', `/api/loans/${id}/repayments`, { amount, channelId: 'cash', valueDate: on, ...extra });

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Loan Accounts SACCO', mfaRequiredRoles: [], adminEmail: 'admin@loanacct.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@loanacct.local', password: PASSWORD })).body.accessToken;
    const { rows: [tenant] } = await pool.query('SELECT id, slug, schema_name FROM platform.tenants WHERE slug = $1', [SLUG]);
    const made = await Promise.all([
      mk('FX'),
      mk('DYN', { productType: 'DYNAMIC_TERM' }),
      mk('REV', { productType: 'REVOLVING', revolvingRepaymentMethod: 'PRINCIPAL_PERCENT', revolvingRepaymentValue: 10 }),
      mk('NOCUST', { allowCustomAllocation: false }),
      mk('FXE', { scheduleEditing: ['FEES', 'PAYMENT_HOLIDAYS'] }),
      mk('DYE', { productType: 'DYNAMIC_TERM', scheduleEditing: ['PAYMENT_HOLIDAYS'] }),
      mk('COV', { requireGuarantorCover: true, minCoverPercent: 100, coverCountsDeposits: false }),
      mk('PEN', { productType: 'INTEREST_FREE', monthlyRate: 0, penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 1 }),
      mk('LATE', { productType: 'INTEREST_FREE', monthlyRate: 0 }),
    ]);
    check('products', made.every((r) => r.status === 201), made.map((r) => `${r.status} ${r.source} ${r.reason}`).join('|'));
    check('a product says whether it takes custom repayments', made[3].body.allowCustomAllocation === false && made[0].body.allowCustomAllocation === true);
    const fees = await Promise.all([
      fee('FX', { code: 'VISIT', name: 'Field visit', feeType: 'MANUAL', calculation: 'FLAT', amount: 50 }),
      fee('FXE', { code: 'VISIT', name: 'Field visit', feeType: 'MANUAL', calculation: 'FLAT', amount: 50 }),
      fee('DYN', { code: 'VISIT', name: 'Field visit', feeType: 'MANUAL', calculation: 'FLAT', amount: 50 }),
      fee('LATE', { code: 'LATEF', name: 'Late fee', feeType: 'LATE_REPAYMENT', calculation: 'FLAT', amount: 25 }),
      fee('LATE', { code: 'LETTER', name: 'Legal letter', feeType: 'MANUAL', calculation: 'FLAT', amount: 40 }),
    ]);
    check('fees', fees.every((r) => r.status === 201), fees.map((r) => `${r.status} ${r.reason}`).join('|'));

    // ----------------------------------------------------------------------
    section('the end of day leaves a broken loan out');
    const { m: e1 } = await member();
    const good = await disbursed(e1.id, 'DYN', 3000, 3, '2026-01-01');
    const bad = await disbursed(e1.id, 'DYN', 3000, 3, '2026-01-01');
    const breakLoan = (cond) => T(async (c) => {
      await c.query(`CREATE OR REPLACE FUNCTION ${SCHEMA}.test_break() RETURNS trigger AS $$
        BEGIN IF ${cond} AND NEW.accrued_through IS DISTINCT FROM OLD.accrued_through THEN RAISE EXCEPTION 'BROKEN_SCHEDULE_TEST'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await c.query(`DROP TRIGGER IF EXISTS test_break ON ${SCHEMA}.loan_accounts`);
      await c.query(`CREATE TRIGGER test_break BEFORE UPDATE ON ${SCHEMA}.loan_accounts FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.test_break()`);
    });
    const mend = () => T((c) => c.query(`DROP TRIGGER IF EXISTS test_break ON ${SCHEMA}.loan_accounts`));
    await breakLoan(`NEW.id = '${bad.id}'`);
    let job = await eod.runJob(tenant, 'accrueInterest', { businessDate: '2026-01-10' });
    check('interest accrues on every other loan and the job succeeds', job.ok !== false && Number((await loanRow(good.id)).interest_accrued) > 0,
      JSON.stringify(job).slice(0, 300));
    check('the broken loan is left out, with the job, the date and the error', job.excluded?.length === 1 && job.excluded[0].loanId === bad.id
      && /BROKEN_SCHEDULE_TEST/.test(job.excluded[0].error), JSON.stringify(job.excluded));
    check('nothing was accrued on it', Number((await loanRow(bad.id)).interest_accrued) === 0);
    job = await eod.runJob(tenant, 'accrueInterest', { businessDate: '2026-01-11' });
    check('the next run leaves it out without failing on it again', job.loans === 1 && !job.excluded, JSON.stringify(job).slice(0, 200));
    job = await eod.runJob(tenant, 'applyFees', { businessDate: '2026-01-11' });
    check('and so does every other loan job', job.loans === 1 && !job.excluded, JSON.stringify(job).slice(0, 200));
    let r = await call('GET', '/api/loans/eod-exclusions');
    check('the list shows it', r.status === 200 && r.body.length === 1 && r.body[0].account_no === bad.account_no && r.body[0].job === 'accrueInterest',
      JSON.stringify(r.body).slice(0, 200));
    check('the loan says it is out', (await call('GET', `/api/loans/${bad.id}`)).body.eod_excluded?.job === 'accrueInterest');
    r = await call('POST', `/api/loans/${bad.id}/eod-include`, { asOf: '2026-01-11' });
    check('including it while it still fails is refused, and it stays out', r.status === 409 && /LOAN_STILL_FAILS/.test(r.reason)
      && (await call('GET', `/api/loans/${bad.id}/eod-exclusions`)).body.excluded === true, `${r.status} ${r.reason}`);
    await mend();
    r = await call('POST', `/api/loans/${bad.id}/eod-include`, { asOf: '2026-01-11' });
    check('once fixed it is included and caught up: its missed interest is accrued', r.status === 200 && r.body.catchUp.accrueInterest > 0
      && round(Number((await loanRow(bad.id)).interest_accrued)) === round(Number((await loanRow(good.id)).interest_accrued)),
      `${r.status} ${r.reason} ${JSON.stringify(r.body?.catchUp)}`);
    check('and it is off the list', (await call('GET', '/api/loans/eod-exclusions')).body.length === 0);
    check('including a loan that is not out is refused', (await call('POST', `/api/loans/${bad.id}/eod-include`, {})).status === 409);
    const extra = [];
    for (let k = 0; k < 3; k += 1) extra.push(await disbursed(e1.id, 'DYN', 1000, 3, '2026-01-01'));
    await breakLoan('true');
    job = await eod.runJob(tenant, 'accrueInterest', { businessDate: '2026-01-15' });
    check('a failure on every loan is a fault in the system: the job fails and no loan is left out',
      job.ok === false && /EOD_TOO_MANY_LOAN_FAILURES/.test(job.error)
      && (await Rd((c) => c.query('SELECT count(*)::int AS n FROM loan_eod_exclusions WHERE included_at IS NULL'))).rows[0].n === 0, JSON.stringify(job).slice(0, 300));
    await mend();

    // ----------------------------------------------------------------------
    section('pay-off');
    const { m: p1 } = await member({ deposit: 100 });
    const po = await disbursed(p1.id, 'FX', 3000, 3, '2026-01-01');
    await accrue(po.id, '2026-02-15');
    const before = await loanRow(po.id);
    r = await call('GET', `/api/loans/${po.id}/pay-off?valueDate=2026-02-15`);
    check('the quote is the principal and the charges owed on the day', r.status === 200 && r.body.principal === 3000
      && r.body.total === round(r.body.principal + r.body.interest + r.body.fees + r.body.penalty) && r.body.interest === round(bal(before).interest),
      `${r.status} ${r.reason} ${JSON.stringify(r.body)}`);
    check('and quoting books nothing', Number((await loanRow(po.id)).interest_accrued) === Number(before.interest_accrued));
    r = await call('POST', `/api/loans/${po.id}/pay-off`, { valueDate: '2026-02-15', interest: 999999, channelId: 'cash' });
    check('collecting more than is owed is refused', r.status === 400 && /EXCEEDS_WHAT_IS_OWED/.test(r.reason), r.reason);
    const woBefore = await glTotal('500-310');
    r = await call('POST', `/api/loans/${po.id}/pay-off`, { valueDate: '2026-02-15', interest: 0, channelId: 'cash', note: 'early settlement' });
    const owedInterest = round(bal(before).interest);
    check('paid off with the interest written off: the member pays the principal, the loan closes', r.status === 201
      && r.body.status === 'CLOSED_REPAID' && r.body.paid.total === 3000 && r.body.writtenOff.interest === owedInterest,
      `${r.status} ${r.reason} ${JSON.stringify(r.body).slice(0, 300)}`);
    check('the interest left is written off against the write-off expense', round(woBefore - await glTotal('500-310')) === owedInterest,
      `${woBefore} ${await glTotal('500-310')}`);
    const poTx = await txs(po.id);
    check('as a balance write-off, and the payment is marked a pay-off', poTx.some((t) => t.kind === 'LOAN_BALANCE_WRITE_OFF' && Number(t.amount) === owedInterest)
      && poTx.some((t) => t.kind === 'LOAN_REPAYMENT' && t.allocation.payOff === true));
    check('nothing is left owed', bal(await loanRow(po.id)).total === 0);
    const { m: p2 } = await member();
    const rpo = await disbursed(p2.id, 'REV', 1000, 12, '2026-01-01');
    r = await call('POST', `/api/loans/${rpo.id}/pay-off`, { valueDate: '2026-01-20', channelId: 'cash' });
    check('a revolving loan, which does not close when paid, is closed by the pay-off', r.status === 201 && (await loanRow(rpo.id)).status === 'CLOSED_REPAID',
      `${r.status} ${r.reason}`);

    // ----------------------------------------------------------------------
    section('terminate');
    const { m: t1 } = await member();
    const tm = await disbursed(t1.id, 'DYN', 3000, 3, '2026-01-01');
    const was = await sched(tm.id);
    r = await call('POST', `/api/loans/${tm.id}/terminate`, { valueDate: '2026-02-10', note: 'member left the area' });
    let ts = await sched(tm.id);
    check('everything owed falls due on the termination date: the installments to come become one due that day', r.status === 200
      && ts.length === 2 && S(ts[1].due_date) === '2026-02-10' && round(Number(ts[1].principal_due)) === round(Number(was[1].principal_due) + Number(was[2].principal_due)),
      `${r.status} ${r.reason} ${ts.map((i) => `${S(i.due_date)}:${i.principal_due}/${i.interest_due}`).join(' ')}`);
    const tl = await loanRow(tm.id);
    check('with the interest earned to the day', round(Number(ts[0].interest_due) - Number(ts[0].interest_paid) + Number(ts[1].interest_due)) === round(bal(tl).interest),
      `${ts[0].interest_due} ${ts[1].interest_due} ${bal(tl).interest}`);
    const tv = (await call('GET', `/api/loans/${tm.id}`)).body;
    check('the loan keeps its state with the sub-state Terminated', tv.status === 'ACTIVE' && tv.sub_state === 'TERMINATED', `${tv.status} ${tv.sub_state}`);
    check('and a non-financial transaction', (await txs(tm.id)).some((t) => t.kind === 'LOAN_TERMINATED' && Number(t.amount) === 0));
    check('terminating twice is refused', (await call('POST', `/api/loans/${tm.id}/terminate`, {})).status === 409);
    r = await call('POST', `/api/loans/${tm.id}/undo-terminate`, {});
    ts = await sched(tm.id);
    check('undo puts the schedule back as it was', r.status === 200 && ts.length === 3 && ts.map((i) => S(i.due_date)).join() === was.map((i) => S(i.due_date)).join()
      && !(await loanRow(tm.id)).terminated_on, `${r.status} ${r.reason} ${ts.map((i) => S(i.due_date))}`);
    await call('POST', `/api/loans/${tm.id}/terminate`, { valueDate: '2026-02-10' });
    await repay(tm.id, 100, '2026-02-12');
    r = await call('POST', `/api/loans/${tm.id}/undo-terminate`, {});
    check('once a repayment is posted after it, undo is refused', r.status === 409 && /REPAYMENT_SINCE_THE_TERMINATION/.test(r.reason), r.reason);
    const { m: t2 } = await member();
    const trv = await disbursed(t2.id, 'REV', 1000, 12, '2026-01-01');
    check('a revolving loan cannot be terminated', (await call('POST', `/api/loans/${trv.id}/terminate`, {})).status === 409);

    // ----------------------------------------------------------------------
    section('disbursement details and disbursing into a deposit account');
    const { m: d1, accounts: [d1a] } = await member({ deposit: 500 });
    r = await call('POST', '/api/loans', { memberId: d1.id, productId: 'FX', principal: 3000, termMonths: 3,
      expectedDisbursementDate: '2026-03-01', firstRepaymentDate: '2026-04-15' });
    const dd = r.body;
    let det = (await call('GET', `/api/loans/${dd.id}/disbursement-details`)).body;
    check('the application carries its anticipated disbursement date and first repayment date', r.status === 201
      && det.expectedDisbursementDate === '2026-03-01' && det.firstRepaymentDate === '2026-04-15' && det.changes.length === 1, JSON.stringify(det).slice(0, 200));
    check('a first repayment date before the disbursement date is refused',
      (await call('PUT', `/api/loans/${dd.id}/disbursement-details`, { firstRepaymentDate: '2026-02-01' })).status === 400);
    await call('PATCH', '/api/loans/controls', { disbursementConditionsRoles: ['MANAGER'] });
    r = await call('PUT', `/api/loans/${dd.id}/disbursement-details`, { firstRepaymentDate: '2026-04-20' });
    check('a user without the Set Disbursement Conditions permission cannot change them', r.status === 403, `${r.status} ${r.reason}`);
    await call('PATCH', '/api/loans/controls', { disbursementConditionsRoles: null });
    r = await call('PUT', `/api/loans/${dd.id}/disbursement-details`, { firstRepaymentDate: '2026-04-20', disbursementSavingsAccountId: d1a.account_no });
    det = r.body;
    check('with it they change, and every change is kept', r.status === 200 && det.firstRepaymentDate === '2026-04-20' && det.changes.length === 2
      && det.disbursementSavingsAccountId === d1a.id, `${r.status} ${r.reason}`);
    await approve(dd.id);
    r = await call('POST', `/api/loans/${dd.id}/disbursements`, { valueDate: '2026-03-01' });
    const ds = await sched(dd.id);
    check('disbursed into the member\'s deposit account named in the details', r.status === 201 && r.body.loanTransaction.allocation.transfer.savingsReference
      && Number((await savRow(d1a.id)).balance) === 3500, `${r.status} ${r.reason} ${(await savRow(d1a.id)).balance}`);
    check('the first installment falls on the first repayment date', S(ds[0].due_date) === '2026-04-20', S(ds[0].due_date));
    check('through the transfer clearing account, which nets to nothing', await glTotal('290-210') === 0, String(await glTotal('290-210')));
    const disbRef = r.body.loanTransaction.reference;
    const depRef = r.body.savingsTransaction.reference;
    r = await call('POST', `/api/savings/transactions/${depRef}/reversal`, {});
    check('reversing the deposit reverses the disbursement with it', r.status === 201 && (await loanRow(dd.id)).status === 'APPROVED'
      && Number((await savRow(d1a.id)).balance) === 500, `${r.status} ${r.reason} ${(await loanRow(dd.id)).status}`);
    await throws('the savings side alone is not reversed', () => T((c) => SV.reverseTransaction(c, depRef, { createdBy: 't' })),
      (e) => /ALREADY_REVERSED|LINKED_TO_A_LOAN_TRANSACTION/.test(e.message));
    check('the disbursement is marked reversed', (await txs(dd.id)).find((t) => t.reference === disbRef).reversed_by !== null);
    const { accounts: [strange] } = await member({ deposit: 10 });
    r = await call('POST', `/api/loans/${dd.id}/disbursements`, { valueDate: '2026-03-01', savingsAccountId: strange.id });
    check('another member\'s account cannot receive the loan', r.status === 409 && /ANOTHER_MEMBER/.test(r.reason), r.reason);

    // ----------------------------------------------------------------------
    section('repayment rules');
    const { m: r1 } = await member({ deposit: 100 });
    const rl = await disbursed(r1.id, 'FX', 3000, 3, '2026-01-01');
    const first = await repay(rl.id, 500, '2026-02-01');
    const second = await repay(rl.id, 500, '2026-02-10');
    r = await repay(rl.id, 100, '2026-02-05');
    check('a repayment dated before one already entered is refused', r.status === 409 && /REPAYMENT_BEFORE_A_LATER_ONE/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/transactions/${first.body.reference}/reversal`, {});
    check('an earlier repayment is not reversed while a later one stands', r.status === 409 && /REVERSE_THE_LATER_REPAYMENT_FIRST/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/transactions/${second.body.reference}/reversal`, {});
    const r2 = await call('POST', `/api/loans/transactions/${first.body.reference}/reversal`, {});
    check('newest first, both come off', r.status === 201 && r2.status === 201 && Number((await loanRow(rl.id)).principal_paid) === 0, `${r.status} ${r2.status}`);
    const { m: r3 } = await member({ deposit: 100 });
    const nc = await disbursed(r3.id, 'NOCUST', 3000, 3, '2026-01-01');
    r = await repay(nc.id, 100, '2026-01-10', { customAllocation: { principal: 100 } });
    check('a product that does not allow custom allocation refuses it', r.status === 409 && /DOES_NOT_ALLOW_CUSTOM/.test(r.reason), r.reason);
    await call('PATCH', '/api/loans/controls', { customAllocationRoles: ['MANAGER'] });
    r = await repay(rl.id, 100, '2026-01-10', { customAllocation: { principal: 100 } });
    check('a user without the permission cannot post one', r.status === 403 && /CUSTOM_ALLOCATION_NOT_PERMITTED/.test(r.reason), `${r.status} ${r.reason}`);
    await call('PATCH', '/api/loans/controls', { customAllocationRoles: null });
    r = await repay(rl.id, 100, '2026-01-10', { customAllocation: { principal: 100 } });
    check('with the tenant allowing any role, it posts', r.status === 201, `${r.status} ${r.reason}`);

    section('repayment from a deposit account');
    const { m: payer, accounts: [payerAcc] } = await member({ deposit: 2000 });
    r = await call('POST', `/api/savings/${payerAcc.id}/loan-repayments`, { loanAccountId: rl.id, amount: 400, valueDate: '2026-01-20' });
    check('another member repays the loan from their deposit account', r.status === 201 && r.body.loanTransaction.allocation.transfer.savingsReference
      && Number((await savRow(payerAcc.id)).balance) === 1600, `${r.status} ${r.reason}`);
    check('the withdrawal names the repayment', r.body.savingsTransaction.allocation.loanTransfer.reference === r.body.loanTransaction.reference && payer.id !== r1.id);
    const wRef = r.body.savingsTransaction.reference;
    const lRef = r.body.loanTransaction.reference;
    r = await call('POST', `/api/savings/transactions/${wRef}/reversal`, {});
    check('reversing the transfer from the deposit account reverses both', r.status === 201 && Number((await savRow(payerAcc.id)).balance) === 2000
      && (await txs(rl.id)).find((t) => t.reference === lRef).reversed_by !== null, `${r.status} ${r.reason}`);
    r = await repay(rl.id, 100000, '2026-01-21', { savingsAccountId: payerAcc.id });
    check('the deposit account\'s own rules stand', r.status === 409 && /INSUFFICIENT_AVAILABLE_BALANCE/.test(r.reason), r.reason);
    check('the transfer clearing account still nets to nothing', await glTotal('290-210') === 0);

    // ----------------------------------------------------------------------
    section('bulk repayment collection');
    const coll = [];
    for (let k = 0; k < 3; k += 1) {
      const { m } = await member({ deposit: 10 });
      coll.push(await disbursed(m.id, 'FX', 3000, 3, '2026-05-01'));
    }
    r = await call('GET', '/api/loans/collections/sheet?view=REPAYMENTS&from=2026-06-01&to=2026-06-01&productId=FX');
    const sheetRows = r.body.rows.filter((x) => coll.some((l) => l.id === x.loan_id));
    check('the sheet lists each installment due in the range at its expected amount', r.status === 200 && sheetRows.length === 3
      && sheetRows.every((x) => x.expected === 1030 && x.amountPaid === 1030 && x.datePaid === '2026-06-01'), JSON.stringify(sheetRows).slice(0, 300));
    r = await call('GET', '/api/loans/collections/sheet?view=REPAYMENTS&from=2026-06-01&to=2026-07-31&productId=FX');
    check('over two months a loan shows twice', r.body.rows.filter((x) => x.loan_id === coll[0].id).length === 2);
    r = await call('GET', '/api/loans/collections/sheet?view=ACCOUNTS&asOf=2026-07-01&productId=FX');
    const acc0 = r.body.rows.find((x) => x.loan_id === coll[0].id);
    check('by account, everything due as of one date', acc0 && acc0.expected === 2050 && acc0.installments_due === 2, JSON.stringify(acc0));
    r = await call('GET', '/api/loans/collections/sheet?view=REPAYMENTS&from=2026-06-01&productId=FX&format=csv');
    check('the sheet exports as CSV', r.status === 200 && /^member_no,member_name,account_no/.test(r.text) && r.text.split('\n').length >= 4, r.text.slice(0, 80));
    const lockConn = await pool.connect();
    await lockConn.query('BEGIN');
    await lockConn.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':loan-collection'))", [SCHEMA]);
    r = await call('POST', '/api/loans/collections/batches', { channelId: 'cash', valueDate: '2026-06-01', rows: [{ loanId: coll[0].id, amount: 1030 }] });
    check('only one batch runs at a time', r.status === 409 && /ANOTHER_PROCESS_IS_IN_PROGRESS/.test(r.reason), `${r.status} ${r.reason}`);
    await lockConn.query('ROLLBACK');
    lockConn.release();
    r = await call('POST', '/api/loans/collections/batches', {
      channelId: 'cash', valueDate: '2026-06-01', reference: 'RCPT-77',
      rows: [{ loanId: coll[0].id, amount: 1030 }, { loanId: coll[1].id, amount: 500, valueDate: '2026-06-03', channelId: 'mpesa' }, { loanId: 'NOPE', amount: 10 }],
    });
    check('a batch posts each row on its own: two posted, the bad one reported', r.status === 201 && r.body.posted === 2 && r.body.failed === 1
      && r.body.results[2].status === 'FAILED' && r.body.amount === 1530, `${r.status} ${r.reason} ${JSON.stringify(r.body).slice(0, 300)}`);
    const t1x = (await txs(coll[1].id)).find((t) => t.kind === 'LOAN_REPAYMENT');
    check('a row\'s own date and channel win over the batch\'s', S(t1x.value_date) === '2026-06-03' && t1x.channel_id === 'mpesa');
    check('the batch is kept', (await call('GET', `/api/loans/collections/batches/${r.body.batchId}`)).body.posted === 2);

    // ----------------------------------------------------------------------
    section('fees applied by hand');
    const { m: f1 } = await member();
    const fl = await disbursed(f1.id, 'FX', 3000, 3, '2026-01-01');
    await repay(fl.id, 100, '2026-01-20');
    r = await call('POST', `/api/loans/${fl.id}/fees`, { fee: 'VISIT', valueDate: '2026-01-10' });
    check('a fee dated before a repayment already entered is refused', r.status === 409 && /FEE_BEFORE_A_LATER_REPAYMENT/.test(r.reason), r.reason);
    check('a fee dated in the future is refused', (await call('POST', `/api/loans/${fl.id}/fees`, { fee: 'VISIT', valueDate: '2099-01-01' })).status === 400);
    r = await call('POST', `/api/loans/${fl.id}/fees`, { fee: 'VISIT', valueDate: '2026-01-25', installmentNumber: 3 });
    const fsched = await sched(fl.id);
    check('a fee placed on a chosen installment', r.status === 201 && Number(fsched[2].fee_due) === 50 && Number(fsched[0].fee_due) === 0, `${r.status} ${r.reason}`);
    const visit = r.body;
    await call('POST', `/api/loans/${fl.id}/lock`, {});
    r = await call('POST', `/api/loans/${fl.id}/fees`, { name: 'Legal letter', amount: 40 });
    const r0 = await call('POST', `/api/loans/${fl.id}/fees`, { fee: 'VISIT' });
    check('a fee may be applied to a locked loan', r0.status === 201, `${r0.status} ${r0.reason}`);
    await call('POST', `/api/loans/${fl.id}/unlock`, {});

    section('adjusting and reducing fees and penalties');
    const feesBefore = Number((await loanRow(fl.id)).fees_due);
    const inst3Before = Number((await sched(fl.id))[2].fee_due);
    r = await call('POST', `/api/loans/fees/${visit.id}/adjust`, { reason: 'applied by mistake' });
    const fAfter = await sched(fl.id);
    check('a fee adjusted is taken back as if never applied', r.status === 200 && Number((await loanRow(fl.id)).fees_due) === round(feesBefore - 50)
      && Number(fAfter[2].fee_due) === round(inst3Before - 50) && r.body.kind === 'LOAN_FEE_ADJUSTED',
      `${r.status} ${r.reason} ${feesBefore} ${(await loanRow(fl.id)).fees_due} ${inst3Before} ${fAfter[2].fee_due} ${r.body?.kind}`);
    check('its fee transaction is marked reversed', (await txs(fl.id)).find((t) => t.kind === 'LOAN_FEE' && t.allocation.feeId === visit.id).reversed_by !== null);
    check('adjusting it again is refused', (await call('POST', `/api/loans/fees/${visit.id}/adjust`, {})).status === 409);
    const feeWo = await glTotal('500-310');
    r = await call('POST', `/api/loans/${fl.id}/reduce-balance`, { component: 'FEE', newBalance: 20 });
    check('Reduce Balance lowers the fee balance and writes off the difference', r.status === 201
      && round(bal(await loanRow(fl.id)).fees) === 20 && round(feeWo - await glTotal('500-310')) === 30, `${r.status} ${r.reason} ${bal(await loanRow(fl.id)).fees}`);
    check('a reduction to more than the balance is refused',
      (await call('POST', `/api/loans/${fl.id}/reduce-balance`, { component: 'FEE', newBalance: 500 })).status === 400);
    const { m: pm } = await member();
    const pn = await disbursed(pm.id, 'PEN', 3000, 3, '2026-01-01');
    await T((c) => L.markArrears(c, { asOf: '2026-02-04' }));
    const [c1] = await T((c) => P.accrueForLoan(c, pn.id, { asOf: '2026-02-04' }));
    r = await call('POST', `/api/loans/penalties/${c1.id}/adjust`, { reason: 'wrong rate' });
    check('a penalty adjusted before any repayment is taken back', r.status === 200 && Number((await loanRow(pn.id)).penalty_accrued) === 0, `${r.status} ${r.reason}`);
    const [c2] = await T((c) => P.accrueForLoan(c, pn.id, { asOf: '2026-02-06' }));
    check('its days count as charged: the next charge covers only the days since', c2 && c2.days_charged === 2, JSON.stringify(c2));
    await repay(pn.id, 5, '2026-02-07');
    r = await call('POST', `/api/loans/penalties/${c2.id}/adjust`, {});
    check('once a repayment is entered a penalty is not adjusted', r.status === 409 && /ONLY_BEFORE_A_REPAYMENT/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${pn.id}/reduce-balance`, { component: 'PENALTY', amount: 5 });
    check('but its balance can be reduced', r.status === 201 && round(bal(await loanRow(pn.id)).penalty) === round(Number(c2.amount) - 5 - 5), `${r.status} ${r.reason}`);

    section('a fee lowered in a fixed-term schedule edit');
    const { m: fe } = await member();
    const fxe = await disbursed(fe.id, 'FXE', 3000, 3, '2026-09-01');
    await call('POST', `/api/loans/${fxe.id}/fees`, { fee: 'VISIT', installmentNumber: 3 });
    const ed = (await call('GET', `/api/loans/${fxe.id}/schedule/editable`)).body;
    r = await call('PUT', `/api/loans/${fxe.id}/schedule`, { installments: ed.installments.map((i, k) => ({ fee: k === ed.installments.length - 1 ? 10 : i.fee })) });
    check('the difference is written off (Fee Due Reduce)', r.status === 200 && r.body.feeDueReduced === 40 && round(bal(await loanRow(fxe.id)).fees) === 10,
      `${r.status} ${r.reason} ${JSON.stringify(r.body).slice(0, 200)}`);
    r = await call('PUT', `/api/loans/${fxe.id}/schedule`, { installments: ed.installments.map((i, k) => ({ fee: k === ed.installments.length - 1 ? 90 : i.fee })) });
    check('an edit cannot raise a fee', r.status === 400 && /FEES_MUST_STILL_ADD_UP/.test(r.reason), r.reason);

    // ----------------------------------------------------------------------
    section('changing a running loan\'s rate');
    const { m: rc } = await member();
    const rt = await disbursed(rc.id, 'DYN', 3000, 3, '2026-09-01');
    await accrue(rt.id, '2026-09-15');
    r = await call('POST', `/api/loans/${rt.id}/interest-rate`, { rate: 2, effectiveFrom: '2026-09-10' });
    check('a change before the day interest is accrued to is refused', r.status === 409 && /BEFORE_INTEREST_ALREADY_ACCRUED/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${rt.id}/interest-rate`, { rate: 2, effectiveFrom: '2026-09-15', note: 'repriced' });
    let rl2 = await loanRow(rt.id);
    check('from the day interest is accrued to, the new rate is in force', r.status === 201 && Number(rl2.monthly_rate) === 2 && r.body.applied?.newRate === 2,
      `${r.status} ${r.reason} ${rl2.monthly_rate}`);
    const rh = (await call('GET', `/api/loans/${rt.id}/rates`)).body;
    check('the loan now has rate periods from disbursement, and the change is recorded', rh.periods.length === 2 && rh.changes.length >= 1);
    check('with a non-financial transaction', (await txs(rt.id)).some((t) => t.kind === 'LOAN_RATE_CHANGED' && Number(t.amount) === 0));
    r = await call('POST', `/api/loans/${rt.id}/interest-rate`, { rate: 3, effectiveFrom: '2026-12-01' });
    rl2 = await loanRow(rt.id);
    check('a change dated ahead waits for its day', r.status === 201 && r.body.applied === null && Number(rl2.monthly_rate) === 2, `${r.status} ${r.reason}`);
    await repay(rt.id, 100, '2026-09-20');
    r = await call('POST', `/api/loans/${rt.id}/interest-rate`, { rate: 1.5, effectiveFrom: '2026-09-18' });
    check('a change dated before a repayment is refused', r.status === 409 && /BEFORE_A_REPAYMENT/.test(r.reason), r.reason);
    check('an interest-free loan has no rate to change', (await call('POST', `/api/loans/${pn.id}/interest-rate`, { rate: 1 })).status === 409);

    // ----------------------------------------------------------------------
    section('payment holidays');
    const { m: h1 } = await member();
    const hs = await disbursed(h1.id, 'FXE', 6000, 6, '2026-09-01');
    const hn = await disbursed(h1.id, 'FXE', 6000, 6, '2026-09-01');
    const ha = await disbursed(h1.id, 'FXE', 6000, 6, '2026-09-01');
    const hp = await disbursed(h1.id, 'FXE', 6000, 6, '2026-09-01');
    const plain = await sched(hs.id);
    const hold = async (id, body) => call('POST', `/api/loans/${id}/payment-holiday`, { from: 2, count: 1, ...body });
    const rS = await hold(hs.id, { interest: 'SPREAD' });
    const rN = await hold(hn.id, { interest: 'NONE' });
    const rA = await hold(ha.id, { interest: 'APPLY_LATER' });
    const sumI = async (id) => round((await sched(id)).reduce((a, i) => a + Number(i.interest_due), 0));
    check('no principal, no interest: the installment falls due with nothing and the schedule gains one', rS.status === 201 && (await sched(hs.id)).length === 7
      && Number((await sched(hs.id))[1].principal_due) === 0 && (await sched(hs.id))[1].payment_holiday, `${rS.status} ${rS.reason}`);
    check('the holiday\'s interest spread over the installments after it, or not charged', rN.status === 201 && await sumI(hs.id) > await sumI(hn.id),
      `${await sumI(hs.id)} ${await sumI(hn.id)}`);
    check('or held until applied', rA.status === 201 && rA.body.heldInterest > 0 && Number((await loanRow(ha.id)).holiday_interest_pending) === rA.body.heldInterest
      && await sumI(ha.id) === await sumI(hn.id), `${rA.status} ${rA.reason} ${rA.body?.heldInterest}`);
    r = await call('POST', `/api/loans/${ha.id}/holiday-interest`, {});
    check('applying it puts it on the installments to come', r.status === 201 && Number((await loanRow(ha.id)).holiday_interest_pending) === 0
      && round(await sumI(ha.id) - await sumI(hn.id)) === rA.body.heldInterest, `${r.status} ${r.reason}`);
    check('with nothing held, applying is refused', (await call('POST', `/api/loans/${ha.id}/holiday-interest`, {})).status === 409);
    r = await hold(hp.id, { kind: 'PRINCIPAL_NO_INTEREST', count: 2 });
    const pps = await sched(hp.id);
    check('principal, no interest: the installments keep their principal and carry no interest; the term does not change', r.status === 201
      && pps.length === 6 && Number(pps[1].principal_due) === Number(plain[1].principal_due) && Number(pps[1].interest_due) === 0
      && Number(pps[2].interest_due) === 0 && Number(pps[3].interest_due) === Number(plain[3].interest_due), `${r.status} ${r.reason}`);
    check('an unknown kind is refused', (await hold(hs.id, { from: 4, kind: 'SOME_INTEREST' })).status === 400);
    const { m: h2 } = await member();
    const dh = await disbursed(h2.id, 'DYE', 3000, 3, '2026-09-01');
    const dt = await disbursed(h2.id, 'DYE', 3000, 3, '2026-09-01');
    r = await call('POST', `/api/loans/${dh.id}/payment-holiday`, { from: 1, count: 1, interest: 'NONE' });
    await accrue(dh.id, '2026-09-25');
    await accrue(dt.id, '2026-09-25');
    check('on a dynamic loan interest not charged in a holiday does not accrue through it', r.status === 201
      && Number((await loanRow(dh.id)).interest_accrued) === 0 && Number((await loanRow(dt.id)).interest_accrued) > 0,
      `${r.status} ${r.reason} ${(await loanRow(dh.id)).interest_accrued} ${(await loanRow(dt.id)).interest_accrued}`);

    // ----------------------------------------------------------------------
    section('revolving installments added by hand');
    const { m: rv1 } = await member();
    const ra = await apply(rv1.id, 'REV', 1000, 12);
    r = await call('POST', `/api/loans/${ra.id}/revolving-installments`, { dueDate: '2026-01-20' });
    check('an installment is added on the application', r.status === 201, `${r.status} ${r.reason}`);
    await approve(ra.id);
    await disburse(ra.id, 1000, '2026-01-01');
    await call('POST', `/api/loans/${ra.id}/revolving-installments`, { dueDate: '2026-02-25' });
    let rs = (await call('GET', `/api/loans/${ra.id}/revolving-schedule`)).body;
    check('the schedule shows them pending, and the product\'s dates resume after the last', rs.addedByHand.length === 2
      && rs.addedByHand.every((x) => x.status === 'PENDING') && rs.nextProductBilling === '2026-03-01', JSON.stringify(rs));
    await T((c) => RV.billAll(c, { asOf: '2026-01-20' }));
    await T((c) => RV.billAll(c, { asOf: '2026-02-01' }));
    let ri = await sched(ra.id);
    check('the first is filled on its date; the product date it replaces is not billed', ri.length === 1 && S(ri[0].due_date) === '2026-01-20'
      && Number(ri[0].principal_due) === 100, ri.map((i) => `${S(i.due_date)}:${i.principal_due}`).join(' '));
    r = await call('POST', `/api/loans/${ra.id}/revolving-installments`, { dueDate: '2026-01-15' });
    check('one cannot be added before an installment already billed', r.status === 409 && /AFTER_THE_LAST_INSTALLMENT/.test(r.reason), r.reason);
    const added = await call('POST', `/api/loans/${ra.id}/revolving-installments`, { dueDate: '2026-02-27' });
    r = await call('DELETE', `/api/loans/${ra.id}/revolving-installments/${added.body.id}`);
    check('one not yet billed may be removed', r.status === 200);
    await T((c) => RV.billAll(c, { asOf: '2026-03-01' }));
    ri = await sched(ra.id);
    check('then the second, then the product resumes', ri.map((i) => S(i.due_date)).join() === '2026-01-20,2026-02-25,2026-03-01',
      ri.map((i) => S(i.due_date)).join());
    rs = (await call('GET', `/api/loans/${ra.id}/revolving-schedule`)).body;
    const billed = (await Rd((c) => c.query('SELECT id FROM loan_billing_dates WHERE loan_id = $1 AND billed_at IS NOT NULL LIMIT 1', [ra.id]))).rows[0];
    check('a billed one cannot be removed', (await call('DELETE', `/api/loans/${ra.id}/revolving-installments/${billed.id}`)).status === 409);
    const { m: rv2 } = await member();
    const rz = await disbursed(rv2.id, 'REV', 1000, 12, '2026-01-01');
    await repay(rz.id, 1001, '2026-01-02');
    await call('POST', `/api/loans/${rz.id}/revolving-installments`, { dueDate: '2026-01-10' });
    await T((c) => RV.billAll(c, { asOf: '2026-01-10' }));
    const rzs = await sched(rz.id);
    check('an installment added by hand with nothing to bill is marked GRACE', rzs.length === 1 && rzs[0].status === 'GRACE', rzs.map((i) => i.status).join());

    // ----------------------------------------------------------------------
    section('guarantors on a running loan');
    const { m: g0, accounts: [g0a] } = await member({ deposit: 100 });
    const { m: gA } = await member({ deposit: 10000 });
    const { m: gB } = await member({ deposit: 10000 });
    const gl = await apply(g0.id, 'COV', 3000, 3);
    await T((c) => L.addGuarantor(c, gl.id, { memberId: gA.id, amount: 3000 }));
    await approve(gl.id);
    await disburse(gl.id, 3000, '2026-01-01');
    r = await call('POST', `/api/loans/${gl.id}/guarantors`, { memberId: gB.id, amount: 1000 });
    check('a guarantor is added to a running loan', r.status === 201, `${r.status} ${r.reason}`);
    const gRows = (await call('GET', `/api/loans/${gl.id}/guarantors`)).body;
    const ga = gRows.find((g) => g.member_id === gA.id);
    const gb = gRows.find((g) => g.member_id === gB.id);
    r = await call('DELETE', `/api/loans/${gl.id}/guarantors/${ga.id}`);
    check('removing the guarantee the cover rests on is refused', r.status === 409 && /UNDER_COVER/.test(r.reason), r.reason);
    r = await call('DELETE', `/api/loans/${gl.id}/guarantors/${gb.id}`);
    check('one the loan does not need is removed and their deposits are free', r.status === 200 && r.body.status === 'RELEASED', `${r.status} ${r.reason}`);
    void g0a;

    // ----------------------------------------------------------------------
    section('the member\'s loan history');
    const { m: hm } = await member({ deposit: 10 });
    const onTime = await disbursed(hm.id, 'FX', 3000, 3, '2026-01-01');
    for (const [d, a] of [['2026-02-01', 1030], ['2026-03-01', 1020], ['2026-04-01', 1010]]) { await accrue(onTime.id, d); await repay(onTime.id, a, d); }
    const lateOne = await disbursed(hm.id, 'FX', 1000, 2, '2026-01-01');
    for (const [d, a] of [['2026-02-10', 510], ['2026-03-01', 505]]) { await accrue(lateOne.id, d); await repay(lateOne.id, a, d); }
    const bigOne = await apply(hm.id, 'FX', 9000, 3);
    await call('POST', `/api/loans/${bigOne.id}/reject`, {});
    const hist = (await call('GET', `/api/members/${hm.id}/loan-history`)).body;
    const hOn = hist.closedLoans.find((x) => x.loanId === onTime.id);
    const hLate = hist.closedLoans.find((x) => x.loanId === lateOne.id);
    check('closed loans with how they closed', hist.closedLoans.length === 3 && hOn.closedAs === 'ALL_OBLIGATIONS_MET'
      && hist.closedLoans.find((x) => x.loanId === bigOne.id).closedAs === 'REJECTED', JSON.stringify(hist).slice(0, 300));
    check('the on-time rate: every installment on time, and one of two late', hOn.onTimeRate === 100 && hLate.onTimeRate === 50, `${hOn.onTimeRate} ${hLate.onTimeRate}`);
    check('the overall rate averages the loans', hist.overallOnTimeRate === 75);
    check('the largest amount approved is marked, not the rejected one', hist.maxLoanSize === 3000 && hOn.maxLoanSize === true);
    check('completed loan cycles count the loans closed with all obligations met', hist.completedLoanCycles === 2
      && (await call('GET', `/api/loans/${onTime.id}`)).body.completed_loan_cycles === 2);

    // ----------------------------------------------------------------------
    section('attachments');
    const up = (name, content, extraBody = {}) => call('POST', `/api/loans/${fl.id}/attachments`, { fileName: name, content: Buffer.from(content).toString('base64'), ...extraBody });
    r = await up('agreement.txt', 'signed loan agreement', { title: 'Agreement', description: 'signed at the branch' });
    const att = r.body;
    check('a document is uploaded to the loan', r.status === 201 && att.contentType === 'text/plain' && att.size === 21 && att.previewable, `${r.status} ${r.reason}`);
    check('a name with two periods is refused', (await up('agree.ment.txt', 'x')).status === 400);
    check('a forbidden type is refused', (await up('run.js', 'x')).status === 400);
    check('a name with a forbidden character is refused', (await up('a#b.txt', 'x')).status === 400);
    check('an empty file is refused', (await up('empty.txt', '')).status === 400);
    check('a file that says it is a PDF and is not is refused', (await up('fake.pdf', 'hello')).status === 400);
    check('an encrypted PDF is refused', (await up('locked.pdf', '%PDF-1.7 /Encrypt 1 0 R')).status === 400);
    r = await call('POST', `/api/loans/${fl.id}/attachments?fileName=scan.png&title=ID`, null, { raw: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), type: 'image/png' });
    check('a file may be sent as the raw body', r.status === 201 && r.body.contentType === 'image/png' && r.body.size === 7, `${r.status} ${r.reason}`);
    r = await call('GET', `/api/loans/${fl.id}/attachments/${att.id}/download`);
    check('downloaded as it was uploaded', r.status === 200 && r.text === 'signed loan agreement' && /attachment/.test(r.headers.get('content-disposition')));
    r = await call('GET', `/api/loans/${fl.id}/attachments/${att.id}/preview`);
    check('previewed inline', r.status === 200 && /inline/.test(r.headers.get('content-disposition')));
    r = await call('PATCH', `/api/loans/${fl.id}/attachments/${att.id}`, { title: 'Loan agreement' });
    check('its title is edited', r.status === 200 && r.body.title === 'Loan agreement');
    check('the list has both', (await call('GET', `/api/loans/${fl.id}/attachments`)).body.length === 2);
    r = await call('DELETE', `/api/loans/${fl.id}/attachments/${att.id}`);
    check('and one is deleted', r.status === 200 && (await call('GET', `/api/loans/${fl.id}/attachments`)).body.length === 1);

    // ----------------------------------------------------------------------
    section('interest from arrears');
    const { m: ia } = await member();
    const ial = await disbursed(ia.id, 'DYN', 3000, 3, '2026-01-01');
    await accrue(ial.id, '2026-02-01');
    check('none while nothing is overdue', Number((await loanRow(ial.id)).interest_from_arrears_accrued) === 0);
    const iaS = await sched(ial.id);
    const iaTx = await accrue(ial.id, '2026-03-01');
    const overdue = Number(iaS[0].principal_due);
    const expectA = round(Number(iaTx.amount) * overdue / Number(iaTx.allocation.base));
    check('the interest earned on overdue principal is shown as interest from arrears, part of the interest', Number(iaTx.allocation.interestFromArrears) === expectA
      && Number((await loanRow(ial.id)).interest_from_arrears_accrued) === expectA, `${iaTx.allocation.interestFromArrears} ${expectA}`);
    const bd = (await call('GET', `/api/loans/${ial.id}`)).body.breakdown;
    check('the overview breaks the balances down and shows it due', bd.interestFromArrears.due === expectA && bd.principal.outstanding === 3000
      && bd.interest.outstanding === round(bal(await loanRow(ial.id)).interest), JSON.stringify(bd).slice(0, 200));
    r = await repay(ial.id, 5, '2026-03-01');
    check('it is paid first', r.status === 201 && Number((await loanRow(ial.id)).interest_from_arrears_paid) === Math.min(5, expectA), `${r.status} ${r.reason}`);

    // ----------------------------------------------------------------------
    section('reschedule: capitalising part, reducing the principal, carrying fees, keeping the number');
    const { m: rs1, accounts: [rs1a] } = await member({ deposit: 50 });
    const { m: rsg } = await member({ deposit: 20000 });
    const old = await disbursed(rs1.id, 'LATE', 3000, 3, '2026-01-01');
    await T((c) => L.addGuarantor(c, old.id, { memberId: rsg.id, amount: 1000 })).catch(() => null);
    await T((c) => L.markArrears(c, { asOf: '2026-02-05' }));
    await T(async (c) => require('../src/domain/fees').applyLateFees(c, await L.lock(c, old.id), '2026-02-05'));
    await call('POST', `/api/loans/${old.id}/fees`, { fee: 'LETTER', valueDate: '2026-02-05' });
    const oldNo = (await loanRow(old.id)).account_no;
    const ob = bal(await loanRow(old.id));
    check('(the loan owes a late fee of 25 and a letter of 40)', ob.fees === 65, JSON.stringify(ob));
    const portfolio = await glTotal('100-100');
    r = await call('POST', `/api/loans/${old.id}/reschedule`, {
      termMonths: 6, valueDate: '2026-02-05', principal: 2500, capitalize: { fees: 10 }, keepAccountNo: true, note: 'hardship',
    });
    const nw = r.body.newLoan;
    const ol = await loanRow(old.id);
    check('rescheduled at a reduced principal with part of the fees capitalised', r.status === 201 && Number(nw.principal_disbursed) === 2510,
      `${r.status} ${r.reason} ${nw?.principal_disbursed}`);
    check('the late fee moves to the new loan as a fee, not capitalised', round(Number(nw.fees_due)) === 25, String(nw?.fees_due));
    check('the rest written off: 500 of principal and 30 of fees', (await txs(old.id)).some((t) => t.kind === 'LOAN_BALANCE_WRITE_OFF'
      && Number(t.allocation.principal) === 500 && Number(t.allocation.fees) === 30));
    check('the new loan takes the account number; the old one is renumbered', nw.account_no === oldNo && ol.account_no !== oldNo && ol.previous_account_no === oldNo,
      `${nw.account_no} ${ol.account_no} ${ol.previous_account_no}`);
    check('the old loan is closed as rescheduled', ol.status === 'CLOSED_RESCHEDULED');
    r = await call('POST', `/api/loans/${nw.id}/undo-restructure`, { note: 'wrong terms' });
    const back = await loanRow(old.id);
    const gone = await loanRow(nw.id);
    check('undo: the original loan is running again as it was', r.status === 200 && ['ACTIVE', 'IN_ARREARS'].includes(back.status)
      && bal(back).principal === 3000 && bal(back).fees === 65, `${r.status} ${r.reason} ${back.status} ${JSON.stringify(bal(back))}`);
    check('with its account number back, and the new loan withdrawn', back.account_no === oldNo && gone.status === 'CLOSED_WITHDRAWN' && gone.account_no !== oldNo,
      `${back.account_no} ${gone.account_no}`);
    check('the portfolio is as it was', await glTotal('100-100') === portfolio, `${portfolio} ${await glTotal('100-100')}`);
    check('the restructure is marked reversed', (await txs(old.id)).find((t) => t.kind === 'LOAN_RESCHEDULE').reversed_by !== null);
    const r2x = await call('POST', `/api/loans/${old.id}/reschedule`, { termMonths: 6, valueDate: '2026-02-05' });
    await repay(r2x.body.newLoan.id, 100, '2026-02-20');
    r = await call('POST', `/api/loans/${r2x.body.newLoan.id}/undo-restructure`, {});
    check('once the new loan has taken a repayment, undo is refused', r.status === 409 && /NEW_LOAN_HAS_TRANSACTIONS/.test(r.reason), r.reason);
    void rs1a;

    section('refinance: kept number and undo');
    const { m: rf1 } = await member({ deposit: 10000 });
    const rold = await disbursed(rf1.id, 'FX', 3000, 3, '2026-01-01');
    const rfNo = (await loanRow(rold.id)).account_no;
    r = await call('POST', `/api/loans/${rold.id}/refinance`, { topUp: 1000, termMonths: 6, keepAccountNo: true });
    const appId = r.body.application.id;
    check('the top-up application keeps its settlement terms', r.status === 201 && r.body.quote.keepAccountNo === true, `${r.status} ${r.reason}`);
    await call('POST', `/api/loans/${appId}/approve`, {});
    const bank = await glTotal('100-210');
    r = await call('POST', `/api/loans/${appId}/disbursements`, { channelId: 'bank', valueDate: '2026-01-10' });
    check('paid out, the new loan takes the number', r.status === 201 && (await loanRow(appId)).account_no === rfNo, `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${appId}/undo-restructure`, {});
    check('undo takes the top-up back and the original runs again with its number', r.status === 200 && (await loanRow(rold.id)).account_no === rfNo
      && (await loanRow(rold.id)).status === 'ACTIVE' && await glTotal('100-210') === bank, `${r.status} ${r.reason} ${await glTotal('100-210')} ${bank}`);

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

function S(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
