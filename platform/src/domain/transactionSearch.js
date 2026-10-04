'use strict';

const SEARCH = require('../lib/searchCriteria');
const { err } = require('../lib/errors');

/**
 * Loan or deposit transactions across accounts, for the console's Loan
 * Transactions and Deposit Transactions lists and their search endpoints
 * (POST /api/loans/transactions:search, POST /api/deposits/transactions:search).
 *
 * A loan transaction is one posted on a loan account, a deposit transaction
 * one posted on a deposit account, so a reversal is listed with the side it
 * reverses. The branch row security on transactions applies as on every
 * read, so a user limited to some branches finds only theirs.
 */

const SIDES = {
  LOAN: { join: 'JOIN loan_accounts x ON x.id = t.loan_account_id' },
  DEPOSIT: { join: 'JOIN savings_accounts x ON x.id = t.savings_account_id' },
};

// Search names, after the reference platform's, and their SQL.
const FIELDS = {
  id: { sql: 't.reference', type: 'text' },
  type: { sql: 't.kind', type: 'text' },
  valueDate: { sql: 't.value_date', type: 'date' },
  creationDate: { sql: 't.created_at', type: 'timestamp' },
  amount: { sql: 't.amount', type: 'number' },
  accountId: { sql: 'x.account_no', type: 'text' },
  accountKey: { sql: 'x.id::text', type: 'text' },
  memberId: { sql: 'm.member_no', type: 'text' },
  memberKey: { sql: 'm.id::text', type: 'text' },
  branchKey: { sql: 't.branch_id::text', type: 'text' },
  productKey: { sql: 'x.product_id', type: 'text' },
  user: { sql: 't.created_by', type: 'text' },
  reversed: { sql: '(t.reversed_by IS NOT NULL)', type: 'boolean' },
};

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function row(r) {
  return {
    reference: r.reference,
    id: r.reference,
    type: r.kind,
    valueDate: day(r.value_date),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    amount: Number(r.amount),
    accountId: r.account_no,
    accountKey: r.account_id,
    memberId: r.member_no,
    memberKey: r.member_id,
    memberName: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.member_no,
    branchKey: r.branch_id,
    productKey: r.product_id,
    user: r.created_by,
    reversed: r.reversed_by !== null,
    reversalOf: r.allocation?.reversalOf || null,
    narration: r.narration || null,
  };
}

/** One page of a side's transactions matching the search body, newest first unless sorted. */
async function search(c, side, body = {}, { offset = 0, limit = 50 } = {}) {
  const s = SIDES[side];
  if (!s) throw err(`UNKNOWN_TRANSACTION_SIDE: ${side}`);
  const q = SEARCH.build({ filterCriteria: body.filterCriteria || [], sortingCriteria: body.sortingCriteria }, FIELDS, {});
  const { rows } = await c.query(
    `SELECT t.reference, t.kind, t.value_date, t.created_at, t.amount, t.branch_id, t.created_by, t.reversed_by, t.allocation, t.narration,
            x.id AS account_id, x.account_no, x.product_id, m.id AS member_id, m.member_no, m.first_name, m.last_name,
            count(*) OVER () AS total
       FROM transactions t ${s.join} JOIN members m ON m.id = x.member_id
      WHERE ${q.where}
      ORDER BY ${q.order ? `${q.order}, ` : ''}t.created_at DESC, t.id
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, q.params);
  return { rows: rows.map(row), total: rows.length ? Number(rows[0].total) : (offset ? await count(c, s, q) : 0) };
}

// The count when a page past the end is asked for.
async function count(c, s, q) {
  const { rows: [r] } = await c.query(
    `SELECT count(*)::int AS n FROM transactions t ${s.join} JOIN members m ON m.id = x.member_id WHERE ${q.where}`, q.params);
  return r.n;
}

module.exports = { search, FIELDS };
