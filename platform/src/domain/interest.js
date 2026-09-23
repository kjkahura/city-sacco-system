'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const savings = require('./savings');
const tax = require('./tax');
const funding = require('./funding');
const workflow = require('./workflow');
const { round2 } = acct;
const { ymd, isoDate, toUTC, interestBetween } = S;
const {
  lock, principalOutstanding, terms, isDynamic, isInterestFree, isAccrual, post, isMonthEnd,
} = require('./ledger');
const { scheduledOutstanding, scheduledInterestThrough } = require('./installments');

/**
 * Interest: daily or monthly accrual by product type and interest type, and
 * capitalisation. Called by the EOD job, by repayment (which brings interest
 * to the payment date first), by revolving billing and by later tranches.
 */

/**
 * Accrue interest through `valueDate`.
 *
 * Idempotent by construction: the loan records how far it has been accrued
 * (`accrued_through`) and each call books the days from there to the value
 * date, then moves the marker. Calling it twice for the same date books
 * nothing the second time; calling it after a missed week books the week.
 *
 *   DAILY    interest for the elapsed days, by the product's day count
 *   MONTHLY  one month's interest, on the last day of the month only
 *   NONE     never accrues; interest is owed on the schedule and booked
 *            when paid
 *
 * What a day of interest *is* depends on the product type:
 *
 *   FIXED_TERM    the schedule's interest, pro rata through the period in
 *                 progress (scheduledInterestThrough). Prepaying principal
 *                 does not lower it and paying late does not raise it, and
 *                 nothing accrues after the last period.
 *   DYNAMIC_TERM  the actual outstanding principal × the rate for the days
 *                 elapsed (SIMPLE), on principal plus unpaid interest
 *                 (SIMPLE with PRINCIPAL_AND_INTEREST, and COMPOUND), or
 *                 folded into principal on each due date (CAPITALIZED).
 *                 Past the last due date it keeps accruing only if the
 *                 product accrues late interest.
 *   INTEREST_FREE nothing, ever.
 *
 * Under ACCRUAL the entry is Dr Interest Receivable, Cr Interest Income.
 * Under CASH nothing is booked: the loan still tracks what is owed, and the
 * eventual payment credits income. CAPITALIZED interest books nothing at
 * accrual and Dr Portfolio, Cr Interest Income when it is capitalised.
 */
async function accrueInterest(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) return null;
  if (l.interest_accrual === 'NONE' || isInterestFree(l)) return null;
  if (l.interest_posting === 'ON_DISBURSEMENT' && !isDynamic(l)) return null;

  let date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const from = l.accrued_through || l.disbursed_on;
  if (!from) return null;
  const fromIso = ymd(from);
  if (date <= fromIso) return null;

  const t = terms(l);
  const dynamic = isDynamic(l);
  const capitalizing = l.interest_type === 'CAPITALIZED';
  const { rows: installments } = await c.query(
    'SELECT number, principal_due, interest_due, due_date, nominal_due FROM loan_installments WHERE loan_id = $1 ORDER BY number', [l.id]
  );

  if (dynamic && !l.accrue_late_interest && installments.length) {
    // Interest stops at maturity; penalties take over from there.
    const maturity = ymd(installments[installments.length - 1].nominal_due);
    if (fromIso >= maturity) return null;
    if (date > maturity) date = maturity;
  }

  // The base a period is priced on, at the start of the run.
  const unpaidInterest = Math.max(0, round2(l.interest_accrued - l.interest_paid));
  const onInterestToo = t.interestType === 'COMPOUND' || (t.interestType === 'SIMPLE' && l.simple_base === 'PRINCIPAL_AND_INTEREST');
  const base = dynamic
    ? round2(principalOutstanding(l) + (onInterestToo ? unpaidInterest : 0))
    : l.method === 'FLAT' ? Number(l.principal) : scheduledOutstanding(l, installments, fromIso);

  let amt = 0;
  const through = date;
  if (l.interest_accrual === 'MONTHLY') {
    if (!isMonthEnd(date)) return null;
    // Every month-end after the marker and up to the value date, in case
    // one was missed; each month priced as one period at the base.
    const start = toUTC(fromIso);
    const end = toUTC(date);
    for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m += 1) {
      const monthEnd = new Date(Date.UTC(y, m + 1, 0));
      if (monthEnd > end) break;
      if (monthEnd > start) amt = round2(amt + interestBetween(base, t, new Date(Date.UTC(y, m, 0)), monthEnd));
    }
  } else if (!dynamic && installments.length) {
    amt = round2(scheduledInterestThrough(l, installments, date, t.convention)
      - scheduledInterestThrough(l, installments, fromIso, t.convention));
  } else {
    amt = interestBetween(base, t, fromIso, date);
  }

  // A loan in arrears under a charge cap may not be charged past it.
  if (amt > 0 && l.status === 'IN_ARREARS') amt = await workflow.capAllows(c, l, amt);

  // Tax on interest, where the product charges it: the member owes the
  // gross, the income is the net.
  const tx = tax.split(l, 'INTEREST', amt);
  await c.query(
    `UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, accrued_through = $2::date,
       tax_charged = tax_charged + $4,
       charges_since_arrears = charges_since_arrears + CASE WHEN status = 'IN_ARREARS' THEN $1 ELSE 0 END,
       updated_at = now() WHERE id = $3`,
    [tx.gross, through, l.id, tx.tax]
  );

  let recorded = null;
  if (amt > 0) {
    let entryId = null;
    if (isAccrual(l) && !capitalizing) {
      // On a funded loan only the organisation's commission is its income;
      // the funders' share reaches them when the member pays.
      const funded = await funding.isFunded(c, l.id);
      const own = funded ? funding.interestShares(l, tx.income).org : tx.income;
      const ownTax = funded ? round2(tx.tax * (tx.income > 0 ? own / tx.income : 0)) : tx.tax;
      if (own + ownTax > 0) {
        entryId = await post(c, l, {
          debits: [{ glCode: l.gl_interest_rec, amount: round2(own + ownTax), memberId: l.member_id }],
          credits: tax.incomeCredits(l, { income: own, tax: ownTax }, l.gl_interest_inc, l.member_id),
          narration: `Interest accrual ${l.account_no} ${fromIso} to ${date}`,
          sourceType: 'LOAN_INTEREST_ACCRUAL', sourceId: l.id, bookingDate: date, createdBy,
        });
      }
    }
    recorded = await savings.record(c, {
      reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
      loanAccountId: l.id, amount: tx.gross, valueDate: date, entryId,
      allocation: {
        from: fromIso, through, base, dayCount: t.convention, method: l.interest_accrual,
        interestType: t.interestType, productType: l.product_type, basis: dynamic ? 'ACTUAL_BALANCE' : 'SCHEDULE',
        ...(tx.tax > 0 ? { tax: tx.tax, net: tx.income } : {}),
      },
      createdBy,
    });
  }

  // Capitalising products fold the interest earned into principal on each
  // due date that this run crossed (and at repayment, which calls here first).
  if (capitalizing && dynamic) {
    const crossed = installments.some((i) => ymd(i.nominal_due) > fromIso && ymd(i.nominal_due) <= date);
    if (crossed) await capitalizeInterest(c, l.id, { valueDate: date, createdBy });
  }
  return recorded;
}

/**
 * Move a loan's unpaid accrued interest into principal (CAPITALIZED interest
 * type): Dr Portfolio, Cr Interest Income. From here on it is repaid, and
 * earns interest, as principal.
 */
async function capitalizeInterest(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  const amt = Math.max(0, round2(l.interest_accrued - l.interest_paid));
  if (!(amt > 0)) return null;
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  await c.query(
    `UPDATE loan_accounts SET interest_accrued = interest_accrued - $1,
       principal_capitalized = principal_capitalized + $1, updated_at = now() WHERE id = $2`, [amt, l.id]);
  const entryId = await post(c, l, {
    debits: [{ glCode: l.gl_portfolio, amount: amt, memberId: l.member_id }],
    credits: [{ glCode: l.gl_interest_inc, amount: amt, memberId: l.member_id }],
    narration: `Interest capitalised ${l.account_no}`,
    sourceType: 'LOAN_INTEREST_CAPITALIZED', sourceId: l.id, bookingDate: date, createdBy,
  });
  return savings.record(c, {
    reference: savings.ref('LC'), kind: 'LOAN_INTEREST_CAPITALIZED', memberId: l.member_id,
    loanAccountId: l.id, amount: amt, valueDate: date, entryId, createdBy,
  });
}

module.exports = { accrueInterest, capitalizeInterest };
