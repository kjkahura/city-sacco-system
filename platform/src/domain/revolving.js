'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const S = require('./schedule');
const ledger = require('./ledger');
const fees = require('./fees');
const { accrueInterest } = require('./interest');
const types = require('./productTypes');
const { validUntil, available, firstBillingDate, nextBillingDate } = require('./productTypes/revolving');
const { isRevolving } = types;
const { err, round2 } = acct;

/**
 * Revolving credit, after Mambu's "Revolving Loans" and "Credit Balance for
 * Revolving Loans": a limit the member draws on and repays as they like.
 *
 *   - loan_accounts.principal is the limit; drawdowns add to
 *     principal_disbursed, repayments to principal_paid; available =
 *     limit − outstanding + credit balance.
 *   - There is no schedule up front. On each billing date (the product's
 *     interval or fixed days) an installment is generated from the balance:
 *     principal by the product's repayment method, the interest accrued to
 *     that day, and any fees due. From there arrears, penalties and late
 *     fees work as on any loan.
 *   - Interest accrues daily on the actual balance (REDUCING, SIMPLE on
 *     principal only or principal and interest).
 *   - The credit balance is the member's own money: an overpayment lands
 *     there (up to the product's maximum) instead of in savings, funds the
 *     next drawdown first, and blocks closing while it is above zero.
 *   - The limit runs for term_months from the first drawdown; after that no
 *     more drawdowns, repayment continues.
 */

const { ymd, isoDate } = S;

// What makes a loan revolving (drawdown limits, billing dates) is the
// REVOLVING strategy in ./productTypes/revolving; this module is billing.

/**
 * Generate the installment for a billing date: interest is brought up to
 * the date, and the installment carries the principal the product's method
 * says, the interest owed, and the fees due. Idempotent per date.
 */
async function bill(c, loanId, { date, createdBy = 'EOD' } = {}) {
  let l = await ledger.lock(c, loanId);
  if (!isRevolving(l) || !['ACTIVE', 'IN_ARREARS'].includes(l.status)) return null;
  if (!l.next_billing_on || ymd(l.next_billing_on) > date) return null;
  const billing = ymd(l.next_billing_on);
  await accrueInterest(c, l.id, { valueDate: billing, createdBy });
  await fees.applyPaymentDueFees(c, l, billing);
  l = await ledger.lock(c, l.id);
  const b = ledger.balances(l);

  // Fees and interest not already carried by an earlier installment.
  const { rows: [carried] } = await c.query(
    `SELECT COALESCE(SUM(interest_due - interest_paid), 0) AS i, COALESCE(SUM(fee_due - fee_paid), 0) AS f
     FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID'`, [l.id]);
  const interestDue = round2(Math.max(0, b.interest - Number(carried.i)));
  const feeDue = round2(Math.max(0, b.fees - Number(carried.f)));

  const value = ledger.effective(l).revolvingRepaymentValue;
  let principalDue;
  switch (l.revolving_repayment_method) {
    case 'PRINCIPAL_FLAT': principalDue = value; break;
    case 'PRINCIPAL_PERCENT': principalDue = round2(b.principal * value / 100); break;
    case 'TOTAL_DUE_PERCENT': principalDue = round2(Math.max(0, b.total * value / 100 - interestDue - feeDue)); break;
    default: principalDue = 0;
  }
  if (l.revolving_repayment_floor !== null && l.revolving_repayment_floor !== undefined) principalDue = Math.max(principalDue, Number(l.revolving_repayment_floor));
  if (l.revolving_repayment_ceiling !== null && l.revolving_repayment_ceiling !== undefined) principalDue = Math.min(principalDue, Number(l.revolving_repayment_ceiling));
  principalDue = round2(Math.min(principalDue, b.principal));

  const { rows: [n] } = await c.query('SELECT COALESCE(max(number), 0) + 1 AS n FROM loan_installments WHERE loan_id = $1', [l.id]);
  // A bill is not a schedule to extend: under Extend Schedule it moves forward.
  const rule = l.non_working_days === 'EXTEND_SCHEDULE' ? 'MOVE_FORWARD' : (l.non_working_days || 'MOVE_FORWARD');
  const dueDate = await ledger.shiftOffClosedDays(c, billing, rule, { notBefore: l.disbursed_on });
  let installment = null;
  if (principalDue > 0 || interestDue > 0 || feeDue > 0) {
    const { rows } = await c.query(
      `INSERT INTO loan_installments (loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING') RETURNING *`,
      [l.id, n.n, dueDate, billing, principalDue, interestDue, feeDue]);
    installment = rows[0];
  }
  const next = nextBillingDate(l, billing);
  await c.query('UPDATE loan_accounts SET next_billing_on = $2::date, updated_at = now() WHERE id = $1', [l.id, next]);
  return { billed: billing, installment, next };
}

/** Every revolving loan whose billing date has come. */
async function billAll(c, { asOf = null } = {}) {
  const date = asOf || isoDate(new Date());
  const { rows } = await c.query(
    "SELECT id FROM loan_accounts WHERE product_type = 'REVOLVING' AND status IN ('ACTIVE','IN_ARREARS') AND next_billing_on <= $1::date", [date]);
  let billed = 0;
  for (const r of rows) {
    // A loan may be several billing dates behind; catch each one up.
    for (let guard = 0; guard < 60; guard += 1) {
      const out = await bill(c, r.id, { date });
      if (!out) break;
      billed += 1;
    }
  }
  return { loans: rows.length, installments: billed };
}

/** The member tops up their credit balance ahead of a drawdown. */
async function depositToCreditBalance(c, loanId, { amount, channelId = 'cash', valueDate, createdBy }) {
  const l = await ledger.lock(c, loanId);
  if (!isRevolving(l)) throw err('NOT_A_REVOLVING_LOAN', 409);
  if (!l.credit_balance_enabled) throw err('CREDIT_BALANCE_NOT_ENABLED', 409);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT', 400);
  if (l.max_credit_balance !== null && round2(l.credit_balance) + amt > Number(l.max_credit_balance)) {
    throw err(`EXCEEDS_MAX_CREDIT_BALANCE: ${l.max_credit_balance}`, 409);
  }
  const ch = (await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId])).rows[0];
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const entryId = await ledger.post(c, l, {
    debits: [{ glCode: ch.gl_account_code, amount: amt, memberId: l.member_id }],
    credits: [{ glCode: l.gl_credit_balance, amount: amt, memberId: l.member_id }],
    narration: `Credit balance deposit ${l.account_no}`, sourceType: 'CREDIT_BALANCE_DEPOSIT', sourceId: l.id, channelId,
    bookingDate: date, createdBy,
  });
  await c.query('UPDATE loan_accounts SET credit_balance = credit_balance + $1, updated_at = now() WHERE id = $2', [amt, l.id]);
  return savings.record(c, {
    reference: savings.ref('CB'), kind: 'CREDIT_BALANCE_DEPOSIT', memberId: l.member_id, loanAccountId: l.id,
    channelId, amount: amt, valueDate: date, entryId, createdBy,
  });
}

module.exports = { isRevolving, validUntil, available, firstBillingDate, nextBillingDate, bill, billAll, depositToCreditBalance };
