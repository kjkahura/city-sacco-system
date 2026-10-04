#!/usr/bin/env node
'use strict';

/**
 * Searching loan and deposit transactions across accounts, for the
 * console's Loan Transactions and Deposit Transactions lists
 * (docs/superpowers/specs/2026-10-04-console-navigation-design.md):
 * src/domain/transactionSearch, POST /api/loans/transactions:search and
 * POST /api/deposits/transactions:search, and GET /api/loans with a list of
 * states.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'txsearch';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4123;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);

const tokens = {};
async function call(method, p, body, { who = 'admin' } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 400), reason: `${d?.errors?.[0]?.errorReason || ''}`, total: r.headers.get('items-total') };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Search SACCO', mfaRequiredRoles: [], adminEmail: 'admin@tx.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@tx.local', PASSWORD);
    const hq = (await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' })).body;
    await call('POST', '/api/branches', { code: 'NKR', name: 'Nakuru' });
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@tx.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@tx.local`);
    };
    const role = await call('POST', '/api/roles', { name: 'No accounts', code: 'NO_ACCOUNTS', baseRole: 'TELLER', permissions: ['VIEW_CLIENT_DETAILS'] });
    check('a role without the account permissions', role.status === 201, role.text);
    await mk('hq', { role: 'AUDITOR', branchId: 'HQ', accessRights: { allBranches: false } });
    await mk('none', { role: 'NO_ACCOUNTS', branchId: 'HQ' });

    const made = {};
    for (const [code, name, amounts] of [['HQ', 'Akinyi', [30000, 20000]], ['NKR', 'Baraka', [40000, 10000]]]) {
      const m = (await call('POST', '/api/members', { firstName: name, lastName: 'Search', branchId: code })).body;
      const sav = (await call('POST', '/api/savings', { memberId: m.id, productId: 'SAV01' })).body;
      for (const amount of amounts) await call('POST', `/api/savings/${sav.id}/deposits`, { amount, channelId: 'cash' });
      await call('POST', `/api/savings/${sav.id}/withdrawals`, { amount: 5000, channelId: 'cash' });
      const loan = (await call('POST', '/api/loans', { memberId: m.id, productId: 'NL01', principal: 12000, termMonths: 6 })).body;
      await call('POST', `/api/loans/${loan.id}/approve`, {});
      const disb = await call('POST', `/api/loans/${loan.id}/disbursements`, { channelId: 'cash' });
      const rep = await call('POST', `/api/loans/${loan.id}/repayments`, { amount: 1000, channelId: 'cash' });
      check(`${name}'s accounts and a repayment`, disb.status < 300 && rep.status < 300, `${disb.text} ${rep.text}`);
      made[code] = { m, sav, loan };
    }
    const { rows: [dep] } = await T((c) => c.query("SELECT reference FROM transactions WHERE kind = 'SAVINGS_DEPOSIT' AND savings_account_id = $1 ORDER BY created_at LIMIT 1", [made.HQ.sav.id]));
    const { rows: [rep] } = await T((c) => c.query("SELECT reference FROM transactions WHERE kind = 'LOAN_REPAYMENT' AND loan_account_id = $1", [made.HQ.loan.id]));
    const r1 = await call('POST', `/api/savings/transactions/${dep.reference}/reversal`, { notes: 'test' });
    const r2 = await call('POST', `/api/loans/transactions/${rep.reference}/reversal`, { notes: 'test' });
    check('one deposit and one loan repayment reversed', r1.status < 300 && r2.status < 300, `${r1.text} ${r2.text}`);

    // ------------------------------------------------------------------------
    section('the search (src/domain/transactionSearch)');
    const TS = require('../src/domain/transactionSearch');
    const pg = { offset: 0, limit: 50 };
    const loanRev = await T((c) => TS.search(c, 'LOAN', { filterCriteria: [{ field: 'type', operator: 'IN', values: ['REVERSAL'] }] }, pg));
    check('loan reversals are the loan\'s only, naming what they reverse', loanRev.rows.length === 1 && loanRev.rows[0].reversalOf === rep.reference
      && loanRev.rows[0].accountKey === made.HQ.loan.id, JSON.stringify(loanRev.rows));
    const depRev = await T((c) => TS.search(c, 'DEPOSIT', { filterCriteria: [{ field: 'type', operator: 'IN', values: ['REVERSAL'] }] }, pg));
    check('deposit reversals are the deposit account\'s only', depRev.rows.length === 1 && depRev.rows[0].reversalOf === dep.reference, JSON.stringify(depRev.rows));
    const deposits = await T((c) => TS.search(c, 'DEPOSIT', { filterCriteria: [{ field: 'type', operator: 'IN', values: ['SAVINGS_DEPOSIT'] }] }, pg));
    check('deposits across accounts', deposits.rows.length === 4 && deposits.total === 4, String(deposits.rows.length));
    const row = deposits.rows[0];
    check('a row\'s shape', row && typeof row.amount === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(row.valueDate) && row.memberName && row.accountId && row.branchKey
      && typeof row.reversed === 'boolean' && row.productKey === 'SAV01', JSON.stringify(row));
    const sorted = await T((c) => TS.search(c, 'DEPOSIT', { filterCriteria: [{ field: 'type', operator: 'IN', values: ['SAVINGS_DEPOSIT'] }], sortingCriteria: { field: 'amount', order: 'ASC' } }, pg));
    check('sorted by amount', sorted.rows.map((r) => r.amount).join() === '10000,20000,30000,40000', sorted.rows.map((r) => r.amount).join());
    const reversed = await T((c) => TS.search(c, 'DEPOSIT', { filterCriteria: [{ field: 'reversed', operator: 'EQUALS', value: 'true' }] }, pg));
    check('the reversed originals', reversed.rows.length === 1 && reversed.rows[0].id === dep.reference && reversed.rows[0].reversed === true, JSON.stringify(reversed.rows));
    const page = await T((c) => TS.search(c, 'DEPOSIT', { filterCriteria: [{ field: 'type', operator: 'IN', values: ['SAVINGS_DEPOSIT'] }] }, { offset: 1, limit: 1 }));
    check('paged, with the whole count', page.rows.length === 1 && page.total === 4);
    const byMember = await T((c) => TS.search(c, 'LOAN', { filterCriteria: [{ field: 'memberKey', operator: 'EQUALS', value: made.NKR.m.id }] }, pg));
    check('by member', byMember.rows.length >= 2 && byMember.rows.every((r) => r.memberId === made.NKR.m.member_no), JSON.stringify(byMember.rows.map((r) => r.memberId)));

    // ------------------------------------------------------------------------
    section('the two endpoints');
    const repay = { filterCriteria: [{ field: 'type', operator: 'IN', values: ['LOAN_REPAYMENT'] }] };
    const lr = await call('POST', '/api/loans/transactions:search?paginationDetails=ON', repay);
    check('loan transactions by type, with the count', lr.status === 200 && lr.body.length === 2 && lr.total === '2', `${lr.status} ${lr.text}`);
    const dAll = await call('POST', '/api/deposits/transactions:search?paginationDetails=ON', {});
    check('deposit transactions, not taken by the colon actions', dAll.status === 200 && Array.isArray(dAll.body) && dAll.body.length === 7, `${dAll.status} ${dAll.text}`);
    const lHq = await call('POST', '/api/loans/transactions:search', {}, { who: 'hq' });
    const dHq = await call('POST', '/api/deposits/transactions:search', {}, { who: 'hq' });
    check('a user limited to a branch finds that branch\'s only', lHq.status === 200 && dHq.status === 200 && lHq.body.length > 0 && dHq.body.length > 0
      && [...lHq.body, ...dHq.body].every((r) => r.branchKey === hq.id), `${lHq.text} ${dHq.text}`);
    const lNo = await call('POST', '/api/loans/transactions:search', {}, { who: 'none' });
    const dNo = await call('POST', '/api/deposits/transactions:search', {}, { who: 'none' });
    check('each needs its view permission', lNo.status === 403 && dNo.status === 403, `${lNo.status} ${dNo.status}`);
    const bad = await call('POST', '/api/loans/transactions:search', { filterCriteria: [{ field: 'nonsense', operator: 'EQUALS', value: 'x' }] });
    check('an unknown field is refused', bad.status === 400 && /UNKNOWN_SEARCH_FIELD/.test(bad.reason), bad.text);

    // ------------------------------------------------------------------------
    section('GET /api/loans with several states');
    const po = await call('POST', `/api/loans/${made.NKR.loan.id}/pay-off`, { channelId: 'cash' });
    check('one loan paid off', po.status < 300, po.text);
    const both = await call('GET', '/api/loans?status=ACTIVE,CLOSED_REPAID');
    const st = (both.body || []).map((l) => l.status).sort().join();
    check('a list of states gives loans in any of them', both.status === 200 && st === 'ACTIVE,CLOSED_REPAID', st);
    const one = await call('GET', '/api/loans?status=ACTIVE');
    check('one state as before', one.status === 200 && one.body.length === 1 && one.body[0].status === 'ACTIVE', one.text);
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
