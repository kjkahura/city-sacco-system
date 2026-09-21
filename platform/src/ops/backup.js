'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pool } = require('../db/pool');
const { assertSchemaName } = require('../db/tenantContext');
const crypt = require('./crypt');
const offsite = require('./offsite');

/**
 * Per-tenant backup.
 *
 * Schema per tenant makes this the easy win of the whole design: one
 * pg_dump -n tenant_<slug> is that SACCO's entire book, and restoring it
 * touches nobody else. That is the answer to the question a board asks
 * before signing, so it is automated rather than left as a runbook note.
 */

const DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const PG_DUMP = process.env.PG_DUMP || 'pg_dump';
const PG_RESTORE = process.env.PG_RESTORE || 'pg_restore';

function run(cmd, args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0
      ? resolve({ stderr })
      : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`))));
  });
}

const sha256File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d))
    .on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

async function backupTenant(slug, { dir = DIR } = {}) {
  const { rows } = await pool.query('SELECT * FROM platform.tenants WHERE slug = $1', [slug]);
  if (!rows.length) throw Object.assign(new Error('TENANT_NOT_FOUND'), { status: 404 });
  const t = rows[0];
  assertSchemaName(t.schema_name);

  fs.mkdirSync(path.join(dir, slug), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, slug, `${t.schema_name}-${stamp}.dump`);

  const { rows: [runRow] } = await pool.query(
    `INSERT INTO platform.backup_runs (tenant_id, schema_name, path, status)
     VALUES ($1,$2,$3,'RUNNING') RETURNING *`,
    [t.id, t.schema_name, file]
  );

  try {
    // Custom format so pg_restore can do a selective, parallel restore.
    await run(PG_DUMP, [
      '--format=custom', '--no-owner', '--no-privileges',
      '--schema', t.schema_name,
      '--file', file,
      '--host', process.env.PGHOST || 'localhost',
      '--port', String(process.env.PGPORT || 5432),
      '--username', process.env.PGUSER || 'postgres',
      process.env.PGDATABASE || 'sacco',
    ]);

    const { size } = fs.statSync(file);
    if (!size) throw new Error('pg_dump produced an empty file');

    // Encrypt at rest. The plaintext dump is removed once the encrypted
    // copy verifies, so a readable book is never left lying on disk.
    let finalPath = file;
    let encrypted = false;
    if (crypt.isConfigured()) {
      const enc = `${file}.enc`;
      await crypt.encryptFile(file, enc);
      // Round-trip before deleting the plaintext. An encrypted file that
      // cannot be decrypted is not a backup.
      const probe = `${file}.probe`;
      await crypt.decryptFile(enc, probe);
      if (fs.statSync(probe).size !== size) throw new Error('encryption round trip size mismatch');
      fs.unlinkSync(probe);
      fs.unlinkSync(file);
      finalPath = enc;
      encrypted = true;
    }

    const digest = await sha256File(finalPath);
    const bytes = fs.statSync(finalPath).size;

    let shipped = null;
    if (encrypted || !crypt.isConfigured()) {
      try {
        shipped = await offsite.ship(finalPath, { slug });
      } catch (e) {
        // A failed offsite copy must not throw away a good local backup,
        // but it must be visible rather than swallowed.
        shipped = { shipped: false, error: e.message };
      }
    }

    await pool.query(
      `UPDATE platform.backup_runs SET status='SUCCEEDED', bytes=$1, sha256=$2,
         path=$3, finished_at=now() WHERE id=$4`,
      [bytes, digest, finalPath, runRow.id]
    );
    return { slug, file: finalPath, bytes, sha256: digest, encrypted, offsite: shipped };
  } catch (e) {
    await pool.query(
      "UPDATE platform.backup_runs SET status='FAILED', error=$1, finished_at=now() WHERE id=$2",
      [e.message.slice(0, 1000), runRow.id]
    );
    for (const f of [file, `${file}.enc`, `${file}.probe`]) { try { fs.unlinkSync(f); } catch {} }
    throw e;
  }
}

async function backupAll({ dir = DIR, concurrency = 2 } = {}) {
  const { rows } = await pool.query(
    "SELECT slug FROM platform.tenants WHERE status = 'ACTIVE' ORDER BY slug");
  const results = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const out = await Promise.all(batch.map(async (t) => {
      try { return { ...(await backupTenant(t.slug, { dir })), ok: true }; }
      catch (e) { return { slug: t.slug, ok: false, error: e.message }; }
    }));
    results.push(...out);
  }
  return results;
}

/**
 * Restore into a different schema by default. Restoring over a live tenant
 * should be a deliberate act, not a default, so the caller must name the
 * target and confirm when it is the original.
 */
async function restoreTenant(file, { targetSchema, confirmOverwrite = false } = {}) {
  if (!fs.existsSync(file)) throw new Error(`backup file not found: ${file}`);
  assertSchemaName(targetSchema);

  const { rows } = await pool.query(
    'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [targetSchema]);
  if (rows.length && !confirmOverwrite) {
    throw Object.assign(
      new Error(`${targetSchema} already exists; pass confirmOverwrite to replace it`), { status: 409 });
  }

  await run(PG_RESTORE, [
    '--no-owner', '--no-privileges', '--clean', '--if-exists',
    '--dbname', process.env.PGDATABASE || 'sacco',
    '--host', process.env.PGHOST || 'localhost',
    '--port', String(process.env.PGPORT || 5432),
    '--username', process.env.PGUSER || 'postgres',
    file,
  ]);
  return { restored: targetSchema, from: file };
}

/** Retention: keep the newest N per tenant, delete the rest from disk. */
async function prune({ dir = DIR, keep = 14 } = {}) {
  const { rows } = await pool.query('SELECT slug FROM platform.tenants');
  const pruned = [];
  for (const t of rows) {
    const d = path.join(dir, t.slug);
    if (!fs.existsSync(d)) continue;
    const files = fs.readdirSync(d)
      .filter((f) => f.endsWith('.dump') || f.endsWith('.enc'))
      .map((f) => ({ f, full: path.join(d, f), mtime: fs.statSync(path.join(d, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(keep)) {
      fs.unlinkSync(old.full);
      await pool.query("UPDATE platform.backup_runs SET status='PRUNED' WHERE path = $1", [old.full]);
      pruned.push(old.full);
    }
  }
  return pruned;
}

/**
 * A backup nobody has restored is a hope, not a backup. This restores the
 * newest dump into a throwaway schema, counts a couple of tables, and drops
 * it again, so the restore path is exercised rather than assumed.
 */
async function verifyLatest(slug, { dir = DIR } = {}) {
  const d = path.join(dir, slug);
  if (!fs.existsSync(d)) throw new Error(`no backups for ${slug}`);
  const newest = fs.readdirSync(d).filter((f) => f.endsWith('.dump') || f.endsWith('.enc'))
    .map((f) => ({ f, full: path.join(d, f), mtime: fs.statSync(path.join(d, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) throw new Error(`no backups for ${slug}`);

  // Decrypt to a temporary plaintext that is removed whatever happens.
  let restoreFrom = newest.full;
  let tmpPlain = null;
  if (newest.full.endsWith('.enc')) {
    tmpPlain = `${newest.full}.restore-${Date.now()}`;
    await crypt.decryptFile(newest.full, tmpPlain);
    restoreFrom = tmpPlain;
  }

  const { rows: [t] } = await pool.query('SELECT schema_name FROM platform.tenants WHERE slug=$1', [slug]);
  const probe = `tenant_verify_${Date.now().toString(36)}`.slice(0, 40);

  // pg_restore writes into the schema recorded in the dump, so verify by
  // restoring into a scratch database-side copy: rename, check, drop.
  const { rows: [{ format: rename }] } = await pool.query(
    "SELECT format('ALTER SCHEMA %I RENAME TO %I', $1::text, $2::text)", [t.schema_name, probe]);
  const { rows: [{ format: back }] } = await pool.query(
    "SELECT format('ALTER SCHEMA %I RENAME TO %I', $1::text, $2::text)", [probe, t.schema_name]);

  await pool.query(rename);
  try {
    await restoreTenant(restoreFrom, { targetSchema: t.schema_name, confirmOverwrite: true });
    const { rows: [c] } = await pool.query(
      `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = $1)::int AS tables`,
      [t.schema_name]
    );
    const { rows: [{ format: drop }] } = await pool.query(
      "SELECT format('DROP SCHEMA IF EXISTS %I CASCADE', $1::text)", [t.schema_name]);
    await pool.query(drop);
    await pool.query(back);
    if (tmpPlain) { try { fs.unlinkSync(tmpPlain); } catch {} }
    return {
      slug, file: newest.full, encrypted: Boolean(tmpPlain),
      tablesRestored: c.tables, ok: c.tables > 0,
    };
  } catch (e) {
    const { rows: [{ format: drop }] } = await pool.query(
      "SELECT format('DROP SCHEMA IF EXISTS %I CASCADE', $1::text)", [t.schema_name]);
    await pool.query(drop).catch(() => {});
    await pool.query(back).catch(() => {});
    if (tmpPlain) { try { fs.unlinkSync(tmpPlain); } catch {} }
    throw e;
  }
}

/**
 * Re-encrypt every stored backup with the current key.
 *
 * Run after rotating BACKUP_ENCRYPTION_KEY, with the old key still present
 * in BACKUP_ENCRYPTION_KEYS_OLD. Each file is verified before it is
 * replaced, and a failure leaves the original untouched, so a half-finished
 * rekey never costs you a backup.
 */
async function rekeyAll({ dir = DIR, slug = null } = {}) {
  const { rows } = await pool.query(
    'SELECT slug FROM platform.tenants WHERE ($1::text IS NULL OR slug = $1)', [slug]);
  const results = [];
  const currentId = crypt.keyId(crypt.currentKey());

  for (const t of rows) {
    const d = path.join(dir, t.slug);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.enc'))) {
      const full = path.join(d, f);
      const before = crypt.inspect(full);
      if (before.keyId === currentId) {
        results.push({ slug: t.slug, file: f, skipped: 'ALREADY_CURRENT_KEY' });
        continue;
      }
      try {
        const out = await crypt.rekeyFile(full);
        const digest = await sha256File(full);
        await pool.query(
          'UPDATE platform.backup_runs SET sha256 = $1, bytes = $2 WHERE path = $3',
          [digest, out.bytes, full]
        );
        results.push({ slug: t.slug, file: f, from: out.fromKeyId || 'v1', to: out.toKeyId, ok: true });
      } catch (e) {
        results.push({ slug: t.slug, file: f, ok: false, error: e.message });
      }
    }
  }
  return { currentKeyId: currentId, files: results };
}

/** Which key each stored backup is encrypted with. */
function keyReport({ dir = DIR } = {}) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const slug of fs.readdirSync(dir)) {
    const d = path.join(dir, slug);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.enc'))) {
      out.push({ slug, file: f, ...crypt.inspect(path.join(d, f)) });
    }
  }
  return out;
}

module.exports = {
  backupTenant, backupAll, restoreTenant, prune, verifyLatest,
  rekeyAll, keyReport, DIR, crypt, offsite,
};
