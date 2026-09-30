'use strict';

/**
 * The chart of accounts, after the reference platform's "Creating your Chart of Accounts"
 * and its GL accounts API (/glaccounts).
 *
 * An account has a GL code, a name, a type (ASSET, LIABILITY, EQUITY,
 * INCOME, EXPENSE), a usage (HEADER or DETAIL), a description, an active
 * flag and "Allow Manual Journal Entries" (detail accounts only). The
 * hierarchy is by parent code: a header's balance is the sum of the accounts
 * under it, at any depth.
 *
 * What may change (decisions in docs/audits/audit-accounting.md):
 *   - the name, description, parent, regulatory class, the active flag and
 *     the manual-entries flag at any time;
 *   - the GL code only while nothing uses the account: the code is the key
 *     products, channels, tills, rules and every journal line point at;
 *   - the type and usage never (the reference platform: they cannot be edited).
 * An account is deleted only while nothing uses it, as the reference platform deletes only an
 * account never used.
 *
 * Depends on accounting only.
 */

const acct = require('./accounting');
const { recordAudit } = require('../lib/auditLog');
const { err, round2 } = acct;

const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const USAGES = ['HEADER', 'DETAIL'];
const REGULATORY = ['LIQUID_ASSET', 'LOAN_PORTFOLIO', 'OTHER_ASSET', 'MEMBER_DEPOSIT', 'SHORT_TERM_LIABILITY', 'OTHER_LIABILITY',
  'SHARE_CAPITAL', 'INSTITUTIONAL_CAPITAL', 'INCOME', 'EXPENSE'];
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

// Accounts the platform posts to by code, outside any mapping: the year-end
// close's retained earnings, dividends payable and the till's cash over and
// short. Column defaults that name an account are found from the catalog.
const PLATFORM_CODES = ['200-200', '300-200', '500-330'];

const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * Where an account is used: every column that holds a GL code (by foreign
 * key to gl_accounts, or named gl_* / *_gl), its child accounts, and the
 * column defaults and platform postings that name it. Returns short labels
 * ("journal_lines.gl_code"); empty means unused.
 */
async function uses(c, code) {
  const { rows: cols } = await c.query(
    `SELECT DISTINCT cl.table_name AS tbl, cl.column_name AS col, cl.column_default AS dflt
       FROM information_schema.columns cl
       JOIN information_schema.tables tb ON tb.table_schema = cl.table_schema AND tb.table_name = cl.table_name AND tb.table_type = 'BASE TABLE'
      WHERE cl.table_schema = current_schema()
        AND cl.data_type = 'text'
        AND NOT (cl.table_name = 'gl_accounts' AND cl.column_name <> 'parent_code')
        AND (cl.column_name ~ '^gl_' OR cl.column_name ~ '_gl$' OR cl.column_name IN ('gl_code', 'parent_code')
             OR (cl.table_name, cl.column_name) IN (
               SELECT r.relname::text, a.attname::text
                 FROM pg_constraint k
                 JOIN pg_class r ON r.oid = k.conrelid
                 JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
                WHERE k.contype = 'f' AND k.confrelid = to_regclass('gl_accounts')))
      ORDER BY 1, 2`);
  const out = [];
  for (const col of cols) {
    if (col.tbl === 'gl_accounts' && col.col === 'parent_code') {
      const { rows: [r] } = await c.query('SELECT EXISTS (SELECT 1 FROM gl_accounts WHERE parent_code = $1) AS used', [code]);
      if (r.used) out.push('child accounts');
      continue;
    }
    const { rows: [r] } = await c.query(`SELECT EXISTS (SELECT 1 FROM ${qi(col.tbl)} WHERE ${qi(col.col)} = $1) AS used`, [code]);
    if (r.used) out.push(`${col.tbl}.${col.col}`);
    else if (col.dflt && col.dflt.startsWith(`'${code}'`)) out.push(`${col.tbl}.${col.col} (the default for new rows)`);
  }
  if (PLATFORM_CODES.includes(code)) out.push('posted to by the platform');
  return [...new Set(out)];
}

/** A header: usage HEADER, or an account with accounts under it (the platform's rule since 028). */
async function isHeader(c, g) {
  if (g.usage === 'HEADER') return true;
  const { rows: [r] } = await c.query('SELECT EXISTS (SELECT 1 FROM gl_accounts WHERE parent_code = $1) AS h', [g.code]);
  return r.h;
}

async function find(c, ref, { lock = false } = {}) {
  const { rows: [g] } = await c.query(`SELECT * FROM gl_accounts WHERE code = $1${lock ? ' FOR UPDATE' : ''}`, [String(ref ?? '')]);
  if (!g) throw err(`GL_ACCOUNT_NOT_FOUND: ${ref}`, 404);
  return g;
}

/**
 * Balances, in each account's own sign (assets and expenses debit minus
 * credit, the rest credit minus debit), for [from, to] and a branch or the
 * whole book. A header's balance is the sum of every account under it.
 */
async function balanceMap(c, { from = null, to = null, branchId = null } = {}) {
  const branch = await acct.branchScope(c, branchId);
  const m = acct.movement({ from, to, branchId: branch ? branch.id : null });
  const { rows: moved } = await c.query(m.sql, m.params);
  const own = new Map(moved.map((r) => [r.gl_code, Number(r.debit) - Number(r.credit)]));
  const { rows: all } = await c.query('SELECT code, parent_code, type FROM gl_accounts');
  const kids = new Map();
  for (const g of all) if (g.parent_code) kids.set(g.parent_code, [...(kids.get(g.parent_code) || []), g.code]);
  const memo = new Map();
  const debitPositive = (code, seen = new Set()) => {
    if (memo.has(code)) return memo.get(code);
    if (seen.has(code)) return 0;
    seen.add(code);
    const v = (own.get(code) || 0) + (kids.get(code) || []).reduce((s, k) => s + debitPositive(k, seen), 0);
    memo.set(code, v);
    return v;
  };
  const out = new Map();
  for (const g of all) out.set(g.code, acct.natural(g.type, debitPositive(g.code)));
  return { balances: out, branch };
}

/** The reference platform's GLAccount. */
function shape(g, { balance, header } = {}) {
  const out = {
    encodedKey: g.code,
    glCode: g.code,
    name: g.name,
    type: g.type,
    usage: header ? 'HEADER' : g.usage,
    description: g.notes ?? null,
    activated: g.is_active,
    allowManualJournalEntries: header ? false : g.allow_manual_entries,
    parentGlCode: g.parent_code ?? null,
    regulatoryClass: g.regulatory_class ?? null,
    currency: { code: null },
    creationDate: g.created_at ?? null,
    lastModifiedDate: g.updated_at ?? null,
  };
  if (balance !== undefined) out.balance = round2(balance);
  return out;
}

async function currencyCode(c) {
  const { rows: [t] } = await c.query('SELECT currency_code FROM platform.tenants WHERE schema_name = current_schema()');
  return t ? t.currency_code : null;
}

/**
 * GET /glaccounts: filtered by type, usage and the active flag, with each
 * account's balance for [from, to] (and a branch).
 */
async function list(c, { type = null, usage = null, activated = null, from = null, to = null, branchId = null, offset = 0, limit = 50 } = {}) {
  if (type && !TYPES.includes(String(type).toUpperCase())) throw err(`INVALID_GL_ACCOUNT_TYPE: ${type}; one of ${TYPES.join(', ')}`, 400);
  if (usage && !USAGES.includes(String(usage).toUpperCase())) throw err(`INVALID_GL_ACCOUNT_USAGE: ${usage}; HEADER or DETAIL`, 400);
  const { balances } = await balanceMap(c, { from, to, branchId });
  const { rows } = await c.query(
    `SELECT g.*, (g.usage = 'HEADER' OR EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_code = g.code)) AS header,
            count(*) OVER () AS total
       FROM gl_accounts g
      WHERE ($1::text IS NULL OR g.type = $1)
        AND ($2::text IS NULL OR (CASE WHEN g.usage = 'HEADER' OR EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_code = g.code) THEN 'HEADER' ELSE 'DETAIL' END) = $2)
        AND ($3::boolean IS NULL OR g.is_active = $3)
      ORDER BY g.code LIMIT $4 OFFSET $5`,
    [type ? String(type).toUpperCase() : null, usage ? String(usage).toUpperCase() : null,
      activated === null || activated === undefined || activated === '' ? null : String(activated) === 'true', limit, offset]);
  const cur = await currencyCode(c);
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    items: rows.map((g) => ({ ...shape(g, { balance: balances.get(g.code) || 0, header: g.header }), currency: { code: cur } })),
  };
}

async function get(c, ref, { from = null, to = null, branchId = null } = {}) {
  const g = await find(c, ref);
  const { balances } = await balanceMap(c, { from, to, branchId });
  return { ...shape(g, { balance: balances.get(g.code) || 0, header: await isHeader(c, g) }), currency: { code: await currencyCode(c) } };
}

const bool = (v, name) => {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  throw err(`${name}_IS_TRUE_OR_FALSE`, 400);
};

const audit = (c, actor, action, entityId, before, after) => recordAudit(c, {
  actor: actor || 'SYSTEM', action, entity: 'gl_account', entityId, before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null });

/** A parent must exist, have the same type, and be a header. */
async function checkParent(c, parentCode, type, selfCode = null) {
  if (parentCode === null || parentCode === undefined || parentCode === '') return null;
  const p = await c.query('SELECT * FROM gl_accounts WHERE code = $1', [String(parentCode)]).then((r) => r.rows[0]);
  if (!p) throw err(`PARENT_GL_ACCOUNT_NOT_FOUND: ${parentCode}`, 400);
  if (p.type !== type) throw err(`PARENT_GL_ACCOUNT_TYPE_DIFFERS: ${p.code} is ${p.type}`, 400);
  if (!(await isHeader(c, p))) throw err(`PARENT_GL_ACCOUNT_IS_NOT_A_HEADER: ${p.code}`, 400);
  if (selfCode) {
    // The new parent must not sit under the account itself.
    let at = p;
    for (let depth = 0; at && depth < 64; depth += 1) {
      if (at.code === selfCode) throw err('PARENT_GL_ACCOUNT_WOULD_MAKE_A_LOOP', 400);
      at = at.parent_code ? (await c.query('SELECT code, parent_code FROM gl_accounts WHERE code = $1', [at.parent_code])).rows[0] : null;
    }
  }
  return p.code;
}

/** POST /glaccounts: one account, or a list created in order (parents first). */
async function create(c, body, { createdBy } = {}) {
  if (Array.isArray(body)) {
    const out = [];
    for (const [i, one] of body.entries()) {
      try { out.push(await create(c, one, { createdBy })); } catch (e) { e.message = `ITEM_${i}: ${e.message}`; throw e; }
    }
    return out;
  }
  const b = body || {};
  const code = String(b.glCode ?? '').trim();
  if (!code) throw err('GL_CODE_REQUIRED', 400);
  if (!CODE_RE.test(code)) throw err('INVALID_GL_CODE: letters, digits, period, hyphen and underscore, up to 32 characters', 400);
  const name = String(b.name ?? '').trim();
  if (!name) throw err('GL_ACCOUNT_NAME_REQUIRED', 400);
  const type = String(b.type ?? '').toUpperCase();
  if (!TYPES.includes(type)) throw err(`INVALID_GL_ACCOUNT_TYPE: ${b.type}; one of ${TYPES.join(', ')}`, 400);
  const usage = String(b.usage ?? 'DETAIL').toUpperCase();
  if (!USAGES.includes(usage)) throw err(`INVALID_GL_ACCOUNT_USAGE: ${b.usage}; HEADER or DETAIL`, 400);
  const manual = bool(b.allowManualJournalEntries, 'ALLOW_MANUAL_JOURNAL_ENTRIES');
  if (usage === 'HEADER' && manual) throw err('A_HEADER_ACCOUNT_TAKES_NO_MANUAL_JOURNAL_ENTRIES', 400);
  const activated = bool(b.activated, 'ACTIVATED');
  if (b.regulatoryClass && !REGULATORY.includes(b.regulatoryClass)) throw err(`INVALID_REGULATORY_CLASS: one of ${REGULATORY.join(', ')}`, 400);
  if (b.currency?.code) {
    const cur = await currencyCode(c);
    if (String(b.currency.code).toUpperCase() !== cur) throw err(`GL_ACCOUNTS_ARE_IN_THE_BASE_CURRENCY: ${cur}; the ledger holds one currency`, 400);
  }
  const { rows: [dup] } = await c.query('SELECT 1 FROM gl_accounts WHERE lower(code) = lower($1)', [code]);
  if (dup) throw err(`GL_CODE_ALREADY_IN_USE: ${code}`, 409);
  const parent = await checkParent(c, b.parentGlCode, type);
  const { rows: [g] } = await c.query(
    `INSERT INTO gl_accounts (code, name, type, usage, parent_code, notes, is_active, allow_manual_entries, regulatory_class)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [code, name, type, usage, parent, b.description ?? null, activated ?? true, usage === 'HEADER' ? false : (manual ?? true), b.regulatoryClass || null]);
  // A detail account that becomes a parent is a header now: it takes no manual entries.
  if (parent) await c.query('UPDATE gl_accounts SET allow_manual_entries = false, updated_at = now() WHERE code = $1 AND allow_manual_entries', [parent]);
  await audit(c, createdBy, 'GL_ACCOUNT_CREATED', g.code, null, shape(g));
  return { ...shape(g, { header: usage === 'HEADER' }), currency: { code: await currencyCode(c) } };
}

const FIXED = ['type', 'usage'];

/**
 * Apply an edit (PUT gives every field, PATCH the ones it changes). Fields
 * not given are kept.
 */
async function update(c, ref, next, { createdBy } = {}) {
  const g = await find(c, ref, { lock: true });
  const header = await isHeader(c, g);
  const current = shape(g, { header });
  const n = next || {};
  const moved = FIXED.filter((k) => n[k] !== undefined && String(n[k]).toUpperCase() !== current[k]);
  if (moved.length) throw err(`FIELDS_NOT_EDITABLE: ${moved.join(', ')}; the type and usage of an account cannot change`, 400);
  if (n.encodedKey !== undefined && n.encodedKey !== g.code && n.glCode === undefined) throw err('FIELDS_NOT_EDITABLE: encodedKey; change glCode', 400);
  const set = {};
  if (n.name !== undefined) {
    const name = String(n.name ?? '').trim();
    if (!name) throw err('GL_ACCOUNT_NAME_REQUIRED', 400);
    set.name = name;
  }
  if (n.description !== undefined) set.notes = n.description === null ? null : String(n.description);
  if (n.regulatoryClass !== undefined) {
    if (n.regulatoryClass !== null && !REGULATORY.includes(n.regulatoryClass)) throw err(`INVALID_REGULATORY_CLASS: one of ${REGULATORY.join(', ')}`, 400);
    set.regulatory_class = n.regulatoryClass;
  }
  const manual = bool(n.allowManualJournalEntries, 'ALLOW_MANUAL_JOURNAL_ENTRIES');
  if (manual !== undefined && manual !== current.allowManualJournalEntries) {
    if (header && manual) throw err('A_HEADER_ACCOUNT_TAKES_NO_MANUAL_JOURNAL_ENTRIES', 400);
    set.allow_manual_entries = manual;
  }
  const activated = bool(n.activated, 'ACTIVATED');
  let used = null;
  const inUse = async () => { if (used === null) used = await uses(c, g.code); return used; };
  if (activated !== undefined && activated !== g.is_active) {
    if (!activated) {
      // An account something posts to by mapping stays active: the postings would carry on landing there.
      const mapped = (await inUse()).filter((u) => !/^journal_lines|^gl_daily_balances|^gl_branch_daily_balances|^accrual_lines|child accounts/.test(u));
      if (mapped.length) throw err(`GL_ACCOUNT_IS_MAPPED: ${mapped.join(', ')}; change the mapping before deactivating it`, 409);
    }
    set.is_active = activated;
  }
  if (n.parentGlCode !== undefined && (n.parentGlCode || null) !== (g.parent_code || null)) {
    set.parent_code = await checkParent(c, n.parentGlCode, g.type, g.code);
  }
  let code = g.code;
  if (n.glCode !== undefined && String(n.glCode) !== g.code) {
    const to = String(n.glCode ?? '').trim();
    if (!CODE_RE.test(to)) throw err('INVALID_GL_CODE: letters, digits, period, hyphen and underscore, up to 32 characters', 400);
    const u = await inUse();
    if (u.length) throw err(`GL_CODE_CANNOT_CHANGE_ONCE_THE_ACCOUNT_IS_USED: ${u.join(', ')}`, 409);
    const { rows: [dup] } = await c.query('SELECT 1 FROM gl_accounts WHERE lower(code) = lower($1) AND code <> $2', [to, g.code]);
    if (dup) throw err(`GL_CODE_ALREADY_IN_USE: ${to}`, 409);
    set.code = to;
    code = to;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await c.query(
      `UPDATE gl_accounts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE code = $1`,
      [g.code, ...keys.map((k) => set[k])]);
    if (set.parent_code) await c.query('UPDATE gl_accounts SET allow_manual_entries = false WHERE code = $1 AND allow_manual_entries', [set.parent_code]);
    const after = await find(c, code);
    await audit(c, createdBy, 'GL_ACCOUNT_EDITED', code, current, shape(after));
  }
  return get(c, code);
}

/** The reference platform's PATCH: JSON Patch operations on the account object. */
function jsonPatch(obj, ops) {
  if (!Array.isArray(ops)) throw err('A_JSON_PATCH_IS_A_LIST_OF_OPERATIONS', 400);
  const out = { ...obj };
  const allowed = ['glCode', 'name', 'description', 'activated', 'allowManualJournalEntries', 'parentGlCode', 'regulatoryClass', 'type', 'usage'];
  for (const o of ops) {
    const op = String(o?.op || '').toUpperCase();
    if (!['ADD', 'REPLACE', 'REMOVE'].includes(op)) throw err(`UNSUPPORTED_PATCH_OPERATION: ${o?.op}; ADD, REPLACE or REMOVE`, 400);
    const key = String(o.path || '').replace(/^\//, '');
    if (!allowed.includes(key)) throw err(`INVALID_PATCH_PATH: ${o.path}; one of /${allowed.join(', /')}`, 400);
    out[key] = op === 'REMOVE' ? null : o.value;
  }
  return out;
}

async function patch(c, ref, ops, opts) {
  const g = await find(c, ref);
  const current = shape(g, { header: await isHeader(c, g) });
  const next = jsonPatch(current, ops);
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(current[k])));
  if (changed.name === null) throw err('GL_ACCOUNT_NAME_REQUIRED', 400);
  return update(c, ref, changed, opts);
}

async function remove(c, ref, { createdBy } = {}) {
  const g = await find(c, ref, { lock: true });
  const u = await uses(c, g.code);
  if (u.length) throw err(`GL_ACCOUNT_IN_USE: ${u.join(', ')}`, 409);
  await c.query('DELETE FROM gl_accounts WHERE code = $1', [g.code]);
  await audit(c, createdBy, 'GL_ACCOUNT_DELETED', g.code, shape(g), null);
  return { deleted: g.code };
}

module.exports = { list, get, create, update, patch, remove, uses, find, isHeader, shape, balanceMap, TYPES, USAGES, PLATFORM_CODES };
