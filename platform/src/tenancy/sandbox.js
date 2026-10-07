'use strict';

const crypto = require('crypto');
const { pool, directPool } = require('../db/pool');
const { migrateTenant } = require('../db/migrate');
const { hashPassword } = require('../auth/passwords');
const { TenantError } = require('../db/tenantContext');
const provision = require('./provision');
const { invalidate } = require('./resolve');

/**
 * Sandboxes (docs/audits/audit-getting-started-and-sandbox.md): one second
 * tenant per SACCO, `<slug>_sbx`, on the same deployment, marked SANDBOX and
 * linked to its production tenant.
 *
 * Operations are queued (one at a time per SACCO) and run by runPending(),
 * from the scheduler's notification pass, `cli sandbox:run` or straight after the request, since
 * a clone of a large book outlasts a request:
 *
 *   CREATE  an empty sandbox: migrations and the seeds a new tenant gets
 *   RESET   the same, over an existing sandbox
 *   CLONE   production's book copied, anonymized unless asked otherwise
 *   DELETE  the sandbox's schema dropped and its tenant closed
 *
 * Whatever the operation, the sandbox is left with its administrator (who
 * asked), with a temporary password shown once. A clone copies the staff
 * users with their roles but no passwords or second factors; it leaves out
 * API consumers and keys, the notification queues and members' portal
 * access; and it switches webhooks, email and SMS off and drops their
 * secrets, so a sandbox cannot write to a real member.
 */

const SUFFIX = '_sbx';
const OPEN = ['QUEUED', 'RUNNING'];
const STATE_OF = { CREATE: 'CREATING', RESET: 'RESETTING', CLONE: 'CLONING', DELETE: 'DELETING' };
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Tables whose rows a clone leaves behind: queues, sessions, keys and
// idempotency records belong to production's traffic, not its book.
const NOT_COPIED = new Set([
  'notification_events', 'notification_messages', 'stream_events', 'stream_cursors', 'stream_sessions', 'stream_subscriptions',
  'api_idempotency', 'app_launches', 'member_credentials', 'member_login_attempts', 'member_sessions', 'database_backups',
]);

const shapeOp = (o) => o && ({
  id: o.id, kind: o.kind, anonymize: o.anonymize, state: o.state, detail: o.detail || null, requestedBy: o.requested_by,
  requestedAt: iso(o.requested_at), startedAt: iso(o.started_at), finishedAt: iso(o.finished_at),
});

async function productionOf(slug) {
  const t = await one('SELECT * FROM platform.tenants WHERE slug = $1', [slug]);
  if (!t) throw new TenantError('tenant not found', 404);
  if (t.environment === 'SANDBOX') throw new TenantError('A_SANDBOX_HAS_NO_SANDBOX: manage it from its production tenant', 409);
  return t;
}

const sandboxOf = (prod) => one("SELECT * FROM platform.tenants WHERE production_tenant_id = $1 AND status <> 'CLOSED'", [prod.id]);

/** What a SACCO's administrators see: whether there is a sandbox, its state and the last operation. */
async function status(slug) {
  const prod = await productionOf(slug);
  const sbx = await sandboxOf(prod);
  const last = await one('SELECT * FROM platform.sandbox_operations WHERE production_tenant_id = $1 ORDER BY requested_at DESC LIMIT 1', [prod.id]);
  return {
    exists: Boolean(sbx), slug: sbx?.slug || null, state: sbx?.sandbox_state || null, status: sbx?.status || null,
    createdAt: iso(sbx?.created_at), lastOperation: shapeOp(last),
  };
}

/**
 * Queue an operation. CREATE needs no sandbox; DELETE needs one; RESET and
 * CLONE make it when there is none. Returns the operation and, unless
 * deleting, the administrator's temporary password (shown this once).
 */
async function request(slug, kind, { actor, adminEmail = null, anonymize = true } = {}) {
  if (!STATE_OF[kind]) throw new TenantError(`UNKNOWN_SANDBOX_OPERATION: ${kind}`, 400);
  const prod = await productionOf(slug);
  if (prod.status !== 'ACTIVE') throw new TenantError(`tenant ${slug} is ${prod.status}`, 409);
  const sbxSlug = `${prod.slug}${SUFFIX}`;
  if (!provision.SLUG_RE.test(sbxSlug)) throw new TenantError(`SLUG_TOO_LONG_FOR_A_SANDBOX: ${sbxSlug}`, 409);
  const sbx = await sandboxOf(prod);
  if (kind === 'CREATE' && sbx) throw new TenantError('SANDBOX_EXISTS: reset, clone or delete it', 409);
  if (kind === 'DELETE' && !sbx) throw new TenantError('NO_SANDBOX', 404);
  if (typeof anonymize !== 'boolean') throw new TenantError('ANONYMIZE_MUST_BE_TRUE_OR_FALSE', 400);
  const email = String(adminEmail || actor || '').trim().toLowerCase();
  if (kind !== 'DELETE' && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new TenantError('ADMIN_EMAIL_REQUIRED: the sandbox administrator', 400);
  const password = kind === 'DELETE' ? null : crypto.randomBytes(18).toString('base64url');
  let op;
  try {
    op = (await pool.query(
      `INSERT INTO platform.sandbox_operations (production_tenant_id, kind, anonymize, admin_email, admin_password_hash, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [prod.id, kind, kind === 'CLONE' ? anonymize : null, kind === 'DELETE' ? null : email, password ? await hashPassword(password) : null, actor || 'SYSTEM'])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw new TenantError('SANDBOX_BUSY: an operation is queued or running', 409);
    throw e;
  }
  await pool.query("INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'SANDBOX_REQUESTED', $3)",
    [prod.id, actor || 'SYSTEM', JSON.stringify({ kind, anonymize: op.anonymize })]);
  kick();
  return { operation: shapeOp(op), sandbox: { slug: sbxSlug }, ...(password ? { adminEmail: email, temporaryPassword: password } : {}) };
}

// --- running operations ------------------------------------------------------------------

let running = null;
let again = false;
const LOCK = (id) => `sandbox:${id}`;

/**
 * Run what is queued, one operation after another, until the queue is empty.
 * A runner holds an advisory lock on its operation for as long as it runs it,
 * so an operation left RUNNING with no lock held belongs to a runner that
 * stopped (a restart, a crash): it is marked failed and the SACCO can go on.
 */
async function runPending() {
  if (running) { again = true; return running; }
  running = (async () => {
    const out = await recover();
    for (;;) {
      again = false;
      // The operation's session advisory lock needs a connection of its own (db/pool directPool).
      const c = await directPool.connect();
      let op = null;
      try {
        await c.query('BEGIN');
        op = (await c.query("SELECT * FROM platform.sandbox_operations WHERE state = 'QUEUED' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
        if (op) {
          await c.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK(op.id)]);
          await c.query("UPDATE platform.sandbox_operations SET state = 'RUNNING', started_at = now() WHERE id = $1", [op.id]);
        }
        await c.query('COMMIT');
        if (!op) { if (again) continue; break; }
        try {
          const detail = await execute(op);
          await finish(op, 'DONE', detail);
          out.push({ id: op.id, kind: op.kind, state: 'DONE', detail });
        } catch (e) {
          await fail(op, e.message);
          out.push({ id: op.id, kind: op.kind, state: 'FAILED', detail: e.message });
        }
      } finally {
        if (op) await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK(op.id)]).catch(() => {});
        c.release();
      }
    }
    return out;
  })();
  try { return await running; } finally { running = null; }
}

const finish = (op, state, detail) => pool.query(
  'UPDATE platform.sandbox_operations SET state = $2, detail = $3, finished_at = now(), admin_password_hash = NULL WHERE id = $1',
  [op.id, state, String(detail || '').slice(0, 1000)]);

async function fail(op, message) {
  await finish(op, 'FAILED', message);
  const { rows } = await pool.query(
    `UPDATE platform.tenants SET sandbox_state = 'FAILED', status = CASE WHEN status = 'PROVISIONING' THEN 'SUSPENDED' ELSE status END, updated_at = now()
      WHERE production_tenant_id = $1 AND status <> 'CLOSED' RETURNING slug`, [op.production_tenant_id]);
  for (const r of rows) invalidate(r.slug);
  console.warn(`[sandbox] ${op.kind} failed: ${message}`);
}

/** Operations RUNNING whose runner holds no lock any more. */
async function recover() {
  const out = [];
  const { rows } = await pool.query("SELECT * FROM platform.sandbox_operations WHERE state = 'RUNNING'");
  if (!rows.length) return out;
  const c = await directPool.connect();
  try {
    for (const op of rows) {
      const { rows: [{ got }] } = await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS got', [LOCK(op.id)]);
      if (!got) continue;
      try {
        const { rowCount } = await pool.query("SELECT 1 FROM platform.sandbox_operations WHERE id = $1 AND state = 'RUNNING'", [op.id]);
        if (rowCount) {
          await fail(op, 'INTERRUPTED: the runner stopped before the operation finished; run it again');
          out.push({ id: op.id, kind: op.kind, state: 'FAILED', detail: 'INTERRUPTED' });
        }
      } finally {
        await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK(op.id)]);
      }
    }
  } finally {
    c.release();
  }
  return out;
}

function kick() {
  if (process.env.SANDBOX_AFTER_REQUEST === 'off') return;
  setTimeout(() => runPending().catch((e) => console.warn(`[sandbox] ${e.message}`)), 100).unref?.();
}

async function execute(op) {
  const prod = await one('SELECT * FROM platform.tenants WHERE id = $1', [op.production_tenant_id]);
  let sbx = await sandboxOf(prod);
  if (op.kind === 'DELETE') {
    if (!sbx) return 'no sandbox';
    await setState(sbx, 'DELETING', 'PROVISIONING');
    await provision.deprovisionTenant(sbx.slug, { confirm: sbx.slug });
    await pool.query("UPDATE platform.tenants SET sandbox_state = NULL, updated_at = now() WHERE id = $1", [sbx.id]);
    await pool.query('DELETE FROM platform.users WHERE tenant_id = $1', [sbx.id]);
    invalidate(sbx.slug);
    return `deleted ${sbx.slug}`;
  }
  if (!sbx) sbx = await createTenantRow(prod);
  else sbx = await syncTenantRow(sbx, prod);
  // Never drop anything but a sandbox's own schema.
  if (sbx.environment !== 'SANDBOX' || sbx.id === prod.id || sbx.schema_name === prod.schema_name || sbx.production_tenant_id !== prod.id) {
    throw new Error(`NOT_A_SANDBOX: ${sbx.slug}`);
  }
  await setState(sbx, STATE_OF[op.kind], 'PROVISIONING');
  await pool.query(`DROP SCHEMA IF EXISTS ${ident(sbx.schema_name)} CASCADE`);
  await pool.query('DELETE FROM platform.schema_migrations WHERE schema_name = $1', [sbx.schema_name]);
  await migrateTenant(sbx.schema_name);
  let detail;
  if (op.kind === 'CLONE') {
    const counts = await copyBook(prod.schema_name, sbx.schema_name, { anonymize: op.anonymize });
    await copyUsers(prod, sbx, { anonymize: op.anonymize });
    detail = `cloned ${counts.tables} tables, ${counts.rows} rows${op.anonymize ? ', anonymized' : ', with production data'}`;
  } else {
    await provision.seedTenantSchema(sbx.schema_name);
    await quiet(pool, sbx.schema_name);
    await pool.query('DELETE FROM platform.users WHERE tenant_id = $1', [sbx.id]);
    detail = op.kind === 'CREATE' ? `created ${sbx.slug}` : `reset ${sbx.slug}`;
  }
  await setAdmin(sbx, op);
  await setState(sbx, 'READY', 'ACTIVE');
  await pool.query("INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4)",
    [prod.id, op.requested_by, { CREATE: 'SANDBOX_CREATED', RESET: 'SANDBOX_RESET', CLONE: 'SANDBOX_CLONED' }[op.kind], JSON.stringify({ sandbox: sbx.slug, detail })]);
  return detail;
}

async function setState(sbx, state, status) {
  await pool.query('UPDATE platform.tenants SET sandbox_state = $2, status = $3, updated_at = now() WHERE id = $1', [sbx.id, state, status]);
  invalidate(sbx.slug);
}

async function createTenantRow(prod) {
  const slug = `${prod.slug}${SUFFIX}`;
  // A closed sandbox of the same name (deleted earlier) is reopened rather than duplicated.
  const old = await one('SELECT * FROM platform.tenants WHERE slug = $1', [slug]);
  if (old) {
    if (old.environment !== 'SANDBOX') throw new TenantError(`SLUG_TAKEN: ${slug} is not a sandbox`, 409);
    return syncTenantRow({ ...old, status: 'PROVISIONING' }, prod, 'PROVISIONING');
  }
  return (await pool.query(
    `INSERT INTO platform.tenants (slug, schema_name, name, country_code, currency_code, timezone, plan, status, mfa_required_roles,
       environment, production_tenant_id, rate_limit_per_min, max_concurrent_queries, access_preferences)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROVISIONING', $8, 'SANDBOX', $9, $10, $11, $12) RETURNING *`,
    [slug, provision.toSchemaName(slug), `${prod.name} (sandbox)`, prod.country_code, prod.currency_code, prod.timezone, prod.plan,
      prod.mfa_required_roles, prod.id, prod.rate_limit_per_min, prod.max_concurrent_queries, prod.access_preferences || {}])).rows[0];
}

/** A sandbox follows its production tenant's settings and security policy (access preferences, second factors) at every operation. */
async function syncTenantRow(sbx, prod, status = sbx.status) {
  if (sbx.environment !== 'SANDBOX') throw new TenantError(`SLUG_TAKEN: ${sbx.slug} is not a sandbox`, 409);
  return (await pool.query(
    `UPDATE platform.tenants SET production_tenant_id = $2, status = $3, name = $4, country_code = $5, currency_code = $6,
       timezone = $7, mfa_required_roles = $8, access_preferences = $9, updated_at = now() WHERE id = $1 AND environment = 'SANDBOX' RETURNING *`,
    [sbx.id, prod.id, status, `${prod.name} (sandbox)`, prod.country_code, prod.currency_code, prod.timezone, prod.mfa_required_roles,
      prod.access_preferences || {}])).rows[0];
}

/** The administrator the operation leaves: whoever asked, with the password shown to them, to be changed at first sign-in. */
async function setAdmin(sbx, op) {
  const { rowCount } = await pool.query(
    `UPDATE platform.users SET password_hash = $3, must_change_password = true, status = 'ACTIVE', role = 'TENANT_ADMIN',
       mfa_enabled = false, mfa_secret = NULL, mfa_enrolled_at = NULL, updated_at = now()
     WHERE tenant_id = $1 AND lower(email) = $2`, [sbx.id, op.admin_email, op.admin_password_hash]);
  if (!rowCount) {
    await pool.query(
      `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role, must_change_password, created_by)
       VALUES ($1, $2, $3, $2, 'TENANT_ADMIN', true, $4)`, [sbx.id, op.admin_email, op.admin_password_hash, op.requested_by]);
  }
}

/**
 * Production's staff, with their roles, branches, limits and permissions,
 * but no password (a value no password matches) and no second factor.
 */
async function copyUsers(prod, sbx, { anonymize: anon = false } = {}) {
  await pool.query('DELETE FROM platform.users WHERE tenant_id = $1', [sbx.id]);
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'users'
      AND column_name NOT IN ('id', 'tenant_id', 'password_hash', 'mfa_enabled', 'mfa_secret', 'mfa_enrolled_at', 'mfa_last_counter',
        'last_login_at', 'locked_at', 'locked_until', 'failed_logins', 'password_changed_at', 'created_at', 'updated_at')
      AND is_generated = 'NEVER'`);
  const list = cols.map((c) => ident(c.column_name)).join(', ');
  await pool.query(
    `INSERT INTO platform.users (tenant_id, password_hash, ${list})
     SELECT $2, '!' || replace(gen_random_uuid()::text, '-', ''), ${list} FROM platform.users WHERE tenant_id = $1`, [prod.id, sbx.id]);
  // Staff contact details and their own custom fields are personal data too.
  if (anon) await pool.query("UPDATE platform.users SET phone = NULL, custom_fields = '{}' WHERE tenant_id = $1", [sbx.id]);
}

// --- copying a book ---------------------------------------------------------------------

/**
 * Copy every table of production's schema into the sandbox's (built by the
 * same migrations). Foreign keys are dropped while copying and added back
 * after, which also checks the copy; user triggers are off, so no event is
 * raised and no ledger guard fires on rows already checked in production.
 * Sequences are set to production's values. One transaction, with the
 * anonymization and the switching off: a clone is all or nothing.
 */
async function copyBook(from, to, { anonymize: anon = true } = {}) {
  const c = await pool.connect();
  let rows = 0;
  let tables = 0;
  try {
    // One snapshot of production for every table, so a posting made during
    // the copy is in it whole or not at all.
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const { rows: fks } = await c.query(
      `SELECT k.conname, t.relname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid
        WHERE k.contype = 'f' AND k.connamespace = $1::regnamespace`, [to]);
    for (const f of fks) await c.query(`ALTER TABLE ${ident(to)}.${ident(f.relname)} DROP CONSTRAINT ${ident(f.conname)}`);
    const { rows: list } = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`, [to]);
    for (const { table_name: t } of list) {
      if (NOT_COPIED.has(t)) continue;
      const { rows: present } = await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2", [from, t]);
      if (!present.length) continue;
      const { rows: cols } = await c.query(
        `SELECT a.column_name FROM information_schema.columns a JOIN information_schema.columns b
            ON b.table_schema = $2 AND b.table_name = a.table_name AND b.column_name = a.column_name
          WHERE a.table_schema = $1 AND a.table_name = $3 AND a.is_generated = 'NEVER' ORDER BY a.ordinal_position`, [to, from, t]);
      const names = cols.map((x) => ident(x.column_name)).join(', ');
      await c.query(`ALTER TABLE ${ident(to)}.${ident(t)} DISABLE TRIGGER USER`);
      await c.query(`DELETE FROM ${ident(to)}.${ident(t)}`);
      const { rowCount } = await c.query(
        `INSERT INTO ${ident(to)}.${ident(t)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${names} FROM ${ident(from)}.${ident(t)}`);
      await c.query(`ALTER TABLE ${ident(to)}.${ident(t)} ENABLE TRIGGER USER`);
      rows += rowCount;
      tables += 1;
    }
    for (const f of fks) await c.query(`ALTER TABLE ${ident(to)}.${ident(f.relname)} ADD CONSTRAINT ${ident(f.conname)} ${f.def}`);
    const { rows: seqs } = await c.query('SELECT sequencename FROM pg_sequences WHERE schemaname = $1', [to]);
    for (const { sequencename: s } of seqs) {
      const { rows: here } = await c.query('SELECT 1 FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2', [from, s]);
      if (!here.length) continue;
      const { rows: [src] } = await c.query(`SELECT last_value, is_called FROM ${ident(from)}.${ident(s)}`);
      await c.query('SELECT setval($1, $2, $3)', [`${ident(to)}.${ident(s)}`, src.last_value, src.is_called]);
    }
    // In the same transaction: production's personal data is never committed to the sandbox.
    if (anon) await anonymize(c, to);
    await quiet(c, to);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return { tables, rows };
}

/** Columns a table has, for the updates that follow (a migration may not have added one yet). */
async function columnsOf(c, schema, table) {
  const { rows } = await c.query('SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [schema, table]);
  return new Map(rows.map((r) => [r.column_name, r.is_nullable === 'YES']));
}

/**
 * The anonymized clone (the reference platform's list): members' and
 * groups' names replaced, and their contacts, documents, addresses, notes,
 * custom field values, pictures and attachments removed; account names,
 * transaction and journal narrations and notes removed; the audit trail and
 * activities removed; members unsubscribed from email and SMS templates.
 */
// Free-text columns, wherever they appear: staff write members' details into them.
const FREE_TEXT = new Set(['notes', 'note', 'narration', 'description', 'reason', 'decision_note', 'reversal_reason', 'comment', 'comments',
  'purpose', 'memo', 'remarks', 'state_reason', 'exit_reason', 'locked_reason', 'migration_fields']);

async function anonymize(c, schema) {
  const T = (t) => `${ident(schema)}.${ident(t)}`;
  const quietly = async (table, fn) => {
    await c.query(`ALTER TABLE ${T(table)} DISABLE TRIGGER USER`);
    await fn();
    await c.query(`ALTER TABLE ${T(table)} ENABLE TRIGGER USER`);
  };
  const nullable = async (table, names) => {
    const cols = await columnsOf(c, schema, table);
    const set = names.filter((n) => cols.get(n) === true).map((n) => `${ident(n)} = NULL`);
    if (set.length) await quietly(table, () => c.query(`UPDATE ${T(table)} SET ${set.join(', ')}`));
  };
  await quietly('members', () => c.query(`UPDATE ${T('members')} SET first_name = CASE WHEN holder_type = 'GROUP' THEN 'Group' ELSE 'Client' END, last_name = member_no`));
  await nullable('members', ['middle_name', 'national_id', 'kra_pin', 'phone', 'phone2', 'email', 'date_of_birth', 'gender', 'employer', 'address_line1',
    'address_line2', 'city', 'postcode', 'region', 'country', 'preferred_language']);
  for (const [table, names] of [['savings_accounts', ['name']], ['loan_accounts', ['name']], ['loan_collateral', ['reference']]]) await nullable(table, names);
  await quietly('loan_collateral', () => c.query(`UPDATE ${T('loan_collateral')} SET description = 'Collateral'`));
  await quietly('tasks', () => c.query(`UPDATE ${T('tasks')} SET title = 'Task'`));
  // Free text and custom field values on every table that has them.
  const { rows: cols } = await c.query(
    `SELECT c.table_name, c.column_name, c.is_nullable, c.data_type FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = $1 AND (c.column_name = ANY($2) OR (c.column_name = 'custom_fields' AND c.data_type = 'jsonb'))`, [schema, [...FREE_TEXT]]);
  const byTable = new Map();
  for (const x of cols) {
    let v = null;
    if (x.column_name === 'custom_fields') v = "'{}'";
    else if (x.is_nullable === 'YES') v = 'NULL';
    else if (x.data_type === 'text') v = "'Removed in the sandbox'";
    else if (x.data_type === 'jsonb') v = "'{}'";
    if (!v) continue;
    if (!byTable.has(x.table_name)) byTable.set(x.table_name, []);
    byTable.get(x.table_name).push(`${ident(x.column_name)} = ${v}`);
  }
  for (const [t, set] of byTable) await quietly(t, () => c.query(`UPDATE ${T(t)} SET ${set.join(', ')}`));
  // Imported files hold members' rows as uploaded.
  await quietly('data_imports', () => c.query(`UPDATE ${T('data_imports')} SET file = ''::bytea, error_file = NULL, pending = NULL,
    errors = '[]', warnings = '[]', summary = '{}', file_name = 'removed'`));
  for (const t of ['member_identification_files', 'member_identifications', 'member_media', 'beneficiaries', 'loan_attachments',
    'journal_entry_attachments', 'audit_log', 'audit_events', 'activities']) {
    const { rows } = await c.query('SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [schema, t]);
    if (rows.length) await quietly(t, () => c.query(`DELETE FROM ${T(t)}`));
  }
  await c.query(`DELETE FROM ${T('notification_subscriptions')}`);
  await c.query(
    `INSERT INTO ${T('notification_subscriptions')} (template_id, member_id, subscribed, changed_by)
     SELECT t.id, m.id, false, 'SANDBOX_CLONE' FROM ${T('notification_templates')} t CROSS JOIN ${T('members')} m
      WHERE t.type IN ('EMAIL', 'SMS')`);
}

/**
 * A sandbox writes to no one: webhooks, email and SMS off, their secrets and
 * report addresses gone, and each webhook switched off, so switching webhooks
 * on sends nothing to production's receivers until a webhook is pointed at a
 * test address and switched on.
 */
async function quiet(c, schema) {
  const T = (t) => `${ident(schema)}.${ident(t)}`;
  await c.query(`UPDATE ${T('notification_settings')} SET webhook_state = 'DISABLED', updated_by = 'SANDBOX_CLONE', updated_at = now()`);
  await c.query(`UPDATE ${T('notification_channels')} SET enabled = false, secret = NULL, callback_token_hash = NULL, updated_by = 'SANDBOX_CLONE', updated_at = now()`);
  await c.query(`UPDATE ${T('notification_templates')} SET auth_secret = NULL, signing_secret = NULL, consecutive_failures = 0, circuit_open_until = NULL,
    activated = CASE WHEN type = 'WEB_HOOK' THEN false ELSE activated END`);
  // Apps (domain/apps) stay installed but disabled, without their App Keys or production's API consumers.
  await c.query(`UPDATE ${T('apps')} SET state = 'DISABLED', app_key = NULL, consumer_id = NULL, consumer_created = false, updated_by = 'SANDBOX_CLONE', updated_at = now()`);
}

module.exports = { status, request, runPending, SUFFIX };
