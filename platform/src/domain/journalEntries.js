'use strict';

/**
 * Journal entries, after the reference platform's "Journal Entries" and its GL journal
 * entries API (/gljournalentries).
 *
 * Manual entries: a user posts balanced debits and credits to detail
 * accounts that allow manual entries, on a booking date (backdating allowed
 * to after the accounting closure and inside an open financial year, never
 * in the future), for a branch or none, with notes. Every line of the entry
 * carries one transaction ID. Lines in a branch other than the entry's are
 * squared through the inter-branch rules, as every other posting is; the
 * lines added show in the entry. Up to five files may be attached.
 *
 * Only a manual entry is reversed here, with notes. An automatic entry is
 * corrected by reversing the transaction that posted it.
 *
 * The journal reads as the reference platform's GLJournalEntry, one per line, with the
 * product and account of the transaction behind an automatic entry.
 *
 * Depends on accounting, chartOfAccounts and attachments.
 */

const crypto = require('crypto');
const acct = require('./accounting');
const COA = require('./chartOfAccounts');
const ATT = require('./attachments');
const SEARCH = require('../lib/searchCriteria');
const { orgToday } = require('../lib/orgDate');
const { recordAudit } = require('../lib/auditLog');

const { err, round2 } = acct;
const MAX_FILES = 5;
const TX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --------------------------------------------------------------------------
// Reading: one row per journal line
// --------------------------------------------------------------------------

const LINES_SQL = `
  SELECT l.id AS line_id, l.entry_id, l.gl_code, l.direction, l.amount, l.branch_id, l.member_id, l.line_no,
         e.booking_date, e.created_at, e.created_by, e.narration, e.source_type,
         e.reversal_of, e.branch_id AS entry_branch_id,
         COALESCE(e.transaction_id, t.reference) AS transaction_id,
         g.name AS gl_name, g.type AS gl_type,
         (g.usage = 'HEADER' OR EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_code = g.code)) AS gl_header,
         b.code AS branch_code,
         CASE WHEN t.loan_account_id IS NOT NULL THEN 'LOAN' WHEN t.savings_account_id IS NOT NULL THEN 'SAVINGS' END AS product_type,
         COALESCE(la.product_id, sa.product_id) AS product_key,
         COALESCE(la.account_no, sa.account_no) AS account_id,
         COALESCE(t.loan_account_id, t.savings_account_id)::text AS account_key,
         rv.id AS reversal_entry_id
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN gl_accounts g ON g.code = l.gl_code
    LEFT JOIN branches b ON b.id = l.branch_id
    LEFT JOIN LATERAL (SELECT t.reference, t.loan_account_id, t.savings_account_id FROM transactions t
                        WHERE t.entry_id = e.id ORDER BY t.created_at LIMIT 1) t ON true
    LEFT JOIN loan_accounts la ON la.id = t.loan_account_id
    LEFT JOIN savings_accounts sa ON sa.id = t.savings_account_id
    LEFT JOIN journal_entries rv ON rv.reversal_of = e.id`;

// The reference platform's field names for filtering and sorting, over LINES_SQL's columns (j).
const FIELDS = {
  encodedKey: { sql: 'j.line_id::text', type: 'text' },
  entryId: { sql: 'j.line_id', type: 'number' },
  journalEntryId: { sql: 'j.entry_id::text', type: 'text' },
  transactionId: { sql: 'j.transaction_id', type: 'text' },
  type: { sql: 'j.direction', type: 'text' },
  amount: { sql: 'j.amount', type: 'number' },
  bookingDate: { sql: 'j.booking_date', type: 'date' },
  creationDate: { sql: 'j.created_at', type: 'timestamp' },
  'glAccount.glCode': { sql: 'j.gl_code', type: 'text' },
  glAccountId: { sql: 'j.gl_code', type: 'text' },
  glAccountKey: { sql: 'j.gl_code', type: 'text' },
  'glAccount.type': { sql: 'j.gl_type', type: 'text' },
  'glAccount.name': { sql: 'j.gl_name', type: 'text' },
  assignedBranchKey: { sql: 'j.branch_id::text', type: 'text' },
  branchKey: { sql: 'j.branch_id::text', type: 'text' },
  branchId: { sql: 'j.branch_code', type: 'text' },
  productType: { sql: 'j.product_type', type: 'text' },
  productKey: { sql: 'j.product_key', type: 'text' },
  accountKey: { sql: 'j.account_key', type: 'text' },
  accountId: { sql: 'j.account_id', type: 'text' },
  userKey: { sql: 'j.created_by', type: 'text' },
  sourceType: { sql: 'j.source_type', type: 'text' },
  notes: { sql: 'j.narration', type: 'text' },
  reversalEntryKey: { sql: 'j.reversal_entry_id::text', type: 'text' },
};

/** The reference platform's GLJournalEntry, for one line. */
function shape(r) {
  return {
    encodedKey: String(r.line_id),
    entryId: Number(r.line_id),
    journalEntryId: r.entry_id,
    transactionId: r.transaction_id ?? null,
    type: r.direction,
    amount: round2(r.amount),
    glAccount: { encodedKey: r.gl_code, glCode: r.gl_code, name: r.gl_name, type: r.gl_type, usage: r.gl_header ? 'HEADER' : 'DETAIL' },
    bookingDate: r.booking_date,
    creationDate: r.created_at,
    assignedBranchKey: r.branch_id ?? null,
    branchId: r.branch_code ?? null,
    productType: r.product_type ?? null,
    productKey: r.product_key ?? null,
    accountKey: r.account_key ?? null,
    accountId: r.account_id ?? null,
    userKey: r.created_by ?? null,
    reversalEntryKey: r.reversal_entry_id ?? null,
    reversalOf: r.reversal_of ?? null,
    sourceType: r.source_type ?? null,
    notes: r.narration ?? null,
  };
}

/**
 * GET /gljournalentries (from, to, branchId, glAccountId) and
 * POST /gljournalentries:search (filterCriteria, sortingCriteria). A user
 * limited to some branches reads the lines of their branches.
 */
async function search(c, { body = {}, query = {}, offset = 0, limit = 50, branches = null } = {}) {
  const criteria = { filterCriteria: [...(body.filterCriteria || [])], sortingCriteria: body.sortingCriteria };
  const q = query || {};
  if (q.from) criteria.filterCriteria.push({ field: 'bookingDate', operator: 'AFTER_INCLUSIVE', value: String(q.from).slice(0, 10) });
  if (q.to) criteria.filterCriteria.push({ field: 'bookingDate', operator: 'BEFORE_INCLUSIVE', value: String(q.to).slice(0, 10) });
  if (q.glAccountId) criteria.filterCriteria.push({ field: 'glAccountId', operator: 'EQUALS_CASE_SENSITIVE', value: q.glAccountId });
  if (q.transactionId) criteria.filterCriteria.push({ field: 'transactionId', operator: 'EQUALS_CASE_SENSITIVE', value: q.transactionId });
  if (q.branchId) {
    const b = await acct.branchScope(c, q.branchId);
    criteria.filterCriteria.push(b.id === 'NONE' ? { field: 'assignedBranchKey', operator: 'EMPTY' } : { field: 'assignedBranchKey', operator: 'EQUALS', value: b.id });
  }
  const s = SEARCH.build(criteria, FIELDS, { customColumn: 'NULL::jsonb', today: await orgToday(c) });
  let where = s.where;
  if (Array.isArray(branches)) {
    s.params.push(branches);
    where = `(${where}) AND j.branch_id = ANY($${s.params.length}::uuid[])`;
  }
  const { rows } = await c.query(
    `SELECT j.*, count(*) OVER () AS total FROM (${LINES_SQL}) j
      WHERE ${where}
      ORDER BY ${s.order ? `${s.order}, ` : ''}j.booking_date DESC, j.created_at DESC, j.line_id
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, s.params);
  return { total: rows.length ? Number(rows[0].total) : 0, items: rows.map(shape) };
}

async function linesOf(c, entryId) {
  const { rows } = await c.query(`SELECT j.* FROM (${LINES_SQL}) j WHERE j.entry_id = $1 ORDER BY j.line_no`, [entryId]);
  return rows.map(shape);
}

/** An entry by its id, its transaction ID, or the entryId of one of its lines. */
async function findEntry(c, ref) {
  const v = String(ref ?? '');
  let q;
  if (UUID_RE.test(v)) q = c.query('SELECT * FROM journal_entries WHERE id = $1', [v]);
  else if (/^\d+$/.test(v)) q = c.query('SELECT e.* FROM journal_entries e WHERE e.transaction_id = $1 OR e.id = (SELECT entry_id FROM journal_lines WHERE id = $1::bigint) ORDER BY e.transaction_id = $1 DESC LIMIT 1', [v]);
  else q = c.query('SELECT * FROM journal_entries WHERE transaction_id = $1', [v]);
  const { rows: [e] } = await q;
  if (!e) throw err(`JOURNAL_ENTRY_NOT_FOUND: ${ref}`, 404);
  return e;
}

async function get(c, ref) {
  const e = await findEntry(c, ref);
  const lines = await linesOf(c, e.id);
  const { rows: files } = await c.query('SELECT count(*)::int AS n FROM journal_entry_attachments WHERE entry_id = $1', [e.id]);
  return {
    journalEntryId: e.id, transactionId: lines[0]?.transactionId ?? e.transaction_id, bookingDate: lines[0]?.bookingDate,
    creationDate: e.created_at, sourceType: e.source_type, notes: e.narration, userKey: e.created_by,
    branchId: e.branch_id, reversalOf: e.reversal_of, reversalEntryKey: lines[0]?.reversalEntryKey ?? null,
    manual: e.source_type === 'MANUAL', attachments: files[0].n, lines,
  };
}

// --------------------------------------------------------------------------
// Manual entries
// --------------------------------------------------------------------------

async function branchOf(c, ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  const b = await acct.branchScope(c, ref);
  return b.id === 'NONE' ? null : b.id;
}

/** A user limited to some branches posts only to them, and never to no branch. */
function assertBranches(user, ids) {
  if (!user || !Array.isArray(user.branches)) return;
  for (const id of ids) {
    if (!id) throw err('BRANCH_REQUIRED: your access is limited to some branches; every line needs one of them', 403);
    if (!user.branches.includes(id)) throw err('OUTSIDE_YOUR_BRANCH_ACCESS', 403);
  }
}

async function dayOf(c, raw, { required = true } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw err('BOOKING_DATE_REQUIRED: date', 400);
    return null;
  }
  const day = String(raw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) throw err(`INVALID_BOOKING_DATE: ${raw}`, 400);
  if (day > await orgToday(c)) throw err('BOOKING_DATE_IN_THE_FUTURE: a journal entry is booked today or earlier', 400);
  const { rows: [y] } = await c.query(
    "SELECT year FROM financial_years WHERE $1::date BETWEEN starts_on AND ends_on AND status = 'CLOSED'", [day]);
  if (y) throw err(`FINANCIAL_YEAR_CLOSED: ${y.year} is closed; nothing can be booked on ${day}`, 409);
  return day;
}

async function manualLine(c, l, side, entryBranch) {
  const ref = typeof l?.glAccount === 'object' && l.glAccount !== null
    ? (l.glAccount.glCode ?? l.glAccount.encodedKey) : (l?.glAccount ?? l?.glCode ?? l?.glAccountId);
  if (!ref) throw err(`GL_ACCOUNT_REQUIRED: every ${side} line names its glAccount`, 400);
  const g = await COA.find(c, ref).catch(() => { throw err(`GL_ACCOUNT_NOT_FOUND: ${ref}`, 400); });
  if (!g.is_active) throw err(`GL_ACCOUNT_INACTIVE: ${g.code}`, 400);
  if (await COA.isHeader(c, g)) throw err(`HEADER_GL_ACCOUNT_NOT_ALLOWED: ${g.code}; post to a detail account`, 400);
  if (!g.allow_manual_entries) throw err(`MANUAL_JOURNAL_ENTRIES_NOT_ALLOWED: ${g.code}`, 400);
  const amount = Number(l.amount);
  if (!(amount > 0) || !Number.isFinite(amount)) throw err(`AMOUNT_MUST_BE_ABOVE_ZERO: ${side} ${g.code}`, 400);
  if (Math.abs(round2(amount) - amount) > 1e-9) throw err(`AMOUNT_HAS_MORE_THAN_2_DECIMALS: ${side} ${g.code}`, 400);
  const branchId = l.branchId === undefined && l.assignedBranchKey === undefined ? entryBranch : await branchOf(c, l.branchId ?? l.assignedBranchKey);
  return { glCode: g.code, amount, branchId };
}

async function nextTransactionId(c) {
  for (;;) {
    const { rows: [n] } = await c.query("SELECT nextval('manual_journal_entry_seq') AS n");
    const id = `MJ-${String(n.n).padStart(6, '0')}`;
    const { rows: [used] } = await c.query('SELECT 1 FROM journal_entries WHERE transaction_id = $1', [id]);
    if (!used) return id;
  }
}

async function transactionIdOf(c, given) {
  if (given === undefined || given === null || given === '') return nextTransactionId(c);
  const id = String(given);
  if (!TX_ID_RE.test(id)) throw err('INVALID_TRANSACTION_ID: letters, digits, period, hyphen and underscore, up to 64 characters', 400);
  const { rows: [used] } = await c.query('SELECT 1 FROM journal_entries WHERE transaction_id = $1', [id]);
  if (used) throw err(`TRANSACTION_ID_ALREADY_IN_USE: ${id}`, 409);
  return id;
}

/**
 * POST /gljournalentries. Returns the entry's lines as GLJournalEntry, the
 * inter-branch lines the platform added included.
 */
async function logManual(c, body, { user = null, createdBy } = {}) {
  const b = body || {};
  const notes = String(b.notes ?? '').trim();
  if (!notes) throw err('NOTES_REQUIRED: a manual journal entry is explained in its notes', 400);
  const day = await dayOf(c, b.date ?? b.bookingDate);
  const entryBranch = await branchOf(c, b.branchId ?? b.assignedBranchKey);
  const debits = Array.isArray(b.debits) ? b.debits : [];
  const credits = Array.isArray(b.credits) ? b.credits : [];
  if (!debits.length || !credits.length) throw err('DEBITS_AND_CREDITS_REQUIRED: at least one of each', 400);
  if (debits.length + credits.length > 200) throw err('AT_MOST_200_LINES', 400);
  const dr = [];
  for (const l of debits) dr.push(await manualLine(c, l, 'debit', entryBranch));
  const cr = [];
  for (const l of credits) cr.push(await manualLine(c, l, 'credit', entryBranch));
  const dt = round2(dr.reduce((s, l) => s + l.amount, 0));
  const ct = round2(cr.reduce((s, l) => s + l.amount, 0));
  if (dt !== ct) throw err(`JOURNAL_ENTRY_UNBALANCED: debits ${dt}, credits ${ct}`, 400);
  assertBranches(user, [entryBranch, ...dr.map((l) => l.branchId), ...cr.map((l) => l.branchId)]);
  const transactionId = await transactionIdOf(c, b.transactionId);
  const { rows: [t] } = await c.query('SELECT currency_code FROM platform.tenants WHERE schema_name = current_schema()');
  const posted = await acct.post(c, {
    debits: dr, credits: cr, bookingDate: day, narration: notes, sourceType: 'MANUAL',
    createdBy: createdBy || 'SYSTEM', branchId: entryBranch, transactionId, currencyCode: t?.currency_code || 'KES',
  });
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'MANUAL_JOURNAL_ENTRY_LOGGED', entity: 'journal_entry', entityId: posted.entryId, after: JSON.stringify({ transactionId, bookingDate: day, amount: dt, notes }) });
  return linesOf(c, posted.entryId);
}

/**
 * Reverse a manual entry (POST /gljournalentries/:ref:reverse), with notes,
 * on its own booking date unless another is given.
 */
async function reverseManual(c, ref, { notes, date, user = null, createdBy } = {}) {
  const e = await findEntry(c, ref);
  if (e.reversal_of) throw err('A_REVERSAL_CANNOT_BE_REVERSED', 409);
  if (e.source_type !== 'MANUAL') {
    const { rows: [t] } = await c.query('SELECT reference FROM transactions WHERE entry_id = $1 ORDER BY created_at LIMIT 1', [e.id]);
    throw err(`AUTOMATIC_JOURNAL_ENTRY: only a manual entry is reversed here; ${t ? `reverse transaction ${t.reference}` : `it was posted by ${e.source_type || 'the platform'}`} instead`, 409);
  }
  const why = String(notes ?? '').trim();
  if (!why) throw err('NOTES_REQUIRED: say why the entry is reversed', 400);
  const day = await dayOf(c, date, { required: false });
  const { rows: lines } = await c.query('SELECT DISTINCT branch_id FROM journal_lines WHERE entry_id = $1', [e.id]);
  assertBranches(user, lines.map((l) => l.branch_id));
  let tid = e.transaction_id ? `${e.transaction_id}-REV` : null;
  if (tid) {
    const { rows: [used] } = await c.query('SELECT 1 FROM journal_entries WHERE transaction_id = $1', [tid]);
    if (used || tid.length > 64) tid = await nextTransactionId(c);
  } else tid = await nextTransactionId(c);
  const posted = await acct.reverse(c, e.id, why, createdBy || 'SYSTEM', { bookingDate: day, transactionId: tid });
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'MANUAL_JOURNAL_ENTRY_REVERSED', entity: 'journal_entry', entityId: e.id, after: JSON.stringify({ reversal: posted.entryId, transactionId: tid, notes: why }) });
  return linesOf(c, posted.entryId);
}

// --------------------------------------------------------------------------
// Files on a manual entry
// --------------------------------------------------------------------------

const fileView = (r) => ({
  id: r.id, journalEntryId: r.entry_id, title: r.title, description: r.description, fileName: r.file_name, contentType: r.content_type,
  size: r.size, sha256: r.sha256, createdBy: r.created_by, createdAt: r.created_at, previewable: ATT.PREVIEWABLE.has(r.content_type),
});

async function attach(c, ref, { title = null, description = null, fileName, data, createdBy } = {}) {
  const e = await findEntry(c, ref);
  if (e.source_type !== 'MANUAL') throw err('FILES_ARE_ATTACHED_TO_MANUAL_JOURNAL_ENTRIES', 409);
  const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM journal_entry_attachments WHERE entry_id = $1', [e.id]);
  if (n.n >= MAX_FILES) throw err(`AT_MOST_${MAX_FILES}_FILES_ON_A_JOURNAL_ENTRY`, 409);
  const buf = Buffer.isBuffer(data) ? data : (typeof data === 'string' ? Buffer.from(data, 'base64') : null);
  const type = ATT.validate(fileName, buf);
  const name = String(fileName).trim();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const { rows: [r] } = await c.query(
    `INSERT INTO journal_entry_attachments (entry_id, title, description, file_name, content_type, size, sha256, data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [e.id, String(title || name.split('.')[0]).slice(0, 200), description, name, type, buf.length, sha, buf, createdBy || 'SYSTEM']);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'JOURNAL_ENTRY_FILE_ATTACHED', entity: 'journal_entry_attachment', entityId: r.id, after: JSON.stringify({ journalEntry: e.id, transactionId: e.transaction_id, fileName: name, size: buf.length, sha256: sha }) });
  return fileView(r);
}

async function files(c, ref) {
  const e = await findEntry(c, ref);
  const { rows } = await c.query(
    `SELECT id, entry_id, title, description, file_name, content_type, size, sha256, created_by, created_at
       FROM journal_entry_attachments WHERE entry_id = $1 ORDER BY created_at, id`, [e.id]);
  return rows.map(fileView);
}

async function file(c, ref, attachmentId) {
  const e = await findEntry(c, ref);
  if (!UUID_RE.test(String(attachmentId))) throw err('ATTACHMENT_NOT_FOUND', 404);
  const { rows: [r] } = await c.query('SELECT * FROM journal_entry_attachments WHERE id = $1 AND entry_id = $2', [attachmentId, e.id]);
  if (!r) throw err('ATTACHMENT_NOT_FOUND', 404);
  return { ...fileView(r), data: r.data };
}

module.exports = { search, get, logManual, reverseManual, attach, files, file, findEntry, FIELDS, MAX_FILES };
