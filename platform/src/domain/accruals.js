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
 *                                     per product and branch (Mambu's default)
 *   GL accrual MONTHLY, either        posted on the last day of the month,
 *                                     per account or per product and branch
 *
 * Aggregated entries keep their per-account lines, linked by entry_id, so
 * the breakdown behind any accrual entry is a query (Mambu's "Interest
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

module.exports = { record, flush, breakdown, postMode, legs, isMonthEnd };
