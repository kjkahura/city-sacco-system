'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./pool');
const { assertSchemaName } = require('./tenantContext');

const DIR = path.join(__dirname, 'migrations');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function load(kind) {
  const dir = path.join(DIR, kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return { version: f.replace(/\.sql$/, ''), sql, checksum: sha(sql) };
    });
}

async function applied(client, schemaName) {
  const { rows } = await client.query(
    'SELECT version, checksum FROM platform.schema_migrations WHERE schema_name = $1 ORDER BY version',
    [schemaName]
  );
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

/** Bring the platform schema up to date. Must run before anything else. */
async function migratePlatform() {
  const files = load('platform');
  const client = await pool.connect();
  const done = [];
  try {
    // Bootstrap: the ledger lives in the schema it tracks, so the first file
    // has to run before we can read the ledger.
    await client.query('CREATE SCHEMA IF NOT EXISTS platform');
    await client.query(`CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      schema_name text NOT NULL, version text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (schema_name, version))`);

    const have = await applied(client, 'platform');
    for (const m of files) {
      const prev = have.get(m.version);
      if (prev === m.checksum) continue;
      if (prev && prev !== m.checksum) {
        throw new Error(
          `platform migration ${m.version} changed after being applied ` +
          `(${prev} -> ${m.checksum}). Migrations are immutable; add a new file.`
        );
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO platform.schema_migrations (schema_name, version, checksum) VALUES ($1,$2,$3)',
          ['platform', m.version, m.checksum]
        );
        await client.query('COMMIT');
        done.push(m.version);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`platform migration ${m.version} failed: ${e.message}`);
      }
    }
  } finally {
    client.release();
  }
  return done;
}

/**
 * Bring one tenant schema up to date.
 *
 * Each migration runs in its own transaction with search_path pinned to the
 * tenant, so an unqualified CREATE TABLE lands in the right schema.
 */
async function migrateTenant(schemaName) {
  assertSchemaName(schemaName);
  const files = load('tenant');
  const client = await pool.connect();
  const done = [];
  try {
    await client.query(
      "SELECT format('CREATE SCHEMA IF NOT EXISTS %I', $1::text)", [schemaName]
    );
    // format() only builds the string; execute it for real.
    const { rows: [{ format: ddl }] } = await client.query(
      "SELECT format('CREATE SCHEMA IF NOT EXISTS %I', $1::text)", [schemaName]
    );
    await client.query(ddl);

    const have = await applied(client, schemaName);
    for (const m of files) {
      const prev = have.get(m.version);
      if (prev === m.checksum) continue;
      if (prev && prev !== m.checksum) {
        throw new Error(
          `tenant migration ${m.version} changed after being applied to ${schemaName}. ` +
          `Migrations are immutable; add a new file.`
        );
      }
      await client.query('BEGIN');
      try {
        await client.query(
          "SELECT set_config('search_path', format('%I, public', $1::text), true)", [schemaName]
        );
        await client.query(m.sql);
        await client.query(
          'INSERT INTO platform.schema_migrations (schema_name, version, checksum) VALUES ($1,$2,$3)',
          [schemaName, m.version, m.checksum]
        );
        await client.query('COMMIT');
        done.push(m.version);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`tenant migration ${m.version} failed on ${schemaName}: ${e.message}`);
      }
    }
  } finally {
    client.release();
  }
  return done;
}

/** Migrate every registered tenant. Reports per tenant rather than aborting. */
async function migrateAllTenants() {
  const { rows } = await pool.query(
    "SELECT slug, schema_name FROM platform.tenants WHERE status <> 'CLOSED' ORDER BY slug"
  );
  const results = [];
  for (const t of rows) {
    try {
      results.push({ tenant: t.slug, applied: await migrateTenant(t.schema_name), ok: true });
    } catch (e) {
      results.push({ tenant: t.slug, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * Drift report: which tenants are behind, and by what.
 * With N schemas this is the thing that stops a half-migrated fleet going
 * unnoticed until a query fails in production.
 */
async function drift() {
  const latest = load('tenant').map((m) => m.version);
  const head = latest[latest.length - 1] || null;
  const { rows } = await pool.query(`
    SELECT t.slug, t.schema_name,
           COALESCE(MAX(m.version), '(none)') AS at_version,
           COUNT(m.version)::int AS applied_count
    FROM platform.tenants t
    LEFT JOIN platform.schema_migrations m ON m.schema_name = t.schema_name
    WHERE t.status <> 'CLOSED'
    GROUP BY t.slug, t.schema_name
    ORDER BY t.slug
  `);
  return {
    head,
    total: latest.length,
    tenants: rows.map((r) => ({
      ...r,
      behind: r.applied_count < latest.length,
      missing: latest.filter((v) => v > r.at_version),
    })),
  };
}

module.exports = { migratePlatform, migrateTenant, migrateAllTenants, drift, load };
