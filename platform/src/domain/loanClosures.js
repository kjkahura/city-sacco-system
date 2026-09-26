'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const savings = require('./savings');
const ledger = require('./ledger');
const types = require('./productTypes');
const workflow = require('./workflow');
const controls = require('./controls');
const eligibility = require('./eligibility');
const securities = require('./securities');
const fees = require('./fees');
const penalties = require('./penalties');
const funding = require('./funding');
const writeOffs = require('./writeOffs');
const loans = require('./loans');
const { err, round2 } = acct;
const { ymd, isoDate } = S;

/**
 * Pay-off and terminate, after Mambu's "Loan Account Life Cycle and States".
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
 * termination date. The installments not yet due are replaced by one due
 * that day carrying all the principal still to come, the interest earned to
 * the day and the fees already applied to them; installments already due
 * stay as they are. The loan keeps its state and every running-loan rule
 * (repayments, arrears from the next day, penalties, interest where it
 * accrues on the balance): Terminated is recorded as a sub-state
 * (terminated_on). Undo Terminate puts the schedule back as it was, while
 * no repayment has been posted since. Mambu offers termination for dynamic
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
    await eligibility.releaseGuarantors(c, l.id);
    await securities.onClose(c, l.id);
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
  const sum = (xs, k) => round2(xs.reduce((a, x) => a + Number(x[k]), 0));
  const keptInterestUnpaid = round2(kept.reduce((a, x) => a + Math.max(0, Number(x.interest_due) - Number(x.interest_paid)), 0));
  // Of the fees on the installments to come, only those already applied
  // (a fee row on them); a dynamic loan's payment-due fee not yet applied
  // is not owed and does not come forward.
  const ids = future.map((i) => i.id);
  const { rows: links } = await c.query('SELECT id, installment_id, amount, paid FROM loan_fees WHERE installment_id = ANY($1::uuid[])', [ids]);
  const appliedFees = round2(links.reduce((a, f) => a + Number(f.amount), 0));
  const feesDue = round2(Math.min(sum(future, 'fee_due'), appliedFees));
  const line = {
    principal_due: sum(future, 'principal_due'),
    principal_paid: sum(future, 'principal_paid'),
    interest_paid: sum(future, 'interest_paid'),
    interest_due: round2(sum(future, 'interest_paid') + Math.max(0, b.interest - keptInterestUnpaid)),
    fee_paid: sum(future, 'fee_paid'),
    fee_due: round2(Math.max(feesDue, sum(future, 'fee_paid'))),
  };
  const number = Math.min(...future.map((i) => i.number));
  const settledNow = line.principal_paid >= line.principal_due && line.interest_paid >= line.interest_due && line.fee_paid >= line.fee_due;

  // Keep what is replaced, then replace it.
  const snapshot = { date, installments: future, feeLinks: links.map((f) => ({ id: f.id, installmentId: f.installment_id })), termMonths: l.term_months };
  await c.query('UPDATE loan_fees SET installment_id = NULL WHERE installment_id = ANY($1::uuid[])', [ids]);
  await c.query('DELETE FROM loan_installments WHERE id = ANY($1::uuid[])', [ids]);
  const { rows: [inst] } = await c.query(
    `INSERT INTO loan_installments (loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due, principal_paid, interest_paid, fee_paid, status)
     VALUES ($1,$2,$3::date,$3::date,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [l.id, number, date, line.principal_due, line.interest_due, line.fee_due, line.principal_paid, line.interest_paid, line.fee_paid,
      settledNow ? 'PAID' : (line.principal_paid > 0 || line.interest_paid > 0 ? 'PARTIALLY_PAID' : 'PENDING')]);
  await c.query('UPDATE loan_fees SET installment_id = $1 WHERE id = ANY($2::uuid[])', [inst.id, links.map((f) => f.id)]);
  await c.query(
    'UPDATE loan_accounts SET terminated_on = $2::date, terminated_by = $3, termination = $4, updated_at = now() WHERE id = $1',
    [l.id, date, createdBy || 'SYSTEM', JSON.stringify(snapshot)]);
  await workflow.history(c, l.id, { from: l.status, to: l.status, action: 'TERMINATE', actor: createdBy, note: note || `all owed due ${date}` });
  const tx = await savings.record(c, {
    reference: savings.ref('LT'), kind: 'LOAN_TERMINATED', memberId: l.member_id, loanAccountId: l.id, amount: 0, valueDate: date,
    allocation: { principal: round2(line.principal_due - line.principal_paid), interest: round2(line.interest_due - line.interest_paid),
      fees: round2(line.fee_due - line.fee_paid), installment: number, replaced: future.length },
    narration: note, createdBy,
  });
  return { loanId: l.id, accountNo: l.account_no, terminatedOn: date, installment: inst, transaction: tx };
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

  const { rows: [inst] } = await c.query(
    'SELECT * FROM loan_installments WHERE loan_id = $1 AND due_date = $2::date ORDER BY number DESC LIMIT 1', [l.id, date]);
  // Penalties on the termination's installment are taken back (unpaid ones)
  // and detached from it; they are worked out again below.
  await penalties.reverseAfter(c, l.id, date, { createdBy, reason: 'termination undone' });
  if (inst) {
    await c.query('UPDATE penalty_charges SET installment_id = NULL WHERE installment_id = $1', [inst.id]);
    const { rows: stray } = await c.query('SELECT id FROM loan_fees WHERE installment_id = $1', [inst.id]);
    await c.query('UPDATE loan_fees SET installment_id = NULL WHERE installment_id = $1', [inst.id]);
    await c.query('DELETE FROM loan_installments WHERE id = $1', [inst.id]);
    snap.stray = stray.map((f) => f.id);
  }
  for (const i of snap.installments || []) {
    await c.query(
      `INSERT INTO loan_installments (id, loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due,
         principal_paid, interest_paid, fee_paid, status, payment_holiday, holiday_kind, holiday_interest)
       VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [i.id, l.id, i.number, ymd(i.due_date), ymd(i.nominal_due), i.principal_due, i.interest_due, i.fee_due,
        i.principal_paid, i.interest_paid, i.fee_paid, i.status, Boolean(i.payment_holiday), i.holiday_kind || null, i.holiday_interest || null]);
  }
  for (const f of snap.feeLinks || []) await c.query('UPDATE loan_fees SET installment_id = $1 WHERE id = $2', [f.installmentId, f.id]);
  // Fees applied to the termination's installment since (a late fee) go on
  // the first installment put back.
  if ((snap.stray || []).length && (snap.installments || []).length) {
    const first = snap.installments.reduce((a, x) => (x.number < a.number ? x : a));
    const { rows: moved } = await c.query(
      `UPDATE loan_fees SET installment_id = $1 WHERE id = ANY($2::uuid[]) AND NOT (id = ANY($3::uuid[])) RETURNING amount`,
      [first.id, snap.stray, (snap.feeLinks || []).map((f) => f.id)]);
    const add = round2(moved.reduce((a, f) => a + Number(f.amount), 0));
    if (add > 0) await c.query('UPDATE loan_installments SET fee_due = fee_due + $1 WHERE id = $2', [add, first.id]);
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

module.exports = { payOffQuote, payOff, terminate, undoTerminate };
