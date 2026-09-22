'use strict';

/**
 * Double-entry posting, SQL-backed.
 *
 * Every function here takes an open tenant client (from withTenant), so the
 * posting joins whatever transaction the caller is already in. A disbursement
 * and its journal entry either both commit or neither does.
 *
 * The database has the final say on balance: journal_lines carries a deferred
 * constraint trigger that re-checks debits against credits at COMMIT. The
 * check below is here to fail early with a readable message, not because it
 * is the safeguard.
 */

const err = (code, status = 400) => Object.assign(new Error(code), { status });
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * @param {import('pg').PoolClient} c  open client with search_path on a tenant
 * @param {object} p
 * @param {Array<{glCode:string, amount:number, memberId?:string}>} p.debits
 * @param {Array<{glCode:string, amount:number, memberId?:string}>} p.credits
 */
async function post(c, {
  debits = [], credits = [], bookingDate = null, narration = '',
  sourceType = null, sourceId = null, channelId = null,
  currencyCode = 'KES', createdBy = 'SYSTEM', reversalOf = null,
}) {
  const dr = round2(debits.reduce((s, d) => s + Number(d.amount || 0), 0));
  const cr = round2(credits.reduce((s, x) => s + Number(x.amount || 0), 0));
  if (dr <= 0 && cr <= 0) throw err('JOURNAL_ENTRY_EMPTY');
  if (dr !== cr) throw err(`JOURNAL_ENTRY_UNBALANCED: debits ${dr}, credits ${cr}`);

  const { rows: [entry] } = await c.query(
    `INSERT INTO journal_entries
       (booking_date, currency_code, narration, source_type, source_id, channel_id, created_by, reversal_of)
     VALUES (COALESCE($1::date, current_date), $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, booking_date`,
    [bookingDate, currencyCode, narration, sourceType, sourceId, channelId, createdBy, reversalOf]
  );

  const lines = [...debits.map((d) => ({ ...d, direction: 'DEBIT' })),
                 ...credits.map((x) => ({ ...x, direction: 'CREDIT' }))]
    .filter((l) => Number(l.amount) > 0);

  let n = 0;
  for (const l of lines) {
    n += 1;
    await c.query(
      `INSERT INTO journal_lines (entry_id, gl_code, direction, amount, member_id, line_no)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.id, l.glCode, l.direction, round2(l.amount), l.memberId || null, n]
    );
  }
  return { entryId: entry.id, amount: dr, lineCount: n };
}

/**
 * Reversal writes the mirror image and links both directions. The original
 * lines are never touched, because a trigger forbids it and because an
 * auditor needs to see that the correction happened, not a tidy book.
 */
async function reverse(c, entryId, narration = 'Reversal', createdBy = 'SYSTEM', { bookingDate } = {}) {
  const { rows: original } = await c.query(
    'SELECT gl_code, direction, amount, member_id FROM journal_lines WHERE entry_id = $1 ORDER BY line_no',
    [entryId]
  );
  if (!original.length) throw err('JOURNAL_ENTRY_NOT_FOUND', 404);

  // The reversal inherits the original's source type. Without it a reversal
  // is an untyped entry, and anything that filters by source type — the
  // income statement excluding year-end closing entries, for one — would
  // see the reversal but not what it reversed, and report the difference as
  // real trading.
  const { rows: [head] } = await c.query(
    'SELECT source_type, source_id, booking_date FROM journal_entries WHERE id = $1', [entryId]);

  // A reversal is dated with the entry it reverses unless the caller says
  // otherwise. Letting it default to today moves money between accounting
  // periods: reverse December's entry in January and December keeps the
  // debit while January gets the credit, so both periods are wrong. If the
  // original period has since been closed the posting is refused, which is
  // the right answer: reopen the year, or pass a date in an open one.

  const { rows: [already] } = await c.query(
    'SELECT id FROM journal_entries WHERE reversal_of = $1', [entryId]
  );
  if (already) throw err('JOURNAL_ENTRY_ALREADY_REVERSED', 409);

  return post(c, {
    debits: original.filter((l) => l.direction === 'CREDIT')
      .map((l) => ({ glCode: l.gl_code, amount: l.amount, memberId: l.member_id })),
    credits: original.filter((l) => l.direction === 'DEBIT')
      .map((l) => ({ glCode: l.gl_code, amount: l.amount, memberId: l.member_id })),
    narration, createdBy, reversalOf: entryId,
    sourceType: head?.source_type || null, sourceId: head?.source_id || null,
    bookingDate: bookingDate || head?.booking_date || null,
  });
}

/** Net movement on one GL account, debit-positive. */
async function balance(c, glCode, { from = null, to = null } = {}) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS bal
     FROM gl_daily_balances
     WHERE gl_code = $1
       AND ($2::date IS NULL OR booking_date >= $2::date)
       AND ($3::date IS NULL OR booking_date <= $3::date)`,
    [glCode, from, to]
  );
  return round2(r.bal);
}

/**
 * Movement per account for a period, read from the daily rollup.
 *
 * gl_daily_balances holds one row per account per day per closing flag,
 * maintained by a trigger on journal_lines (migration 007). Reports read
 * that instead of the lines: a day's postings collapse to one row per
 * account, so a six-year trial balance touches a few hundred thousand rows
 * rather than tens of millions. The rollup is exact because the journal is
 * append-only; `verifyRollup` below recomputes from the lines and compares,
 * so that is a checkable claim rather than an assumption.
 *
 * The period filter sits inside the aggregate. An earlier version had it in
 * an outer LEFT JOIN onto journal_entries, where a line row survives with
 * the entry columns nulled and is summed anyway, so `from` and `to` did
 * nothing and a one-month statement reported the whole book. The aggregate
 * is done first, then joined to the chart of accounts so accounts with no
 * movement in the period still appear.
 */
const MOVEMENT_SQL_BASE = `
  SELECT b.gl_code, SUM(b.debit) AS debit, SUM(b.credit) AS credit
  FROM gl_daily_balances b
  WHERE ($1::date IS NULL OR b.booking_date >= $1::date)
    AND ($2::date IS NULL OR b.booking_date <= $2::date)`;

const MOVEMENT_SQL = `${MOVEMENT_SQL_BASE}
  GROUP BY b.gl_code`;

/**
 * The same aggregate with the year-end sweep left out.
 *
 * A close posts entries that zero every income and expense account. They are
 * real postings and the balance sheet needs them, but an income statement
 * that counts them reports a closed year as having earned and spent nothing.
 * Reversals inherit their source type, so reversing a close removes both
 * halves from this view rather than one.
 */
const MOVEMENT_SQL_TRADING = `${MOVEMENT_SQL_BASE}
    AND NOT b.is_closing
  GROUP BY b.gl_code`;

/**
 * The same figures computed the slow way, straight from the lines. Used
 * only to check the rollup; nothing user-facing reads this.
 */
const MOVEMENT_SQL_FROM_LINES = `
  SELECT l.gl_code,
         SUM(CASE WHEN l.direction='DEBIT'  THEN l.amount ELSE 0 END) AS debit,
         SUM(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE 0 END) AS credit
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  WHERE ($1::date IS NULL OR e.booking_date >= $1::date)
    AND ($2::date IS NULL OR e.booking_date <= $2::date)
  GROUP BY l.gl_code`;

/**
 * Recompute every account's movement from the lines and compare it with the
 * rollup. Returns the accounts that disagree; an empty array is the claim
 * "the rollup is exact" made good. Run it after a restore, after any manual
 * SQL against the ledger, or whenever a number looks wrong.
 */
async function verifyRollup(c, { from = null, to = null } = {}) {
  const { rows } = await c.query(
    `SELECT COALESCE(r.gl_code, l.gl_code) AS gl_code,
            COALESCE(r.debit, 0)  AS rollup_debit,  COALESCE(l.debit, 0)  AS lines_debit,
            COALESCE(r.credit, 0) AS rollup_credit, COALESCE(l.credit, 0) AS lines_credit
     FROM (${MOVEMENT_SQL}) r
     FULL OUTER JOIN (${MOVEMENT_SQL_FROM_LINES}) l ON l.gl_code = r.gl_code
     WHERE COALESCE(r.debit, 0)  <> COALESCE(l.debit, 0)
        OR COALESCE(r.credit, 0) <> COALESCE(l.credit, 0)
     ORDER BY 1`,
    [from, to]
  );
  const { rows: [n] } = await c.query(
    'SELECT count(*)::int AS rollup_rows, (SELECT count(*) FROM journal_lines)::int AS line_rows FROM gl_daily_balances');
  return { mismatches: rows, rollupRows: n.rollup_rows, lineRows: n.line_rows, exact: rows.length === 0 };
}

/**
 * Trial balance for a period.
 *
 * Paged, because a real chart of accounts runs to thousands of codes. The
 * totals are computed over the whole period rather than over the page, since
 * a trial balance whose totals only add up the fifty rows you happen to be
 * looking at is worse than useless: it would say the book is unbalanced.
 */
async function trialBalance(c, { from = null, to = null, offset = 0, limit = null } = {}) {
  const sql = `
    SELECT g.code, g.name, g.type,
           COALESCE(m.debit, 0) AS debit,
           COALESCE(m.credit, 0) AS credit
    FROM gl_accounts g
    JOIN (${MOVEMENT_SQL}) m ON m.gl_code = g.code
    WHERE COALESCE(m.debit, 0) + COALESCE(m.credit, 0) > 0
    ORDER BY g.code`;

  const { rows: [t] } = await c.query(
    `SELECT COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit,
            count(*)::int AS accounts
     FROM (${sql}) s`,
    [from, to]
  );
  const totals = { debit: round2(t.debit), credit: round2(t.credit) };

  const take = limit === null ? null : Math.max(1, Number(limit));
  const { rows } = take === null
    ? await c.query(sql, [from, to])
    : await c.query(`${sql} LIMIT $3 OFFSET $4`, [from, to, take, Math.max(0, Number(offset) || 0)]);

  return {
    period: { from, to },
    rows: rows.map((r) => ({ ...r, balance: round2(r.debit - r.credit) })),
    page: { offset: Number(offset) || 0, limit: take, total: t.accounts },
    totals,
    balanced: totals.debit === totals.credit,
  };
}

/**
 * Balance on every account in one query.
 *
 * The route that lists the chart of accounts used to call balance() per
 * account, which is a query per row: 400 accounts meant 400 round trips
 * inside one transaction.
 */
async function balances(c, { from = null, to = null } = {}) {
  const { rows } = await c.query(
    `SELECT g.code, g.name, g.type, g.regulatory_class, g.is_active,
            COALESCE(m.debit, 0) - COALESCE(m.credit, 0) AS balance
     FROM gl_accounts g
     LEFT JOIN (${MOVEMENT_SQL}) m ON m.gl_code = g.code
     ORDER BY g.code`,
    [from, to]
  );
  return rows.map((r) => ({ ...r, balance: round2(r.balance) }));
}

module.exports = {
  post, reverse, balance, balances, trialBalance, verifyRollup, round2, err,
  MOVEMENT_SQL, MOVEMENT_SQL_TRADING, MOVEMENT_SQL_FROM_LINES,
};
