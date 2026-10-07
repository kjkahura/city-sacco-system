'use strict';

const { Pool, types } = require('pg');

// pg returns numeric as a string to avoid silent precision loss. Money here is
// numeric(18,2) in KES; the largest value that fits is far inside JS's safe
// integer range once scaled by 100, so parsing to Number is lossless for this
// domain and saves parseFloat noise at every call site. All arithmetic that
// changes a balance is still done in SQL, on the numeric type, never in JS.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// A DATE is a calendar day, not a moment: kept as 'YYYY-MM-DD' (the reference platform's API
// standard for date-only values). pg's default turns it into a JavaScript
// Date at local midnight, so on a server running in Africa/Nairobi every
// date read back through toISOString() came out a day early.
types.setTypeParser(types.builtins.DATE, (v) => v);

/**
 * One pool for the whole process, not one per tenant.
 *
 * Schema-per-tenant tempts you into a pool per tenant. Don't: 200 SACCOs times
 * a 10-connection pool is 2000 connections and Postgres falls over around a
 * few hundred. Tenancy is selected per transaction via search_path instead.
 */
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || 'sacco',
  max: Number(process.env.PGPOOL_MAX || 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'sacco-platform',
});

pool.on('error', (err) => {
  // An idle client erroring out must not take the process down.
  console.error('[pg] idle client error', err.message);
});

/**
 * Two optional pools beside the main one, both off unless set (docs/deploy.md,
 * "Scaling the database"):
 *
 * - directPool: a direct connection to the primary for the few places that
 *   hold a session-level advisory lock across transactions (the scheduler,
 *   migrations, sandbox jobs). Behind a pooler in transaction mode
 *   (PgBouncer, Cloud SQL managed connection pooling) a session lock would be
 *   left on a server connection another client then uses, so those places
 *   need a connection of their own. PG_DIRECT_HOST (and PG_DIRECT_PORT) name
 *   it; unset, they use the main pool, as before.
 * - replicaPool: a read replica for reports, the data extract and the
 *   dashboard indicators (db/tenantContext withTenantReport). PG_REPLICA_HOST
 *   (and PG_REPLICA_PORT) name it; unset, those read the primary, as before.
 */
const side = (host, port, max, name) => {
  const p = new Pool({
    host,
    port: Number(port || process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
    database: process.env.PGDATABASE || 'sacco',
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: name,
  });
  p.on('error', (err) => console.error(`[pg] ${name} idle client error`, err.message));
  return p;
};
const directPool = process.env.PG_DIRECT_HOST
  ? side(process.env.PG_DIRECT_HOST, process.env.PG_DIRECT_PORT, Number(process.env.PGPOOL_DIRECT_MAX || 3), 'sacco-platform-direct')
  : pool;
const replicaPool = process.env.PG_REPLICA_HOST
  ? side(process.env.PG_REPLICA_HOST, process.env.PG_REPLICA_PORT, Number(process.env.PGPOOL_REPLICA_MAX || 10), 'sacco-platform-replica')
  : null;

/** Close every pool (tests and one-off scripts). */
async function endAll() {
  await Promise.all([pool, directPool !== pool ? directPool : null, replicaPool].filter(Boolean).map((p) => p.end().catch(() => {})));
}

/** Query against the platform schema. */
async function query(text, params) {
  const client = await pool.connect();
  try {
    await client.query("SET LOCAL search_path TO platform, public");
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

/** Run a function inside a transaction on the platform schema. */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL search_path TO platform, public");
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, directPool, replicaPool, endAll, query, transaction };
