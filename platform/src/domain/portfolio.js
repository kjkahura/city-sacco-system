'use strict';

const { orgToday } = require('../lib/orgDate');
const { pageQuery } = require('../lib/page');

/**
 * The loan portfolio, loan by loan, as at a date: what each running loan
 * owes, what of it is overdue and how many days late it is. Every portfolio
 * report reads these positions (PAR and VAR, the risk report, the indicators
 * and the management reports), so they cannot disagree about which loans are
 * in trouble.
 *
 * Today's positions are computed from the loan tables. A past date is read
 * from loan_daily_positions, which the end of day writes for its business
 * date (snapshot below): the loan tables only hold the present, and working a
 * past day out of them gives a figure the book never showed that day (an
 * installment paid since no longer shows as late, the principal has moved
 * on). A past date with no positions is refused with the earliest date that
 * has them. A future date is refused.
 *
 * Days late: days since the oldest installment still unpaid fell due, the
 * measure the provisioning run and the arrears job use.
 */

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Running loans. LOCKED is one: a loan locked for arrears still owes its
// principal and is usually the latest in the book.
const RUNNING = "('ACTIVE','IN_ARREARS','LOCKED')";

/** Positions of the running loans now, with days late counted to $1. */
const LIVE_SQL = `
  SELECT l.id AS loan_id, l.account_no, l.member_id, l.product_id, l.branch_id, m.centre_id,
         COALESCE(l.credit_officer, m.credit_officer) AS credit_officer, l.status, l.disbursed_on,
         round(GREATEST(l.principal_disbursed - l.principal_paid, 0), 2) AS principal_outstanding,
         round(GREATEST(l.interest_accrued - l.interest_paid, 0), 2) AS interest_outstanding,
         round(GREATEST(l.fees_due - l.fees_paid, 0) + GREATEST(COALESCE(l.ns_fees_due, 0) - COALESCE(l.ns_fees_paid, 0), 0), 2) AS fees_outstanding,
         round(GREATEST(l.penalty_accrued - l.penalty_paid, 0), 2) AS penalty_outstanding,
         round(COALESCE(i.principal_overdue, 0), 2) AS principal_overdue,
         round(COALESCE(i.interest_overdue, 0), 2) AS interest_overdue,
         round(COALESCE(i.fees_overdue, 0), 2) AS fees_overdue,
         COALESCE(i.days_late, 0)::int AS days_late
  FROM loan_accounts l
  JOIN members m ON m.id = l.member_id
  LEFT JOIN (
    SELECT loan_id,
           SUM(GREATEST(principal_due - principal_paid, 0)) AS principal_overdue,
           SUM(GREATEST(interest_due - interest_paid, 0)) AS interest_overdue,
           SUM(GREATEST(fee_due - fee_paid, 0)) AS fees_overdue,
           GREATEST(0, MAX($1::date - due_date)) AS days_late
    FROM loan_installments
    WHERE status <> 'PAID' AND due_date < $1::date
    GROUP BY loan_id
  ) i ON i.loan_id = l.id
  WHERE l.status IN ${RUNNING}`;

const SNAPSHOT_SQL = `
  SELECT loan_id, account_no, member_id, product_id, branch_id, centre_id, credit_officer, status, disbursed_on,
         principal_outstanding, interest_outstanding, fees_outstanding, penalty_outstanding,
         principal_overdue, interest_overdue, fees_overdue, days_late
  FROM loan_daily_positions WHERE business_date = $1::date`;

/**
 * Filters (id or code for a branch, centre or product; the officer's email).
 * Returns the WHERE clause over the positions ($2 on) and its parameters.
 */
async function scope(c, { branchId = null, centreId = null, productId = null, creditOfficer = null } = {}) {
  const out = { branch: null, centre: null, product: null, creditOfficer: creditOfficer || null };
  if (branchId) {
    const { rows: [b] } = await c.query('SELECT id, code, name FROM branches WHERE id::text = $1 OR code = $1', [String(branchId)]);
    if (!b) throw err(`BRANCH_NOT_FOUND: ${branchId}`, 404);
    out.branch = b;
  }
  if (centreId) {
    const { rows: [ce] } = await c.query('SELECT id, code, name FROM centres WHERE id::text = $1 OR code = $1', [String(centreId)]);
    if (!ce) throw err(`CENTRE_NOT_FOUND: ${centreId}`, 404);
    out.centre = ce;
  }
  if (productId) {
    const { rows: [p] } = await c.query('SELECT id, name FROM loan_products WHERE id = $1', [String(productId)]);
    if (!p) throw err(`LOAN_PRODUCT_NOT_FOUND: ${productId}`, 404);
    out.product = p;
  }
  return out;
}

function whereOf(s, first = 2) {
  const conds = [];
  const params = [];
  const add = (sql, v) => { params.push(v); conds.push(sql.replace('?', `$${first + params.length - 1}`)); };
  if (s.branch) add('branch_id = ?::uuid', s.branch.id);
  if (s.centre) add('centre_id = ?::uuid', s.centre.id);
  if (s.product) add('product_id = ?', s.product.id);
  if (s.creditOfficer) add('lower(credit_officer) = lower(?)', s.creditOfficer);
  return { sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/** The earliest and latest dates with stored positions. */
async function snapshotRange(c) {
  const { rows: [r] } = await c.query('SELECT min(business_date)::text AS earliest, max(business_date)::text AS latest, count(*)::int AS days FROM portfolio_snapshots');
  return r;
}

/**
 * Where the positions for a date come from: { asAt, source, sql, takenAt }.
 * `sql` selects the positions with the date as $1.
 */
async function sourceFor(c, asAt) {
  const today = await orgToday(c);
  const date = asAt ? String(asAt).slice(0, 10) : today;
  if (!ISO.test(date)) throw err(`INVALID_DATE: ${asAt}`, 400);
  if (date > today) throw err(`AS_AT_IN_THE_FUTURE: ${date} (today is ${today})`, 400);
  if (date === today) return { asAt: date, source: 'LIVE', sql: LIVE_SQL, takenAt: null };
  const { rows: [s] } = await c.query('SELECT taken_at FROM portfolio_snapshots WHERE business_date = $1::date', [date]);
  if (!s) {
    const range = await snapshotRange(c);
    throw Object.assign(err(`NO_PORTFOLIO_POSITIONS_FOR_DATE: ${date}${range.earliest ? ` (positions are held from ${range.earliest})` : ' (none are held yet)'}`, 409), { earliest: range.earliest });
  }
  return { asAt: date, source: 'SNAPSHOT', sql: SNAPSHOT_SQL, takenAt: s.taken_at };
}

/** All positions for a date and scope. */
async function positions(c, { asAt = null, ...filters } = {}) {
  const src = await sourceFor(c, asAt);
  const s = await scope(c, filters);
  const w = whereOf(s);
  const { rows } = await c.query(`SELECT * FROM (${src.sql}) p ${w.sql} ORDER BY account_no`, [src.asAt, ...w.params]);
  return { ...src, scope: scopeOut(s), rows: rows.map(numeric) };
}

const NUM = ['principal_outstanding', 'interest_outstanding', 'fees_outstanding', 'penalty_outstanding',
  'principal_overdue', 'interest_overdue', 'fees_overdue'];
function numeric(r) {
  const o = { ...r };
  for (const k of NUM) o[k] = round2(o[k]);
  return o;
}
function scopeOut(s) {
  return {
    branch: s.branch ? { id: s.branch.id, code: s.branch.code, name: s.branch.name } : null,
    centre: s.centre ? { id: s.centre.id, code: s.centre.code, name: s.centre.name } : null,
    product: s.product ? { id: s.product.id, name: s.product.name } : null,
    creditOfficer: s.creditOfficer,
  };
}

/**
 * Write the day's positions (the end of day's last job). The positions are
 * today's, so the business date has to be today or yesterday (an end of day
 * run after midnight for the day that just ended); anything older would store
 * the present under a past date.
 */
async function snapshot(c, { date = null, takenBy = 'EOD' } = {}) {
  const today = await orgToday(c);
  const d = date ? String(date).slice(0, 10) : today;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (d !== today && d !== yesterday) throw err(`SNAPSHOT_DATE_MUST_BE_TODAY_OR_YESTERDAY: ${d}`, 400);
  await c.query('DELETE FROM loan_daily_positions WHERE business_date = $1::date', [d]);
  const { rowCount } = await c.query(
    `INSERT INTO loan_daily_positions (business_date, loan_id, account_no, member_id, product_id, branch_id, centre_id,
       credit_officer, status, disbursed_on, principal_outstanding, interest_outstanding, fees_outstanding,
       penalty_outstanding, principal_overdue, interest_overdue, fees_overdue, days_late)
     SELECT $1::date, loan_id, account_no, member_id, product_id, branch_id, centre_id, credit_officer, status, disbursed_on,
            principal_outstanding, interest_outstanding, fees_outstanding, penalty_outstanding,
            principal_overdue, interest_overdue, fees_overdue, days_late
     FROM (${LIVE_SQL}) p`, [d]);
  await c.query(
    `INSERT INTO portfolio_snapshots (business_date, loans, taken_at, taken_by) VALUES ($1::date, $2, now(), $3)
     ON CONFLICT (business_date) DO UPDATE SET loans = EXCLUDED.loans, taken_at = now(), taken_by = EXCLUDED.taken_by`,
    [d, rowCount, takenBy]);
  return { businessDate: d, loans: rowCount };
}

// --------------------------------------------------------------------------
// Portfolio at risk and value at risk
// --------------------------------------------------------------------------

/** The disjoint arrears buckets the PAR report has always shown. */
const BUCKETS = [
  ['CURRENT', 0, 0], ['PAR_1_30', 1, 30], ['PAR_31_90', 31, 90], ['PAR_91_180', 91, 180],
  ['PAR_181_360', 181, 360], ['PAR_OVER_360', 361, null],
];
const bucketOf = (days) => BUCKETS.find(([, lo, hi]) => days >= lo && (hi === null || days <= hi))[0];

/**
 * The reference platform's thresholds: PAR over X days is the outstanding principal of loans
 * more than X days late, as a share of the gross loan portfolio; a range
 * (7-30) is loans more than 7 and at most 30 days late. VAR is the same with
 * the overdue principal in place of the outstanding.
 */
const PAR_THRESHOLDS = [0, 7, 15, 30, 60, 90, 180, 360];
const PAR_RANGES = [[7, 30], [30, 90], [90, 180], [180, 360]];
const VAR_THRESHOLDS = [0, 7, 15, 30, 90];

const DEFINITIONS = {
  grossLoanPortfolio: 'Principal disbursed and not repaid on running (ACTIVE, IN_ARREARS and LOCKED) loans.',
  daysLate: 'Days since the oldest installment still unpaid fell due.',
  par: 'PAR over X: outstanding principal of loans more than X days late, over the gross loan portfolio. PAR is PAR over 0.',
  parRange: 'PAR a-b: loans more than a and at most b days late.',
  var: 'VAR over X: overdue principal of loans more than X days late, over the gross loan portfolio. VAR is VAR over 0.',
  interestInSuspense: 'Interest accrued and not paid on loans that are late.',
};

const pct = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : 0);

/** PAR, VAR and the buckets over a set of positions. */
function measures(rows, { thresholds = PAR_THRESHOLDS } = {}) {
  const glp = round2(rows.reduce((s, r) => s + r.principal_outstanding, 0));
  const par = {};
  for (const t of thresholds) {
    const late = rows.filter((r) => r.days_late > t);
    const amount = round2(late.reduce((s, r) => s + r.principal_outstanding, 0));
    par[t === 0 ? 'PAR' : `PAR_OVER_${t}`] = { loans: late.length, outstanding: amount, percent: pct(amount, glp) };
  }
  for (const [a, b] of PAR_RANGES) {
    const late = rows.filter((r) => r.days_late > a && r.days_late <= b);
    const amount = round2(late.reduce((s, r) => s + r.principal_outstanding, 0));
    par[`PAR_${a}_${b}`] = { loans: late.length, outstanding: amount, percent: pct(amount, glp) };
  }
  const vr = {};
  for (const t of VAR_THRESHOLDS) {
    const late = rows.filter((r) => r.days_late > t);
    const amount = round2(late.reduce((s, r) => s + r.principal_overdue, 0));
    vr[t === 0 ? 'VAR' : `VAR_OVER_${t}`] = { loans: late.length, overdue: amount, percent: pct(amount, glp) };
  }
  const buckets = BUCKETS.map(([b]) => {
    const inB = rows.filter((r) => bucketOf(r.days_late) === b);
    return { bucket: b, loans: inB.length, outstanding: round2(inB.reduce((s, r) => s + r.principal_outstanding, 0)) };
  }).filter((b) => b.loans > 0);
  const atRisk = par.PAR.outstanding;
  const interestInSuspense = round2(rows.filter((r) => r.days_late > 0).reduce((s, r) => s + r.interest_outstanding, 0));
  return { glp, par, var: vr, buckets, atRisk, interestInSuspense };
}

/** The PAR report: buckets, thresholds and VAR, for a date and scope. */
async function portfolioAtRisk(c, opts = {}) {
  const p = await positions(c, opts);
  const m = measures(p.rows);
  return {
    asAt: p.asAt,
    source: p.source,
    takenAt: p.takenAt,
    scope: p.scope,
    buckets: m.buckets,
    totalOutstanding: m.glp,
    atRisk: m.atRisk,
    parPercent: m.par.PAR.percent,
    par: m.par,
    var: m.var,
    interestInSuspense: m.interestInSuspense,
    definitions: DEFINITIONS,
  };
}

const BUCKET_SQL = `CASE ${BUCKETS.map(([b, lo, hi]) => `WHEN days_late >= ${lo}${hi === null ? '' : ` AND days_late <= ${hi}`} THEN '${b}'`).join(' ')} END`;

/**
 * The loans behind the report, one row each, paged in SQL. Filters: bucket,
 * minDaysLate, maxDaysLate and the scope.
 */
async function loans(c, { asAt = null, bucket = null, minDaysLate = null, maxDaysLate = null, offset = 0, limit = 50, ...filters } = {}) {
  const src = await sourceFor(c, asAt);
  const s = await scope(c, filters);
  const w = whereOf(s, 5);
  if (bucket && !BUCKETS.some(([b]) => b === bucket)) throw err(`UNKNOWN_BUCKET: ${bucket}`, 400);
  const sql = `
    SELECT p.account_no, p.status, mb.member_no, mb.first_name, mb.last_name, p.product_id, p.branch_id,
           br.code AS branch_code, p.centre_id, p.credit_officer, p.days_late, ${BUCKET_SQL.replace(/days_late/g, 'p.days_late')} AS bucket,
           p.principal_outstanding AS outstanding, p.principal_overdue, p.interest_overdue, p.fees_overdue,
           p.interest_outstanding
    FROM (${src.sql}) p
    JOIN members mb ON mb.id = p.member_id
    LEFT JOIN branches br ON br.id = p.branch_id
    WHERE ($2::text IS NULL OR ${BUCKET_SQL.replace(/days_late/g, 'p.days_late')} = $2::text)
      AND ($3::int IS NULL OR p.days_late >= $3::int)
      AND ($4::int IS NULL OR p.days_late <= $4::int)
      ${w.sql.replace(/^WHERE /, 'AND ').replace(/\b(branch_id|centre_id|product_id|credit_officer)\b/g, 'p.$1')}
    ORDER BY p.days_late DESC, p.account_no`;
  const page = await pageQuery(c, sql, [src.asAt, bucket, intOrNull(minDaysLate), intOrNull(maxDaysLate), ...w.params], { offset, limit });
  return { asAt: src.asAt, source: src.source, bucket: bucket || 'ALL', scope: scopeOut(s), ...page, items: page.items.map(numericLoan) };
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw err(`INVALID_DAYS: ${v}`, 400);
  return n;
}
function numericLoan(r) {
  const o = { ...r };
  for (const k of ['outstanding', 'principal_overdue', 'interest_overdue', 'fees_overdue', 'interest_outstanding']) o[k] = round2(o[k]);
  return o;
}

// --------------------------------------------------------------------------
// The risk report (the reference platform's Reporting > Risk)
// --------------------------------------------------------------------------

const GROUPS = {
  BRANCH: { key: 'branch_id', label: async (c, ids) => labels(c, 'SELECT id::text AS k, code || \' \' || name AS l FROM branches WHERE id::text = ANY($1)', ids) },
  CENTRE: { key: 'centre_id', label: async (c, ids) => labels(c, 'SELECT id::text AS k, code || \' \' || name AS l FROM centres WHERE id::text = ANY($1)', ids) },
  PRODUCT: { key: 'product_id', label: async (c, ids) => labels(c, 'SELECT id AS k, name AS l FROM loan_products WHERE id = ANY($1)', ids) },
  CREDIT_OFFICER: { key: 'credit_officer', label: async (c, ids) => labels(c, 'SELECT email AS k, COALESCE(full_name, email) AS l FROM platform.users WHERE email = ANY($1) AND tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema())', ids) },
};
async function labels(c, sql, ids) {
  const clean = ids.filter((x) => x !== null && x !== undefined).map(String);
  if (!clean.length) return new Map();
  const { rows } = await c.query(sql, [clean]);
  return new Map(rows.map((r) => [r.k, r.l]));
}

/**
 * The risk report: loans late by at least `minDaysLate` (1 by default) and
 * at most `maxDaysLate`, optionally in one provisioning band, grouped by
 * branch, centre, product or credit officer, each band with its provision
 * rate and the provision it calls for. Bands whose rate is not set show the
 * rate and provision as null: the rates ship unset and are the SACCO's to
 * enter (Period and provisions).
 */
async function riskReport(c, { asAt = null, minDaysLate = 1, maxDaysLate = null, band = null, groupBy = 'BRANCH', ...filters } = {}) {
  const g = GROUPS[String(groupBy || 'BRANCH').toUpperCase()];
  if (!g) throw err(`UNKNOWN_GROUP: ${groupBy} (use ${Object.keys(GROUPS).join(', ')})`, 400);
  const min = intOrNull(minDaysLate) ?? 0;
  const max = intOrNull(maxDaysLate);
  const p = await positions(c, { asAt, ...filters });
  const { rows: bands } = await c.query('SELECT code, label, min_days, max_days, rate_percent FROM provision_bands ORDER BY sort_order, min_days');
  if (band && !bands.some((b) => b.code === band)) throw err(`UNKNOWN_BAND: ${band}`, 400);
  const bandOf = (days) => bands.find((b) => days >= b.min_days && (b.max_days === null || days <= b.max_days)) || null;

  const glp = round2(p.rows.reduce((s, r) => s + r.principal_outstanding, 0));
  const picked = p.rows.filter((r) => r.days_late >= min && (max === null || r.days_late <= max))
    .map((r) => ({ ...r, band: bandOf(r.days_late) }))
    .filter((r) => !band || (r.band && r.band.code === band));
  const provision = (r) => (r.band && r.band.rate_percent !== null ? round2(r.principal_outstanding * Number(r.band.rate_percent) / 100) : null);
  const sumOf = (rs, f) => round2(rs.reduce((s, r) => s + (f(r) || 0), 0));
  const allSet = (rs) => rs.every((r) => provision(r) !== null);

  const keys = [...new Set(picked.map((r) => r[g.key] ?? null))];
  const names = await g.label(c, keys);
  const groups = keys.map((k) => {
    const rs = picked.filter((r) => (r[g.key] ?? null) === k);
    const out = sumOf(rs, (r) => r.principal_outstanding);
    return {
      key: k, label: k === null ? 'None' : names.get(String(k)) || String(k),
      loans: rs.length,
      principalOutstanding: out,
      principalOverdue: sumOf(rs, (r) => r.principal_overdue),
      percentOfPortfolio: pct(out, glp),
      provisionRequired: allSet(rs) ? sumOf(rs, provision) : null,
    };
  }).sort((a, b) => b.principalOutstanding - a.principalOutstanding);

  const byBand = bands.map((b) => {
    const rs = picked.filter((r) => r.band && r.band.code === b.code);
    return {
      band: b.code, label: b.label, daysFrom: b.min_days, daysTo: b.max_days,
      ratePercent: b.rate_percent === null ? null : Number(b.rate_percent),
      loans: rs.length,
      principalOutstanding: sumOf(rs, (r) => r.principal_outstanding),
      provisionRequired: b.rate_percent === null ? null : sumOf(rs, provision),
    };
  }).filter((b) => b.loans > 0 || !band);

  const total = sumOf(picked, (r) => r.principal_outstanding);
  return {
    asAt: p.asAt,
    source: p.source,
    takenAt: p.takenAt,
    scope: p.scope,
    filter: { minDaysLate: min, maxDaysLate: max, band: band || null },
    groupBy: String(groupBy).toUpperCase(),
    grossLoanPortfolio: glp,
    loans: picked.length,
    principalOutstanding: total,
    principalOverdue: sumOf(picked, (r) => r.principal_overdue),
    percentOfPortfolio: pct(total, glp),
    provisionRequired: allSet(picked) ? sumOf(picked, provision) : null,
    ratesUnset: bands.filter((b) => b.rate_percent === null).map((b) => b.code),
    groups,
    bands: byBand,
  };
}

module.exports = {
  LIVE_SQL, BUCKETS, PAR_THRESHOLDS, PAR_RANGES, VAR_THRESHOLDS, DEFINITIONS,
  sourceFor, scope, whereOf, positions, snapshot, snapshotRange, measures, portfolioAtRisk, loans, riskReport, bucketOf,
};
