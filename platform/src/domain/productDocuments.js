'use strict';

const { orgToday } = require('../lib/orgDate');
const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const customFields = require('./customFields');
const { recordAudit } = require('../lib/auditLog');
const { err, round2 } = acct;
const { ymd } = S;

/**
 * Product documents, after the reference platform's page of that name: templates kept per
 * loan or deposit product, for an account (contracts, letters, statements)
 * or for a transaction (receipts, confirmations), written in HTML and
 * filled from placeholders when generated.
 *
 * Placeholders are {{name}}; {{#statement}}...{{/statement}} repeats for
 * each transaction in the date range asked for, {{#schedule}}...{{/schedule}}
 * for each installment of a loan. A page break is
 * <div class="page-break"></div>. Values are HTML-escaped; dates and amounts
 * follow the organization's date format and decimal mark. The generated
 * page is served with a content security policy that allows no script.
 *
 *   organization.name .address .city .region .postcode .country .phone .email
 *   today  now
 *   member.memberNo .firstName .lastName .fullName .nationalId .phone .email
 *     .branch .centre  member.custom.<setId>.<fieldId>
 *   account.accountNo .name .productName .status .openedOn
 *     loans: .principal .disbursed .disbursedOn .interestRate .term
 *            .principalBalance .interestBalance .feesBalance .penaltyBalance .totalBalance
 *     deposits: .balance
 *     account.custom.<setId>.<fieldId>
 *   transaction.reference .type .amount .valueDate .channel .narration .postedBy
 *     transaction.custom.<setId>.<fieldId>
 *   statement.from .to   and in the block: line.date .reference .type .amount .narration
 *   in the schedule block: line.number .dueDate .principal .interest .fees .total .status
 */

async function audit(c, actor, action, id, before, after) {
  await recordAudit(c, { actor: actor || 'SYSTEM', action: action, entity: 'product_document', entityId: id, before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null });
}

async function productExists(c, kind, productId) {
  const table = kind === 'LOAN' ? 'loan_products' : 'savings_products';
  const { rows: [p] } = await c.query(`SELECT id FROM ${table} WHERE id = $1`, [productId]);
  if (!p) throw err(`UNKNOWN_${kind}_PRODUCT: ${productId}`, 404);
  return p.id;
}

async function list(c, kind, productId, { availability = null } = {}) {
  const { rows } = await c.query(
    `SELECT id, product_kind, product_id, name, availability, created_at, created_by, updated_at, updated_by
     FROM product_documents WHERE product_kind = $1 AND product_id = $2 AND ($3::text IS NULL OR availability = $3) ORDER BY name`,
    [kind, productId, availability]);
  return rows;
}

async function find(c, id) {
  const { rows: [d] } = await c.query('SELECT * FROM product_documents WHERE id::text = $1', [String(id)]);
  if (!d) throw err(`UNKNOWN_PRODUCT_DOCUMENT: ${id}`, 404);
  return d;
}

function shape(body, creating) {
  const out = {};
  if (body.name !== undefined || creating) {
    const n = String(body.name || '').trim();
    if (!n || n.length > 255) throw err('DOCUMENT_NAME_IS_1_TO_255_CHARACTERS', 400);
    out.name = n;
  }
  if (body.availability !== undefined || creating) {
    if (!['ACCOUNT', 'TRANSACTION'].includes(body.availability)) throw err('AVAILABILITY_IS_ACCOUNT_OR_TRANSACTION', 400);
    out.availability = body.availability;
  }
  if (body.content !== undefined) {
    const t = String(body.content || '');
    if (t.length > 500000) throw err('DOCUMENT_CONTENT_TOO_LONG', 413);
    out.content = t;
  }
  return out;
}

async function create(c, kind, productId, body = {}, { createdBy } = {}) {
  const pid = await productExists(c, kind, productId);
  const cols = { ...shape(body, true), product_kind: kind, product_id: pid, created_by: createdBy || 'SYSTEM' };
  const keys = Object.keys(cols);
  const { rows: [d] } = await c.query(
    `INSERT INTO product_documents (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (product_kind, product_id, name) DO NOTHING RETURNING *`, keys.map((k) => cols[k]));
  if (!d) throw err(`PRODUCT_DOCUMENT_EXISTS: ${cols.name}`, 409);
  await audit(c, createdBy, 'PRODUCT_DOCUMENT_CREATED', d.id, null, { name: d.name, product: pid });
  return d;
}

async function update(c, id, body = {}, { createdBy } = {}) {
  const before = await find(c, id);
  const cols = shape(body, false);
  const keys = Object.keys(cols);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const { rows: [after] } = await c.query(
    `UPDATE product_documents SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now(), updated_by = $${keys.length + 2}
     WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => cols[k]), createdBy || 'SYSTEM']);
  await audit(c, createdBy, 'PRODUCT_DOCUMENT_CHANGED', before.id, { name: before.name }, { name: after.name });
  return after;
}

async function remove(c, id, { createdBy } = {}) {
  const d = await find(c, id);
  await c.query('DELETE FROM product_documents WHERE id = $1', [d.id]);
  await audit(c, createdBy, 'PRODUCT_DOCUMENT_DELETED', d.id, { name: d.name, product: d.product_id }, null);
  return { deleted: d.id };
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A date in the organization's format (y M d H h m s a; MMMM and MMM for month names). */
function formatDate(value, pattern, withTime = false) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(withTime ? value : `${ymd(value)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
  const pad = (n, w) => String(n).padStart(w, '0');
  return pattern.replace(/y+|M+|d+|H+|h+|m+|s+|a/g, (tok) => {
    const ch = tok[0]; const w = tok.length;
    if (ch === 'y') return w === 2 ? pad(p.y % 100, 2) : String(p.y);
    if (ch === 'M') return w >= 4 ? MONTHS[p.M - 1] : w === 3 ? MONTHS[p.M - 1].slice(0, 3) : pad(p.M, w);
    if (ch === 'd') return pad(p.d, w);
    if (ch === 'H') return pad(p.H, w);
    if (ch === 'h') return pad(((p.H + 11) % 12) + 1, w);
    if (ch === 'm') return pad(p.m, w);
    if (ch === 's') return pad(p.s, w);
    return p.H < 12 ? 'AM' : 'PM';
  });
}

function formatAmount(n, decimals, mark) {
  const v = Number(n || 0);
  const [i, f] = Math.abs(v).toFixed(decimals).split('.');
  const group = mark === ',' ? '.' : ',';
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${v < 0 ? '-' : ''}${int}${f ? mark + f : ''}`;
}

/** Fill a template: blocks first, then placeholders. */
function fill(template, ctx, blocks) {
  let out = String(template || '');
  for (const [name, rows] of Object.entries(blocks)) {
    const re = new RegExp(`{{#${name}}}([\\s\\S]*?){{/${name}}}`, 'g');
    out = out.replace(re, (_, body) => rows.map((row) => body.replace(/{{\s*line\.([A-Za-z0-9_.]+)\s*}}/g, (m, k) => esc(row[k]))).join(''));
  }
  return out.replace(/{{\s*([A-Za-z0-9_.]+)\s*}}/g, (m, key) => (Object.prototype.hasOwnProperty.call(ctx, key) ? esc(ctx[key]) : ''));
}

function flatten(prefix, obj, out) {
  for (const [k, v] of Object.entries(obj || {})) out[`${prefix}.${k}`] = v;
  return out;
}

async function orgContext(c) {
  const { rows: [t] } = await c.query('SELECT name, currency_code, timezone FROM platform.tenants WHERE schema_name = current_schema()');
  const { rows: [s] } = await c.query('SELECT * FROM organization_settings WHERE id = 1');
  const decimals = await ledger.currencyDecimals(c);
  const fmt = {
    date: (v) => formatDate(v, s.date_format),
    dateTime: (v) => formatDate(v, s.datetime_format, true),
    amount: (v) => formatAmount(v, decimals, s.decimal_mark),
  };
  const ctx = {
    'organization.name': t.name, 'organization.address': s.street_address, 'organization.city': s.city, 'organization.region': s.region,
    'organization.postcode': s.postcode, 'organization.country': s.country, 'organization.phone': s.phone, 'organization.email': s.email,
    'organization.currency': t.currency_code, today: fmt.date((await orgToday(c))), now: fmt.dateTime(new Date().toISOString()),
  };
  return { ctx, fmt };
}

async function memberContext(c, memberId, fmt) {
  const { rows: [m] } = await c.query(
    `SELECT m.*, b.name AS branch_name, ce.name AS centre_name FROM members m
     LEFT JOIN branches b ON b.id = m.branch_id LEFT JOIN centres ce ON ce.id = m.centre_id WHERE m.id = $1`, [memberId]);
  if (!m) return {};
  const ctx = {
    'member.memberNo': m.member_no, 'member.firstName': m.first_name, 'member.lastName': m.last_name,
    'member.fullName': `${m.first_name} ${m.last_name}`, 'member.nationalId': m.national_id, 'member.phone': m.phone,
    'member.email': m.email, 'member.branch': m.branch_name, 'member.centre': m.centre_name,
    'member.dateOfBirth': fmt.date(m.date_of_birth),
  };
  return flatten('member.custom', await customFields.displayValues(c, 'MEMBER', m.custom_fields || {}), ctx);
}

async function accountContext(c, kind, id, fmt) {
  if (kind === 'LOAN') {
    const l = await ledger.read(c, id);
    const b = ledger.balances(l);
    const ctx = {
      'account.accountNo': l.account_no, 'account.name': l.name, 'account.productName': l.product_name, 'account.status': l.status,
      'account.openedOn': fmt.date(l.applied_on || l.created_at), 'account.principal': fmt.amount(l.principal),
      'account.disbursed': fmt.amount(l.principal_disbursed), 'account.disbursedOn': fmt.date(l.disbursed_on),
      'account.interestRate': l.monthly_rate, 'account.term': l.term_months,
      'account.principalBalance': fmt.amount(b.principal), 'account.interestBalance': fmt.amount(b.interest),
      'account.feesBalance': fmt.amount(round2(b.fees + (b.nonScheduledFees || 0))), 'account.penaltyBalance': fmt.amount(b.penalty),
      'account.totalBalance': fmt.amount(b.total),
    };
    flatten('account.custom', await customFields.displayValues(c, 'LOAN_ACCOUNT', l.custom_fields || {}), ctx);
    return { row: l, ctx, memberId: l.member_id, productId: l.product_id };
  }
  const { rows: [a] } = await c.query(
    `SELECT a.*, p.name AS product_name FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
     WHERE a.id::text = $1 OR a.account_no = $1`, [String(id)]);
  if (!a) throw err('SAVINGS_ACCOUNT_NOT_FOUND', 404);
  const ctx = {
    'account.accountNo': a.account_no, 'account.productName': a.product_name, 'account.status': a.status,
    'account.openedOn': fmt.date(a.opened_on), 'account.balance': fmt.amount(a.balance),
  };
  flatten('account.custom', await customFields.displayValues(c, 'SAVINGS_ACCOUNT', a.custom_fields || {}), ctx);
  return { row: a, ctx, memberId: a.member_id, productId: a.product_id };
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111;margin:24px}table{border-collapse:collapse}
td,th{padding:4px 8px}.page-break{page-break-after:always;break-after:page}</style></head><body>${body}</body></html>`;
}

/** The content security policy a generated document is served with. */
const CSP = "default-src 'none'; style-src 'unsafe-inline' https:; img-src data: https:; font-src https: data:";

/**
 * Generate an account document (`from` and `to` bound the statement block)
 * or, with `reference`, a transaction document.
 */
async function generate(c, kind, accountId, docId, { from = null, to = null, reference = null } = {}) {
  const d = await find(c, docId);
  if (d.product_kind !== kind) throw err(`DOCUMENT_IS_FOR_${d.product_kind}_PRODUCTS`, 409);
  const { ctx: org, fmt } = await orgContext(c);
  const acc = await accountContext(c, kind, accountId, fmt);
  if (d.product_id !== acc.productId) throw err(`DOCUMENT_IS_FOR_PRODUCT_${d.product_id}`, 409);
  const ctx = { ...org, ...(await memberContext(c, acc.memberId, fmt)), ...acc.ctx };
  const col = kind === 'LOAN' ? 'loan_account_id' : 'savings_account_id';
  if (d.availability === 'TRANSACTION') {
    if (!reference) throw err('A_TRANSACTION_DOCUMENT_NEEDS_A_TRANSACTION', 400);
    const { rows: [t] } = await c.query(
      `SELECT t.*, ch.name AS channel_name FROM transactions t LEFT JOIN transaction_channels ch ON ch.id = t.channel_id
       WHERE t.reference = $1 AND t.${col} = $2`, [reference, acc.row.id]);
    if (!t) throw err(`TRANSACTION_NOT_ON_THIS_ACCOUNT: ${reference}`, 404);
    Object.assign(ctx, {
      'transaction.reference': t.reference, 'transaction.type': t.kind, 'transaction.amount': fmt.amount(t.amount),
      'transaction.valueDate': fmt.date(t.value_date), 'transaction.channel': t.channel_name || t.channel_id,
      'transaction.narration': t.narration, 'transaction.postedBy': t.created_by,
    });
    flatten('transaction.custom', await customFields.displayValues(c, 'TRANSACTION_CHANNEL', t.custom_fields || {}), ctx);
  } else if (reference) throw err('AN_ACCOUNT_DOCUMENT_TAKES_NO_TRANSACTION', 400);
  const hasStatement = /{{#statement}}/.test(d.content);
  if (hasStatement && (!from || !to)) throw err('THIS_DOCUMENT_HAS_A_STATEMENT: give from and to dates', 400);
  const blocks = { statement: [], schedule: [] };
  if (hasStatement) {
    ctx['statement.from'] = fmt.date(from); ctx['statement.to'] = fmt.date(to);
    const { rows } = await c.query(
      `SELECT * FROM transactions WHERE ${col} = $1 AND value_date BETWEEN $2::date AND $3::date AND reversed_by IS NULL
       ORDER BY value_date, created_at`, [acc.row.id, ymd(from), ymd(to)]);
    blocks.statement = rows.map((t) => ({ date: fmt.date(t.value_date), reference: t.reference, type: t.kind, amount: fmt.amount(t.amount), narration: t.narration || '' }));
  }
  if (kind === 'LOAN' && /{{#schedule}}/.test(d.content)) {
    const { rows } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [acc.row.id]);
    blocks.schedule = rows.map((i) => ({
      number: i.number, dueDate: fmt.date(i.due_date), principal: fmt.amount(i.principal_due), interest: fmt.amount(i.interest_due),
      fees: fmt.amount(i.fee_due), total: fmt.amount(Number(i.principal_due) + Number(i.interest_due) + Number(i.fee_due)), status: i.status,
    }));
  }
  return { html: page(d.name, fill(d.content, ctx, blocks)), name: d.name };
}

/** Templates available on an account, for its Documents menu. */
async function forAccount(c, kind, accountId) {
  const table = kind === 'LOAN' ? 'loan_accounts' : 'savings_accounts';
  const { rows: [a] } = await c.query(`SELECT product_id FROM ${table} WHERE id::text = $1 OR account_no = $1`, [String(accountId)]);
  if (!a) throw err(`${kind}_ACCOUNT_NOT_FOUND`, 404);
  return list(c, kind, a.product_id);
}

module.exports = { list, find, create, update, remove, generate, forAccount, fill, formatDate, formatAmount, CSP };
