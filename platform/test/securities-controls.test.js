#!/usr/bin/env node
'use strict';

/**
 * Securities, internal controls and settlement deposit accounts, after
 * Mambu's "Configure securities and controls": the securities cover checked
 * at approval and disbursement and whether deposits count; closing loans
 * that owe nothing; accrued charges in the cap; posting on a locked loan;
 * charges on a cap-locked loan applied when it is unlocked; and settlement
 * accounts linked by hand, auto-set and auto-created, the end-of-day
 * transfer under each settlement option, the order of several loans on one
 * account, and the branch rules.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const P = require('../src/domain/penalties');
const W = require('../src/domain/workflow');
const SV = require('../src/domain/savings');
const BR = require('../src/domain/branches');
const SETTLE = require('../src/domain/settlement');
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

const SLUG = 'secctltest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4101;
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
const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200', glInterestRec: '100-300', glPenaltyInc: '400-200' };
const BASE = { ...GL, accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', enforceDepositMultiplier: false, maxTerm: 36,
  monthlyRate: 1, productType: 'FIXED_TERM', method: 'REDUCING', nonWorkingDays: 'DO_NOT_RESCHEDULE' };
const mk = (id, body = {}) => call('POST', '/api/loan-products', { id, name: id, ...BASE, ...body });
const sched = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id])).rows);
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
const savRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [id])).rows[0]);
const glTotal = (code) => Rd(async (c) => Number((await c.query(
  `SELECT COALESCE(sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS b FROM journal_lines WHERE gl_code = $1`, [code])).rows[0].b));
let seq = 0;
/** A member, with an ordinary savings account holding `deposit` unless `accounts` is 0. */
const member = ({ deposit = 0, accounts = 1, branchId = null } = {}) => T(async (c) => {
  seq += 1;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name, branch_id) VALUES ($1,'S',$1,$2) RETURNING *`,
    [`S${String(seq).padStart(4, '0')}`, branchId])).rows[0];
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

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Controls SACCO', mfaRequiredRoles: [], adminEmail: 'admin@secctltest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@secctltest.local', password: PASSWORD })).body.accessToken;
    await call('PUT', '/api/accounting/inter-branch-rules', { rules: [{ id: 'DEFAULT', glCode: '290-100' }] });
    await T((c) => c.query("INSERT INTO savings_products (id, name, annual_rate, gl_liability, gl_interest_exp, gl_fee_inc, allow_overdraft, max_overdraft_limit) VALUES ('ODSAV','Overdraft savings',0,'200-100','500-100','400-200', true, 10000)"));
    await T((c) => c.query("INSERT INTO savings_products (id, name, annual_rate, accounting_method, gl_liability) VALUES ('OFFBK','Off the books',0,'NONE', NULL)"));
    const made = await Promise.all([
      mk('COV', { requireGuarantorCover: true, minCoverPercent: 100, coverCountsDeposits: false }),
      mk('COVD', { requireGuarantorCover: true, minCoverPercent: 100 }),
      mk('REV', { productType: 'REVOLVING', revolvingRepaymentMethod: 'PRINCIPAL_PERCENT', revolvingRepaymentValue: 10, autoClosePaidOffDays: 5 }),
      mk('CAPA', { productType: 'INTEREST_FREE', monthlyRate: 0, penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 1, penaltyToleranceDays: 30,
        chargeCapPercent: 1, chargeCapBase: 'OUTSTANDING_PRINCIPAL', chargeCapMode: 'HARD', capIncludesAccrued: true }),
      mk('CAPN', { productType: 'INTEREST_FREE', monthlyRate: 0, penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 1, penaltyToleranceDays: 30,
        chargeCapPercent: 1, chargeCapBase: 'OUTSTANDING_PRINCIPAL', chargeCapMode: 'HARD' }),
      mk('CAPH', { productType: 'INTEREST_FREE', monthlyRate: 0, penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 1,
        chargeCapPercent: 1, chargeCapBase: 'OUTSTANDING_PRINCIPAL', chargeCapMode: 'HARD' }),
      mk('SETS', { settlementEnabled: true, settlementProductId: 'SAV01', settlementAutoSet: true }),
      mk('SETC', { settlementEnabled: true, settlementProductId: 'SAV01', settlementAutoCreate: true }),
      mk('SETF', { settlementEnabled: true }),
      mk('SETP', { settlementEnabled: true, settlementOption: 'PARTIAL' }),
      mk('SETN', { settlementEnabled: true, settlementOption: 'NONE' }),
    ]);
    check('products', made.every((r) => r.status === 201), made.map((r) => `${r.status} ${r.source}`).join('|'));
    check('auto-set needs a settlement product', (await mk('BAD1', { settlementEnabled: true, settlementAutoSet: true })).status === 400);
    check('settlement options need settlement turned on', (await mk('BAD2', { settlementProductId: 'SAV01' })).status === 400);
    check('a deposit product with overdrafts is linked by hand only',
      (await mk('BAD3', { settlementEnabled: true, settlementProductId: 'ODSAV', settlementAutoSet: true })).status === 400);
    check('the product shows its settings', made[6].body.settlement.autoSet === true && made[0].body.coverCountsDeposits === false && made[3].body.capIncludesAccrued === true);

    // ----------------------------------------------------------------------
    section('securities cover');
    const { m: borrower } = await member({ deposit: 10000 });
    const { m: guarantor } = await member({ deposit: 20000 });
    const cv = await apply(borrower.id, 'COV', 5000, 6);
    await throws('with own deposits not counted, 10,000 of deposits give no cover', () => approve(cv.id), (e) => /INSUFFICIENT_GUARANTOR_COVER/.test(e.message));
    await T((c) => L.addGuarantor(c, cv.id, { memberId: guarantor.id, amount: 5000 }));
    await approve(cv.id);
    check('a guarantee for the whole amount covers it', (await loanRow(cv.id)).status === 'APPROVED');
    await T((c) => c.query("UPDATE loan_guarantors SET status = 'RELEASED' WHERE loan_id = $1", [cv.id]));
    await throws('the guarantee released after approval: disbursement is refused', () => disburse(cv.id, 5000, '2026-01-01'),
      (e) => /INSUFFICIENT_GUARANTOR_COVER_AT_DISBURSEMENT/.test(e.message));
    const cd = await apply(borrower.id, 'COVD', 5000, 6);
    await approve(cd.id);
    const el = (await call('GET', `/api/loans/${cd.id}/eligibility`)).body;
    check('where the product counts them, own deposits cover the loan', (await loanRow(cd.id)).status === 'APPROVED' && el.depositCover === 10000, JSON.stringify(el).slice(0, 200));

    // ----------------------------------------------------------------------
    section('closing loans that owe nothing');
    const { m: rm } = await member();
    const rv = await disbursed(rm.id, 'REV', 1000, 12, '2026-01-01');
    await call('POST', `/api/loans/${rv.id}/repayments`, { amount: 1001, channelId: 'cash', valueDate: '2026-01-02' });
    check('(a revolving loan paid down to nothing stays active)', (await loanRow(rv.id)).status === 'ACTIVE');
    let ctl = await T((c) => W.enforceControls(c, { asOf: '2026-01-05' }));
    check('three days after its last transaction it is left open', (await loanRow(rv.id)).status === 'ACTIVE' && ctl.closed === 0);
    ctl = await T((c) => W.enforceControls(c, { asOf: '2026-01-07' }));
    check('five days after, the end of day closes it', (await loanRow(rv.id)).status === 'CLOSED_REPAID' && ctl.closed === 1, (await loanRow(rv.id)).status);

    // ----------------------------------------------------------------------
    section('accrued charges in the cap');
    const { m: cm } = await member();
    const ca = await disbursed(cm.id, 'CAPA', 3000, 3, '2026-01-01');
    const cn = await disbursed(cm.id, 'CAPN', 3000, 3, '2026-01-01');
    await T((c) => L.markArrears(c, { asOf: '2026-02-06' }));
    for (const x of [ca, cn]) await T((c) => P.accrueForLoan(c, x.id, { asOf: '2026-02-06' }));
    check('five days late inside a thirty-day penalty tolerance: 50 accrued, nothing applied',
      Number((await loanRow(ca.id)).penalty_unapplied) === 50 && Number((await loanRow(ca.id)).penalty_accrued) === 0);
    await T((c) => W.enforceControls(c, { asOf: '2026-02-06' }));
    check('counting accrued charges, 50 is over the cap of 1% of 3,000 and the loan is locked', (await loanRow(ca.id)).status === 'LOCKED'
      && (await loanRow(ca.id)).locked_reason === 'CAPPED', (await loanRow(ca.id)).status);
    check('without that option it is not', (await loanRow(cn.id)).status === 'IN_ARREARS', (await loanRow(cn.id)).status);

    // ----------------------------------------------------------------------
    section('posting on a locked loan');
    const { m: lm } = await member();
    const lk = await disbursed(lm.id, 'CAPH', 3000, 3, '2026-01-01');
    await T((c) => W.transition(c, lk.id, 'LOCK', { createdBy: 'manager' }));
    let r = await call('POST', `/api/loans/${lk.id}/repayments`, { amount: 100, channelId: 'cash', valueDate: '2026-01-10' });
    check('refused when no role may post on locked loans', r.status === 409 && /LOAN_IS_LOCKED/.test(r.reason), r.reason);
    check('the roles must be real ones', (await call('PATCH', '/api/loans/controls', { lockedPostingRoles: ['KING'] })).status === 400);
    r = await call('PATCH', '/api/loans/controls', { lockedPostingRoles: ['TENANT_ADMIN', 'MANAGER'] });
    check('the tenant names them', r.status === 200 && r.body.locked_posting_roles.includes('TENANT_ADMIN'), `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${lk.id}/repayments`, { amount: 100, channelId: 'cash', valueDate: '2026-01-10' });
    check('a user with one of them posts, and the loan stays locked', r.status === 201 && (await loanRow(lk.id)).status === 'LOCKED', `${r.status} ${r.reason}`);
    await throws('the end of day and other automatic postings still cannot', () => T((c) => L.repay(c, lk.id, { amount: 10, channelId: 'cash', valueDate: '2026-01-10', createdBy: 'EOD' })),
      (e) => /LOAN_IS_LOCKED/.test(e.message));

    section('a cap-locked loan accrues and is charged when unlocked');
    const { m: hm } = await member();
    const hl = await disbursed(hm.id, 'CAPH', 3000, 3, '2026-01-01');
    await T((c) => L.markArrears(c, { asOf: '2026-02-04' }));
    let ch = await T((c) => P.accrueForLoan(c, hl.id, { asOf: '2026-02-04' }));
    await T((c) => W.enforceControls(c, { asOf: '2026-02-04' }));
    check('three days at 10 a day reach the cap of 30 and the loan is locked', ch.length === 1 && Number(ch[0].amount) === 30
      && (await loanRow(hl.id)).status === 'LOCKED', `${ch.map((x) => x.amount)} ${(await loanRow(hl.id)).status}`);
    ch = await T((c) => P.accrueForLoan(c, hl.id, { asOf: '2026-02-08' }));
    check('locked: nothing applied, the four days accrued', ch.length === 0 && Number((await loanRow(hl.id)).penalty_unapplied) === 40,
      String((await loanRow(hl.id)).penalty_unapplied));
    r = await call('POST', `/api/loans/${hl.id}/repayments`, { amount: 30, channelId: 'cash', valueDate: '2026-02-08' });
    const un = await call('POST', `/api/loans/${hl.id}/unlock`, {});
    check('with the charges paid the cap lock lifts and the count starts again', r.status === 201 && un.status === 200
      && Number((await loanRow(hl.id)).charges_since_arrears) === 0, `${r.status} ${un.status} ${un.reason}`);
    ch = await T((c) => P.accrueForLoan(c, hl.id, { asOf: '2026-02-09' }));
    check('the next run charges the days accrued while locked, up to the cap', ch.length === 1 && ch[0].days_charged === 5 && Number(ch[0].amount) === 30,
      JSON.stringify(ch.map((x) => [x.amount, x.days_charged])));

    // ----------------------------------------------------------------------
    section('settlement accounts: linking');
    const { m: s1, accounts: [s1a] } = await member({ deposit: 500 });
    const auto = await apply(s1.id, 'SETS', 3000, 3);
    check('auto-set links a new loan to the member\'s only account of the product', (await loanRow(auto.id)).settlement_account_id === s1a.id);
    const { m: s2 } = await member({ accounts: 2 });
    const twoAcc = await apply(s2.id, 'SETS', 3000, 3);
    check('a member with two such accounts is left for a person to link', (await loanRow(twoAcc.id)).settlement_account_id === null);
    const { m: s3 } = await member({ accounts: 0 });
    const created = await apply(s3.id, 'SETC', 3000, 3);
    const ca3 = await loanRow(created.id);
    const newAcc = ca3.settlement_account_id ? await savRow(ca3.settlement_account_id) : null;
    check('auto-create opens an account for a member with none, and links it', newAcc && newAcc.member_id === s3.id && newAcc.product_id === 'SAV01');
    const { m: s4, accounts: [s4a] } = await member({ deposit: 2000 });
    const { accounts: [otherAcc] } = await member();
    const man = await disbursed(s4.id, 'SETF', 3000, 3, '2026-01-01');
    r = await call('PUT', `/api/loans/${man.id}/settlement-account`, { savingsAccountId: otherAcc.account_no });
    check('another member\'s account cannot settle the loan', r.status === 409 && /ANOTHER_MEMBER/.test(r.reason), r.reason);
    const off = await T((c) => SV.open(c, { memberId: s4.id, productId: 'OFFBK' }));
    r = await call('PUT', `/api/loans/${man.id}/settlement-account`, { savingsAccountId: off.id });
    check('nor one on a product not linked to the ledger while the loan is', r.status === 409 && /ACCOUNTING_DIFFERS/.test(r.reason), r.reason);
    const br = await T((c) => BR.create(c, { code: 'EAST', name: 'East' }));
    const far = await T((c) => SV.open(c, { memberId: s4.id, productId: 'SAV01', branchId: br.id }));
    r = await call('PUT', `/api/loans/${man.id}/settlement-account`, { savingsAccountId: far.id });
    check('nor one in another branch', r.status === 409 && /ANOTHER_BRANCH/.test(r.reason), r.reason);
    r = await call('PUT', `/api/loans/${man.id}/settlement-account`, { savingsAccountId: s4a.account_no });
    check('the member\'s own account in the same branch links', r.status === 200 && r.body.settlementAccountNo === s4a.account_no, `${r.status} ${r.reason}`);
    check('the loan shows it', (await call('GET', `/api/loans/${man.id}`)).body.settlement_account_no === s4a.account_no);

    section('settlement accounts: the end-of-day transfer');
    await accrue(man.id, '2026-02-01');
    let run = await T((c) => SETTLE.run(c, { asOf: '2026-02-01' }));
    let ms = await sched(man.id);
    check('full dues: 2,000 covers the 1,030 due, which is taken on the due date', run.transferred >= 1 && ms[0].status === 'PAID'
      && Number((await savRow(s4a.id)).balance) === 970, `${JSON.stringify(run)} ${ms[0].status} ${(await savRow(s4a.id)).balance}`);
    check('through the settlement clearing account, which nets to nothing', await glTotal('290-200') === 0, String(await glTotal('290-200')));
    await accrue(man.id, '2026-03-01');
    run = await T((c) => SETTLE.run(c, { asOf: '2026-03-01' }));
    check('970 does not cover the next 1,020: under full dues nothing moves', Number((await savRow(s4a.id)).balance) === 970 && (await sched(man.id))[1].status !== 'PAID');
    const { m: p1, accounts: [p1a] } = await member({ deposit: 400 });
    const pl = await disbursed(p1.id, 'SETP', 3000, 3, '2026-01-01');
    await call('PUT', `/api/loans/${pl.id}/settlement-account`, { savingsAccountId: p1a.id });
    await accrue(pl.id, '2026-02-01');
    await T((c) => SETTLE.run(c, { asOf: '2026-02-01' }));
    check('partial transfers: the 400 there is taken', Number((await savRow(p1a.id)).balance) === 0 && Number((await loanRow(pl.id)).principal_paid + (await loanRow(pl.id)).interest_paid) > 0,
      String((await savRow(p1a.id)).balance));
    const { m: n1, accounts: [n1a] } = await member({ deposit: 5000 });
    const nl = await disbursed(n1.id, 'SETN', 3000, 3, '2026-01-01');
    await call('PUT', `/api/loans/${nl.id}/settlement-account`, { savingsAccountId: n1a.id });
    await accrue(nl.id, '2026-02-01');
    await T((c) => SETTLE.run(c, { asOf: '2026-02-01' }));
    check('no automated transfers: linked, and nothing moves', Number((await savRow(n1a.id)).balance) === 5000);

    const { m: o1, accounts: [o1a] } = await member({ deposit: 1100 });
    const first = await disbursed(o1.id, 'SETF', 3000, 3, '2026-01-01');
    const second = await disbursed(o1.id, 'SETF', 3000, 3, '2026-01-01');
    await call('PUT', `/api/loans/${first.id}/settlement-account`, { savingsAccountId: o1a.id });
    await call('PUT', `/api/loans/${second.id}/settlement-account`, { savingsAccountId: o1a.id });
    for (const x of [first, second]) await accrue(x.id, '2026-02-01');
    await T((c) => SETTLE.run(c, { asOf: '2026-02-01' }));
    check('one account, two loans: the one linked first is paid first', (await sched(first.id))[0].status === 'PAID' && (await sched(second.id))[0].status !== 'PAID');
    check('the end of day collects settlements after interest and before arrears',
      eod.DEFAULT_JOBS.indexOf('collectSettlements') > eod.DEFAULT_JOBS.indexOf('accrueInterest')
      && eod.DEFAULT_JOBS.indexOf('collectSettlements') < eod.DEFAULT_JOBS.indexOf('markArrears'));

    section('settlement accounts: branches');
    const main = await T((c) => BR.create(c, { code: 'WEST', name: 'West' }));
    const { m: b1, accounts: [b1a] } = await member({ deposit: 100, branchId: main.id });
    const bl = await disbursed(b1.id, 'SETF', 1000, 3, '2026-01-01');
    await call('PUT', `/api/loans/${bl.id}/settlement-account`, { savingsAccountId: b1a.id });
    r = await call('POST', `/api/loans/${bl.id}/branch`, { branchId: br.id });
    check('moving the loan moves its settlement account with it', r.status === 200 && (await savRow(b1a.id)).branch_id === br.id && (await loanRow(bl.id)).branch_id === br.id,
      `${r.status} ${r.reason}`);
    r = await call('DELETE', `/api/loans/${bl.id}/settlement-account`);
    check('unlinking returns the account to its member\'s branch', r.status === 200 && r.body.movedToMemberBranch === true && (await savRow(b1a.id)).branch_id === main.id,
      `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${first.id}/branch`, { branchId: br.id });
    check('an account settling other loans stays where it is', r.status === 200 && r.body.settlementAccountStays === true && (await savRow(o1a.id)).branch_id !== br.id,
      `${r.status} ${r.reason}`);
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
