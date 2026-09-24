'use strict';

const acct = require('../accounting');
const S = require('../schedule');
const ledger = require('../ledger');
const { dynamicTerm } = require('./dynamicTerm');
const { err, round2 } = acct;
const { ymd, isoDate } = S;

/**
 * REVOLVING: a limit the member draws on and repays as they like.
 *
 * Drawdowns are allowed while the limit is valid, up to what is available,
 * and take the member's credit balance first. There is no schedule up
 * front: installments are generated on billing dates (../revolving.js).
 * Interest accrues on the actual balance and does not stop at a "maturity",
 * since the last billed installment is not one. A payment settles every
 * billed installment, an overpayment stays on the loan as a credit balance
 * when the product allows it, and a zero balance does not close the loan:
 * the member may draw again, so closing is a decision.
 *
 * The strategy contract is documented in ./index.js.
 */

/** The limit runs for term_months from the first drawdown (or approval). */
function validUntil(l) {
  const start = l.disbursed_on || l.approved_on;
  return start ? isoDate(S.addMonths(ymd(start), Number(l.term_months))) : null;
}

/** What the member may still draw. */
function available(l) {
  return round2(Math.max(0, Number(l.principal) - ledger.principalOutstanding(l)) + Number(l.credit_balance || 0));
}

/** The billing dates are the product's schedule dates, rolling from the first drawdown. */
function firstBillingDate(l, from) {
  const inputs = ledger.scheduleInputs(l);
  const [d] = S.nominalDueDates({ start: from, count: 1, interval: inputs.interval, fixedDays: inputs.fixedDays,
    shortMonth: inputs.shortMonth, firstOffsetDays: inputs.firstOffsetDays });
  return isoDate(d);
}

function nextBillingDate(l, after) {
  const inputs = ledger.scheduleInputs(l);
  const [d] = S.nominalDueDates({ start: after, count: 1, interval: inputs.interval, fixedDays: inputs.fixedDays, shortMonth: inputs.shortMonth });
  return isoDate(d);
}

const revolving = {
  ...dynamicTerm,
  type: 'REVOLVING',
  schedulesUpfront: false,
  redrawsOnPrepayment: () => false,
  disbursesAgain: true,

  async disbursementAmount(c, l, { amount, date }) {
    const amt = round2(amount);
    if (!(amt > 0)) throw err('INVALID_DISBURSEMENT_AMOUNT');
    const until = validUntil(l);
    if (until && date > until) throw err(`CREDIT_LIMIT_EXPIRED_ON_${until}`, 409);
    const avail = available(l);
    if (amt > avail) throw err(`EXCEEDS_AVAILABLE_CREDIT: available ${avail}`, 409);
    return { amount: amt, tranche: null };
  },
  /** The member's own money back to them first: no portfolio movement for that part. */
  fromCreditBalance: (l, amt) => round2(Math.min(Number(l.credit_balance || 0), amt)),
  /** No schedule: set the first billing date if there is none yet. */
  async afterDisbursement(c, { l, fresh, date }) {
    if (!fresh.next_billing_on) {
      await c.query('UPDATE loan_accounts SET next_billing_on = $2::date WHERE id = $1', [l.id, firstBillingDate(fresh, date)]);
    }
    return null;
  },

  closesWhenPaid: false,
  surplusToCreditBalance: (l) => Boolean(l.credit_balance_enabled),
  installmentScope: () => ({}),
  async afterRepayment() { return null; },
  redrawsOnReversal: false,

  accrualWindow: (l, fromIso, date) => date,
};

module.exports = { revolving, validUntil, available, firstBillingDate, nextBillingDate };
