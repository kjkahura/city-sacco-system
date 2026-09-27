'use strict';

const acct = require('./accounting');
const { err } = acct;

/**
 * ID templates, after the reference platform's page of that name: the kinds of
 * identification document the SACCO takes from members (national ID,
 * passport, driving licence), each with an issuing authority and an input
 * mask for the document number (# a digit, @ a letter, $ either; any other
 * character must appear as written). A mandatory template must be supplied
 * when a member is created; a template may allow an attachment (a scan of
 * the document). The organization may also allow "Other" documents entered
 * without a template. A template in use cannot be deleted; editing one can
 * leave older documents out of step, and they are brought in line the next
 * time they are edited.
 */

// Sent as base64 in JSON, inside the 1 MB request limit.
const MAX_ATTACHMENT = 700 * 1024;
const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];

function maskMatches(mask, v) {
  const s = String(v);
  if (s.length !== mask.length) return false;
  for (let k = 0; k < mask.length; k += 1) {
    const m = mask[k]; const ch = s[k];
    if (m === '#' && !/[0-9]/.test(ch)) return false;
    if (m === '@' && !/[A-Za-z]/.test(ch)) return false;
    if (m === '$' && !/[A-Za-z0-9]/.test(ch)) return false;
    if (!'#@$'.includes(m) && m !== ch) return false;
  }
  return true;
}

async function audit(c, actor, action, entity, id, before, after) {
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor || 'SYSTEM', action, entity, id, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

async function list(c) {
  const { rows } = await c.query(
    `SELECT t.*, (SELECT count(*)::int FROM member_identifications m WHERE m.template_id = t.id) AS in_use
     FROM id_templates t ORDER BY t.id_type, t.id`);
  const { rows: [s] } = await c.query('SELECT allow_other_id_templates FROM organization_settings WHERE id = 1');
  return { templates: rows, allowOther: s.allow_other_id_templates };
}

function shape(body, creating) {
  const out = {};
  if (creating) {
    const id = body.id ? String(body.id) : `T${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    if (!/^[A-Za-z0-9]{1,32}$/.test(id)) throw err('TEMPLATE_ID_IS_LETTERS_AND_DIGITS_WITHOUT_SPACES', 400);
    out.id = id;
  }
  for (const [k, col, label] of [['idType', 'id_type', 'ID_TYPE'], ['issuingAuthority', 'issuing_authority', 'ISSUING_AUTHORITY'], ['mask', 'mask', 'ID_DOCUMENT_TEMPLATE']]) {
    if (body[k] === undefined && !creating) continue;
    const v = String(body[k] ?? '').trim();
    if (!v) throw err(`${label}_REQUIRED`, 400);
    out[col] = v.slice(0, 255);
  }
  if (out.mask && !/[#@$]/.test(out.mask)) throw err('THE_TEMPLATE_NEEDS_AT_LEAST_ONE_OF_#_@_$', 400);
  if (body.mandatory !== undefined) out.mandatory = body.mandatory === true;
  if (body.allowAttachments !== undefined) out.allow_attachments = body.allowAttachments === true;
  return out;
}

async function create(c, body = {}, { createdBy } = {}) {
  const cols = { ...shape(body, true), created_by: createdBy || 'SYSTEM' };
  const keys = Object.keys(cols);
  const { rows: [t] } = await c.query(
    `INSERT INTO id_templates (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING RETURNING *`,
    keys.map((k) => cols[k]));
  if (!t) throw err(`ID_TEMPLATE_EXISTS: ${cols.id}`, 409);
  await audit(c, createdBy, 'ID_TEMPLATE_CREATED', 'id_template', t.id, null, t);
  return t;
}

async function find(c, id) {
  const { rows: [t] } = await c.query('SELECT * FROM id_templates WHERE id = $1', [id]);
  if (!t) throw err(`UNKNOWN_ID_TEMPLATE: ${id}`, 404);
  return t;
}

async function update(c, id, body = {}, { createdBy } = {}) {
  const before = await find(c, id);
  const cols = shape(body, false);
  const keys = Object.keys(cols);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const { rows: [after] } = await c.query(`UPDATE id_templates SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [before.id, ...keys.map((k) => cols[k])]);
  const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM member_identifications WHERE template_id = $1', [before.id]);
  const off = after.mask !== before.mask ? await c.query('SELECT document_id FROM member_identifications WHERE template_id = $1', [before.id]) : { rows: [] };
  await audit(c, createdBy, 'ID_TEMPLATE_CHANGED', 'id_template', before.id, before, after);
  return { ...after, inUse: n.n, documentsNoLongerMatching: off.rows.filter((r) => !maskMatches(after.mask, r.document_id)).length };
}

async function remove(c, id, { createdBy } = {}) {
  const t = await find(c, id);
  const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM member_identifications WHERE template_id = $1', [t.id]);
  if (n.n > 0) throw err(`ID_TEMPLATE_IN_USE: ${n.n} document(s)`, 409);
  await c.query('DELETE FROM id_templates WHERE id = $1', [t.id]);
  await audit(c, createdBy, 'ID_TEMPLATE_DELETED', 'id_template', t.id, t, null);
  return { deleted: t.id };
}

async function setAllowOther(c, allow, { createdBy } = {}) {
  await c.query('UPDATE organization_settings SET allow_other_id_templates = $1, updated_at = now(), updated_by = $2 WHERE id = 1',
    [allow === true || allow === 'true', createdBy || 'SYSTEM']);
  await audit(c, createdBy, 'OTHER_ID_TEMPLATES_SET', 'organization', null, null, { allowOther: allow === true || allow === 'true' });
  return list(c);
}

// --------------------------------------------------------------------------
// A member's identification documents
// --------------------------------------------------------------------------

const publicDoc = ({ attachment, ...d }) => ({ ...d, hasAttachment: Boolean(attachment) });

/**
 * Check a document against its template (or as "Other" when allowed) and
 * return the columns to store. `templateId` null or 'OTHER' is an Other
 * document, which needs its own idType.
 */
async function shapeDocument(c, d) {
  const out = { document_id: String(d.documentId || '').trim() };
  if (!out.document_id) throw err('DOCUMENT_ID_REQUIRED', 400);
  if (d.validUntil) {
    const v = String(d.validUntil).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw err('VALID_UNTIL_IS_A_DATE', 400);
    out.valid_until = v;
  }
  if (!d.templateId || d.templateId === 'OTHER') {
    const { rows: [s] } = await c.query('SELECT allow_other_id_templates FROM organization_settings WHERE id = 1');
    if (!s.allow_other_id_templates) throw err('OTHER_ID_DOCUMENTS_ARE_NOT_ALLOWED: choose a template', 400);
    if (!d.idType) throw err('AN_OTHER_DOCUMENT_NEEDS_ITS_ID_TYPE', 400);
    Object.assign(out, { template_id: null, id_type: String(d.idType), issuing_authority: d.issuingAuthority || null });
  } else {
    const t = await find(c, d.templateId);
    if (!maskMatches(t.mask, out.document_id)) throw err(`DOCUMENT_ID_DOES_NOT_MATCH_THE_TEMPLATE: ${t.id_type} is ${t.mask}`, 400);
    Object.assign(out, { template_id: t.id, id_type: t.id_type, issuing_authority: t.issuing_authority });
    if (d.attachment && !t.allow_attachments) throw err(`TEMPLATE_${t.id}_DOES_NOT_TAKE_ATTACHMENTS`, 400);
  }
  if (d.attachment) {
    const bytes = Buffer.from(String(d.attachment.data || ''), 'base64');
    if (!bytes.length) throw err('ATTACHMENT_IS_EMPTY', 400);
    if (bytes.length > MAX_ATTACHMENT) throw err(`ATTACHMENT_TOO_LARGE: at most ${MAX_ATTACHMENT} bytes`, 413);
    if (!ATTACHMENT_TYPES.includes(d.attachment.type)) throw err(`ATTACHMENT_TYPE_NOT_ALLOWED: ${ATTACHMENT_TYPES.join(', ')}`, 415);
    Object.assign(out, { attachment: bytes, attachment_name: String(d.attachment.name || 'document').slice(0, 200), attachment_type: d.attachment.type });
  }
  return out;
}

async function addDocument(c, memberId, d = {}, { createdBy } = {}) {
  const { rows: [m] } = await c.query('SELECT id FROM members WHERE id::text = $1 OR member_no = $1', [String(memberId)]);
  if (!m) throw err('MEMBER_NOT_FOUND', 404);
  const cols = { ...(await shapeDocument(c, d)), member_id: m.id, created_by: createdBy || 'SYSTEM' };
  const keys = Object.keys(cols);
  const { rows: [doc] } = await c.query(
    `INSERT INTO member_identifications (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k]));
  await audit(c, createdBy, 'MEMBER_ID_DOCUMENT_ADDED', 'member', m.id, null, publicDoc(doc));
  return publicDoc(doc);
}

async function documents(c, memberId) {
  const { rows } = await c.query(
    `SELECT d.* FROM member_identifications d JOIN members m ON m.id = d.member_id
     WHERE m.id::text = $1 OR m.member_no = $1 ORDER BY d.created_at`, [String(memberId)]);
  return rows.map(publicDoc);
}

async function removeDocument(c, memberId, docId, { createdBy } = {}) {
  const { rows: [d] } = await c.query(
    `SELECT d.* FROM member_identifications d JOIN members m ON m.id = d.member_id
     WHERE d.id::text = $2 AND (m.id::text = $1 OR m.member_no = $1)`, [String(memberId), String(docId)]);
  if (!d) throw err('ID_DOCUMENT_NOT_FOUND', 404);
  if (d.template_id) {
    const t = await find(c, d.template_id);
    const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM member_identifications WHERE member_id = $1 AND template_id = $2', [d.member_id, t.id]);
    if (t.mandatory && n.n <= 1) throw err(`ID_DOCUMENT_IS_MANDATORY: ${t.id_type}`, 409);
  }
  await c.query('DELETE FROM member_identifications WHERE id = $1', [d.id]);
  await audit(c, createdBy, 'MEMBER_ID_DOCUMENT_REMOVED', 'member', d.member_id, publicDoc(d), null);
  return { deleted: d.id };
}

async function attachment(c, memberId, docId) {
  const { rows: [d] } = await c.query(
    `SELECT d.attachment, d.attachment_name, d.attachment_type FROM member_identifications d JOIN members m ON m.id = d.member_id
     WHERE d.id::text = $2 AND (m.id::text = $1 OR m.member_no = $1)`, [String(memberId), String(docId)]);
  if (!d || !d.attachment) throw err('NO_ATTACHMENT', 404);
  return d;
}

/**
 * The documents a new member arrives with: each checked, and every
 * mandatory template covered.
 */
async function forNewMember(c, docs = []) {
  if (!Array.isArray(docs)) throw err('IDENTIFICATION_DOCUMENTS_IS_A_LIST', 400);
  const shaped = [];
  for (const d of docs) shaped.push(await shapeDocument(c, d));
  const { rows: mandatory } = await c.query('SELECT id, id_type FROM id_templates WHERE mandatory');
  const missing = mandatory.filter((t) => !shaped.some((d) => d.template_id === t.id));
  if (missing.length) throw err(`MANDATORY_ID_DOCUMENTS_MISSING: ${missing.map((t) => t.id_type).join(', ')}`, 400);
  return shaped;
}

async function storeForMember(c, memberId, shaped, { createdBy } = {}) {
  for (const cols0 of shaped) {
    const cols = { ...cols0, member_id: memberId, created_by: createdBy || 'SYSTEM' };
    const keys = Object.keys(cols);
    await c.query(`INSERT INTO member_identifications (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => cols[k]));
  }
}

module.exports = {
  list, create, update, remove, setAllowOther, addDocument, documents, removeDocument, attachment, forNewMember, storeForMember, maskMatches,
};
