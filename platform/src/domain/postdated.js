'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const types = require('./productTypes');
const loans = require('./loans');
const G = require('./eodGuard');
const { err, round2 } = acct;
const { ymd, isoDate } = S;

/**
 * Postdated payments on fixed-term loans, after Mambu's option of the same
 * name: a payment recorded now with a later value date (a postdated cheque,
 * a standing order, a salary check-off promised for a date). Nothing moves
 * when it is recorded. The end of day on its value date applies it as an
 * ordinary repayment (loans.repay) dated that day, so the interest, fees and
 * installments it settles are those of that date, not of the day it was
 * taken in.
 *
 *   schedule         one payment, any amount, any later date
 *   forInstallments  one per unpaid installment not yet due, for what the
 *                    installment still owes, on its due date
 *   cancel           while it is still pending
 *   applyDue         the end-of-day job: every pending payment whose value
 *                    date has come; one that cannot be applied (the loan
 *                    has closed, the channel has gone) is marked FAILED with
 *                    the reason and the rest carry on
 *
 * Postdated payments may not add up to more than the schedule still owes.
 *
 * This module stands above ./loans, like ./restructure.
 */

const today = () => isoDate(new Date());

async function loanFor(c, loanId, asOf) {
  const l = await ledger.lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  if (types.forLoan(l).basis !== 'SCHEDULE') throw err('POSTDATED_PAYMENTS_ARE_FOR_FIXED_TERM_LOANS', 409);
  if (!l.allow_postdated_payments) throw err('PRODUCT_DOES_NOT_ALLOW_POSTDATED_PAYMENTS', 409);
  return { l, date: asOf ? ymd(asOf) : today() };
}

async function channel(c, channelId) {
  const { rows: [ch] } = await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId]);
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`, 400);
  return ch;
}

/** What the loan's schedule still owes, with penalties owed, and what is already postdated. */
async function room(c, l) {
  const { rows: [s] } = await c.query(
    `SELECT COALESCE(sum(principal_due - principal_paid + interest_due - interest_paid + fee_due - fee_paid), 0) AS owed
     FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID'`, [l.id]);
  const { rows: [p] } = await c.query(
    "SELECT COALESCE(sum(amount), 0) AS pending FROM loan_postdated_payments WHERE loan_id = $1 AND status = 'PENDING'", [l.id]);
  const b = ledger.balances(l);
  const owed = round2(Number(s.owed) + b.penalty);
  return { owed, pending: round2(Number(p.pending)), free: round2(owed - Number(p.pending)) };
}

async function insert(c, l, x) {
  const { rows: [r] } = await c.query(
    `INSERT INTO loan_postdated_payments (loan_id, amount, value_date, channel_id, reference, note, installment_no, created_by)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8) RETURNING *`,
    [l.id, x.amount, x.valueDate, x.channelId, x.reference || null, x.note || null, x.installmentNo || null, x.createdBy || 'SYSTEM']);
  return r;
}

/** Record one postdated payment. */
async function schedule(c, loanId, { amount, valueDate, channelId = 'bank', reference = null, note = null, asOf = null, createdBy } = {}) {
  const { l, date } = await loanFor(c, loanId, asOf);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_POSTDATED_AMOUNT', 400);
  const on = valueDate ? String(valueDate).slice(0, 10) : null;
  if (!on || !/^\d{4}-\d{2}-\d{2}$/.test(on)) throw err('A_POSTDATED_PAYMENT_NEEDS_A_VALUE_DATE', 400);
  if (on <= date) throw err(`VALUE_DATE_NOT_IN_THE_FUTURE: ${on}; record a repayment instead`, 400);
  await channel(c, channelId);
  const r = await room(c, l);
  if (amt > r.free) throw err(`POSTDATED_PAYMENTS_EXCEED_WHAT_THE_SCHEDULE_OWES: ${r.free} is left of ${r.owed}`, 409);
  return insert(c, l, { amount: amt, valueDate: on, channelId, reference, note, createdBy });
}

/**
 * One postdated payment per unpaid installment not yet due (from
 * installment `from`, if given), for what it still owes, on its due date.
 * An installment that already has a pending postdated payment on its date
 * is left alone.
 */
async function forInstallments(c, loanId, { channelId = 'bank', reference = null, note = null, from = null, asOf = null, createdBy } = {}) {
  const { l, date } = await loanFor(c, loanId, asOf);
  await channel(c, channelId);
  const { rows } = await c.query(
    `SELECT i.*, (principal_due - principal_paid + interest_due - interest_paid + fee_due - fee_paid) AS owes
     FROM loan_installments i WHERE loan_id = $1 AND status NOT IN ('PAID', 'GRACE') AND due_date > $2::date
       AND ($3::int IS NULL OR number >= $3::int)
       AND NOT EXISTS (SELECT 1 FROM loan_postdated_payments p WHERE p.loan_id = i.loan_id AND p.status = 'PENDING' AND p.value_date = i.due_date)
     ORDER BY number`, [l.id, date, from === null || from === undefined ? null : Number(from)]);
  const lines = rows.filter((i) => Number(i.owes) > 0);
  if (!lines.length) throw err('NO_INSTALLMENT_TO_POSTDATE: every one not yet due is paid or already postdated', 409);
  const r = await room(c, l);
  const total = round2(lines.reduce((a, i) => a + Number(i.owes), 0));
  if (total > r.free) throw err(`POSTDATED_PAYMENTS_EXCEED_WHAT_THE_SCHEDULE_OWES: ${r.free} is left of ${r.owed}`, 409);
  const made = [];
  for (const i of lines) {
    made.push(await insert(c, l, {
      amount: round2(Number(i.owes)), valueDate: ymd(i.due_date), channelId, installmentNo: i.number,
      reference: reference ? `${reference}-${i.number}` : null, note, createdBy,
    }));
  }
  return made;
}

async function cancel(c, id, { reason = null, createdBy } = {}) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_postdated_payments WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw err('POSTDATED_PAYMENT_NOT_FOUND', 404);
  if (p.status !== 'PENDING') throw err(`POSTDATED_PAYMENT_IS_${p.status}`, 409);
  const { rows: [r] } = await c.query(
    `UPDATE loan_postdated_payments SET status = 'CANCELLED', failure = $2, settled_by = $3, settled_at = now()
     WHERE id = $1 RETURNING *`, [id, reason, createdBy || 'SYSTEM']);
  return r;
}

async function forLoan(c, loanId) {
  const l = await ledger.read(c, loanId);
  const { rows } = await c.query('SELECT * FROM loan_postdated_payments WHERE loan_id = $1 ORDER BY value_date, id', [l.id]);
  return rows;
}

/**
 * Apply every pending postdated payment whose value date is on or before
 * `asOf`, oldest first, each in its own savepoint so one that fails is
 * recorded as FAILED without undoing the others.
 */
async function applyDue(c, { asOf = null, createdBy = 'EOD', loanId = null } = {}) {
  const date = asOf ? ymd(asOf) : today();
  const { rows } = await c.query(
    `SELECT * FROM loan_postdated_payments WHERE status = 'PENDING' AND value_date <= $1::date
       AND ${G.EXCLUDED_ID_SQL('loan_id')} AND ($2::uuid IS NULL OR loan_id = $2::uuid)
     ORDER BY value_date, id FOR UPDATE`, [date, loanId]);
  const out = { due: rows.length, applied: 0, failed: 0, amount: 0 };
  for (const p of rows) {
    await c.query('SAVEPOINT postdated');
    try {
      const tx = await loans.repay(c, p.loan_id, {
        amount: Number(p.amount), channelId: p.channel_id, valueDate: ymd(p.value_date),
        narration: `Postdated payment${p.reference ? ` ${p.reference}` : ''}`, createdBy: p.created_by || createdBy,
      });
      await c.query('RELEASE SAVEPOINT postdated');
      await c.query(
        `UPDATE loan_postdated_payments SET status = 'APPLIED', transaction_ref = $2, settled_by = $3, settled_at = now() WHERE id = $1`,
        [p.id, tx.reference, createdBy]);
      out.applied += 1;
      out.amount = round2(out.amount + Number(p.amount));
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT postdated');
      await c.query(
        `UPDATE loan_postdated_payments SET status = 'FAILED', failure = $2, settled_by = $3, settled_at = now() WHERE id = $1`,
        [p.id, String(e.message).slice(0, 500), createdBy]);
      out.failed += 1;
    }
  }
  return out;
}

module.exports = { schedule, forInstallments, cancel, forLoan, applyDue };
