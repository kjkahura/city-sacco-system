'use strict';

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { pool } = require('../db/pool');
const { withTenant, assertSchemaName } = require('../db/tenantContext');
const DD = require('../domain/dataDictionary');
const { zip, unzip } = require('../lib/zip');
const CSV = require('../lib/csv');
const { err } = require('../lib/errors');
const { recordAudit } = require('../lib/auditLog');

/**
 * The tenant's own database backup (the reference platform's Database Backup API): a tenant
 * administrator asks for one, it is taken in the background, and when it is
 * ready it can be downloaded as a ZIP. Optionally a callback URL is called
 * when it finishes, and it can be limited to some tables or to rows created
 * or changed since a moment (the reference platform's createBackupFromDate).
 *
 * This is not the platform's disaster-recovery backup (./backup, pg_dump of
 * the schema, encrypted, off-site, operated by the platform). This one is
 * for the SACCO: its data in a form it can open, load into its own
 * warehouse, or keep.
 *
 * The ZIP holds:
 *  - one CSV per table, with a header row, every value in Postgres's text
 *    form (dates yyyy-MM-dd, timestamps in UTC), ordered by primary key;
 *  - schema.sql: CREATE TABLE statements, so the CSVs load with COPY;
 *  - dictionary.json: the data dictionary (what every column means);
 *  - manifest.json: when, from which snapshot, the row counts, and what
 *    was left out.
 *
 * Every table is read in one REPEATABLE READ transaction, so the files agree
 * with each other: a repayment is in the transactions file and in the
 * journal files, or in neither. Member PIN hashes, portal sessions and login
 * attempts are never exported, and binary columns (attachments, logos, the
 * stored files of earlier imports and backups) are left out and listed in
 * the manifest. One backup may be in progress per tenant; the file is kept
 * for 30 days.
 */

const EXCLUDED_TABLES = ['member_credentials', 'member_sessions', 'member_login_attempts'];
const RETENTION_DAYS = Number(process.env.TENANT_BACKUP_RETENTION_DAYS || 30);
const BATCH = 5000;
const running = new Map();


// --- the callback, and why it is careful ------------------------------------
//
// A callback URL is a request the server makes to an address a client chose.
// Left open, it would let a tenant administrator make the platform call its
// own internal services (the metadata endpoint of a cloud host, a database
// admin page on the private network). So: https only, no credentials in the
// URL, and every address the name resolves to must be public. The check runs
// inside the connection's own DNS lookup, so a name that resolves to a
// public address when checked and a private one when connected (DNS
// rebinding) is caught at the connection. Redirects are not followed.
// CALLBACK_ALLOW_PRIVATE=true lifts the address check (and allows http) for
// development and tests only.

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
      || (a === 169 && b === 254) // link-local, cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

const allowPrivate = () => process.env.CALLBACK_ALLOW_PRIVATE === 'true';

function checkCallbackUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let u;
  try { u = new URL(String(raw)); } catch { throw err('INVALID_CALLBACK_URL'); }
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) throw err('CALLBACK_URL_MUST_BE_HTTPS');
  if (u.username || u.password) throw err('CALLBACK_URL_MUST_NOT_CARRY_CREDENTIALS');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate() && (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isPrivateAddress(host)))) {
    throw err('CALLBACK_URL_MUST_BE_PUBLIC');
  }
  if (String(raw).length > 2000) throw err('CALLBACK_URL_TOO_LONG');
  return u.toString();
}

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (e, addresses) => {
    if (e) return cb(e);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!allowPrivate() && list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error(`CALLBACK_HOST_RESOLVES_TO_A_PRIVATE_ADDRESS: ${hostname}`), { code: 'EPRIVATE' }));
    }
    if (options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function postCallback(url, body, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      lookup: guardedLookup,
      timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': payload.length, 'user-agent': 'sacco-platform-backup' },
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, at: new Date().toISOString() });
    });
    req.on('timeout', () => req.destroy(new Error('CALLBACK_TIMED_OUT')));
    req.on('error', (e) => resolve({ error: e.message, at: new Date().toISOString() }));
    req.end(payload);
  });
}

// --- requests -------------------------------------------------------------

/** Files older than the retention period are removed; the rows stay. */
async function expire(c) {
  const { rowCount } = await c.query(
    `UPDATE database_backups SET status = 'EXPIRED', file = NULL
     WHERE status = 'COMPLETE' AND expires_at < now()`);
  return rowCount;
}

const PUBLIC = `id, status, tables, from_date, callback_url, callback_result, file_name, file_size, sha256,
                row_counts, error, created_by, created_at, finished_at, expires_at`;

async function list(c, { limit = 20 } = {}) {
  await expire(c);
  const { rows } = await c.query(`SELECT ${PUBLIC} FROM database_backups ORDER BY created_at DESC LIMIT $1`, [Math.min(100, Number(limit) || 20)]);
  return rows;
}

async function get(c, id) {
  await expire(c);
  const q = String(id).toLowerCase() === 'latest'
    ? await c.query(`SELECT ${PUBLIC} FROM database_backups ORDER BY created_at DESC LIMIT 1`)
    : await c.query(`SELECT ${PUBLIC} FROM database_backups WHERE id::text = $1`, [String(id)]);
  if (!q.rows[0]) throw err('BACKUP_NOT_FOUND', 404);
  return q.rows[0];
}

/**
 * The file. LATEST is the most recent backup, as in the reference platform: if that one is
 * still running the answer is 409 rather than an older file, so a client
 * that just asked for a backup does not download yesterday's by mistake.
 */
async function file(c, id) {
  const b = await get(c, id);
  if (b.status === 'IN_PROGRESS') throw err('BACKUP_IN_PROGRESS', 409);
  if (b.status === 'FAILED') throw err(`BACKUP_FAILED: ${b.error}`, 409);
  if (b.status === 'EXPIRED') throw err('BACKUP_EXPIRED', 410);
  const { rows: [f] } = await c.query('SELECT file FROM database_backups WHERE id = $1', [b.id]);
  return { ...b, data: f.file };
}

/**
 * Ask for a backup. Returns at once with the record in IN_PROGRESS; the work
 * runs after the response. `done` (not serialised) settles when it finishes.
 */
async function request(tenant, { tables = null, fromDate = null, callback = null } = {}, { createdBy }) {
  assertSchemaName(tenant.schema_name);
  const callbackUrl = checkCallbackUrl(callback);
  let from = null;
  if (fromDate) {
    const d = new Date(String(fromDate));
    if (Number.isNaN(d.getTime())) throw err('INVALID_FROM_DATE');
    from = d.toISOString();
  }
  const row = await withTenant(tenant.schema_name, async (c) => {
    await expire(c);
    let wanted = null;
    if (tables !== null && tables !== undefined) {
      if (!Array.isArray(tables) || !tables.length) throw err('TABLES_MUST_BE_A_NON_EMPTY_LIST');
      const cat = await DD.catalog(c);
      for (const t of tables) {
        if (EXCLUDED_TABLES.includes(t)) throw err(`TABLE_IS_NOT_EXPORTED: ${t}`);
        if (!cat.tables.includes(t)) throw err(`UNKNOWN_TABLE: ${t}`);
      }
      wanted = [...new Set(tables)];
    }
    try {
      const { rows: [r] } = await c.query(
        `INSERT INTO database_backups (tables, from_date, callback_url, created_by)
         VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC}`, [wanted, from, callbackUrl, createdBy]);
      await recordAudit(c, { actor: createdBy, action: 'DATABASE_BACKUP_REQUESTED', entity: 'database_backup', entityId: r.id, after: JSON.stringify({ tables: wanted, fromDate: from, callback: callbackUrl }) });
      return r;
    } catch (e) {
      if (e.code === '23505') throw err('BACKUP_IN_PROGRESS: one backup may run at a time', 409);
      throw e;
    }
  });
  const done = run(tenant, row).catch((e) => console.error('[tenant-backup]', tenant.slug, e));
  running.set(row.id, done);
  done.finally(() => running.delete(row.id));
  Object.defineProperty(row, 'done', { value: done, enumerable: false });
  return row;
}

/** Wait for a backup started in this process (tests, the CLI). */
async function waitFor(id) {
  if (running.has(id)) await running.get(id);
}

// --- the export -----------------------------------------------------------

async function exportTables(tenant, { tables, from }) {
  const client = await pool.connect();
  const files = [];
  const counts = {};
  const omitted = {};
  const columnsOf = {};
  let dict;
  let snapshotAt;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('search_path', format('%I, public', $1::text), true)", [tenant.schema_name]);
    await client.query("SET LOCAL TimeZone = 'UTC'");
    ({ rows: [{ now: snapshotAt }] } = await client.query('SELECT now()'));
    dict = await DD.build(client);
    const chosen = dict.tables.filter((t) => !EXCLUDED_TABLES.includes(t.name) && (!tables || tables.includes(t.name)));
    for (const t of chosen) {
      const cols = t.columns.filter((col) => col.type !== 'bytea');
      const skipped = t.columns.filter((col) => col.type === 'bytea').map((col) => col.name);
      if (skipped.length) omitted[t.name] = skipped;
      const names = cols.map((col) => col.name);
      const has = (n) => names.includes(n);
      // From a moment: rows created or changed since, where the table says.
      let where = '';
      if (from) {
        const conds = [];
        if (has('created_at')) conds.push('created_at >= $1::timestamptz');
        if (has('updated_at')) conds.push('updated_at >= $1::timestamptz');
        where = conds.length ? `WHERE ${conds.join(' OR ')}` : '';
      }
      const q = (s) => `"${s.replace(/"/g, '""')}"`;
      const order = t.primaryKey.length ? `ORDER BY ${t.primaryKey.map(q).join(', ')}` : '';
      const select = `SELECT ${cols.map((col) => `${q(col.name)}::text AS ${q(col.name)}`).join(', ')} FROM ${q(t.name)} ${where} ${order}`;
      const params = where ? [from] : [];
      const chunks = [`${names.map(DD.csvCell).join(',')}\r\n`];
      let n = 0;
      await client.query(`DECLARE backup_cursor NO SCROLL CURSOR FOR ${select}`, params);
      for (;;) {
        const { rows } = await client.query(`FETCH ${BATCH} FROM backup_cursor`);
        if (!rows.length) break;
        n += rows.length;
        chunks.push(rows.map((r) => names.map((k) => DD.csvCell(r[k])).join(',')).join('\r\n') + '\r\n');
      }
      await client.query('CLOSE backup_cursor');
      counts[t.name] = n;
      columnsOf[t.name] = names;
      files.push({ name: `${t.name}.csv`, data: Buffer.from(chunks.join(''), 'utf8') });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const manifest = {
    tenant: tenant.slug,
    schemaVersion: dict.schema.version,
    snapshotAt: new Date(snapshotAt).toISOString(),
    fromDate: from,
    tables: counts,
    excludedTables: EXCLUDED_TABLES,
    omittedColumns: omitted,
    format: 'CSV, UTF-8, comma separated, header row, CRLF line ends; values in PostgreSQL text form, timestamps in UTC; empty field is NULL.',
  };
  files.push({ name: 'schema.sql', data: DD.schemaSql(dict, Object.keys(counts), { withoutBinary: true }) });
  files.push({ name: 'restore.sql', data: restoreSql(tenant, columnsOf) });
  files.push({ name: 'dictionary.json', data: JSON.stringify({ ...dict, tables: dict.tables.filter((t) => counts[t.name] !== undefined) }, null, 2) });
  files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  return { files, counts, snapshotAt };
}

// --- loading a backup back (the reference platform: Import Database clone) ------------------

const ident = (x) => `"${String(x).replace(/"/g, '""')}"`;

/**
 * restore.sql, in the ZIP: loads the backup into a PostgreSQL database with
 * psql, from the folder it was unzipped into:
 *   psql -d mydb -v schema=citysacco_copy -f restore.sql
 * The schema is created if missing (default tenant_backup); the tables come
 * from schema.sql and the rows from the CSVs, in one transaction.
 */
function restoreSql(tenant, columnsOf) {
  const out = [
    `-- Load the ${tenant.slug} backup into PostgreSQL. Unzip it, change into the folder, and run:`,
    '--   psql -d yourdb -v schema=your_schema -f restore.sql',
    '\\set ON_ERROR_STOP on',
    '\\if :{?schema}',
    '\\else',
    '\\set schema tenant_backup',
    '\\endif',
    'BEGIN;',
    'CREATE SCHEMA IF NOT EXISTS :"schema";',
    'SET LOCAL search_path TO :"schema";',
    '\\i schema.sql',
  ];
  for (const [t, cols] of Object.entries(columnsOf)) {
    out.push(`\\copy ${ident(t)} (${cols.map(ident).join(', ')}) FROM '${t}.csv' WITH (FORMAT csv, HEADER true)`);
  }
  out.push('COMMIT;');
  return `${out.join('\n')}\n`;
}

/**
 * Load a backup ZIP into a schema of a database (cli backup:load): the
 * tables from schema.sql, then each CSV's rows, in one transaction. For
 * analysis or a check that a backup restores; the migrations remain the
 * way a tenant's live schema is made.
 */
async function load(zipBuffer, { schema, client }) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(String(schema))) throw err('SCHEMA_NAME_IS_LOWERCASE_LETTERS_DIGITS_AND_UNDERSCORES');
  const files = unzip(zipBuffer, { maxTotal: 2 * 1024 * 1024 * 1024, maxEntries: 1000 });
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const counts = {};
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
    await client.query(`SET LOCAL search_path TO ${ident(schema)}`);
    await client.query(files.get('schema.sql').toString('utf8'));
    for (const t of Object.keys(manifest.tables)) {
      const rows = CSV.parse(files.get(`${t}.csv`).toString('utf8'));
      const [header, ...body] = rows;
      for (let i = 0; i < body.length; i += 500) {
        const batch = body.slice(i, i + 500);
        const params = [];
        const values = batch.map((r) => `(${header.map((_, k) => { params.push(r[k]); return `$${params.length}`; }).join(',')})`);
        await client.query(`INSERT INTO ${ident(t)} (${header.map(ident).join(',')}) VALUES ${values.join(',')}`, params);
      }
      counts[t] = body.length;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
  return { schema, tables: counts };
}

async function run(tenant, row) {
  let outcome;
  try {
    const { files, counts } = await exportTables(tenant, { tables: row.tables, from: row.from_date });
    const data = zip(files);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const fileName = `${tenant.slug}-backup-${stamp}.zip`;
    outcome = await withTenant(tenant.schema_name, async (c) => (await c.query(
      `UPDATE database_backups
       SET status = 'COMPLETE', file = $2, file_name = $3, file_size = $4, sha256 = $5, row_counts = $6,
           finished_at = now(), expires_at = now() + make_interval(days => $7::int)
       WHERE id = $1 RETURNING ${PUBLIC}`,
      [row.id, data, fileName, data.length, sha256, JSON.stringify(counts), RETENTION_DAYS])).rows[0]);
  } catch (e) {
    outcome = await withTenant(tenant.schema_name, async (c) => (await c.query(
      `UPDATE database_backups SET status = 'FAILED', error = $2, finished_at = now()
       WHERE id = $1 RETURNING ${PUBLIC}`, [row.id, String(e.message).slice(0, 1000)])).rows[0]);
  }
  if (row.callback_url) {
    const result = await postCallback(row.callback_url, {
      backupId: outcome.id,
      tenant: tenant.slug,
      state: outcome.status,
      finishedAt: outcome.finished_at,
      fileName: outcome.file_name,
      fileSize: outcome.file_size,
      sha256: outcome.sha256,
      download: outcome.status === 'COMPLETE' ? `/api/database/backup/${outcome.id}/file` : null,
      error: outcome.error,
    });
    await withTenant(tenant.schema_name, (c) => c.query(
      'UPDATE database_backups SET callback_result = $2 WHERE id = $1', [row.id, JSON.stringify(result)]));
    outcome.callback_result = result;
  }
  return outcome;
}

module.exports = { request, list, get, file, waitFor, expire, checkCallbackUrl, isPrivateAddress, load, restoreSql, EXCLUDED_TABLES };
