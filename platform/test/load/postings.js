#!/usr/bin/env node
'use strict';

/**
 * Load test for concurrent postings: many tellers depositing cash into
 * different members' accounts at once. Every such deposit adds to the same
 * gl_daily_balances rows (cash and the savings liability, today), so this
 * measures how much those rows make postings wait for each other.
 *
 * It provisions its own throwaway tenant (`loadtest`), never touches another,
 * and removes it at the end. It is not part of `npm test`.
 *
 *   node test/load/postings.js [--workers 16] [--seconds 20] [--members 200]
 *
 * Point PG* at staging to measure there (docs/deploy.md, "Load testing"),
 * never at production: it writes postings.
 *
 * It prints postings per second, latency percentiles, and the share of
 * sampled time that postings spent waiting on another transaction's row lock.
 */

const { pool, endAll } = require('../../src/db/pool');
const { withTenant } = require('../../src/db/tenantContext');
const provision = require('../../src/tenancy/provision');
const S = require('../../src/domain/savings');

const arg = (name, dflt) => {
  const k = process.argv.indexOf(`--${name}`);
  return k > 0 ? Number(process.argv[k + 1]) : dflt;
};
const WORKERS = arg('workers', 16);
const SECONDS = arg('seconds', 20);
const MEMBERS = arg('members', Math.max(WORKERS * 4, 50));
const SLUG = 'loadtest';
const SCHEMA = `tenant_${SLUG}`;
const T = (fn) => withTenant(SCHEMA, fn);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

async function setup() {
  // Only this test's own SACCO is created and migrated (provisionTenant); the database must
  // already be migrated (npm run migrate), so nothing else on it is touched.
  if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
  await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
  await provision.provisionTenant({ slug: SLUG, name: 'Load test SACCO', mfaRequiredRoles: [], adminEmail: 'admin@load.local', adminPassword: 'a sufficiently long passphrase' });
  const accounts = [];
  await T(async (c) => {
    const { rows: [b] } = await c.query("INSERT INTO branches (code, name) VALUES ('HQ', 'Head office') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id");
    for (let k = 0; k < MEMBERS; k += 1) {
      const { rows: [m] } = await c.query(
        "INSERT INTO members (member_no, first_name, last_name, branch_id) VALUES ($1, 'Load', $2, $3) RETURNING id", [`L${k}`, `M${k}`, b.id]);
      accounts.push((await S.open(c, { memberId: m.id, productId: 'SAV01' })).id);
    }
  });
  return accounts;
}

async function sampleWaits(stop) {
  // Every 50 ms: how many of this test's connections are active, and how many
  // of those are waiting on a lock held by another transaction.
  let active = 0; let waiting = 0;
  while (!stop.done) {
    const { rows: [r] } = await pool.query(
      `SELECT count(*) FILTER (WHERE state = 'active')::int AS active,
              count(*) FILTER (WHERE state = 'active' AND wait_event_type = 'Lock')::int AS waiting
         FROM pg_stat_activity WHERE application_name = 'sacco-platform' AND pid <> pg_backend_pid() AND backend_type = 'client backend'`);
    active += r.active; waiting += r.waiting;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return { active, waiting };
}

async function run(accounts) {
  const latencies = []; let errors = 0;
  const end = Date.now() + SECONDS * 1000;
  const stop = { done: false };
  const waits = sampleWaits(stop);
  await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
    let k = w;
    while (Date.now() < end) {
      const id = accounts[k % accounts.length];
      k += WORKERS;
      const t0 = process.hrtime.bigint();
      try {
        await T((c) => S.deposit(c, id, { amount: 100, channelId: 'cash', createdBy: 'loadtest' }));
        latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      } catch (e) { errors += 1; if (errors < 4) console.error(e.message); }
    }
  }));
  stop.done = true;
  const { active, waiting } = await waits;
  return { latencies, errors, lockShare: active ? waiting / active : 0 };
}

(async () => {
  let code = 0;
  try {
    console.log(`setup: ${MEMBERS} accounts`);
    const accounts = await setup();
    console.log(`running: ${WORKERS} workers for ${SECONDS} s (pool ${process.env.PGPOOL_MAX || 20})`);
    const r = await run(accounts);
    const n = r.latencies.length;
    console.log(JSON.stringify({
      workers: WORKERS, seconds: SECONDS, postings: n, errors: r.errors,
      perSecond: Math.round((n / SECONDS) * 10) / 10,
      latencyMs: { p50: Math.round(pct(r.latencies, 50)), p95: Math.round(pct(r.latencies, 95)), p99: Math.round(pct(r.latencies, 99)) },
      lockWaitShare: Math.round(r.lockShare * 1000) / 10,
    }, null, 2));
    const { rows: [v] } = await pool.query(`SELECT sum(debit) - sum(credit) AS cash FROM ${SCHEMA}.gl_daily_balances WHERE gl_code = '100-200'`);
    if (Math.abs(Number(v.cash) - n * 100) > 0.001) { console.error(`ROLLUP MISMATCH: cash ${v.cash}, expected ${n * 100}`); code = 1; }
    else console.log('rollup: cash total matches the postings');
  } catch (e) {
    console.error(e); code = 1;
  } finally {
    if (!process.argv.includes('--keep')) await provision.deprovisionTenant(SLUG, { confirm: SLUG }).catch(() => {});
    await endAll();
    process.exit(code);
  }
})();
