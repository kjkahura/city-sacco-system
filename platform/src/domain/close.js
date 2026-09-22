'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * Financial years and the year-end close.
 *
 * Closing a year does three things, in this order and in one transaction:
 *
 *   1. sweeps every income and expense account to zero against retained
 *      earnings, so the new year starts from nothing;
 *   2. transfers the configured share of the surplus from retained earnings
 *      to the statutory reserve;
 *   3. marks the year CLOSED, after which a database trigger refuses any
 *      posting dated inside it.
 *
 * The order is not cosmetic. The closing entries are themselves postings
 * inside the year, so they have to land before the lock comes down. Doing it
 * in one transaction means a failure halfway leaves the year open and
 * unswept rather than half closed.
 *
 * The reserve percentage is not shipped. It comes from regulation and from
 * the society's by-laws, and a close refuses to run until someone sets it.
 */

async function settings(c) {
  const { rows } = await c.query('SELECT * FROM close_settings WHERE only_row');
  return rows[0] || null;
}

async function setSettings(c, { statutoryReservePercent, glRetainedEarnings, glStatutoryReserve, sourceNote, createdBy } = {}) {
  const before = await settings(c);
  const { rows } = await c.query(
    `UPDATE close_settings SET
       statutory_reserve_percent = COALESCE($1, statutory_reserve_percent),
       gl_retained_earnings      = COALESCE($2, gl_retained_earnings),
       gl_statutory_reserve      = COALESCE($3, gl_statutory_reserve),
       source_note               = COALESCE($4, source_note),
       updated_at = now()
     WHERE only_row RETURNING *`,
    [statutoryReservePercent ?? null, glRetainedEarnings ?? null,
     glStatutoryReserve ?? null, sourceNote ?? null]
  );
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'CLOSE_SETTINGS_CHANGED','close_settings','only',$2,$3)`,
    [createdBy || 'SYSTEM', JSON.stringify(before), JSON.stringify(rows[0])]
  );
  return rows[0];
}

/** Open a financial year. Overlaps are refused by the database. */
async function openYear(c, { year, startsOn, endsOn, createdBy } = {}) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1900 || y > 2999) throw err('INVALID_FINANCIAL_YEAR');
  const start = startsOn || `${y}-01-01`;
  const end = endsOn || `${y}-12-31`;
  const { rows } = await c.query(
    `INSERT INTO financial_years (year, starts_on, ends_on)
     VALUES ($1,$2::date,$3::date)
     ON CONFLICT (year) DO NOTHING
     RETURNING *`,
    [y, start, end]
  );
  if (!rows.length) throw err(`FINANCIAL_YEAR_ALREADY_EXISTS: ${y}`, 409);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'FINANCIAL_YEAR_OPENED','financial_year',$2,$3)`,
    [createdBy || 'SYSTEM', String(y), JSON.stringify(rows[0])]
  );
  return rows[0];
}

async function years(c) {
  const { rows } = await c.query(
    `SELECT y.*, c.id AS close_id, c.surplus, c.reserve_amount, c.retained_amount
     FROM financial_years y
     LEFT JOIN year_end_closes c ON c.year = y.year AND c.status = 'POSTED'
     ORDER BY y.year DESC`);
  return rows;
}

/**
 * One financial year. `lock` takes a row lock so two closes for the same
 * year cannot interleave; it is off by default because preview runs in a
 * read-only transaction, where FOR UPDATE is an error.
 */
async function yearOf(c, year, { lock = false } = {}) {
  const { rows } = await c.query(
    `SELECT * FROM financial_years WHERE year = $1${lock ? ' FOR UPDATE' : ''}`, [Number(year)]);
  return rows[0] || null;
}

/**
 * What the close would do, without doing it.
 *
 * A board sees this before anyone commits: the surplus, the reserve
 * transfer, and every account that will be swept.
 */
async function preview(c, year) {
  const y = await yearOf(c, year);
  if (!y) throw err(`FINANCIAL_YEAR_NOT_FOUND: ${year}`, 404);
  const s = await settings(c);
  const pct = s?.statutory_reserve_percent;

  const { rows } = await c.query(
    `SELECT g.code, g.name, g.type,
            COALESCE(m.debit,0) - COALESCE(m.credit,0) AS net
     FROM gl_accounts g
     JOIN (${acct.MOVEMENT_SQL}) m ON m.gl_code = g.code
     WHERE g.type IN ('INCOME','EXPENSE')
     ORDER BY g.code`,
    [y.starts_on, y.ends_on]
  );

  // Debit-positive: income sits negative, expense positive.
  const income = rows.filter((r) => r.type === 'INCOME' && Number(r.net) !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: round2(-r.net) }));
  const expenses = rows.filter((r) => r.type === 'EXPENSE' && Number(r.net) !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: round2(r.net) }));

  const totalIncome = round2(income.reduce((s2, r) => s2 + r.amount, 0));
  const totalExpenses = round2(expenses.reduce((s2, r) => s2 + r.amount, 0));
  const surplus = round2(totalIncome - totalExpenses);

  // A deficit is not transferred to reserves. You cannot reserve a loss.
  const reserveAmount = pct === null || pct === undefined || surplus <= 0
    ? 0
    : round2(surplus * Number(pct) / 100);

  return {
    year: y.year,
    period: { from: y.starts_on, to: y.ends_on },
    status: y.status,
    income,
    expenses,
    totalIncome,
    totalExpenses,
    surplus,
    reservePercent: pct === null || pct === undefined ? null : Number(pct),
    reserveAmount,
    retainedAmount: round2(surplus - reserveAmount),
    glRetainedEarnings: s?.gl_retained_earnings || null,
    glStatutoryReserve: s?.gl_statutory_reserve || null,
    configured: pct !== null && pct !== undefined,
  };
}

async function close(c, year, { createdBy = 'SYSTEM' } = {}) {
  const y = await yearOf(c, year, { lock: true });
  if (!y) throw err(`FINANCIAL_YEAR_NOT_FOUND: ${year}`, 404);
  if (y.status === 'CLOSED') throw err(`FINANCIAL_YEAR_ALREADY_CLOSED: ${year}`, 409);

  const s = await settings(c);
  if (!s || s.statutory_reserve_percent === null) {
    throw err('STATUTORY_RESERVE_PERCENT_NOT_CONFIGURED', 409);
  }

  const p = await preview(c, year);
  if (!p.income.length && !p.expenses.length) {
    throw err(`NOTHING_TO_CLOSE_FOR_${year}`, 409);
  }

  // Sweep. Each income account is debited by its credit balance and each
  // expense account credited by its debit balance, which leaves both at
  // zero; the difference lands in retained earnings.
  const debits = p.income.map((r) => ({ glCode: r.code, amount: r.amount }));
  const credits = p.expenses.map((r) => ({ glCode: r.code, amount: r.amount }));
  if (p.surplus > 0) credits.push({ glCode: s.gl_retained_earnings, amount: p.surplus });
  else if (p.surplus < 0) debits.push({ glCode: s.gl_retained_earnings, amount: Math.abs(p.surplus) });

  const closeEntry = await acct.post(c, {
    debits,
    credits,
    narration: `Year-end close ${y.year}`,
    sourceType: 'YEAR_END_CLOSE',
    bookingDate: y.ends_on,
    createdBy,
  });

  let reserveEntry = null;
  if (p.reserveAmount > 0) {
    reserveEntry = await acct.post(c, {
      debits: [{ glCode: s.gl_retained_earnings, amount: p.reserveAmount }],
      credits: [{ glCode: s.gl_statutory_reserve, amount: p.reserveAmount }],
      narration: `Statutory reserve transfer ${y.year} (${p.reservePercent}% of surplus)`,
      sourceType: 'STATUTORY_RESERVE',
      bookingDate: y.ends_on,
      createdBy,
    });
  }

  const { rows: [row] } = await c.query(
    `INSERT INTO year_end_closes
       (year, total_income, total_expenses, surplus, reserve_percent, reserve_amount,
        retained_amount, close_entry_id, reserve_entry_id, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'POSTED',$10)
     ON CONFLICT (year) WHERE status = 'POSTED' DO NOTHING
     RETURNING *`,
    [y.year, p.totalIncome, p.totalExpenses, p.surplus, p.reservePercent, p.reserveAmount,
     p.retainedAmount, closeEntry.entryId, reserveEntry?.entryId || null, createdBy]
  );
  if (!row) throw err(`FINANCIAL_YEAR_ALREADY_CLOSED: ${year}`, 409);

  // Only now does the lock come down, so the entries above were legal when
  // they were written.
  await c.query(
    "UPDATE financial_years SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE year=$1",
    [y.year, createdBy]
  );
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'FINANCIAL_YEAR_CLOSED','financial_year',$2,$3)`,
    [createdBy, String(y.year), JSON.stringify(row)]
  );

  return {
    ...p,
    status: 'CLOSED',
    closeId: row.id,
    closeEntryId: closeEntry.entryId,
    reserveEntryId: reserveEntry?.entryId || null,
  };
}

/**
 * Reopen a closed year by reversing what the close posted.
 *
 * Auditors reopen years, usually because an adjustment arrived late. The
 * reversal is visible rather than tidy: the original close, the reversal and
 * the eventual second close all stay on the record.
 */
async function reopen(c, year, { reason = '', createdBy = 'SYSTEM' } = {}) {
  const y = await yearOf(c, year, { lock: true });
  if (!y) throw err(`FINANCIAL_YEAR_NOT_FOUND: ${year}`, 404);
  if (y.status !== 'CLOSED') throw err(`FINANCIAL_YEAR_NOT_CLOSED: ${year}`, 409);
  if (!reason) throw err('REOPEN_REASON_REQUIRED');

  const { rows: [cl] } = await c.query(
    "SELECT * FROM year_end_closes WHERE year = $1 AND status = 'POSTED' FOR UPDATE", [y.year]);

  // Unlock first: reversing entries are dated inside the year, and the
  // trigger would refuse them while it is still closed.
  await c.query(
    "UPDATE financial_years SET status='OPEN', closed_at=NULL, closed_by=NULL WHERE year=$1",
    [y.year]);

  if (cl) {
    if (cl.reserve_entry_id) {
      await acct.reverse(c, cl.reserve_entry_id, `Reserve transfer reversed: ${reason}`, createdBy);
    }
    if (cl.close_entry_id) {
      await acct.reverse(c, cl.close_entry_id, `Year-end close reversed: ${reason}`, createdBy);
    }
    await c.query("UPDATE year_end_closes SET status='REVERSED' WHERE id=$1", [cl.id]);
  }

  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'FINANCIAL_YEAR_REOPENED','financial_year',$2,$3,$4)`,
    [createdBy, String(y.year), JSON.stringify(y), JSON.stringify({ reason })]
  );
  return { year: y.year, status: 'OPEN', reversedClose: cl?.id || null, reason };
}

module.exports = { settings, setSettings, openYear, years, preview, close, reopen };
