'use strict';

const acct = require('../accounting');
const S = require('../schedule');
const ledger = require('../ledger');
const { err, round2 } = acct;
const { ymd, dayCount, interestBetween } = S;

/**
 * FIXED_TERM: the schedule drawn at disbursement is the contract.
 *
 * Interest is the schedule's, earned pro rata through the period in
 * progress. Prepaying principal does not lower it, paying late does not
 * raise it, and nothing accrues after the last period. A payment settles
 * installments in order however early it comes. All payment-due fees are
 * placed on the schedule at disbursement, and upfront fees fall due with the
 * first installment.
 *
 * INTEREST_FREE is this with no interest at all.
 *
 * The strategy contract is documented in ./index.js.
 */

const FAR = '9999-12-31';

/** Principal the schedule says is still out at `date` (nominal period ends). */
function scheduledOutstanding(l, installments, date) {
  let out = ledger.principalOutstanding(l) + Number(l.principal_paid);
  for (const i of installments) {
    if (date >= ymd(i.nominal_due || i.due_date)) out -= Number(i.principal_due);
    else break;
  }
  return round2(Math.max(0, out));
}

/**
 * Interest the schedule has earned by `date`: every period whose nominal end
 * has passed counts in full, the period in progress pro rata by the day
 * count, nothing after the final period. Periods are measured on nominal
 * due dates, so a due date pushed off a weekend does not spread a month's
 * interest over thirty-two days.
 */
function scheduledInterestThrough(l, installments, date, convention, { exact = false, holidays = null } = {}) {
  let from = ymd(l.disbursed_on);
  let total = 0;
  for (const i of installments) {
    const to = ymd(i.nominal_due || i.due_date);
    const interest = Number(i.interest_due);
    if (date >= to) { total += interest; from = to; continue; }
    if (date <= from) break;
    const periodDays = dayCount(from, to, convention, holidays) || 1;
    total += interest * dayCount(from, date, convention, holidays) / periodDays;
    break;
  }
  return exact ? total : round2(total);
}

const UPFRONT = (items) => items.filter((x) => x.feeType === 'DISBURSEMENT_UPFRONT');

const fixedTerm = {
  type: 'FIXED_TERM',
  basis: 'SCHEDULE',

  // ---- schedule ------------------------------------------------------------
  schedulesUpfront: true,
  redrawsOnPrepayment: () => false,
  upfrontFeesOnSchedule: true,
  // Payment-due fees: all of them at disbursement, since they are fixed
  // with the schedule. The EOD job applies none.
  paymentDueFeesByCalendar: false,
  paymentDueHorizon: () => FAR,
  plansTranches: false,

  // ---- disbursement ----------------------------------------------------------
  disbursesAgain: false,
  async disbursementAmount(c, l, { amount }) {
    const amt = round2(amount ?? l.principal);
    if (!(amt > 0)) throw err('INVALID_DISBURSEMENT_AMOUNT');
    return { amount: amt, tranche: null };
  },
  fromCreditBalance: () => 0,
  /** Draw the schedule, place upfront fees on it, apply its payment-due fees. */
  async afterDisbursement(c, { fresh, first, date, plan }, ops) {
    if (!first) return null;
    const sched = await ops.buildSchedule(c, fresh);
    await ops.fees.placeUpfrontFees(c, fresh, UPFRONT(plan.items));
    await ops.fees.applyPaymentDueFees(c, fresh, this.paymentDueHorizon(date));
    return sched;
  },
  async recordDisbursement() {},
  appliesInterestAtDisbursement: (l) => l.interest_posting === 'ON_DISBURSEMENT',

  // ---- repayment -------------------------------------------------------------
  bringsInterestToDate: false,
  async beforeRepayment(c, l) { return l; },
  closesWhenPaid: true,
  surplusToCreditBalance: () => false,
  installmentScope: () => ({}),
  async afterRepayment() { return null; },
  redrawsOnReversal: false,

  // ---- interest --------------------------------------------------------------
  accrues: (l) => Number(l.monthly_rate) > 0 && l.interest_posting !== 'ON_DISBURSEMENT',
  accrualWindow: (l, fromIso, date) => date,
  accrualBase: (l, installments, fromIso) => (l.method === 'FLAT' ? Number(l.principal) : scheduledOutstanding(l, installments, fromIso)),
  /** Unrounded: the caller keeps the fraction of a cent for the next run. */
  dailyAccrual(l, t, { base, fromIso, date, installments }) {
    if (!installments.length) return interestBetween(base, t, fromIso, date, { exact: true });
    return scheduledInterestThrough(l, installments, date, t.convention, { exact: true, holidays: t.holidays })
      - scheduledInterestThrough(l, installments, fromIso, t.convention, { exact: true, holidays: t.holidays });
  },
  capitalizes: () => false,
};

const interestFree = {
  ...fixedTerm,
  type: 'INTEREST_FREE',
  accrues: () => false,
  appliesInterestAtDisbursement: () => false,
};

module.exports = { fixedTerm, interestFree, scheduledOutstanding, scheduledInterestThrough, FAR, UPFRONT };
