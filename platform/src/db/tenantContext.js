'use strict';

const { pool } = require('./pool');

/**
 * Tenant selection.
 *
 * Every tenant query runs inside a transaction that begins with
 * `SET LOCAL search_path`. LOCAL is the whole point: it is scoped to the
 * transaction and Postgres reverts it on COMMIT or ROLLBACK. A plain SET
 * would persist on the pooled connection and the next request, for a
 * different SACCO, would silently inherit it. That is how cross-tenant
 * leaks happen, and it is the bug this module exists to make impossible.
 */

// Matches the CHECK constraint on platform.tenants.schema_name.
const SCHEMA_RE = /^tenant_[a-z][a-z0-9_]{2,40}$/;

class TenantError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function assertSchemaName(schemaName) {
  if (typeof schemaName !== 'string' || !SCHEMA_RE.test(schemaName)) {
    // Never interpolate an unvalidated identifier into SQL. Even though
    // quote_ident would escape it, refusing outright keeps the blast radius
    // of a bad tenant record at zero.
    throw new TenantError(`unsafe schema name: ${String(schemaName).slice(0, 60)}`, 400);
  }
  return schemaName;
}

/**
 * Run fn inside a transaction bound to one tenant's schema.
 * Commits on success, rolls back on throw.
 */
async function withTenant(schemaName, fn) {
  assertSchemaName(schemaName);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // format('%I') applies quote_ident server-side; the regex above already
    // guarantees the value is a bare lowercase identifier. Belt and braces.
    await client.query("SELECT set_config('search_path', format('%I, public', $1::text), true)", [schemaName]);

    // Prove the schema exists rather than silently falling through to public,
    // which would read the wrong tables or none at all.
    const { rows } = await client.query(
      'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schemaName]
    );
    if (!rows.length) throw new TenantError(`tenant schema not found: ${schemaName}`, 404);

    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    // Release returns the connection to the pool. search_path is already
    // reverted by the transaction ending, so the next borrower is clean.
    client.release();
  }
}

/** Read-only variant; same isolation, marked so a replica can serve it later. */
async function withTenantRead(schemaName, fn) {
  assertSchemaName(schemaName);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('search_path', format('%I, public', $1::text), true)", [schemaName]);
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

module.exports = { withTenant, withTenantRead, assertSchemaName, TenantError, SCHEMA_RE };
