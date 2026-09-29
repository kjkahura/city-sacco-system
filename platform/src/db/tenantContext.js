'use strict';

const { pool } = require('./pool');
const { orgToday } = require('../lib/orgDate');
const requestContext = require('../lib/requestContext');

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
 * The transaction's schema and its clock. The session time zone is the
 * tenant's, so current_date, now()::date and a DATE column's default are the
 * organization's calendar day rather than the server's: in Nairobi between
 * midnight and 03:00 the UTC day is still yesterday. Both settings are LOCAL
 * and revert when the transaction ends. A tenant without a row (a schema made
 * by hand in a test) keeps the server's zone. The request's user goes in
 * app.actor, app.till_required, app.till_add and app.till_remove for the till
 * triggers (031, 032), and its branch access in app.branches and app.officer
 * for row security (032), and its IP address and channel (UI or API) in
 * app.ip and app.channel for the change log (042).
 */
const BIND_SQL = `SELECT set_config('search_path', format('%I, public', $1::text), true),
  set_config('TimeZone', COALESCE(
    (SELECT timezone FROM platform.tenants WHERE schema_name = $1::text), current_setting('TimeZone')), true),
  set_config('app.actor', $2::text, true),
  set_config('app.till_required', $3::text, true),
  set_config('app.till_add', $4::text, true),
  set_config('app.till_remove', $5::text, true),
  set_config('app.branches', $6::text, true),
  set_config('app.officer', $7::text, true),
  set_config('app.ip', $8::text, true),
  set_config('app.channel', $9::text, true)`;

/** The request's user for the session settings (lib/requestContext). */
function actorParams() {
  const ctx = requestContext.current();
  return [ctx?.email || '', ctx?.tillRequired ? 'true' : 'false',
    ctx && ctx.tillAdd === false ? 'false' : 'true', ctx && ctx.tillRemove === false ? 'false' : 'true',
    ctx?.branches || '', ctx?.officer || '', ctx?.ip || '', ctx?.channel || ''];
}

/**
 * Bind the transaction to the tenant and the request's user. A user limited
 * to some branches (or to their own members) runs as sacco_branch_scoped, the
 * role row security applies to; without it they are refused, not shown
 * every branch.
 */
async function bind(client, schemaName) {
  const params = actorParams();
  await client.query(BIND_SQL, [schemaName, ...params]);
  if (params[4] || params[5]) {
    try {
      await client.query('SET LOCAL ROLE sacco_branch_scoped');
    } catch (e) {
      throw new TenantError('BRANCH_ACCESS_UNAVAILABLE: the database has no branch-scoped role; ask the platform operator', 503);
    }
  }
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
    await bind(client, schemaName);

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
    await bind(client, schemaName);
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

module.exports = { withTenant, withTenantRead, orgToday, assertSchemaName, TenantError, SCHEMA_RE };
