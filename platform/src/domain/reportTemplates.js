'use strict';

const { orgToday } = require('../lib/orgDate');
const PERMS = require('../lib/permissions');
const V = require('./customViews');
const R = require('./reports');
const PF = require('./portfolio');
const IND = require('./indicators');
const acct = require('./accounting');
const ROLES = require('./roles');

/**
 * Report templates, in place of the reference platform's Jasper reports. The reference platform's JRXML
 * templates hold SQL written against the reference platform's own database, so none would run
 * here; a template here is a JSON document that names its data instead of
 * querying for it, and the platform fetches that data with the permissions
 * of the user running the report. A template cannot read what its reader may
 * not see, and it never carries SQL.
 *
 * As with Jasper, a template has a name, a report type (the kind of record
 * it is shown on: MEMBER, LOAN, DEPOSIT, BRANCH, CENTRE, or OTHER for
 * Reporting > Other reports), the file, and visibility (every user or the
 * roles chosen). It can be edited, deleted, rearranged, downloaded and
 * previewed, and runs to HTML, PDF, Excel, CSV or JSON.
 *
 * The file:
 * {
 *   "title": "Member statement for {{record.name}}",
 *   "parameters": [{ "name": "from", "label": "From", "type": "DATE", "required": true, "default": "MONTH_START" }],
 *   "sections": [
 *     { "title": "Loans", "type": "TABLE",
 *       "view": { "entity": "LOANS", "filters": [{ "field": "memberNo", "operator": "EQUALS", "value": "{{record.memberNo}}" }],
 *                 "columns": ["accountNo", "status", "principalOutstanding"], "includeTotals": true }, "limit": 500 },
 *     { "title": "Portfolio", "type": "TABLE", "report": "portfolio-at-risk", "params": { "branchId": "{{param.branch}}" } },
 *     { "title": "Notes", "type": "TEXT", "text": "Printed {{today}} by {{user.email}}." }
 *   ],
 *   "footer": "{{organization.name}}"
 * }
 * Placeholders: {{record.x}} (the record the report runs on), {{param.x}},
 * {{today}}, {{user.email}}, {{organization.name}}.
 */

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
const ADMIN = 'TENANT_ADMIN';
const TYPES = ['MEMBER', 'LOAN', 'DEPOSIT', 'BRANCH', 'CENTRE', 'OTHER'];
const PARAM_TYPES = ['DATE', 'TEXT', 'NUMBER', 'BOOLEAN', 'SELECTION', 'BRANCH', 'LOAN_PRODUCT', 'DEPOSIT_PRODUCT'];
const SECTION_TYPES = ['TABLE', 'FIELDS', 'TEXT'];
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ROW_MAX = 100000;

/** The built-in reports a section can show, and the permission each needs. */
const REPORTS = {
  'balance-sheet': 'VIEW_ACCOUNTING_REPORTS',
  'income-statement': 'VIEW_ACCOUNTING_REPORTS',
  'trial-balance': 'VIEW_ACCOUNTING_REPORTS',
  'portfolio-at-risk': 'VIEW_REPORTS',
  risk: 'VIEW_REPORTS',
  indicators: 'VIEW_INTELLIGENCE',
};

// --------------------------------------------------------------------------
// The file
// --------------------------------------------------------------------------

/** Check a template file; returns it normalised or throws with every problem. */
async function checkDefinition(c, raw, user) {
  let def = raw;
  if (typeof def === 'string') {
    try { def = JSON.parse(def); } catch (e) { throw err(`TEMPLATE_IS_NOT_JSON: ${e.message}`); }
  }
  if (!def || typeof def !== 'object' || Array.isArray(def)) throw err('TEMPLATE_MUST_BE_A_JSON_OBJECT');
  const problems = [];
  const params = Array.isArray(def.parameters) ? def.parameters : [];
  if (def.parameters !== undefined && !Array.isArray(def.parameters)) problems.push('parameters must be a list');
  const names = new Set();
  for (const [i, p] of params.entries()) {
    if (!p || !IDENT.test(String(p.name || ''))) { problems.push(`parameter ${i + 1}: a name of letters, digits and underscores`); continue; }
    if (names.has(p.name)) problems.push(`parameter ${p.name}: named twice`);
    names.add(p.name);
    const t = String(p.type || 'TEXT').toUpperCase();
    if (!PARAM_TYPES.includes(t)) problems.push(`parameter ${p.name}: type is one of ${PARAM_TYPES.join(', ')}`);
    if (t === 'SELECTION' && (!Array.isArray(p.values) || !p.values.length)) problems.push(`parameter ${p.name}: a selection lists its values`);
  }
  const sections = Array.isArray(def.sections) ? def.sections : null;
  if (!sections || !sections.length) problems.push('sections: at least one');
  if (sections && sections.length > 20) problems.push('sections: at most 20');
  for (const [i, s] of (sections || []).entries()) {
    const where = `section ${i + 1}${s && s.title ? ` (${s.title})` : ''}`;
    if (!s || typeof s !== 'object') { problems.push(`${where}: an object`); continue; }
    const t = String(s.type || 'TABLE').toUpperCase();
    if (!SECTION_TYPES.includes(t)) problems.push(`${where}: type is one of ${SECTION_TYPES.join(', ')}`);
    const sources = ['view', 'report', 'text'].filter((k) => s[k] !== undefined);
    if (t === 'TEXT' ? !s.text : sources.filter((k) => k !== 'text').length !== 1) {
      problems.push(`${where}: ${t === 'TEXT' ? 'text' : 'exactly one of view or report'}`);
      continue;
    }
    if (s.view) {
      try {
        const e = V.entityOf(s.view.entity);
        const fields = await V.fieldsFor(c, e, user);
        // Placeholders stand in for values until the report runs.
        const probe = { ...s.view, filters: (s.view.filters || []).map((f) => ({ ...f, value: f.value, secondValue: f.secondValue })) };
        V.normalise({ ...probe, entity: e.key }, e, fields);
      } catch (e) { problems.push(`${where}: ${e.message}`); }
      if (s.limit !== undefined && !(Number.isInteger(s.limit) && s.limit > 0 && s.limit <= ROW_MAX)) problems.push(`${where}: limit is 1 to ${ROW_MAX}`);
    }
    if (s.report && !REPORTS[s.report]) problems.push(`${where}: report is one of ${Object.keys(REPORTS).join(', ')}`);
  }
  if (problems.length) throw Object.assign(err(`TEMPLATE_INVALID: ${problems.join('; ')}`), { problems });
  return {
    title: def.title ? String(def.title) : null,
    parameters: params.map((p) => ({
      name: p.name, label: p.label || p.name, type: String(p.type || 'TEXT').toUpperCase(), required: Boolean(p.required),
      ...(p.default !== undefined ? { default: p.default } : {}), ...(p.values ? { values: p.values } : {}),
    })),
    sections: sections.map((s) => ({ ...s, type: String(s.type || 'TABLE').toUpperCase() })),
    footer: def.footer ? String(def.footer) : null,
    landscape: Boolean(def.landscape),
  };
}

// --------------------------------------------------------------------------
// Templates
// --------------------------------------------------------------------------

const VISIBLE = `($1::boolean OR t.all_users OR $2 = ANY(t.roles))`;
const who = (user) => [user.role === ADMIN, user.roleCode || user.role];

function shape(t, withDefinition = false) {
  return {
    id: t.id, name: t.name, reportType: t.report_type, description: t.description, fileName: t.file_name,
    usageRights: { allUsers: t.all_users, roles: t.roles }, position: t.position,
    parameters: t.definition.parameters || [],
    ...(withDefinition ? { definition: t.definition } : {}),
    createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

async function list(c, user, { type = null } = {}) {
  const ty = type ? String(type).toUpperCase() : null;
  if (ty && !TYPES.includes(ty)) throw err(`REPORT_TYPE_IS_ONE_OF: ${TYPES.join(', ')}`);
  const { rows } = await c.query(
    `SELECT * FROM report_templates t WHERE ${VISIBLE} AND ($3::text IS NULL OR t.report_type = $3)
     ORDER BY t.report_type, t.position, lower(t.name)`, [...who(user), ty]);
  return rows.map((t) => shape(t));
}

async function find(c, id, user) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw err('REPORT_TEMPLATE_NOT_FOUND', 404);
  const { rows: [t] } = await c.query(`SELECT * FROM report_templates t WHERE t.id = $3::uuid AND ${VISIBLE}`, [...who(user), id]);
  if (!t) throw err('REPORT_TEMPLATE_NOT_FOUND', 404);
  return t;
}

async function get(c, id, user) {
  return shape(await find(c, id, user), true);
}

async function rightsOf(c, body, before = null) {
  const r = body.usageRights || {};
  const allUsers = r.allUsers !== undefined ? Boolean(r.allUsers) : before ? before.all_users : true;
  const roles = r.roles !== undefined ? r.roles : before ? before.roles : [];
  const known = await ROLES.codes(c);
  if (!Array.isArray(roles) || roles.some((x) => !known.includes(x))) throw err(`INVALID_ROLES: use ${known.join(', ')}`);
  return { allUsers, roles: [...new Set(roles)] };
}

async function create(c, body = {}, user) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 255) throw err('REPORT_NAME_REQUIRED: 1 to 255 characters');
  const type = String(body.reportType || body.type || '').toUpperCase();
  if (!TYPES.includes(type)) throw err(`REPORT_TYPE_IS_ONE_OF: ${TYPES.join(', ')}`);
  const def = await checkDefinition(c, body.definition ?? body.template, user);
  const rights = await rightsOf(c, body);
  const { rows: [pos] } = await c.query('SELECT COALESCE(max(position), 0) + 1 AS n FROM report_templates WHERE report_type = $1', [type]);
  try {
    const { rows: [t] } = await c.query(
      `INSERT INTO report_templates (name, report_type, description, definition, file_name, all_users, roles, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, type, body.description || null, JSON.stringify(def), body.fileName || null, rights.allUsers, rights.roles, pos.n, user.email]);
    return shape(t, true);
  } catch (e) {
    if (e.code === '23505') throw err(`REPORT_NAME_TAKEN: ${name}`, 409);
    throw e;
  }
}

async function update(c, id, body = {}, user) {
  const before = await find(c, id, user);
  const name = body.name !== undefined ? String(body.name || '').trim() : before.name;
  if (!name || name.length > 255) throw err('REPORT_NAME_REQUIRED: 1 to 255 characters');
  const type = body.reportType !== undefined ? String(body.reportType).toUpperCase() : before.report_type;
  if (!TYPES.includes(type)) throw err(`REPORT_TYPE_IS_ONE_OF: ${TYPES.join(', ')}`);
  const def = body.definition !== undefined ? await checkDefinition(c, body.definition, user) : before.definition;
  const rights = await rightsOf(c, body, before);
  const position = body.position !== undefined ? Number(body.position) : before.position;
  if (!Number.isInteger(position) || position < 0) throw err('POSITION_MUST_BE_A_WHOLE_NUMBER');
  try {
    const { rows: [t] } = await c.query(
      `UPDATE report_templates SET name = $2, report_type = $3, description = $4, definition = $5, file_name = $6,
         all_users = $7, roles = $8, position = $9 WHERE id = $1 RETURNING *`,
      [before.id, name, type, body.description !== undefined ? body.description || null : before.description, JSON.stringify(def),
        body.fileName !== undefined ? body.fileName || null : before.file_name, rights.allUsers, rights.roles, position]);
    return shape(t, true);
  } catch (e) {
    if (e.code === '23505') throw err(`REPORT_NAME_TAKEN: ${name}`, 409);
    throw e;
  }
}

async function remove(c, id, user) {
  const t = await find(c, id, user);
  await c.query('DELETE FROM report_templates WHERE id = $1', [t.id]);
  return { deleted: t.id };
}

async function rearrange(c, ids) {
  if (!Array.isArray(ids)) throw err('IDS_MUST_BE_A_LIST');
  const { rows } = await c.query('SELECT id FROM report_templates ORDER BY position, name');
  const known = new Set(rows.map((r) => r.id));
  const named = [...new Set(ids.map(String))];
  for (const id of named) if (!known.has(id)) throw err(`REPORT_TEMPLATE_NOT_FOUND: ${id}`, 404);
  const order = [...named, ...rows.map((r) => r.id).filter((id) => !named.includes(id))];
  for (const [i, id] of order.entries()) await c.query('UPDATE report_templates SET position = $2 WHERE id = $1', [id, i + 1]);
  return { rearranged: ids.length };
}

// --------------------------------------------------------------------------
// Running a report
// --------------------------------------------------------------------------

const RECORD = {
  MEMBER: `SELECT m.id::text AS id, m.member_no AS "memberNo", concat_ws(' ', m.first_name, m.last_name) AS name,
             m.first_name AS "firstName", m.last_name AS "lastName", m.phone, m.email, b.code AS "branchCode", b.name AS "branchName"
           FROM members m LEFT JOIN branches b ON b.id = m.branch_id WHERE m.id::text = $1 OR m.member_no = $1`,
  LOAN: `SELECT l.id::text AS id, l.account_no AS "accountNo", m.member_no AS "memberNo", concat_ws(' ', m.first_name, m.last_name) AS "memberName",
           l.product_id AS "productId", l.status, b.code AS "branchCode"
         FROM loan_accounts l JOIN members m ON m.id = l.member_id LEFT JOIN branches b ON b.id = l.branch_id
         WHERE l.id::text = $1 OR l.account_no = $1`,
  DEPOSIT: `SELECT a.id::text AS id, a.account_no AS "accountNo", m.member_no AS "memberNo", concat_ws(' ', m.first_name, m.last_name) AS "memberName",
              a.product_id AS "productId", a.status, b.code AS "branchCode"
            FROM savings_accounts a JOIN members m ON m.id = a.member_id LEFT JOIN branches b ON b.id = a.branch_id
            WHERE a.id::text = $1 OR a.account_no = $1`,
  BRANCH: 'SELECT id::text AS id, code, name FROM branches WHERE id::text = $1 OR code = $1',
  CENTRE: 'SELECT id::text AS id, code, name FROM centres WHERE id::text = $1 OR code = $1',
};
const RECORD_PERMISSION = { MEMBER: 'VIEW_CLIENT_DETAILS', LOAN: 'VIEW_LOAN_ACCOUNT_DETAILS', DEPOSIT: 'VIEW_SAVINGS_ACCOUNT_DETAILS', BRANCH: 'VIEW_BRANCH_DETAILS', CENTRE: 'VIEW_CENTRE_DETAILS' };

function monthStart(d) { return `${d.slice(0, 7)}-01`; }

/** Parameter values from the request, checked, with their defaults. */
async function parameters(c, def, given = {}) {
  const today = await orgToday(c);
  const out = {};
  for (const p of def.parameters || []) {
    let v = given[p.name];
    if (v === undefined || v === null || v === '') {
      v = p.default === 'TODAY' ? today : p.default === 'MONTH_START' ? monthStart(today) : p.default === 'YEAR_START' ? `${today.slice(0, 4)}-01-01` : p.default;
    }
    if (v === undefined || v === null || v === '') {
      if (p.required) throw err(`PARAMETER_REQUIRED: ${p.name}`);
      out[p.name] = null;
      continue;
    }
    if (p.type === 'DATE' && !ISO.test(String(v))) throw err(`PARAMETER_${p.name}_IS_A_DATE: yyyy-MM-dd`);
    if (p.type === 'NUMBER' && !Number.isFinite(Number(v))) throw err(`PARAMETER_${p.name}_IS_A_NUMBER`);
    if (p.type === 'SELECTION' && !p.values.map(String).includes(String(v))) throw err(`PARAMETER_${p.name}_IS_ONE_OF: ${p.values.join(', ')}`);
    if (p.type === 'BOOLEAN') v = String(v) === 'true';
    if (p.type === 'BRANCH') {
      const { rows: [b] } = await c.query('SELECT code FROM branches WHERE id::text = $1 OR code = $1', [String(v)]);
      if (!b) throw err(`BRANCH_NOT_FOUND: ${v}`, 404);
      v = b.code;
    }
    out[p.name] = p.type === 'NUMBER' ? Number(v) : v;
  }
  return out;
}

/** Replace placeholders in a value (strings, and strings inside lists and objects). */
function fill(v, ctx) {
  if (typeof v === 'string') {
    const whole = v.match(/^\{\{\s*([a-zA-Z]+)\.?([A-Za-z0-9_]*)\s*\}\}$/);
    const look = (a, b) => (a === 'today' ? ctx.today : ctx[a] && b ? ctx[a][b] : undefined);
    // A value that is one placeholder keeps the placeholder's type.
    if (whole) { const x = look(whole[1], whole[2]); return x === undefined ? null : x; }
    return v.replace(/\{\{\s*([a-zA-Z]+)\.?([A-Za-z0-9_]*)\s*\}\}/g, (_, a, b) => { const x = look(a, b); return x === undefined || x === null ? '' : String(x); });
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ctx)]));
  return v;
}

const num = (col) => ({ ...col, num: true });

/** A built-in report as columns and rows. */
async function builtin(c, name, params, user) {
  const need = REPORTS[name];
  if (!PERMS.can(user, need)) throw err(`PERMISSION_REQUIRED: ${need} for the ${name} section`, 403);
  const p = Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== null && v !== ''));
  if (name === 'balance-sheet') {
    const b = await R.balanceSheet(c, { asAt: p.asAt || null, month: p.month || null, branchId: p.branchId || null });
    return {
      columns: [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, num({ key: 'amount', label: 'Amount' })],
      rows: [...b.assets.map((r) => ({ section: 'Assets', ...r })), { section: 'Assets', name: 'Total assets', amount: b.totalAssets },
        ...b.liabilities.map((r) => ({ section: 'Liabilities', ...r })), { section: 'Liabilities', name: 'Total liabilities', amount: b.totalLiabilities },
        ...b.equity.map((r) => ({ section: 'Equity', ...r })), { section: 'Equity', name: 'Total equity', amount: b.totalEquity }],
    };
  }
  if (name === 'income-statement') {
    const s = await R.incomeStatement(c, { from: p.from || null, to: p.to || null, branchId: p.branchId || null });
    return {
      columns: [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, num({ key: 'amount', label: 'Amount' })],
      rows: [...s.income.map((r) => ({ section: 'Income', ...r })), ...s.expenses.map((r) => ({ section: 'Expenses', ...r })),
        { section: '', name: 'Surplus', amount: s.surplus }],
    };
  }
  if (name === 'trial-balance') {
    const t = await acct.trialBalance(c, { from: p.from || null, to: p.to || null, branchId: p.branchId || null });
    return {
      columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, num({ key: 'openingBalance', label: 'Opening' }),
        num({ key: 'debit', label: 'Debits' }), num({ key: 'credit', label: 'Credits' }), num({ key: 'closingBalance', label: 'Closing' })],
      rows: t.rows, totals: { debit: t.totals.debit, credit: t.totals.credit },
    };
  }
  if (name === 'portfolio-at-risk') {
    const r = await PF.portfolioAtRisk(c, { asAt: p.asAt || null, branchId: p.branchId || null, productId: p.productId || null, creditOfficer: p.creditOfficer || null });
    return {
      columns: [{ key: 'measure', label: 'Measure' }, num({ key: 'loans', label: 'Loans' }), num({ key: 'amount', label: 'Amount' }), num({ key: 'percent', label: 'Percent' })],
      rows: [...Object.entries(r.par).map(([k, v]) => ({ measure: k, loans: v.loans, amount: v.outstanding, percent: v.percent })),
        ...Object.entries(r.var).map(([k, v]) => ({ measure: k, loans: v.loans, amount: v.overdue, percent: v.percent }))],
    };
  }
  if (name === 'risk') {
    const r = await PF.riskReport(c, { asAt: p.asAt || null, minDaysLate: p.minDaysLate ?? 1, groupBy: p.groupBy || 'BRANCH', branchId: p.branchId || null });
    return {
      columns: [{ key: 'label', label: r.groupBy }, num({ key: 'loans', label: 'Loans' }), num({ key: 'principalOutstanding', label: 'Outstanding' }),
        num({ key: 'principalOverdue', label: 'Overdue' }), num({ key: 'provisionRequired', label: 'Provision' })],
      rows: r.groups,
    };
  }
  const o = await IND.compute(c, { entityType: p.entityType || 'ORGANIZATION', entityId: p.entityId || null, codes: p.indicators || null });
  return {
    columns: [{ key: 'group', label: 'Group' }, { key: 'label', label: 'Indicator' }, num({ key: 'value', label: 'Value' })],
    rows: o.indicators,
  };
}

/**
 * Run a report for a user: { title, header, sections: [{ title, type,
 * columns, rows, totals, text, truncated }] }. `recordId` names the record
 * for a template shown on one (a member number, account number, code or id).
 */
async function run(c, id, { parameters: given = {}, recordId = null } = {}, user, tenant = {}) {
  if (!PERMS.can(user, 'VIEW_REPORTS')) throw err('PERMISSION_REQUIRED: VIEW_REPORTS', 403);
  const t = await find(c, id, user);
  const def = t.definition;
  let record = null;
  if (t.report_type !== 'OTHER') {
    if (!recordId) throw err(`RECORD_REQUIRED: this report runs on a ${t.report_type.toLowerCase()}`);
    if (!PERMS.can(user, RECORD_PERMISSION[t.report_type])) throw err(`PERMISSION_REQUIRED: ${RECORD_PERMISSION[t.report_type]}`, 403);
    const { rows: [r] } = await c.query(RECORD[t.report_type], [String(recordId)]);
    if (!r) throw err(`${t.report_type}_NOT_FOUND: ${recordId}`, 404);
    record = r;
  }
  const params = await parameters(c, def, given);
  const today = await orgToday(c);
  const ctx = { record: record || {}, param: params, today, user: { email: user.email, role: user.roleCode || user.role }, organization: { name: tenant.name || '' } };
  const sections = [];
  for (const s of def.sections) {
    const title = s.title ? fill(s.title, ctx) : null;
    if (s.type === 'TEXT') { sections.push({ title, type: 'TEXT', text: fill(s.text, ctx) }); continue; }
    if (s.view) {
      const view = fill(s.view, ctx);
      // A filter whose placeholder came to nothing is left out, so an optional parameter can be left empty.
      view.filters = (s.view.filters || []).map((o, i) => ({ o, f: view.filters[i] }))
        .filter(({ o, f }) => !(typeof o.value === 'string' && /\{\{/.test(o.value) && (f.value === null || f.value === '')))
        .map(({ f }) => f);
      const out = await V.execute(c, view, user, { all: true });
      const limit = s.limit || 1000;
      sections.push({
        title, type: s.type, columns: out.columns.map((col) => ({ key: col.key, label: col.label, num: ['NUMBER', 'MONEY'].includes(col.type) })),
        rows: out.items.slice(0, limit), totals: out.totals, total: out.total, truncated: out.total > limit,
      });
      continue;
    }
    const b = await builtin(c, s.report, fill(s.params || {}, ctx), user);
    sections.push({ title, type: s.type, columns: b.columns, rows: b.rows, totals: b.totals || null, total: b.rows.length, truncated: false });
  }
  return {
    report: { id: t.id, name: t.name, reportType: t.report_type },
    title: fill(def.title || t.name, ctx),
    record, parameters: params, generatedAt: new Date().toISOString(), generatedBy: user.email,
    footer: def.footer ? fill(def.footer, ctx) : null,
    landscape: Boolean(def.landscape),
    sections,
  };
}

module.exports = { TYPES, PARAM_TYPES, REPORTS, checkDefinition, list, get, find, create, update, remove, rearrange, run };
