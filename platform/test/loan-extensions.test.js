#!/usr/bin/env node
'use strict';

/**
 * The rest of Mambu's loan product form: tranched loans, revolving credit
 * with a credit balance, collateral alongside guarantors, value-added tax on
 * interest and fees, and funding sources (peer-to-peer lending).
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const RV = require('../src/domain/revolving');
const FU = require('../src/domain/funding');
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

const SLUG = 'exttest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4090;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;
const sum = (xs, f) => round(xs.reduce((s, x) => s + Number(f(x)), 0));
const bal = (code) => Rd((c) => acct.balance(c, code));

let server;
let token;
async function call(method, p, body) {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORT}${p}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, reason: d?.errors?.[0]?.errorReason, source: d?.errors?.[0]?.errorSource };
}
async function assertBalanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced, `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}
let memberSeq = 0;
async function newMember(c, deposit = 0, productId = 'SAV01') {
  memberSeq += 1;
  const no = `X${String(memberSeq).padStart(4, '0')}`;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'Ext',$1) RETURNING *`, [no])).rows[0];
  const sav = await S.open(c, { memberId: m.id, productId });
  if (deposit) await S.deposit(c, sav.id, { amount: deposit, channelId: 'cash', createdBy: 'test' });
  return { m, sav };
}
const schedule = (loanId) => Rd(async (c) => (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [loanId])).rows);
const loanRow = (loanId) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [loanId])).rows[0]);
const balancesOf = (loanId) => T(async (c) => L.balances(await L.lock(c, loanId)));
const accrue = (loanId, valueDate) => T((c) => L.accrueInterest(c, loanId, { valueDate, createdBy: 'test' }));
const repay = (loanId, amount, valueDate) => T((c) => L.repay(c, loanId, { amount, channelId: 'cash', valueDate, createdBy: 'teller' }));
const disburse = (loanId, amount, valueDate, extra = {}) => T((c) => L.disburse(c, loanId, { amount, channelId: 'bank', valueDate, createdBy: 'teller', ...extra }));
const approve = (loanId) => T((c) => L.changeState(c, loanId, 'APPROVE', { createdBy: 'manager' }));
const savBalance = (id) => Rd(async (c) => Number((await c.query('SELECT balance FROM savings_accounts WHERE id = $1', [id])).rows[0].balance));

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
    await provision.provisionTenant({ slug: SLUG, name: 'Extensions SACCO', mfaRequiredRoles: [], adminEmail: 'admin@exttest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@exttest.local', password: PASSWORD })).body.accessToken;
    const bankGl = await Rd(async (c) => (await c.query("SELECT gl_account_code FROM transaction_channels WHERE id = 'bank'")).rows[0].gl_account_code);

    // ----------------------------------------------------------------------
    section('product rules');
    const badRev = await product('BADRV', { productType: 'REVOLVING', method: 'REDUCING', monthlyRate: 1, maxTerm: 12 });
    check('a revolving product needs a repayment method and value', badRev.status === 400 && /revolving_repayment_method/.test(badRev.source));
    const badTr = await product('BADTR', { productType: 'TRANCHED', method: 'REDUCING', monthlyRate: 1, maxTerm: 12, maxTranches: 1 });
    check('a tranched product needs two or more tranches', badTr.status === 400);
    const badTax = await product('BADTX', { monthlyRate: 1, maxTerm: 12, taxOnInterest: true, taxRatePercent: 16 });
    check('a taxed product linked to accounting needs a tax payable account', badTax.status === 400 && /gl_tax_payable/.test(badTax.source));
    const badFund = await product('BADFU', { monthlyRate: 1, maxTerm: 12, fundingEnabled: true, orgCommission: 1, accountingMethod: 'CASH' });
    check('a funded product cannot use cash accounting', badFund.status === 400);

    // ----------------------------------------------------------------------
    section('tranched loans');
    const tr = await product('TR01', { productType: 'TRANCHED', method: 'REDUCING', monthlyRate: 1, maxTerm: 24, maxTranches: 3 });
    check('tranched product created', tr.status === 201 && tr.body.maxTranches === 3, tr.source || '');
    const { m: mT } = await T((c) => newMember(c));
    const tl = (await call('POST', '/api/loans', { memberId: mT.id, productId: 'TR01', principal: 300000, termMonths: 12,
      tranches: [{ amount: 100000, expectedOn: '2026-01-12' }, { amount: 100000, expectedOn: '2026-02-12' }, { amount: 100000, expectedOn: '2026-03-12' }] })).body;
    check('an application carries its tranches', tl.status === 'PENDING_APPROVAL' && (await call('GET', `/api/loans/${tl.id}/tranches`)).body.length === 3, JSON.stringify(tl).slice(0, 200));
    const badSum = await call('PUT', `/api/loans/${tl.id}/tranches`, { tranches: [{ amount: 100000, expectedOn: '2026-01-12' }, { amount: 100000, expectedOn: '2026-02-12' }] });
    check('tranches must add up to the principal', badSum.status === 400 && /SUM_TO_PRINCIPAL/.test(badSum.reason));
    const tooMany = await call('PUT', `/api/loans/${tl.id}/tranches`, { tranches: [1, 2, 3, 4].map((i) => ({ amount: 75000, expectedOn: `2026-0${i}-12` })) });
    check('and stay within the product\'s maximum', tooMany.status === 400 && /TOO_MANY/.test(tooMany.reason));
    await approve(tl.id);
    const d1 = await disburse(tl.id, undefined, '2026-01-12');
    check('the first tranche activates the loan on 100,000', d1.allocation.tranche === 1 && (await loanRow(tl.id)).status === 'ACTIVE' && (await balancesOf(tl.id)).principal === 100000);
    let ts = await schedule(tl.id);
    check('with a twelve-line schedule over what was disbursed', ts.length === 12 && sum(ts, (x) => x.principal_due) === 100000);
    await accrue(tl.id, '2026-02-12');
    check('interest runs on the disbursed 100,000: 1,000 for the month', (await balancesOf(tl.id)).interest === 1000);
    const d2 = await disburse(tl.id, undefined, '2026-02-12');
    check('the second tranche lands on the running loan', d2.allocation.tranche === 2 && (await balancesOf(tl.id)).principal === 200000);
    ts = await schedule(tl.id);
    check('and the schedule is redrawn over the new balance, past lines untouched',
      ts.length === 12 && sum(ts, (x) => x.principal_due) === 200000 && Number(ts[0].principal_due) === 8333.33, `${ts.length} ${sum(ts, (x) => x.principal_due)}`);
    const tranches = (await call('GET', `/api/loans/${tl.id}/tranches`)).body;
    check('two tranches disbursed, one planned', tranches.filter((t) => t.status === 'DISBURSED').length === 2 && tranches[2].status === 'PLANNED');
    const tooBig = await call('POST', `/api/loans/${tl.id}/disbursements`, { amount: 150000, channelId: 'bank' });
    check('a tranche cannot exceed the principal left', tooBig.status === 400 && /EXCEEDS_REMAINING/.test(tooBig.reason));
    await disburse(tl.id, undefined, '2026-03-12');
    const none = await call('POST', `/api/loans/${tl.id}/disbursements`, { channelId: 'bank' });
    check('after the last tranche nothing more can be disbursed', none.status === 409 && /NO_TRANCHE_LEFT/.test(none.reason));
    check('the portfolio holds the full 300,000', (await balancesOf(tl.id)).principal === 300000);
    await assertBalanced('tranches');
    const tr2 = (await call('POST', '/api/loans', { memberId: mT.id, productId: 'TR01', principal: 50000, termMonths: 6 })).body;
    const noPlan = await call('POST', `/api/loans/${tr2.id}/approve`, {});
    check('a tranched loan without tranches cannot be approved', noPlan.status === 409 && /SUM_TO_PRINCIPAL/.test(noPlan.reason), `${noPlan.status} ${noPlan.reason} ${JSON.stringify(tr2).slice(0, 120)}`);

    // ----------------------------------------------------------------------
    section('revolving credit');
    const rv = await product('RV01', { productType: 'REVOLVING', method: 'REDUCING', monthlyRate: 1, maxTerm: 12,
      revolvingRepaymentMethod: 'PRINCIPAL_PERCENT', revolvingRepaymentValue: 10, revolvingRepaymentFloor: 1000,
      creditBalanceEnabled: true, maxCreditBalance: 50000, glCreditBalance: '200-310' });
    check('revolving product created', rv.status === 201 && rv.body.revolving.repaymentMethod === 'PRINCIPAL_PERCENT', rv.source || '');
    const { m: mR } = await T((c) => newMember(c));
    const rl = (await call('POST', '/api/loans', { memberId: mR.id, productId: 'RV01', principal: 100000, termMonths: 12 })).body;
    await approve(rl.id);
    await disburse(rl.id, 40000, '2026-01-12');
    let rrow = await loanRow(rl.id);
    check('the first drawdown activates the limit: 40,000 out, 60,000 available, no schedule',
      rrow.status === 'ACTIVE' && RV.available(rrow) === 60000 && (await schedule(rl.id)).length === 0 && rrow.next_billing_on, `${rrow.status} ${RV.available(rrow)}`);
    await disburse(rl.id, 30000, '2026-01-12');
    const over = await call('POST', `/api/loans/${rl.id}/disbursements`, { amount: 40000, channelId: 'bank' });
    check('a drawdown beyond the limit is refused', over.status === 409 && /EXCEEDS_AVAILABLE_CREDIT/.test(over.reason));
    const billed = await T((c) => RV.billAll(c, { asOf: '2026-02-12' }));
    let rs = await schedule(rl.id);
    check('on the billing date one installment is generated: 10% of 70,000 principal and the month\'s interest',
      billed.installments === 1 && rs.length === 1 && Number(rs[0].principal_due) === 7000 && Number(rs[0].interest_due) === 700,
      JSON.stringify(rs.map((x) => `${x.principal_due}/${x.interest_due}`)));
    check('the next billing date rolls a month', String((await loanRow(rl.id)).next_billing_on).slice(0, 10) === '2026-03-12' || new Date((await loanRow(rl.id)).next_billing_on).toISOString().slice(0, 10) === '2026-03-12');
    const rep = await repay(rl.id, 80000, '2026-02-15');
    check('an overpayment clears the balance and the excess goes to the credit balance, not savings',
      rep.allocation.principal === 70000 && rep.allocation.creditBalance > 0 && rep.allocation.creditBalance === rep.allocation.surplus
      && Number((await loanRow(rl.id)).credit_balance) === rep.allocation.creditBalance, JSON.stringify(rep.allocation));
    check('booked as a liability', -(await bal('200-310')) === rep.allocation.creditBalance);
    check('the loan stays open at a zero balance', (await loanRow(rl.id)).status === 'ACTIVE');
    const closeBlocked = await call('POST', `/api/loans/${rl.id}/close`, {});
    check('and cannot be closed while the credit balance stands', closeBlocked.status === 409 && /CREDIT_BALANCE/.test(closeBlocked.reason));
    const cb = rep.allocation.creditBalance;
    const d3 = await disburse(rl.id, 20000, '2026-02-20');
    check('the next drawdown uses the credit balance first', d3.allocation.fromCreditBalance === cb && (await balancesOf(rl.id)).principal === round(20000 - cb)
      && Number((await loanRow(rl.id)).credit_balance) === 0, JSON.stringify(d3.allocation));
    const dep = await call('POST', `/api/loans/${rl.id}/credit-balance-deposits`, { amount: 500, channelId: 'cash' });
    check('a member can top up the credit balance', dep.status === 201 && Number((await loanRow(rl.id)).credit_balance) === 500);
    await accrue(rl.id, '2026-03-12');
    const owed = await balancesOf(rl.id);
    await repay(rl.id, owed.total, '2026-03-12');
    const stillOpen = await call('POST', `/api/loans/${rl.id}/close`, {});
    check('settled but holding 500 of the member\'s money, it still cannot close', stillOpen.status === 409 && /CREDIT_BALANCE/.test(stillOpen.reason));
    const d5 = await disburse(rl.id, 500, '2026-03-12');
    check('drawing the 500 back out owes nothing: it was their own money', d5.allocation.fromCreditBalance === 500 && (await balancesOf(rl.id)).total === 0);
    const closed = await call('POST', `/api/loans/${rl.id}/close`, {});
    check('a settled revolving loan closes on request', closed.status === 200 && closed.body.status === 'CLOSED_REPAID', `${closed.status} ${closed.reason || ''}`);
    await assertBalanced('revolving');

    // ----------------------------------------------------------------------
    section('collateral and required cover');
    const col = await product('COL01', { monthlyRate: 1, maxTerm: 24, enableCollateral: true, requireGuarantorCover: true, minCoverPercent: 100 });
    check('a product may take collateral', col.status === 201 && col.body.securities.collateral === true);
    const { m: mC } = await T((c) => newMember(c, 20000));
    const cl = (await call('POST', '/api/loans', { memberId: mC.id, productId: 'COL01', principal: 100000, termMonths: 12 })).body;
    const short = await call('POST', `/api/loans/${cl.id}/approve`, {});
    check('20,000 of deposits does not cover 100,000', short.status === 409 && /INSUFFICIENT_GUARANTOR_COVER/.test(short.reason));
    const asset = await call('POST', `/api/loans/${cl.id}/collateral`, { assetType: 'VEHICLE', description: 'Toyota Probox KDA 123X', value: 90000, reference: 'Logbook 445' });
    check('a vehicle is pledged', asset.status === 201 && asset.body.status === 'PLEDGED');
    const elig = (await call('GET', `/api/loans/${cl.id}/eligibility`)).body;
    check('collateral counts towards the cover: 20,000 + 90,000', elig.collateral === 90000 && elig.cover === 110000 && elig.approvable);
    check('and the loan is approved', (await call('POST', `/api/loans/${cl.id}/approve`, {})).status === 200);
    await disburse(cl.id, 100000, '2026-01-12');
    const rel = await call('POST', `/api/loans/collateral/${asset.body.id}/release`, { note: 'member asked' });
    check('the asset cannot be released while the loan needs it', rel.status === 409 && /BREACH/.test(rel.reason));
    await T((c) => L.writeOff(c, cl.id, { narration: 'test', createdBy: 'manager' }));
    check('on write-off the collateral is marked seized', (await call('GET', `/api/loans/${cl.id}/collateral`)).body[0].status === 'SEIZED');
    const noG = await product('NOG01', { monthlyRate: 1, maxTerm: 12, enableGuarantors: false });
    const ngl = await T((c) => L.apply(c, { memberId: mC.id, productId: 'NOG01', principal: 1000, termMonths: 3, createdBy: 't' }));
    const { m: mG } = await T((c) => newMember(c, 5000));
    await throws('a product without guarantors refuses one', () => T((c) => L.addGuarantor(c, ngl.id, { memberId: mG.id, amount: 500 })),
      (e) => /DOES_NOT_TAKE_GUARANTORS/.test(e.message));
    await assertBalanced('collateral');

    // ----------------------------------------------------------------------
    section('value-added tax on interest and fees');
    const taxPre = -(await bal('200-300'));
    const tx1 = await product('TAX01', { monthlyRate: 1, maxTerm: 12, processingFee: 1000, taxRatePercent: 16, taxMethod: 'EXCLUSIVE',
      taxOnInterest: true, taxOnFees: true, glTaxPayable: '200-300' });
    check('an exclusive-tax product is created', tx1.status === 201 && tx1.body.tax.ratePercent === 16, tx1.source || '');
    const { m: mX } = await T((c) => newMember(c));
    const xl = await T((c) => L.apply(c, { memberId: mX.id, productId: 'TAX01', principal: 100000, termMonths: 12, createdBy: 't' }));
    await approve(xl.id);
    const feeIncPre = -(await bal('400-200'));
    await disburse(xl.id, 100000, '2026-01-12');
    let xb = await balancesOf(xl.id);
    check('the 1,000 fee is charged as 1,160 with 16% on top', xb.fees === 1160, String(xb.fees));
    check('fee income 1,000, taxes payable 160', round(-(await bal('400-200')) - feeIncPre) === 1000 && round(-(await bal('200-300')) - taxPre) === 160);
    const intIncPre = -(await bal('400-100'));
    await accrue(xl.id, '2026-02-12');
    xb = await balancesOf(xl.id);
    check('a month\'s interest of 1,000 is owed as 1,160', xb.interest === 1160 && Number((await loanRow(xl.id)).tax_charged) === 320);
    check('interest income 1,000, taxes payable now 320', round(-(await bal('400-100')) - intIncPre) === 1000 && round(-(await bal('200-300')) - taxPre) === 320);
    const recBefore = await bal('100-300'); const feeRecBefore = await bal('100-310');
    const xrep = await repay(xl.id, 2320, '2026-02-12');
    check('paying 2,320 clears both receivables', xrep.allocation.fees === 1160 && xrep.allocation.interest === 1160
      && round(recBefore - (await bal('100-300'))) === 1160 && round(feeRecBefore - (await bal('100-310'))) === 1160);
    await assertBalanced('exclusive tax');

    const tx2 = await product('TAX02', { monthlyRate: 1, maxTerm: 12, taxRatePercent: 16, taxMethod: 'INCLUSIVE', taxOnInterest: true, glTaxPayable: '200-300' });
    check('an inclusive-tax product is created', tx2.status === 201);
    const il = await T((c) => L.apply(c, { memberId: mX.id, productId: 'TAX02', principal: 100000, termMonths: 12, createdBy: 't' }));
    await approve(il.id); await disburse(il.id, 100000, '2026-01-12');
    const incPre2 = -(await bal('400-100')); const taxPre2 = -(await bal('200-300'));
    await accrue(il.id, '2026-02-12');
    check('inclusive: the member owes 1,000, income is 862.07 and tax 137.93',
      (await balancesOf(il.id)).interest === 1000 && round(-(await bal('400-100')) - incPre2) === 862.07 && round(-(await bal('200-300')) - taxPre2) === 137.93,
      `${round(-(await bal('400-100')) - incPre2)} ${round(-(await bal('200-300')) - taxPre2)}`);

    const tx3 = await product('TAX03', { monthlyRate: 1, maxTerm: 12, accountingMethod: 'CASH', taxRatePercent: 16, taxOnInterest: true, glTaxPayable: '200-300' });
    check('a cash-basis taxed product is created', tx3.status === 201, tx3.source || '');
    const cl3 = await T((c) => L.apply(c, { memberId: mX.id, productId: 'TAX03', principal: 100000, termMonths: 12, createdBy: 't' }));
    await approve(cl3.id); await disburse(cl3.id, 100000, '2026-01-12');
    const incPre3 = -(await bal('400-100')); const taxPre3 = -(await bal('200-300'));
    await accrue(cl3.id, '2026-02-12');
    check('cash basis: 1,160 owed, nothing recognised yet', (await balancesOf(cl3.id)).interest === 1160 && round(-(await bal('400-100')) - incPre3) === 0);
    await repay(cl3.id, 1160, '2026-02-12');
    check('paying it recognises 1,000 income and 160 tax', round(-(await bal('400-100')) - incPre3) === 1000 && round(-(await bal('200-300')) - taxPre3) === 160);
    await assertBalanced('tax');

    // ----------------------------------------------------------------------
    section('funding sources');
    await T((c) => c.query(`INSERT INTO savings_products (id, name, annual_rate, gl_liability, is_funding_account) VALUES ('FUND01','Funding Account',0,'200-320',true)`));
    const p2p = await product('P2P01', { productType: 'FIXED_TERM', method: 'REDUCING', rateFrequency: 'PER_YEAR', monthlyRate: 10, maxTerm: 12,
      fundingEnabled: true, orgCommission: 3, funderAllocation: 'PERCENT_OF_FUNDING' });
    check('a funded product is created', p2p.status === 201 && p2p.body.funding.orgCommission === 3, p2p.source || '');
    const A = await T((c) => newMember(c, 1000, 'FUND01'));
    const B = await T((c) => newMember(c, 1000, 'FUND01'));
    const { m: borrower } = await T((c) => newMember(c));
    const fl = (await call('POST', '/api/loans', { memberId: borrower.id, productId: 'P2P01', principal: 1000, termMonths: 10,
      fundingSources: [{ savingsAccountId: A.sav.id, amount: 300 }] })).body;
    const notFull = await call('POST', `/api/loans/${fl.id}/approve`, {});
    check('a loan funded 300 of 1,000 cannot be approved', notFull.status === 409 && /NOT_FULLY_FUNDED/.test(notFull.reason), `${notFull.status} ${notFull.reason}`);
    const ownFund = await call('POST', `/api/loans/${fl.id}/funding`, { savingsAccountId: A.sav.id, amount: 100 });
    check('the same account cannot fund twice', ownFund.status >= 400);
    const notFundAcct = await call('POST', `/api/loans/${fl.id}/funding`, { savingsAccountId: (await T((c) => newMember(c, 1000))).sav.id, amount: 700 });
    check('an ordinary savings account is not a funding account', notFundAcct.status === 409 && /NOT_A_FUNDING_ACCOUNT/.test(notFundAcct.reason));
    const fundB = await call('POST', `/api/loans/${fl.id}/funding`, { savingsAccountId: B.sav.id, amount: 700 });
    check('a second funder brings it to 100%', fundB.status === 201);
    check('approved once fully funded', (await call('POST', `/api/loans/${fl.id}/approve`, {})).status === 200);
    const aFree = await T((c) => S.summary(c, A.sav.id));
    check('the funders\' money is locked at approval: A has 700 available of 1,000', aFree.available === 700 && aFree.pledged === 300, JSON.stringify(aFree));
    const portfolioPre = await bal('100-100'); const fundLiabPre = -(await bal('200-320')); const bankPre = await bal(bankGl);
    await disburse(fl.id, 1000, '2020-01-01');
    check('disbursement takes the money from the funders, not the portfolio',
      (await savBalance(A.sav.id)) === 700 && (await savBalance(B.sav.id)) === 300 && round((await bal('100-100')) - portfolioPre) === 0
      && round(fundLiabPre - -(await bal('200-320'))) === 1000 && round(bankPre - (await bal(bankGl))) === 1000);
    const recPre = await bal('100-300'); const incPre = -(await bal('400-100'));
    await accrue(fl.id, '2020-02-01');
    check('interest 8.33 is owed; only the organisation\'s 3% of 10% (2.50) is its income',
      (await balancesOf(fl.id)).interest === 8.33 && round((await bal('100-300')) - recPre) === 2.5 && round(-(await bal('400-100')) - incPre) === 2.5,
      `${(await balancesOf(fl.id)).interest} ${round((await bal('100-300')) - recPre)}`);
    const frep = await repay(fl.id, 108.33, '2020-02-01');
    const fa = frep.allocation.funding;
    check('the installment returns 30 + 70 principal to A and B with their share of 5.83 interest (Mambu\'s example)',
      fa[0].principal === 30 && fa[1].principal === 70 && round(fa[0].interest + fa[1].interest) === 5.83 && frep.allocation.orgInterest === 2.5,
      JSON.stringify(frep.allocation));
    check('their accounts show it', round((await savBalance(A.sav.id)) - 700) === round(30 + fa[0].interest) && round((await savBalance(B.sav.id)) - 300) === round(70 + fa[1].interest));
    check('the organisation\'s receivable is cleared', round((await bal('100-300')) - recPre) === 0);
    await assertBalanced('funded repayment');
    await T((c) => L.reverseTransaction(c, frep.reference, { createdBy: 'test' }));
    check('reversing the repayment takes the money back from the funders', (await savBalance(A.sav.id)) === 700 && (await savBalance(B.sav.id)) === 300);
    await assertBalanced('funded reversal');

    const fx = await product('P2P02', { productType: 'FIXED_TERM', method: 'REDUCING', rateFrequency: 'PER_YEAR', monthlyRate: 0, maxTerm: 12,
      fundingEnabled: true, orgCommission: 4, funderAllocation: 'FIXED_COMMISSIONS', funderRateMin: 1, funderRateMax: 10 });
    check('a fixed-commissions product is created', fx.status === 201, fx.source || '');
    const A2 = await T((c) => newMember(c, 1000, 'FUND01'));
    const B2 = await T((c) => newMember(c, 1000, 'FUND01'));
    const fl2 = (await call('POST', '/api/loans', { memberId: borrower.id, productId: 'P2P02', principal: 1000, termMonths: 6,
      fundingSources: [{ savingsAccountId: A2.sav.id, amount: 300, funderRate: 5 }, { savingsAccountId: B2.sav.id, amount: 700, funderRate: 6 }] })).body;
    await approve(fl2.id);
    check('the loan\'s rate is the commission plus the funders\' rates by share: 4 + 1.5 + 4.2 = 9.7% (Mambu\'s example)',
      Number((await loanRow(fl2.id)).monthly_rate) === 9.7, String((await loanRow(fl2.id)).monthly_rate));
    const outOfBand = await call('POST', '/api/loans', { memberId: borrower.id, productId: 'P2P02', principal: 500, termMonths: 6,
      fundingSources: [{ savingsAccountId: A2.sav.id, amount: 500, funderRate: 12 }] });
    check('a funder rate outside the band is refused', outOfBand.status === 400 && /FUNDER_RATE_ABOVE/.test(outOfBand.reason));
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
