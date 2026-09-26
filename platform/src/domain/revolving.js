'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const S = require('./schedule');
const ledger = require('./ledger');
const fees = require('./fees');
const { accrueInterest } = require('./interest');
const types = require('./productTypes');
const G = require('./eodGuard');
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
 *   - Installments may be added by hand (Mambu's Editing Revolving Credit
 *     Loan Schedules), on an application or a running loan: a due date with
 *     nothing on it (loan_billing_dates), filled on that date at the end of
 *     day like any bill, or marked GRACE if there is nothing to bill. The
 *     product's billing dates up to the last date added by hand are not
 *     billed; after it they resume. A date added by hand may be removed
 *     until it is billed; one cannot be added before an installment already
 *     billed.
 */

const { ymd, isoDate } = S;

// What makes a loan revolving (drawdown limits, billing dates) is the
// REVOLVING strategy in ./productTypes/revolving; this module is billing.

/**
 * The next date to bill: the earliest date added by hand not yet billed, or
 * the product's next billing date. A product date on or before the last date
 * added by hand is passed over (it moves past it), since those dates replace
 * the product's in the stretch they cover.
 */
async function nextDue(c, l) {
  const { rows: custom } = await c.query(
    'SELECT * FROM loan_billing_dates WHERE loan_id = $1 AND billed_at IS NULL ORDER BY due_on', [l.id]);
  const { rows: [m] } = await c.query('SELECT max(due_on)::text AS last FROM loan_billing_dates WHERE loan_id = $1', [l.id]);
  let product = l.next_billing_on ? ymd(l.next_billing_on) : null;
  if (product && m?.last && product <= m.last) {
    for (let n = 0; n < 500 && product <= m.last; n += 1) product = nextBillingDate(l, product);
    await c.query('UPDATE loan_accounts SET next_billing_on = $2::date WHERE id = $1', [l.id, product]);
  }
  const hand = custom.length ? ymd(custom[0].due_on) : null;
  if (hand && (!product || hand <= product)) return { date: hand, custom: custom[0] };
  return product ? { date: product, custom: null } : null;
}

/**
 * Generate the installment for a billing date: interest is brought up to
 * the date, and the installment carries the principal the product's method
 * says, the interest owed, and the fees due. Idempotent per date. A date
 * added by hand with nothing to bill gives a GRACE installment.
 */
async function bill(c, loanId, { date, createdBy = 'EOD' } = {}) {
  let l = await ledger.lock(c, loanId);
  if (!isRevolving(l) || !['ACTIVE', 'IN_ARREARS'].includes(l.status)) return null;
  const due = await nextDue(c, l);
  if (!due || due.date > date) return null;
  const billing = due.date;
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
  const dueDate = due.custom ? billing : await ledger.shiftOffClosedDays(c, billing, rule, { notBefore: l.disbursed_on });
  let installment = null;
  const something = principalDue > 0 || interestDue > 0 || feeDue > 0;
  if (something || due.custom) {
    const { rows } = await c.query(
      `INSERT INTO loan_installments (loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [l.id, n.n, dueDate, billing, principalDue, interestDue, feeDue, something ? 'PENDING' : 'GRACE']);
    installment = rows[0];
  }
  let next = l.next_billing_on ? ymd(l.next_billing_on) : null;
  if (due.custom) {
    await c.query('UPDATE loan_billing_dates SET billed_at = now(), installment_id = $2 WHERE id = $1', [due.custom.id, installment.id]);
  } else {
    next = nextBillingDate(l, billing);
    await c.query('UPDATE loan_accounts SET next_billing_on = $2::date, updated_at = now() WHERE id = $1', [l.id, next]);
  }
  return { billed: billing, custom: Boolean(due.custom), installment, next };
}

/** Every revolving loan whose billing date has come, each on its own (./eodGuard). */
async function billAll(c, { asOf = null } = {}) {
  const date = asOf || isoDate(new Date());
  const { rows } = await c.query(
    `SELECT l.id FROM loan_accounts l WHERE l.product_type = 'REVOLVING' AND l.status IN ('ACTIVE','IN_ARREARS') AND ${G.EXCLUDED_SQL('l')}
       AND (l.next_billing_on <= $1::date
            OR EXISTS (SELECT 1 FROM loan_billing_dates d WHERE d.loan_id = l.id AND d.billed_at IS NULL AND d.due_on <= $1::date))`, [date]);
  let billed = 0;
  const run = await G.eachLoan(c, { job: 'billRevolving', date }, rows, async (id) => {
    // A loan may be several billing dates behind; catch each one up.
    for (let guard = 0; guard < 60; guard += 1) {
      const out = await bill(c, id, { date });
      if (!out) break;
      billed += 1;
    }
  });
  return { loans: rows.length, installments: billed, ...G.summary(run) };
}

// --------------------------------------------------------------------------
// Installments added by hand
// --------------------------------------------------------------------------

const EDITABLE = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED'];

/** Add an installment due on `dueDate`, with nothing on it until then. */
async function addInstallment(c, loanId, { dueDate, createdBy } = {}) {
  const l = await ledger.lock(c, loanId);
  if (!isRevolving(l)) throw err('NOT_A_REVOLVING_LOAN', 409);
  if (!EDITABLE.includes(l.status)) throw err(`SCHEDULE_NOT_EDITABLE_IN_STATE_${l.status}`, 409);
  const d = dueDate ? String(dueDate).slice(0, 10) : null;
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw err('A_DUE_DATE_IS_REQUIRED', 400);
  if (l.disbursed_on && d <= ymd(l.disbursed_on)) throw err(`DUE_DATE_MUST_BE_AFTER_DISBURSEMENT: ${ymd(l.disbursed_on)}`, 400);
  const { rows: [last] } = await c.query('SELECT max(due_date)::text AS d FROM loan_installments WHERE loan_id = $1', [l.id]);
  if (last?.d && d <= last.d) throw err(`DUE_DATE_MUST_BE_AFTER_THE_LAST_INSTALLMENT: ${last.d}`, 409);
  const until = validUntil(l);
  if (until && d > until) throw err(`DUE_DATE_AFTER_THE_LIMIT_EXPIRES: ${until}`, 409);
  const { rows: [row] } = await c.query(
    `INSERT INTO loan_billing_dates (loan_id, due_on, created_by) VALUES ($1,$2::date,$3)
     ON CONFLICT (loan_id, due_on) DO NOTHING RETURNING *`, [l.id, d, createdBy || 'SYSTEM']);
  if (!row) throw err(`AN_INSTALLMENT_IS_ALREADY_DUE_ON_${d}`, 409);
  await c.query(
    `INSERT INTO loan_schedule_edits (loan_id, kind, before, after, note, created_by) VALUES ($1,'EDIT','[]',$2,$3,$4)`,
    [l.id, JSON.stringify([{ dueDate: d, custom: true }]), 'installment added by hand', createdBy || 'SYSTEM']);
  return row;
}

/** Remove an installment added by hand, while nothing has been billed on it. */
async function removeInstallment(c, loanId, billingDateId, { createdBy } = {}) {
  const l = await ledger.lock(c, loanId);
  const { rows: [row] } = await c.query('SELECT * FROM loan_billing_dates WHERE id = $1 AND loan_id = $2 FOR UPDATE', [billingDateId, l.id]);
  if (!row) throw err('INSTALLMENT_ADDED_BY_HAND_NOT_FOUND', 404);
  if (row.billed_at) throw err('INSTALLMENT_ALREADY_BILLED: only one not yet due may be removed', 409);
  await c.query('DELETE FROM loan_billing_dates WHERE id = $1', [row.id]);
  await c.query(
    `INSERT INTO loan_schedule_edits (loan_id, kind, before, after, note, created_by) VALUES ($1,'EDIT',$2,'[]',$3,$4)`,
    [l.id, JSON.stringify([{ dueDate: ymd(row.due_on), custom: true }]), 'installment added by hand removed', createdBy || 'SYSTEM']);
  return { removed: row.id, dueDate: ymd(row.due_on) };
}

/**
 * The revolving schedule: the installments billed, then the dates added by
 * hand still to come (PENDING, nothing on them yet) and the product's next
 * billing date.
 */
async function schedule(c, loanId) {
  const l = await ledger.read(c, loanId);
  if (!isRevolving(l)) throw err('NOT_A_REVOLVING_LOAN', 409);
  const { rows: billed } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [l.id]);
  const { rows: pending } = await c.query(
    'SELECT id, due_on FROM loan_billing_dates WHERE loan_id = $1 AND billed_at IS NULL ORDER BY due_on', [l.id]);
  const { rows: [m] } = await c.query('SELECT max(due_on)::text AS last FROM loan_billing_dates WHERE loan_id = $1', [l.id]);
  let product = l.next_billing_on ? ymd(l.next_billing_on) : null;
  if (product && m?.last) while (product <= m.last) product = nextBillingDate(l, product);
  return {
    loanId: l.id,
    installments: billed.map((i) => ({ number: i.number, dueDate: ymd(i.due_date), principal: Number(i.principal_due), interest: Number(i.interest_due),
      fee: Number(i.fee_due), status: i.status, custom: false })),
    addedByHand: pending.map((p) => ({ id: p.id, dueDate: ymd(p.due_on), status: 'PENDING' })),
    nextProductBilling: product,
  };
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

module.exports = {
  isRevolving, validUntil, available, firstBillingDate, nextBillingDate, bill, billAll, depositToCreditBalance,
  addInstallment, removeInstallment, schedule,
};
