'use strict';

const { err } = require('../accounting');
const { fixedTerm, interestFree } = require('./fixedTerm');
const { dynamicTerm } = require('./dynamicTerm');
const { tranched } = require('./tranched');
const { revolving } = require('./revolving');

/**
 * Product types as strategies.
 *
 * Everything that depends on a loan's product type lives in one file per
 * type; the lifecycle code (loans.js, interest.js, installments.js, fees.js,
 * restructure, the EOD job) asks the loan's strategy rather than testing
 * the type. Adding a product type is a new file here and a line in BY_TYPE.
 *
 * The files depend only on accounting, schedule, ledger and tranches, so
 * anything above the ledger may use them. Hooks that need the lifecycle
 * (drawing a schedule, accruing, redrawing, fees) receive those operations
 * as `ops`, built by loans.js, instead of requiring the modules above them.
 *
 * The contract every strategy fills:
 *
 *   type, basis                      name; 'SCHEDULE' or 'ACTUAL_BALANCE'
 *
 *   schedule
 *   schedulesUpfront                 a schedule is drawn at disbursement
 *   redrawsOnPrepayment(l, {force})  future installments may be redrawn
 *   upfrontFeesOnSchedule            upfront fees ride the first installment
 *   paymentDueFeesByCalendar         the EOD job applies payment-due fees
 *   paymentDueHorizon(date)          the date payment-due fees are applied to
 *   plansTranches                    an application may carry tranches
 *
 *   disbursement
 *   disbursesAgain                   an active loan may be disbursed again
 *   disbursementAmount(c, l, {amount, tranche, date})  -> {amount, tranche}
 *   fromCreditBalance(l, amount)     part of a payout taken from the credit balance
 *   afterDisbursement(c, {l, fresh, first, date, plan, createdBy}, ops)  -> schedule
 *   recordDisbursement(c, {tranche, amount, date, record})
 *   appliesInterestAtDisbursement(l) the whole term's interest on day one
 *
 *   repayment
 *   bringsInterestToDate             interest is accrued to the day first
 *   beforeRepayment(c, l, {asOf, createdBy}, ops)  -> the loan, refreshed
 *   closesWhenPaid                   a zero balance closes the loan
 *   surplusToCreditBalance(l)        an overpayment stays on the loan
 *   installmentScope(asOf)           which installments a payment settles
 *   afterRepayment(c, fresh, {asOf, principal, interest}, ops)  -> redraw
 *   redrawsOnReversal                a reversal redraws the schedule
 *
 *   interest
 *   accrues(l)                       the loan earns interest by accrual
 *   accrualWindow(l, fromIso, date, installments)  -> date to accrue to, or null
 *   accrualBase(l, installments, fromIso)          -> the amount priced
 *   dailyAccrual(l, terms, {base, fromIso, date, installments})  -> amount, unrounded
 *   capitalizes(l)                   accrued interest folds into principal
 */

const BY_TYPE = {
  FIXED_TERM: fixedTerm,
  INTEREST_FREE: interestFree,
  DYNAMIC_TERM: dynamicTerm,
  TRANCHED: tranched,
  REVOLVING: revolving,
};

/** The strategy for a loan (or a product: anything with product_type). */
function forLoan(l) {
  const s = BY_TYPE[l.product_type || 'FIXED_TERM'];
  if (!s) throw err(`UNKNOWN_PRODUCT_TYPE: ${l.product_type}`, 500);
  return s;
}

// The predicates the rest of the system learned, now read off the strategy.
const isDynamic = (l) => forLoan(l).basis === 'ACTUAL_BALANCE';
const isRevolving = (l) => forLoan(l) === revolving;
const isTranched = (l) => forLoan(l) === tranched;
const isInterestFree = (l) => !forLoan(l).accrues({ ...l, interest_posting: 'ON_REPAYMENT' });

module.exports = { BY_TYPE, TYPES: Object.keys(BY_TYPE), forLoan, isDynamic, isRevolving, isTranched, isInterestFree };
