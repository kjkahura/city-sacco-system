'use strict';

const { Pool, types } = require('pg');

// pg returns numeric as a string to avoid silent precision loss. Money here is
// numeric(18,2) in KES; the largest value that fits is far inside JS's safe
// integer range once scaled by 100, so parsing to Number is lossless for this
// domain and saves parseFloat noise at every call site. All arithmetic that
// changes a balance is still done in SQL, on the numeric type, never in JS.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));

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

module.exports = { pool, query, transaction };
