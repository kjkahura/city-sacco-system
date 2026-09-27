'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const savings = require('./savings');
const ledger = require('./ledger');
const types = require('./productTypes');
const workflow = require('./workflow');
const controls = require('./controls');
const fees = require('./fees');
const penalties = require('./penalties');
const funding = require('./funding');
const writeOffs = require('./writeOffs');
const loans = require('./loans');
const transfers = require('./loanTransfers');
const { err, round2 } = acct;
const { ymd, isoDate } = S;

/**
 * Pay-off and terminate, after the reference platform's "Loan Account Life Cycle and States".
 *
 * PAY-OFF (Close > Pay-off): the member pays the whole loan early and it
 * closes as Closed (all obligations met). What they pay is the principal
 * outstanding and, of the interest, fees and penalties owed on the day, as
 * much as the SACCO collects; the rest is written off (./writeOffs
 * writeOffCharges, Dr write-off expense, Cr the receivables). Interest is
 * brought to the day first on a loan that earns it on its balance. The
 * payment is one repayment through the channel, allocated to exactly those
 * amounts, and follows every repayment rule (dated no earlier than the last
 * repayment, the locked-loan permission). A revolving loan, which does not
 * close itself when paid, is closed by the pay-off.
 *
 * TERMINATE (Close > Terminate): everything owed falls due on the
 * termination date. Every installment not yet due stays, with its
 * principal, and falls due that day (the reference platform); the interest earned to the day
 * goes on the first of them, and of their fees only those already applied
 * stay owed. Installments already due stay as they are. The loan keeps its state and every running-loan rule
 * (repayments, arrears from the next day, penalties, interest where it
 * accrues on the balance): Terminated is recorded as a sub-state
 * (terminated_on). Undo Terminate puts the schedule back as it was, while
 * no repayment has been posted since. The reference platform offers termination for dynamic
 * loans; here it is open to any loan with a schedule drawn up front
 * (fixed and dynamic term, interest-free), not revolving, tranched or funded
 * loans.
 *
 * This module stands above ./loans, like ./restructure.
 */

const today = () => isoDate(new Date());
const RUNNING = ['ACTIVE', 'IN_ARREARS', 'LOCKED'];

// --------------------------------------------------------------------------
// Pay-off
// --------------------------------------------------------------------------

/** Interest and payment-due fees brought to `date`, as a repayment would. */
async function bringToDate(c, l, date, createdBy) {
  const type = types.forLoan(l);
  if (l.status !== 'LOCKED') {
    if (type.bringsInterestToDate && l.prepayment_interest !== 'MANUAL') await loans.accrueInterest(c, l.id, { valueDate: date, createdBy });
    if (type.paymentDueFeesByCalendar) await fees.applyPaymentDueFees(c, await ledger.lock(c, l.id), date);
  }
  return ledger.lock(c, l.id);
}

function owed(l) {
  const b = ledger.balances(l);
  return {
    principal: Math.max(0, b.principal),
    interest: Math.max(0, b.interest),
    fees: round2(Math.max(0, b.fees) + Math.max(0, b.nonScheduledFees)),
    scheduledFees: Math.max(0, b.fees),
    nonScheduledFees: Math.max(0, b.nonScheduledFees),
    penalty: Math.max(0, b.penalty),
  };
}

/**
 * What paying the loan off on `valueDate` costs. Worked out in a savepoint
 * that is rolled back, so the interest brought to the day is shown and not
 * booked.
 */
async function payOffQuote(c, loanId, { valueDate = null } = {}) {
  const date = valueDate ? ymd(valueDate) : today();
  await c.query('SAVEPOINT pay_off_quote');
  try {
    let l = await ledger.lock(c, loanId);
    if (!RUNNING.includes(l.status)) throw err(`LOAN_NOT_RUNNING: ${l.status}`, 409);
    // A date to come (the reference platform's pay-off preview for a future date): the
    // arrears and penalties the end of day would add by then, as well.
    if (date > today()) {
      await loans.accrueInterest(c, l.id, { valueDate: date, createdBy: 'QUOTE' });
      await workflow.markArrears(c, { asOf: date, loanId: l.id });
      await penalties.accrueForLoan(c, l.id, { asOf: date, createdBy: 'QUOTE' });
      l = await ledger.lock(c, l.id);
    }
    l = await bringToDate(c, l, date, 'QUOTE');
    const o = owed(l);
    return {
      loanId: l.id, accountNo: l.account_no, valueDate: date, ...o,
      total: round2(o.principal + o.interest + o.fees + o.penalty),
      creditBalance: Number(l.credit_balance || 0),
    };
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT pay_off_quote');
    await c.query('RELEASE SAVEPOINT pay_off_quote');
  }
}

/**
 * Pay the loan off. `interest`, `fees` and `penalty` are what is collected
 * of each (default: all of it); what is left of each is written off. The
 * principal is always paid in full.
 */
async function payOff(c, loanId, { channelId = 'cash', valueDate = null, interest = null, fees: feesPaid = null, penalty = null,
  note = null, createdBy, user = null } = {}) {
  let l = await ledger.lock(c, loanId);
  if (!RUNNING.includes(l.status)) throw err(`LOAN_NOT_RUNNING: ${l.status}`, 409);
  await controls.assertMayPayOff(c, { user });
  if (l.status === 'LOCKED') await controls.assertMayPostOnLocked(c, { user });
  const date = valueDate ? ymd(valueDate) : today();
  if (date > today()) throw err('PAY_OFF_CANNOT_BE_DATED_IN_THE_FUTURE', 400);
  await loans.assertNoLaterRepayment(c, l.id, date);
  if (Number(l.credit_balance) > 0) throw err(`LOAN_HAS_A_CREDIT_BALANCE: ${l.credit_balance}; it must be drawn or refunded first`, 409);
  // Penalties charged after a back date are worked out again to it first, as
  // a repayment on that date would.
  const recharge = await penalties.reverseAfter(c, l.id, date, { createdBy, reason: `pay-off ${date}` });
  if (recharge.reversed.length) await penalties.accrueForLoan(c, l.id, { asOf: date, createdBy });
  l = await bringToDate(c, await ledger.lock(c, l.id), date, createdBy);
  const o = owed(l);
  const take = (given, max, label) => {
    if (given === null || given === undefined || given === '') return max;
    const v = round2(given);
    if (!(v >= 0)) throw err(`PAY_OFF_AMOUNT_INVALID: ${label}`, 400);
    if (v > max) throw err(`PAY_OFF_AMOUNT_EXCEEDS_WHAT_IS_OWED: ${label} owes ${max}`, 400);
    return v;
  };
  const pay = { interest: take(interest, o.interest, 'interest'), fees: take(feesPaid, o.fees, 'fees'), penalty: take(penalty, o.penalty, 'penalty') };
  const writtenOff = { interest: round2(o.interest - pay.interest), fees: round2(o.fees - pay.fees), penalty: round2(o.penalty - pay.penalty) };

  let woTx = null;
  if (writtenOff.interest > 0 || writtenOff.fees > 0 || writtenOff.penalty > 0) {
    // Writing charges off is a loan adjustment (the reference platform's permission).
    await controls.assertMayAdjust(c, { user });
    woTx = await writeOffs.writeOffCharges(c, l.id, { ...writtenOff, kind: 'PAY_OFF', reason: note || 'pay-off', valueDate: date, createdBy });
    l = await ledger.lock(c, l.id);
  }
  // What is still owed after the write-off is exactly what is paid.
  const left = owed(l);
  const amount = round2(left.principal + left.interest + left.fees + left.penalty);
  let tx = null;
  if (amount > 0) {
    tx = await loans.repay(c, l.id, {
      amount, channelId, valueDate: date, narration: note || `Pay-off ${l.account_no}`, createdBy, user, internal: true,
      customAllocation: {
        principal: left.principal, interest: left.interest, fee: left.scheduledFees, nonScheduledFee: left.nonScheduledFees, penalty: left.penalty,
      },
    });
    await c.query(`UPDATE transactions SET allocation = allocation || $2::jsonb WHERE id = $1`,
      [tx.id, JSON.stringify({ payOff: true, writtenOff, writeOff: woTx?.reference || null })]);
  }
  l = await ledger.lock(c, l.id);
  // A loan that does not close itself when paid (revolving) is closed now;
  // one whose balance was all written off closes the same way.
  if (RUNNING.includes(l.status) && ledger.balances(l).total <= 0) {
    await c.query("UPDATE loan_accounts SET status = 'CLOSED_REPAID', closed_on = $2::date, locked_at = NULL, locked_reason = NULL, updated_at = now() WHERE id = $1", [l.id, date]);
    await workflow.history(c, l.id, { from: l.status, to: 'CLOSED_REPAID', action: 'PAID_OFF', actor: createdBy, note });
    await workflow.closeSecurities(c, l.id, { how: 'PAY_OFF' });
  } else if (RUNNING.includes(l.status)) {
    throw err(`PAY_OFF_LEFT_A_BALANCE: ${ledger.balances(l).total}`, 500);
  }
  const closed = await ledger.lock(c, l.id);
  return {
    loanId: closed.id, accountNo: closed.account_no, status: closed.status, valueDate: date,
    paid: { principal: o.principal, ...pay, total: amount }, writtenOff,
    transaction: tx, writeOff: woTx,
  };
}

// --------------------------------------------------------------------------
// Terminate
// --------------------------------------------------------------------------

async function assertTerminable(c, l) {
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_TERMINABLE: ${l.status}`, 409);
  if (l.terminated_on) throw err(`LOAN_ALREADY_TERMINATED: ${ymd(l.terminated_on)}`, 409);
  const type = types.forLoan(l);
  if (!type.schedulesUpfront || type.disbursesAgain || type.plansTranches) throw err('ONLY_A_LOAN_WITH_A_SCHEDULE_DRAWN_UP_FRONT_CAN_BE_TERMINATED', 409);
  if (await funding.isFunded(c, l.id)) throw err('A_FUNDED_LOAN_CANNOT_BE_TERMINATED', 409);
}

/** Everything owed falls due on `valueDate` (today by default). */
async function terminate(c, loanId, { valueDate = null, note = null, createdBy } = {}) {
  let l = await ledger.lock(c, loanId);
  await assertTerminable(c, l);
  const date = valueDate ? ymd(valueDate) : today();
  if (date > today()) throw err('TERMINATION_CANNOT_BE_DATED_IN_THE_FUTURE', 400);
  if (l.disbursed_on && date < ymd(l.disbursed_on)) throw err(`TERMINATION_BEFORE_DISBURSEMENT: ${ymd(l.disbursed_on)}`, 400);
  await loans.assertNoLaterRepayment(c, l.id, date);
  if (types.forLoan(l).bringsInterestToDate) {
    await loans.accrueInterest(c, l.id, { valueDate: date, createdBy });
    l = await ledger.lock(c, l.id);
  }
  const { rows } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [l.id]);
  const future = rows.filter((i) => ymd(i.due_date) > date && i.status !== 'PAID');
  if (!future.length) throw err('NOTHING_LEFT_TO_FALL_DUE: every installment is already due or paid', 409);
  const kept = rows.filter((i) => !future.includes(i));
  const b = ledger.balances(l);
  const keptInterestUnpaid = round2(kept.reduce((a, x) => a + Math.max(0, Number(x.interest_due) - Number(x.interest_paid)), 0));
  // Interest earned to the day and not yet on an installment already due
  // goes on the first installment brought forward; the others keep only
  // the interest already paid on them.
  const earned = Math.max(0, round2(b.interest - keptInterestUnpaid));
  // Of the fees on the installments to come, only those already applied
  // (a fee row on them) stay owed; a dynamic loan's payment-due fee not yet
  // applied is not owed and falls away.
  const ids = future.map((i) => i.id);
  const { rows: links } = await c.query('SELECT id, installment_id, amount, paid FROM loan_fees WHERE installment_id = ANY($1::uuid[])', [ids]);
  const applied = (id) => round2(links.filter((f) => f.installment_id === id).reduce((a, f) => a + Number(f.amount), 0));

  // Every installment to come stays, with its principal, and falls due on
  // the termination date (the reference platform). Keep what they were, then change them.
  const snapshot = { date, installments: future, feeLinks: links.map((f) => ({ id: f.id, installmentId: f.installment_id })), termMonths: l.term_months };
  const first = Math.min(...future.map((i) => i.number));
  const changed = [];
  let totals = { principal: 0, interest: 0, fees: 0 };
  for (const i of future) {
    const interestDue = round2(Number(i.interest_paid) + (i.number === first ? earned : 0));
    const feeDue = round2(Math.max(Number(i.fee_paid), Math.min(Number(i.fee_due), applied(i.id))));
    const paidUp = Number(i.principal_paid) >= Number(i.principal_due) && Number(i.interest_paid) >= interestDue && Number(i.fee_paid) >= feeDue;
    const started = Number(i.principal_paid) > 0 || Number(i.interest_paid) > 0 || Number(i.fee_paid) > 0;
    const { rows: [u] } = await c.query(
      `UPDATE loan_installments SET due_date = $2::date, nominal_due = $2::date, interest_due = $3, fee_due = $4, status = $5,
         holiday_interest = NULL WHERE id = $1 RETURNING *`,
      [i.id, date, interestDue, feeDue, paidUp ? 'PAID' : started ? 'PARTIALLY_PAID' : 'PENDING']);
    changed.push(u);
    totals = {
      principal: round2(totals.principal + Number(u.principal_due) - Number(u.principal_paid)),
      interest: round2(totals.interest + Number(u.interest_due) - Number(u.interest_paid)),
      fees: round2(totals.fees + Number(u.fee_due) - Number(u.fee_paid)),
    };
  }
  await c.query(
    'UPDATE loan_accounts SET terminated_on = $2::date, terminated_by = $3, termination = $4, updated_at = now() WHERE id = $1',
    [l.id, date, createdBy || 'SYSTEM', JSON.stringify(snapshot)]);
  await workflow.history(c, l.id, { from: l.status, to: l.status, action: 'TERMINATE', actor: createdBy, note: note || `all owed due ${date}` });
  const tx = await savings.record(c, {
    reference: savings.ref('LT'), kind: 'LOAN_TERMINATED', memberId: l.member_id, loanAccountId: l.id, amount: 0, valueDate: date,
    allocation: { ...totals, installments: changed.map((u) => u.number) },
    narration: note, createdBy,
  });
  return { loanId: l.id, accountNo: l.account_no, terminatedOn: date, installments: changed, transaction: tx };
}

/**
 * Undo Terminate: the schedule as it was before, while no repayment has
 * been posted since. Penalties charged on the installment the termination
 * made are worked out again on the schedule put back, as a reversal would.
 */
async function undoTerminate(c, loanId, { note = null, createdBy } = {}) {
  const l = await ledger.lock(c, loanId);
  if (!l.terminated_on) throw err('LOAN_IS_NOT_TERMINATED', 409);
  const snap = l.termination || {};
  const date = ymd(l.terminated_on);
  const { rows: [tt] } = await c.query(
    "SELECT * FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_TERMINATED' AND reversed_by IS NULL ORDER BY created_at DESC LIMIT 1", [l.id]);
  const { rows: [later] } = await c.query(
    `SELECT reference FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT' AND reversed_by IS NULL
       AND created_at > $2 LIMIT 1`, [l.id, tt ? tt.created_at : new Date(0)]);
  if (later) throw err(`REPAYMENT_SINCE_THE_TERMINATION: reverse ${later.reference} first`, 409);
  if (!['ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(l.status)) throw err(`LOAN_NOT_RUNNING: ${l.status}`, 409);

  // Penalties charged since on the installments brought forward are taken
  // back (unpaid ones); they are worked out again below.
  await penalties.reverseAfter(c, l.id, date, { createdBy, reason: 'termination undone' });
  const before = new Set((snap.feeLinks || []).map((f) => f.id));
  for (const i of snap.installments || []) {
    // A fee applied to it since the termination (a late fee) stays on it.
    const { rows: since } = await c.query('SELECT id, amount FROM loan_fees WHERE installment_id = $1', [i.id]);
    const added = round2(since.filter((f) => !before.has(f.id)).reduce((a, f) => a + Number(f.amount), 0));
    await c.query(
      `UPDATE loan_installments SET due_date = $2::date, nominal_due = $3::date, interest_due = $4, fee_due = $5, status = $6,
         holiday_interest = $7 WHERE id = $1`,
      [i.id, ymd(i.due_date), ymd(i.nominal_due || i.due_date), i.interest_due, round2(Number(i.fee_due) + added), i.status, i.holiday_interest ?? null]);
  }
  await c.query('UPDATE loan_accounts SET terminated_on = NULL, terminated_by = NULL, termination = NULL, updated_at = now() WHERE id = $1', [l.id]);
  let fresh = await ledger.lock(c, l.id);
  if (fresh.status === 'IN_ARREARS') await workflow.refreshArrears(c, fresh, today());
  await penalties.accrueForLoan(c, l.id, { asOf: today(), createdBy });
  await workflow.history(c, l.id, { from: l.status, to: (await ledger.lock(c, l.id)).status, action: 'UNDO_TERMINATE', actor: createdBy, note });
  if (tt) {
    const rev = await savings.record(c, {
      reference: savings.ref('REV'), kind: 'REVERSAL', memberId: l.member_id, loanAccountId: l.id, amount: 0,
      allocation: { reversalOf: tt.reference }, narration: note || 'Termination undone', createdBy,
    });
    await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tt.id]);
  }
  fresh = await ledger.lock(c, l.id);
  return { loanId: fresh.id, accountNo: fresh.account_no, status: fresh.status, restored: (snap.installments || []).length };
}

// --------------------------------------------------------------------------
// Collect securities, on a write-off
// --------------------------------------------------------------------------

/**
 * Take what each guarantor pledged from their deposits and repay the loan
 * with it (the reference platform's Collect Securities), before the rest is written off.
 * Each pledge is taken, up to what the loan still owes, from the
 * guarantor's deposit accounts in the order they were opened, beyond their
 * other pledges and each account's minimum balance; the deposits need not
 * be withdrawable. Each amount is a withdrawal from the deposit account and
 * a repayment of the loan through the transfer channel, linked to each
 * other, and counts as recovered on the pledge: a pledge taken in full is
 * RECOVERED, one taken in part stays pledged for the rest and is called by
 * the write-off. What the deposits cannot cover is left to the write-off.
 */
async function collectSecurities(c, loanId, { valueDate = null, createdBy, user = null } = {}) {
  const l = await ledger.lock(c, loanId);
  if (!RUNNING.includes(l.status)) throw err(`LOAN_NOT_RUNNING: ${l.status}`, 409);
  const date = valueDate ? ymd(valueDate) : today();
  const { rows: pledges } = await c.query(
    "SELECT * FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED' AND pledged_amount > recovered ORDER BY created_at, id", [l.id]);
  const out = [];
  for (const g of pledges) {
    let owedNow = ledger.balances(await ledger.lock(c, l.id)).total;
    if (!(owedNow > 0)) break;
    let pledgeLeft = round2(Number(g.pledged_amount) - Number(g.recovered));
    let want = round2(Math.min(pledgeLeft, owedNow));
    const { rows: accounts } = await c.query(
      `SELECT a.id FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
       WHERE a.member_id = $1 AND a.status = 'ACTIVE' AND NOT p.is_funding_account ORDER BY a.opened_on, a.id`, [g.member_id]);
    let taken = 0;
    const moves = [];
    for (const r of accounts) {
      if (!(want > 0)) break;
      const a = await savings.lock(c, r.id);
      const others = round2(await savings.pledgedAmount(c, g.member_id) - pledgeLeft);
      const take = round2(Math.min(want, savings.availableOf(a, Math.max(0, others))));
      if (!(take > 0)) continue;
      const savingsTx = await savings.withdraw(c, a.id, {
        amount: take, channelId: transfers.CHANNEL, valueDate: date, createdBy, offsetPledge: pledgeLeft,
        narration: `Security collected for loan ${l.account_no}`,
      });
      const loanTx = await loans.repay(c, l.id, {
        amount: take, channelId: transfers.CHANNEL, valueDate: date, createdBy, user, internal: true,
        narration: `Security collected from guarantor account ${a.account_no}`,
      });
      await c.query(
        `UPDATE loan_guarantors SET recovered = recovered + $1,
           status = CASE WHEN recovered + $1 >= pledged_amount THEN 'RECOVERED' ELSE status END WHERE id = $2`, [take, g.id]);
      await c.query('UPDATE transactions SET allocation = allocation || $2::jsonb WHERE id = $1',
        [loanTx.id, JSON.stringify({ securityCollected: { guarantorId: g.id, guarantorMemberId: g.member_id } })]);
      const linked = await transfers.link(c, loanTx, savingsTx);
      moves.push({ savingsAccountId: a.id, accountNo: a.account_no, amount: take,
        loanReference: linked.loanTransaction.reference, savingsReference: linked.savingsTransaction.reference });
      taken = round2(taken + take);
      want = round2(want - take);
      pledgeLeft = round2(pledgeLeft - take);
      const now = await ledger.lock(c, l.id);
      if (!RUNNING.includes(now.status)) break;
    }
    out.push({ guarantorId: g.id, memberId: g.member_id, pledged: Number(g.pledged_amount), collected: taken, moves });
    if (!RUNNING.includes((await ledger.lock(c, l.id)).status)) break;
  }
  return { loanId: l.id, valueDate: date, total: round2(out.reduce((a, x) => a + x.collected, 0)), guarantors: out };
}

/** A write-off request, with the securities collected first when asked (and permitted). */
async function requestWriteOff(c, loanId, { collectSecurities: collect = false, user = null, ...rest } = {}) {
  const yes = collect === true || collect === 'true';
  if (yes) await controls.assertMayCollectSecurities(c, { user });
  return writeOffs.requestWriteOff(c, loanId, { ...rest, user, collectSecurities: yes, beforeWriteOff: collectSecurities });
}

/** Approve the pending write-off; the securities are collected first if the request asked for it. */
async function approveWriteOff(c, loanId, { note = null, createdBy, user = null } = {}) {
  const { rows: [r] } = await c.query(
    `SELECT r.collect_securities FROM loan_write_off_requests r JOIN loan_accounts l ON l.id = r.loan_id
     WHERE (l.id::text = $1 OR l.account_no = $1) AND r.status = 'PENDING'`, [String(loanId)]);
  if (r?.collect_securities) await controls.assertMayCollectSecurities(c, { user });
  return writeOffs.decide(c, loanId, { approve: true, note, createdBy, user, beforeWriteOff: collectSecurities });
}

module.exports = { payOffQuote, payOff, terminate, undoTerminate, collectSecurities, requestWriteOff, approveWriteOff };
