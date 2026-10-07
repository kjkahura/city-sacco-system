'use strict';

const { pool, replicaPool } = require('./pool');
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
// A request's statements are bounded, so one caller (or one aborted request whose
// query keeps running) cannot hold a shared connection for long. Jobs (no request) are not.
const REQUEST_STATEMENT_TIMEOUT = `${Math.max(1, Number(process.env.REQUEST_STATEMENT_TIMEOUT_MS) || 55_000)}ms`;

async function bind(client, schemaName) {
  const params = actorParams();
  await client.query(BIND_SQL, [schemaName, ...params]);
  const ctx = requestContext.current();
  if (ctx && !ctx.noStatementTimeout) {
    await client.query(`SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)`,
      [REQUEST_STATEMENT_TIMEOUT, REQUEST_STATEMENT_TIMEOUT]);
  }
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
/**
 * The request's database work in progress: the tenant's concurrency slot
 * (lib/limits) is given back when it ends, not when an impatient client
 * disconnects while a query still runs.
 */
function workStarted() {
  const w = requestContext.current()?.work;
  if (w) w.busy += 1;
  return () => {
    if (!w) return;
    w.busy -= 1;
    if (w.busy === 0 && w.onIdle) { const f = w.onIdle; w.onIdle = null; f(); }
  };
}

async function withTenant(schemaName, fn) {
  assertSchemaName(schemaName);
  const done = workStarted();
  let client;
  try { client = await pool.connect(); } catch (e) { done(); throw e; }
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
    for (const hook of client.afterCommit || []) { try { hook(); } catch { /* a hook never fails the request */ } }
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.afterCommit = null;
    // Release returns the connection to the pool. search_path is already
    // reverted by the transaction ending, so the next borrower is clean.
    try { client.release(); } finally { done(); }
  }
}

/** Run fn once the transaction on c (from withTenant) has committed; never if it rolls back. */
function afterCommit(c, fn) {
  (c.afterCommit ||= []).push(fn);
}

/** Read-only variant; same isolation, marked so a replica can serve it later. */
async function withTenantRead(schemaName, fn) {
  assertSchemaName(schemaName);
  const done = workStarted();
  let client;
  try { client = await pool.connect(); } catch (e) { done(); throw e; }
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
    done();
  }
}

/**
 * A read for reports, the data extract and the dashboard indicators. With a
 * read replica set (db/pool replicaPool) it is read there, so heavy reports
 * do not take the primary's time from postings; otherwise from the primary,
 * as withTenantRead. `meta` receives where it was read (`source`: replica or
 * primary) and `asAt`: on the replica, the time of the latest change it has
 * applied (a replica is a little behind); on the primary, now. A replica that
 * cannot be reached is skipped for the primary, so a report never fails
 * because the replica is down. Nothing that comes before a posting reads
 * here: postings read the primary in their own transaction.
 */
// After a replica cannot be reached, reports skip it for this long instead of waiting on it each time.
const REPLICA_RETRY_MS = 30_000;
let replicaDownUntil = 0;
// A replica further behind than this, and not caught up, is skipped (REPLICA_MAX_LAG_SECONDS, default 60).
const replicaMaxLag = () => Math.max(1, Number(process.env.REPLICA_MAX_LAG_SECONDS) || 60);
// Errors that mean "this replica cannot answer now", not "the report is wrong": read the primary instead.
// 40001 is a query cancelled for a conflict with the replica applying changes; 57P0x the server
// shutting down or starting; 08xxx a lost connection; 42P01 and 3F000 a table or schema not yet replicated.
const REPLICA_GIVE_UP = (e) => ['40001', '57P01', '57P02', '57P03', '42P01', '3F000'].includes(e.code)
  || /^08/.test(e.code || '') || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(e.code)
  || /Connection terminated|connection timeout/i.test(e.message || '');

async function fromPrimary(schemaName, fn, meta, why) {
  if (why) console.warn(`[db] reading the primary for a report: ${why}`);
  meta.source = 'primary';
  meta.asAt = new Date().toISOString();
  return withTenantRead(schemaName, fn);
}

async function withTenantReport(schemaName, fn, meta = {}) {
  assertSchemaName(schemaName);
  if (!replicaPool || Date.now() < replicaDownUntil) return fromPrimary(schemaName, fn, meta);
  const done = workStarted();
  let client;
  try {
    client = await replicaPool.connect();
  } catch (e) {
    done();
    replicaDownUntil = Date.now() + REPLICA_RETRY_MS;
    return fromPrimary(schemaName, fn, meta, `replica unavailable (${e.message})`);
  }
  let skip = null;
  let out;
  try {
    await client.query('BEGIN READ ONLY');
    await bind(client, schemaName);
    // How current the replica is. Caught up (everything received is applied) and still
    // streaming: as at now. Otherwise as at the last change it applied; too far behind, skipped.
    const { rows: [st] } = await client.query(
      `SELECT pg_is_in_recovery() AS replica, pg_last_xact_replay_timestamp() AS replay_ts,
              COALESCE(pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn(), false) AS caught_up,
              (SELECT status FROM pg_stat_wal_receiver LIMIT 1) AS receiver,
              EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::float AS lag_seconds`);
    const current = !st.replica || (st.caught_up && st.receiver !== 'stopping' && st.receiver !== 'stopped');
    if (!current && (st.lag_seconds === null || st.lag_seconds > replicaMaxLag())) {
      skip = `replica ${st.lag_seconds === null ? 'has applied nothing yet' : `${Math.round(st.lag_seconds)} s behind`}`;
      await client.query('ROLLBACK');
    } else {
      out = await fn(client);
      await client.query('COMMIT');
      meta.source = st.replica ? 'replica' : 'primary';
      meta.asAt = (current || !st.replay_ts ? new Date() : new Date(st.replay_ts)).toISOString();
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (!REPLICA_GIVE_UP(e)) throw e;
    skip = `replica could not answer (${e.code || e.message})`;
  } finally {
    client.release();
    done();
  }
  return skip ? fromPrimary(schemaName, fn, meta, skip) : out;
}

/** The Data-As-At and Data-Source headers for a report read with withTenantReport. */
function reportHeaders(res, meta) {
  if (meta.asAt) res.set('Data-As-At', meta.asAt);
  if (meta.source) res.set('Data-Source', meta.source);
}

/**
 * Run a whole transaction again when PostgreSQL ended it to break a deadlock
 * (40P01) or a serialization conflict (40001). Either way the transaction was
 * rolled back, so nothing it did in the database remains, and running it
 * again is the database's own advice. `run` must open its own transaction
 * (withTenant). A handler that calls an outside service inside its
 * transaction would call it again, so outside calls belong after the commit
 * (afterCommit, the notification outbox). CONFLICT_RETRIES sets how many more
 * tries (default 2; 0 answers the first conflict with 409 CONFLICT_TRY_AGAIN,
 * as before). `canRetry()` says whether the caller can still start over (an
 * answer already sent cannot).
 */
const RETRYABLE = new Set(['40P01', '40001']);
const conflictRetries = () => {
  const n = Number(process.env.CONFLICT_RETRIES);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 5) : 2;
};
async function retryConflicts(run, { retries = conflictRetries(), canRetry = () => true, label = '' } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (e) {
      if (!RETRYABLE.has(e.code) || attempt >= retries || !canRetry()) throw e;
      // Back off a little, with jitter, so the two transactions do not meet again at once.
      const wait = 15 * 2 ** attempt + Math.floor(Math.random() * 40);
      console.warn(`[db] ${e.code === '40P01' ? 'deadlock' : 'serialization conflict'}${label ? ` on ${label}` : ''}; retrying in ${wait} ms (try ${attempt + 2})`);
      await new Promise((ok) => setTimeout(ok, wait));
      // The caller may have gone during the wait (its concurrency slot is then given back).
      if (!canRetry()) throw e;
    }
  }
}

/**
 * A request that is a job (end of day run now, an import, a backup): its
 * statements are not cut off at the request limit. Express middleware.
 */
function longRunning(_req, _res, next) {
  const ctx = requestContext.current();
  if (ctx) ctx.noStatementTimeout = true;
  next();
}

module.exports = { withTenant, withTenantRead, orgToday, assertSchemaName, TenantError, SCHEMA_RE, longRunning, afterCommit, retryConflicts, withTenantReport, reportHeaders };
