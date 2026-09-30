'use strict';

/**
 * The Excel data import: the life of an import, from upload to approval or rejection.
 */

const crypto = require('crypto');
const { err } = require('../../lib/errors');
const { recordAudit } = require('../../lib/auditLog');
const definitions = require('./definitions');
const execute = require('./execute');
const parse = require('./parse');
const workbooks = require('./workbooks');

// --- the life of an import ------------------------------------------------------

const PUBLIC = `id, file_name, file_size, sha256, status, as_of, summary, errors, warnings, entry_id, progress, progress_at,
                started_at, finished_at, created_by, created_at, decided_by, decided_at, decision_note,
                (error_file IS NOT NULL) AS has_error_file, (preview IS NOT NULL) AS has_preview,
                CASE status WHEN 'PENDING_APPROVAL' THEN 'DRAFT' WHEN 'REJECTED' THEN 'REVERTED' ELSE status END AS import_state`;
const STALE_MINUTES = 30;

/** Store an upload, QUEUED for the background run (../../ops/importRunner). */
async function submit(c, { buffer, fileName }, { createdBy }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw err('SEND_THE_WORKBOOK_AS_THE_REQUEST_BODY');
  if (buffer.length > definitions.MAX_FILE) throw err(`FILE_TOO_LARGE: the limit is ${definitions.MAX_FILE} bytes`, 413);
  const name = String(fileName || 'import.xlsx').replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 200);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const { rows: [imp] } = await c.query(
    `INSERT INTO data_imports (file_name, file_size, sha256, status, file, created_by)
     VALUES ($1,$2,$3,'QUEUED',$4,$5) RETURNING ${PUBLIC}`, [name, buffer.length, sha256, buffer, createdBy]);
  await recordAudit(c, { actor: createdBy, action: 'DATA_IMPORT_UPLOADED', entity: 'data_import', entityId: imp.id, after: JSON.stringify({ fileName: name, size: buffer.length }) });
  return imp;
}

/**
 * The validation run for a QUEUED import: check the workbook, run the
 * import in a savepoint and roll it back, and record the outcome with the
 * preview. `progress(percent)` is called as it goes (the runner writes it
 * on its own connection so it can be seen while this transaction is open).
 */
async function validate(c, id, { user, today, progress = null }) {
  // Not locked: the runner writes progress to this row from another
  // connection while this transaction is open.
  const { rows: [imp] } = await c.query('SELECT * FROM data_imports WHERE id = $1', [id]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  if (!['QUEUED', 'IN_PROGRESS'].includes(imp.status)) return get(c, id);
  let parsed;
  try {
    parsed = parse.parse(imp.file, { today });
  } catch (e) {
    parsed = { asOf: null, data: null, counts: {}, errors: [{ sheet: null, row: null, column: null, message: execute.explain(e) }], warnings: [], layout: {} };
  }
  if (progress) progress(10);
  let run = { errors: [], warnings: [], created: {} };
  const preview = {};
  if (!parsed.errors.length) {
    const pre = await execute.prerequisites(c);
    const need = {
      'Loan products': parsed.data.loans.length, 'Deposit products': parsed.data.deposits.length,
      Branches: parsed.data.members.some((r) => r.branch) && !parsed.data.branches.length,
      'Users (credit officers)': parsed.data.members.some((r) => r.creditOfficer),
    };
    for (const p of pre) {
      if (!p.ok && need[p.item]) parsed.warnings.push({ sheet: null, row: null, column: null, message: `Prerequisite missing: ${p.item} (${p.detail})` });
    }
    await c.query('SAVEPOINT import_dry_run');
    try {
      run = await execute.execute(c, parsed, {
        importId: id, createdBy: imp.created_by, user, preview,
        onProgress: progress ? (done, total) => progress(10 + Math.floor((85 * done) / total)) : null,
      });
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT import_dry_run');
    }
  }
  const errors = [...parsed.errors, ...run.errors];
  const warnings = [...parsed.warnings, ...run.warnings];
  const status = errors.length ? (parsed.data ? 'INVALID' : 'ERROR') : 'PENDING_APPROVAL';
  let errorFile = null;
  if (errors.length && parsed.data) {
    try { errorFile = workbooks.errorWorkbook(imp.file, errors); } catch { errorFile = null; }
  }
  const summary = { rows: parsed.counts, creates: errors.length ? null : run.created };
  const { rows: [out] } = await c.query(
    `UPDATE data_imports SET status = $2, as_of = $3, summary = $4, errors = $5, warnings = $6, error_file = $7, pending = $8,
       preview = $9, progress = 100, progress_at = now(), finished_at = now()
     WHERE id = $1 RETURNING ${PUBLIC}`,
    [id, status, parsed.asOf, JSON.stringify(summary), JSON.stringify(errors.slice(0, 5000)), JSON.stringify(warnings), errorFile,
      status === 'PENDING_APPROVAL' ? JSON.stringify({ asOf: parsed.asOf, data: parsed.data, layout: parsed.layout }) : null,
      status === 'PENDING_APPROVAL' ? JSON.stringify(preview) : null]);
  await recordAudit(c, { actor: imp.created_by, action: 'DATA_IMPORT_VALIDATED', entity: 'data_import', entityId: id, after: JSON.stringify({ status, errors: errors.length }) });
  return out;
}

/** Upload and validate in one transaction (the CLI, and callers that wait). */
async function upload(c, { buffer, fileName }, { createdBy, user, today }) {
  const imp = await submit(c, { buffer, fileName }, { createdBy });
  return validate(c, imp.id, { user, today });
}

async function lockImport(c, id) {
  const { rows: [imp] } = await c.query('SELECT * FROM data_imports WHERE id::text = $1 FOR UPDATE', [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  return imp;
}

/**
 * Approve: run it again and commit, all or nothing. Under the four-eyes rule
 * (lending controls, two_man_rule) the person who uploaded it may not
 * approve it. If anything fails now (someone opened member M000123 since the
 * upload), nothing is created and the import is FAILED with the reasons,
 * returned as { failed: true, errors, import }.
 */
async function approve(c, id, { createdBy, user, note = null }) {
  const imp = await lockImport(c, id);
  if (imp.status !== 'PENDING_APPROVAL') throw err(`IMPORT_IS_${imp.status}`, 409);
  const { rows: [ctl] } = await c.query('SELECT two_man_rule FROM lending_controls LIMIT 1');
  if (ctl && ctl.two_man_rule && imp.created_by === createdBy) throw err('FOUR_EYES: the person who uploaded an import may not approve it', 409);
  await c.query('SAVEPOINT import_approve');
  const run = await execute.execute(c, imp.pending, { importId: imp.id, createdBy, user });
  if (run.errors.length) {
    await c.query('ROLLBACK TO SAVEPOINT import_approve');
    await c.query(
      `UPDATE data_imports SET status = 'FAILED', errors = $2, error_file = $3, decided_by = $4, decided_at = now(), decision_note = $5
       WHERE id = $1`,
      [imp.id, JSON.stringify(run.errors), (() => { try { return workbooks.errorWorkbook(imp.file, run.errors); } catch { return null; } })(), createdBy, note]);
    await recordAudit(c, { actor: createdBy, action: 'DATA_IMPORT_FAILED', entity: 'data_import', entityId: imp.id, after: JSON.stringify({ errors: run.errors.length }) });
    // Returned, not thrown: the FAILED record must be committed, the data not.
    return { failed: true, errors: run.errors, import: await get(c, imp.id) };
  }
  const { rows: [out] } = await c.query(
    `UPDATE data_imports SET status = 'APPROVED', summary = summary || jsonb_build_object('created', $2::jsonb), warnings = $3,
       entry_id = $4, pending = NULL, decided_by = $5, decided_at = now(), decision_note = $6
     WHERE id = $1 RETURNING ${PUBLIC}`,
    [imp.id, JSON.stringify(run.created), JSON.stringify(run.warnings), run.entryId, createdBy, note]);
  await recordAudit(c, { actor: createdBy, action: 'DATA_IMPORT_APPROVED', entity: 'data_import', entityId: imp.id, after: JSON.stringify(run.created) });
  return out;
}

async function reject(c, id, { createdBy, note = null }) {
  const imp = await lockImport(c, id);
  if (!['PENDING_APPROVAL', 'INVALID'].includes(imp.status)) throw err(`IMPORT_IS_${imp.status}`, 409);
  const { rows: [out] } = await c.query(
    `UPDATE data_imports SET status = 'REJECTED', pending = NULL, preview = NULL, decided_by = $2, decided_at = now(), decision_note = $3
     WHERE id = $1 RETURNING ${PUBLIC}`, [imp.id, createdBy, note]);
  await recordAudit(c, { actor: createdBy, action: 'DATA_IMPORT_REJECTED', entity: 'data_import', entityId: imp.id, after: JSON.stringify({ note }) });
  return out;
}

/** A run that stopped moving (the process went away) is not left IN_PROGRESS for ever. */
async function markStale(c) {
  await c.query(
    `UPDATE data_imports SET status = 'ERROR', finished_at = now(),
       errors = '[{"sheet":null,"row":null,"column":null,"message":"The validation run was interrupted; upload the file again"}]'
     WHERE status IN ('QUEUED', 'IN_PROGRESS') AND COALESCE(progress_at, created_at) < now() - make_interval(mins => $1)`, [STALE_MINUTES]);
}

async function list(c, { limit = 50 } = {}) {
  const { rows } = await c.query(`SELECT ${PUBLIC} FROM data_imports ORDER BY created_at DESC LIMIT $1`, [Math.min(200, Number(limit) || 50)]);
  return rows;
}

async function get(c, id) {
  const { rows: [imp] } = await c.query(`SELECT ${PUBLIC} FROM data_imports WHERE id::text = $1`, [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  return imp;
}

/**
 * The preview, one kind of record at a time and paged: what approval would
 * create, as it will be (the reference platform shows the draft data in its screens; here
 * nothing exists before approval, so the validation run keeps a copy).
 */
async function previewOf(c, id, { kind = null, offset = 0, limit = 50 } = {}) {
  const { rows: [imp] } = await c.query('SELECT status, preview FROM data_imports WHERE id::text = $1', [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  if (!imp.preview) throw err(`NO_PREVIEW: the import is ${imp.status}`, 409);
  const kinds = Object.fromEntries(Object.entries(imp.preview).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
  if (!kind) return { kinds };
  if (!(kind in imp.preview)) throw err(`UNKNOWN_KIND: ${Object.keys(imp.preview).join(', ')}`, 404);
  const all = imp.preview[kind] || [];
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(500, Math.max(1, Number(limit) || 50));
  return { kind, total: all.length, offset: off, limit: lim, items: all.slice(off, off + lim) };
}

async function fileOf(c, id, which) {
  const col = which === 'errors' ? 'error_file' : 'file';
  const { rows: [imp] } = await c.query(`SELECT file_name, ${col} AS data FROM data_imports WHERE id::text = $1`, [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  if (!imp.data) throw err('NO_ERROR_FILE', 404);
  return { fileName: which === 'errors' ? imp.file_name.replace(/(\.xlsx)?$/i, '-errors.xlsx') : imp.file_name, data: imp.data };
}

/**
 * The import in the reference platform's terms (GET /data/import/{importKey}): the job's
 * state, the event to approve or reject once validation has passed, and the
 * errors with the sheet, row and column (name and position).
 */
function apiStatus(imp) {
  const running = ['QUEUED', 'IN_PROGRESS'].includes(imp.status);
  const state = running ? imp.status : imp.status === 'ERROR' ? 'ERROR' : 'COMPLETE';
  return {
    importKey: imp.id,
    state,
    progress: imp.progress,
    eventKey: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'FAILED'].includes(imp.status) ? imp.id : null,
    importState: imp.import_state,
    errors: (imp.errors || []).map((x) => ({
      sheet: x.sheet, row: x.row, column: x.column || x.index !== undefined ? { name: x.column || null, index: x.index ?? null } : null, errorMessage: x.message,
    })),
  };
}

Object.assign(module.exports, {
  PUBLIC, STALE_MINUTES, submit, validate, upload, lockImport, approve, reject, markStale, list, get, previewOf, fileOf, apiStatus,
});
