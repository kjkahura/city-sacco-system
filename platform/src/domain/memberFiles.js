'use strict';

const acct = require('./accounting');
const { err } = acct;

/**
 * A member's picture and signature (the reference platform's profile picture and client
 * signature), and the files on an identification document.
 *
 * Both are uploaded as the raw request body and checked by their first
 * bytes, not by what the request claims: PNG, JPEG or GIF for a picture or
 * signature; PNG, JPEG or PDF for a document file. The reference platform's limits: 50 MB a
 * file, and up to five files on one identification document (the single
 * scan an ID document could carry before counts as one of them). A
 * blacklisted member's picture and signature may still change (the reference platform);
 * an anonymized member's may not, and anonymizing removes them.
 *
 * Expiry: an identification document past its valid-until date is
 * flagged (expired, and expiresInDays when it is still valid), never
 * refused; nothing is blocked by it.
 */

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 5;

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

function checkFile(buf, allowed) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw err('THE_FILE_IS_EMPTY: send it as the request body', 400);
  if (buf.length > MAX_BYTES) throw err(`FILE_TOO_LARGE: at most ${MAX_BYTES} bytes`, 413);
  const type = sniff(buf);
  if (!type || !allowed.includes(type)) throw err(`FILE_TYPE_NOT_ALLOWED: ${allowed.join(', ')}`, 415);
  return type;
}

const safeName = (v, fallback) => String(v || fallback).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 200) || fallback;

async function audit(c, actor, action, memberId, after) {
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,$2,'member',$3,$4)`,
    [actor || 'SYSTEM', action, String(memberId), after ? JSON.stringify(after) : null]);
}

async function memberOf(c, ref) {
  const { rows: [m] } = await c.query('SELECT id, member_no, holder_type, anonymized_at FROM members WHERE id::text = $1 OR member_no = $1', [String(ref)]);
  if (!m) throw err('MEMBER_NOT_FOUND', 404);
  return m;
}

// --------------------------------------------------------------------------
// Picture and signature
// --------------------------------------------------------------------------

const KINDS = { picture: 'PICTURE', signature: 'SIGNATURE' };

function kindOf(k) {
  const kind = KINDS[String(k || '').toLowerCase()];
  if (!kind) throw err('KIND_IS_PICTURE_OR_SIGNATURE', 400);
  return kind;
}

async function putMedia(c, ref, k, buf, { fileName = null, actor } = {}) {
  const kind = kindOf(k);
  const m = await memberOf(c, ref);
  if (m.holder_type === 'GROUP') throw err('A_GROUP_HAS_NO_PICTURE_OR_SIGNATURE', 400);
  if (m.anonymized_at) throw err('THE_MEMBER_IS_ANONYMIZED', 409);
  const type = checkFile(buf, ['image/png', 'image/jpeg', 'image/gif']);
  await c.query(
    `INSERT INTO member_media (member_id, kind, content, content_type, file_name, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (member_id, kind) DO UPDATE SET content = EXCLUDED.content, content_type = EXCLUDED.content_type, file_name = EXCLUDED.file_name,
       size_bytes = EXCLUDED.size_bytes, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
    [m.id, kind, buf, type, safeName(fileName, kind.toLowerCase()), buf.length, actor || 'SYSTEM']);
  await audit(c, actor, `MEMBER_${kind}_SET`, m.id, { contentType: type, sizeBytes: buf.length });
  return { kind, contentType: type, sizeBytes: buf.length };
}

async function getMedia(c, ref, k) {
  const kind = kindOf(k);
  const m = await memberOf(c, ref);
  const { rows: [x] } = await c.query('SELECT content, content_type, file_name, size_bytes, uploaded_at FROM member_media WHERE member_id = $1 AND kind = $2', [m.id, kind]);
  if (!x) throw err(`NO_${kind}`, 404);
  return x;
}

async function removeMedia(c, ref, k, { actor } = {}) {
  const kind = kindOf(k);
  const m = await memberOf(c, ref);
  const { rowCount } = await c.query('DELETE FROM member_media WHERE member_id = $1 AND kind = $2', [m.id, kind]);
  if (!rowCount) throw err(`NO_${kind}`, 404);
  await audit(c, actor, `MEMBER_${kind}_REMOVED`, m.id, null);
  return { deleted: kind };
}

/** Which of the picture and signature a member has (for the member's page). */
async function mediaOf(c, memberId) {
  const { rows } = await c.query('SELECT kind, content_type, size_bytes, uploaded_at FROM member_media WHERE member_id = $1', [memberId]);
  return Object.fromEntries(rows.map((r) => [r.kind.toLowerCase(), { contentType: r.content_type, sizeBytes: r.size_bytes, uploadedAt: r.uploaded_at }]));
}

// --------------------------------------------------------------------------
// Files on an identification document
// --------------------------------------------------------------------------

async function documentOf(c, ref, docId) {
  const m = await memberOf(c, ref);
  const { rows: [d] } = await c.query('SELECT * FROM member_identifications WHERE id::text = $1 AND member_id = $2', [String(docId), m.id]);
  if (!d) throw err('ID_DOCUMENT_NOT_FOUND', 404);
  return { m, d };
}

async function listFiles(c, ref, docId) {
  const { d } = await documentOf(c, ref, docId);
  const { rows } = await c.query(
    'SELECT id, file_name, content_type, size_bytes, created_by, created_at FROM member_identification_files WHERE identification_id = $1 ORDER BY created_at', [d.id]);
  const out = rows.map((r) => ({ id: r.id, fileName: r.file_name, contentType: r.content_type, sizeBytes: r.size_bytes, createdBy: r.created_by, createdAt: r.created_at }));
  if (d.attachment) out.unshift({ id: 'original', fileName: d.attachment_name, contentType: d.attachment_type, sizeBytes: d.attachment.length, createdBy: d.created_by, createdAt: d.created_at });
  return out;
}

async function addFile(c, ref, docId, buf, { fileName = null, actor } = {}) {
  const { m, d } = await documentOf(c, ref, docId);
  if (m.anonymized_at) throw err('THE_MEMBER_IS_ANONYMIZED', 409);
  if (d.template_id) {
    const { rows: [t] } = await c.query('SELECT allow_attachments, id_type FROM id_templates WHERE id = $1', [d.template_id]);
    if (t && !t.allow_attachments) throw err(`TEMPLATE_${d.template_id}_DOES_NOT_TAKE_ATTACHMENTS`, 400);
  }
  const type = checkFile(buf, ['image/png', 'image/jpeg', 'application/pdf']);
  const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM member_identification_files WHERE identification_id = $1', [d.id]);
  if (n.n + (d.attachment ? 1 : 0) >= MAX_FILES) throw err(`AT_MOST_${MAX_FILES}_FILES_ON_A_DOCUMENT`, 409);
  const { rows: [f] } = await c.query(
    `INSERT INTO member_identification_files (identification_id, file_name, content_type, content, size_bytes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, file_name, content_type, size_bytes, created_at`,
    [d.id, safeName(fileName, 'document'), type, buf, buf.length, actor || 'SYSTEM']);
  await audit(c, actor, 'MEMBER_ID_DOCUMENT_FILE_ADDED', m.id, { documentId: d.id, file: f.file_name, sizeBytes: f.size_bytes });
  return { id: f.id, fileName: f.file_name, contentType: f.content_type, sizeBytes: f.size_bytes, createdAt: f.created_at };
}

async function getFile(c, ref, docId, fileId) {
  const { d } = await documentOf(c, ref, docId);
  if (fileId === 'original') {
    if (!d.attachment) throw err('NO_ATTACHMENT', 404);
    return { content: d.attachment, content_type: d.attachment_type, file_name: d.attachment_name };
  }
  const { rows: [f] } = await c.query('SELECT content, content_type, file_name FROM member_identification_files WHERE id::text = $1 AND identification_id = $2', [String(fileId), d.id]);
  if (!f) throw err('FILE_NOT_FOUND', 404);
  return f;
}

async function removeFile(c, ref, docId, fileId, { actor } = {}) {
  const { m, d } = await documentOf(c, ref, docId);
  if (fileId === 'original') {
    if (!d.attachment) throw err('NO_ATTACHMENT', 404);
    await c.query('UPDATE member_identifications SET attachment = NULL, attachment_name = NULL, attachment_type = NULL WHERE id = $1', [d.id]);
  } else {
    const { rowCount } = await c.query('DELETE FROM member_identification_files WHERE id::text = $1 AND identification_id = $2', [String(fileId), d.id]);
    if (!rowCount) throw err('FILE_NOT_FOUND', 404);
  }
  await audit(c, actor, 'MEMBER_ID_DOCUMENT_FILE_REMOVED', m.id, { documentId: d.id, fileId });
  return { deleted: fileId };
}

/** The expiry flags on a list of documents, as of the organization's today. */
function withExpiry(docs, today) {
  const t = Date.parse(`${today}T00:00:00Z`);
  return docs.map((d) => {
    const v = d.valid_until ? String(d.valid_until).slice(0, 10) : null;
    if (!v) return { ...d, expired: false, expiresInDays: null };
    const days = Math.round((Date.parse(`${v}T00:00:00Z`) - t) / 86400000);
    return { ...d, expired: days < 0, expiresInDays: days < 0 ? null : days };
  });
}

module.exports = { MAX_BYTES, MAX_FILES, sniff, putMedia, getMedia, removeMedia, mediaOf, listFiles, addFile, getFile, removeFile, withExpiry };
