'use strict';

const acct = require('./accounting');
const { round2 } = acct;

/**
 * Interest accrual postings, for loans and deposits.
 *
 * Every accrual is written as accrual_lines rows, one per account, component
 * and GL pair. When the ledger sees them depends on the product:
 *
 *   GL accrual DAILY,   PER_ACCOUNT   posted at once, one entry per account
 *   GL accrual DAILY,   AGGREGATED    posted at the end of the day, one entry
 *                                     per product and branch (the reference platform's default)
 *   GL accrual MONTHLY, either        posted on the last day of the month,
 *                                     per account or per product and branch
 *
 * Aggregated entries keep their per-account lines, linked by entry_id, so
 * the breakdown behind any accrual entry is a query (the reference platform's "Interest
 * Accrual Breakdown").
 *
 * Accruals here are incremental: each run books the change since the last
 * one. A negative change (the MINIMUM balance method lowering what has been
 * earned) reverses the direction. Nothing already posted is ever edited.
 *
 * Depends on accounting only.
 */

function postMode(p) {
  if ((p.interest_accrued_accounting || 'DAILY') === 'MONTHLY') return 'END_OF_MONTH';
  return p.accrual_granularity === 'AGGREGATED' ? 'END_OF_DAY' : 'NOW';
}

const SOURCE = { LOAN: 'LOAN_INTEREST_ACCRUAL', SAVINGS: 'SAVINGS_INTEREST_ACCRUAL' };

/** Turn grouped lines into balanced debits and credits, netting each GL pair. */
function legs(rows, memberId = null, branchId = null) {
  const pairs = new Map();
  for (const r of rows) {
    const k = `${r.debit_gl}|${r.credit_gl}`;
    pairs.set(k, round2((pairs.get(k) || 0) + Number(r.amount)));
  }
  const debits = [];
  const credits = [];
  for (const [k, amt] of pairs) {
    if (!amt) continue;
    const [dr, cr] = k.split('|');
    const [d, cgl] = amt > 0 ? [dr, cr] : [cr, dr];
    debits.push({ glCode: d, amount: Math.abs(amt), memberId, branchId });
    credits.push({ glCode: cgl, amount: Math.abs(amt), memberId, branchId });
  }
  return { debits, credits };
}

/**
 * Record an accrual. `lines` are { component, debitGl, creditGl, amount };
 * amounts may be negative. Returns the journal entry id when the product
 * posts at once, otherwise null.
 */
async function record(c, { kind, product, accountId, memberId = null, branchId = null, date, lines, narration, createdBy = 'EOD' }) {
  const live = lines.filter((l) => round2(l.amount) !== 0);
  if (!live.length) return null;
  const mode = postMode(product);
  const ids = [];
  for (const l of live) {
    const { rows: [r] } = await c.query(
      `INSERT INTO accrual_lines (account_kind, product_id, branch_id, account_id, member_id, component, booking_date,
                                  debit_gl, credit_gl, amount, post_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [kind, product.product_id || product.id, branchId, accountId, memberId, l.component, date,
        l.debitGl, l.creditGl, round2(l.amount), mode]);
    ids.push(r);
  }
  if (mode !== 'NOW') return null;
  const { debits, credits } = legs(ids, memberId, branchId);
  if (!debits.length) {
    await c.query('UPDATE accrual_lines SET settled_at = now() WHERE id = ANY($1)', [ids.map((r) => r.id)]);
    return null;
  }
  const e = await acct.post(c, {
    debits, credits, narration: narration || `Interest accrual ${date}`,
    sourceType: SOURCE[kind], sourceId: accountId, bookingDate: date, createdBy, branchId,
  });
  await c.query('UPDATE accrual_lines SET entry_id = $1 WHERE id = ANY($2)', [e.entryId, ids.map((r) => r.id)]);
  return e.entryId;
}

const isMonthEnd = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() + 86400000).getUTCDate() === 1;
};

/**
 * Post what is waiting: END_OF_DAY lines every day, END_OF_MONTH lines on
 * the last day of the month. Aggregated products get one entry per product,
 * branch and account kind; per-account products one per account.
 */
async function flush(c, { date, createdBy = 'EOD' } = {}) {
  const monthEnd = isMonthEnd(date);
  const { rows } = await c.query(
    `SELECT a.*,
            COALESCE(lp.accrual_granularity, sp.accrual_granularity, 'PER_ACCOUNT') AS granularity,
            COALESCE(lp.name, sp.name) AS product_name
     FROM accrual_lines a
     LEFT JOIN loan_products lp ON a.account_kind = 'LOAN' AND lp.id = a.product_id
     LEFT JOIN savings_products sp ON a.account_kind = 'SAVINGS' AND sp.id = a.product_id
     WHERE a.entry_id IS NULL AND a.settled_at IS NULL AND a.booking_date <= $1::date
       AND (a.post_mode = 'END_OF_DAY' OR (a.post_mode = 'END_OF_MONTH' AND $2))
     ORDER BY a.id
     FOR UPDATE OF a`, [date, monthEnd]);
  const groups = new Map();
  for (const r of rows) {
    const perAccount = r.granularity === 'PER_ACCOUNT';
    const k = [r.account_kind, r.product_id, r.branch_id || '', perAccount ? r.account_id : ''].join('|');
    if (!groups.has(k)) groups.set(k, { rows: [], perAccount, first: r });
    groups.get(k).rows.push(r);
  }
  let entries = 0;
  for (const g of groups.values()) {
    const f = g.first;
    const { debits, credits } = legs(g.rows, g.perAccount ? f.member_id : null, f.branch_id);
    if (!debits.length) {
      await c.query('UPDATE accrual_lines SET settled_at = now() WHERE id = ANY($1)', [g.rows.map((r) => r.id)]);
      continue;
    }
    const e = await acct.post(c, {
      debits, credits,
      narration: `Interest accrual ${f.product_name || f.product_id}${g.perAccount ? '' : ` (${g.rows.length} line(s))`} to ${date}`,
      sourceType: SOURCE[f.account_kind], sourceId: g.perAccount ? f.account_id : null,
      bookingDate: date, createdBy, branchId: f.branch_id,
    });
    await c.query('UPDATE accrual_lines SET entry_id = $1 WHERE id = ANY($2)', [e.entryId, g.rows.map((r) => r.id)]);
    entries += 1;
  }
  return { lines: rows.length, entries, monthEnd };
}

/** The per-account lines behind an accrual entry. */
async function breakdown(c, entryId) {
  const { rows } = await c.query(
    `SELECT account_kind, account_id, member_id, component, booking_date, debit_gl, credit_gl, amount
     FROM accrual_lines WHERE entry_id = $1 ORDER BY id`, [entryId]);
  return rows;
}

/**
 * The reference platform's interest accrual breakdown search (POST
 * /accounting/interestaccrual:search): each accrual line read as its debit
 * and its credit, with the account, product, branch and the journal entry
 * that carried it (parentEntryId; empty while waiting to be posted). A user
 * limited to some branches reads the lines of their branches.
 */
const BREAKDOWN_SQL = `
  SELECT x.*, g.name AS gl_name, g.type AS gl_type, b.code AS branch_code, b.name AS branch_name,
         COALESCE(la.account_no, sa.account_no) AS account_no
    FROM (
      SELECT a.id, a.account_kind, a.product_id, a.branch_id, a.account_id, a.component, a.booking_date, a.amount,
             a.post_mode, a.entry_id, a.created_at, 'DEBIT' AS entry_type, a.debit_gl AS gl_code FROM accrual_lines a
      UNION ALL
      SELECT a.id, a.account_kind, a.product_id, a.branch_id, a.account_id, a.component, a.booking_date, a.amount,
             a.post_mode, a.entry_id, a.created_at, 'CREDIT', a.credit_gl FROM accrual_lines a
    ) x
    JOIN gl_accounts g ON g.code = x.gl_code
    LEFT JOIN branches b ON b.id = x.branch_id
    LEFT JOIN loan_accounts la ON x.account_kind = 'LOAN' AND la.id = x.account_id
    LEFT JOIN savings_accounts sa ON x.account_kind = 'SAVINGS' AND sa.id = x.account_id`;

const BREAKDOWN_FIELDS = {
  entryId: { sql: "(j.id::text || '-' || left(j.entry_type, 1))", type: 'text' },
  accrualLineId: { sql: 'j.id', type: 'number' },
  entryType: { sql: 'j.entry_type', type: 'text' },
  parentEntryId: { sql: 'j.entry_id::text', type: 'text' },
  amount: { sql: 'j.amount', type: 'number' },
  bookingDate: { sql: 'j.booking_date', type: 'date' },
  creationDate: { sql: 'j.created_at', type: 'timestamp' },
  glAccountId: { sql: 'j.gl_code', type: 'text' },
  glAccountKey: { sql: 'j.gl_code', type: 'text' },
  glAccountName: { sql: 'j.gl_name', type: 'text' },
  glAccountType: { sql: 'j.gl_type', type: 'text' },
  productType: { sql: "(CASE j.account_kind WHEN 'LOAN' THEN 'LOAN' ELSE 'SAVINGS' END)", type: 'text' },
  productId: { sql: 'j.product_id', type: 'text' },
  productKey: { sql: 'j.product_id', type: 'text' },
  accountId: { sql: 'j.account_no', type: 'text' },
  accountKey: { sql: 'j.account_id::text', type: 'text' },
  branchKey: { sql: 'j.branch_id::text', type: 'text' },
  branchId: { sql: 'j.branch_code', type: 'text' },
  component: { sql: 'j.component', type: 'text' },
};

async function searchBreakdown(c, { body = {}, offset = 0, limit = 50, branches = null, today = null } = {}) {
  const SEARCH = require('../lib/searchCriteria');
  const s = SEARCH.build({ filterCriteria: body.filterCriteria || [], sortingCriteria: body.sortingCriteria }, BREAKDOWN_FIELDS,
    { customColumn: 'NULL::jsonb', today });
  let where = s.where;
  if (Array.isArray(branches)) { s.params.push(branches); where = `(${where}) AND j.branch_id = ANY($${s.params.length}::uuid[])`; }
  const { rows } = await c.query(
    `SELECT j.*, count(*) OVER () AS total FROM (${BREAKDOWN_SQL}) j WHERE ${where}
      ORDER BY ${s.order ? `${s.order}, ` : ''}j.booking_date DESC, j.id, j.entry_type DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, s.params);
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      entryId: `${r.id}-${r.entry_type[0]}`, accrualLineId: Number(r.id), entryType: r.entry_type, amount: round2(r.amount),
      bookingDate: r.booking_date, creationDate: r.created_at,
      glAccountId: r.gl_code, glAccountKey: r.gl_code, glAccountName: r.gl_name, glAccountType: r.gl_type,
      productType: r.account_kind === 'LOAN' ? 'LOAN' : 'SAVINGS', productId: r.product_id, productKey: r.product_id,
      accountId: r.account_no ?? null, accountKey: r.account_id,
      branchKey: r.branch_id ?? null, branchId: r.branch_code ?? null, branchName: r.branch_name ?? null,
      parentEntryId: r.entry_id ?? null, component: r.component, postMode: r.post_mode,
    })),
  };
}

module.exports = { record, flush, breakdown, searchBreakdown, postMode, legs, isMonthEnd, BREAKDOWN_FIELDS };
