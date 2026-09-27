'use strict';

const PF = require('./portfolio');

/**
 * Indicators (the reference platform's Reporting > Indicators and the dashboard's Indicators
 * widget): figures on outreach, deposits, loans, risk and the organization,
 * for the whole organization or for one branch, centre, loan product,
 * deposit product or credit officer. They are the position now; the
 * portfolio report gives them over time.
 *
 * The reference platform's indicators for groups and lines of credit have no counterpart
 * here: the platform has neither. An indicator that does not apply to the
 * scope (deposit figures for a loan product) is null with the reason.
 */

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (a, b) => (Number(b) > 0 ? round2((Number(a) / Number(b)) * 100) : 0);

const GROUPS = ['OUTREACH', 'DEPOSITS', 'LOANS', 'RISK', 'ORGANIZATION'];

/** code: [group, label, kind] */
const CATALOG = {
  CLIENTS: ['OUTREACH', 'Clients (not exited)', 'COUNT'],
  ACTIVE_CLIENTS: ['OUTREACH', 'Active clients', 'COUNT'],
  NEW_CLIENTS_THIS_MONTH: ['OUTREACH', 'Clients joined this month', 'COUNT'],
  ACTIVE_BORROWERS: ['OUTREACH', 'Active borrowers', 'COUNT'],
  ACTIVE_SAVERS: ['OUTREACH', 'Active savers', 'COUNT'],
  FEMALE_CLIENTS_PERCENT: ['OUTREACH', 'Female clients', 'PERCENT'],
  FEMALE_BORROWERS_PERCENT: ['OUTREACH', 'Female borrowers', 'PERCENT'],

  DEPOSIT_ACCOUNTS: ['DEPOSITS', 'Active deposit accounts', 'COUNT'],
  DEPOSIT_BALANCE: ['DEPOSITS', 'Deposit balance', 'AMOUNT'],
  AVERAGE_DEPOSIT_BALANCE: ['DEPOSITS', 'Average deposit balance', 'AMOUNT'],
  DEPOSIT_INTEREST_ACCRUED: ['DEPOSITS', 'Deposit interest accrued, not applied', 'AMOUNT'],
  OVERDRAWN_ACCOUNTS: ['DEPOSITS', 'Overdrawn deposit accounts', 'COUNT'],
  OVERDRAFT_BALANCE: ['DEPOSITS', 'Overdraft balance', 'AMOUNT'],

  GROSS_LOAN_PORTFOLIO: ['LOANS', 'Gross loan portfolio', 'AMOUNT'],
  LOANS_OUTSTANDING: ['LOANS', 'Loans outstanding', 'COUNT'],
  AVERAGE_LOAN_BALANCE: ['LOANS', 'Average outstanding loan balance', 'AMOUNT'],
  INTEREST_OUTSTANDING: ['LOANS', 'Interest outstanding', 'AMOUNT'],
  FEES_OUTSTANDING: ['LOANS', 'Fees outstanding', 'AMOUNT'],
  PENALTIES_OUTSTANDING: ['LOANS', 'Penalties outstanding', 'AMOUNT'],
  LOANS_PENDING_APPROVAL: ['LOANS', 'Loans pending approval', 'COUNT'],
  AMOUNT_PENDING_APPROVAL: ['LOANS', 'Amount pending approval', 'AMOUNT'],
  LOANS_PENDING_DISBURSEMENT: ['LOANS', 'Loans approved, pending disbursement', 'COUNT'],
  AMOUNT_PENDING_DISBURSEMENT: ['LOANS', 'Amount pending disbursement', 'AMOUNT'],
  DISBURSED_THIS_MONTH: ['LOANS', 'Disbursed this month', 'AMOUNT'],
  LOANS_DISBURSED_THIS_MONTH: ['LOANS', 'Loans disbursed this month', 'COUNT'],
  LOAN_TO_DEPOSIT_RATIO: ['LOANS', 'Loans to deposits', 'PERCENT'],

  LOANS_IN_ARREARS: ['RISK', 'Loans in arrears', 'COUNT'],
  AMOUNT_IN_ARREARS: ['RISK', 'Amount in arrears (principal, interest, fees)', 'AMOUNT'],
  INTEREST_IN_SUSPENSE: ['RISK', 'Interest in suspense', 'AMOUNT'],
  PAR: ['RISK', 'PAR', 'PERCENT'],
  PAR_OVER_7: ['RISK', 'PAR over 7 days', 'PERCENT'],
  PAR_OVER_15: ['RISK', 'PAR over 15 days', 'PERCENT'],
  PAR_7_30: ['RISK', 'PAR 7-30 days', 'PERCENT'],
  PAR_OVER_30: ['RISK', 'PAR over 30 days', 'PERCENT'],
  PAR_OVER_90: ['RISK', 'PAR over 90 days', 'PERCENT'],
  PAR_90_180: ['RISK', 'PAR 90-180 days', 'PERCENT'],
  PAR_180_360: ['RISK', 'PAR 180-360 days', 'PERCENT'],
  VAR: ['RISK', 'VAR', 'PERCENT'],
  VAR_OVER_7: ['RISK', 'VAR over 7 days', 'PERCENT'],
  VAR_OVER_15: ['RISK', 'VAR over 15 days', 'PERCENT'],
  VAR_OVER_30: ['RISK', 'VAR over 30 days', 'PERCENT'],
  VAR_OVER_90: ['RISK', 'VAR over 90 days', 'PERCENT'],

  BRANCHES: ['ORGANIZATION', 'Active branches', 'COUNT'],
  CENTRES: ['ORGANIZATION', 'Active centres', 'COUNT'],
  USERS: ['ORGANIZATION', 'Active users', 'COUNT'],
  CREDIT_OFFICERS: ['ORGANIZATION', 'Credit officers with running loans', 'COUNT'],
  BORROWERS_PER_OFFICER: ['ORGANIZATION', 'Borrowers per credit officer', 'RATIO'],
  PORTFOLIO_PER_OFFICER: ['ORGANIZATION', 'Portfolio per credit officer', 'AMOUNT'],
};

const ENTITY_TYPES = ['ORGANIZATION', 'BRANCH', 'CENTRE', 'LOAN_PRODUCT', 'DEPOSIT_PRODUCT', 'CREDIT_OFFICER'];

function catalog() {
  return Object.entries(CATALOG).map(([code, [group, label, kind]]) => ({ code, group, label, kind }));
}

/** The entity a set of indicators is for, checked; returns its filters. */
async function entityOf(c, entityType = 'ORGANIZATION', entityId = null) {
  const type = String(entityType || 'ORGANIZATION').toUpperCase();
  if (!ENTITY_TYPES.includes(type)) throw err(`UNKNOWN_ENTITY_TYPE: ${entityType} (use ${ENTITY_TYPES.join(', ')})`);
  if (type === 'ORGANIZATION') return { type, id: null, label: 'Organization' };
  if (!entityId) throw err(`ENTITY_ID_REQUIRED for ${type}`);
  const q = {
    BRANCH: ["SELECT id::text AS id, code || ' ' || name AS label FROM branches WHERE id::text = $1 OR code = $1", 'BRANCH_NOT_FOUND'],
    CENTRE: ["SELECT id::text AS id, code || ' ' || name AS label FROM centres WHERE id::text = $1 OR code = $1", 'CENTRE_NOT_FOUND'],
    LOAN_PRODUCT: ['SELECT id, name AS label FROM loan_products WHERE id = $1', 'LOAN_PRODUCT_NOT_FOUND'],
    DEPOSIT_PRODUCT: ['SELECT id, name AS label FROM savings_products WHERE id = $1', 'DEPOSIT_PRODUCT_NOT_FOUND'],
  }[type];
  if (q) {
    const { rows: [r] } = await c.query(q[0], [String(entityId)]);
    if (!r) throw err(`${q[1]}: ${entityId}`, 404);
    return { type, id: r.id, label: r.label };
  }
  return { type, id: String(entityId).toLowerCase(), label: String(entityId) };
}

/**
 * The SQL filters for a scope, over members (m), loans (l) and deposit
 * accounts (a). `applies` says which families of indicator make sense.
 */
function filtersOf(e) {
  const f = { member: 'TRUE', loan: 'TRUE', deposit: 'TRUE', params: [], applies: { members: true, loans: true, deposits: true } };
  if (e.type === 'ORGANIZATION') return f;
  f.params = [e.id];
  if (e.type === 'BRANCH') {
    f.member = 'm.branch_id::text = $1'; f.loan = 'l.branch_id::text = $1'; f.deposit = 'a.branch_id::text = $1';
  } else if (e.type === 'CENTRE') {
    f.member = 'm.centre_id::text = $1'; f.loan = 'm.centre_id::text = $1'; f.deposit = 'm.centre_id::text = $1';
  } else if (e.type === 'CREDIT_OFFICER') {
    f.member = 'lower(m.credit_officer) = $1'; f.loan = 'lower(COALESCE(l.credit_officer, m.credit_officer)) = $1'; f.deposit = 'lower(m.credit_officer) = $1';
  } else if (e.type === 'LOAN_PRODUCT') {
    f.loan = 'l.product_id = $1'; f.member = 'FALSE'; f.deposit = 'FALSE';
    f.applies = { members: false, loans: true, deposits: false };
  } else if (e.type === 'DEPOSIT_PRODUCT') {
    f.deposit = 'a.product_id = $1'; f.member = 'FALSE'; f.loan = 'FALSE';
    f.applies = { members: false, loans: false, deposits: true };
  }
  return f;
}

const NOT_APPLICABLE = 'NOT_APPLICABLE_TO_SCOPE';

/**
 * Compute indicators for a scope. `codes` limits the set (default all).
 * Returns { entity, generatedAt, indicators: [{ code, group, label, kind, value, reason? }] }.
 */
async function compute(c, { entityType = 'ORGANIZATION', entityId = null, codes = null } = {}) {
  const e = await entityOf(c, entityType, entityId);
  const want = codes && codes.length ? codes.map((x) => String(x).toUpperCase()) : Object.keys(CATALOG);
  const unknown = want.filter((x) => !CATALOG[x]);
  if (unknown.length) throw err(`UNKNOWN_INDICATORS: ${unknown.join(', ')}`);
  const f = filtersOf(e);
  const v = {};
  const na = new Set();

  // Outreach.
  const { rows: [o] } = await c.query(
    `WITH mem AS (SELECT m.* FROM members m WHERE ${f.member}),
          borrowers AS (SELECT DISTINCT l.member_id FROM loan_accounts l JOIN members m ON m.id = l.member_id
                        WHERE l.status IN ('ACTIVE','IN_ARREARS','LOCKED') AND ${f.loan}),
          savers AS (SELECT DISTINCT a.member_id FROM savings_accounts a JOIN members m ON m.id = a.member_id
                     WHERE a.status = 'ACTIVE' AND a.balance > 0 AND ${f.deposit})
     SELECT (SELECT count(*) FROM mem WHERE status NOT IN ('EXITED','DECEASED'))::int AS clients,
            (SELECT count(*) FROM mem WHERE status = 'ACTIVE')::int AS active_clients,
            (SELECT count(*) FROM mem WHERE date_trunc('month', joined_on) = date_trunc('month', current_date))::int AS new_clients,
            (SELECT count(*) FROM mem WHERE status NOT IN ('EXITED','DECEASED') AND gender = 'FEMALE')::int AS female_clients,
            (SELECT count(*) FROM borrowers)::int AS borrowers,
            (SELECT count(*) FROM borrowers b JOIN members m ON m.id = b.member_id WHERE m.gender = 'FEMALE')::int AS female_borrowers,
            (SELECT count(*) FROM savers)::int AS savers`, f.params);
  if (f.applies.members) {
    v.CLIENTS = o.clients; v.ACTIVE_CLIENTS = o.active_clients; v.NEW_CLIENTS_THIS_MONTH = o.new_clients;
    v.FEMALE_CLIENTS_PERCENT = pct(o.female_clients, o.clients);
  } else ['CLIENTS', 'ACTIVE_CLIENTS', 'NEW_CLIENTS_THIS_MONTH', 'FEMALE_CLIENTS_PERCENT'].forEach((k) => na.add(k));
  if (f.applies.loans) { v.ACTIVE_BORROWERS = o.borrowers; v.FEMALE_BORROWERS_PERCENT = pct(o.female_borrowers, o.borrowers); } else { na.add('ACTIVE_BORROWERS'); na.add('FEMALE_BORROWERS_PERCENT'); }
  if (f.applies.deposits) v.ACTIVE_SAVERS = o.savers; else na.add('ACTIVE_SAVERS');

  // Deposits.
  if (f.applies.deposits) {
    const { rows: [d] } = await c.query(
      `SELECT count(*)::int AS n,
              COALESCE(SUM(GREATEST(a.balance, 0)), 0) AS balance,
              COALESCE(SUM(a.interest_accrued), 0) AS accrued,
              count(*) FILTER (WHERE a.balance < 0)::int AS overdrawn,
              COALESCE(-SUM(LEAST(a.balance, 0)), 0) AS overdraft
       FROM savings_accounts a JOIN members m ON m.id = a.member_id
       WHERE a.status = 'ACTIVE' AND ${f.deposit}`, f.params);
    v.DEPOSIT_ACCOUNTS = d.n; v.DEPOSIT_BALANCE = round2(d.balance);
    v.AVERAGE_DEPOSIT_BALANCE = d.n ? round2(d.balance / d.n) : 0;
    v.DEPOSIT_INTEREST_ACCRUED = round2(d.accrued); v.OVERDRAWN_ACCOUNTS = d.overdrawn; v.OVERDRAFT_BALANCE = round2(d.overdraft);
  } else Object.keys(CATALOG).filter((k) => CATALOG[k][0] === 'DEPOSITS').forEach((k) => na.add(k));

  // Loans and risk.
  if (f.applies.loans) {
    const scope = {
      BRANCH: { branchId: e.id }, CENTRE: { centreId: e.id }, LOAN_PRODUCT: { productId: e.id }, CREDIT_OFFICER: { creditOfficer: e.id },
    }[e.type] || {};
    const p = await PF.positions(c, scope);
    const m = PF.measures(p.rows);
    const rows = p.rows;
    const sum = (k) => round2(rows.reduce((s, r) => s + r[k], 0));
    v.GROSS_LOAN_PORTFOLIO = m.glp; v.LOANS_OUTSTANDING = rows.length;
    v.AVERAGE_LOAN_BALANCE = rows.length ? round2(m.glp / rows.length) : 0;
    v.INTEREST_OUTSTANDING = sum('interest_outstanding'); v.FEES_OUTSTANDING = sum('fees_outstanding'); v.PENALTIES_OUTSTANDING = sum('penalty_outstanding');
    const late = rows.filter((r) => r.days_late > 0);
    v.LOANS_IN_ARREARS = late.length;
    v.AMOUNT_IN_ARREARS = round2(late.reduce((s, r) => s + r.principal_overdue + r.interest_overdue + r.fees_overdue, 0));
    v.INTEREST_IN_SUSPENSE = m.interestInSuspense;
    for (const k of ['PAR', 'PAR_OVER_7', 'PAR_OVER_15', 'PAR_7_30', 'PAR_OVER_30', 'PAR_OVER_90', 'PAR_90_180', 'PAR_180_360']) v[k] = m.par[k].percent;
    for (const k of ['VAR', 'VAR_OVER_7', 'VAR_OVER_15', 'VAR_OVER_30', 'VAR_OVER_90']) v[k] = m.var[k].percent;

    const { rows: [q] } = await c.query(
      `SELECT count(*) FILTER (WHERE l.status IN ('PARTIAL_APPLICATION','PENDING_APPROVAL'))::int AS pending_n,
              COALESCE(SUM(l.principal) FILTER (WHERE l.status IN ('PARTIAL_APPLICATION','PENDING_APPROVAL')), 0) AS pending_amt,
              count(*) FILTER (WHERE l.status = 'APPROVED')::int AS approved_n,
              COALESCE(SUM(l.principal - l.principal_disbursed) FILTER (WHERE l.status = 'APPROVED'), 0) AS approved_amt
       FROM loan_accounts l JOIN members m ON m.id = l.member_id WHERE ${f.loan}`, f.params);
    v.LOANS_PENDING_APPROVAL = q.pending_n; v.AMOUNT_PENDING_APPROVAL = round2(q.pending_amt);
    v.LOANS_PENDING_DISBURSEMENT = q.approved_n; v.AMOUNT_PENDING_DISBURSEMENT = round2(q.approved_amt);
    const { rows: [dm] } = await c.query(
      `SELECT count(DISTINCT t.loan_account_id)::int AS n, COALESCE(SUM(t.amount), 0) AS amt
       FROM transactions t JOIN loan_accounts l ON l.id = t.loan_account_id JOIN members m ON m.id = l.member_id
       WHERE t.kind = 'LOAN_DISBURSEMENT' AND t.reversed_by IS NULL AND NOT (COALESCE(t.allocation, '{}'::jsonb) ? 'imported')
         AND date_trunc('month', t.value_date) = date_trunc('month', current_date) AND ${f.loan}`, f.params);
    v.LOANS_DISBURSED_THIS_MONTH = dm.n; v.DISBURSED_THIS_MONTH = round2(dm.amt);
    if (f.applies.deposits) v.LOAN_TO_DEPOSIT_RATIO = pct(v.GROSS_LOAN_PORTFOLIO, v.DEPOSIT_BALANCE);
    else na.add('LOAN_TO_DEPOSIT_RATIO');

    const officers = new Set(rows.map((r) => (r.credit_officer || '').toLowerCase()).filter(Boolean));
    v.CREDIT_OFFICERS = officers.size;
    const withOfficer = rows.filter((r) => r.credit_officer);
    v.BORROWERS_PER_OFFICER = officers.size ? round2(new Set(withOfficer.map((r) => r.member_id)).size / officers.size) : 0;
    v.PORTFOLIO_PER_OFFICER = officers.size ? round2(withOfficer.reduce((s, r) => s + r.principal_outstanding, 0) / officers.size) : 0;
  } else {
    Object.keys(CATALOG).filter((k) => ['LOANS', 'RISK'].includes(CATALOG[k][0])).forEach((k) => na.add(k));
    ['CREDIT_OFFICERS', 'BORROWERS_PER_OFFICER', 'PORTFOLIO_PER_OFFICER'].forEach((k) => na.add(k));
  }

  // Organization.
  const { rows: [g] } = await c.query(
    `SELECT (SELECT count(*) FROM branches WHERE status = 'ACTIVE' AND ($1::text IS NULL OR id::text = $1))::int AS branches,
            (SELECT count(*) FROM centres WHERE status = 'ACTIVE' AND ($1::text IS NULL OR branch_id::text = $1))::int AS centres,
            (SELECT count(*) FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
              WHERE t.schema_name = current_schema() AND u.status = 'ACTIVE' AND ($1::text IS NULL OR u.branch_id::text = $1))::int AS users`,
    [e.type === 'BRANCH' ? e.id : null]);
  if (['ORGANIZATION', 'BRANCH'].includes(e.type)) { v.BRANCHES = g.branches; v.CENTRES = g.centres; v.USERS = g.users; } else ['BRANCHES', 'CENTRES', 'USERS'].forEach((k) => na.add(k));

  return {
    entity: e,
    generatedAt: new Date().toISOString(),
    indicators: want.map((code) => {
      const [group, label, kind] = CATALOG[code];
      if (na.has(code) || v[code] === undefined) return { code, group, label, kind, value: null, reason: NOT_APPLICABLE };
      return { code, group, label, kind, value: v[code] };
    }),
  };
}

// --------------------------------------------------------------------------
// Saved indicator reports
// --------------------------------------------------------------------------

function shape(r) {
  return {
    id: r.id, name: r.name, description: r.description, entityType: r.entity_type, entityId: r.entity_id,
    indicators: r.indicators, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function list(c) {
  const { rows } = await c.query('SELECT * FROM indicator_reports ORDER BY lower(name)');
  return rows.map(shape);
}

async function find(c, id) {
  const { rows: [r] } = await c.query('SELECT * FROM indicator_reports WHERE id::text = $1 OR name = $1', [String(id)]);
  if (!r) throw err('INDICATOR_REPORT_NOT_FOUND', 404);
  return r;
}

async function checked(c, body, before = null) {
  const name = body.name !== undefined ? String(body.name || '').trim() : before?.name;
  if (!name) throw err('NAME_REQUIRED');
  if (name.length > 255) throw err('NAME_TOO_LONG: at most 255 characters');
  const entityType = body.entityType !== undefined ? body.entityType : before?.entity_type || 'ORGANIZATION';
  const entityId = body.entityId !== undefined ? body.entityId : before?.entity_id || null;
  const e = await entityOf(c, entityType, entityId);
  const indicators = body.indicators !== undefined ? body.indicators : before?.indicators;
  if (!Array.isArray(indicators) || !indicators.length) throw err('INDICATORS_REQUIRED: a list of indicator codes');
  const codes = [...new Set(indicators.map((x) => String(x).toUpperCase()))];
  const unknown = codes.filter((x) => !CATALOG[x]);
  if (unknown.length) throw err(`UNKNOWN_INDICATORS: ${unknown.join(', ')}`);
  const description = body.description !== undefined ? (body.description ? String(body.description) : null) : before?.description ?? null;
  return { name, description, entityType: e.type, entityId: e.id, indicators: codes };
}

async function create(c, body, { createdBy } = {}) {
  const x = await checked(c, body || {});
  const { rows: [r] } = await c.query(
    `INSERT INTO indicator_reports (name, description, entity_type, entity_id, indicators, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (name) DO NOTHING RETURNING *`,
    [x.name, x.description, x.entityType, x.entityId, x.indicators, createdBy || null]);
  if (!r) throw err(`INDICATOR_REPORT_NAME_TAKEN: ${x.name}`, 409);
  return shape(r);
}

async function update(c, id, body) {
  const before = await find(c, id);
  const x = await checked(c, body || {}, before);
  const { rows: [clash] } = await c.query('SELECT 1 FROM indicator_reports WHERE name = $1 AND id <> $2', [x.name, before.id]);
  if (clash) throw err(`INDICATOR_REPORT_NAME_TAKEN: ${x.name}`, 409);
  const { rows: [r] } = await c.query(
    `UPDATE indicator_reports SET name = $2, description = $3, entity_type = $4, entity_id = $5, indicators = $6
     WHERE id = $1 RETURNING *`, [before.id, x.name, x.description, x.entityType, x.entityId, x.indicators]);
  return shape(r);
}

async function remove(c, id) {
  const r = await find(c, id);
  await c.query('DELETE FROM indicator_reports WHERE id = $1', [r.id]);
  return { deleted: r.id };
}

/** A saved report with its values. */
async function run(c, id) {
  const r = await find(c, id);
  const out = await compute(c, { entityType: r.entity_type, entityId: r.entity_id, codes: r.indicators });
  return { report: shape(r), ...out };
}

module.exports = { GROUPS, CATALOG, ENTITY_TYPES, catalog, entityOf, compute, list, find, create, update, remove, run };
