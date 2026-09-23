'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const fees = require('./fees');
const { err, round2 } = acct;
const { ymd, isoDate, toUTC, dayCount, annuityPayment } = S;
const {
  principalOutstanding, balances, isDynamic, isRevolving, scheduleInputs, shiftOffClosedDays,
} = require('./ledger');

/**
 * A loan's installments: drawing the schedule at disbursement, previewing
 * one before there is a loan, redrawing a dynamic loan's future after a
 * prepayment, and spreading payments over what is due.
 *
 * The arithmetic is ./schedule (pure); this module is where it meets the
 * loan_installments table. Payment-due fees and, on fixed-term loans, the
 * upfront disbursement fees are placed on the schedule by ./fees.
 */

async function persistInstallments(c, loanId, installments) {
  for (const i of installments) {
    await c.query(
      `INSERT INTO loan_installments (loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [loanId, i.number, i.dueDate, i.nominalDue, i.principal, i.interest, i.fee || 0,
        i.grace === 'PURE' && !(i.fee > 0) ? 'GRACE' : 'PENDING']
    );
  }
}

/**
 * The schedule a loan is given at disbursement, on the product's repayment
 * interval, grace, amortisation and rounding. For a FIXED_TERM loan this
 * schedule is the contract; for a DYNAMIC_TERM loan it is the expectation
 * if every installment is paid on its date, and a prepayment regenerates it
 * (see reschedule).
 *
 * Payment-due fees and, on fixed-term loans, the upfront disbursement fees
 * are placed on the schedule by ./fees, which is called here.
 */
async function buildSchedule(c, l, { persist = true } = {}) {
  const count = Number(l.term_months);
  const principal = Number(l.principal_disbursed) > 0 ? principalOutstanding(l) : Number(l.principal);
  if (!principal || !count) throw err('LOAN_MISSING_PRINCIPAL_OR_TERM');
  const start = l.disbursed_on ? ymd(l.disbursed_on) : isoDate(new Date());

  const lines = S.draftSchedule({ start, count, principal, ...scheduleInputs(l) });
  const feePlan = await fees.scheduledFees(c, l, lines);
  const installments = [];
  for (const line of lines) {
    const dueDate = await shiftOffClosedDays(c, line.nominalDue);
    installments.push({ ...line, dueDate, fee: round2(feePlan[line.number] || 0) });
  }

  if (persist) {
    await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [l.id]);
    await persistInstallments(c, l.id, installments);
  }

  return {
    loanId: l.id,
    method: l.method,
    productType: l.product_type,
    totals: {
      principal,
      interest: round2(installments.reduce((s, i) => s + i.interest, 0)),
      fees: round2(installments.reduce((s, i) => s + i.fee, 0)),
    },
    installments,
  };
}

/**
 * Preview the schedule a loan would get, from a product and terms, without
 * a loan. What a teller shows a member before anything is written.
 */
async function previewSchedule(c, { productId, principal, termMonths, monthlyRate, disbursedOn, firstDueOffsetDays, gracePeriods, amortizationPeriods }) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  const l = {
    ...p, product_id: p.id, product_type: p.product_type, product_rate: p.monthly_rate,
    product_grace_periods: p.grace_periods, product_amortization_periods: p.amortization_periods,
    monthly_rate: monthlyRate ?? p.monthly_rate, principal, term_months: termMonths,
    disbursed_on: disbursedOn || null, first_due_offset_days: firstDueOffsetDays ?? p.first_due_offset_days,
    grace_periods: gracePeriods ?? null, amortization_periods: amortizationPeriods ?? null,
    principal_disbursed: 0, principal_capitalized: 0, principal_paid: 0, id: null,
  };
  return buildSchedule(c, l, { persist: false });
}

/**
 * Regenerate a DYNAMIC_TERM loan's future installments from its actual
 * outstanding balance, after a repayment on `asOf`.
 *
 * Installments already due keep their figures. Everything falling due after
 * `asOf` is redrawn over what remains of the principal once those are netted
 * off, the way the product says (Mambu's prepayment recalculation):
 *
 *   REDUCE_INSTALLMENT_AMOUNT       same number of installments, each smaller
 *   REDUCE_NUMBER_OF_INSTALLMENTS   same installment as before, fewer of them
 *   NONE                            the schedule stands as drawn
 *
 * The first redrawn period runs from `asOf` to its due date, so its interest
 * is the rest of the period on the new balance, plus whatever had accrued on
 * the old balance and is still unpaid.
 */
async function reschedule(c, l, asOf, { force = false } = {}) {
  if (!isDynamic(l) || isRevolving(l)) return null;
  if (!force && (!l.prepayment_recalculation || l.prepayment_recalculation === 'NONE')) return null;
  const date = ymd(asOf);
  const { rows } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [l.id]);
  const past = rows.filter((r) => ymd(r.due_date) <= date);
  const future = rows.filter((r) => ymd(r.due_date) > date);
  if (!future.length) return null;

  const b = balances(l);
  const pastPrincipalStillDue = round2(past.reduce((s, r) => s + Math.max(0, r.principal_due - r.principal_paid), 0));
  const remaining = round2(b.principal - pastPrincipalStillDue);
  const inputs = scheduleInputs(l);
  const t = inputs.terms;

  let fixedShare = null;
  if (!force && l.prepayment_recalculation === 'REDUCE_NUMBER_OF_INSTALLMENTS') {
    const P = Number(l.principal);
    const n = Number(l.term_months);
    const first = rows[0];
    const r = S.periodRate(t, ymd(l.disbursed_on), ymd(first.nominal_due));
    fixedShare = l.method === 'REDUCING_EQUAL_INSTALLMENTS' ? annuityPayment(P, r, inputs.amortization || n) : round2(P / (inputs.amortization || n));
  }

  const periods = future.map((r, i) => ({
    from: i === 0 ? toUTC(date) : toUTC(future[i - 1].nominal_due), to: toUTC(r.nominal_due),
  }));
  const amortization = inputs.amortization ? Math.max(future.length, inputs.amortization - past.length) : null;
  let lines = S.planInstallments({
    principal: remaining, terms: t, method: l.method, periods, fixedShare, amortization,
    rounding: inputs.rounding, extraFirstInterest: Math.max(0, b.interest),
  });
  if (lines.length > future.length) {
    // More periods than dates: fold the tail into the last dated line.
    const tail = lines.splice(future.length);
    const last = lines[lines.length - 1];
    last.principal = round2(last.principal + tail.reduce((s, x) => s + x.principal, 0));
    last.interest = round2(last.interest + tail.reduce((s, x) => s + x.interest, 0));
  }

  const installments = lines.map((line, i) => ({
    number: future[i].number, dueDate: ymd(future[i].due_date), nominalDue: ymd(future[i].nominal_due), ...line,
    fee: Math.max(0, round2(future[i].fee_due - future[i].fee_paid)),
  }));

  await c.query('DELETE FROM loan_installments WHERE loan_id = $1 AND id = ANY($2)', [l.id, future.map((r) => r.id)]);
  await persistInstallments(c, l.id, installments);
  await c.query(
    'UPDATE loan_accounts SET rescheduled_at = now(), reschedule_count = reschedule_count + 1 WHERE id = $1', [l.id]
  );
  return {
    recalculation: force ? 'REDUCE_INSTALLMENT_AMOUNT' : l.prepayment_recalculation, remaining, dropped: future.length - installments.length,
    installments,
  };
}

/** Last scheduled due date, or null when there is no schedule. */
async function maturityDate(c, loanId) {
  const { rows: [r] } = await c.query('SELECT max(due_date) AS d FROM loan_installments WHERE loan_id = $1', [loanId]);
  return r?.d ? ymd(r.d) : null;
}

/** Principal a FIXED_TERM loan's schedule says is still out at `date` (nominal period ends). */
function scheduledOutstanding(l, installments, date) {
  let out = principalOutstanding(l) + Number(l.principal_paid);
  for (const i of installments) {
    if (date >= ymd(i.nominal_due || i.due_date)) out -= Number(i.principal_due);
    else break;
  }
  return round2(Math.max(0, out));
}

/**
 * Interest a FIXED_TERM loan has earned by `date`, reading the schedule:
 * every period whose nominal end has passed counts in full, the period in
 * progress counts pro rata by the day count, and nothing accrues after the
 * final period. A fixed-term loan's interest is fixed; that is the point.
 *
 * Periods are measured on the nominal due dates, not the shifted ones, so a
 * due date pushed off a weekend does not spread a month's interest over
 * thirty-two days.
 */
function scheduledInterestThrough(l, installments, date, convention) {
  let from = ymd(l.disbursed_on);
  let total = 0;
  for (const i of installments) {
    const to = ymd(i.nominal_due || i.due_date);
    const interest = Number(i.interest_due);
    if (date >= to) { total += interest; from = to; continue; }
    if (date <= from) break;
    const periodDays = dayCount(from, to, convention) || 1;
    total += interest * dayCount(from, date, convention) / periodDays;
    break;
  }
  return round2(total);
}

/**
 * Spread paid amounts over installments, earliest first. With `dueBy`, only
 * installments due on or before that date take a share; what is left over
 * is a prepayment the caller deals with.
 */
async function applyToInstallments(c, loanId, { principal, interest, fees }, { dueBy = null } = {}) {
  const { rows } = await c.query(
    `SELECT * FROM loan_installments WHERE loan_id = $1 AND status NOT IN ('PAID', 'GRACE')
       AND ($2::date IS NULL OR due_date <= $2::date)
     ORDER BY number`,
    [loanId, dueBy]
  );
  let p = principal, i = interest, f = fees;
  for (const inst of rows) {
    if (!p && !i && !f) break;
    const pa = round2(Math.min(p, inst.principal_due - inst.principal_paid));
    const ia = round2(Math.min(i, inst.interest_due - inst.interest_paid));
    const fa = round2(Math.min(f, inst.fee_due - inst.fee_paid));
    p = round2(p - pa); i = round2(i - ia); f = round2(f - fa);

    await c.query(
      `UPDATE loan_installments SET
         principal_paid = principal_paid + $1,
         interest_paid = interest_paid + $2,
         fee_paid = fee_paid + $3,
         status = CASE
           WHEN principal_paid + $1 >= principal_due
            AND interest_paid + $2 >= interest_due
            AND fee_paid + $3 >= fee_due THEN 'PAID'
           WHEN principal_paid + $1 > 0 OR interest_paid + $2 > 0 THEN 'PARTIALLY_PAID'
           ELSE status END
       WHERE id = $4`,
      [pa, ia, fa, inst.id]
    );
  }
}

module.exports = {
  buildSchedule, previewSchedule, reschedule, maturityDate, persistInstallments,
  scheduledOutstanding, scheduledInterestThrough, applyToInstallments,
};
