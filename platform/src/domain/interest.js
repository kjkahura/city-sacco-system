'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const savings = require('./savings');
const tax = require('./tax');
const funding = require('./funding');
const workflow = require('./workflow');
const accruals = require('./accruals');
const { round2 } = acct;
const { ymd, isoDate, toUTC, interestBetween } = S;
const {
  lock, termsFor, interestAccrues, booksEntries, post, isMonthEnd, creditsFor,
} = require('./ledger');
const types = require('./productTypes');

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
 * What a day of interest *is* depends on the product type (./productTypes):
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
  const type = types.forLoan(l);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) return null;
  if (l.interest_accrual === 'NONE' || !type.accrues(l)) return null;

  let date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const from = l.accrued_through || l.disbursed_on;
  if (!from) return null;
  const fromIso = ymd(from);
  if (date <= fromIso) return null;

  const t = await termsFor(c, l);
  const capitalizing = type.capitalizes(l);
  const { rows: installments } = await c.query(
    `SELECT number, principal_due, interest_due, due_date, nominal_due, principal_paid, status, payment_holiday, holiday_interest
     FROM loan_installments WHERE loan_id = $1 ORDER BY number`, [l.id]
  );

  // How far this run may go (a dynamic loan stops at maturity unless it
  // accrues late interest) and the base a period is priced on.
  const capped = type.accrualWindow(l, fromIso, date, installments);
  if (!capped) return null;
  date = capped;
  const base = type.accrualBase(l, installments, fromIso);

  // The interest earned is computed unrounded and added to the fraction of
  // a cent the last run left over (interest_accrual_carry). Only whole cents
  // are posted; the new fraction waits for the next run. So the interest
  // posted always equals the unrounded interest earned, to within half a
  // cent, however many runs it took (Mambu keeps accruals unrounded and
  // rounds when it posts, for the same reason).
  let exact = 0;
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
      if (monthEnd > start) exact += interestBetween(base, t, new Date(Date.UTC(y, m, 0)), monthEnd, { exact: true });
    }
  } else {
    exact = type.dailyAccrual(l, t, { base, fromIso, date, installments });
  }
  const carried = Number(l.interest_accrual_carry || 0) + exact;
  let amt = S.roundTo(carried, t.decimals);
  let carry = carried - amt;

  // A loan in arrears under a charge cap may not be charged past it; what
  // the cap refuses is not carried forward either.
  if (amt > 0 && l.status === 'IN_ARREARS') {
    const allowed = await workflow.capAllows(c, l, amt);
    if (allowed < amt) carry = 0;
    amt = allowed;
  }

  // Tax on interest, where the product charges it: the member owes the
  // gross, the income is the net.
  const tx = tax.split(l, 'INTEREST', amt);
  // Interest from arrears (Mambu): on a loan that earns interest on its
  // balance, the part of this interest earned on principal already overdue
  // (on principal and interest overdue when interest earns interest). It is
  // a breakdown of the interest, never added to it; the arrears tolerance
  // does not affect it.
  let fromArrears = 0;
  if (type.basis === 'ACTUAL_BALANCE' && !capitalizing && tx.gross > 0 && base > 0) {
    const late = installments.filter((i) => ymd(i.due_date) <= fromIso && !['PAID', 'GRACE'].includes(i.status));
    const overduePrincipal = late.reduce((a, i) => a + Math.max(0, Number(i.principal_due) - Number(i.principal_paid || 0)), 0);
    const onInterestToo = base > S.round2(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - Number(l.principal_paid)) + 0.005;
    const overdueBase = overduePrincipal + (onInterestToo ? late.reduce((a, i) => a + Math.max(0, Number(i.interest_due)), 0) : 0);
    if (overdueBase > 0) fromArrears = S.roundTo(tx.gross * Math.min(1, overdueBase / base), t.decimals);
  }
  await c.query(
    `UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, accrued_through = $2::date,
       tax_charged = tax_charged + $4, interest_accrual_carry = $5,
       charges_since_arrears = charges_since_arrears + CASE WHEN status = 'IN_ARREARS' THEN $1 ELSE 0 END,
       interest_from_arrears_accrued = interest_from_arrears_accrued + $6,
       updated_at = now() WHERE id = $3`,
    [tx.gross, through, l.id, tx.tax, carry, fromArrears]
  );

  let recorded = null;
  if (amt > 0) {
    let entryId = null;
    if (booksEntries(l) && interestAccrues(l) && !capitalizing) {
      // On a funded loan only the organisation's commission is its income;
      // the funders' share reaches them when the member pays.
      const funded = await funding.isFunded(c, l.id);
      const own = funded ? funding.interestShares(l, tx.income).org : tx.income;
      const ownTax = funded ? round2(tx.tax * (tx.income > 0 ? own / tx.income : 0)) : tx.tax;
      // When the entry reaches the ledger is the product's GL accrual method
      // and granularity (./accruals): at once per loan, at the day's end per
      // product and branch, or at the month's end.
      entryId = await accruals.record(c, {
        kind: 'LOAN', product: { ...l, id: l.product_id }, accountId: l.id, memberId: l.member_id, branchId: l.branch_id,
        date, createdBy, narration: `Interest accrual ${l.account_no} ${fromIso} to ${date}`,
        lines: [
          { component: 'INTEREST', debitGl: l.gl_interest_rec, creditGl: l.gl_interest_inc, amount: round2(own) },
          { component: 'INTEREST_TAX', debitGl: l.gl_interest_rec, creditGl: l.gl_tax_payable, amount: round2(ownTax) },
        ],
      });
    }
    recorded = await savings.record(c, {
      reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
      loanAccountId: l.id, amount: tx.gross, valueDate: date, entryId,
      allocation: {
        from: fromIso, through, base, exact, carry, dayCount: t.convention, method: l.interest_accrual,
        interestType: t.interestType, productType: l.product_type, basis: type.basis,
        ...(fromArrears > 0 ? { interestFromArrears: fromArrears } : {}),
        ...(tx.tax > 0 ? { tax: tx.tax, net: tx.income } : {}),
      },
      createdBy,
    });
  }

  // Interest the member paid in advance settles what has now been earned.
  if (Number(l.interest_prepaid) > 0) await applyPrepaidInterest(c, l.id, { valueDate: date, createdBy });

  // Capitalising products fold the interest earned into principal on each
  // due date that this run crossed (and at repayment, which calls here first).
  if (capitalizing) {
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

// --------------------------------------------------------------------------
// Interest received in advance (loan_products.interest_prepayment)
// --------------------------------------------------------------------------

/**
 * Interest a fixed-term loan's member paid before it was earned sits in the
 * deferred interest liability (interest_prepaid). As interest is earned it
 * is settled from there: Dr Deferred Interest, Cr what a payment of interest
 * credits (the receivable under accrual, income under cash). Called after
 * every accrual.
 */
async function applyPrepaidInterest(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  const prepaid = Number(l.interest_prepaid || 0);
  const owed = round2(Number(l.interest_accrued) - Number(l.interest_paid));
  const amt = round2(Math.min(prepaid, owed));
  if (!(amt > 0)) return 0;
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  await c.query(
    'UPDATE loan_accounts SET interest_paid = interest_paid + $1, interest_prepaid = interest_prepaid - $1, updated_at = now() WHERE id = $2',
    [amt, l.id]);
  await post(c, l, {
    debits: [{ glCode: l.gl_deferred_interest, amount: amt, memberId: l.member_id }],
    credits: creditsFor(l, 'INTEREST', amt, l.member_id),
    narration: `Prepaid interest earned ${l.account_no}`,
    sourceType: 'LOAN_PREPAID_INTEREST', sourceId: l.id, bookingDate: date, createdBy,
  });
  return amt;
}

/**
 * A loan that closes with interest still held in advance (every
 * installment paid early): the member paid it under the contract, so it is
 * recognised as income on the day, Dr Deferred Interest, Cr Interest Income
 * (and the tax payable share where the product taxes interest).
 */
async function recognisePrepaidInterest(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  const amt = round2(Number(l.interest_prepaid || 0));
  if (!(amt > 0)) return 0;
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const s = tax.splitPaid(l, 'INTEREST', amt);
  await c.query(
    `UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, interest_paid = interest_paid + $1,
       tax_charged = tax_charged + $3, interest_prepaid = 0, updated_at = now() WHERE id = $2`, [amt, l.id, s.tax]);
  const entryId = await post(c, l, {
    debits: [{ glCode: l.gl_deferred_interest, amount: amt, memberId: l.member_id }],
    credits: tax.incomeCredits(l, s, l.gl_interest_inc, l.member_id),
    narration: `Prepaid interest recognised at closure ${l.account_no}`,
    sourceType: 'LOAN_PREPAID_INTEREST', sourceId: l.id, bookingDate: date, createdBy,
  });
  await savings.record(c, {
    reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
    loanAccountId: l.id, amount: amt, valueDate: date, entryId,
    allocation: { method: 'PREPAID_AT_CLOSURE', prepaid: amt, ...(s.tax > 0 ? { tax: s.tax, net: s.income } : {}) }, createdBy,
  });
  return amt;
}

/**
 * Interest held in advance on a loan that is being written off or settled
 * by a reschedule or top-up was never earned: it goes to the principal
 * instead, Dr Deferred Interest, Cr Portfolio. Returns the amount moved.
 */
async function prepaidToPrincipal(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  const amt = round2(Math.min(Number(l.interest_prepaid || 0), Number(l.principal_disbursed) + Number(l.principal_capitalized) - Number(l.principal_paid)));
  if (!(amt > 0)) return 0;
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  await c.query(
    'UPDATE loan_accounts SET principal_paid = principal_paid + $1, interest_prepaid = interest_prepaid - $1, updated_at = now() WHERE id = $2',
    [amt, l.id]);
  await post(c, l, {
    debits: [{ glCode: l.gl_deferred_interest, amount: amt, memberId: l.member_id }],
    credits: [{ glCode: l.gl_portfolio, amount: amt, memberId: l.member_id }],
    narration: `Prepaid interest applied to principal ${l.account_no}`,
    sourceType: 'LOAN_PREPAID_INTEREST', sourceId: l.id, bookingDate: date, createdBy,
  });
  return amt;
}

module.exports = { accrueInterest, capitalizeInterest, applyPrepaidInterest, recognisePrepaidInterest, prepaidToPrincipal };
