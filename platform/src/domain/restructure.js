'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const L = require('./ledger');
const W = require('./workflow');
const loans = require('./loans');
const fees = require('./fees');
const funding = require('./funding');
const eligibility = require('./eligibility');
const { accrueInterest, prepaidToPrincipal } = require('./interest');
const { buildSchedule } = require('./installments');
const FA = require('./feeAmortization');
const types = require('./productTypes');
const { err, round2 } = acct;

/**
 * Reschedule and refinance (top-up), after Mambu's "Rescheduled" and
 * "Refinanced" closures: the running loan is closed and a new one opened
 * under it, with a link back (parent_loan_id), so the audit trail is two
 * accounts and one transaction rather than an edited schedule.
 *
 *   RESCHEDULE   new terms (installments, rate, product) for the balance.
 *                One step, a management decision on a loan in difficulty:
 *                no new money leaves the SACCO.
 *
 *   REFINANCE    a top-up: a new, larger loan that settles the running one
 *                and pays the rest to the member. New money, so it is a
 *                credit decision and goes through the ordinary application
 *                life cycle:
 *
 *     1. requestRefinance opens an application that refinances the loan
 *        (loan_accounts.refinance_of). Its principal is the gross new loan:
 *        what settling the old loan costs now plus the top-up asked for, or
 *        a principal given outright. The old loan keeps running meanwhile.
 *     2. APPROVE is the ordinary approval (./workflow): eligibility on the
 *        gross principal, counting the old loan's guarantors and collateral
 *        towards cover and not counting its balance as exposure twice; the
 *        approver's limit; and the check that a top-up is still left.
 *        Guarantors may be added to the application to cover the extra.
 *     3. disburseRefinance settles the old loan as of the value date and
 *        pays out the rest: top-up = approved principal - settlement. The
 *        approved amount is the member's new loan; if the old balance moved
 *        between approval and payout, the top-up moves with it. The
 *        disbursing user's limit and the two-man rule apply to the top-up.
 *
 * What was owed in interest, fees and penalties is either CAPITALIZED onto
 * the new principal or WRITTEN_OFF. The principal itself moves from the old
 * portfolio account to the new product's: no cash, one journal entry, with
 * the top-up leaving through the channel.
 *
 * Guarantors and collateral follow the loan: pledges are released on the old
 * account and re-pledged on the new one for the same amounts, and pledged
 * collateral moves across.
 */

const RESTRUCTURABLE = ['ACTIVE', 'IN_ARREARS', 'LOCKED'];
const ARREARS = ['CAPITALIZE', 'WRITE_OFF'];

const ymd = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);

async function assertRestructurable(c, old) {
  if (!RESTRUCTURABLE.includes(old.status)) throw err(`LOAN_NOT_RESTRUCTURABLE: ${old.status}`, 409);
  if (Number(old.credit_balance) > 0) throw err(`LOAN_HAS_A_CREDIT_BALANCE: ${old.credit_balance}`, 409);
  if (await funding.isFunded(c, old.id)) throw err('FUNDED_LOANS_CANNOT_BE_RESTRUCTURED_HERE', 409);
}

/**
 * Mambu refuses to carry capitalised amounts into a product booked on a
 * different method: they were recognised one way and would be unwound
 * another.
 */
function assertSameMethod(old, np, capitalized) {
  if ((Number(old.principal_capitalized) > 0 || capitalized > 0) && np.accounting_method !== old.accounting_method) {
    throw err(`CAPITALIZED_AMOUNTS_NOT_ALLOWED_DUE_TO_DIFFERENT_ACCOUNTING: ${old.accounting_method} to ${np.accounting_method}`, 409);
  }
}

/**
 * Interest owed brought up to the date, so the figure settled is the real
 * one. Interest the member paid in advance and has not earned goes to the
 * principal of the loan being settled.
 */
async function bringToDate(c, old, date, createdBy) {
  if (Number(old.interest_prepaid) > 0) {
    await prepaidToPrincipal(c, old.id, { valueDate: date, createdBy });
    old = await L.lock(c, old.id);
  }
  if (!types.forLoan(old).bringsInterestToDate || old.status === 'LOCKED') return old;
  await accrueInterest(c, old.id, { valueDate: date, createdBy });
  return L.lock(c, old.id);
}

async function productFor(c, id, { activeOnly = true } = {}) {
  const { rows: [np] } = await c.query(
    `SELECT * FROM loan_products WHERE id = $1 ${activeOnly ? 'AND is_active' : ''}`, [id]);
  if (!np) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  return np;
}

async function channelFor(c, channelId) {
  const { rows: [ch] } = await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId]);
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);
  return ch;
}

/**
 * Settle `old` into `fresh`: the journal entry, the old loan closed, the new
 * one made ACTIVE with its schedule, guarantors and collateral moved, and
 * the transaction recorded on the old account.
 */
async function settle(c, { kind, old, np, fresh, s, extra, channel, channelId, arrears, date, note, createdBy }) {
  const b = s.balances;
  const { capitalized, writtenOff } = s;
  const newPrincipal = round2(b.principal + capitalized + extra);
  const mid = old.member_id;
  const label = kind === 'REFINANCE' ? 'Refinance' : 'Reschedule';

  // ---- the journal entry ---------------------------------------------------
  const debits = [];
  const credits = [];
  const books = L.booksEntries(old) && np.accounting_method !== 'NONE';
  if (books) {
    // Principal moves portfolio to portfolio; the top-up leaves through the channel.
    debits.push({ glCode: np.gl_portfolio, amount: newPrincipal, memberId: mid });
    credits.push({ glCode: old.gl_portfolio, amount: b.principal, memberId: mid });
    if (extra > 0) credits.push({ glCode: channel.gl_account_code, amount: extra, memberId: mid });
    // Whether a component sits in a receivable: interest when accrued
    // interest reaches the ledger, fees and penalties under accrual.
    const inReceivable = (component) => (component === 'INTEREST' ? L.interestAccrues(old) : L.isAccrual(old));
    for (const [component, amount] of [['INTEREST', b.interest], ['FEE', round2(b.fees + b.nonScheduledFees)], ['PENALTY', b.penalty]]) {
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
    narration: `${label} ${old.account_no}${note ? `: ${note}` : ''}`,
    sourceType: `LOAN_${kind}`, sourceId: old.id, bookingDate: date, channelId: extra > 0 ? channelId : undefined, createdBy,
    branchId: old.branch_id || null,
  })).entryId : null;

  // ---- close the old loan ------------------------------------------------
  const closedStatus = kind === 'REFINANCE' ? 'CLOSED_REFINANCED' : 'CLOSED_RESCHEDULED';
  await c.query(
    `UPDATE loan_accounts SET
       principal_paid = principal_paid + $1, interest_paid = interest_paid + $2,
       fees_paid = fees_paid + $3, penalty_paid = penalty_paid + $4, ns_fees_paid = ns_fees_paid + $8,
       status = $5, closed_on = $6::date, locked_at = NULL, locked_reason = NULL, status_before_lock = NULL, updated_at = now()
     WHERE id = $7`,
    [b.principal, b.interest, b.fees, b.penalty, closedStatus, date, old.id, b.nonScheduledFees]);
  await c.query("UPDATE loan_fees SET status = CASE WHEN status = 'DUE' THEN 'PAID' ELSE status END, paid = amount WHERE loan_id = $1 AND status = 'DUE'", [old.id]);
  await W.history(c, old.id, { from: old.status, to: closedStatus, action: kind, actor: createdBy, note: note || `into ${fresh.account_no}` });

  // ---- the new one becomes active ------------------------------------------
  await c.query(
    `UPDATE loan_accounts SET parent_loan_id = $1, status = 'ACTIVE',
       approved_on = COALESCE(approved_on, $2::date), approved_by = COALESCE(approved_by, $3),
       principal_disbursed = $4, disbursed_on = $2::date, accrued_through = $2::date, disbursed_by = $3, updated_at = now()
     WHERE id = $5`,
    [old.id, date, createdBy || 'SYSTEM', newPrincipal, fresh.id]);
  await W.history(c, fresh.id, { from: fresh.status, to: 'ACTIVE', action: kind, actor: createdBy, note: `from ${old.account_no}` });
  await W.freezeSettings(c, fresh.id);
  const activated = await L.lock(c, fresh.id);
  // Deferred fee income ends on the old loan or continues on the new one.
  await FA.carryOver(c, old, activated, { date, createdBy });
  await buildSchedule(c, activated);
  // The new product's payment-due fees, if fixed-term, land with the schedule.
  await fees.applyPaymentDueFees(c, activated, types.forLoan(activated).paymentDueHorizon(date));

  // ---- security follows ------------------------------------------------------
  const { rows: gs } = await c.query(
    "SELECT member_id, pledged_amount FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED'", [old.id]);
  await eligibility.releaseGuarantors(c, old.id);
  for (const g of gs) {
    await c.query('INSERT INTO loan_guarantors (loan_id, member_id, pledged_amount) VALUES ($1,$2,$3)', [fresh.id, g.member_id, g.pledged_amount]);
  }
  const { rowCount: collateralMoved } = await c.query(
    "UPDATE loan_collateral SET loan_id = $2 WHERE loan_id = $1 AND status = 'PLEDGED'", [old.id, fresh.id]);

  const tx = await savings.record(c, {
    reference: savings.ref(kind === 'REFINANCE' ? 'RF' : 'RS'), kind: `LOAN_${kind}`, memberId: mid,
    loanAccountId: old.id, amount: newPrincipal, valueDate: date, entryId,
    channelId: extra > 0 ? channelId : undefined,
    allocation: {
      newLoanId: fresh.id, newAccountNo: activated.account_no, principal: b.principal,
      capitalized, writtenOff, topUp: extra, arrears,
      charges: { interest: b.interest, fees: b.fees, penalty: b.penalty },
      guarantorsMoved: gs.length, collateralMoved,
    },
    narration: note, createdBy,
  });
  return {
    transaction: tx, oldLoan: { id: old.id, accountNo: old.account_no, status: closedStatus },
    newLoan: await L.lock(c, fresh.id), topUp: extra,
  };
}

// --------------------------------------------------------------------------
// Reschedule: one step
// --------------------------------------------------------------------------

async function restructure(c, loanId, {
  kind, productId = null, termMonths, monthlyRate, topUp = 0,
  arrears = 'CAPITALIZE', valueDate, note = null, createdBy,
} = {}) {
  if (kind === 'REFINANCE') {
    throw err('TOP_UP_NEEDS_AN_APPLICATION: POST /api/loans/:id/refinance opens one for approval', 400);
  }
  if (kind !== 'RESCHEDULE') throw err(`UNSUPPORTED_RESTRUCTURE: ${kind}`);
  if (!ARREARS.includes(arrears)) throw err('ARREARS_MUST_BE_CAPITALIZE_OR_WRITE_OFF', 400);
  if (round2(topUp || 0) > 0) throw err('RESCHEDULE_TAKES_NO_TOP_UP', 400);
  const date = valueDate ? ymd(valueDate) : today();

  let old = await L.lock(c, loanId);
  await assertRestructurable(c, old);
  const term = Number(termMonths);
  if (!(Number.isInteger(term) && term > 0)) throw err('INVALID_TERM', 400);

  old = await bringToDate(c, old, date, createdBy);
  const s = L.settlement(old, arrears);
  const np = await productFor(c, productId || old.product_id);
  if (term > np.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${np.max_term}`, 400);
  assertSameMethod(old, np, s.capitalized);
  if (!(s.amount > 0)) throw err('NOTHING_TO_RESTRUCTURE', 409);

  // The loan being settled is not counted against the member's exposure or
  // the one-active-loan rule: the new principal already includes it.
  const fresh = await loans.apply(c, {
    memberId: old.member_id, productId: np.id, principal: s.amount, termMonths: term, branchId: old.branch_id,
    monthlyRate, purpose: `Reschedule of ${old.account_no}`, notes: note, createdBy,
  }, { settles: old.id });
  return settle(c, { kind, old, np, fresh, s, extra: 0, channel: null, channelId: null, arrears, date, note, createdBy });
}

// --------------------------------------------------------------------------
// Refinance (top-up): application, approval, disbursement
// --------------------------------------------------------------------------

const OPEN_OR_APPROVED = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED'];

/**
 * Open a top-up application on a running loan. `topUp` is what the member
 * asks to receive; the application's principal is the settlement as the
 * loan stands now plus that. Or give `principal`, the gross new loan, and
 * the top-up is what is left after settlement.
 */
async function requestRefinance(c, loanId, params = {}) {
  const { topUp = null, principal = null, termMonths, productId = null, arrears = 'CAPITALIZE', note = null, createdBy } = params;
  if (!ARREARS.includes(arrears)) throw err('ARREARS_MUST_BE_CAPITALIZE_OR_WRITE_OFF', 400);
  const old = await L.lock(c, loanId);
  await assertRestructurable(c, old);
  const { rows: [open] } = await c.query(
    'SELECT account_no FROM loan_accounts WHERE refinance_of = $1 AND status = ANY($2)', [old.id, OPEN_OR_APPROVED]);
  if (open) throw err(`TOP_UP_ALREADY_OPEN: ${open.account_no}`, 409);

  const np = await productFor(c, productId || old.product_id);
  const s = L.settlement(old, arrears);
  assertSameMethod(old, np, s.capitalized);
  const gross = principal !== null && principal !== undefined ? round2(principal) : round2(s.amount + round2(topUp || 0));
  if (!(gross > s.amount)) throw err(`REFINANCE_NEEDS_A_TOP_UP: settlement of ${old.account_no} is ${s.amount}`, 400);

  // Only the loan's own terms and the overrides the product allows travel
  // from the request; tranches and funding sources do not apply to a top-up.
  const overrides = Object.fromEntries(Object.keys(L.OVERRIDES).filter((k) => params[k] !== undefined).map((k) => [k, params[k]]));
  const application = await loans.apply(c, {
    ...overrides, memberId: old.member_id, productId: np.id, principal: gross, termMonths,
    branchId: old.branch_id, purpose: `Top-up of ${old.account_no}`, notes: note, createdBy,
  }, { refinance: { of: old.id, arrears, topUp: round2(gross - s.amount) } });
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'LOAN_TOP_UP_REQUESTED','loan_account',$2,$3)`,
    [createdBy || 'SYSTEM', old.id, JSON.stringify({ application: application.account_no, principal: gross, settlement: s.amount, arrears })]);
  return { application, quote: await quote(c, application.id) };
}

/**
 * What a top-up application would pay out if disbursed on the balances as
 * they stand. Disbursement brings interest to the day first, so the figure
 * then may be a little lower on a loan that accrues daily.
 */
async function quote(c, applicationId) {
  const a = await L.read(c, applicationId);
  if (!a.refinance_of) throw err('NOT_A_TOP_UP_APPLICATION', 409);
  const old = await L.read(c, a.refinance_of);
  const s = L.settlement(old, a.refinance_arrears || 'CAPITALIZE');
  return {
    application: { id: a.id, accountNo: a.account_no, status: a.status },
    refinances: { id: old.id, accountNo: old.account_no, status: old.status },
    principal: Number(a.principal),
    settlement: s.amount,
    principalOutstanding: s.balances.principal,
    charges: { interest: s.balances.interest, fees: s.balances.fees, penalty: s.balances.penalty },
    arrears: a.refinance_arrears, capitalized: s.capitalized, writtenOff: s.writtenOff,
    requestedTopUp: a.top_up_requested === null ? null : Number(a.top_up_requested),
    topUp: round2(Number(a.principal) - s.amount),
  };
}

/** Pay out an approved top-up application by settling the loan it refinances. */
async function disburseRefinance(c, applicationId, { channelId = 'bank', valueDate, note = null, createdBy, user = null } = {}) {
  const a = await L.lock(c, applicationId);
  if (!a.refinance_of) throw err('NOT_A_TOP_UP_APPLICATION', 409);
  if (a.status !== 'APPROVED') throw err(`LOAN_NOT_APPROVED: ${a.status}`, 409);
  const date = valueDate ? ymd(valueDate) : today();

  let old = await L.lock(c, a.refinance_of);
  await assertRestructurable(c, old);
  old = await bringToDate(c, old, date, createdBy);
  const arrears = a.refinance_arrears || 'CAPITALIZE';
  const s = L.settlement(old, arrears);
  const extra = round2(Number(a.principal) - s.amount);
  if (!(extra > 0)) throw err(`NO_TOP_UP_LEFT: principal ${Number(a.principal)}, settlement of ${old.account_no} ${s.amount}`, 409);
  // The product was active when the application was opened; a product
  // retired since does not strand an approved loan, as with any disbursement.
  const np = await productFor(c, a.product_id, { activeOnly: false });
  assertSameMethod(old, np, s.capitalized);
  await W.assertMayDisburse(c, a, { actor: createdBy, amount: extra, user });
  const channel = await channelFor(c, channelId);
  return settle(c, { kind: 'REFINANCE', old, np, fresh: a, s, extra, channel, channelId, arrears, date, note: note || a.notes, createdBy });
}

module.exports = { restructure, requestRefinance, quote, disburseRefinance };
