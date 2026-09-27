#!/usr/bin/env node
'use strict';

/**
 * Closing and exiting a loan account, after the reference platform's pages of that name:
 * locks that suspend only some activities and a change to them while
 * locked; penalties after an unlock (locked days forfeited, penalties on the
 * outstanding principal applied on the next due date); deleting a loan made
 * by mistake; a loan name; undoing a closure; collecting securities before a
 * write-off; the pay-off, loan adjustment and collect securities
 * permissions; and a pay-off preview for a date to come.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const P = require('../src/domain/penalties');
const SV = require('../src/domain/savings');
const LC = require('../src/domain/loanClosures');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'closeexit';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4103;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

let server;
let token;
async function call(method, p, body) {
  const headers = { 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text, reason: d?.errors?.[0]?.errorReason || '', source: d?.errors?.[0]?.errorSource || '' };
}
const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200', glInterestRec: '100-300', glPenaltyInc: '400-200' };
const BASE = { ...GL, accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', enforceDepositMultiplier: false, maxTerm: 36,
  monthlyRate: 1, productType: 'FIXED_TERM', method: 'REDUCING', nonWorkingDays: 'DO_NOT_RESCHEDULE' };
const mk = (id, body = {}) => call('POST', '/api/loan-products', { id, name: id, ...BASE, ...body });
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
const savRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [id])).rows[0]);
const txs = (id) => Rd(async (c) => (await c.query('SELECT * FROM transactions WHERE loan_account_id = $1 ORDER BY created_at', [id])).rows);
const guarantors = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_guarantors WHERE loan_id = $1 ORDER BY created_at', [id])).rows);
const charges = (id) => Rd(async (c) => (await c.query('SELECT * FROM penalty_charges WHERE loan_id = $1 AND reversed_at IS NULL ORDER BY charged_on, created_at', [id])).rows);
let seq = 0;
const member = ({ deposit = 0 } = {}) => T(async (c) => {
  seq += 1;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'C',$1) RETURNING *`,
    [`C${String(seq).padStart(4, '0')}`])).rows[0];
  const a = await SV.open(c, { memberId: m.id, productId: 'SAV01' });
  if (deposit > 0) await SV.deposit(c, a.id, { amount: deposit, channelId: 'cash', valueDate: '2025-12-01', createdBy: 'test' });
  return { m, a };
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
const arrears = (on, loanId) => T((c) => L.markArrears(c, { asOf: on, loanId }));
const penalise = (id, on) => T((c) => P.accrueForLoan(c, id, { asOf: on }));

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Closing SACCO', mfaRequiredRoles: [], adminEmail: 'admin@closeexit.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@closeexit.local', password: PASSWORD })).body.accessToken;
    const made = await Promise.all([
      mk('FX'),
      mk('PENOUT', { penaltyBasis: 'OUTSTANDING_PRINCIPAL', penaltyRate: 36.5, rateFrequency: 'PER_YEAR', monthlyRate: 12, dayCount: 'ACTUAL_365' }),
      mk('PEN', { productType: 'INTEREST_FREE', monthlyRate: 0, penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 1 }),
    ]);
    check('products', made.every((r) => r.status === 201), made.map((r) => `${r.status} ${r.source} ${r.reason}`).join('|'));

    // ----------------------------------------------------------------------
    section('a lock that suspends only some activities');
    const { m: k1 } = await member();
    const kl = await disbursed(k1.id, 'FX', 3000, 3, '2026-01-01');
    await accrue(kl.id, '2026-01-10');
    let r = await call('POST', `/api/loans/${kl.id}/lock`, { note: 'dispute', valueDate: '2026-01-10', suspend: { interest: false } });
    let row = await loanRow(kl.id);
    check('a lock that leaves interest running', r.status === 200 && row.status === 'LOCKED' && row.lock_interest === false && row.lock_fees && row.lock_penalties,
      `${r.status} ${r.reason}`);
    let t = await accrue(kl.id, '2026-01-15');
    check('keeps accruing interest while locked', t && Number(t.amount) > 0, JSON.stringify(t));
    check('the lock is listed with the loan\'s transactions, suspending what it says',
      (await txs(kl.id)).some((x) => x.kind === 'LOAN_LOCKED' && Number(x.amount) === 0 && x.allocation.suspend.interest === false));
    r = await call('POST', `/api/loans/${kl.id}/lock-settings`, { suspend: { interest: true, fees: true, penalties: true }, valueDate: '2026-01-15' });
    row = await loanRow(kl.id);
    check('what it suspends can be changed while it stays locked', r.status === 200 && row.lock_interest === true && row.status === 'LOCKED', `${r.status} ${r.reason}`);
    t = await accrue(kl.id, '2026-01-20');
    check('and then interest stops', t === null, JSON.stringify(t));
    check('the change is listed too', (await txs(kl.id)).some((x) => x.kind === 'LOAN_LOCK_CHANGED'));
    r = await call('POST', `/api/loans/${kl.id}/unlock`, { valueDate: '2026-01-20' });
    row = await loanRow(kl.id);
    check('unlocking lifts everything and is listed', r.status === 200 && row.status === 'ACTIVE' && (await txs(kl.id)).some((x) => x.kind === 'LOAN_UNLOCKED'),
      `${r.status} ${r.reason} ${row.status}`);
    check('the lock settings cannot be changed on a loan that is not locked',
      (await call('POST', `/api/loans/${kl.id}/lock-settings`, { suspend: { interest: false } })).status === 409);

    // ----------------------------------------------------------------------
    section('penalties on the outstanding principal after an unlock');
    const { m: p1 } = await member();
    const po = await disbursed(p1.id, 'PENOUT', 3000, 3, '2026-01-01');
    await arrears('2026-02-05', po.id);
    let ch = await penalise(po.id, '2026-02-05');
    check('charged before the lock: four days at 3 a day', ch.length === 1 && Number(ch[0].amount) === 12, JSON.stringify(ch.map((x) => x.amount)));
    await call('POST', `/api/loans/${po.id}/lock`, { valueDate: '2026-02-05' });
    ch = await penalise(po.id, '2026-02-10');
    check('locked: nothing applied, five days accrued', ch.length === 0 && Number((await loanRow(po.id)).penalty_unapplied) === 15,
      String((await loanRow(po.id)).penalty_unapplied));
    r = await call('POST', `/api/loans/${po.id}/unlock`, { valueDate: '2026-02-11' });
    row = await loanRow(po.id);
    check('unlocked: what accrued while locked waits for the next installment due date', r.status === 200
      && Number(row.penalty_deferred) === 15 && String(row.penalty_deferred_until).length && new Date(row.penalty_deferred_until).toISOString().slice(0, 10) === '2026-03-01'
      && Number(row.penalty_unapplied) === 0, `${r.status} ${r.reason} ${row.penalty_deferred} ${row.penalty_deferred_until}`);
    ch = await penalise(po.id, '2026-02-12');
    check('penalties run again from the unlock date', ch.length === 1 && ch[0].days_charged === 2 && Number(ch[0].amount) === 6,
      JSON.stringify(ch.map((x) => [x.amount, x.days_charged])));
    await arrears('2026-03-01', po.id);
    ch = await penalise(po.id, '2026-03-01');
    const dfr = ch.find((x) => x.deferred);
    row = await loanRow(po.id);
    check('and on the due date the locked-period penalty is applied on that installment', dfr && Number(dfr.amount) === 15 && dfr.days_charged === 0
      && Number(row.penalty_deferred) === 0 && !row.penalty_deferred_until, JSON.stringify(ch.map((x) => [x.amount, x.days_charged, x.deferred])));

    section('penalties on an overdue balance after an unlock');
    const { m: p2 } = await member();
    const pv = await disbursed(p2.id, 'PEN', 3000, 3, '2026-01-01');
    await arrears('2026-02-04', pv.id);
    await penalise(pv.id, '2026-02-04');
    await call('POST', `/api/loans/${pv.id}/lock`, { valueDate: '2026-02-04' });
    await penalise(pv.id, '2026-02-09');
    await call('POST', `/api/loans/${pv.id}/unlock`, { valueDate: '2026-02-10' });
    const all = await charges(pv.id);
    const forfeit = all.filter((x) => x.forfeited);
    check('the locked days are forfeited and never charged', forfeit.length === 1 && forfeit[0].days_charged === 5 && Number(forfeit[0].amount) === 0
      && Number((await loanRow(pv.id)).penalty_deferred) === 0, JSON.stringify(all.map((x) => [x.amount, x.days_charged, x.forfeited])));

    // ----------------------------------------------------------------------
    section('a loan name, and deleting a loan made by mistake');
    const { m: d1 } = await member();
    r = await call('POST', '/api/loans', { memberId: d1.id, productId: 'FX', principal: 2000, termMonths: 3, name: 'Motorbike loan' });
    const dl = r.body;
    check('an application takes a name', r.status === 201 && dl.name === 'Motorbike loan', `${r.status} ${r.reason}`);
    r = await call('DELETE', `/api/loans/${dl.id}`, { note: 'wrong member' });
    check('an application nothing was posted to can be deleted', r.status === 200 && !(await loanRow(dl.id)), `${r.status} ${r.reason}`);
    check('and the deletion is audited', (await Rd((c) => c.query("SELECT 1 FROM audit_log WHERE action = 'LOAN_DELETED' AND entity_id = $1", [dl.id]))).rowCount === 1);
    const rj = await apply(d1.id, 'FX', 2000, 3);
    await call('POST', `/api/loans/${rj.id}/reject`, { note: 'no' });
    check('so can a rejected one', (await call('DELETE', `/api/loans/${rj.id}`)).status === 200);
    const act = await disbursed(d1.id, 'FX', 2000, 3, '2026-01-01');
    r = await call('DELETE', `/api/loans/${act.id}`);
    check('a disbursed loan cannot be deleted', r.status === 409 && /LOAN_NOT_DELETABLE/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('PATCH', `/api/loans/${act.id}`, { name: 'School fees' });
    check('the name can be changed on a running loan', r.status === 200 && (await loanRow(act.id)).name === 'School fees', `${r.status} ${r.reason}`);

    // ----------------------------------------------------------------------
    section('pay-off permissions, a preview for a date to come, and undo closure');
    const { m: u1 } = await member();
    const { m: ug } = await member({ deposit: 5000 });
    const ul = await apply(u1.id, 'FX', 3000, 3);
    await T((c) => L.addGuarantor(c, ul.id, { memberId: ug.id, amount: 1000, createdBy: 'officer' }));
    await approve(ul.id);
    await disburse(ul.id, 3000, '2026-01-01');
    await accrue(ul.id, '2026-01-20');
    const qNow = (await call('GET', `/api/loans/${ul.id}/pay-off`)).body;
    const later = addDays(today(), 30);
    const qLater = (await call('GET', `/api/loans/${ul.id}/pay-off?valueDate=${later}`)).body;
    check('the pay-off preview for a date to come includes what accrues by then', qLater.valueDate === later && qLater.interest > qNow.interest,
      `${qNow.interest} ${qLater.interest}`);
    const kept = await loanRow(ul.id);
    check('and changes nothing', kept.status === 'ACTIVE' && new Date(kept.accrued_through).toISOString().slice(0, 10) === '2026-01-20');
    await call('PATCH', '/api/loans/controls', { payOffRoles: ['MANAGER'] });
    r = await call('POST', `/api/loans/${ul.id}/pay-off`, { channelId: 'cash' });
    check('a pay-off needs the pay-off permission', r.status === 403 && /PAY_OFF_NOT_PERMITTED/.test(r.reason), `${r.status} ${r.reason}`);
    await call('PATCH', '/api/loans/controls', { payOffRoles: null, loanAdjustmentRoles: ['MANAGER'] });
    r = await call('POST', `/api/loans/${ul.id}/pay-off`, { channelId: 'cash', interest: 0 });
    check('writing charges off in it needs the loan adjustment permission', r.status === 403 && /LOAN_ADJUSTMENT_NOT_PERMITTED/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${ul.id}/reduce-balance`, { component: 'PENALTY', amount: 1 });
    check('so does reducing a balance', r.status === 403 && /LOAN_ADJUSTMENT_NOT_PERMITTED/.test(r.reason), `${r.status} ${r.reason}`);
    await call('PATCH', '/api/loans/controls', { loanAdjustmentRoles: null });
    r = await call('POST', `/api/loans/${ul.id}/pay-off`, { channelId: 'cash' });
    check('paid off, the loan closes and its guarantor is released', r.status === 201 && (await loanRow(ul.id)).status === 'CLOSED_REPAID'
      && (await guarantors(ul.id))[0].status === 'RELEASED', `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${ul.id}/undo-close`, { note: 'paid by mistake' });
    row = await loanRow(ul.id);
    check('undo closure reopens it', r.status === 200 && ['ACTIVE', 'IN_ARREARS'].includes(row.status) && !row.closure, `${r.status} ${r.reason} ${row.status}`);
    check('with its guarantor pledged again', (await guarantors(ul.id))[0].status === 'PLEDGED');
    check('and a non-financial transaction', (await txs(ul.id)).some((x) => x.kind === 'LOAN_CLOSURE_UNDONE' && Number(x.amount) === 0));
    check('a running loan has no closure to undo', (await call('POST', `/api/loans/${ul.id}/undo-close`, {})).status === 409);

    // ----------------------------------------------------------------------
    section('collect securities before a write-off');
    const { m: w1 } = await member();
    const { m: wg, a: wga } = await member({ deposit: 5000 });
    const wl = await apply(w1.id, 'FX', 3000, 3);
    await T((c) => L.addGuarantor(c, wl.id, { memberId: wg.id, amount: 2000, createdBy: 'officer' }));
    await approve(wl.id);
    await disburse(wl.id, 3000, '2026-01-01');
    await T((c) => c.query("UPDATE savings_products SET withdrawable = false WHERE id = 'SAV01'"));
    await call('PATCH', '/api/loans/controls', { collectSecuritiesRoles: ['MANAGER'] });
    r = await call('POST', `/api/loans/${wl.id}/write-off`, { reason: 'absconded', collectSecurities: true, valueDate: '2026-03-01' });
    check('asking to collect securities needs the permission', r.status === 403 && /COLLECT_SECURITIES_NOT_PERMITTED/.test(r.reason), `${r.status} ${r.reason}`);
    await call('PATCH', '/api/loans/controls', { collectSecuritiesRoles: null });
    r = await call('POST', `/api/loans/${wl.id}/write-off`, { reason: 'absconded', collectSecurities: true, valueDate: '2026-03-01' });
    check('the request records it', r.status === 201 && r.body.request.collect_securities === true, `${r.status} ${r.reason}`);
    const owedBefore = L.balances(await loanRow(wl.id)).total;
    const out = await T((c) => LC.approveWriteOff(c, wl.id, { createdBy: 'second-approver' }));
    row = await loanRow(wl.id);
    check('on approval the pledge is taken from the guarantor\'s deposits first, withdrawable or not', out.collected && out.collected.total === 2000
      && Number((await savRow(wga.id)).balance) === 3000, JSON.stringify(out.collected));
    const col = (await txs(wl.id)).find((x) => x.kind === 'LOAN_REPAYMENT' && x.allocation.securityCollected);
    check('as a repayment through the transfer channel, linked to the withdrawal', col && Number(col.amount) === 2000 && col.channel_id === 'transfer'
      && col.allocation.transfer && col.allocation.transfer.savingsReference);
    check('the pledge is recovered in full', (await guarantors(wl.id))[0].status === 'RECOVERED' && Number((await guarantors(wl.id))[0].recovered) === 2000);
    check('and the rest is written off', row.status === 'CLOSED_WRITTEN_OFF' && round(Number(row.written_off_amount)) === round(owedBefore - 2000),
      `${row.status} ${row.written_off_amount} ${owedBefore}`);
    check('the guarantor\'s other deposits are free again', (await T((c) => SV.pledgedAmount(c, wg.id))) === 0);
    await T((c) => c.query("UPDATE savings_products SET withdrawable = true WHERE id = 'SAV01'"));
  } catch (e) {
    fail++; failures.push(e.stack); console.error(e);
  } finally {
    server.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
    process.exit(fail ? 1 : 0);
  }
})();
