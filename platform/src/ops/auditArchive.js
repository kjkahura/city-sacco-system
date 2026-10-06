'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pool } = require('../db/pool');
const offsite = require('./offsite');

/**
 * A day's audit trail copied out of the database (security review, CFG-8):
 * every production SACCO's change log (audit_log) and request log
 * (audit_events), and the platform's own log, as gzipped JSON lines, sent to
 * AUDIT_ARCHIVE (dir:<path>, gcs:<bucket> or cmd:<command with {src} {name} {slug}>, as for
 * BACKUP_OFFSITE). Point it at a bucket with a locked retention policy and the
 * copy cannot be changed or deleted, even by someone holding the database.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function writeDay(file, sql, params) {
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(file, { mode: 0o600 });
  gz.pipe(out);
  const { rows } = await pool.query(sql, params);
  for (const r of rows) gz.write(`${JSON.stringify(r)}\n`);
  gz.end();
  await new Promise((ok, no) => { out.on('finish', ok); out.on('error', no); });
  return rows.length;
}

async function exportDay(day, { target = process.env.AUDIT_ARCHIVE } = {}) {
  if (!DAY.test(String(day))) throw new Error('a day as yyyy-MM-dd');
  if (!offsite.parse(target)) throw new Error('AUDIT_ARCHIVE_NOT_CONFIGURED: set AUDIT_ARCHIVE (dir:<path>, gcs:<bucket> or cmd:<command>)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const out = [];
  try {
    const { rows: tenants } = await pool.query("SELECT slug, schema_name FROM platform.tenants WHERE environment = 'PRODUCTION' AND status <> 'CLOSED' ORDER BY slug");
    const jobs = [['platform', 'platform-audit', 'SELECT * FROM platform.audit_log WHERE created_at >= $1::date AND created_at < $1::date + 1 ORDER BY id']];
    for (const t of tenants) {
      jobs.push([t.slug, 'changes', `SELECT * FROM "${t.schema_name}".audit_log WHERE created_at >= $1::date AND created_at < $1::date + 1 ORDER BY id`]);
      jobs.push([t.slug, 'requests', `SELECT * FROM "${t.schema_name}".audit_events WHERE occurred_at >= $1::date AND occurred_at < $1::date + 1 ORDER BY id`]);
    }
    for (const [slug, kind, sql] of jobs) {
      const file = path.join(dir, `${slug}-${kind}-${day}.jsonl.gz`);
      const rows = await writeDay(file, sql, [day]);
      const shipped = await offsite.ship(file, { target, slug: `audit/${slug}` });
      out.push({ slug, kind, rows, shipped: shipped.shipped });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

module.exports = { exportDay };
