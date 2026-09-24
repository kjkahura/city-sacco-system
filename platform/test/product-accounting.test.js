#!/usr/bin/env node
'use strict';

/**
 * Product accounting after Mambu: the accounting switch on deposit and loan
 * products (NONE, CASH, ACCRUAL), the GL mappings each setting requires,
 * deposit interest with its accrual and withholding tax, negative rates,
 * overdrafts, the GL accrual method and posting granularity, branches with
 * inter-branch rules, accounting closures, and changing the method of a
 * product that has accounts.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/savings');
const F = require('../src/domain/fees');
const R = require('../src/domain/restructure');
const accruals = require('../src/domain/accruals');
const acct = require('../src/domain/accounting');
const eod = require('../src/ops/eod');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
async function throws(label, fn, re) {
  try { await fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, re ? re.test(e.message) : true, e.message.slice(0, 200)); }
}

const SLUG = 'pacctest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4089;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const bal = (code) => Rd((c) => acct.balance(c, code));
const round = (n) => Math.round(n * 100) / 100;

let server;
let token;
async function call(method, p, body) {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, reason: d?.errors?.[0]?.errorReason, source: d?.errors?.[0]?.errorSource };
}
async function balanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced, `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}
let seq = 0;
async function member(c, branchId = null) {
  seq += 1;
  const no = `PA${String(seq).padStart(4, '0')}`;
  return (await c.query(`INSERT INTO members (member_no, first_name, last_name, branch_id) VALUES ($1,'Acc',$1,$2) RETURNING *`, [no, branchId])).rows[0];
}
const account = (id) => Rd(async (c) => (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [id])).rows[0]);
const entryLines = (entryId) => Rd(async (c) => (await c.query('SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY line_no', [entryId])).rows);
const depositProduct = (id, body) => call('POST', '/api/deposit-products', { id, name: id, glSavingsControl: '200-100', glFeeIncome: '400-200', ...body });
const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };
const loanProduct = (id, body) => call('POST', '/api/loan-products', { id, name: id, enforceDepositMultiplier: false, ...GL, ...body });
async function disbursed(c, memberId, productId, principal, term, on) {
  const l = await L.apply(c, { memberId, productId, principal, termMonths: term, createdBy: 'officer' });
  await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
  await L.disburse(c, l.id, { channelId: 'bank', valueDate: on, createdBy: 'teller' });
  return L.lock(c, l.id);
}

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Accounting SACCO', mfaRequiredRoles: [], adminEmail: 'admin@pacc.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@pacc.local', password: PASSWORD })).body.accessToken;
    await T((c) => c.query(`INSERT INTO gl_accounts (code, name, type) VALUES
      ('100-900','Receivables (header)','ASSET'), ('100-910','Insurance fee receivable','ASSET'),
      ('500-900','Insurance fee write-off','EXPENSE'), ('400-900','Insurance fee income','INCOME')`));
    await T((c) => c.query("UPDATE gl_accounts SET parent_code = '100-900' WHERE code = '100-910'"));
    check('a tenant starts with the seeded product accounts and a suspense account',
      (await Rd(async (c) => (await c.query("SELECT count(*)::int AS n FROM gl_accounts WHERE code IN ('290-900','100-400','200-110','200-330')")).rows[0].n)) === 4);

    // ----------------------------------------------------------------------
    section('deposit products: the accounting switch and its mappings');
    const noControl = await call('POST', '/api/deposit-products', { id: 'D0', name: 'No control', glFeeIncome: '400-200' });
    check('a CASH product without Savings Control is refused by name', noControl.status === 400 && /MISSING_ACCOUNTING_RULE: savingsControl/.test(noControl.source), noControl.source);
    const extra = await depositProduct('D1', { glInterestPayable: '200-110' });
    check('an interest payable account on a CASH product is refused as not required', extra.status === 400 && /NOT_REQUIRED_ACCOUNTING_RULE: interestPayable/.test(extra.source), extra.source);
    const header = await depositProduct('D2', { glSavingsControl: '100-900' });
    check('a header GL account is refused', header.status === 400 && /HEADER_GL_ACCOUNT_NOT_ALLOWED/.test(header.source), header.source);
    const wrongType = await depositProduct('D3', { glSavingsControl: '400-100' });
    check('a Savings Control that is income is refused', wrongType.status === 400 && /INVALID_RULE_GLACCOUNT_TYPE: savingsControl/.test(wrongType.source), wrongType.source);
    const cashAccrued = await depositProduct('D4', { interestAccruedAccounting: 'DAILY' });
    check('CASH with a daily GL accrual is refused', cashAccrued.status === 400 && /INTEREST_ACCRUED_METHOD_INVALID/.test(cashAccrued.source), cashAccrued.source);
    const fundAcc = await depositProduct('D5', { isFundingAccount: true, accountingMethod: 'ACCRUAL' });
    check('a funding account product cannot use ACCRUAL', fundAcc.status === 400 && /funding account product uses NONE or CASH/.test(fundAcc.source), fundAcc.source);
    const accNeeds = await depositProduct('D6', { accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', interestPaidIntoAccount: true, annualRate: 3.65, glInterestExpense: '500-100' });
    check('ACCRUAL with interest needs the Interest Payable account', accNeeds.status === 400 && /MISSING_ACCOUNTING_RULE: interestPayable/.test(accNeeds.source), accNeeds.source);
    const rules = await call('POST', '/api/deposit-products/accounting-rules', { accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', interestPaidIntoAccount: true, allowOverdraft: true });
    const used = rules.body.filter((r) => r.used).map((r) => r.resource);
    check('the rules a setting needs can be asked for before saving',
      ['savingsControl', 'interestExpense', 'interestPayable', 'overdraftPortfolioControl', 'overdraftInterestReceivable'].every((x) => used.includes(x)) && !used.includes('taxesPayable'),
      used.join(','));

    const none = await call('POST', '/api/deposit-products', { id: 'DNONE', name: 'Unlinked savings', accountingMethod: 'NONE' });
    check('a product not linked to accounting needs no mappings', none.status === 201 && none.body.accountRules === undefined && none.body.accountingMethod === 'NONE', none.source || '');
    const mNone = await T((c) => member(c));
    const aNone = await T((c) => S.open(c, { memberId: mNone.id, productId: 'DNONE' }));
    const scBefore = await bal('200-100');
    const suspBefore = await bal('290-900');
    const cashBefore = await bal('100-200');
    await T((c) => S.deposit(c, aNone.id, { amount: 5000, channelId: 'cash', createdBy: 'teller' }));
    check('a deposit into it moves the till against suspense, not Savings Control',
      (await bal('100-200')) - cashBefore === 5000 && (await bal('290-900')) - suspBefore === -5000 && (await bal('200-100')) === scBefore);
    const changeByPatch = await call('PATCH', '/api/deposit-products/DNONE', { accountingMethod: 'CASH', glSavingsControl: '200-100', glFeeIncome: '400-200' });
    check('the method of a product with accounts is not changed by a plain edit',
      changeByPatch.status === 400 && /ACCOUNTING_METHOD_CHANGES_THROUGH_CHANGE_ACTION/.test(changeByPatch.source), changeByPatch.source);
    await balanced('the unlinked deposit product');

    // ----------------------------------------------------------------------
    section('deposit interest under accrual, applied with withholding tax');
    const acc = await depositProduct('DACC', {
      accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', interestPaidIntoAccount: true, annualRate: 3.65,
      interestDayCount: 'ACTUAL_365', interestApplication: 'MONTHLY', withholdingTaxPercent: 15,
      glInterestExpense: '500-100', glInterestPayable: '200-110', glTaxPayable: '200-330',
    });
    check('an accrual deposit product with interest and withholding tax is created', acc.status === 201, acc.source || '');
    check('with the rules it uses listed', acc.body.accountingRules.map((r) => r.resource).join(',') === 'savingsControl,feeIncome,interestExpense,interestPayable,taxesPayable',
      acc.body.accountingRules.map((r) => r.resource).join(','));
    const m1 = await T((c) => member(c));
    const a1 = await T((c) => S.open(c, { memberId: m1.id, productId: 'DACC', openedOn: '2026-01-01' }));
    await T((c) => S.deposit(c, a1.id, { amount: 100000, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
    const payBefore = await bal('200-110');
    const expBefore = await bal('500-100');
    await T((c) => S.accrueInterest(c, a1.id, { date: '2026-01-15' }));
    check('100,000 at 3.65% on actual/365 earns 10 a day: 150 by the 15th', round(Number((await account(a1.id)).interest_accrued)) === 150, String((await account(a1.id)).interest_accrued));
    check('booked Dr Interest Expense, Cr Interest Payable as it accrues',
      (await bal('500-100')) - expBefore === 150 && (await bal('200-110')) - payBefore === -150);
    await T((c) => S.accrueInterest(c, a1.id, { date: '2026-01-15' }));
    check('accruing the same day again books nothing', round(Number((await account(a1.id)).interest_accrued)) === 150);
    await T((c) => S.accrueInterest(c, a1.id, { date: '2026-01-31' }));
    const whtBefore = await bal('200-330');
    const applied = await T((c) => S.applyInterest(c, a1.id, { date: '2026-01-31' }));
    const a1after = await account(a1.id);
    check('the month end applies 310 and withholds 15% (46.50)', Number(a1after.balance) === 100263.5 && applied.length === 2, `${a1after.balance} ${applied.length}`);
    check('the payable is cleared by the application (Dr Interest Payable, Cr Savings Control)', (await bal('200-110')) === payBefore, String(await bal('200-110')));
    check('and the tax sits in Withholding Tax Payable', (await bal('200-330')) - whtBefore === -46.5);
    check('the expense is recognised once, not again at application', (await bal('500-100')) - expBefore === 310, String((await bal('500-100')) - expBefore));
    check('every day it priced is on record', (await Rd(async (c) => (await c.query('SELECT count(*)::int AS n FROM savings_daily_balances WHERE account_id = $1', [a1.id])).rows[0].n)) === 31);
    await balanced('deposit accrual and application');

    section('deposit interest under cash, and the minimum balance method');
    await depositProduct('DCASH', { interestPaidIntoAccount: true, annualRate: 3.65, glInterestExpense: '500-100' });
    const m2 = await T((c) => member(c));
    const a2 = await T((c) => S.open(c, { memberId: m2.id, productId: 'DCASH', openedOn: '2026-01-01' }));
    await T((c) => S.deposit(c, a2.id, { amount: 100000, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
    const exp2 = await bal('500-100');
    await T((c) => S.accrueInterest(c, a2.id, { date: '2026-01-31' }));
    check('under cash, accruing books nothing', (await bal('500-100')) === exp2);
    await T((c) => S.applyInterest(c, a2.id, { date: '2026-01-31' }));
    check('and applying books Dr Interest Expense, Cr Savings Control', (await bal('500-100')) - exp2 === 310 && Number((await account(a2.id)).balance) === 100310);
    await depositProduct('DMIN', { interestPaidIntoAccount: true, annualRate: 3.65, interestCalcBalance: 'MINIMUM', glInterestExpense: '500-100' });
    const m3 = await T((c) => member(c));
    const a3 = await T((c) => S.open(c, { memberId: m3.id, productId: 'DMIN', openedOn: '2026-01-01' }));
    await T((c) => S.deposit(c, a3.id, { amount: 100000, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
    await T((c) => S.accrueInterest(c, a3.id, { date: '2026-01-10' }));
    await T((c) => S.withdraw(c, a3.id, { amount: 50000, channelId: 'cash', valueDate: '2026-01-10', createdBy: 'teller' }));
    await T((c) => S.accrueInterest(c, a3.id, { date: '2026-01-31' }));
    check('the minimum method prices the whole period on its lowest balance: 50,000 for 31 days is 155',
      round(Number((await account(a3.id)).interest_accrued)) === 155, String((await account(a3.id)).interest_accrued));

    section('negative rates');
    await depositProduct('DNEG', {
      accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', interestPaidIntoAccount: true, annualRate: -3.65, allowNegativeRate: true,
      glInterestExpense: '500-100', glInterestPayable: '200-110', glNegativeInterestIncome: '400-310', glNegativeInterestReceivable: '100-330',
    });
    const m4 = await T((c) => member(c));
    const a4 = await T((c) => S.open(c, { memberId: m4.id, productId: 'DNEG', openedOn: '2026-01-01' }));
    await T((c) => S.deposit(c, a4.id, { amount: 100000, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
    const negIncBefore = await bal('400-310');
    await T((c) => S.accrueInterest(c, a4.id, { date: '2026-01-31' }));
    check('a negative rate accrues to the negative interest receivable', (await bal('100-330')) === 310 && (await bal('400-310')) - negIncBefore === -310);
    await T((c) => S.applyInterest(c, a4.id, { date: '2026-01-31' }));
    check('and is charged to the balance at application, clearing the receivable', Number((await account(a4.id)).balance) === 99690 && (await bal('100-330')) === 0);
    await balanced('negative interest');

    // ----------------------------------------------------------------------
    section('overdrafts');
    const od = await depositProduct('DOD', {
      accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', allowOverdraft: true, maxOverdraftLimit: 50000, overdraftAnnualRate: 36.5,
      glOverdraftPortfolio: '100-400', glOverdraftWriteOff: '500-320', glOverdraftInterestIncome: '400-300', glOverdraftInterestReceivable: '100-410',
    });
    check('an overdraft product needs and takes the four overdraft accounts', od.status === 201, od.source || '');
    const m5 = await T((c) => member(c));
    await throws('a limit above the product maximum is refused', () => T((c) => S.open(c, { memberId: m5.id, productId: 'DOD', overdraftLimit: 60000 })), /ABOVE_PRODUCT_MAXIMUM/);
    const a5 = await T((c) => S.open(c, { memberId: m5.id, productId: 'DOD', openedOn: '2026-01-01', overdraftLimit: 20000 }));
    await T((c) => S.deposit(c, a5.id, { amount: 1000, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
    const odPort = await bal('100-400');
    const wd = await T((c) => S.withdraw(c, a5.id, { amount: 5000, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
    const wl = await entryLines(wd.entry_id);
    check('a withdrawal past zero splits: 1,000 from Savings Control, 4,000 into the Overdraft Portfolio',
      wl.some((x) => x.gl_code === '200-100' && Number(x.amount) === 1000) && wl.some((x) => x.gl_code === '100-400' && Number(x.amount) === 4000),
      JSON.stringify(wl.map((x) => [x.gl_code, x.direction, x.amount])));
    await throws('past the authorised limit a withdrawal is refused', () => T((c) => S.withdraw(c, a5.id, { amount: 20000, channelId: 'cash', createdBy: 'teller' })), /INSUFFICIENT_AVAILABLE_BALANCE/);
    await T((c) => S.accrueInterest(c, a5.id, { date: '2026-01-10' }));
    check('36.5% a year on 4,000 overdrawn is 4 a day, accrued to the overdraft interest receivable',
      round(Number((await account(a5.id)).od_interest_accrued)) === 40 && (await bal('100-410')) === 40, String((await account(a5.id)).od_interest_accrued));
    await T((c) => S.applyInterest(c, a5.id, { date: '2026-01-10' }));
    check('applied, it joins the overdraft (Dr Portfolio, Cr receivable)', Number((await account(a5.id)).balance) === -4040 && (await bal('100-400')) - odPort === 4040 && (await bal('100-410')) === 0);
    await T((c) => S.deposit(c, a5.id, { amount: 10000, channelId: 'cash', valueDate: '2026-01-10', createdBy: 'teller' }));
    check('a deposit clears the overdraft first, the rest is balance', Number((await account(a5.id)).balance) === 5960 && (await bal('100-400')) === odPort);
    await balanced('overdraft under accrual');

    await depositProduct('DODC', {
      allowOverdraft: true, maxOverdraftLimit: 50000, overdraftAnnualRate: 36.5, allowTechnicalOverdraft: true,
      glOverdraftPortfolio: '100-400', glOverdraftWriteOff: '500-320', glOverdraftInterestIncome: '400-300',
    });
    await call('POST', '/api/deposit-products/DODC/fees', { code: 'LEDGER', name: 'Ledger fee', trigger: 'MANUAL', amount: 300 });
    const m6 = await T((c) => member(c));
    const a6 = await T((c) => S.open(c, { memberId: m6.id, productId: 'DODC', openedOn: '2026-01-01', overdraftLimit: 10000 }));
    await T((c) => S.withdraw(c, a6.id, { amount: 3650, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
    await T((c) => S.accrueInterest(c, a6.id, { date: '2026-01-11' }));
    const odIncBefore = await bal('400-300');
    await T((c) => S.applyInterest(c, a6.id, { date: '2026-01-11' }));
    const a6x = await account(a6.id);
    check('under cash, overdraft interest (3.65 a day for 11 days) applied to an overdrawn balance is owed, not yet income',
      Number(a6x.od_interest_due) === 40.15 && (await bal('400-300')) === odIncBefore, `${a6x.od_interest_due} ${a6x.balance}`);
    await T((c) => S.applyFee(c, a6.id, { feeCode: 'LEDGER', valueDate: '2026-01-11', createdBy: 'teller' }));
    check('a fee on an overdrawn cash account is owed too', Number((await account(a6.id)).od_fees_due) === 300);
    const feeIncBefore = await bal('400-200');
    await T((c) => S.deposit(c, a6.id, { amount: 5000, channelId: 'cash', valueDate: '2026-01-11', createdBy: 'teller' }));
    check('the deposit that pays them recognises them: fee and overdraft interest income',
      (await bal('400-200')) - feeIncBefore === -300 && round((await bal('400-300')) - odIncBefore) === -40.15 && Number((await account(a6.id)).od_interest_due) === 0,
      `${(await bal('400-200')) - feeIncBefore} ${(await bal('400-300')) - odIncBefore} ${(await account(a6.id)).od_interest_due}`);
    check('and the balance ends where the arithmetic says', Number((await account(a6.id)).balance) === round(5000 - 3650 - 40.15 - 300), String((await account(a6.id)).balance));
    await T((c) => c.query('UPDATE savings_accounts SET overdraft_limit = 0 WHERE id = $1', [a6.id]));
    await T((c) => S.applyFee(c, a6.id, { amount: 2000, name: 'Card replacement', valueDate: '2026-01-11', createdBy: 'teller' }));
    check('with technical overdrafts allowed, a charge may take the balance below zero with no limit', Number((await account(a6.id)).balance) < 0, String((await account(a6.id)).balance));
    await throws('without them, a fee the balance cannot cover is refused', () => T((c) => S.applyFee(c, a1.id, { amount: 10000000, name: 'Huge', createdBy: 'teller' })), /INSUFFICIENT_BALANCE_FOR_FEE/);
    const woBefore = await bal('500-320');
    const wo = await T((c) => S.writeOffOverdraft(c, a6.id, { createdBy: 'manager' }));
    check('an overdraft is written off to the overdraft write-off expense', Number((await account(a6.id)).balance) === 0 && (await bal('500-320')) - woBefore === Number(wo.allocation.portfolio),
      JSON.stringify(wo.allocation));
    await balanced('overdraft under cash');

    // ----------------------------------------------------------------------
    section('granularity: aggregated and monthly accrual postings');
    await depositProduct('DAGG', {
      accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', accrualGranularity: 'AGGREGATED', interestPaidIntoAccount: true, annualRate: 3.65,
      glInterestExpense: '500-100', glInterestPayable: '200-110',
    });
    const aggAccounts = [];
    for (let i = 0; i < 2; i += 1) {
      const m = await T((c) => member(c));
      const a = await T((c) => S.open(c, { memberId: m.id, productId: 'DAGG', openedOn: '2026-01-01' }));
      await T((c) => S.deposit(c, a.id, { amount: 100000, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
      await T((c) => S.accrueInterest(c, a.id, { date: '2026-01-05' }));
      aggAccounts.push(a);
    }
    const pending = await Rd(async (c) => (await c.query("SELECT count(*)::int AS n FROM accrual_lines WHERE product_id = 'DAGG' AND entry_id IS NULL")).rows[0].n);
    check('aggregated accruals wait for the end of the day', pending === 2, String(pending));
    const flushed = await T((c) => accruals.flush(c, { date: '2026-01-05' }));
    const aggEntry = await Rd(async (c) => (await c.query("SELECT DISTINCT entry_id FROM accrual_lines WHERE product_id = 'DAGG'")).rows);
    check('then post as one entry for the product', flushed.entries >= 1 && aggEntry.length === 1 && aggEntry[0].entry_id);
    const breakdown = await call('GET', `/api/accounting/accruals/${aggEntry[0].entry_id}`);
    check('with the per-account breakdown behind it', breakdown.status === 200 && breakdown.body.length === 2 && breakdown.body.every((x) => Number(x.amount) === 50));
    await depositProduct('DMON', {
      accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'MONTHLY', interestPaidIntoAccount: true, annualRate: 3.65,
      glInterestExpense: '500-100', glInterestPayable: '200-110',
    });
    const mm = await T((c) => member(c));
    const am = await T((c) => S.open(c, { memberId: mm.id, productId: 'DMON', openedOn: '2026-01-01' }));
    await T((c) => S.deposit(c, am.id, { amount: 100000, channelId: 'cash', valueDate: '2026-01-01', createdBy: 'teller' }));
    await T((c) => S.accrueInterest(c, am.id, { date: '2026-01-20' }));
    await T((c) => accruals.flush(c, { date: '2026-01-20' }));
    const monthPending = await Rd(async (c) => (await c.query("SELECT count(*)::int AS n FROM accrual_lines WHERE product_id = 'DMON' AND entry_id IS NULL")).rows[0].n);
    check('a monthly GL accrual is not posted mid-month', monthPending === 1);
    await T((c) => S.accrueInterest(c, am.id, { date: '2026-01-31' }));
    await T((c) => accruals.flush(c, { date: '2026-01-31' }));
    const monthPosted = await Rd(async (c) => (await c.query("SELECT count(DISTINCT entry_id)::int AS n, count(*) FILTER (WHERE entry_id IS NULL)::int AS open FROM accrual_lines WHERE product_id = 'DMON'")).rows[0]);
    check('and goes in on the month\'s last day', monthPosted.n === 1 && monthPosted.open === 0, JSON.stringify(monthPosted));
    await balanced('aggregated and monthly accruals');

    section('the end of day for deposits');
    await depositProduct('DFEE', { interestPaidIntoAccount: true, annualRate: 3.65, glInterestExpense: '500-100' });
    const feeAdd = await call('POST', '/api/deposit-products/DFEE/fees', { code: 'MAINT', name: 'Maintenance', trigger: 'MONTHLY', amount: 50 });
    check('a monthly fee is added to a deposit product', feeAdd.status === 201, feeAdd.source || '');
    const mE = await T((c) => member(c));
    const aE = await T((c) => S.open(c, { memberId: mE.id, productId: 'DFEE', openedOn: '2026-02-01' }));
    await T((c) => S.deposit(c, aE.id, { amount: 36500, channelId: 'cash', valueDate: '2026-02-01', createdBy: 'teller' }));
    const tenantRow = { schema_name: SCHEMA };
    const night = await eod.JOBS.accrueSavings(tenantRow, '2026-02-28');
    const aEx = await account(aE.id);
    check('on the month end it accrues (3.65 a day for 28 days), applies interest and charges the monthly fee',
      night.applied >= 1 && night.fees.charged >= 1 && Number(aEx.balance) === round(36500 + 102.2 - 50), `${aEx.balance} ${JSON.stringify(night.fees)}`);
    const again = await eod.JOBS.accrueSavings(tenantRow, '2026-02-28');
    check('and running it again for the same day charges nothing twice', again.fees.charged === 0 && Number((await account(aE.id)).balance) === Number(aEx.balance));

    // ----------------------------------------------------------------------
    section('loan products: the GL accrual method and fees');
    const cashDaily = await loanProduct('LC1', { accountingMethod: 'CASH', interestAccruedAccounting: 'DAILY', monthlyRate: 1, maxTerm: 12 });
    check('a CASH loan product cannot post daily accruals', cashDaily.status === 400 && /INTEREST_ACCRUED_METHOD_INVALID/.test(cashDaily.source), cashDaily.source);
    const cashRec = await loanProduct('LC2', { accountingMethod: 'CASH', monthlyRate: 1, maxTerm: 12, glInterestRec: '100-300' });
    check('nor carry an interest receivable', cashRec.status === 400 && /NOT_REQUIRED_ACCOUNTING_RULE: interestReceivable/.test(cashRec.source), cashRec.source);
    const cashOk = await loanProduct('LC3', { accountingMethod: 'CASH', monthlyRate: 1, maxTerm: 12 });
    check('a CASH product is created with its GL accrual method set to NONE', cashOk.status === 201 && cashOk.body.interestAccruedAccounting === 'NONE');
    await loanProduct('LNA', { accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'NONE', monthlyRate: 1, maxTerm: 12, method: 'REDUCING' });
    const mL = await T((c) => member(c));
    const lna = await T((c) => disbursed(c, mL.id, 'LNA', 10000, 5, '2026-01-10'));
    const recBefore = await bal('100-300');
    const incBefore = await bal('400-100');
    await T((c) => L.accrueInterest(c, lna.id, { valueDate: '2026-02-10', createdBy: 'test' }));
    check('accrual accounting with the GL accrual method NONE books no accrued interest', (await bal('100-300')) === recBefore && (await bal('400-100')) === incBefore);
    await T((c) => L.repay(c, lna.id, { amount: 2100, channelId: 'cash', valueDate: '2026-02-10', createdBy: 'teller' }));
    check('interest is recognised when paid, straight to income', (await bal('400-100')) - incBefore === -100 && (await bal('100-300')) === recBefore, String((await bal('400-100')) - incBefore));

    await loanProduct('LMO', { accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'MONTHLY', monthlyRate: 1, maxTerm: 12, method: 'REDUCING', productType: 'DYNAMIC_TERM' });
    const lmo = await T((c) => disbursed(c, mL.id, 'LMO', 10000, 5, '2026-01-10'));
    await T((c) => L.accrueInterest(c, lmo.id, { valueDate: '2026-01-20', createdBy: 'test' }));
    const lmoPending = await Rd(async (c) => (await c.query('SELECT count(*)::int AS n FROM accrual_lines WHERE account_id = $1 AND entry_id IS NULL', [lmo.id])).rows[0].n);
    check('a loan with a monthly GL accrual waits for the month end', lmoPending >= 1, String(lmoPending));
    await T((c) => accruals.flush(c, { date: '2026-01-31' }));
    check('and posts then', (await Rd(async (c) => (await c.query('SELECT count(*)::int AS n FROM accrual_lines WHERE account_id = $1 AND entry_id IS NULL', [lmo.id])).rows[0].n)) === 0);

    await loanProduct('LAG', { accountingMethod: 'ACCRUAL', accrualGranularity: 'AGGREGATED', monthlyRate: 1, maxTerm: 12, method: 'REDUCING', productType: 'DYNAMIC_TERM' });
    const lags = [];
    for (let i = 0; i < 2; i += 1) {
      const m = await T((c) => member(c));
      const l = await T((c) => disbursed(c, m.id, 'LAG', 10000, 5, '2026-01-10'));
      await T((c) => L.accrueInterest(c, l.id, { valueDate: '2026-01-20', createdBy: 'test' }));
      lags.push(l);
    }
    await T((c) => accruals.flush(c, { date: '2026-01-20' }));
    const lagEntries = await Rd(async (c) => (await c.query("SELECT count(DISTINCT entry_id)::int AS n FROM accrual_lines WHERE product_id = 'LAG'")).rows[0].n);
    check('aggregated loan accruals post one entry for the product and branch', lagEntries === 1, String(lagEntries));

    await loanProduct('LFE', { monthlyRate: 1, maxTerm: 12 });
    const fee = await call('POST', '/api/loan-products/LFE/fees', {
      code: 'INS', name: 'Insurance', feeType: 'MANUAL', calculation: 'FLAT', amount: 500,
      glIncome: '400-900', glReceivable: '500-900',
    });
    check('a fee receivable that is not an asset is refused', fee.status === 400 && /gl_receivable/.test(fee.source), fee.source);
    const feeHeader = await call('POST', '/api/loan-products/LFE/fees', {
      code: 'INS', name: 'Insurance', feeType: 'MANUAL', calculation: 'FLAT', amount: 500, glReceivable: '100-900' });
    check('nor a header account', feeHeader.status === 400 && /HEADER_GL_ACCOUNT_NOT_ALLOWED/.test(feeHeader.source), feeHeader.source);
    const feeOk = await call('POST', '/api/loan-products/LFE/fees', {
      code: 'INS', name: 'Insurance', feeType: 'MANUAL', calculation: 'FLAT', amount: 500,
      glIncome: '400-900', glReceivable: '100-910', glWriteOff: '500-900' });
    check('a fee takes its own income, receivable and write-off accounts', feeOk.status === 201, feeOk.source || '');
    const lfe = await T((c) => disbursed(c, mL.id, 'LFE', 10000, 5, '2026-01-10'));
    await T((c) => F.applyManualFee(c, lfe.id, { fee: 'INS', valueDate: '2026-01-15', createdBy: 'teller' }));
    check('applying it debits the fee\'s own receivable', (await bal('100-910')) === 500 && (await bal('400-900')) === -500);
    await T((c) => L.repay(c, lfe.id, { amount: 200, channelId: 'cash', valueDate: '2026-01-16', createdBy: 'teller' }));
    check('paying it credits that receivable, not the product\'s', (await bal('100-910')) === 300, String(await bal('100-910')));
    await T((c) => c.query("UPDATE lending_controls SET min_arrears_days_before_writeoff = 0 WHERE id = 1"));
    await T((c) => L.writeOff(c, lfe.id, { createdBy: 'manager' }));
    check('writing the loan off clears it against the fee\'s own write-off account', (await bal('100-910')) === 0 && (await bal('500-900')) === 300, String(await bal('500-900')));
    await balanced('loan fees with their own accounts');

    section('restructuring across methods');
    await loanProduct('LCAPA', { monthlyRate: 1, maxTerm: 24 });
    await loanProduct('LCAPC', { accountingMethod: 'CASH', monthlyRate: 1, maxTerm: 24 });
    const lcap = await T((c) => disbursed(c, mL.id, 'LCAPA', 10000, 5, '2026-01-10'));
    await T((c) => L.accrueInterest(c, lcap.id, { valueDate: '2026-02-10', createdBy: 'test' }));
    await throws('capitalised amounts cannot move to a product on another method',
      () => T((c) => R.restructure(c, lcap.id, { kind: 'RESCHEDULE', productId: 'LCAPC', termMonths: 10, arrears: 'CAPITALIZE', valueDate: '2026-02-10', createdBy: 'manager' })),
      /CAPITALIZED_AMOUNTS_NOT_ALLOWED_DUE_TO_DIFFERENT_ACCOUNTING/);

    section('GL mapping history');
    await call('PATCH', '/api/loan-products/LFE', { glPenaltyInc: '400-200' });
    const hist = await call('GET', '/api/loan-products/LFE/gl-mapping-history');
    check('every mapping change is kept with its date and who made it',
      hist.status === 200 && hist.body.some((h) => h.resource === 'penaltyIncome' && h.gl_code === '400-200' && h.changed_by === 'admin@pacc.local'));

    // ----------------------------------------------------------------------
    section('branches and inter-branch rules');
    const hq = await call('POST', '/api/branches', { code: 'HQ', name: 'Head Office' });
    const twn = await call('POST', '/api/branches', { code: 'TWN', name: 'Town Branch' });
    check('branches are created', hq.status === 201 && twn.status === 201);
    const mB = await T((c) => member(c, twn.body.id));
    const aB = await T((c) => S.open(c, { memberId: mB.id, productId: 'SAV01' }));
    check('an account opens in its member\'s branch', aB.branch_id === twn.body.id);
    await throws('money taken at another branch needs an inter-branch rule',
      () => T((c) => S.deposit(c, aB.id, { amount: 1000, channelId: 'cash', branchId: hq.body.id, createdBy: 'teller' })), /NO_INTER_BRANCH_GL_ACCOUNT/);
    const badRule = await call('PUT', '/api/accounting/inter-branch-rules', { rules: [{ id: 'X1', branchA: 'HQ', glCode: '290-100' }] });
    check('a rule names both branches or neither', badRule.status === 400 && /BOTH_BRANCHES/.test(badRule.reason), badRule.reason);
    const setRules = await call('PUT', '/api/accounting/inter-branch-rules', { rules: [{ id: 'DEFAULT', glCode: '290-100' }] });
    check('a default rule is set', setRules.status === 200 && setRules.body.length === 1);
    const dep = await T((c) => S.deposit(c, aB.id, { amount: 1000, channelId: 'cash', branchId: hq.body.id, createdBy: 'teller' }));
    const dl = await entryLines(dep.entry_id);
    check('the entry balances in each branch through the inter-branch account',
      dl.filter((x) => x.gl_code === '290-100').length === 2
      && [hq.body.id, twn.body.id].every((b) => round(dl.filter((x) => x.branch_id === b).reduce((t, x) => t + (x.direction === 'DEBIT' ? 1 : -1) * Number(x.amount), 0)) === 0),
      JSON.stringify(dl.map((x) => [x.gl_code, x.direction, x.amount, x.branch_id === hq.body.id ? 'HQ' : 'TWN'])));
    const tbTwn = await call('GET', `/api/accounting/trial-balance?branchId=${twn.body.id}`);
    const tbHq = await call('GET', `/api/accounting/trial-balance?branchId=${hq.body.id}`);
    check('each branch\'s trial balance balances on its own', tbTwn.body.balanced && tbHq.body.balanced && tbTwn.body.totals.debit > 0);
    await loanProduct('LBR', { monthlyRate: 1, maxTerm: 12 });
    const lbr = await T((c) => disbursed(c, mB.id, 'LBR', 30000, 6, new Date().toISOString().slice(0, 10)));
    check('a loan opens in its member\'s branch', lbr.branch_id === twn.body.id);
    const lmove = await call('POST', `/api/loans/${lbr.id}/branch`, { branchId: 'HQ' });
    const tbTwnL = await call('GET', `/api/accounting/trial-balance?branchId=${twn.body.id}`);
    const twnPort = tbTwnL.body.rows.find((r) => r.code === '100-100');
    check('and moves to another with its portfolio', lmove.status === 200 && (!twnPort || twnPort.balance === 0), `${lmove.status} ${lmove.reason || ''} ${JSON.stringify(twnPort)}`);
    const moved = await call('POST', `/api/savings/${aB.id}/branch`, { branchId: 'HQ' });
    check('an account moves branch, taking its balance with it', moved.status === 200 && (await account(aB.id)).branch_id === hq.body.id, moved.reason || '');
    const tbTwn2 = await call('GET', `/api/accounting/trial-balance?branchId=${twn.body.id}`);
    check('leaving nothing of it in the old branch\'s Savings Control',
      !(tbTwn2.body.rows.find((r) => r.code === '200-100')) || tbTwn2.body.rows.find((r) => r.code === '200-100').balance === 0, JSON.stringify(tbTwn2.body.rows.find((r) => r.code === '200-100')));
    await balanced('branches');

    // ----------------------------------------------------------------------
    section('accounting closures');
    const future = await call('POST', '/api/accounting/closures', { closedThrough: '2099-01-01' });
    check('a closure must be in the past', future.status === 400 && /IN_THE_PAST/.test(future.reason));
    const brClose = await call('POST', '/api/accounting/closures', { closedThrough: '2026-02-28', branchId: 'TWN' });
    check('a branch can close on its own', brClose.status === 201);
    const mT2 = await T((c) => member(c, twn.body.id));
    const aT2 = await T((c) => S.open(c, { memberId: mT2.id, productId: 'SAV01', openedOn: '2026-01-01' }));
    await throws('nothing may be dated into that branch\'s closed period',
      () => T((c) => S.deposit(c, aT2.id, { amount: 100, channelId: 'cash', valueDate: '2026-02-15', createdBy: 'teller' })), /BEFORE_CLOSURE/);
    const mH2 = await T((c) => member(c, hq.body.id));
    const aH2 = await T((c) => S.open(c, { memberId: mH2.id, productId: 'SAV01', openedOn: '2026-01-01' }));
    await T((c) => S.deposit(c, aH2.id, { amount: 100, channelId: 'cash', valueDate: '2026-02-15', createdBy: 'teller' }));
    check('while another branch still can', true);
    const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 0);
    const lastMonthIso = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-${String(lastMonth.getDate()).padStart(2, '0')}`;
    const all = await call('POST', '/api/accounting/closures', { closedThrough: lastMonthIso, notes: 'month end' });
    check('the whole book is closed through last month', all.status === 201, all.reason || '');
    const earlier = await call('POST', '/api/accounting/closures', { closedThrough: '2026-03-01' });
    check('a closure must follow the last one', earlier.status === 409 && /MUST_FOLLOW/.test(earlier.reason));
    await throws('the database refuses a backdated journal entry too',
      () => T((c) => c.query(`WITH e AS (INSERT INTO journal_entries (booking_date, narration) VALUES ('2026-03-01','x') RETURNING id)
        INSERT INTO journal_lines (entry_id, gl_code, direction, amount, line_no) SELECT id, '100-200', 'DEBIT', 1, 1 FROM e`)), /BEFORE_CLOSURE/);
    await throws('and a transaction on an unlinked product, which writes no journal',
      () => T((c) => S.deposit(c, aNone.id, { amount: 10, channelId: 'cash', valueDate: '2026-03-01', createdBy: 'teller' })), /BEFORE_CLOSURE/);
    const reopened = await call('DELETE', `/api/accounting/closures/${brClose.body.id}`, { reason: 'late deposit slip' });
    check('a closure can be removed, and stays on record as deleted', reopened.status === 200 && reopened.body.deleted_at);
    const settings = await call('PUT', '/api/accounting/settings', { autoClosureEnabled: true, autoClosureIntervalDays: 7 });
    check('automatic closures are switched on with an interval', settings.status === 200 && settings.body.auto_closure_interval_days === 7);
    const todayIso = new Date().toISOString().slice(0, 10);
    const ac = await T((c) => require('../src/domain/branches').autoClose(c, { date: todayIso }));
    check('the end of day closes the book through yesterday', ac.closed === true, JSON.stringify(ac));
    const ac2 = await T((c) => require('../src/domain/branches').autoClose(c, { date: todayIso }));
    check('and not again before the interval has passed', ac2.closed === false);

    // ----------------------------------------------------------------------
    section('changing the method of a product in use');
    await T((c) => c.query("DELETE FROM accounting_closures WHERE automatic"));
    await T((c) => c.query("UPDATE accounting_settings SET auto_closure_enabled = false, last_auto_closure_on = NULL"));
    await loanProduct('LCH', { monthlyRate: 1, maxTerm: 12, method: 'REDUCING', productType: 'DYNAMIC_TERM' });
    const mC = await T((c) => member(c));
    const lch = await T((c) => disbursed(c, mC.id, 'LCH', 20000, 5, todayIso));
    await T((c) => c.query("UPDATE loan_accounts SET interest_accrued = 150 WHERE id = $1", [lch.id]));
    await T((c) => acct.post(c, { debits: [{ glCode: '100-300', amount: 150 }], credits: [{ glCode: '400-100', amount: 150 }], narration: 'test accrual', bookingDate: todayIso }));
    const noReason = await call('POST', '/api/loan-products/LCH/accounting-method', { accountingMethod: 'CASH' });
    check('a change needs a reason', noReason.status === 400 && /REASON_REQUIRED/.test(noReason.reason));
    const rec0 = await bal('100-300');
    const inc0 = await bal('400-100');
    const toCash = await call('POST', '/api/loan-products/LCH/accounting-method', { accountingMethod: 'CASH', reason: 'moving small loans to cash basis' });
    check('ACCRUAL to CASH is booked once the previous month is closed', toCash.status === 201 && toCash.body.accounts === 1, toCash.reason || '');
    check('the open interest receivable is reversed against income', (await bal('100-300')) - rec0 === -150 && (await bal('400-100')) - inc0 === 150);
    check('and the change is recorded with the amounts per loan', toCash.body.detail[0].interest === 150 && toCash.body.reason.includes('cash basis'));
    const lchP = await call('GET', '/api/loan-products/LCH');
    check('the product is now CASH with no GL accrual', lchP.body.accountingMethod === 'CASH' && lchP.body.interestAccruedAccounting === 'NONE');
    const back = await call('POST', '/api/loan-products/LCH/accounting-method', { accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', reason: 'back to accrual' });
    check('CASH to ACCRUAL books what is owed into the receivable', back.status === 201 && (await bal('100-300')) === rec0, String(await bal('100-300')));
    const toNone = await call('POST', '/api/loan-products/LCH/accounting-method', { accountingMethod: 'NONE', reason: 'unlink',
      mappings: { glPortfolio: null } });
    const port = await bal('100-100');
    check('to NONE, the portfolio and the receivable leave for suspense', toNone.status === 201 && toNone.body.detail[0].principal === 20000, toNone.reason || JSON.stringify(toNone.body.detail));
    void port;

    const dChange = await call('POST', '/api/deposit-products/DNONE/accounting-method', {
      accountingMethod: 'CASH', reason: 'link savings to the ledger', mappings: { glSavingsControl: '200-100', glFeeIncome: '400-200' } });
    check('a deposit product moves from NONE to CASH with its balances brought in from suspense',
      dChange.status === 201 && dChange.body.detail.some((d) => d.savings === 5000), dChange.reason || JSON.stringify(dChange.body));
    const changes = await call('GET', '/api/deposit-products/DNONE/accounting-changes');
    check('and the change is on the product\'s history', changes.body.length === 1 && changes.body[0].to_method === 'CASH');
    await balanced('method changes');

    const tbAll = await Rd((c) => acct.verifyRollup(c));
    check('the rollups still agree with the lines', tbAll.exact, JSON.stringify(tbAll.mismatches.slice(0, 3)));
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
