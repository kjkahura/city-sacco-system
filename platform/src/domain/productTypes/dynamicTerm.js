'use strict';

const acct = require('../accounting');
const S = require('../schedule');
const ledger = require('../ledger');
const { fixedTerm } = require('./fixedTerm');
const { round2 } = acct;
const { ymd, interestBetween } = S;

/**
 * DYNAMIC_TERM: interest on the actual balance for the actual days.
 *
 * The schedule drawn at disbursement is the expectation if every
 * installment is paid on its date. Interest is brought to the payment date
 * before a repayment is allocated, a payment settles what has fallen due
 * and the rest is a prepayment, and the future installments are redrawn
 * from the new balance (the product's prepayment recalculation). Payment-
 * due fees are applied on their dates by the EOD job; upfront fees are due
 * at once, outside the schedule. Past the last due date interest keeps
 * accruing only if the product accrues late interest. CAPITALIZED interest
 * folds into principal on each due date.
 *
 * The strategy contract is documented in ./index.js.
 */

/**
 * The stretches of a payment holiday whose interest is not charged or is
 * held (holiday_interest NONE or APPLY_LATER): from the end of the period
 * before each such installment to its own nominal date. Interest does not
 * accrue in them.
 */
function interestFreeWindows(l, installments) {
  const out = [];
  let prev = l.disbursed_on ? ymd(l.disbursed_on) : null;
  for (const i of installments) {
    const to = ymd(i.nominal_due || i.due_date);
    if (i.payment_holiday && (i.holiday_interest === 'NONE' || i.holiday_interest === 'APPLY_LATER') && prev) out.push([prev, to]);
    prev = to;
  }
  return out;
}

/** [from, to] less the windows, as the stretches left. */
function outside(fromIso, toIso, windows) {
  let parts = [[fromIso, toIso]];
  for (const [a, b] of windows) {
    const next = [];
    for (const [x, y] of parts) {
      if (b <= x || a >= y) { next.push([x, y]); continue; }
      if (a > x) next.push([x, a]);
      if (b < y) next.push([b, y]);
    }
    parts = next;
  }
  return parts;
}

const dynamicTerm = {
  ...fixedTerm,
  type: 'DYNAMIC_TERM',
  basis: 'ACTUAL_BALANCE',

  // ---- schedule ------------------------------------------------------------
  /** Redraw on a prepayment when the product says so, or when forced (a later tranche). */
  redrawsOnPrepayment: (l, { force = false } = {}) => force
    || Boolean(l.prepayment_recalculation && l.prepayment_recalculation !== 'NONE' && l.prepayment_allocation !== 'NEXT_INSTALLMENTS'),
  upfrontFeesOnSchedule: false,
  paymentDueFeesByCalendar: true,
  paymentDueHorizon: (date) => date,

  // ---- disbursement ----------------------------------------------------------
  appliesInterestAtDisbursement: () => false,

  // ---- repayment -------------------------------------------------------------
  bringsInterestToDate: true,
  /**
   * Interest and payment-due fees up to the payment date, so a prepayment
   * pays what it has actually earned. Under MANUAL prepayment interest the
   * interest is applied after the payment instead (afterRepayment).
   */
  async beforeRepayment(c, l, { asOf, createdBy }, ops) {
    if (l.prepayment_interest !== 'MANUAL') await ops.accrueInterest(c, l.id, { valueDate: asOf, createdBy });
    await ops.fees.applyPaymentDueFees(c, l, asOf);
    return ops.lock(c, l.id);
  },
  /** What has fallen due; under NEXT_INSTALLMENTS a prepayment goes on to the next installments in turn. */
  installmentScope: (asOf, l = {}) => (l.prepayment_allocation === 'NEXT_INSTALLMENTS' ? {} : { dueBy: asOf }),
  /** Redraw the future from the new balance once principal or interest moved. */
  async afterRepayment(c, fresh, { asOf, principal, interest, createdBy }, ops) {
    if (fresh.prepayment_interest === 'MANUAL') await ops.accrueInterest(c, fresh.id, { valueDate: asOf, createdBy });
    if (!(principal > 0 || interest > 0)) return null;
    return ops.reschedule(c, fresh, asOf);
  },
  redrawsOnReversal: true,

  // ---- interest --------------------------------------------------------------
  accrues: (l) => Number(l.monthly_rate) > 0,
  /** Stop at maturity unless the product accrues late interest; penalties take over from there. */
  accrualWindow(l, fromIso, date, installments) {
    if (l.accrue_late_interest || !installments.length) return date;
    const maturity = ymd(installments[installments.length - 1].nominal_due);
    if (fromIso >= maturity) return null;
    return date > maturity ? maturity : date;
  },
  /** Outstanding principal, plus unpaid interest when interest earns interest (compound, or simple on principal and interest). */
  accrualBase(l) {
    const unpaidInterest = Math.max(0, round2(l.interest_accrued - l.interest_paid));
    const t = ledger.terms(l);
    const onInterestToo = t.interestType === 'COMPOUND' || t.interestType === 'COMPOUND_DAILY_REST'
      || (t.interestType === 'SIMPLE' && l.simple_base === 'PRINCIPAL_AND_INTEREST');
    return round2(ledger.principalOutstanding(l) + (onInterestToo ? unpaidInterest : 0));
  },
  dailyAccrual(l, t, { base, fromIso, date, installments = [] }) {
    const windows = interestFreeWindows(l, installments);
    if (!windows.length) return interestBetween(base, t, fromIso, date, { exact: true });
    return outside(fromIso, date, windows).reduce((a, [x, y]) => a + interestBetween(base, t, x, y, { exact: true }), 0);
  },
  capitalizes: (l) => l.interest_type === 'CAPITALIZED',
};

module.exports = { dynamicTerm, interestFreeWindows, outside };
