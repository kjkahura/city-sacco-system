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
async function reverse(c, entryId, narration = 'Reversal', createdBy = 'SYSTEM') {
  const { rows: original } = await c.query(
    'SELECT gl_code, direction, amount, member_id FROM journal_lines WHERE entry_id = $1 ORDER BY line_no',
    [entryId]
  );
  if (!original.length) throw err('JOURNAL_ENTRY_NOT_FOUND', 404);

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
  });
}

/** Net movement on one GL account, debit-positive. */
async function balance(c, glCode, { from = null, to = null } = {}) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(CASE WHEN l.direction='DEBIT' THEN l.amount ELSE -l.amount END), 0) AS bal
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.gl_code = $1
       AND ($2::date IS NULL OR e.booking_date >= $2::date)
       AND ($3::date IS NULL OR e.booking_date <= $3::date)`,
    [glCode, from, to]
  );
  return round2(r.bal);
}

async function trialBalance(c, { from = null, to = null } = {}) {
  const { rows } = await c.query(
    `SELECT g.code, g.name, g.type,
            COALESCE(SUM(CASE WHEN l.direction='DEBIT'  THEN l.amount ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE 0 END), 0) AS credit
     FROM gl_accounts g
     LEFT JOIN journal_lines l ON l.gl_code = g.code
     LEFT JOIN journal_entries e ON e.id = l.entry_id
       AND ($1::date IS NULL OR e.booking_date >= $1::date)
       AND ($2::date IS NULL OR e.booking_date <= $2::date)
     GROUP BY g.code, g.name, g.type
     HAVING COALESCE(SUM(l.amount), 0) > 0
     ORDER BY g.code`,
    [from, to]
  );
  const totals = rows.reduce(
    (t, r) => ({ debit: round2(t.debit + r.debit), credit: round2(t.credit + r.credit) }),
    { debit: 0, credit: 0 }
  );
  return {
    rows: rows.map((r) => ({ ...r, balance: round2(r.debit - r.credit) })),
    totals,
    balanced: totals.debit === totals.credit,
  };
}

module.exports = { post, reverse, balance, trialBalance, round2, err };
