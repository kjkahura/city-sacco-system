#!/usr/bin/env node
'use strict';

/**
 * The reference platform's API v2 for deposit accounts at /api/deposits, over the same
 * accounts and rules as /api/savings: the account object and its overdraft
 * settings, list and search, create, read, replace and JSON Patch, the
 * colon actions, transactions, blocks and holds. Also the overdraft expiry
 * date at opening, an index rate's review frequency, and 30E/360.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const { orgDay, addDays } = require('./_org');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'dapitest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4118;
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

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Deposits API SACCO', mfaRequiredRoles: [], adminEmail: 'admin@dapi.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@dapi.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const u = await call('POST', '/api/users', { email: 'teller@dapi.local', fullName: 'The teller', password: PW, role: 'TELLER', branchId: 'HQ' });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
    tokens.teller = await login('teller@dapi.local');
    const m = (await call('POST', '/api/members', { firstName: 'Wambui', lastName: 'Api', branchId: 'HQ' })).body;
    const D0 = orgDay(-10);
    const today = orgDay(0);
    const yesterday = addDays(today, -1);
    const acc = async (id) => (await T((c) => c.query('SELECT * FROM savings_accounts WHERE id = $1', [id]))).rows[0];
    check('staff signed in', tokens.admin && tokens.teller);
    await product('CUR1', { productType: 'CURRENT_ACCOUNT', allowOverdraft: true, maxOverdraftLimit: 20000, overdraftAnnualRate: 20,
      overdraftRateMin: 10, overdraftRateMax: 30, annualRate: 2 });

    // ------------------------------------------------------------------------
    section('creating an account the reference platform way, with its overdraft terms');
    const expiry = addDays(today, 30);
    const cr = await call('POST', '/api/deposits', {
      accountHolderKey: m.member_no, productTypeKey: 'CUR1', name: 'Shop account', notes: 'opened by API',
      overdraftSettings: { overdraftLimit: 5000, overdraftExpiryDate: expiry },
      overdraftInterestSettings: { interestRateSettings: { interestRate: 18 } },
      internalControls: { maxDepositBalance: 100000 },
    });
    const a = cr.body;
    check('POST /deposits opens it', cr.status === 201 && a.accountType === 'CURRENT_ACCOUNT' && a.accountState === 'ACTIVE' && a.name === 'Shop account'
      && a.notes === 'opened by API' && a.accountHolderKey === m.id, cr.text);
    check('with its overdraft limit, expiry date and rate (the reference platform\'s overdraftSettings and overdraftInterestSettings)',
      a.overdraftSettings?.allowOverdraft === true && a.overdraftSettings.overdraftLimit === 5000 && a.overdraftSettings.overdraftExpiryDate === expiry
      && a.overdraftInterestSettings.interestRateSettings.interestRate === 18 && a.overdraftInterestSettings.interestRateSettings.interestRateSource === 'FIXED_INTEREST_RATE',
      JSON.stringify(a.overdraftSettings));
    check('and its internal controls', a.internalControls.maxDepositBalance === 100000, JSON.stringify(a.internalControls));
    const badRate = await call('POST', '/api/deposits', { accountHolderKey: m.id, productTypeKey: 'CUR1',
      overdraftSettings: { overdraftLimit: 100 }, overdraftInterestSettings: { interestRateSettings: { interestRate: 40 } } });
    check('an overdraft rate outside the product\'s range is refused', badRate.status === 400 && /OVERDRAFT_RATE_ABOVE_THE_PRODUCT_MAXIMUM/.test(badRate.reason), badRate.text);
    const viaSavings = await call('POST', '/api/savings', { memberId: m.id, productId: 'CUR1', overdraftLimit: 1000, overdraftExpiryDate: expiry });
    check('/api/savings takes the expiry date at opening too', viaSavings.status === 201 && String(viaSavings.body.overdraft_expires_on).slice(0, 10) === expiry, viaSavings.text);
    const noLimit = await call('POST', '/api/savings', { memberId: m.id, productId: 'CUR1', overdraftExpiryDate: expiry });
    check('an expiry date needs a limit', noLimit.status === 400 && /AN_OVERDRAFT_EXPIRY_DATE_NEEDS_AN_OVERDRAFT_LIMIT/.test(noLimit.reason), noLimit.text);

    // ------------------------------------------------------------------------
    section('reading, listing and searching');
    const got = await call('GET', `/api/deposits/${a.id}`);
    check('GET /deposits/:id by the account number or key', got.status === 200 && got.body.encodedKey === a.encodedKey
      && (await call('GET', `/api/deposits/${a.encodedKey}`)).body.id === a.id, got.text);
    const listed = await call('GET', '/api/deposits?accountState=ACTIVE&paginationDetails=ON&limit=50');
    check('GET /deposits filters by state, with paging headers', listed.status === 200 && listed.body.some((x) => x.id === a.id) && Number(listed.total) >= 2, listed.text);
    const found = await call('POST', '/api/deposits:search', { filterCriteria: [{ field: 'overdraftSettings.overdraftLimit', operator: 'MORE_THAN', value: 2000 },
      { field: 'accountHolderKey', operator: 'EQUALS', value: m.id }] });
    check('POST /deposits:search on the overdraft limit', found.status === 200 && found.body.length === 1 && found.body[0].id === a.id, found.text);
    const bad = await call('POST', '/api/deposits:search', { filterCriteria: [{ field: 'colour', operator: 'EQUALS', value: 1 }] });
    check('an unknown search field is refused', bad.status === 400 && /UNKNOWN_SEARCH_FIELD/.test(bad.reason), bad.text);

    // ------------------------------------------------------------------------
    section('transactions');
    const dep = await call('POST', `/api/deposits/${a.id}/deposit-transactions`, { amount: 1000, transactionDetails: { transactionChannelId: 'cash' }, notes: 'first' });
    check('deposit-transactions: a DEPOSIT', dep.status === 201 && dep.body.type === 'DEPOSIT' && dep.body.amount === 1000, dep.text);
    const wd = await call('POST', `/api/deposits/${a.id}/withdrawal-transactions`, { amount: 3000, transactionDetails: { transactionChannelId: 'cash' } });
    check('withdrawal-transactions into the overdraft', wd.status === 201 && wd.body.type === 'WITHDRAWAL' && wd.body.affectedAmounts.overdraftAmount === 2000, wd.text);
    const after = (await call('GET', `/api/deposits/${a.id}`)).body;
    check('the balances show what is overdrawn', after.balances.totalBalance === -2000 && after.balances.overdraftAmount === 2000
      && after.balances.technicalOverdraftAmount === 0 && after.balances.availableBalance === 3000, JSON.stringify(after.balances));
    const fee = await call('POST', `/api/deposits/${a.id}/fee-transactions`, { amount: 10, notes: 'Statement' });
    check('fee-transactions: a FEE_APPLIED', fee.status === 201 && fee.body.type === 'FEE_APPLIED', fee.text);
    const other = (await call('POST', '/api/deposits', { accountHolderKey: m.id, productTypeKey: 'SAV01' })).body;
    const tr = await call('POST', `/api/deposits/${a.id}/transfer-transactions`, { amount: 100, transferDetails: { linkedAccountId: other.id, linkedAccountType: 'DEPOSIT' } });
    check('transfer-transactions to another deposit account', tr.status === 201 && tr.body.type === 'TRANSFER' && tr.body.transferDetails.linkedAccountId === other.id, tr.text);
    await call('POST', `/api/savings/transactions/${fee.body.id}/reversal`, {});
    const txs = (await call('GET', `/api/deposits/${a.id}/transactions`)).body;
    check('GET /deposits/:id/transactions, with a reversal as the reference platform\'s adjustment type', txs.some((x) => x.type === 'FEE_ADJUSTED')
      && txs.find((x) => x.id === fee.body.id).adjustmentTransactionKey, JSON.stringify(txs.map((x) => x.type)));
    const bulk = await call('POST', '/api/deposits/deposit-transactions:bulk', { transactions: [{ accountId: other.id, amount: 50 }] });
    check('bulk deposits under /deposits too', bulk.status === 202 && bulk.body.processed === 1, bulk.text);

    // ------------------------------------------------------------------------
    section('adjusting overdraft terms by PATCH and PUT');
    const tooLow = await call('PATCH', `/api/deposits/${a.id}`, [{ op: 'replace', path: '/overdraftSettings/overdraftLimit', value: 1000 }]);
    check('a limit below what is owed is refused without a technical overdraft', tooLow.status === 409 && /BALANCE_ALREADY_BELOW_THAT_LIMIT/.test(tooLow.reason), tooLow.text);
    const raise = await call('PATCH', `/api/deposits/${a.id}`, [{ op: 'replace', path: '/overdraftSettings/overdraftLimit', value: 8000 },
      { op: 'replace', path: '/overdraftInterestSettings/interestRateSettings/interestRate', value: 22 }]);
    check('JSON Patch raises the limit and the rate', raise.status === 200 && raise.body.overdraftSettings.overdraftLimit === 8000
      && raise.body.overdraftInterestSettings.interestRateSettings.interestRate === 22, raise.text);
    const expire = await call('PATCH', `/api/deposits/${a.id}`, [{ op: 'replace', path: '/overdraftSettings/overdraftExpiryDate', value: addDays(today, -1) }]);
    check('an expiry date in the past puts the overdrawn account in arrears', expire.status === 200 && expire.body.accountState === 'ACTIVE_IN_ARREARS'
      && expire.body.lastSetToArrearsDate === today, expire.text);
    const back = await call('PATCH', `/api/deposits/${a.id}`, [{ op: 'remove', path: '/overdraftSettings/overdraftExpiryDate' }]);
    check('removing the expiry date lends again: ACTIVE', back.status === 200 && back.body.accountState === 'ACTIVE' && back.body.overdraftSettings.overdraftExpiryDate === null, back.text);
    const rename = await call('PATCH', `/api/deposits/${a.id}`, [{ op: 'replace', path: '/name', value: 'Main shop' }]);
    check('the name is patched', rename.status === 200 && rename.body.name === 'Main shop', rename.text);
    const state = await call('PATCH', `/api/deposits/${a.id}`, [{ op: 'replace', path: '/accountState', value: 'LOCKED' }]);
    check('the state is not patched; :changeState changes it', state.status === 400 && /FIELDS_NOT_EDITABLE: accountState; use :changeState/.test(state.reason), state.text);
    const terms = await call('PATCH', `/api/deposits/${a.id}`, [{ op: 'replace', path: '/interestSettings/interestRateSettings/interestRate', value: 1 }]);
    check('the credit rate of an active account changes through :changeInterestRate', terms.status === 409 && /TERMS_ARE_EDITED_BEFORE_ACTIVATION/.test(terms.reason), terms.text);
    const current = (await call('GET', `/api/deposits/${a.id}`)).body;
    const put = await call('PUT', `/api/deposits/${a.id}`, { ...current, notes: 'replaced', internalControls: { ...current.internalControls, maxWithdrawalAmount: 5000 } });
    check('PUT the object back with changes: only what changed is applied', put.status === 200 && put.body.notes === 'replaced'
      && put.body.internalControls.maxWithdrawalAmount === 5000 && put.body.overdraftSettings.overdraftLimit === 8000, put.text);
    const tellerPut = await call('PUT', `/api/deposits/${a.id}`, { ...current, notes: 'x' }, { who: 'teller' });
    check('replacing needs EDIT_SAVINGS_ACCOUNT', tellerPut.status === 403, tellerPut.text);

    // ------------------------------------------------------------------------
    section('colon actions, blocks and holds');
    const lock = await call('POST', `/api/deposits/${a.id}:changeState`, { action: 'LOCK', notes: 'review' });
    const unlock = await call('POST', `/api/deposits/${a.id}:changeState`, { action: 'UNLOCK' });
    check(':changeState locks and unlocks', lock.status === 200 && lock.body.accountState === 'LOCKED' && unlock.body.accountState === 'ACTIVE', lock.text);
    const tellerRate = await call('POST', `/api/deposits/${other.id}:changeInterestRate`, { interestRate: 3 }, { who: 'teller' });
    check(':changeInterestRate checks EDIT_SAVINGS_ACCOUNT itself', tellerRate.status === 403 && /EDIT_SAVINGS_ACCOUNT/.test(tellerRate.reason), tellerRate.text);
    const rate = await call('POST', `/api/deposits/${other.id}:changeInterestRate`, { interestRate: 3 });
    check(':changeInterestRate', rate.status === 200 && rate.body.interestSettings.interestRateSettings.interestRate === 3, rate.text);
    await T((c) => c.query('UPDATE savings_accounts SET opened_on = $2, period_started_on = $2, accrued_through = NULL WHERE id = $1', [other.encodedKey, D0]));
    const ap = await call('POST', `/api/deposits/${other.id}:applyInterest`, { interestApplicationDate: yesterday });
    check(':applyInterest accrues and applies to the date', ap.status === 200 && ap.body.lastInterestStoredDate === yesterday, ap.text);
    const future = await call('POST', `/api/deposits/${other.id}:applyInterest`, { interestApplicationDate: addDays(today, 3) });
    check('not to a future date', future.status === 400, future.text);
    const blk = await call('POST', `/api/deposits/${other.id}/blocks`, { amount: 10, externalReferenceId: 'B1' });
    const hold = await call('POST', `/api/deposits/${other.id}/authorizationholds`, { externalReferenceId: 'H1', amount: 5 });
    const shown = (await call('GET', `/api/deposits/${other.id}`)).body.balances;
    check('blocks and holds under /deposits, and in the balances', blk.status === 201 && hold.status === 201 && shown.blockedBalance === 10 && shown.holdBalance === 5, JSON.stringify(shown));
    const fresh = (await call('POST', '/api/deposits', { accountHolderKey: m.id, productTypeKey: 'SAV01' })).body;
    const del = await call('DELETE', `/api/deposits/${fresh.id}`);
    check('DELETE /deposits/:id for an account nothing was posted to', del.status === 204, del.text);

    // ------------------------------------------------------------------------
    section('an index rate\'s review frequency (the reference platform\'s Interest Rate Review Frequency)');
    await T(async (c) => {
      await c.query("INSERT INTO index_rate_sources (id, name, kind) VALUES ('BASE', 'Base rate', 'INTEREST')");
      await c.query("INSERT INTO index_rates (source_id, valid_from, rate) VALUES ('BASE', $1, 10), ('BASE', $2, 20)", [addDays(D0, -30), addDays(D0, 3)]);
    });
    const reviewFixed = await product('FIXR', { annualRate: 5, interestReviewCount: 1, interestReviewUnit: 'MONTHS' });
    check('a review frequency is for an INDEX rate', reviewFixed.status === 400 && /a review frequency is for an INDEX rate/.test(reviewFixed.reason), reviewFixed.text);
    const half = await product('HALF', { interestRateTerms: 'INDEX', interestIndexSourceId: 'BASE', interestSpreadDefault: 0, interestReviewCount: 1 });
    check('its count and unit are given together', half.status === 400 && /given together/.test(half.reason), half.text);
    const rv = await product('IDXR', { interestRateTerms: 'INDEX', interestIndexSourceId: 'BASE', interestSpreadDefault: 0, interestReviewCount: 1, interestReviewUnit: 'MONTHS' });
    await product('IDXD', { interestRateTerms: 'INDEX', interestIndexSourceId: 'BASE', interestSpreadDefault: 0 });
    check('a product whose index rate is reviewed monthly', rv.status === 201 && rv.body.interest.review?.unit === 'MONTHS', rv.text);
    const monthly = await T((c) => S.open(c, { memberId: m.id, productId: 'IDXR', openedOn: D0 }));
    const daily = await T((c) => S.open(c, { memberId: m.id, productId: 'IDXD', openedOn: D0 }));
    for (const x of [monthly, daily]) {
      await T((c) => S.deposit(c, x.id, { amount: 10000, channelId: 'cash', valueDate: D0, createdBy: 'test' }));
      await T((c) => S.accrueInterest(c, x.id, { date: yesterday }));
    }
    const mA = Number((await acc(monthly.id)).interest_accrued);
    const dA = Number((await acc(daily.id)).interest_accrued);
    check('reviewed monthly, the rate stays at its review date\'s 10% for the ten days', near(mA, 10000 * 0.10 * 10 / 365), String(mA));
    check('unreviewed, the rate follows the index to 20% on its date', near(dA, 10000 * (0.10 * 3 + 0.20 * 7) / 365), String(dA));
    const shownRv = (await call('GET', `/api/deposits/${monthly.id}`)).body.interestSettings.interestRateSettings;
    check('and /deposits shows it', shownRv.interestRateSource === 'INDEX_INTEREST_RATE' && shownRv.interestRateReviewCount === 1
      && shownRv.interestRateReviewUnit === 'MONTHS' && shownRv.indexSourceKey === 'BASE', JSON.stringify(shownRv));
    const odReview = await call('PATCH', '/api/deposit-products/CUR1', { overdraftReviewCount: 1, overdraftReviewUnit: 'WEEKS' });
    check('the overdraft rate\'s review is for an INDEX overdraft rate too', odReview.status === 400 && /the overdraft rate is FIXED/.test(odReview.reason), odReview.text);

    // ------------------------------------------------------------------------
    section('30E/360');
    await product('E30', { annualRate: 3.6, interestDayCount: 'THIRTY_360' });
    const e = (await call('POST', '/api/deposits', { accountHolderKey: m.id, productTypeKey: 'E30' })).body;
    check('the platform\'s 30/360 is the reference platform\'s 30E/360', e.interestSettings.interestRateSettings.daysInYear === 'E30_360', JSON.stringify(e.interestSettings));
    const S2 = require('../src/domain/schedule');
    check('30E/360: the 31st counts as the 30th at either end', S2.dayCount('2026-01-30', '2026-01-31', 'THIRTY_360') === 0
      && S2.dayCount('2026-01-31', '2026-02-28', 'THIRTY_360') === 30 && S2.dayCount('2026-03-15', '2026-03-31', 'THIRTY_360') === 15);
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
