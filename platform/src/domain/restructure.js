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
const writeOffs = require('./writeOffs');
const accruals = require('./accruals');
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
 * Swap account numbers so the new loan takes the running one's (Mambu's
 * Keep same account ID): the running loan is renumbered on its product's
 * pattern first and remembers the number it had.
 */
async function keepNumber(c, old, fresh) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [old.product_id]);
  const original = old.account_no;
  const renumbered = await loans.nextAccountNo(c, p);
  await c.query('UPDATE loan_accounts SET account_no = $2, previous_account_no = $3 WHERE id = $1', [old.id, renumbered, original]);
  await c.query('UPDATE loan_accounts SET previous_account_no = account_no, account_no = $2 WHERE id = $1', [fresh.id, original]);
  return { original, renumbered, discarded: fresh.account_no };
}

/**
 * Settle `old` into `fresh`: the charges not capitalised written off
 * (./writeOffs, with any principal a reschedule gives up), the journal
 * entry, the old loan closed, the new one made ACTIVE with its schedule,
 * late and payment-due fees moved across, guarantors and collateral moved,
 * and the transaction recorded on the old account. Everything an undo needs
 * is kept in the transaction's allocation.
 */
async function settle(c, { kind, old, np, fresh, plan, extra, channel, channelId, arrears, date, note, createdBy, keepAccountNo = false }) {
  const mid = old.member_id;
  const label = kind === 'REFINANCE' ? 'Refinance' : 'Reschedule';
  const previousStatus = old.status;

  // ---- what is not capitalised is written off first ----------------------
  let writeOff = null;
  if (plan.writtenOff > 0 || plan.reduce > 0) {
    const { rows: keep } = await c.query('SELECT id FROM loan_fees WHERE loan_id = $1 AND status = $2', [old.id, 'DUE']);
    const carriedIds = new Set(plan.carried.map((f) => f.id));
    writeOff = await writeOffs.writeOffCharges(c, old.id, {
      ...plan.wo, principal: plan.reduce, kind, reason: `${label}${note ? `: ${note}` : ''}`, valueDate: date, createdBy,
      feeIds: keep.map((f) => f.id).filter((id) => !carriedIds.has(id)),
    });
    old = await L.lock(c, old.id);
  }
  const b = L.balances(old);
  const carried = plan.carriedTotal;
  const capFee = round2(b.fees + b.nonScheduledFees - carried);
  const capitalized = round2(Math.max(0, b.interest) + Math.max(0, capFee) + Math.max(0, b.penalty));
  const newPrincipal = round2(b.principal + capitalized + extra);

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
    for (const [component, amount] of [['INTEREST', b.interest], ['FEE', capFee], ['PENALTY', b.penalty]]) {
      if (!(amount > 0)) continue;
      // Capitalised charges: under accrual they clear the receivable that
      // held them; under cash they are recognised as income now, since
      // they have become principal the member will repay.
      credits.push({ glCode: inReceivable(component) ? L.writeOffCredit(old, component) : L.paidCredit(old, component), amount, memberId: mid });
    }
    // Fees moving to the new loan move from one receivable to the other
    // (nothing under cash, where they were never recognised).
    if (L.isAccrual(old) && L.isAccrual(np)) {
      for (const f of plan.carried) {
        const from = f.gl_receivable || old.gl_fee_rec;
        const to = np.gl_fee_rec;
        if (from === to) continue;
        debits.push({ glCode: to, amount: f.left, memberId: mid });
        credits.push({ glCode: from, amount: f.left, memberId: mid });
      }
    }
  }
  const entryId = books ? (await acct.post(c, {
    debits, credits,
    narration: `${label} ${old.account_no}${note ? `: ${note}` : ''}`,
    sourceType: `LOAN_${kind}`, sourceId: old.id, bookingDate: date, channelId: extra > 0 ? channelId : undefined, createdBy,
    branchId: old.branch_id || null,
  })).entryId : null;

  // ---- keep the account number, if asked -----------------------------------
  const numbers = keepAccountNo ? await keepNumber(c, old, fresh) : null;

  // ---- close the old loan ------------------------------------------------
  const closedStatus = kind === 'REFINANCE' ? 'CLOSED_REFINANCED' : 'CLOSED_RESCHEDULED';
  await c.query(
    `UPDATE loan_accounts SET
       principal_paid = principal_paid + $1, interest_paid = interest_paid + $2,
       fees_paid = fees_paid + $3, penalty_paid = penalty_paid + $4, ns_fees_paid = ns_fees_paid + $8,
       status = $5, closed_on = $6::date, locked_at = NULL, locked_reason = NULL, status_before_lock = NULL, updated_at = now()
     WHERE id = $7`,
    [b.principal, b.interest, b.fees, b.penalty, closedStatus, date, old.id, b.nonScheduledFees]);
  const { rows: settledFees } = await c.query(
    "SELECT id, (amount - paid) AS was_owed FROM loan_fees WHERE loan_id = $1 AND status = 'DUE' FOR UPDATE", [old.id]);
  await c.query("UPDATE loan_fees SET status = 'PAID', paid = amount WHERE loan_id = $1 AND status = 'DUE'", [old.id]);
  await W.history(c, old.id, { from: old.status, to: closedStatus, action: kind, actor: createdBy, note: note || `into ${numbers ? numbers.original : fresh.account_no}` });

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
  const { rows: movingPlans } = await c.query("SELECT id FROM loan_fee_amortization WHERE loan_id = $1 AND status = 'OPEN'", [old.id]);
  await FA.carryOver(c, old, activated, { date, createdBy });
  await buildSchedule(c, activated);
  // The new product's payment-due fees, if fixed-term, land with the schedule.
  await fees.applyPaymentDueFees(c, activated, types.forLoan(activated).paymentDueHorizon(date));
  // Late repayment and payment-due fees move across (Mambu), as fees on
  // the new loan's next installment, already recognised on the old one.
  const moved = [];
  for (const f of plan.carried) {
    const row = await fees.recordFee(c, await L.lock(c, fresh.id), {
      name: `${f.name} (from ${old.account_no})`, feeType: 'MANUAL', amount: f.left, valueDate: date, createdBy,
      allocation: 'NEXT_INSTALLMENT', booked: false, taxable: false, note: `${f.fee_type} carried from ${old.account_no}`,
    });
    if (row) moved.push({ from: f.id, to: row.id, amount: f.left });
  }

  // ---- security follows ------------------------------------------------------
  const { rows: gs } = await c.query(
    "SELECT id, member_id, pledged_amount FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED'", [old.id]);
  await eligibility.releaseGuarantors(c, old.id);
  const added = [];
  for (const g of gs) {
    const { rows: [n] } = await c.query(
      `INSERT INTO loan_guarantors (loan_id, member_id, pledged_amount) VALUES ($1,$2,$3)
       ON CONFLICT (loan_id, member_id) DO UPDATE SET status = 'PLEDGED', pledged_amount = EXCLUDED.pledged_amount RETURNING id`,
      [fresh.id, g.member_id, g.pledged_amount]);
    added.push(n.id);
  }
  const { rows: collateral } = await c.query(
    "UPDATE loan_collateral SET loan_id = $2 WHERE loan_id = $1 AND status = 'PLEDGED' RETURNING id", [old.id, fresh.id]);

  const tx = await savings.record(c, {
    reference: savings.ref(kind === 'REFINANCE' ? 'RF' : 'RS'), kind: `LOAN_${kind}`, memberId: mid,
    loanAccountId: old.id, amount: newPrincipal, valueDate: date, entryId,
    channelId: extra > 0 ? channelId : undefined,
    allocation: {
      newLoanId: fresh.id, newAccountNo: (await L.lock(c, fresh.id)).account_no, principal: b.principal,
      capitalized, writtenOff: plan.writtenOff, principalWrittenOff: plan.reduce, topUp: extra, arrears,
      capitalizedCharges: { interest: b.interest, fees: capFee, penalty: b.penalty },
      writtenOffCharges: plan.wo, carriedFees: moved, writeOff: writeOff?.reference || null,
      charges: { interest: b.interest, fees: b.fees, penalty: b.penalty },
      guarantorsMoved: gs.length, collateralMoved: collateral.length,
      undo: {
        previousStatus, nonScheduledFees: b.nonScheduledFees, settledFees: settledFees.map((f) => ({ id: f.id, owed: Number(f.was_owed) })),
        guarantorsReleased: gs.map((g) => g.id), guarantorsAdded: added, collateral: collateral.map((k) => k.id),
        amortizationMoved: movingPlans.map((r) => r.id), numbers,
      },
    },
    narration: note, createdBy,
  });
  return {
    transaction: tx, oldLoan: { id: old.id, accountNo: (await L.lock(c, old.id)).account_no, status: closedStatus },
    newLoan: await L.lock(c, fresh.id), topUp: extra,
  };
}

// --------------------------------------------------------------------------
// Reschedule: one step
// --------------------------------------------------------------------------

async function restructure(c, loanId, {
  kind, productId = null, termMonths, monthlyRate, topUp = 0,
  arrears = 'CAPITALIZE', capitalize = null, carryFees = true, principal = null, keepAccountNo = false,
  valueDate, note = null, createdBy,
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
  const plan = await L.settlementPlan(c, old, { arrears, capitalize, carryFees: carryFees !== false && carryFees !== 'false', principal });
  const np = await productFor(c, productId || old.product_id);
  if (term > np.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${np.max_term}`, 400);
  assertSameMethod(old, np, plan.capitalized);
  if (!(plan.amount > 0)) throw err('NOTHING_TO_RESTRUCTURE', 409);

  // The loan being settled is not counted against the member's exposure or
  // the one-active-loan rule: the new principal already includes it.
  const fresh = await loans.apply(c, {
    memberId: old.member_id, productId: np.id, principal: plan.amount, termMonths: term, branchId: old.branch_id,
    monthlyRate, purpose: `Reschedule of ${old.account_no}`, notes: note, createdBy,
  }, { settles: old.id });
  return settle(c, { kind, old, np, fresh, plan, extra: 0, channel: null, channelId: null, arrears, date, note, createdBy, keepAccountNo: keepAccountNo === true || keepAccountNo === 'true' });
}

// --------------------------------------------------------------------------
// Refinance (top-up): application, approval, disbursement
// --------------------------------------------------------------------------

const OPEN_OR_APPROVED = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED'];

/**
 * Open a top-up application on a running loan. `topUp` is what the member
 * asks to receive; the application's principal is the settlement as the
 * loan stands now plus that. Or give `principal`, the gross new loan, and
 * the top-up is what is left after settlement. The settlement terms
 * (`arrears` or `capitalize`, `carryFees`, `keepAccountNo`) are kept on the
 * application and applied when it is paid out.
 */
async function requestRefinance(c, loanId, params = {}) {
  const { topUp = null, principal = null, termMonths, productId = null, arrears = 'CAPITALIZE', capitalize = null, carryFees = true,
    keepAccountNo = false, note = null, createdBy } = params;
  if (!ARREARS.includes(arrears)) throw err('ARREARS_MUST_BE_CAPITALIZE_OR_WRITE_OFF', 400);
  const old = await L.lock(c, loanId);
  await assertRestructurable(c, old);
  const { rows: [open] } = await c.query(
    'SELECT account_no FROM loan_accounts WHERE refinance_of = $1 AND status = ANY($2)', [old.id, OPEN_OR_APPROVED]);
  if (open) throw err(`TOP_UP_ALREADY_OPEN: ${open.account_no}`, 409);

  const np = await productFor(c, productId || old.product_id);
  const carry = carryFees !== false && carryFees !== 'false';
  const s = await L.settlementPlan(c, old, { arrears, capitalize, carryFees: carry });
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
    'UPDATE loan_accounts SET refinance_capitalize = $2, refinance_carry_fees = $3, keep_account_no = $4 WHERE id = $1',
    [application.id, capitalize && typeof capitalize === 'object' ? JSON.stringify(s.cap) : null, carry, keepAccountNo === true || keepAccountNo === 'true']);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'LOAN_TOP_UP_REQUESTED','loan_account',$2,$3)`,
    [createdBy || 'SYSTEM', old.id, JSON.stringify({ application: application.account_no, principal: gross, settlement: s.amount, arrears, capitalize: s.cap })]);
  return { application: await L.read(c, application.id), quote: await quote(c, application.id) };
}

const planFor = (c, old, a) => L.settlementPlan(c, old, {
  arrears: a.refinance_arrears || 'CAPITALIZE', capitalize: a.refinance_capitalize, carryFees: a.refinance_carry_fees !== false,
});

/**
 * What a top-up application would pay out if disbursed on the balances as
 * they stand. Disbursement brings interest to the day first, so the figure
 * then may be a little lower on a loan that accrues daily.
 */
async function quote(c, applicationId) {
  const a = await L.read(c, applicationId);
  if (!a.refinance_of) throw err('NOT_A_TOP_UP_APPLICATION', 409);
  const old = await L.read(c, a.refinance_of);
  const s = await planFor(c, old, a);
  return {
    application: { id: a.id, accountNo: a.account_no, status: a.status },
    refinances: { id: old.id, accountNo: old.account_no, status: old.status },
    principal: Number(a.principal),
    settlement: s.amount,
    principalOutstanding: s.balances.principal,
    charges: { interest: s.balances.interest, fees: s.balances.fees, penalty: s.balances.penalty },
    arrears: a.refinance_arrears, capitalized: s.capitalized, writtenOff: s.writtenOff,
    capitalize: s.cap, writeOff: s.wo, carriedFees: s.carriedTotal, keepAccountNo: Boolean(a.keep_account_no),
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
  const plan = await planFor(c, old, a);
  const extra = round2(Number(a.principal) - plan.amount);
  if (!(extra > 0)) throw err(`NO_TOP_UP_LEFT: principal ${Number(a.principal)}, settlement of ${old.account_no} ${plan.amount}`, 409);
  // The product was active when the application was opened; a product
  // retired since does not strand an approved loan, as with any disbursement.
  const np = await productFor(c, a.product_id, { activeOnly: false });
  assertSameMethod(old, np, plan.capitalized);
  await W.assertMayDisburse(c, a, { actor: createdBy, amount: extra, user });
  await eligibility.assertCovered(c, a);
  const channel = await channelFor(c, channelId || 'bank');
  return settle(c, { kind: 'REFINANCE', old, np, fresh: a, plan, extra, channel, channelId: channelId || 'bank', arrears, date,
    note: note || a.notes, createdBy, keepAccountNo: Boolean(a.keep_account_no) });
}

// --------------------------------------------------------------------------
// Undo reschedule or refinance
// --------------------------------------------------------------------------

/**
 * Undo a reschedule or a refinance (Mambu's Undo Reschedule / Undo
 * Refinance), from the new loan: the original loan is active again as it
 * was, and the new one is Closed (Withdrawn). The restructure's entry is
 * reversed (the principal moved back, charges no longer capitalised, a
 * top-up's payout taken back), the charges it wrote off are restored, what
 * the new loan booked since (interest accrued, fees applied) is reversed,
 * fees moved across go back, and guarantors, collateral, deferred fee income
 * and a kept account number return. The transactions stay on both loans,
 * marked reversed. Refused once the new loan has taken a repayment.
 */
async function undoRestructure(c, loanId, { note = null, createdBy } = {}) {
  let fresh = await L.lock(c, loanId);
  if (!fresh.parent_loan_id) throw err('NOT_A_RESCHEDULED_OR_REFINANCED_LOAN', 409);
  if (!['ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(fresh.status)) throw err(`NEW_LOAN_NOT_RUNNING: ${fresh.status}`, 409);
  let old = await L.lock(c, fresh.parent_loan_id);
  if (!['CLOSED_RESCHEDULED', 'CLOSED_REFINANCED'].includes(old.status)) throw err(`ORIGINAL_LOAN_NOT_RESTRUCTURED: ${old.status}`, 409);
  const { rows: [tx] } = await c.query(
    `SELECT * FROM transactions WHERE loan_account_id = $1 AND kind IN ('LOAN_RESCHEDULE', 'LOAN_REFINANCE') AND reversed_by IS NULL
       AND allocation->>'newLoanId' = $2 ORDER BY created_at DESC LIMIT 1`, [old.id, fresh.id]);
  if (!tx) throw err('RESTRUCTURE_TRANSACTION_NOT_FOUND', 404);
  const { rows: [paid] } = await c.query(
    `SELECT reference FROM transactions WHERE loan_account_id = $1 AND kind IN ('LOAN_REPAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_WRITE_OFF')
       AND reversed_by IS NULL LIMIT 1`, [fresh.id]);
  if (paid) throw err(`NEW_LOAN_HAS_TRANSACTIONS: reverse ${paid.reference} first`, 409);
  const a = tx.allocation || {};
  const u = a.undo || {};
  const narration = note || `Undo ${tx.kind === 'LOAN_REFINANCE' ? 'refinance' : 'reschedule'}`;
  const date = today();

  // ---- what the new loan booked since ---------------------------------------
  const { rows: own } = await c.query(
    `SELECT * FROM transactions WHERE loan_account_id = $1 AND reversed_by IS NULL
       AND kind IN ('LOAN_INTEREST_ACCRUAL', 'LOAN_FEE', 'LOAN_INTEREST_CAPITALIZED') ORDER BY created_at DESC`, [fresh.id]);
  for (const t of own) {
    if (t.entry_id) await acct.reverse(c, t.entry_id, narration, createdBy);
    const rev = await savings.record(c, {
      reference: savings.ref('REV'), kind: 'REVERSAL', memberId: t.member_id, loanAccountId: fresh.id, amount: -Number(t.amount),
      allocation: { reversalOf: t.reference }, narration, createdBy,
    });
    await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, t.id]);
  }
  // Interest accrued on the new loan and not yet posted, or posted in an
  // aggregated entry, is taken back with an accrual the other way.
  const { rows: pendingAccruals } = await c.query(
    `SELECT product_id, branch_id, component, debit_gl, credit_gl, sum(amount) AS amount FROM accrual_lines
     WHERE account_kind = 'LOAN' AND account_id = $1 AND post_mode <> 'NOW' GROUP BY product_id, branch_id, component, debit_gl, credit_gl`, [fresh.id]);
  for (const r of pendingAccruals) {
    if (!(Math.abs(Number(r.amount)) > 0)) continue;
    await accruals.record(c, { kind: 'LOAN', product: { ...fresh, id: fresh.product_id }, accountId: fresh.id, memberId: fresh.member_id,
      branchId: r.branch_id, date, createdBy, narration,
      lines: [{ component: r.component, debitGl: r.debit_gl, creditGl: r.credit_gl, amount: -Number(r.amount) }] });
  }
  const { rows: penaltyEntries } = await c.query(
    'SELECT id, entry_id FROM penalty_charges WHERE loan_id = $1 AND entry_id IS NOT NULL AND waived_at IS NULL AND reversed_at IS NULL', [fresh.id]);
  for (const p of penaltyEntries) {
    await acct.reverse(c, p.entry_id, narration, createdBy);
    await c.query('UPDATE penalty_charges SET reversed_at = now(), reversed_by = $2, reversal_reason = $3 WHERE id = $1', [p.id, createdBy || 'SYSTEM', narration]);
  }
  // Deferred fee income that moved to the new loan comes back.
  if ((u.amortizationMoved || []).length) {
    await c.query('UPDATE loan_fee_amortization SET loan_id = $1 WHERE id = ANY($2::uuid[]) AND loan_id = $3', [old.id, u.amortizationMoved, fresh.id]);
  }
  await FA.undoClosure(c, old.id, { createdBy, narration });

  // ---- the restructure itself ----------------------------------------------
  if (tx.entry_id) await acct.reverse(c, tx.entry_id, narration, createdBy);
  const ch = a.charges || {};
  await c.query(
    `UPDATE loan_accounts SET principal_paid = principal_paid - $2, interest_paid = interest_paid - $3, fees_paid = fees_paid - $4,
       penalty_paid = penalty_paid - $5, ns_fees_paid = ns_fees_paid - $6, status = $7, closed_on = NULL, updated_at = now() WHERE id = $1`,
    [old.id, Number(a.principal || 0), Number(ch.interest || 0), Number(ch.fees || 0), Number(ch.penalty || 0), Number(u.nonScheduledFees || 0),
      u.previousStatus || 'ACTIVE']);
  for (const f of u.settledFees || []) {
    await c.query("UPDATE loan_fees SET paid = amount - $2, status = CASE WHEN $2 > 0 THEN 'DUE' ELSE status END WHERE id = $1", [f.id, f.owed]);
  }
  if (a.writeOff) {
    const { rows: [w] } = await c.query('SELECT * FROM transactions WHERE reference = $1', [a.writeOff]);
    if (w) await writeOffs.undoChargeWriteOff(c, w, { narration, createdBy });
  }
  // Guarantors and collateral back on the original loan.
  if ((u.guarantorsAdded || []).length) await c.query("UPDATE loan_guarantors SET status = 'RELEASED' WHERE id = ANY($1::uuid[])", [u.guarantorsAdded]);
  if ((u.guarantorsReleased || []).length) await c.query("UPDATE loan_guarantors SET status = 'PLEDGED' WHERE id = ANY($1::uuid[])", [u.guarantorsReleased]);
  if ((u.collateral || []).length) await c.query('UPDATE loan_collateral SET loan_id = $1 WHERE id = ANY($2::uuid[])', [old.id, u.collateral]);
  // A kept account number goes back to the original loan.
  if (u.numbers) {
    await c.query('UPDATE loan_accounts SET account_no = $2 WHERE id = $1', [fresh.id, u.numbers.discarded]);
    await c.query('UPDATE loan_accounts SET account_no = $2, previous_account_no = NULL WHERE id = $1', [old.id, u.numbers.original]);
  }

  // ---- the new loan withdrawn ---------------------------------------------
  await c.query("UPDATE loan_installments SET status = CASE WHEN status = 'PAID' THEN status ELSE 'PENDING' END WHERE loan_id = $1", [fresh.id]);
  await c.query(
    `UPDATE loan_accounts SET status = 'CLOSED_WITHDRAWN', closed_on = $2::date, locked_at = NULL, locked_reason = NULL, status_before_lock = NULL,
       updated_at = now() WHERE id = $1`, [fresh.id, date]);
  await c.query("UPDATE loan_fees SET status = 'ADJUSTED', waived_at = now(), waived_by = $2 WHERE loan_id = $1 AND status = 'DUE'", [fresh.id, createdBy || 'SYSTEM']);
  await eligibility.releaseGuarantors(c, fresh.id);
  await W.history(c, fresh.id, { from: fresh.status, to: 'CLOSED_WITHDRAWN', action: `UNDO_${tx.kind.replace('LOAN_', '')}`, actor: createdBy, note });
  await W.history(c, old.id, { from: old.status, to: u.previousStatus || 'ACTIVE', action: `UNDO_${tx.kind.replace('LOAN_', '')}`, actor: createdBy, note });
  const rev = await savings.record(c, {
    reference: savings.ref('REV'), kind: 'REVERSAL', memberId: tx.member_id, loanAccountId: old.id, amount: -Number(tx.amount),
    allocation: { reversalOf: tx.reference, newLoanId: fresh.id }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  // The original loan is caught up: arrears on what fell due meanwhile.
  old = await L.lock(c, old.id);
  if (old.status === 'IN_ARREARS') await W.refreshArrears(c, old, date);
  fresh = await L.lock(c, fresh.id);
  return { restored: { id: old.id, accountNo: (await L.lock(c, old.id)).account_no, status: (await L.lock(c, old.id)).status },
    withdrawn: { id: fresh.id, accountNo: fresh.account_no, status: fresh.status }, reversal: rev };
}

module.exports = { restructure, requestRefinance, quote, disburseRefinance, undoRestructure };
