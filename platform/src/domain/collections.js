'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const loans = require('./loans');
const { err, round2 } = acct;
const { isoDate } = S;

/**
 * Bulk repayment collection, after Mambu's "Bulk repayments collection".
 *
 * A collection sheet lists what is due, filtered by branch, product and
 * member (the platform has no credit officers or centres to filter by):
 *
 *   REPAYMENTS  every installment due in a date range, at its expected
 *               amount; a loan with weekly installments over a fortnight
 *               shows twice. Each row comes with the defaults a batch would
 *               post: paid on its due date, in full.
 *   ACCOUNTS    one row per loan: everything due as of a single date
 *               (installments due and unpaid, and penalties owed).
 *
 * The sheet prints for field staff (the console) or exports as CSV.
 *
 * Posting a batch: the rows chosen, each with its amount and, where the
 * teller changed it, its own date and channel; the batch's channel, date and
 * receipt reference fill in what a row does not say. Each row is an
 * ordinary repayment in its own savepoint, so a row that fails (a loan
 * already paid, a date before a later repayment) is reported and the rest
 * post. Only one batch runs at a time in a tenant (Mambu: "Another process
 * is in progress"). Every batch is kept with its results.
 *
 * This module stands above ./loans, like ./restructure.
 */

const RUNNING = ['ACTIVE', 'IN_ARREARS', 'LOCKED'];
const today = () => isoDate(new Date());
const dateOr = (v, fallback) => (v ? String(v).slice(0, 10) : fallback);

async function sheet(c, { view = 'REPAYMENTS', from = null, to = null, asOf = null, branchId = null, productId = null, memberId = null } = {}) {
  const v = String(view).toUpperCase();
  const filters = [branchId || null, productId || null, memberId || null];
  const where = `l.status = ANY($1) AND ($2::uuid IS NULL OR l.branch_id = $2::uuid) AND ($3::text IS NULL OR l.product_id = $3)
    AND ($4::uuid IS NULL OR l.member_id = $4::uuid)`;
  if (v === 'REPAYMENTS') {
    const start = dateOr(from, today());
    const end = dateOr(to, start);
    if (end < start) throw err('THE_RANGE_ENDS_BEFORE_IT_STARTS', 400);
    const { rows } = await c.query(
      `SELECT l.id AS loan_id, l.account_no, l.branch_id, l.product_id, m.member_no, m.first_name || ' ' || m.last_name AS member_name,
              i.number, i.due_date::text AS due_date, i.status,
              (i.principal_due - i.principal_paid + i.interest_due - i.interest_paid + i.fee_due - i.fee_paid)::float8 AS expected
       FROM loan_installments i JOIN loan_accounts l ON l.id = i.loan_id JOIN members m ON m.id = l.member_id
       WHERE ${where} AND i.status NOT IN ('PAID', 'GRACE') AND i.due_date BETWEEN $5::date AND $6::date
       ORDER BY m.member_no, l.account_no, i.number`, [RUNNING, ...filters, start, end]);
    const out = rows.map((r) => ({ ...r, expected: round2(r.expected), datePaid: r.due_date, amountPaid: round2(r.expected) }));
    return { view: 'REPAYMENTS', from: start, to: end, rows: out, total: round2(out.reduce((a, r) => a + r.expected, 0)) };
  }
  if (v === 'ACCOUNTS') {
    const date = dateOr(asOf || to || from, today());
    const { rows } = await c.query(
      `SELECT l.id AS loan_id, l.account_no, l.branch_id, l.product_id, m.member_no, m.first_name || ' ' || m.last_name AS member_name,
              l.status, (l.penalty_accrued - l.penalty_paid)::float8 AS penalty,
              COALESCE(SUM(i.principal_due - i.principal_paid + i.interest_due - i.interest_paid + i.fee_due - i.fee_paid), 0)::float8 AS installments,
              count(i.id)::int AS installments_due
       FROM loan_accounts l JOIN members m ON m.id = l.member_id
       LEFT JOIN loan_installments i ON i.loan_id = l.id AND i.status NOT IN ('PAID', 'GRACE') AND i.due_date <= $5::date
       WHERE ${where}
       GROUP BY l.id, m.id
       HAVING COALESCE(SUM(i.principal_due - i.principal_paid + i.interest_due - i.interest_paid + i.fee_due - i.fee_paid), 0) > 0
           OR (l.penalty_accrued - l.penalty_paid) > 0
       ORDER BY m.member_no, l.account_no`, [RUNNING, ...filters, date]);
    const out = rows.map((r) => {
      const expected = round2(Number(r.installments) + Math.max(0, Number(r.penalty)));
      return { ...r, installments: round2(r.installments), penalty: round2(r.penalty), expected, datePaid: date, amountPaid: expected };
    });
    return { view: 'ACCOUNTS', asOf: date, rows: out, total: round2(out.reduce((a, r) => a + r.expected, 0)) };
  }
  throw err('VIEW_IS_REPAYMENTS_OR_ACCOUNTS', 400);
}

/** The sheet as CSV, for export. */
function toCsv(s) {
  const cols = s.view === 'REPAYMENTS'
    ? ['member_no', 'member_name', 'account_no', 'number', 'due_date', 'expected', 'datePaid', 'amountPaid']
    : ['member_no', 'member_name', 'account_no', 'installments_due', 'installments', 'penalty', 'expected', 'datePaid', 'amountPaid'];
  const cell = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(','), ...s.rows.map((r) => cols.map((k) => cell(r[k])).join(','))].join('\n') + '\n';
}

/**
 * Post a batch of repayments. `rows` are { loanId, amount, valueDate?,
 * channelId?, reference? }; the batch's `channelId`, `valueDate` and
 * `reference` fill in what a row leaves out.
 */
async function post(c, { rows = [], channelId = null, valueDate = null, reference = null, createdBy, user = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw err('A_BATCH_NEEDS_ROWS', 400);
  if (rows.length > 2000) throw err('A_BATCH_TAKES_AT_MOST_2000_ROWS', 400);
  const { rows: [g] } = await c.query("SELECT pg_try_advisory_xact_lock(hashtext(current_schema() || ':loan-collection')) AS ok");
  if (!g.ok) throw err('ANOTHER_PROCESS_IS_IN_PROGRESS: a collection batch is being posted', 409);
  const batchDate = dateOr(valueDate, today());
  // Oldest first within a loan, so two rows for one loan post in date order.
  const ordered = rows.map((r, k) => ({ ...r, k, date: dateOr(r.valueDate, batchDate) }))
    .sort((a, b) => String(a.loanId).localeCompare(String(b.loanId)) || a.date.localeCompare(b.date) || a.k - b.k);
  const results = [];
  let amount = 0;
  for (const r of ordered) {
    const amt = round2(r.amount);
    const ch = r.channelId || channelId || 'cash';
    const ref = r.reference || reference || null;
    await c.query('SAVEPOINT collection_row');
    try {
      if (!r.loanId) throw err('ROW_NEEDS_A_LOAN', 400);
      if (!(amt > 0)) throw err('ROW_NEEDS_AN_AMOUNT', 400);
      const l = await ledger.read(c, String(r.loanId));
      const tx = await loans.repay(c, l.id, {
        amount: amt, channelId: ch, valueDate: r.date, createdBy, user,
        narration: `Collection${ref ? ` ${ref}` : ''}`,
      });
      await c.query('RELEASE SAVEPOINT collection_row');
      amount = round2(amount + amt);
      results.push({ row: r.k, loanId: l.id, accountNo: l.account_no, amount: amt, valueDate: r.date, channelId: ch, status: 'POSTED', reference: tx.reference });
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT collection_row');
      results.push({ row: r.k, loanId: r.loanId || null, amount: amt, valueDate: r.date, channelId: ch, status: 'FAILED', error: String(e.message).slice(0, 300) });
    }
  }
  results.sort((a, b) => a.row - b.row);
  const posted = results.filter((r) => r.status === 'POSTED').length;
  const { rows: [batch] } = await c.query(
    `INSERT INTO loan_collection_batches (channel_id, value_date, reference, rows, posted, failed, amount, results, posted_by)
     VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [channelId, batchDate, reference, rows.length, posted, rows.length - posted, amount, JSON.stringify(results), createdBy || 'SYSTEM']);
  return { batchId: batch.id, rows: rows.length, posted, failed: rows.length - posted, amount, results };
}

async function batches(c, { limit = 20 } = {}) {
  const { rows } = await c.query('SELECT id, channel_id, value_date, reference, rows, posted, failed, amount, posted_by, created_at FROM loan_collection_batches ORDER BY created_at DESC LIMIT $1', [Math.min(Number(limit) || 20, 200)]);
  return rows;
}

async function batch(c, id) {
  const { rows: [b] } = await c.query('SELECT * FROM loan_collection_batches WHERE id = $1', [id]);
  return b || null;
}

module.exports = { sheet, toCsv, post, batches, batch };
