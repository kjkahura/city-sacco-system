#!/usr/bin/env node
'use strict';

/**
 * Deposits > Deposit Accounts, after the reference platform: the initial state, approval,
 * activation by the first transaction, reject and withdraw, lock and
 * unlock, dormancy (no interest, no automated fees), In Arrears, close with
 * write-off and its undo, reopen and delete; offset loans; and the credit
 * arrangement search and schedule.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const INT = require('../src/domain/interest');
const PERMS = require('../src/lib/permissions');
const { orgDay, addDays } = require('./_org');
const { ymd } = require('../src/domain/schedule');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'dacctest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4116;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

const tokens = {};
async function call(method, p, body, { who = 'admin' } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 400), reason: `${d?.errors?.[0]?.errorReason || ''} ${d?.errors?.[0]?.errorSource || ''}`, total: r.headers.get('items-total') };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}
const product = (id, body = {}) => call('POST', '/api/deposit-products', {
  id, name: id, accountingMethod: 'NONE', interestPaidIntoAccount: true, interestDayCount: 'ACTUAL_365', ...body });
const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };
const loanProduct = (id, body = {}) => call('POST', '/api/loan-products', {
  id, name: id, ...GL, method: 'FLAT', monthlyRate: 1, maxTerm: 24, enforceDepositMultiplier: false, ...body });
const errOf = (p) => p.then(() => 'ok', (e) => e.message);

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Deposit Accounts SACCO', mfaRequiredRoles: [], adminEmail: 'admin@dacc.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@dacc.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const u = await call('POST', '/api/users', { email: 'teller@dacc.local', fullName: 'The teller', password: PW, role: 'TELLER', branchId: 'HQ' });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
    tokens.teller = await login('teller@dacc.local');
    const m = (await call('POST', '/api/members', { firstName: 'Akinyi', lastName: 'Holder', branchId: 'HQ' })).body;
    const D0 = orgDay(-10);
    const today = orgDay(0);
    const open = (productId, extra = {}) => T((c) => S.open(c, { memberId: m.id, productId, openedOn: D0, ...extra }));
    const put = (id, amount, valueDate = today) => T((c) => S.deposit(c, id, { amount, channelId: 'cash', valueDate, createdBy: 'test' }));
    const take = (id, amount, valueDate = today) => T((c) => S.withdraw(c, id, { amount, channelId: 'cash', valueDate, createdBy: 'test' }));
    const acc = async (id) => (await T((c) => c.query('SELECT * FROM savings_accounts WHERE id = $1', [id]))).rows[0];
    const state = (id, action, body = {}, who = 'admin') => call('POST', `/api/savings/${id}:changeState`, { action, ...body }, { who });
    const bal = async (id) => (await call('GET', `/api/savings/${id}/balance`)).body;
    check('staff signed in', tokens.admin && tokens.teller);

    // ------------------------------------------------------------------------
    section('the initial state and approval');
    const plain = await open('SAV01');
    check('an existing product still opens accounts ACTIVE', plain.status === 'ACTIVE');
    const pen = await product('PEN1', { initialState: 'PENDING_APPROVAL', annualRate: 3.65 });
    check('a product whose accounts start pending approval', pen.status === 201 && pen.body.initialState === 'PENDING_APPROVAL', pen.text);
    const badState = await product('PENX', { initialState: 'DORMANT' });
    check('the initial state is ACTIVE, PENDING_APPROVAL or APPROVED', badState.status === 400, badState.text);
    const p1 = await open('PEN1');
    check('an account opens PENDING_APPROVAL', p1.status === 'PENDING_APPROVAL');
    const early = await errOf(put(p1.id, 100));
    check('a pending account takes no deposit', /ACCOUNT_NOT_ACTIVE: PENDING_APPROVAL/.test(early), early);
    const tellerApprove = await state(p1.id, 'APPROVE', {}, 'teller');
    check('a teller may not approve it', tellerApprove.status === 403, tellerApprove.text);
    const appr = await state(p1.id, 'APPROVE');
    check('approved (the reference platform\'s APPROVE)', appr.status === 200 && appr.body.status === 'APPROVED' && String(appr.body.approved_on).slice(0, 10) === today, appr.text);
    const undo = await state(p1.id, 'UNDO_APPROVE');
    check('the approval is undone', undo.status === 200 && undo.body.status === 'PENDING_APPROVAL' && !undo.body.approved_on, undo.text);
    await state(p1.id, 'APPROVE');
    const wrong = await state(p1.id, 'LOCK');
    check('an approved account is not locked', wrong.status === 409 && /CANNOT_LOCK_A_APPROVED_ACCOUNT/.test(wrong.reason), wrong.text);
    const unknown = await state(p1.id, 'FREEZE');
    check('an unknown action is refused with the list', unknown.status === 400 && /ACTION_IS_ONE_OF/.test(unknown.reason), unknown.text);
    const dep1 = await put(p1.id, 1000);
    const a1 = await acc(p1.id);
    check('its first transaction activates it', a1.status === 'ACTIVE' && ymd(a1.activated_on) === today, `${a1.status} ${a1.activated_on}`);
    check('and interest runs from that day, not the day it was opened', ymd(a1.accrued_through) === addDays(today, -1)
      && ymd(a1.period_started_on) === today, `${a1.accrued_through} ${a1.period_started_on}`);
    const undoAct = await state(p1.id, 'UNDO_ACTIVATE');
    check('the activation is not undone while a transaction stands', undoAct.status === 409 && /ACCOUNT_HAS_TRANSACTIONS/.test(undoAct.reason), undoAct.text);
    await call('POST', `/api/savings/transactions/${dep1.reference}/reversal`, {});
    const undoAct2 = await state(p1.id, 'UNDO_ACTIVATE');
    check('once reversed, the activation is undone', undoAct2.status === 200 && undoAct2.body.status === 'APPROVED' && !undoAct2.body.activated_on, undoAct2.text);
    const undoPlain = await state(plain.id, 'UNDO_ACTIVATE');
    check('an account that opened ACTIVE has no activation to undo', undoPlain.status === 409 && /NOT_ACTIVATED_FROM_APPROVED/.test(undoPlain.reason), undoPlain.text);
    const wd = await state(p1.id, 'CLOSE_WITHDRAW', { notes: 'changed their mind' });
    check('an approved account is withdrawn', wd.status === 200 && wd.body.status === 'CLOSED' && wd.body.closed_as === 'WITHDRAWN', wd.text);
    check('the reference platform\'s state for it is WITHDRAWN', (await bal(p1.id)).accountState === 'WITHDRAWN');
    const reopenWd = await state(p1.id, 'REOPEN');
    check('a withdrawn account is not reopened', reopenWd.status === 409 && /CANNOT_REOPEN_A_WITHDRAWN_ACCOUNT/.test(reopenWd.reason), reopenWd.text);
    const p2 = await open('PEN1');
    const rej = await state(p2.id, 'CLOSE_REJECT');
    check('a pending account is rejected: CLOSED_REJECTED', rej.status === 200 && (await bal(p2.id)).accountState === 'CLOSED_REJECTED', rej.text);
    await product('APR1', { initialState: 'APPROVED' });
    const ap = await open('APR1');
    check('a product whose accounts start approved', ap.status === 'APPROVED' && ap.approved_on);
    const member1 = (await T((c) => c.query('SELECT status FROM members WHERE id = $1', [m.id]))).rows[0].status;
    check('the holder is active through the account that opened ACTIVE', member1 === 'ACTIVE', member1);

    // ------------------------------------------------------------------------
    section('lock and unlock');
    await put(plain.id, 5000);
    const lk = await state(plain.id, 'LOCK', { notes: 'court order' });
    check('an active account is locked', lk.status === 200 && lk.body.status === 'LOCKED' && lk.body.state_before_lock === 'ACTIVE', lk.text);
    check('a locked account takes no deposit', /ACCOUNT_NOT_ACTIVE: LOCKED/.test(await errOf(put(plain.id, 10))));
    check('and no withdrawal', /ACCOUNT_NOT_ACTIVE: LOCKED/.test(await errOf(take(plain.id, 10))));
    const feeLocked = await call('POST', `/api/savings/${plain.id}/fees`, { amount: 5, name: 'Statement' });
    check('and no fee', feeLocked.status === 409 && /ACCOUNT_LOCKED/.test(feeLocked.reason), feeLocked.text);
    const closeLocked = await state(plain.id, 'CLOSE');
    check('and is not closed', closeLocked.status === 409, closeLocked.text);
    const tellerUnlock = await state(plain.id, 'UNLOCK', {}, 'teller');
    check('unlocking needs UNLOCK_SAVINGS_ACCOUNT', tellerUnlock.status === 403, tellerUnlock.text);
    const ul = await state(plain.id, 'UNLOCK');
    check('unlocked, back to ACTIVE', ul.status === 200 && ul.body.status === 'ACTIVE' && !ul.body.state_before_lock, ul.text);

    // ------------------------------------------------------------------------
    section('dormancy (the reference platform: no interest, no automated fees)');
    await product('DOR1', { annualRate: 36.5, dormancyDays: 5 });
    await call('POST', '/api/deposit-products/DOR1/fees', { code: 'MF', name: 'Ledger fee', trigger: 'MONTHLY', amount: 10, applyDateMethod: 'FIRST_DAY_OF_MONTH' });
    const dz = await open('DOR1');
    const busy = await open('DOR1');
    await put(dz.id, 10000, D0);
    await put(busy.id, 10000, D0);
    await T((c) => c.query('UPDATE savings_accounts SET last_activity_on = $2 WHERE id = $1', [busy.id, today]));
    const eod = await T((c) => S.endOfDay(c, { date: today, createdBy: 'test' }));
    const dzA = await acc(dz.id);
    check('an account without activity for the dormancy days is dormant', dzA.status === 'DORMANT' && eod.dormant >= 1, `${dzA.status} ${JSON.stringify(eod.dormant)}`);
    const lockedDormant = await state(dz.id, 'LOCK');
    const backDormant = await state(dz.id, 'UNLOCK');
    check('a dormant account locked and unlocked is dormant again', lockedDormant.body?.status === 'LOCKED' && backDormant.body?.status === 'DORMANT', backDormant.text);
    const before = Number(dzA.interest_accrued);
    await T((c) => S.accrueInterest(c, dz.id, { date: addDays(today, 5) }));
    await T((c) => S.accrueInterest(c, busy.id, { date: addDays(today, 5) }));
    const dzB = await acc(dz.id);
    const busyB = await acc(busy.id);
    check('a dormant account accrues nothing, though its days are recorded', near(dzB.interest_accrued, before, 0.001)
      && ymd(dzB.accrued_through) === addDays(today, 5), `${dzB.interest_accrued} ${before}`);
    check('while an active one of the product accrues', Number(busyB.interest_accrued) > Number(dzB.interest_accrued) + 40, `${busyB.interest_accrued}`);
    const first = `${addDays(today, 40).slice(0, 7)}-01`;
    const fees = await T((c) => S.applyMonthlyFees(c, { date: first, createdBy: 'test' }));
    const charged = (await T((c) => c.query("SELECT savings_account_id FROM transactions WHERE kind = 'SAVINGS_FEE' AND value_date = $1", [first]))).rows.map((r) => r.savings_account_id);
    check('the monthly fee is charged to the active account, not the dormant one', charged.includes(busy.id) && !charged.includes(dz.id), JSON.stringify(fees));
    const later = new Date(`${addDays(today, 40)}T00:00:00Z`);
    const monthEnd = new Date(Date.UTC(later.getUTCFullYear(), later.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    await T((c) => S.endOfDay(c, { date: monthEnd, createdBy: 'test' }));
    const appliedTo = (await T((c) => c.query("SELECT savings_account_id FROM transactions WHERE kind = 'SAVINGS_INTEREST_APPLIED' AND value_date = $1", [monthEnd]))).rows.map((r) => r.savings_account_id);
    check('interest is applied to the active account at the month end, not to the dormant one', appliedTo.includes(busy.id) && !appliedTo.includes(dz.id), `${monthEnd} ${appliedTo.length}`);

    // ------------------------------------------------------------------------
    section('In Arrears');
    await product('CUR1', { allowOverdraft: true, maxOverdraftLimit: 10000, overdraftAnnualRate: 0 });
    const cu = await open('CUR1');
    await call('PUT', `/api/savings/${cu.id}/overdraft`, { limit: 5000, expiryDate: addDays(today, 5) });
    await take(cu.id, 3000);
    check('an account inside its overdraft is ACTIVE', (await acc(cu.id)).status === 'ACTIVE');
    const exp = await call('PUT', `/api/savings/${cu.id}/overdraft`, { expiryDate: addDays(today, -1) });
    const cuA = await bal(cu.id);
    check('overdrawn past the expiry date: IN_ARREARS (the reference platform\'s ACTIVE_IN_ARREARS)', exp.status === 200 && cuA.status === 'IN_ARREARS' && cuA.accountState === 'ACTIVE_IN_ARREARS' && cuA.inArrearsSince === today, JSON.stringify(cuA.status));
    const mem = (await T((c) => c.query('SELECT status FROM members WHERE id = $1', [m.id]))).rows[0].status;
    check('an account in arrears is open for its holder', mem === 'ACTIVE', mem);
    check('it takes no withdrawal past the expiry', /INSUFFICIENT_AVAILABLE_BALANCE/.test(await errOf(take(cu.id, 10))));
    await put(cu.id, 3000);
    check('a deposit that covers it: ACTIVE again', (await acc(cu.id)).status === 'ACTIVE' && !(await acc(cu.id)).in_arrears_since);
    await product('CUR2', { allowOverdraft: true, allowTechnicalOverdraft: true, maxOverdraftLimit: 10000, overdraftAnnualRate: 0 });
    const cu2 = await open('CUR2');
    await call('PUT', `/api/savings/${cu2.id}/overdraft`, { limit: 5000 });
    await take(cu2.id, 3000);
    await call('PUT', `/api/savings/${cu2.id}/overdraft`, { limit: 1000 });
    check('a limit lowered below what is owed: IN_ARREARS', (await acc(cu2.id)).status === 'IN_ARREARS');
    await put(cu2.id, 2000);
    check('back within the limit: ACTIVE', (await acc(cu2.id)).status === 'ACTIVE');
    const cu3 = await open('CUR1');
    await call('PUT', `/api/savings/${cu3.id}/overdraft`, { limit: 5000, expiryDate: addDays(today, 5) });
    await take(cu3.id, 1000);
    await T((c) => c.query('UPDATE savings_accounts SET overdraft_expires_on = $2 WHERE id = $1', [cu3.id, addDays(today, -2)]));
    const eod2 = await T((c) => S.endOfDay(c, { date: today, createdBy: 'test' }));
    check('the end of day puts an account past its expiry into arrears', (await acc(cu3.id)).status === 'IN_ARREARS' && eod2.inArrears >= 1, JSON.stringify(eod2.inArrears));
    const lockArrears = await state(cu3.id, 'LOCK');
    const unlockArrears = await state(cu3.id, 'UNLOCK');
    check('an account in arrears is locked, and unlocked back into arrears', lockArrears.body?.status === 'LOCKED' && unlockArrears.body?.status === 'IN_ARREARS', unlockArrears.text);

    // ------------------------------------------------------------------------
    section('close with write-off, and its undo');
    const notOver = await state(cu.id, 'CLOSE_WRITE_OFF');
    check('an account not overdrawn is closed, not written off', notOver.status === 409 && /ACCOUNT_IS_NOT_OVERDRAWN/.test(notOver.reason), notOver.text);
    const tellerWo = await state(cu3.id, 'CLOSE_WRITE_OFF', {}, 'teller');
    check('writing off needs CLOSE_SAVINGS_ACCOUNTS', tellerWo.status === 403, tellerWo.text);
    const wo = await state(cu3.id, 'CLOSE_WRITE_OFF', { notes: 'uncollectable' });
    const woA = await bal(cu3.id);
    check('Close > Write Off: CLOSED_WRITTEN_OFF with nothing left', wo.status === 200 && woA.accountState === 'CLOSED_WRITTEN_OFF' && woA.balance === 0 && woA.overdraftLimit === 0, wo.text);
    const woTx = (await T((c) => c.query("SELECT * FROM transactions WHERE savings_account_id = $1 AND kind = 'OVERDRAFT_WRITE_OFF'", [cu3.id]))).rows[0];
    check('the write-off records what it cleared', woTx && Number(woTx.amount) === 1000 && woTx.allocation.closing === true && woTx.allocation.cleared.overdraftLimit === 5000, JSON.stringify(woTx?.allocation));
    const reopenWo = await state(cu3.id, 'REOPEN');
    check('a written-off account is not reopened: its write-off is undone', reopenWo.status === 409 && /undo the write-off/.test(reopenWo.reason), reopenWo.text);
    const tellerUndo = await state(cu3.id, 'UNDO_CLOSE_WRITE_OFF', {}, 'teller');
    check('undoing it needs REVERSE_SAVINGS_ACCOUNT_WRITE_OFF', tellerUndo.status === 403, tellerUndo.text);
    const unwo = await state(cu3.id, 'UNDO_CLOSE_WRITE_OFF');
    const unA = await acc(cu3.id);
    check('Undo Write Off: the account is open again as it was', unwo.status === 200 && unA.status === 'IN_ARREARS' && Number(unA.balance) === -1000 && Number(unA.overdraft_limit) === 5000 && !unA.closed_as, `${unA.status} ${unA.balance}`);
    const woTx2 = (await T((c) => c.query('SELECT reversed_by FROM transactions WHERE id = $1', [woTx.id]))).rows[0];
    check('and the write-off is reversed', Boolean(woTx2.reversed_by));
    const oldWo = await T((c) => S.writeOffOverdraft(c, cu3.id, { createdBy: 'test' }));
    const stillOpen = await acc(cu3.id);
    check('the overdraft write-off on its own leaves the account open (as before), and out of arrears', oldWo.kind === 'OVERDRAFT_WRITE_OFF' && stillOpen.status === 'ACTIVE' && Number(stillOpen.balance) === 0, stillOpen.status);

    // ------------------------------------------------------------------------
    section('close, reopen and delete');
    const cl = await open('SAV01');
    const closed = await state(cl.id, 'CLOSE');
    check('CLOSE closes an empty account', closed.status === 200 && closed.body.status === 'CLOSED' && !closed.body.closed_as, closed.text);
    const tellerReopen = await state(cl.id, 'REOPEN', {}, 'teller');
    check('reopening needs REOPEN_SAVINGS_ACCOUNT', tellerReopen.status === 403, tellerReopen.text);
    const ro = await state(cl.id, 'REOPEN');
    const roA = await acc(cl.id);
    check('a closed savings account is reopened, earning from today', ro.status === 200 && roA.status === 'ACTIVE' && !roA.closed_on
      && ymd(roA.accrued_through) === addDays(today, -1), `${roA.status} ${roA.accrued_through}`);
    await product('FD1', { productType: 'FIXED_DEPOSIT', termUnit: 'MONTHS', termDefault: 6 });
    const fd = await open('FD1');
    await state(fd.id, 'CLOSE');
    const roFd = await state(fd.id, 'REOPEN');
    check('only current and savings accounts reopen (the reference platform)', roFd.status === 409 && /ONLY_CURRENT_AND_SAVINGS_ACCOUNTS_REOPEN/.test(roFd.reason), roFd.text);
    const fresh = await open('SAV01');
    const tellerDel = await call('DELETE', `/api/savings/${fresh.id}`, null, { who: 'teller' });
    check('deleting needs DELETE_SAVINGS_ACCOUNT', tellerDel.status === 403, tellerDel.text);
    const del = await call('DELETE', `/api/savings/${fresh.id}`);
    const gone = (await T((c) => c.query('SELECT 1 FROM savings_accounts WHERE id = $1', [fresh.id]))).rowCount;
    check('an account nothing was posted to is deleted', del.status === 200 && del.body.deleted === fresh.account_no && !gone, del.text);
    const delUsed = await call('DELETE', `/api/savings/${plain.id}`);
    check('one with transactions is not', delUsed.status === 409 && /ACCOUNT_HAS_TRANSACTIONS/.test(delUsed.reason), delUsed.text);
    const wd2 = await call('POST', `/api/savings/${p1.id}/state`, { action: 'CLOSE_WITHDRAW' });
    check('the /state path takes the same actions', wd2.status === 409 && /CANNOT_CLOSE_WITHDRAW_A_CLOSED_ACCOUNT/.test(wd2.reason), wd2.text);

    // ------------------------------------------------------------------------
    section('permissions');
    const codes = ['DELETE_SAVINGS_ACCOUNT', 'APPROVE_SAVINGS', 'LOCK_SAVINGS_ACCOUNT', 'UNLOCK_SAVINGS_ACCOUNT', 'REOPEN_SAVINGS_ACCOUNT', 'REVERSE_SAVINGS_ACCOUNT_WRITE_OFF'];
    check('the reference platform\'s deposit account permissions are in the catalogue', codes.every((x) => PERMS.CODES.has(x)));
    check('a manager holds them, bar deleting', codes.slice(1).every((x) => PERMS.DEFAULTS.MANAGER.includes(x)) && !PERMS.DEFAULTS.MANAGER.includes('DELETE_SAVINGS_ACCOUNT'));
    await T((c) => c.query(`INSERT INTO roles (code, name, base_role, permissions) VALUES ('OLDACC', 'Old accounts role', 'MANAGER',
      ARRAY['EDIT_SAVINGS_ACCOUNT', 'CLOSE_SAVINGS_ACCOUNTS'])`));
    await pool.query("DELETE FROM platform.schema_migrations WHERE schema_name = $1 AND version LIKE '037%'", [SCHEMA]);
    await migrateAllTenants({});
    const old = (await T((c) => c.query("SELECT permissions FROM roles WHERE code = 'OLDACC'"))).rows[0].permissions;
    check('roles holding the deposit permissions are given the matching ones, and the migration runs twice',
      codes.slice(1).every((x) => old.includes(x)) && !old.includes('DELETE_SAVINGS_ACCOUNT'), old.join(','));

    // ------------------------------------------------------------------------
    section('offset loans');
    const g = (await call('GET', '/api/deposit-products/SAV01')).body.gl;
    const off = await product('OFF1', { allowOffset: true, annualRate: 0, accountingMethod: 'CASH', glSavingsControl: g.savingsControl,
      glFeeIncome: g.feeIncome, glInterestExpense: g.interestExpense, glInterestPayable: g.interestPayable });
    check('a deposit product whose accounts may offset loans', off.status === 201 && off.body.allowOffset === true, off.text);
    const badOff = await loanProduct('OFFX', { offsetEnabled: true });
    check('offset needs a dynamic term, equal instalment, simple interest on principal and interest product', badOff.status === 400 && /offset_enabled needs a DYNAMIC_TERM/.test(badOff.reason), badOff.text);
    const offL = await loanProduct('OFFL', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', interestType: 'SIMPLE',
      simpleBase: 'PRINCIPAL_AND_INTEREST', offsetEnabled: true, settlementOption: 'NONE', dayCount: 'ACTUAL_365' });
    check('an offset loan product, which links its deposit account', offL.status === 201 && offL.body.offsetEnabled === true && offL.body.settlement.enabled === true, offL.text);
    const ln = (await call('POST', '/api/loans', { memberId: m.id, productId: 'OFFL', principal: 100000, termMonths: 12 })).body;
    await call('POST', `/api/loans/${ln.id}/approve`, {});
    const noLink = await call('POST', `/api/loans/${ln.id}/disbursements`, { channelId: 'cash' });
    check('it is not disbursed without its offset account (the reference platform)', noLink.status === 409 && /MISSING_LINKED_OFFSET_ACCOUNT/.test(noLink.reason), noLink.text);
    const wrongLink = await call('PUT', `/api/loans/${ln.id}/settlement-account`, { savingsAccountId: plain.id });
    check('a deposit product that does not allow offset is refused', wrongLink.status === 409 && /DEPOSIT_PRODUCT_DOES_NOT_ALLOW_OFFSET/.test(wrongLink.reason), wrongLink.text);
    const oa = await open('OFF1');
    const offDep = await put(oa.id, 40000);
    const link = await call('PUT', `/api/loans/${ln.id}/settlement-account`, { savingsAccountId: oa.id });
    const disb = await call('POST', `/api/loans/${ln.id}/disbursements`, { channelId: 'cash' });
    check('linked, it is disbursed', link.status === 200 && disb.status === 201, `${link.text} ${disb.text}`);
    const acr = await T((c) => INT.accrueInterest(c, ln.id, { valueDate: addDays(today, 10), createdBy: 'test' }));
    const rate = (await T((c) => c.query('SELECT monthly_rate FROM loan_accounts WHERE id = $1', [ln.id]))).rows[0].monthly_rate;
    check('interest is on the balance less the offset account\'s balance', acr && acr.allocation.base === 60000 && acr.allocation.offsetBalance === 40000, JSON.stringify(acr?.allocation));
    check('so 10 days on 60,000, not 100,000', acr && near(acr.amount, 60000 * Number(rate) * 12 / 100 * 10 / 365, 0.05), `${acr?.amount} rate ${rate}`);
    await put(oa.id, 70000);
    const acr2 = await T((c) => INT.accrueInterest(c, ln.id, { valueDate: addDays(today, 20), createdBy: 'test' }));
    check('an offset at or above the balance: no interest', acr2 === null, JSON.stringify(acr2?.allocation));
    const revOff = await call('POST', `/api/savings/transactions/${offDep.reference}/reversal`, {});
    check('reversals on an offset account are not supported (the reference platform)', revOff.status === 409 && /REVERSAL_NOT_SUPPORTED_ON_AN_OFFSET_ACCOUNT/.test(revOff.reason), revOff.text);
    const offOff = await call('PATCH', '/api/deposit-products/OFF1', { allowOffset: false });
    check('the deposit product keeps offset while its accounts offset loans', offOff.status === 400 && /allow_offset cannot be turned off/.test(offOff.reason), offOff.text);
    const lpOff = await call('PATCH', '/api/loan-products/OFFL', { offsetEnabled: false });
    check('the loan product keeps offset once loans exist', lpOff.status === 400 && /offset_enabled/.test(lpOff.reason), lpOff.text);

    // ------------------------------------------------------------------------
    section('credit arrangements: search and schedule');
    const expire = addDays(today, 3 * 365);
    const ca1 = (await call('POST', '/api/creditarrangements', { holderKey: m.id, amount: 200000, startDate: today, expireDate: expire, notes: 'Trade line' })).body;
    const ca2 = (await call('POST', '/api/creditarrangements', { holderKey: m.id, amount: 5000, startDate: today, expireDate: expire })).body;
    await call('POST', `/api/creditarrangements/${ca1.encodedKey}:changeState`, { action: 'APPROVE' });
    const found = await call('POST', '/api/creditarrangements:search?paginationDetails=ON', {
      filterCriteria: [{ field: 'amount', operator: 'MORE_THAN', value: 10000 }, { field: 'state', operator: 'EQUALS', value: 'APPROVED' }] });
    check('POST /creditarrangements:search filters (the reference platform)', found.status === 200 && found.body.length === 1 && found.body[0].id === ca1.id && found.total === '1', found.text);
    const sorted = await call('POST', '/api/creditarrangements:search', { filterCriteria: [{ field: 'holderKey', operator: 'EQUALS', value: m.id }],
      sortingCriteria: { field: 'amount', order: 'ASC' } });
    check('and sorts', sorted.status === 200 && sorted.body.map((x) => x.id).join() === [ca2.id, ca1.id].join(), sorted.text);
    const badField = await call('POST', '/api/creditarrangements:search', { filterCriteria: [{ field: 'colour', operator: 'EQUALS', value: 'red' }] });
    check('an unknown field is refused', badField.status === 400 && /UNKNOWN_SEARCH_FIELD/.test(badField.reason), badField.text);
    const tellerSearch = await call('POST', '/api/creditarrangements:search', {}, { who: 'teller' });
    check('searching needs VIEW_LINE_OF_CREDIT_DETAILS, which staff hold', tellerSearch.status === 200, tellerSearch.text);
    await loanProduct('LOC1', { creditArrangementRequirement: 'OPTIONAL' });
    const cl1 = (await call('POST', '/api/loans', { memberId: m.id, productId: 'LOC1', principal: 12000, termMonths: 6, creditArrangementId: ca1.id })).body;
    await call('POST', `/api/loans/${cl1.id}/approve`, {});
    await call('POST', `/api/loans/${cl1.id}/disbursements`, { channelId: 'cash' });
    const sch = await call('GET', `/api/creditarrangements/${ca1.encodedKey}/schedule`);
    const inst = sch.body?.installments || [];
    check('GET /creditarrangements/{id}/schedule: the instalments of its loans', sch.status === 200 && inst.length === 6 && inst.every((i) => i.parentAccountId === cl1.account_no), sch.text);
    check('each with principal, interest and fees expected, paid and due', inst[0] && inst[0].principal.amount.expected === 2000 && inst[0].state === 'PENDING'
      && inst[0].interest.amount.due === inst[0].interest.amount.expected && inst.every((x, i) => !i || x.dueDate >= inst[i - 1].dueDate), JSON.stringify(inst[0]));
    const empty = await call('GET', `/api/creditarrangements/${ca2.encodedKey}/schedule`);
    check('an arrangement without loans has an empty schedule', empty.status === 200 && empty.body.installments.length === 0, empty.text);
  } catch (e) {
    fail++; failures.push(e.stack); console.error(e);
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
