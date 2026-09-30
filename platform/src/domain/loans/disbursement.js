'use strict';

/**
 * Loan accounts: disbursement.
 */

const { orgToday } = require('../../lib/orgDate');
const acct = require('../accounting');
const savings = require('../savings');
const S = require('../schedule');
const tax = require('../tax');
const ledger = require('../ledger');
const controls = require('../controls');
const channels = require('../channels');
const funding = require('../funding');
const eligibility = require('../eligibility');
const workflow = require('../workflow');
const fees = require('../fees');
const types = require('../productTypes');
const rates = require('../rates');
const CA = require('../creditArrangements');
const { err, round2 } = acct;
const { ymd, isoDate } = S;
const { within, lock, interestAccrues, booksEntries, post } = ledger;
const core = require('./core');

/**
 * Disburse an approved loan. Fees the product defines for disbursement are
 * settled here: deducted fees come out of what the member receives,
 * capitalised fees are added to what they repay, upfront fees become due.
 * The schedule is drawn on the resulting principal. Under ON_DISBURSEMENT
 * posting the schedule's whole interest is applied at once.
 */
async function disburse(c, loanId, { amount, channelId = null, valueDate, narration, createdBy, user = null, fees: selectedFees = [], tranche = null, branchId: tellerBranch = null, shiftAdjustableInterestPeriods, firstRepaymentDate = null, transfer = null } = {}) {
  let l = await lock(c, loanId);
  const type = types.forLoan(l);
  const first = l.status === 'APPROVED';
  const again = !first && ['ACTIVE', 'IN_ARREARS'].includes(l.status) && type.disbursesAgain;
  if (!first && !again) throw err(`LOAN_NOT_APPROVED: ${l.status}`, 409);
  // A top-up application pays out by settling the loan it refinances.
  if (l.refinance_of) throw err('TOP_UP_APPLICATION_DISBURSES_THROUGH_REFINANCE', 409);
  // The reference platform: a loan with offset is not disbursed without its offset account.
  if (l.offset_enabled && !l.settlement_account_id) throw err('MISSING_LINKED_OFFSET_ACCOUNT: link a deposit account first', 409);
  const date = valueDate ? ymd(valueDate) : (await orgToday(c));
  // The channel given, else the one in the disbursement details, else bank.
  channelId = channelId || (first && l.disbursement_channel_id) || 'bank';
  // The first repayment date: given now (which needs the Set Disbursement
  // Conditions permission, as changing the details does), else the one in
  // the disbursement details; either way after the disbursement date.
  if (first && firstRepaymentDate) {
    await controls.assertMaySetDisbursementConditions(c, { user });
    await c.query('UPDATE loan_accounts SET first_repayment_date = $2::date WHERE id = $1', [l.id, ymd(firstRepaymentDate)]);
    l = await lock(c, l.id);
  }
  // A member of a centre with a weekly meeting day repays on it: the first
  // repayment moves to the next meeting day on or after the date the
  // schedule would have given it (the reference platform's Weekly Meeting Day).
  if (first && !l.first_repayment_date && type.schedulesUpfront && !(Array.isArray(l.fixed_days_of_month) && l.fixed_days_of_month.length)) {
    const { rows: [ce] } = await c.query(
      "SELECT ce.meeting_day FROM members m JOIN centres ce ON ce.id = m.centre_id WHERE m.id = $1 AND ce.status = 'ACTIVE' AND ce.meeting_day IS NOT NULL",
      [l.member_id]);
    if (ce) {
      const inputs = ledger.scheduleInputs(l);
      let d = S.addDays(S.addInterval(date, inputs.interval, 1), inputs.firstOffsetDays || 0);
      while (d.getUTCDay() !== Number(ce.meeting_day)) d = S.addDays(d, 1);
      await c.query('UPDATE loan_accounts SET first_repayment_date = $2::date WHERE id = $1', [l.id, isoDate(d)]);
      l = await lock(c, l.id);
    }
  }
  if (first && l.first_repayment_date && ymd(l.first_repayment_date) <= date) {
    throw err(`FIRST_REPAYMENT_DATE_NOT_AFTER_DISBURSEMENT: ${ymd(l.first_repayment_date)}`, 409);
  }
  // An indexed or adjustable rate is set from its periods on the day.
  if (first && l.rate_plan) {
    await rates.start(c, l, { date, shift: shiftAdjustableInterestPeriods, createdBy });
    l = await lock(c, l.id);
  }

  // What may be paid out now: the product type says (the principal, the
  // next tranche, or a drawdown within the available limit).
  const { amount: amt, tranche: plannedTranche } = await type.disbursementAmount(c, l, { amount, tranche, date });
  await workflow.assertMayDisburse(c, l, { actor: createdBy, amount: amt, user });
  // The credit arrangement's state, dates and limit (../creditArrangements).
  await CA.onLoanDisburse(c, l, { amount: amt, date });
  // The required securities, checked again before the money leaves.
  if (first) await eligibility.assertCovered(c, l);

  // The channel's usage rights and loan constraints (../channels).
  const ch = await channels.assertUsable(c, channelId, { side: 'LOAN', type: 'DISBURSEMENT', amount: amt, productId: l.product_id, user });
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  // Disbursement fees: on the amount paid out now. Upfront fees (and the
  // legacy processing fee) are charged once, with the first payout.
  let plan = await fees.disbursementFees(c, l, { amount: amt, selected: selectedFees, later: !first });
  if (!first) {
    const items = plan.items.filter((x) => x.feeType !== 'DISBURSEMENT_UPFRONT');
    plan = { ...plan, items, upfront: 0 };
  }
  const paidOut = round2(amt - plan.deducted);
  if (!(paidOut > 0)) throw err('FEES_EXCEED_DISBURSEMENT', 400);

  // A revolving drawdown uses the member's credit balance first: their own
  // money back to them, no portfolio movement for that part.
  const fromCredit = type.fromCreditBalance(l, amt);
  const fromLoan = round2(amt - fromCredit);

  // A funded loan's principal is not the SACCO's: it leaves the funders'
  // accounts. Otherwise Dr Portfolio for what the member owes.
  const funded = await funding.fund(c, l, { amount: fromLoan, date, createdBy });
  const debits = [];
  if (funded) debits.push(...funded.debits);
  else if (fromLoan > 0) debits.push({ glCode: l.gl_portfolio, amount: fromLoan, memberId: l.member_id });
  if (plan.capitalized > 0) debits.push({ glCode: l.gl_portfolio, amount: plan.capitalized, memberId: l.member_id });
  if (fromCredit > 0) debits.push({ glCode: l.gl_credit_balance, amount: fromCredit, memberId: l.member_id });
  const credits = [{ glCode: ch.gl_account_code, amount: paidOut, memberId: l.member_id, branchId: tellerBranch || l.branch_id }];
  for (const f of plan.items.filter((x) => x.feeType === 'DISBURSEMENT_DEDUCTED' || x.feeType === 'DISBURSEMENT_CAPITALIZED')) {
    credits.push(...tax.incomeCredits(l, { income: f.net, tax: f.tax }, f.glIncome, l.member_id));
  }
  const entry = {
    debits, credits,
    narration: narration || `Disbursement ${l.account_no}${plannedTranche ? ` tranche ${plannedTranche.number}` : ''}`,
    sourceType: 'LOAN_DISBURSEMENT', sourceId: l.id, channelId,
    bookingDate: date, createdBy,
  };
  const entryId = booksEntries(l) ? await post(c, l, entry) : await core.postUnlinked(c, l, entry, { cash: credits[0], funded });

  const { rows } = await c.query(
    `UPDATE loan_accounts
     SET principal_disbursed = principal_disbursed + $1,
         principal_capitalized = principal_capitalized + $2,
         credit_balance = credit_balance - $6,
         status = CASE WHEN status = 'APPROVED' THEN 'ACTIVE' ELSE status END,
         disbursed_on = COALESCE(disbursed_on, $3::date),
         accrued_through = COALESCE(accrued_through, $3::date),
         disbursed_by = COALESCE(disbursed_by, $4),
         updated_at = now()
     WHERE id = $5 RETURNING *`,
    [fromLoan, plan.capitalized, date, createdBy || null, l.id, fromCredit]
  );
  if (first) await workflow.history(c, l.id, { from: 'APPROVED', to: 'ACTIVE', action: 'DISBURSE', actor: createdBy });

  for (const f of plan.items) {
    await fees.recordFee(c, l, { ...f, amount: f.net, valueDate: date, createdBy, settled: f.feeType !== 'DISBURSEMENT_UPFRONT' });
  }
  const fresh = { ...l, ...rows[0], _selectedFees: selectedFees };

  // The schedule, or its absence, is the product type's: drawn now, redrawn
  // for a later tranche, or none until the first billing date.
  const sched = await type.afterDisbursement(c, { l, fresh, first, date, plan, createdBy }, core.ops);
  await CA.afterLoanDisburse(c, l.id);
  // Disbursement fees whose income is amortised are planned on the schedule just drawn.
  await fees.planPending(c, fresh, { date, createdBy });

  if (sched && type.appliesInterestAtDisbursement(l) && sched.totals.interest > 0) {
    // The whole term's interest is applied on day one.
    const maturity = sched.installments[sched.installments.length - 1].nominalDue;
    const tx = tax.split(l, 'INTEREST', sched.totals.interest);
    await c.query(
      'UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, tax_charged = tax_charged + $4, accrued_through = $2::date WHERE id = $3',
      [tx.gross, maturity, l.id, tx.tax]);
    let ie = null;
    if (interestAccrues(l)) {
      ie = await post(c, l, {
        debits: [{ glCode: l.gl_interest_rec, amount: tx.gross, memberId: l.member_id }],
        credits: tax.incomeCredits(l, tx, l.gl_interest_inc, l.member_id),
        narration: `Interest applied at disbursement ${l.account_no}`,
        sourceType: 'LOAN_INTEREST_ACCRUAL', sourceId: l.id, bookingDate: date, createdBy,
      });
    }
    await savings.record(c, {
      reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
      loanAccountId: l.id, amount: tx.gross, valueDate: date, entryId: ie,
      allocation: { from: date, through: maturity, method: 'ON_DISBURSEMENT', tax: tx.tax }, createdBy,
    });
  }

  const record = await savings.record(c, {
    reference: savings.ref('LD'), kind: 'LOAN_DISBURSEMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: amt, valueDate: date,
    entryId, narration, createdBy,
    allocation: {
      paidOut, deducted: plan.deducted, capitalized: plan.capitalized, upfront: plan.upfront,
      ...(transfer ? { transfer } : {}),
      fromCreditBalance: fromCredit, tranche: plannedTranche ? plannedTranche.number : undefined,
      funded: funded ? funded.debits.map((d) => ({ glCode: d.glCode, amount: d.amount })) : undefined,
    },
  });
  await type.recordDisbursement(c, { tranche: plannedTranche, amount: amt, date, record });
  return record;
}

Object.assign(module.exports, {
  disburse,
});
