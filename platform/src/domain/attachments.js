'use strict';

const crypto = require('crypto');
const acct = require('./accounting');
const { err } = acct;

/**
 * Files kept on a loan account, after Mambu's "Loan Account Attachments":
 * scans of application documents, signed forms, loan agreements. Each has a
 * title and a description that may be edited, may be previewed, downloaded
 * or deleted, and every upload, edit and deletion is in the audit log.
 *
 * Mambu's rules for what may be uploaded:
 *   - images: JPEG, PNG, GIF, BMP, TIFF; documents: PDF, Office and
 *     OpenDocument files, text, CSV, e-mail, HTML, ZIP and the rest of its
 *     list; never XHTML, JS, JSP, PHP or SWF
 *   - a file name with exactly one extension and no other period, none of
 *     / > < | : & ? * [ ] # ` in it
 *   - not empty; a PDF must be a PDF, and an encrypted one is refused
 *     because it cannot be scanned (Mambu refuses obfuscated PDFs)
 * Files are kept in the tenant's database, up to 10 MB each.
 *
 * Depends on accounting only.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = {
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff',
  pdf: 'application/pdf', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', properties: 'text/plain',
  doc: 'application/msword', dot: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  docm: 'application/vnd.ms-word.document.macroEnabled.12', dotm: 'application/vnd.ms-word.template.macroEnabled.12',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ott: 'application/vnd.oasis.opendocument.text-template', fodt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  msg: 'application/vnd.ms-outlook', eml: 'message/rfc822', emlx: 'message/rfc822', zip: 'application/zip', rtf: 'application/rtf',
  html: 'text/html', mht: 'message/rfc822', mhtml: 'message/rfc822', xps: 'application/vnd.ms-xpsdocument',
  numbers: 'application/vnd.apple.numbers', key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages',
  yaml: 'application/yaml', json: 'application/json', jasper: 'application/octet-stream', jrxml: 'application/xml',
};
const FORBIDDEN = ['xhtml', 'js', 'jsp', 'php', 'swf'];
const BAD_CHARS = /[/><|:&?*[\]#`\\]/;
// Shown in the browser rather than downloaded.
const PREVIEWABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'application/pdf', 'text/plain', 'text/csv']);

/** Check a file name and contents against Mambu's rules; returns its type. */
function validate(fileName, data) {
  const name = String(fileName || '').trim();
  if (!name) throw err('A_FILE_NAME_IS_REQUIRED', 400);
  if (BAD_CHARS.test(name)) throw err('FILE_NAME_HAS_A_CHARACTER_NOT_ALLOWED: / > < | : & ? * [ ] # `', 400);
  const parts = name.split('.');
  if (parts.length < 2 || !parts[parts.length - 1]) throw err('FILE_NAME_NEEDS_AN_EXTENSION', 400);
  if (parts.length > 2) throw err('FILE_NAME_HAS_MORE_THAN_ONE_PERIOD: one extension only', 400);
  if (!parts[0]) throw err('FILE_NAME_NEEDS_A_NAME_BEFORE_ITS_EXTENSION', 400);
  const ext = parts[1].toLowerCase();
  if (FORBIDDEN.includes(ext)) throw err(`FILE_TYPE_NOT_ALLOWED: ${ext}`, 400);
  const type = TYPES[ext];
  if (!type) throw err(`FILE_TYPE_NOT_ALLOWED: ${ext}`, 400);
  if (!Buffer.isBuffer(data) || !data.length) throw err('THE_FILE_IS_EMPTY', 400);
  if (data.length > MAX_BYTES) throw err(`THE_FILE_IS_LARGER_THAN_${MAX_BYTES / 1024 / 1024}_MB`, 413);
  if (ext === 'pdf') {
    if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw err('NOT_A_PDF: the file does not start as a PDF does', 400);
    if (data.includes(Buffer.from('/Encrypt'))) throw err('ENCRYPTED_PDF_REFUSED: it cannot be scanned for malware', 400);
  }
  return type;
}

const view = (r) => ({
  id: r.id, loanId: r.loan_id, title: r.title, description: r.description, fileName: r.file_name, contentType: r.content_type,
  size: r.size, sha256: r.sha256, createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
  previewable: PREVIEWABLE.has(r.content_type),
});

async function loanOf(c, loanId) {
  const { rows: [l] } = await c.query('SELECT id, account_no FROM loan_accounts WHERE id::text = $1 OR account_no = $1', [String(loanId)]);
  if (!l) throw err('LOAN_NOT_FOUND', 404);
  return l;
}

async function upload(c, loanId, { title = null, description = null, fileName, data, createdBy } = {}) {
  const l = await loanOf(c, loanId);
  const buf = Buffer.isBuffer(data) ? data : (typeof data === 'string' ? Buffer.from(data, 'base64') : null);
  const type = validate(fileName, buf);
  const name = String(fileName).trim();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const { rows: [r] } = await c.query(
    `INSERT INTO loan_attachments (loan_id, title, description, file_name, content_type, size, sha256, data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [l.id, String(title || name.split('.')[0]).slice(0, 200), description, name, type, buf.length, sha, buf, createdBy || 'SYSTEM']);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'LOAN_ATTACHMENT_UPLOADED','loan_attachment',$2,$3)`,
    [createdBy || 'SYSTEM', r.id, JSON.stringify({ loan: l.account_no, fileName: name, size: buf.length, sha256: sha })]);
  return view(r);
}

async function list(c, loanId) {
  const l = await loanOf(c, loanId);
  const { rows } = await c.query(
    `SELECT id, loan_id, title, description, file_name, content_type, size, sha256, created_by, created_at, updated_by, updated_at
     FROM loan_attachments WHERE loan_id = $1 ORDER BY created_at, id`, [l.id]);
  return rows.map(view);
}

/** One file with its contents, for download or preview. */
async function file(c, loanId, attachmentId) {
  const l = await loanOf(c, loanId);
  const { rows: [r] } = await c.query('SELECT * FROM loan_attachments WHERE id = $1 AND loan_id = $2', [attachmentId, l.id]);
  if (!r) throw err('ATTACHMENT_NOT_FOUND', 404);
  return { ...view(r), data: r.data };
}

async function update(c, loanId, attachmentId, { title, description, createdBy } = {}) {
  const l = await loanOf(c, loanId);
  const { rows: [r] } = await c.query('SELECT * FROM loan_attachments WHERE id = $1 AND loan_id = $2 FOR UPDATE', [attachmentId, l.id]);
  if (!r) throw err('ATTACHMENT_NOT_FOUND', 404);
  if (title === undefined && description === undefined) throw err('NO_UPDATABLE_FIELDS: title, description', 400);
  if (title !== undefined && !String(title || '').trim()) throw err('A_TITLE_IS_REQUIRED', 400);
  const { rows: [out] } = await c.query(
    `UPDATE loan_attachments SET title = COALESCE($2, title), description = CASE WHEN $4 THEN $3 ELSE description END,
       updated_by = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [r.id, title === undefined ? null : String(title).slice(0, 200), description ?? null, description !== undefined, createdBy || 'SYSTEM']);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'LOAN_ATTACHMENT_EDITED','loan_attachment',$2,$3,$4)`,
    [createdBy || 'SYSTEM', r.id, JSON.stringify({ title: r.title, description: r.description }), JSON.stringify({ title: out.title, description: out.description })]);
  return view(out);
}

async function remove(c, loanId, attachmentId, { createdBy } = {}) {
  const l = await loanOf(c, loanId);
  const { rows: [r] } = await c.query(
    'DELETE FROM loan_attachments WHERE id = $1 AND loan_id = $2 RETURNING id, file_name, size, sha256', [attachmentId, l.id]);
  if (!r) throw err('ATTACHMENT_NOT_FOUND', 404);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'LOAN_ATTACHMENT_DELETED','loan_attachment',$2,$3)`,
    [createdBy || 'SYSTEM', r.id, JSON.stringify({ loan: l.account_no, fileName: r.file_name, size: r.size, sha256: r.sha256 })]);
  return { deleted: r.id, fileName: r.file_name };
}

module.exports = { upload, list, file, update, remove, validate, TYPES, FORBIDDEN, MAX_BYTES, PREVIEWABLE };
