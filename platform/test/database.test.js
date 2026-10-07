#!/usr/bin/env node
'use strict';

/**
 * The database work of October 2026 (docs/data-architecture.md): the daily
 * rollup spread over slots (tenant migration 052), the retry of deadlocked
 * transactions, optimistic locking of configuration (053, lib/versioning),
 * reports read through the replica pool, and the direct pool for session
 * advisory locks.
 *
 * The replica and direct pools are pointed at this same database, so the
 * suite checks the routing (which pool a read used) without a second server.
 */

process.env.PG_REPLICA_HOST = process.env.PG_REPLICA_HOST || process.env.PGHOST || 'localhost';
process.env.PG_DIRECT_HOST = process.env.PG_DIRECT_HOST || process.env.PGHOST || 'localhost';

const { spawnSync } = require('child_process');
const path = require('path');
const app = require('../src/server');
const { pool, endAll } = require('../src/db/pool');
const { withTenant, retryConflicts, withTenantReport } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const acct = require('../src/domain/accounting');
const YAML = require('../src/lib/yaml');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'dbtest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4139;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);

const tokens = {};
async function call(method, p, body, { type = null, ifMatch = null } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens.admin) headers.authorization = `Bearer ${tokens.admin}`;
  if (ifMatch) headers['if-match'] = ifMatch;
  let payload;
  if (type) { headers['content-type'] = type; payload = body; }
  else if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, raw: text, text: text.slice(0, 300), reason: `${d?.errors?.[0]?.errorReason || ''}`, h: (n) => r.headers.get(n) };
}
const store = require('../src/lib/ratestore');
async function login(email, password) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password })).body?.accessToken;
}
const apps = async () => (await pool.query("SELECT DISTINCT application_name AS a FROM pg_stat_activity WHERE datname = current_database()")).rows.map((r) => r.a);

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Database SACCO', mfaRequiredRoles: [], adminEmail: 'admin@db.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@db.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const accounts = [];
    for (let k = 0; k < 12; k += 1) {
      const m = (await call('POST', '/api/members', { firstName: 'Slot', lastName: `M${k}`, branchId: 'HQ' })).body;
      accounts.push((await T((c) => S.open(c, { memberId: m.id, productId: 'SAV01' }))).id);
    }
    check('a SACCO with twelve deposit accounts', tokens.admin && accounts.length === 12);
    check('migrations used the direct pool', (await apps()).includes('sacco-platform-direct'), (await apps()).join());

    // ------------------------------------------------------------------------
    section('the daily rollup over slots (052)');
    {
      const { rows } = await T((c) => c.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'gl_daily_balances'::regclass AND i.indisprimary`));
      check('the slot is part of the rollup\'s key', rows.map((r) => r.attname).sort().join() === 'booking_date,gl_code,is_closing,slot', rows.map((r) => r.attname).join());
      await Promise.all(accounts.map((id) => T((c) => S.deposit(c, id, { amount: 1000, channelId: 'cash', createdBy: 'test' }))));
      await Promise.all(accounts.map((id) => T((c) => S.deposit(c, id, { amount: 250, channelId: 'cash', createdBy: 'test' }))));
      const { rows: slots } = await T((c) => c.query("SELECT count(*)::int AS n, sum(debit)::numeric AS debit FROM gl_daily_balances WHERE gl_code = '100-200'"));
      check('concurrent deposits are spread over more than one slot', slots[0].n > 1, String(slots[0].n));
      check('and the slots add up to the cash deposited', Number(slots[0].debit) === 12 * 1250, String(slots[0].debit));
      const v = await T((c) => acct.verifyRollup(c));
      check('the rollup still matches the journal exactly', v.exact, JSON.stringify(v.mismatches));
      const { rows: br } = await T((c) => c.query("SELECT sum(debit)::numeric AS debit FROM gl_branch_daily_balances WHERE gl_code = '100-200'"));
      check('the branch rollup adds up too', Number(br[0].debit) === 12 * 1250, String(br[0].debit));
      const tb = await call('GET', '/api/accounting/trial-balance?limit=200');
      const cash = (tb.body?.rows || []).find((r) => r.code === '100-200');
      check('the trial balance reads the sum of the slots', tb.status === 200 && cash && Number(cash.debit) === 12 * 1250 && tb.body.balanced, tb.text);
    }

    // ------------------------------------------------------------------------
    section('a deadlock is run again (retryConflicts)');
    {
      const [a, b] = accounts;
      const warnings = [];
      const warn = console.warn;
      console.warn = (m) => { warnings.push(String(m)); };
      let gate;
      const both = new Promise((ok) => { let n = 0; gate = () => { n += 1; if (n === 2) ok(); }; });
      const tries = { one: 0, two: 0 };
      const lockBoth = (first, second, key) => retryConflicts(() => T(async (c) => {
        tries[key] += 1;
        await c.query('SELECT 1 FROM savings_accounts WHERE id = $1 FOR UPDATE', [first]);
        if (tries[key] === 1) { gate(); await both; }
        await c.query('SELECT 1 FROM savings_accounts WHERE id = $1 FOR UPDATE', [second]);
        return key;
      }), { label: 'test' });
      const out = await Promise.allSettled([lockBoth(a, b, 'one'), lockBoth(b, a, 'two')]);
      console.warn = warn;
      check('two transactions locking in opposite orders both finish', out.every((r) => r.status === 'fulfilled'), JSON.stringify(out.map((r) => r.reason?.code || r.status)));
      check('one of them was run again after PostgreSQL broke the deadlock', tries.one + tries.two === 3 && warnings.some((w) => /deadlock on test/.test(w)), `${JSON.stringify(tries)} ${warnings.join(' | ')}`);
      let n = 0;
      const e1 = await retryConflicts(async () => { n += 1; throw Object.assign(new Error('x'), { code: '23505' }); }).catch((e) => e);
      check('other errors are not retried', e1.code === '23505' && n === 1);
      n = 0;
      const e2 = await retryConflicts(async () => { n += 1; throw Object.assign(new Error('x'), { code: '40P01' }); }, { retries: 0 }).catch((e) => e);
      check('with no retries the conflict reaches the caller (409 CONFLICT_TRY_AGAIN)', e2.code === '40P01' && n === 1);
      n = 0;
      console.warn = () => {};
      const e3 = await retryConflicts(async () => { n += 1; throw Object.assign(new Error('x'), { code: '40001' }); }, { retries: 2 }).catch((e) => e);
      console.warn = warn;
      check('a serialization conflict is retried at most the set number of times', e3.code === '40001' && n === 3, String(n));
      n = 0;
      const e4 = await retryConflicts(async () => { n += 1; throw Object.assign(new Error('x'), { code: '40P01' }); }, { canRetry: () => false }).catch((e) => e);
      check('nothing is retried once the answer has been sent', e4.code === '40P01' && n === 1);
    }

    // ------------------------------------------------------------------------
    section('optimistic locking of configuration (053)');
    {
      let r = await call('GET', '/api/loan-products/NL01');
      const tag1 = r.h('etag');
      check('a loan product answers with its version', r.status === 200 && /^"v\d+"$/.test(tag1 || ''), tag1);
      r = await call('PATCH', '/api/loan-products/NL01', { name: 'Normal Loan (A)' }, { ifMatch: tag1 });
      const tag2 = r.h('etag');
      check('a change sent with the current version goes through, with the next version', r.status === 200 && tag2 && tag2 !== tag1, `${r.status} ${r.reason} ${tag2}`);
      r = await call('PATCH', '/api/loan-products/NL01', { name: 'Normal Loan (B)' }, { ifMatch: tag1 });
      check('one sent with the version before is refused with 412', r.status === 412 && /PRECONDITION_FAILED/.test(r.reason), `${r.status} ${r.reason}`);
      check('and changes nothing', (await call('GET', '/api/loan-products/NL01')).body.name === 'Normal Loan (A)');
      r = await call('PATCH', '/api/loan-products/NL01', { name: 'Normal Loan (C)' });
      check('without If-Match a change goes through as before', r.status === 200);
      r = await call('PATCH', '/api/loan-products/NL01', { name: 'Normal Loan' }, { ifMatch: '*' });
      check('If-Match: * takes any version', r.status === 200);
      const weak = `W/${r.h('etag')}`;
      check('a weak form of the tag is taken', (await call('PATCH', '/api/loan-products/NL01', { name: 'Normal Loan' }, { ifMatch: weak })).status === 200);
      const same = (await call('GET', '/api/loan-products/NL01')).h('etag');
      await call('PATCH', '/api/loan-products/NL01', { name: 'Normal Loan' });
      check('a save that changes nothing keeps the version', (await call('GET', '/api/loan-products/NL01')).h('etag') === same);
      r = await call('PATCH', '/api/loan-products/NL01', { name: 'Stale' }, { ifMatch: '"v1"' });
      check('a refusal carries the current version', r.status === 412 && r.h('etag') === same, `${r.status} ${r.h('etag')} ${same}`);

      const sav0 = (await call('GET', '/api/deposit-products/SAV01')).h('etag');
      const m = (await call('POST', '/api/members', { firstName: 'Counter', lastName: 'Check', branchId: 'HQ' })).body;
      await T((c) => S.open(c, { memberId: m.id, productId: 'SAV01' }));
      check('opening an account (the number counter) does not change the product\'s version', (await call('GET', '/api/deposit-products/SAV01')).h('etag') === sav0);
      r = await call('POST', '/api/loan-products/NL01/fees', { code: 'LEDGERFEE', name: 'Ledger fee', feeType: 'DISBURSEMENT_UPFRONT', calculation: 'FLAT', amount: 50 }, { ifMatch: same });
      const afterFee = (await call('GET', '/api/loan-products/NL01')).h('etag');
      check('a fee added with the product\'s version goes through and raises it', r.status === 201 && afterFee !== same, `${r.status} ${r.reason} ${afterFee}`);
      r = await call('PATCH', `/api/loan-products/NL01/fees/LEDGERFEE`, { amount: 60 }, { ifMatch: same });
      check('a fee change sent with the product\'s old version is refused', r.status === 412, `${r.status} ${r.reason}`);
      r = await call('PATCH', '/api/loan-products/NL01', { name: 'Normal Loan' }, { ifMatch: same });
      check('and so is a product edit read before the fee changed', r.status === 412, `${r.status} ${r.reason}`);

      r = await call('GET', '/api/deposit-products/SAV01');
      const dTag = r.h('etag');
      await call('PATCH', '/api/deposit-products/SAV01', { name: 'Ordinary Savings (edited elsewhere)' });
      r = await call('PATCH', '/api/deposit-products/SAV01', { name: 'Ordinary Savings' }, { ifMatch: dTag });
      check('a deposit product edited meanwhile refuses a stale change', r.status === 412, `${r.status} ${r.reason}`);

      r = await call('GET', '/api/organization/transactionChannels/mpesa');
      const cTag = r.h('etag');
      check('a channel answers with its version', r.status === 200 && /^"v\d+"$/.test(cTag || ''), cTag);
      await call('PUT', '/api/transaction-channels/order', { order: ['mpesa', 'cash'] });
      check('rearranging the channels does not change their version', (await call('GET', '/api/organization/transactionChannels/mpesa')).h('etag') === cTag);
      const body = { ...r.body, name: 'M-Pesa paybill' };
      r = await call('PUT', '/api/organization/transactionChannels/mpesa', body, { ifMatch: cTag });
      check('a channel PUT with the current version goes through', r.status === 200 && r.h('etag') !== cTag, `${r.status} ${r.reason}`);
      r = await call('PATCH', '/api/transaction-channels/mpesa', { name: 'M-Pesa' }, { ifMatch: cTag });
      check('a PATCH with the old one is refused', r.status === 412, `${r.status} ${r.reason}`);

      await call('POST', '/api/custom-fields/sets', { entity: 'MEMBER', name: 'Profile', id: '_profile' });
      await call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_profile', id: 'county', name: 'County', type: 'FREE_TEXT' });
      r = await call('GET', '/api/custom-fields/definitions/county');
      const fTag = r.h('etag');
      check('a custom field answers with its version', r.status === 200 && r.body.row_version >= 1 && fTag === `"v${r.body.row_version}"`, `${fTag} ${r.body?.row_version}`);
      await call('PATCH', '/api/custom-fields/definitions/county', { name: 'Home county' }, { ifMatch: fTag });
      r = await call('PATCH', '/api/custom-fields/definitions/county', { name: 'County of residence' }, { ifMatch: fTag });
      check('a custom field changed meanwhile refuses a stale change', r.status === 412, `${r.status} ${r.reason}`);
      const sets = (await call('GET', '/api/custom-fields/sets?entity=MEMBER')).body;
      const sTag = `"v${sets.find((x) => x.id === '_profile').row_version}"`;
      await call('PATCH', '/api/custom-fields/sets/_profile', { name: 'Member profile' }, { ifMatch: sTag });
      r = await call('PATCH', '/api/custom-fields/sets/_profile', { name: 'Profile' }, { ifMatch: sTag });
      check('and so does a set', r.status === 412, `${r.status} ${r.reason}`);

      r = await call('GET', '/api/configuration/transactionchannels.yaml');
      const yTag = r.h('etag');
      check('a configuration file answers with a hash of itself', r.status === 200 && /^"[A-Za-z0-9_-]{27}"$/.test(yTag || ''), yTag);
      const file = r.raw;
      r = await call('PUT', '/api/configuration/transactionchannels.yaml', file, { type: 'application/yaml', ifMatch: yTag });
      check('a file PUT with the current tag goes through', r.status === 200, `${r.status} ${r.reason}`);
      await call('PATCH', '/api/transaction-channels/bank', { name: 'Bank (edited elsewhere)' });
      const doc = YAML.parse(file);
      r = await call('PUT', '/api/configuration/transactionchannels.yaml', YAML.stringify(doc), { type: 'application/yaml', ifMatch: yTag });
      check('one sent after a channel changed is refused', r.status === 412 && (await call('GET', '/api/organization/transactionChannels/bank')).body.name === 'Bank (edited elsewhere)', `${r.status} ${r.reason}`);
      r = await call('GET', '/api/configuration/customfields.yaml');
      const cfTag = r.h('etag');
      await call('PATCH', '/api/custom-fields/definitions/county', { name: 'County' });
      r = await call('PUT', '/api/configuration/customfields.yaml', r.raw, { type: 'application/yaml', ifMatch: cfTag });
      check('the custom fields file too', r.status === 412, `${r.status} ${r.reason}`);
    }

    // ------------------------------------------------------------------------
    section('reports through the replica pool');
    {
      const r = await call('GET', '/api/reports/balance-sheet');
      check('a report says where it was read and as at when', r.status === 200 && r.h('data-source') === 'primary' && !Number.isNaN(Date.parse(r.h('data-as-at') || '')),
        `${r.status} ${r.h('data-source')} ${r.h('data-as-at')}`);
      check('it was read through the replica pool (here the same server, so "primary")', (await apps()).includes('sacco-platform-replica'), (await apps()).join());
      const tb = await call('GET', '/api/accounting/trial-balance');
      check('the trial balance too', tb.status === 200 && tb.h('data-source') === 'primary');
      const ex = await call('GET', '/api/extract');
      check('the data extract does not say (it reads the primary)', ex.status === 200 && ex.h('data-source') === null, ex.text);
      const meta = {};
      await withTenantReport(SCHEMA, (c) => c.query('SELECT 1'), meta);
      check('withTenantReport fills in source and as-at', meta.source === 'primary' && Boolean(meta.asAt));
      let calls = 0;
      const warn = console.warn; console.warn = () => {};
      const meta2 = {};
      const got2 = await withTenantReport(SCHEMA, async (c) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('canceling statement due to conflict with recovery'), { code: '40001' });
        return (await c.query('SELECT 2 AS two')).rows[0].two;
      }, meta2);
      console.warn = warn;
      check('a report the replica cancels is read again from the primary', got2 === 2 && calls === 2 && meta2.source === 'primary', `${got2} ${calls}`);
      const e5 = await withTenantReport(SCHEMA, async () => { throw Object.assign(new Error('bad'), { code: '22P02' }); }).catch((e) => e);
      check('a report\'s own error is not hidden by a second try', e5.code === '22P02');
      // A replica that cannot be reached: the report reads the primary.
      const child = spawnSync(process.execPath, ['-e', `
        const { withTenantReport } = require(${JSON.stringify(path.join(__dirname, '../src/db/tenantContext'))});
        const { endAll } = require(${JSON.stringify(path.join(__dirname, '../src/db/pool'))});
        const meta = {};
        withTenantReport(${JSON.stringify(SCHEMA)}, (c) => c.query('SELECT 1 AS one'), meta)
          .then((r) => { console.log(JSON.stringify({ one: r.rows[0].one, meta })); })
          .catch((e) => { console.log(JSON.stringify({ error: e.message })); })
          .finally(() => endAll());`], { env: { ...process.env, PG_REPLICA_HOST: '127.0.0.1', PG_REPLICA_PORT: '1' }, encoding: 'utf8', timeout: 30000 });
      const got = (() => { try { return JSON.parse(child.stdout.trim().split('\n').pop()); } catch { return {}; } })();
      check('a replica that cannot be reached is skipped for the primary', got.one === 1 && got.meta?.source === 'primary', `${child.stdout} ${child.stderr.slice(0, 200)}`);
    }
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`); console.log('FAILED:', e.stack);
  } finally {
    server.close();
    await endAll();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  }
})();
