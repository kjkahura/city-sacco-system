#!/usr/bin/env node
'use strict';

/**
 * Deposits > Working with Deposit Accounts, after the reference platform: the account's
 * balances, blocked funds and seizures, transaction holds, backdated
 * movements and the interest priced again, reversals (interest applied and
 * withholding tax, on open accounts only), inter-client transfers, bulk
 * deposits and bulk reversals, the account's own limits and its own
 * withholding tax source.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
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

const SLUG = 'dtxtest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4117;
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
  return { status: r.status, body: d, text: text.slice(0, 400), reason: `${d?.errors?.[0]?.errorReason || ''} ${d?.errors?.[0]?.errorSource || ''}` };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}
const product = (id, body = {}) => call('POST', '/api/deposit-products', {
  id, name: id, accountingMethod: 'NONE', interestPaidIntoAccount: true, interestDayCount: 'ACTUAL_365', ...body });
const errOf = (p) => p.then(() => 'ok', (e) => e.message);

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Deposit Transactions SACCO', mfaRequiredRoles: [], adminEmail: 'admin@dtx.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@dtx.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const u = await call('POST', '/api/users', { email: 'teller@dtx.local', fullName: 'The teller', password: PW, role: 'TELLER', branchId: 'HQ' });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
    tokens.teller = await login('teller@dtx.local');
    const m = (await call('POST', '/api/members', { firstName: 'Njeri', lastName: 'Saver', branchId: 'HQ' })).body;
    const m2 = (await call('POST', '/api/members', { firstName: 'Otieno', lastName: 'Other', branchId: 'HQ' })).body;
    const D0 = orgDay(-10);
    const today = orgDay(0);
    const yesterday = addDays(today, -1);
    const open = (productId, extra = {}, member = m) => T((c) => S.open(c, { memberId: member.id, productId, openedOn: D0, ...extra }));
    const put = (id, amount, valueDate = today) => T((c) => S.deposit(c, id, { amount, channelId: 'cash', valueDate, createdBy: 'test' }));
    const acc = async (id) => (await T((c) => c.query('SELECT * FROM savings_accounts WHERE id = $1', [id]))).rows[0];
    const bal = async (id) => (await call('GET', `/api/savings/${id}/balance`)).body;
    const accrue = (id, date = yesterday) => T((c) => S.accrueInterest(c, id, { date }));
    const apiDep = (id, body, who = 'admin') => call('POST', `/api/savings/${id}/deposits`, { channelId: 'cash', ...body }, { who });
    const apiWd = (id, body, who = 'admin') => call('POST', `/api/savings/${id}/withdrawals`, { channelId: 'cash', ...body }, { who });
    const reverse = (reference, who = 'admin') => call('POST', `/api/savings/transactions/${reference}/reversal`, {}, { who });
    check('staff signed in', tokens.admin && tokens.teller);

    // ------------------------------------------------------------------------
    section('the account\'s balances (the reference platform\'s overview details)');
    const a1 = await open('SAV01');
    await apiDep(a1.id, { amount: 10000 });
    const b1 = await bal(a1.id);
    check('the reference platform\'s seven balances', b1.balances && b1.balances.totalBalance === 10000 && b1.balances.availableBalance === 10000
      && b1.balances.holdBalance === 0 && b1.balances.blockedBalance === 0 && b1.balances.lockedBalance === 0 && b1.balances.overdraftAmountDue === 0, JSON.stringify(b1.balances));

    // ------------------------------------------------------------------------
    section('blocking and seizing funds');
    const tellerBlock = await call('POST', `/api/savings/${a1.id}/blocks`, { amount: 100 }, { who: 'teller' });
    check('blocking needs BLOCK_AND_SEIZE_FUNDS', tellerBlock.status === 403, tellerBlock.text);
    const blk = await call('POST', `/api/savings/${a1.id}/blocks`, { amount: 3000, externalReferenceId: 'COURT-1', notes: 'garnishee order' });
    check('funds are blocked, pending', blk.status === 201 && blk.body.state === 'PENDING' && blk.body.amount === 3000, blk.text);
    const big = await call('POST', `/api/savings/${a1.id}/blocks`, { amount: 50000, externalReferenceId: 'BIG' });
    check('a block may be larger than the balance (the reference platform)', big.status === 201, big.text);
    const dupe = await call('POST', `/api/savings/${a1.id}/blocks`, { amount: 5, externalReferenceId: 'BIG' });
    check('a block reference is used once on an account', dupe.status === 409 && /BLOCK_REFERENCE_IN_USE/.test(dupe.reason), dupe.text);
    const unbig = await call('DELETE', `/api/savings/${a1.id}/blocks/BIG`);
    check('a pending block is unblocked', unbig.status === 200 && unbig.body.state === 'UNBLOCKED', unbig.text);
    const b2 = await bal(a1.id);
    check('what is blocked is not available', b2.balances.blockedBalance === 3000 && b2.available === 7000 && b2.balances.totalBalance === 10000, JSON.stringify(b2.balances));
    const over = await apiWd(a1.id, { amount: 8000 });
    check('a withdrawal beyond what is not blocked is refused', over.status === 409 && /INSUFFICIENT_AVAILABLE_BALANCE.*3000 blocked/.test(over.reason), over.text);
    const okWd = await apiWd(a1.id, { amount: 7000 });
    check('what is not blocked is withdrawn', okWd.status === 201, okWd.text);
    const moreIn = await apiDep(a1.id, { amount: 500 });
    check('and deposits still come in', moreIn.status === 201, moreIn.text);
    const sz1 = await call('POST', `/api/savings/${a1.id}/seizure-transactions`, { blockId: 'COURT-1', amount: 1000, notes: 'first instalment' });
    check('part of a block is seized: a SAVINGS_SEIZURE', sz1.status === 201 && sz1.body.kind === 'SAVINGS_SEIZURE' && Number(sz1.body.amount) === 1000, sz1.text);
    const szTooMuch = await call('POST', `/api/savings/${a1.id}/seizure-transactions`, { blockId: 'COURT-1', amount: 2500 });
    check('no more than the block still holds', szTooMuch.status === 409 && /ABOVE_WHAT_THE_BLOCK_HOLDS: 2000/.test(szTooMuch.reason), szTooMuch.text);
    const sz2 = await call('POST', `/api/savings/${a1.id}/seizure-transactions`, { blockId: 'COURT-1' });
    const blocks = (await call('GET', `/api/savings/${a1.id}/blocks`)).body;
    const court = blocks.find((x) => x.externalReferenceId === 'COURT-1');
    check('the rest is seized and the block is SEIZED', sz2.status === 201 && court.state === 'SEIZED' && court.seizedAmount === 3000, JSON.stringify(court));
    check('the balance is what was left', Number((await acc(a1.id)).balance) === 500);
    const revSz = await reverse(sz2.body.reference);
    const court2 = (await call('GET', `/api/savings/${a1.id}/blocks`)).body.find((x) => x.externalReferenceId === 'COURT-1');
    check('a seizure is reversed: the money and the block are back', revSz.status === 201 && court2.state === 'PENDING' && court2.seizedAmount === 1000
      && Number((await acc(a1.id)).balance) === 2500, JSON.stringify(court2));
    const a2 = await open('SAV01');
    await call('POST', `/api/savings/${a2.id}/blocks`, { amount: 100, externalReferenceId: 'HOLDME' });
    const closeBlocked = await call('POST', `/api/savings/${a2.id}/close`, {});
    check('an account with blocked funds is not closed', closeBlocked.status === 409 && /ACCOUNT_HAS_BLOCKED_FUNDS/.test(closeBlocked.reason), closeBlocked.text);
    await call('DELETE', `/api/savings/${a2.id}/blocks/HOLDME`);
    const closeFree = await call('POST', `/api/savings/${a2.id}/close`, {});
    const blockClosed = await call('POST', `/api/savings/${a2.id}/blocks`, { amount: 1 });
    check('unblocked, it closes; a closed account takes no block', closeFree.status === 200 && blockClosed.status === 409, blockClosed.text);

    // ------------------------------------------------------------------------
    section('transaction holds');
    // a1: balance 2,500, 2,000 still blocked: 500 available.
    const tellerHold = await call('POST', `/api/savings/${a1.id}/authorizationholds`, { externalReferenceId: 'X', amount: 1 }, { who: 'teller' });
    check('holding needs CREATE_HOLDS', tellerHold.status === 403, tellerHold.text);
    const hTooBig = await call('POST', `/api/savings/${a1.id}/authorizationholds`, { externalReferenceId: 'CHQ-0', amount: 600 });
    check('a debit hold is no larger than what is available', hTooBig.status === 409 && /INSUFFICIENT_AVAILABLE_BALANCE: available 500/.test(hTooBig.reason), hTooBig.text);
    const h1 = await call('POST', `/api/savings/${a1.id}/authorizationholds`, { externalReferenceId: 'CHQ-1', amount: 400, creditDebitIndicator: 'DBIT' });
    check('a debit hold, pending', h1.status === 201 && h1.body.status === 'PENDING', h1.text);
    const long = await call('POST', `/api/savings/${a1.id}/authorizationholds`, { externalReferenceId: 'X'.repeat(33), amount: 1 });
    const dupH = await call('POST', `/api/savings/${a1.id}/authorizationholds`, { externalReferenceId: 'CHQ-1', amount: 1 });
    check('the reference is at most 32 characters and unique', long.status === 400 && dupH.status === 409, `${long.text} ${dupH.text}`);
    const b3 = await bal(a1.id);
    check('what is held is not available', b3.balances.holdBalance === 400 && b3.available === 100, JSON.stringify(b3.balances));
    check('a withdrawal cannot take it', (await apiWd(a1.id, { amount: 200 })).status === 409);
    const wrongAmt = await apiWd(a1.id, { amount: 300, holdExternalReferenceId: 'CHQ-1' });
    check('settling takes the exact amount held', wrongAmt.status === 409 && /THE_AMOUNT_MUST_MATCH_THE_HOLD/.test(wrongAmt.reason), wrongAmt.text);
    const withDate = await apiWd(a1.id, { amount: 400, holdExternalReferenceId: 'CHQ-1', valueDate: today });
    check('and no value date (the reference platform)', withDate.status === 400, withDate.text);
    const tellerSettle = await apiWd(a1.id, { amount: 400, holdExternalReferenceId: 'CHQ-1' }, 'teller');
    check('settling needs UPDATE_HOLDS', tellerSettle.status === 403 && /UPDATE_HOLDS/.test(tellerSettle.reason), tellerSettle.text);
    const settle = await apiWd(a1.id, { amount: 400, holdExternalReferenceId: 'CHQ-1' });
    const held = (await call('GET', `/api/savings/${a1.id}/authorizationholds`)).body.find((x) => x.externalReferenceId === 'CHQ-1');
    check('a withdrawal naming the hold settles it', settle.status === 201 && held.status === 'SETTLED' && held.transactionKey === settle.body.id, JSON.stringify(held));
    const cr = await call('POST', `/api/savings/${a1.id}/authorizationholds`, { externalReferenceId: 'IN-1', amount: 800, creditDebitIndicator: 'CRDT' });
    check('a credit hold is money on its way, not yet available', cr.status === 201 && (await bal(a1.id)).balances.pendingCredits === 800 && (await bal(a1.id)).available === 100);
    const crWrong = await apiWd(a1.id, { amount: 800, holdExternalReferenceId: 'IN-1' });
    check('a credit hold is settled by a deposit', crWrong.status === 409 && /A_CRDT_HOLD_IS_SETTLED_BY_A_DEPOSIT/.test(crWrong.reason), crWrong.text);
    const crOk = await apiDep(a1.id, { amount: 800, holdExternalReferenceId: 'IN-1' });
    check('and the deposit settles it', crOk.status === 201 && (await bal(a1.id)).balances.pendingCredits === 0 && (await bal(a1.id)).available === 900, crOk.text);
    await call('POST', `/api/savings/${a1.id}/authorizationholds`, { externalReferenceId: 'CHQ-2', amount: 100 });
    const rv = await call('DELETE', `/api/savings/${a1.id}/authorizationholds/CHQ-2`);
    const pendingOnly = (await call('GET', `/api/savings/${a1.id}/authorizationholds?status=PENDING`)).body;
    check('a pending hold is reversed, and the list filters by status', rv.status === 200 && rv.body.status === 'REVERSED' && pendingOnly.length === 0, rv.text);

    // ------------------------------------------------------------------------
    section('backdated movements (the reference platform: the interest from the value date is priced again)');
    await product('BD1', { annualRate: 36.5 });
    const bd = await open('BD1');
    await put(bd.id, 10000, D0);
    await accrue(bd.id);
    const before = Number((await acc(bd.id)).interest_accrued);
    check('10,000 at 36.5% earns 10 a day', near(before, 100), String(before));
    const future = await apiDep(bd.id, { amount: 10, valueDate: addDays(today, 1) });
    check('a value date in the future is refused', future.status === 400 && /VALUE_DATE_CANNOT_BE_IN_THE_FUTURE/.test(future.reason), future.text);
    const noPerm = await errOf(T((c) => S.deposit(c, bd.id, { amount: 10, channelId: 'cash', valueDate: addDays(today, -2), createdBy: 'test',
      user: { role: 'TELLER', permissions: ['MAKE_DEPOSIT'] } })));
    check('a past value date needs BACKDATE_SAVINGS_TRANSACTIONS', /PERMISSION_REQUIRED: BACKDATE_SAVINGS_TRANSACTIONS/.test(noPerm), noPerm);
    const back = await apiDep(bd.id, { amount: 10000, valueDate: addDays(today, -3) }, 'teller');
    const afterBack = Number((await acc(bd.id)).interest_accrued);
    check('a deposit dated three days back adds three days of interest on it', back.status === 201 && near(afterBack - before, 30) && back.body.allocation.repricedFrom === addDays(today, -3),
      `${back.text} ${afterBack}`);
    const daily = (await T((c) => c.query('SELECT balance FROM savings_daily_balances WHERE account_id = $1 AND day = $2', [bd.id, addDays(today, -2)]))).rows[0];
    check('and the recorded daily balances move with it', Number(daily.balance) === 20000, String(daily?.balance));
    const revBack = await reverse(back.body.reference);
    check('reversing it prices the days again', revBack.status === 201 && near(Number((await acc(bd.id)).interest_accrued), before), String((await acc(bd.id)).interest_accrued));
    await T((c) => S.applyInterest(c, bd.id, { date: yesterday }));
    const tooFar = await apiDep(bd.id, { amount: 10, valueDate: addDays(today, -2) });
    check('not before the day after the last interest application', tooFar.status === 409 && /BACKDATED_BEFORE_THE_LAST_INTEREST_APPLICATION/.test(tooFar.reason), tooFar.text);
    const fresh = await open('BD1');
    await accrue(fresh.id);
    await put(fresh.id, 1000);
    const overdraw = await apiWd(fresh.id, { amount: 500, valueDate: addDays(today, -3) });
    check('a backdated withdrawal that would overdraw a past day is refused (the reference platform)', overdraw.status === 409 && /BACKDATED_WITHDRAWAL_WOULD_OVERDRAW/.test(overdraw.reason), overdraw.text);

    // ------------------------------------------------------------------------
    section('reversing interest applied and withholding tax');
    await product('WHT1', { annualRate: 36.5, withholdingTaxPercent: 15 });
    const w = await open('WHT1');
    await put(w.id, 10000, D0);
    await accrue(w.id);
    const applied = await T((c) => S.applyInterest(c, w.id, { date: yesterday }));
    const intTx = applied.find((x) => x.kind === 'SAVINGS_INTEREST_APPLIED');
    const whtTx = applied.find((x) => x.kind === 'SAVINGS_WITHHOLDING_TAX');
    check('interest applied with 15% withholding tax', intTx && near(intTx.amount, 100) && whtTx && near(whtTx.amount, 15) && near((await acc(w.id)).balance, 10085));
    const revInt = await reverse(intTx.reference);
    const wA = await acc(w.id);
    check('reversing interest applied puts it back as accrued, and its tax is reversed with it',
      revInt.status === 201 && near(wA.balance, 10000) && near(wA.interest_accrued, 100) && !wA.last_interest_applied_on
      && revInt.body.allocation.alsoReversed?.[0] === whtTx.reference, `${revInt.text} ${wA.balance} ${wA.interest_accrued}`);
    const again = await T((c) => S.applyInterest(c, w.id, { date: yesterday }));
    check('and it is applied again', near(again.find((x) => x.kind === 'SAVINGS_INTEREST_APPLIED').amount, 100) && near((await acc(w.id)).balance, 10085));
    await accrue(w.id, today);
    const later = await T((c) => S.applyInterest(c, w.id, { date: today }));
    const earlier = again.find((x) => x.kind === 'SAVINGS_INTEREST_APPLIED');
    const notLatest = await reverse(earlier.reference);
    check('only the latest interest application is reversed', notLatest.status === 409 && /REVERSE_THE_LATEST_INTEREST_APPLICATION_FIRST/.test(notLatest.reason), notLatest.text);
    const whtAlone = await reverse(later.find((x) => x.kind === 'SAVINGS_WITHHOLDING_TAX').reference);
    check('withholding tax is reversed on its own', whtAlone.status === 201, whtAlone.text);
    const cz = await open('SAV01');
    const czIn = await put(cz.id, 50);
    await T((c) => S.withdraw(c, cz.id, { amount: 50, channelId: 'cash', createdBy: 'test' }));
    await call('POST', `/api/savings/${cz.id}/close`, {});
    const revClosed = await reverse(czIn.reference);
    check('a closed account\'s transactions are not reversed (the reference platform)', revClosed.status === 409 && /ACCOUNT_IS_CLOSED/.test(revClosed.reason), revClosed.text);

    // ------------------------------------------------------------------------
    section('inter-client transfers');
    const own2 = await open('SAV01');
    const theirs = await open('SAV01', {}, m2);
    await put(a1.id, 1000);
    const noInter = await errOf(T((c) => S.transfer(c, a1.id, { toAccountId: theirs.id, amount: 10, createdBy: 'test',
      user: { role: 'TELLER', permissions: ['MAKE_TRANSFER'] } })));
    const ownOk = await errOf(T((c) => S.transfer(c, a1.id, { toAccountId: own2.id, amount: 10, createdBy: 'test',
      user: { role: 'TELLER', permissions: ['MAKE_TRANSFER'] } })));
    check('to another holder needs MAKE_INTER_CLIENTS_TRANSFERS; to one\'s own account does not', /MAKE_INTER_CLIENTS_TRANSFERS/.test(noInter) && ownOk === 'ok', `${noInter} ${ownOk}`);
    const interOk = await call('POST', `/api/savings/${a1.id}/transfers`, { toAccountId: theirs.id, amount: 10 }, { who: 'teller' });
    check('a teller holds it by default, as holders of MAKE_TRANSFER do', interOk.status === 201, interOk.text);

    // ------------------------------------------------------------------------
    section('bulk deposits and bulk reversals');
    const bulk = await call('POST', '/api/savings/deposit-transactions:bulk', { transactions: [
      { accountId: own2.id, amount: 100, externalId: 'P-1' }, { accountId: 'NO-SUCH-ACCOUNT', amount: 50, externalId: 'P-2' },
      { accountId: theirs.account_no, amount: 70, transactionDetails: { transactionChannelId: 'cash' }, externalId: 'P-3' }] });
    check('each deposit posts on its own (the reference platform\'s bulk)', bulk.status === 202 && bulk.body.status === 'COMPLETED_WITH_ERRORS' && bulk.body.processed === 2 && bulk.body.failed === 1, bulk.text);
    const status = await call('GET', `/api/bulks/${bulk.body.bulkProcessKey}`);
    check('GET /bulks/:key tells which went through', status.status === 200 && status.body.processedItems.length === 2 && status.body.errors[0].externalId === 'P-2', status.text);
    const emptyBulk = await call('POST', '/api/savings/deposit-transactions:bulk', { transactions: [] });
    check('an empty bulk is refused', emptyBulk.status === 400, emptyBulk.text);
    const refs = status.body.processedItems.map((x) => x.transactionReference);
    const tellerBulkRev = await call('POST', '/api/savings/transactions/reversals', { references: refs }, { who: 'teller' });
    check('reversing several at once needs BULK_DEPOSIT_CORRECTIONS', tellerBulkRev.status === 403, tellerBulkRev.text);
    const bulkRev = await call('POST', '/api/savings/transactions/reversals', { references: [...refs, 'NOPE'], notes: 'posted twice' });
    check('each is reversed on its own', bulkRev.status === 200 && bulkRev.body.reversed.length === 2 && bulkRev.body.errors.length === 1, bulkRev.text);

    // ------------------------------------------------------------------------
    section('the account\'s own limits');
    await product('LIM1', { maxWithdrawalAmount: 1000 });
    const tooHigh = await errOf(open('LIM1', { maxWithdrawalAmount: 2000 }));
    check('an account\'s maximum withdrawal is within the product\'s', /MAX_WITHDRAWAL_AMOUNT_ABOVE_THE_PRODUCT_MAXIMUM/.test(tooHigh), tooHigh);
    const lim = await open('LIM1', { maxWithdrawalAmount: 500, recommendedDepositAmount: 250 });
    await put(lim.id, 5000);
    const limWd = await apiWd(lim.id, { amount: 600 });
    check('the lower limit holds', limWd.status === 409 && /ABOVE_THE_MAXIMUM_WITHDRAWAL: 500/.test(limWd.reason), limWd.text);
    const limB = await bal(lim.id);
    check('and the account shows its own amounts', limB.maxWithdrawalAmount === 500 && limB.recommendedDepositAmount === 250, JSON.stringify([limB.maxWithdrawalAmount, limB.recommendedDepositAmount]));
    const limEdit = await call('PATCH', `/api/savings/${lim.id}`, { maxWithdrawalAmount: 800 });
    check('they are edited at any time', limEdit.status === 200 && (await bal(lim.id)).maxWithdrawalAmount === 800, limEdit.text);

    // ------------------------------------------------------------------------
    section('withholding tax per account (the reference platform\'s :changeWithholdingTax)');
    await T(async (c) => {
      await c.query("INSERT INTO index_rate_sources (id, name, kind) VALUES ('WHT10', 'Withholding 10%', 'WITHHOLDING'), ('IDX', 'An index', 'INTEREST')");
      await c.query("INSERT INTO index_rates (source_id, valid_from, rate) VALUES ('WHT10', $1, 10), ('IDX', $1, 5)", [D0]);
    });
    const wt = await open('BD1');
    await put(wt.id, 10000, D0);
    const notWht = await call('POST', `/api/savings/${wt.id}:changeWithholdingTax`, { withholdingTaxSourceKey: 'IDX' });
    check('only a withholding tax source is taken', notWht.status === 400 && /NOT_A_WITHHOLDING_TAX_SOURCE/.test(notWht.reason), notWht.text);
    const chg = await call('POST', `/api/savings/${wt.id}:changeWithholdingTax`, { withholdingTaxSourceKey: 'WHT10' });
    check('the account takes its own source', chg.status === 200 && chg.body.rate === 10 && (await bal(wt.id)).withholdingTaxSourceId === 'WHT10', chg.text);
    const hist = await call('GET', `/api/savings/${wt.id}/withholdingtaxes`);
    check('and the change is kept', hist.status === 200 && hist.body.length === 1 && hist.body[0].withholdingTaxSourceKey === 'WHT10', hist.text);
    await accrue(wt.id);
    const wtApplied = await T((c) => S.applyInterest(c, wt.id, { date: yesterday }));
    const wtTax = wtApplied.find((x) => x.kind === 'SAVINGS_WITHHOLDING_TAX');
    check('interest applied is taxed at the account\'s rate', wtTax && near(wtTax.amount, 10) && wtTax.allocation.rate === 10, JSON.stringify(wtTax?.allocation));

    // ------------------------------------------------------------------------
    section('permissions');
    const codes = ['BACKDATE_SAVINGS_TRANSACTIONS', 'MAKE_INTER_CLIENTS_TRANSFERS', 'BULK_DEPOSIT_CORRECTIONS', 'BLOCK_AND_SEIZE_FUNDS',
      'VIEW_HOLDS', 'CREATE_HOLDS', 'UPDATE_HOLDS', 'DELETE_HOLDS'];
    check('the reference platform\'s permissions for these are in the catalogue', codes.every((x) => PERMS.CODES.has(x)));
    check('blocking and seizing is left to administrators', !PERMS.DEFAULTS.MANAGER.includes('BLOCK_AND_SEIZE_FUNDS') && !PERMS.DEFAULTS.TELLER.includes('BLOCK_AND_SEIZE_FUNDS'));
    await T((c) => c.query(`INSERT INTO roles (code, name, base_role, permissions) VALUES ('OLDTX', 'Old deposits role', 'MANAGER',
      ARRAY['MAKE_DEPOSIT', 'MAKE_TRANSFER', 'APPLY_SAVINGS_ADJUSTMENTS', 'VIEW_SAVINGS_ACCOUNT_DETAILS', 'EDIT_SAVINGS_ACCOUNT'])`));
    await pool.query("DELETE FROM platform.schema_migrations WHERE schema_name = $1 AND version LIKE '039%'", [SCHEMA]);
    await migrateAllTenants({});
    const old = (await T((c) => c.query("SELECT permissions FROM roles WHERE code = 'OLDTX'"))).rows[0].permissions;
    check('roles holding the matching permissions are given these, and the migration runs twice',
      codes.filter((x) => x !== 'BLOCK_AND_SEIZE_FUNDS').every((x) => old.includes(x)) && !old.includes('BLOCK_AND_SEIZE_FUNDS'), old.join(','));
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
