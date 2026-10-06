'use strict';

/**
 * Loan accounts: allocation of a repayment across installments and components, interest paid in advance, and repayment.
 */

const { orgToday } = require('../../lib/orgDate');
const PERMS = require('../../lib/permissions');
const acct = require('../accounting');
const savings = require('../savings');
const S = require('../schedule');
const ledger = require('../ledger');
const controls = require('../controls');
const channels = require('../channels');
const funding = require('../funding');
const workflow = require('../workflow');
const fees = require('../fees');
const installments = require('../installments');
const interest = require('../interest');
const types = require('../productTypes');
const PA = require('../productAccounting');
const penalties = require('../penalties');
const FA = require('../feeAmortization');
const { err, round2 } = acct;
const { ymd } = S;
const { lock, balances, booksEntries, post, creditsFor } = ledger;
const { applyToInstallments, markPaidOnPrincipal } = installments;
const { recognisePrepaidInterest } = interest;
const core = require('./core');

/**
 * Repayment allocation follows the product's `allocation_order` (default
 * penalty, fee, interest, principal). Anything left over goes to the
 * member's savings rather than sitting as an unexplained credit on the loan.
 *
 * Each component is credited to the account the accounting method says:
 * under accrual, the receivable that was debited when it was applied; under
 * cash, income. See paidCredit().
 */
const COMPONENTS = ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'];

/**
 * HORIZONTAL allocation (the reference platform): the schedule decides. Each unpaid
 * installment in turn takes its own penalties, fees, interest and principal
 * in the allocation order before the next is touched; interest never beyond
 * what has been earned. Whatever the loan owes outside its installments (a
 * fee due at once, interest past the schedule) is then paid in the order,
 * and the rest is surplus.
 */
async function horizontalAllocation(c, l, due, amount, order) {
  const { rows: insts } = await c.query(
    "SELECT * FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID' ORDER BY number", [l.id]);
  // Penalties are charged against installments; what has been paid is taken
  // off the oldest first.
  const { rows: pen } = await c.query(
    `SELECT i.number, COALESCE(sum(pc.amount), 0) AS amount FROM penalty_charges pc JOIN loan_installments i ON i.id = pc.installment_id
     WHERE pc.loan_id = $1 AND pc.waived_at IS NULL GROUP BY i.number ORDER BY i.number`, [l.id]);
  let penPaid = Number(l.penalty_paid || 0);
  const penLeft = {};
  for (const x of pen) {
    const take = Math.min(penPaid, Number(x.amount));
    penPaid = round2(penPaid - take);
    penLeft[x.number] = round2(Number(x.amount) - take);
  }
  const cap = { ...due };
  const paid = { PENALTY: 0, FEE: 0, INTEREST: 0, PRINCIPAL: 0 };
  let left = amount;
  for (const inst of insts) {
    if (!(left > 0)) break;
    const owes = {
      PENALTY: penLeft[inst.number] || 0,
      FEE: round2(inst.fee_due - inst.fee_paid),
      INTEREST: round2(inst.interest_due - inst.interest_paid),
      PRINCIPAL: round2(inst.principal_due - inst.principal_paid),
    };
    for (const k of order) {
      const t = round2(Math.max(0, Math.min(left, owes[k], cap[k])));
      paid[k] = round2(paid[k] + t); cap[k] = round2(cap[k] - t); left = round2(left - t);
    }
  }
  for (const k of order) {
    const t = round2(Math.max(0, Math.min(left, cap[k])));
    paid[k] = round2(paid[k] + t); cap[k] = round2(cap[k] - t); left = round2(left - t);
  }
  return { paid, left };
}

/**
 * Interest taken in advance on a fixed-term loan (the product's
 * interest_prepayment). What the payment has left after penalties, fees and
 * the interest earned so far (`pool`) goes through the unpaid installments
 * in order: an installment not yet due gives up its whole interest first
 * (NEXT_INSTALLMENT: only the next one; ALL_INSTALLMENTS: each one the
 * payment reaches), then its principal. The interest not yet earned is held
 * in the deferred interest account until it is (../interest). A funded
 * loan's interest belongs partly to its funders when paid, so it is not
 * taken in advance. Returns null when nothing is taken.
 */
async function prepayInterest(c, l, type, { interest, pool, asOf }) {
  const mode = l.interest_prepayment || 'NONE';
  if (mode === 'NONE' || type.basis !== 'SCHEDULE' || !type.accrues(l) || l.interest_accrual === 'NONE' || !(pool > 0)) return null;
  if (await funding.isFunded(c, l.id)) return null;
  const { rows } = await c.query(
    "SELECT * FROM loan_installments WHERE loan_id = $1 AND status NOT IN ('PAID', 'GRACE') ORDER BY number", [l.id]);
  const cap = balances(l).principal;
  let earnedLeft = interest;   // the earned interest this payment settles, applied in order first
  let left = pool;
  let prepaid = 0;
  let principal = 0;
  let reached = 0;
  for (const inst of rows) {
    let owes = round2(Number(inst.interest_due) - Number(inst.interest_paid));
    const earned = round2(Math.min(earnedLeft, owes));
    earnedLeft = round2(earnedLeft - earned);
    owes = round2(owes - earned);
    const future = ymd(inst.due_date) > asOf;
    if (future && owes > 0 && (mode === 'ALL_INSTALLMENTS' || reached === 0)) {
      const t = round2(Math.min(left, owes));
      prepaid = round2(prepaid + t); left = round2(left - t);
    }
    if (future) reached += 1;
    const t = round2(Math.max(0, Math.min(left, Number(inst.principal_due) - Number(inst.principal_paid), cap - principal)));
    principal = round2(principal + t); left = round2(left - t);
    if (!(left > 0)) break;
  }
  const rest = round2(Math.max(0, Math.min(left, cap - principal)));
  principal = round2(principal + rest); left = round2(left - rest);
  if (!(prepaid > 0)) return null;
  return { prepaid, principal, left };
}

/**
 * A custom repayment (the reference platform's Custom Repayments): the teller says how much
 * goes to each item. Each amount is at most what is owed on it and they add
 * up to the payment. It is the only way to pay fees kept off the schedule
 * (NON_SCHEDULED_FEE).
 */
const CUSTOM_ITEMS = { penalty: 'PENALTY', fee: 'FEE', interest: 'INTEREST', principal: 'PRINCIPAL', nonScheduledFee: 'NON_SCHEDULED_FEE' };
function customPaid(custom, amount, due) {
  const keys = Object.keys(custom || {});
  if (!keys.length || keys.some((k) => !CUSTOM_ITEMS[k])) throw err(`CUSTOM_ALLOCATION_ITEMS: ${Object.keys(CUSTOM_ITEMS).join(', ')}`, 400);
  const paid = { PENALTY: 0, FEE: 0, INTEREST: 0, PRINCIPAL: 0, NON_SCHEDULED_FEE: 0 };
  for (const k of keys) {
    const v = round2(custom[k]);
    if (!(v >= 0)) throw err(`CUSTOM_ALLOCATION_AMOUNT_INVALID: ${k}`, 400);
    if (v > round2(due[CUSTOM_ITEMS[k]])) throw err(`CUSTOM_ALLOCATION_EXCEEDS_WHAT_IS_OWED: ${k} owes ${round2(due[CUSTOM_ITEMS[k]])}`, 400);
    paid[CUSTOM_ITEMS[k]] = v;
  }
  const sum = round2(Object.values(paid).reduce((a, x) => a + x, 0));
  if (sum !== round2(amount)) throw err(`CUSTOM_ALLOCATION_MUST_ADD_UP_TO_THE_AMOUNT: ${sum} of ${round2(amount)}`, 400);
  return paid;
}

/**
 * The value date a repayment may carry: not before a repayment already on
 * the loan (the reference platform: backdate only where no repayment is entered after the
 * date; reverse the later ones first).
 */
async function assertNoLaterRepayment(c, loanId, asOf) {
  const { rows: [later] } = await c.query(
    `SELECT reference, value_date FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT'
       AND reversed_by IS NULL AND value_date > $2::date ORDER BY value_date DESC LIMIT 1`, [loanId, asOf]);
  if (later) {
    throw err(`REPAYMENT_BEFORE_A_LATER_ONE: ${later.reference} is dated ${ymd(later.value_date)}; `
      + 'reverse it first or date this one on or after it', 409);
  }
}

async function repay(c, loanId, { amount, channelId = 'mpesa', valueDate, narration, createdBy, branchId: tellerBranch = null, allocationOrder = null, customAllocation = null, user = null, internal = false } = {}) {
  let l = await lock(c, loanId);
  const type = types.forLoan(l);
  // A locked loan takes repayments only from a user whose role may post on
  // locked accounts (the reference platform's permission); the loan stays locked.
  // A repayment the system makes under another permission (`internal`: a
  // pay-off checks it itself, securities collected before a write-off have
  // their own) is not held to it.
  if (l.status === 'LOCKED') { if (!internal) await controls.assertMayPostOnLocked(c, { user }); }
  else if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  let left = round2(amount);
  if (!(left > 0)) throw err('INVALID_REPAYMENT_AMOUNT');

  const ch = await channels.assertUsable(c, channelId, { side: 'LOAN', type: 'REPAYMENT', amount: left, productId: l.product_id, user });
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);

  const asOf = valueDate ? ymd(valueDate) : (await orgToday(c));
  // A staff user's repayment (the API, collection batches, pay-offs) is not dated in the future.
  if (user && asOf > await orgToday(c)) throw err('VALUE_DATE_IS_IN_THE_FUTURE: post on today or an earlier day', 400);
  // A past value date needs the backdating permission, as for deposit accounts.
  if (user && asOf < await orgToday(c) && !PERMS.can(user, 'BACKDATE_LOAN_TRANSACTIONS')) {
    throw err('PERMISSION_REQUIRED: BACKDATE_LOAN_TRANSACTIONS, to post with a past value date', 403);
  }
  await assertNoLaterRepayment(c, l.id, asOf);
  // A custom allocation needs the product to allow it and the user the
  // permission (the reference platform). A pay-off allocates its own amounts (`internal`).
  if (customAllocation !== null && customAllocation !== undefined && !internal) {
    if (l.allow_custom_allocation === false) throw err('PRODUCT_DOES_NOT_ALLOW_CUSTOM_REPAYMENT_ALLOCATION', 409);
    await controls.assertMayAllocateCustom(c, { user });
  }
  // A repayment dated before penalties already charged: the unpaid ones
  // after its date are taken back and worked out again up to its date on
  // what was owed then; after the payment, the days since are charged
  // again on what is still owed (the reference platform recomputes penalties on a
  // backdated transaction).
  const recharge = await penalties.reverseAfter(c, l.id, asOf, { createdBy, reason: `backdated repayment ${asOf}` });
  if (recharge.reversed.length) {
    await penalties.accrueForLoan(c, l.id, { asOf, createdBy });
    l = await lock(c, l.id);
  }
  // Interest owed is brought up to the payment date first, so a prepayment
  // on a dynamic loan pays the interest it has actually earned (the reference platform's
  // "apply interest on prepayments"); a capitalising product folds it into
  // principal at the same moment.
  l = await type.beforeRepayment(c, l, { asOf, createdBy }, core.ops);

  const b = balances(l);
  const due = { PENALTY: b.penalty, FEE: b.fees, INTEREST: b.interest, PRINCIPAL: b.principal };
  let paid = { PENALTY: 0, FEE: 0, INTEREST: 0, PRINCIPAL: 0 };
  // The product's allocation order, or one given for this repayment (the reference platform
  // allows a custom order on a single repayment through the API).
  if (allocationOrder !== null && allocationOrder !== undefined) {
    if (!Array.isArray(allocationOrder) || allocationOrder.length !== 4 || new Set(allocationOrder).size !== 4
      || allocationOrder.some((x) => !COMPONENTS.includes(x))) {
      throw err(`ALLOCATION_ORDER_LISTS_EACH_OF: ${COMPONENTS.join(', ')}`, 400);
    }
  }
  const order = allocationOrder || (Array.isArray(l.allocation_order) && l.allocation_order.length === 4
    ? l.allocation_order : COMPONENTS);

  // A product that does not accept prepayments takes no more than is due:
  // charges owed and the principal of installments fallen due.
  // A custom repayment: the items and amounts are the teller's.
  let nsPaid = 0;
  let custom = null;
  if (customAllocation !== null && customAllocation !== undefined) {
    custom = customPaid(customAllocation, left, { ...due, NON_SCHEDULED_FEE: b.nonScheduledFees });
    nsPaid = custom.NON_SCHEDULED_FEE;
  }
  if (l.allow_prepayments === false && !internal) {
    const { rows: [pd] } = await c.query(
      `SELECT COALESCE(sum(principal_due - principal_paid), 0) AS p FROM loan_installments
       WHERE loan_id = $1 AND due_date <= $2::date AND status NOT IN ('PAID', 'GRACE')`, [l.id, asOf]);
    const dueNow = round2(b.penalty + b.fees + b.interest + Math.min(Number(pd.p), b.principal));
    if (round2(left - nsPaid) > dueNow) throw err(`PREPAYMENT_NOT_ALLOWED: ${dueNow} is due`, 409);
  }

  if (custom) {
    paid = { PENALTY: custom.PENALTY, FEE: custom.FEE, INTEREST: custom.INTEREST, PRINCIPAL: custom.PRINCIPAL };
    left = 0;
  } else if (l.payment_method === 'HORIZONTAL') {
    ({ paid, left } = await horizontalAllocation(c, l, due, left, order));
  } else {
    for (const component of order) {
      const t = round2(Math.min(left, Math.max(0, due[component])));
      paid[component] = t;
      left = round2(left - t);
    }
  }
  // Interest taken in advance, where the product takes it.
  let prepaidInterest = 0;
  const pre = custom ? null : await prepayInterest(c, l, type, { interest: paid.INTEREST, pool: round2(paid.PRINCIPAL + left), asOf });
  if (pre) { prepaidInterest = pre.prepaid; paid.PRINCIPAL = pre.principal; left = pre.left; }
  const { PENALTY: penalty, FEE: feesPaid, INTEREST: interest, PRINCIPAL: principal } = paid;
  const surplus = round2(left);
  const total = round2(penalty + feesPaid + interest + principal + prepaidInterest + nsPaid + surplus);
  const finalPayment = round2(b.principal - principal) <= 0 && type.closesWhenPaid;

  // Where each component's money goes. On a funded loan the principal and
  // the funders' share of the interest go back to the funders' accounts;
  // the organisation keeps its commission, fees and penalties.
  // Fees are credited fee by fee, each to its own receivable (or income,
  // under cash), in the order fees.settle will mark them paid.
  const credits = [];
  let distributed = null;
  const feeCredits = await fees.settlementCredits(c, l, feesPaid);
  if (await funding.isFunded(c, l.id)) {
    distributed = await funding.distribute(c, l, { principal, interest, date: asOf, createdBy, finalPayment });
    credits.push(...distributed.credits);
    credits.push(...creditsFor(l, 'INTEREST', distributed.orgInterest, l.member_id));
    credits.push(...feeCredits);
    credits.push(...creditsFor(l, 'PENALTY', penalty, l.member_id));
  } else {
    for (const component of order) {
      if (component === 'FEE') credits.push(...feeCredits);
      else credits.push(...creditsFor(l, component, paid[component], l.member_id));
    }
  }
  if (prepaidInterest > 0) credits.push({ glCode: l.gl_deferred_interest, amount: prepaidInterest, memberId: l.member_id });
  if (nsPaid > 0) credits.push(...await fees.settlementCredits(c, l, nsPaid, { nonScheduled: true }));

  // A surplus is the member's money: on a revolving loan with a credit
  // balance it stays on the loan for the next drawdown; otherwise it goes to
  // their savings rather than sitting as an unexplained credit.
  let surplusAccount = null;
  const surplusCredits = [];
  let toCreditBalance = 0;
  if (surplus > 0) {
    if (type.surplusToCreditBalance(l)) {
      if (l.max_credit_balance !== null && round2(l.credit_balance) + surplus > Number(l.max_credit_balance)) {
        throw err(`OVERPAYMENT_EXCEEDS_MAX_CREDIT_BALANCE: ${l.max_credit_balance}`, 409);
      }
      toCreditBalance = surplus;
      credits.push({ glCode: l.gl_credit_balance, amount: surplus, memberId: l.member_id });
    } else {
      const { rows } = await c.query(
        `SELECT a.id FROM savings_accounts a
         JOIN savings_products p ON p.id = a.product_id
         WHERE a.member_id = $1 AND a.status = 'ACTIVE' AND NOT p.is_funding_account ORDER BY a.opened_on LIMIT 1`,
        [l.member_id]
      );
      if (!rows.length) throw err('OVERPAYMENT_WITH_NO_SAVINGS_ACCOUNT_TO_RECEIVE_IT', 409);
      // The surplus lands in savings as a deposit would: it clears any
      // overdraft first, and follows the deposit product's own accounting.
      surplusAccount = await savings.lock(c, rows[0].id);
      surplusAccount.legs = savings.inLegs(surplusAccount, surplus);
      surplusCredits.push(...(savings.books(surplusAccount) ? surplusAccount.legs.credits
        : [{ glCode: await PA.suspense(c), amount: surplus, memberId: l.member_id, branchId: surplusAccount.branch_id }]));
      if (booksEntries(l)) credits.push(...surplusCredits);
    }
  }

  // Under NONE the loan's own accounts are not touched, but the cash is
  // real: the channel is booked against suspense, and the funders' and the
  // savings surplus legs are booked as they are.
  const cashLeg = { glCode: ch.gl_account_code, amount: total, memberId: l.member_id, branchId: tellerBranch || l.branch_id };
  const repayEntry = {
    debits: [cashLeg], credits: credits.filter((x) => x.amount > 0),
    narration: narration || `Repayment ${l.account_no}`,
    sourceType: 'LOAN_REPAYMENT', sourceId: l.id, channelId,
    bookingDate: asOf, createdBy,
  };
  const entryId = booksEntries(l)
    ? await post(c, l, repayEntry)
    : await core.postUnlinked(c, l, repayEntry, { cash: cashLeg, extra: [...(distributed ? distributed.credits : []), ...surplusCredits] });

  // Interest from arrears is part of the interest and is paid first
  // (The reference platform): the interest this payment settles goes to it before the rest.
  const fromArrears = round2(Math.max(0, Math.min(interest, Number(l.interest_from_arrears_accrued || 0) - Number(l.interest_from_arrears_paid || 0))));
  await c.query(
    `UPDATE loan_accounts SET
       penalty_paid = penalty_paid + $1, fees_paid = fees_paid + $2,
       interest_paid = interest_paid + $3, principal_paid = principal_paid + $4,
       credit_balance = credit_balance + $6, interest_prepaid = interest_prepaid + $7, ns_fees_paid = ns_fees_paid + $8,
       interest_from_arrears_paid = interest_from_arrears_paid + $9,
       updated_at = now()
     WHERE id = $5`,
    [penalty, feesPaid, interest, principal, l.id, toCreditBalance, prepaidInterest, nsPaid, fromArrears]
  );
  if (surplusAccount) {
    await c.query(
      `UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3
       WHERE id = $4`, [surplus, surplusAccount.legs.allocation.odFees, surplusAccount.legs.allocation.odInterest, surplusAccount.id]);
  }

  // A fixed-term loan's payment settles its installments in order, however
  // early it comes. A dynamic loan's payment settles what has fallen due and
  // anything beyond that is a prepayment: it reduces the balance, and the
  // schedule for what remains is redrawn from that balance. A revolving
  // loan's installments only exist once due, so all of them take a share.
  await applyToInstallments(c, l.id, { principal, interest: round2(interest + prepaidInterest), fees: feesPaid }, type.installmentScope(asOf, l));
  if (l.mark_paid_when === 'PRINCIPAL_EXPECTED' && type.basis === 'ACTUAL_BALANCE') await markPaidOnPrincipal(c, l.id, asOf);
  await fees.settle(c, l.id, feesPaid);
  if (nsPaid > 0) await fees.settle(c, l.id, nsPaid, { nonScheduled: true });

  const fresh = await lock(c, l.id);
  const after = balances(fresh);
  let rescheduled = null;
  if (after.total <= 0 && type.closesWhenPaid) {
    // Interest still held in advance was paid under the contract, and fee
    // income still deferred is recognised (the reference platform: at pay-off).
    await recognisePrepaidInterest(c, l.id, { valueDate: asOf, createdBy });
    await FA.recogniseRemaining(c, l.id, { date: asOf, createdBy });
    await c.query("UPDATE loan_accounts SET status = 'CLOSED_REPAID', closed_on = $2::date, updated_at = now() WHERE id = $1", [l.id, asOf]);
    await workflow.history(c, l.id, { from: fresh.status, to: 'CLOSED_REPAID', action: 'PAID_OFF', actor: createdBy });
    await workflow.closeSecurities(c, l.id, { how: 'PAID' });
  } else if (fresh.status === 'IN_ARREARS') {
    await workflow.refreshArrears(c, fresh, asOf);
  }
  rescheduled = await type.afterRepayment(c, fresh, { asOf, principal, interest, createdBy }, core.ops);
  if (recharge.reversed.length) await penalties.accrueForLoan(c, l.id, { asOf: recharge.through, createdBy });

  return savings.record(c, {
    reference: savings.ref('LR'), kind: 'LOAN_REPAYMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: total, valueDate: asOf, entryId,
    allocation: {
      penalty, fees: feesPaid, interest, principal, surplus,
      ...(prepaidInterest > 0 ? { prepaidInterest } : {}),
      ...(fromArrears > 0 ? { interestFromArrears: fromArrears } : {}),
      ...(nsPaid > 0 ? { nonScheduledFees: nsPaid } : {}),
      ...(custom ? { custom: true } : {}),
      ...(toCreditBalance > 0 ? { creditBalance: toCreditBalance } : {}),
      ...(distributed ? { funding: distributed.allocation, orgInterest: distributed.orgInterest } : {}),
      ...(rescheduled ? { rescheduled: { recalculation: rescheduled.recalculation, dropped: rescheduled.dropped } } : {}),
    },
    narration, createdBy,
  });
}

Object.assign(module.exports, {
  COMPONENTS, horizontalAllocation, prepayInterest, CUSTOM_ITEMS, customPaid, assertNoLaterRepayment, repay,
});
