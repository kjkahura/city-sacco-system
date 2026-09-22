'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const { pageQuery } = require('../lib/page');
const { err, round2 } = acct;

const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;

/**
 * Share capital and the dividend cycle.
 *
 * Shares are equity, not a deposit: buying them credits share capital, and a
 * dividend is a distribution out of retained earnings, not interest expense.
 * That distinction is what keeps the balance sheet honest.
 */

async function lock(c, accountId) {
  const { rows } = await c.query(
    `SELECT a.*, p.unit_price, p.min_units, p.gl_equity
     FROM share_accounts a JOIN share_products p ON p.id = a.product_id
     WHERE a.id::text = $1 OR a.account_no = $1
     FOR UPDATE OF a`,
    [accountId]
  );
  if (!rows.length) throw err('SHARE_ACCOUNT_NOT_FOUND', 404);
  return rows[0];
}

async function open(c, { memberId, productId = 'SHR01', accountNo }) {
  const no = accountNo || (await c.query(
    `SELECT 'SH' || lpad((count(*)+1)::text, 6, '0') AS n FROM share_accounts`)).rows[0].n;
  const { rows } = await c.query(
    `INSERT INTO share_accounts (account_no, member_id, product_id) VALUES ($1,$2,$3) RETURNING *`,
    [no, memberId, productId]
  );
  return rows[0];
}

async function purchase(c, accountId, { units, channelId = 'cash', valueDate, narration, createdBy }) {
  const a = await lock(c, accountId);
  if (a.status !== 'ACTIVE') throw err(`SHARE_ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  const u = round4(units);
  if (!(u > 0)) throw err('INVALID_UNITS');

  const { rows: [ch] } = await c.query(
    'SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId]);
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);

  const amount = round2(u * Number(a.unit_price));

  const entry = await acct.post(c, {
    debits: [{ glCode: ch.gl_account_code, amount, memberId: a.member_id }],
    credits: [{ glCode: a.gl_equity, amount, memberId: a.member_id }],
    narration: narration || `Share purchase ${a.account_no}`,
    sourceType: 'SHARE_PURCHASE', sourceId: a.id, channelId,
    bookingDate: valueDate, createdBy,
  });

  await c.query('UPDATE share_accounts SET units = units + $1 WHERE id = $2', [u, a.id]);
  await c.query(
    `INSERT INTO share_movements (account_id, member_id, units, unit_price, amount, kind, entry_id, value_date)
     VALUES ($1,$2,$3,$4,$5,'PURCHASE',$6,COALESCE($7::date, current_date))`,
    [a.id, a.member_id, u, a.unit_price, amount, entry.entryId, valueDate || null]
  );

  return savings.record(c, {
    reference: savings.ref('SP'), kind: 'SHARE_PURCHASE', memberId: a.member_id,
    shareAccountId: a.id, channelId, amount, valueDate, entryId: entry.entryId,
    allocation: { units: u, unitPrice: Number(a.unit_price) }, narration, createdBy,
  });
}

/**
 * Share transfer between members. No GL movement: share capital is unchanged,
 * only who holds it. The movement rows carry the ownership change.
 */
async function transfer(c, fromAccountId, { toAccountId, units, valueDate, narration, createdBy }) {
  const from = await lock(c, fromAccountId);
  const to = await lock(c, toAccountId);
  if (from.id === to.id) throw err('SAME_ACCOUNT_TRANSFER');
  const u = round4(units);
  if (!(u > 0)) throw err('INVALID_UNITS');
  if (u > Number(from.units)) {
    throw err(`INSUFFICIENT_UNITS: holds ${from.units}, transferring ${u}`, 409);
  }
  if (round4(Number(from.units) - u) < Number(from.min_units)) {
    throw err(`TRANSFER_WOULD_BREACH_MINIMUM_HOLDING: min ${from.min_units}`, 409);
  }

  const amount = round2(u * Number(from.unit_price));
  await c.query('UPDATE share_accounts SET units = units - $1 WHERE id = $2', [u, from.id]);
  await c.query('UPDATE share_accounts SET units = units + $1 WHERE id = $2', [u, to.id]);
  await c.query(
    `INSERT INTO share_movements (account_id, member_id, units, unit_price, amount, kind, value_date)
     VALUES ($1,$2,$3,$4,$5,'TRANSFER_OUT',COALESCE($6::date, current_date)),
            ($7,$8,$9,$4,$5,'TRANSFER_IN', COALESCE($6::date, current_date))`,
    [from.id, from.member_id, -u, from.unit_price, amount, valueDate || null,
     to.id, to.member_id, u]
  );

  return savings.record(c, {
    reference: savings.ref('STR'), kind: 'SHARE_TRANSFER', memberId: from.member_id,
    shareAccountId: from.id, amount, valueDate,
    allocation: { units: u, toAccountId: to.id, toMemberId: to.member_id },
    narration, createdBy,
  });
}

// --------------------------------------------------------------------------
// Dividend cycle: declare -> allocate -> pay
// --------------------------------------------------------------------------

/**
 * The AGM declares a rate for a financial year against a record date.
 * Nothing is posted yet; declaration is a decision, not a payment.
 */
async function declare(c, { financialYear, ratePercent, recordDate, basis = 'UNITS', glPayable = '200-200', createdBy }) {
  const rate = Number(ratePercent);
  if (!(rate > 0) || rate > 100) throw err('INVALID_DIVIDEND_RATE');
  const { rows } = await c.query(
    `INSERT INTO dividends (financial_year, rate_percent, record_date, basis, gl_payable, status)
     VALUES ($1,$2,COALESCE($3::date, current_date),$4,$5,'DECLARED')
     ON CONFLICT (financial_year) DO NOTHING
     RETURNING *`,
    [financialYear, rate, recordDate || null, basis, glPayable]
  );
  if (!rows.length) throw err(`DIVIDEND_ALREADY_DECLARED_FOR_${financialYear}`, 409);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'DIVIDEND_DECLARED','dividend',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]
  );
  return rows[0];
}

/**
 * Allocate by shareholding as at the record date, then post the whole
 * distribution as one journal entry: retained earnings out, dividends
 * payable in. Members are not paid yet.
 *
 * Rounding: each member's amount is rounded to the cent, and the residual
 * from rounding goes to the largest holder rather than being lost. The
 * journal entry is posted for the sum of what was actually allocated, so
 * the payable matches the allocations exactly.
 */
async function allocate(c, financialYear, { createdBy } = {}) {
  const { rows: [d] } = await c.query(
    'SELECT * FROM dividends WHERE financial_year = $1 FOR UPDATE', [financialYear]);
  if (!d) throw err('DIVIDEND_NOT_FOUND', 404);
  if (d.status !== 'DECLARED') throw err(`DIVIDEND_ALREADY_${d.status}`, 409);

  const { rows: holders } = await c.query(
    `SELECT m.id AS member_id, units_as_at(m.id, $1::date) AS units
     FROM members m
     WHERE units_as_at(m.id, $1::date) > 0
     ORDER BY units_as_at(m.id, $1::date) DESC, m.id`,
    [d.record_date]
  );
  if (!holders.length) throw err('NO_SHAREHOLDERS_AT_RECORD_DATE', 409);

  const { rows: [p] } = await c.query('SELECT unit_price FROM share_products ORDER BY id LIMIT 1');
  const unitPrice = Number(p?.unit_price || 1);
  const rate = Number(d.rate_percent) / 100;

  const totalUnits = round4(holders.reduce((s, h) => s + Number(h.units), 0));
  const allocations = holders.map((h) => ({
    memberId: h.member_id,
    units: round4(h.units),
    amount: round2(Number(h.units) * unitPrice * rate),
  }));

  // Rounding residual to the largest holder, so the sum of allocations is
  // exactly the amount posted to the payable account.
  const exact = round2(Number(totalUnits) * unitPrice * rate);
  const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
  const residual = round2(exact - allocated);
  if (residual !== 0 && allocations.length) {
    allocations[0].amount = round2(allocations[0].amount + residual);
  }
  const total = round2(allocations.reduce((s, a) => s + a.amount, 0));
  if (!(total > 0)) throw err('DIVIDEND_TOTAL_IS_ZERO', 409);

  const entry = await acct.post(c, {
    debits: [{ glCode: '300-200', amount: total }],          // retained earnings
    credits: [{ glCode: d.gl_payable, amount: total }],      // dividends payable
    narration: `Dividend ${financialYear} at ${d.rate_percent}%`,
    sourceType: 'DIVIDEND_ALLOCATION', sourceId: d.id, createdBy,
  });

  for (const a of allocations) {
    await c.query(
      `INSERT INTO dividend_allocations (dividend_id, member_id, units, amount, entry_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [d.id, a.memberId, a.units, a.amount, entry.entryId]
    );
  }

  const { rows } = await c.query(
    `UPDATE dividends SET status='ALLOCATED', total_units=$1, total_amount=$2,
       declared_entry=$3, allocated_at=now() WHERE id=$4 RETURNING *`,
    [totalUnits, total, entry.entryId, d.id]
  );
  return { dividend: rows[0], holders: allocations.length, total, residualAppliedTo: residual !== 0 ? allocations[0].memberId : null };
}

/**
 * Pay out: dividends payable is cleared into each member's savings account.
 * Members without a savings account are reported, not silently skipped.
 */
async function pay(c, financialYear, { createdBy } = {}) {
  const { rows: [d] } = await c.query(
    'SELECT * FROM dividends WHERE financial_year = $1 FOR UPDATE', [financialYear]);
  if (!d) throw err('DIVIDEND_NOT_FOUND', 404);
  if (d.status !== 'ALLOCATED') throw err(`DIVIDEND_IS_${d.status}_NOT_ALLOCATED`, 409);

  const { rows: allocations } = await c.query(
    `SELECT a.*, s.id AS savings_id, sp.gl_liability
     FROM dividend_allocations a
     LEFT JOIN LATERAL (
       SELECT id, product_id FROM savings_accounts
       WHERE member_id = a.member_id AND status = 'ACTIVE'
       ORDER BY opened_on LIMIT 1
     ) s ON true
     LEFT JOIN savings_products sp ON sp.id = s.product_id
     WHERE a.dividend_id = $1 AND a.paid_at IS NULL`,
    [d.id]
  );

  const paid = [];
  const skipped = [];
  for (const a of allocations) {
    if (!a.savings_id) { skipped.push({ memberId: a.member_id, amount: a.amount, reason: 'NO_ACTIVE_SAVINGS_ACCOUNT' }); continue; }

    const entry = await acct.post(c, {
      debits: [{ glCode: d.gl_payable, amount: a.amount, memberId: a.member_id }],
      credits: [{ glCode: a.gl_liability, amount: a.amount, memberId: a.member_id }],
      narration: `Dividend ${financialYear} payout`,
      sourceType: 'DIVIDEND_PAYOUT', sourceId: d.id, channelId: 'internal', createdBy,
    });
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2',
      [a.amount, a.savings_id]);
    await c.query(
      'UPDATE dividend_allocations SET paid_at = now(), savings_account_id = $1, entry_id = $2 WHERE id = $3',
      [a.savings_id, entry.entryId, a.id]
    );
    await savings.record(c, {
      reference: savings.ref('DV'), kind: 'DIVIDEND_PAYOUT', memberId: a.member_id,
      savingsAccountId: a.savings_id, channelId: 'internal', amount: a.amount,
      entryId: entry.entryId, allocation: { financialYear, units: a.units }, createdBy,
    });
    paid.push({ memberId: a.member_id, amount: a.amount });
  }

  // Only fully paid when nothing is left hanging.
  if (!skipped.length) {
    await c.query("UPDATE dividends SET status='PAID', paid_at=now() WHERE id=$1", [d.id]);
  }

  return {
    financialYear,
    paidCount: paid.length,
    paidTotal: round2(paid.reduce((s, x) => s + x.amount, 0)),
    skipped,
    status: skipped.length ? 'ALLOCATED' : 'PAID',
  };
}

/**
 * Reverse a share purchase.
 *
 * Refused if the member no longer holds the units, because the shares may
 * have been transferred on and reversing would drive the holding negative.
 * Also refused once a dividend has been allocated against a record date on
 * or after the purchase: the allocation used that holding, so unwinding the
 * purchase silently would leave the dividend overstated with nothing to
 * show why.
 */
async function reversePurchase(c, reference, { narration = 'Reversal', createdBy } = {}) {
  const { rows } = await c.query(
    'SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]);
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.kind !== 'SHARE_PURCHASE') throw err('NOT_A_SHARE_PURCHASE');
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);

  const units = round4(tx.allocation?.units);
  if (!(units > 0)) throw err('TRANSACTION_HAS_NO_UNITS');

  const a = await lock(c, tx.share_account_id);
  if (Number(a.units) < units) {
    throw err(
      `CANNOT_REVERSE_UNITS_NO_LONGER_HELD: holds ${a.units}, purchase was ${units}`, 409);
  }

  const { rows: [blocking] } = await c.query(
    `SELECT d.financial_year FROM dividend_allocations da
     JOIN dividends d ON d.id = da.dividend_id
     WHERE da.member_id = $1 AND d.record_date >= $2::date
     ORDER BY d.financial_year LIMIT 1`,
    [a.member_id, tx.value_date]
  );
  if (blocking) {
    throw err(
      `DIVIDEND_${blocking.financial_year}_ALREADY_ALLOCATED_ON_THIS_HOLDING; `
      + 'reverse or adjust the dividend first', 409);
  }

  const entry = await acct.reverse(c, tx.entry_id, narration, createdBy);

  await c.query('UPDATE share_accounts SET units = units - $1 WHERE id = $2', [units, a.id]);
  await c.query(
    `INSERT INTO share_movements (account_id, member_id, units, unit_price, amount, kind, entry_id, value_date)
     VALUES ($1,$2,$3,$4,$5,'REVERSAL',$6,$7::date)`,
    [a.id, a.member_id, -units, a.unit_price, tx.amount, entry.entryId, tx.value_date]
  );

  const rev = await savings.record(c, {
    reference: savings.ref('REV'), kind: 'REVERSAL', memberId: a.member_id,
    shareAccountId: a.id, amount: -tx.amount, entryId: entry.entryId,
    allocation: { reversalOf: tx.reference, units: -units }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

/**
 * The share register: one row per member holding units.
 *
 * It grows with membership, so it pages in SQL. The total units and the
 * member count are computed over the whole register, not the page, because
 * the register's own footer is the number people quote at an AGM.
 */
async function register(c, { asAt = null, offset = 0, limit = 50 } = {}) {
  const sql = `
    SELECT m.id AS member_id, m.member_no, m.first_name, m.last_name,
           units_as_at(m.id, COALESCE($1::date, current_date)) AS units
    FROM members m
    WHERE units_as_at(m.id, COALESCE($1::date, current_date)) > 0
    ORDER BY units DESC, m.member_no`;

  const { rows: [t] } = await c.query(
    `SELECT COALESCE(SUM(units),0) AS units, count(*)::int AS holders FROM (${sql}) r`, [asAt]);

  const p = await pageQuery(c, sql, [asAt], { offset, limit });
  return {
    asAt: asAt || new Date().toISOString().slice(0, 10),
    holders: p.items,
    totalUnits: Number(t.units),
    totalHolders: t.holders,
    page: { offset: p.offset, limit: p.limit, total: p.total, hasMore: p.hasMore },
  };
}

module.exports = { open, purchase, transfer, reversePurchase, declare, allocate, pay, register, lock };
