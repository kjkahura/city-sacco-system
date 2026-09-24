'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const { err, round2 } = acct;

/**
 * Reschedule and refinance, after Mambu's "Rescheduled" and "Refinanced"
 * closures: the running loan is closed and a new one opened under it, with
 * a link back (parent_loan_id), so the audit trail is two accounts and one
 * transaction rather than an edited schedule.
 *
 *   RESCHEDULE   new terms (installments, rate, product) for the balance
 *   REFINANCE    the same, plus a top-up paid out to the member
 *
 * What was owed in interest, fees and penalties is either CAPITALIZED onto
 * the new principal or WRITTEN_OFF. The principal itself moves from the old
 * portfolio account to the new product's: no cash, one journal entry.
 *
 * Guarantors follow the loan: their pledges are released on the old account
 * and re-pledged on the new one for the same amounts.
 */

const L = require('./ledger');
const W = require('./workflow');
const loans = require('./loans');
const fees = require('./fees');
const funding = require('./funding');
const eligibility = require('./eligibility');
const { accrueInterest } = require('./interest');
const { buildSchedule } = require('./installments');
const types = require('./productTypes');

const ymd = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).slice(0, 10));

async function restructure(c, loanId, {
  kind, productId = null, termMonths, monthlyRate, topUp = 0, channelId = 'bank',
  arrears = 'CAPITALIZE', valueDate, note = null, createdBy,
} = {}) {
  if (!['RESCHEDULE', 'REFINANCE'].includes(kind)) throw err(`UNSUPPORTED_RESTRUCTURE: ${kind}`);
  if (!['CAPITALIZE', 'WRITE_OFF'].includes(arrears)) throw err('ARREARS_MUST_BE_CAPITALIZE_OR_WRITE_OFF', 400);
  const date = valueDate ? ymd(valueDate) : new Date().toISOString().slice(0, 10);
  const extra = round2(topUp || 0);
  if (kind === 'REFINANCE' && !(extra > 0)) throw err('REFINANCE_NEEDS_A_TOP_UP', 400);
  if (kind === 'RESCHEDULE' && extra > 0) throw err('RESCHEDULE_TAKES_NO_TOP_UP', 400);

  let old = await L.lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(old.status)) throw err(`LOAN_NOT_RESTRUCTURABLE: ${old.status}`, 409);
  if (Number(old.credit_balance) > 0) throw err(`LOAN_HAS_A_CREDIT_BALANCE: ${old.credit_balance}`, 409);
  if (await funding.isFunded(c, old.id)) throw err('FUNDED_LOANS_CANNOT_BE_RESTRUCTURED_HERE', 409);
  const term = Number(termMonths);
  if (!(Number.isInteger(term) && term > 0)) throw err('INVALID_TERM', 400);

  // Interest owed is brought up to the date first, so the figure being
  // capitalised or written off is the real one.
  if (types.forLoan(old).bringsInterestToDate && old.status !== 'LOCKED') {
    await accrueInterest(c, old.id, { valueDate: date, createdBy });
    old = await L.lock(c, old.id);
  }
  const b = L.balances(old);
  const charges = round2(b.interest + b.fees + b.penalty);
  const newProductId = productId || old.product_id;
  const { rows: [np] } = await c.query('SELECT * FROM loan_products WHERE id = $1 AND is_active', [newProductId]);
  if (!np) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  if (term > np.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${np.max_term}`, 400);

  const capitalized = arrears === 'CAPITALIZE' ? charges : 0;
  // Mambu refuses to carry capitalised amounts into a product booked on a
  // different method: they were recognised one way and would be unwound
  // another.
  if ((Number(old.principal_capitalized) > 0 || capitalized > 0) && np.accounting_method !== old.accounting_method) {
    throw err(`CAPITALIZED_AMOUNTS_NOT_ALLOWED_DUE_TO_DIFFERENT_ACCOUNTING: ${old.accounting_method} to ${np.accounting_method}`, 409);
  }
  const writtenOff = arrears === 'WRITE_OFF' ? charges : 0;
  const newPrincipal = round2(b.principal + capitalized + extra);
  if (!(newPrincipal > 0)) throw err('NOTHING_TO_RESTRUCTURE', 409);

  // ---- the journal entry ---------------------------------------------------
  const debits = [];
  const credits = [];
  const mid = old.member_id;
  const books = L.booksEntries(old) && np.accounting_method !== 'NONE';
  let channel = null;
  if (extra > 0) {
    channel = (await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId])).rows[0];
    if (!channel?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);
  }
  if (books) {
    // Principal moves portfolio to portfolio; the top-up leaves through the channel.
    debits.push({ glCode: np.gl_portfolio, amount: round2(b.principal + capitalized + extra), memberId: mid });
    credits.push({ glCode: old.gl_portfolio, amount: b.principal, memberId: mid });
    if (extra > 0) credits.push({ glCode: channel.gl_account_code, amount: extra, memberId: mid });
    // Whether a component sits in a receivable: interest when accrued
    // interest reaches the ledger, fees and penalties under accrual.
    const inReceivable = (component) => (component === 'INTEREST' ? L.interestAccrues(old) : L.isAccrual(old));
    for (const [component, amount] of [['INTEREST', b.interest], ['FEE', b.fees], ['PENALTY', b.penalty]]) {
      if (!(amount > 0)) continue;
      if (capitalized > 0) {
        // Capitalised charges: under accrual they clear the receivable that
        // held them; under cash they are recognised as income now, since
        // they have become principal the member will repay.
        credits.push({ glCode: inReceivable(component) ? L.writeOffCredit(old, component) : L.paidCredit(old, component), amount, memberId: mid });
      } else if (inReceivable(component)) {
        // Written off: expense against the receivable. Under cash nothing
        // was ever recognised, so there is nothing to write off in the ledger.
        debits.push({ glCode: old.gl_writeoff_exp, amount, memberId: mid });
        credits.push({ glCode: L.writeOffCredit(old, component), amount, memberId: mid });
      }
    }
  }
  const entryId = books ? (await acct.post(c, {
    debits, credits,
    narration: `${kind === 'REFINANCE' ? 'Refinance' : 'Reschedule'} ${old.account_no}${note ? `: ${note}` : ''}`,
    sourceType: `LOAN_${kind}`, sourceId: old.id, bookingDate: date, channelId: extra > 0 ? channelId : undefined, createdBy,
    branchId: old.branch_id || null,
  })).entryId : null;

  // ---- close the old loan ------------------------------------------------
  const closedStatus = kind === 'REFINANCE' ? 'CLOSED_REFINANCED' : 'CLOSED_RESCHEDULED';
  await c.query(
    `UPDATE loan_accounts SET
       principal_paid = principal_paid + $1, interest_paid = interest_paid + $2,
       fees_paid = fees_paid + $3, penalty_paid = penalty_paid + $4,
       status = $5, closed_on = $6::date, locked_at = NULL, locked_reason = NULL, status_before_lock = NULL, updated_at = now()
     WHERE id = $7`,
    [b.principal, b.interest, b.fees, b.penalty, closedStatus, date, old.id]);
  await c.query("UPDATE loan_fees SET status = CASE WHEN status = 'DUE' THEN 'PAID' ELSE status END, paid = amount WHERE loan_id = $1 AND status = 'DUE'", [old.id]);
  await W.history(c, old.id, { from: old.status, to: closedStatus, action: kind, actor: createdBy, note });

  // ---- open the new one ----------------------------------------------------
  const created = await loans.apply(c, {
    memberId: mid, productId: newProductId, principal: newPrincipal, termMonths: term, branchId: old.branch_id,
    monthlyRate, purpose: `${kind === 'REFINANCE' ? 'Refinance' : 'Reschedule'} of ${old.account_no}`, notes: note, createdBy,
  });
  await c.query(
    `UPDATE loan_accounts SET parent_loan_id = $1, status = 'ACTIVE', approved_on = $2::date, approved_by = $3,
       principal_disbursed = $4, disbursed_on = $2::date, accrued_through = $2::date, disbursed_by = $3, updated_at = now()
     WHERE id = $5`,
    [old.id, date, createdBy || 'SYSTEM', newPrincipal, created.id]);
  await W.history(c, created.id, { from: created.status, to: 'ACTIVE', action: kind, actor: createdBy, note: `from ${old.account_no}` });
  const fresh = await L.lock(c, created.id);
  await buildSchedule(c, fresh);
  // The new product's payment-due fees, if fixed-term, land with the schedule.
  await fees.applyPaymentDueFees(c, fresh, types.forLoan(fresh).paymentDueHorizon(date));

  // Guarantors follow.
  const { rows: gs } = await c.query(
    "SELECT member_id, pledged_amount FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED'", [old.id]);
  await eligibility.releaseGuarantors(c, old.id);
  for (const g of gs) {
    await c.query('INSERT INTO loan_guarantors (loan_id, member_id, pledged_amount) VALUES ($1,$2,$3)', [created.id, g.member_id, g.pledged_amount]);
  }

  const tx = await savings.record(c, {
    reference: savings.ref(kind === 'REFINANCE' ? 'RF' : 'RS'), kind: `LOAN_${kind}`, memberId: mid,
    loanAccountId: old.id, amount: newPrincipal, valueDate: date, entryId,
    channelId: extra > 0 ? channelId : undefined,
    allocation: {
      newLoanId: created.id, newAccountNo: fresh.account_no, principal: b.principal,
      capitalized, writtenOff, topUp: extra, arrears,
      charges: { interest: b.interest, fees: b.fees, penalty: b.penalty },
    },
    narration: note, createdBy,
  });
  return { transaction: tx, oldLoan: { id: old.id, accountNo: old.account_no, status: closedStatus }, newLoan: fresh };
}

module.exports = { restructure };
