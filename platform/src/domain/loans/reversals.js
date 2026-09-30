'use strict';

/**
 * Loan accounts: reversing a disbursement, repayment or other loan transaction.
 */

const { orgToday } = require('../../lib/orgDate');
const acct = require('../accounting');
const savings = require('../savings');
const S = require('../schedule');
const ledger = require('../ledger');
const funding = require('../funding');
const workflow = require('../workflow');
const fees = require('../fees');
const installments = require('../installments');
const types = require('../productTypes');
const writeOffs = require('../writeOffs');
const penalties = require('../penalties');
const FA = require('../feeAmortization');
const { err, round2 } = acct;
const { ymd } = S;
const { lock, post, creditsFor } = ledger;
const { buildSchedule, reschedule, applyToInstallments } = installments;

/**
 * Undo the interest a repayment took in advance. What is still held comes
 * off the deferred account with the repayment's own entry; what has been
 * earned since (settled from it, or recognised when the loan closed) is
 * owed again, so it is moved back: Dr the account the settlement credited,
 * Cr Deferred Interest.
 */
async function unwindPrepaidInterest(c, tx, amount, { narration, createdBy }) {
  let l = await lock(c, tx.loan_account_id);
  // Recognised at closure by this payment: take that recognition back first.
  const { rows: closure } = await c.query(
    `SELECT * FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_INTEREST_ACCRUAL' AND reversed_by IS NULL
       AND allocation->>'method' = 'PREPAID_AT_CLOSURE' AND created_at >= $2 ORDER BY created_at`, [l.id, tx.created_at]);
  for (const r of closure) {
    const amt = Number(r.amount);
    const taxed = Number(r.allocation?.tax || 0);
    if (r.entry_id) await acct.reverse(c, r.entry_id, narration, createdBy);
    await c.query(
      `UPDATE loan_accounts SET interest_accrued = interest_accrued - $1, interest_paid = interest_paid - $1,
         tax_charged = tax_charged - $3, interest_prepaid = interest_prepaid + $1 WHERE id = $2`, [amt, l.id, taxed]);
    const rev = await savings.record(c, {
      reference: savings.ref('REV'), kind: 'REVERSAL', memberId: r.member_id, loanAccountId: l.id, amount: -amt,
      allocation: { reversalOf: r.reference }, narration, createdBy,
    });
    await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, r.id]);
  }
  l = await lock(c, l.id);
  const held = round2(Math.min(Number(l.interest_prepaid), amount));
  const earned = round2(amount - held);
  await c.query('UPDATE loan_accounts SET interest_prepaid = interest_prepaid - $1, interest_paid = interest_paid - $2 WHERE id = $3',
    [held, earned, l.id]);
  if (earned > 0) {
    await post(c, l, {
      debits: creditsFor(l, 'INTEREST', earned, l.member_id),
      credits: [{ glCode: l.gl_deferred_interest, amount: earned, memberId: l.member_id }],
      narration: `${narration}: prepaid interest earned since ${tx.reference}`,
      sourceType: 'LOAN_PREPAID_INTEREST', sourceId: l.id, bookingDate: (await orgToday(c)), createdBy,
    });
  }
}

async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy } = {}) {
  const { rows } = await c.query('SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]);
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.loan_account_id) throw err('NOT_A_LOAN_TRANSACTION');
  if (tx.kind === 'LOAN_WRITE_OFF' || tx.kind === 'LOAN_RECOVERY') return writeOffs.reverse(c, tx, { narration, createdBy });
  if (!['LOAN_REPAYMENT', 'LOAN_DISBURSEMENT'].includes(tx.kind)) throw err(`CANNOT_REVERSE_${tx.kind}`, 409);
  if (tx.kind === 'LOAN_REPAYMENT') {
    // Repayments come off newest first (the reference platform reverts the last repayment):
    // reversing an earlier one would reallocate the later ones silently.
    const { rows: [later] } = await c.query(
      `SELECT reference FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT' AND reversed_by IS NULL AND id <> $2
         AND (value_date > $3::date OR (value_date = $3::date AND created_at > $4))
       ORDER BY value_date DESC, created_at DESC LIMIT 1`, [tx.loan_account_id, tx.id, tx.value_date, tx.created_at]);
    if (later) throw err(`REVERSE_THE_LATER_REPAYMENT_FIRST: ${later.reference}`, 409);
    const { rows: [t] } = await c.query('SELECT terminated_on FROM loan_accounts WHERE id = $1', [tx.loan_account_id]);
    if (t?.terminated_on && ymd(tx.value_date) < ymd(t.terminated_on)) {
      throw err(`UNDO_THE_TERMINATION_FIRST: the loan was terminated on ${ymd(t.terminated_on)}, after this repayment`, 409);
    }
  }
  // A transfer from or to a deposit account: the deposit side is reversed
  // with it. For a disbursement into a deposit account that comes first, so
  // money the member has already taken out stops the reversal.
  const linked = a0(tx).transfer?.savingsReference || null;
  if (linked && tx.kind === 'LOAN_DISBURSEMENT') await savings.reverseTransaction(c, linked, { narration, createdBy, linked: true });

  const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
  const a = tx.allocation || {};

  if (tx.kind === 'LOAN_REPAYMENT') {
    if (a.prepaidInterest > 0) await unwindPrepaidInterest(c, tx, a.prepaidInterest, { narration, createdBy });
    if (a.interestFromArrears > 0) {
      await c.query('UPDATE loan_accounts SET interest_from_arrears_paid = GREATEST(0, interest_from_arrears_paid - $1) WHERE id = $2',
        [a.interestFromArrears, tx.loan_account_id]);
    }
    // A payment that closed the loan: the fee income its closure recognised goes back to deferred.
    const { rows: [was] } = await c.query('SELECT status FROM loan_accounts WHERE id = $1', [tx.loan_account_id]);
    if (was.status === 'CLOSED_REPAID') await FA.undoClosure(c, tx.loan_account_id, { createdBy, narration });
    if (a.nonScheduledFees > 0) {
      await c.query('UPDATE loan_accounts SET ns_fees_paid = ns_fees_paid - $1 WHERE id = $2', [a.nonScheduledFees, tx.loan_account_id]);
      const { rows: [ns] } = await c.query(
        `SELECT COALESCE(SUM((allocation->>'nonScheduledFees')::numeric), 0) AS n FROM transactions
         WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT' AND reversed_by IS NULL AND id <> $2`, [tx.loan_account_id, tx.id]);
      await fees.resettle(c, tx.loan_account_id, Number(ns.n), { nonScheduled: true });
    }
    await c.query(
      `UPDATE loan_accounts SET
         penalty_paid = penalty_paid - $1, fees_paid = fees_paid - $2,
         interest_paid = interest_paid - $3, principal_paid = principal_paid - $4,
         status = CASE WHEN status = 'CLOSED_REPAID' THEN 'ACTIVE' ELSE status END,
         closed_on = CASE WHEN status = 'CLOSED_REPAID' THEN NULL ELSE closed_on END,
         updated_at = now()
       WHERE id = $5`,
      [a.penalty || 0, a.fees || 0, a.interest || 0, a.principal || 0, tx.loan_account_id]
    );
    if (a.creditBalance > 0) {
      await c.query('UPDATE loan_accounts SET credit_balance = credit_balance - $1 WHERE id = $2', [a.creditBalance, tx.loan_account_id]);
    } else if (a.surplus > 0) {
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1
         WHERE member_id = $2 AND status = 'ACTIVE'
           AND id = (SELECT a.id FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
                     WHERE a.member_id = $2 AND a.status = 'ACTIVE' AND NOT p.is_funding_account ORDER BY a.opened_on LIMIT 1)`,
        [a.surplus, tx.member_id]
      );
    }
    if (a.funding) {
      await funding.undistribute(c, { id: tx.loan_account_id }, a.funding, { date: (await orgToday(c)), createdBy });
    }
    // Rebuild installment allocation from what survives. A dynamic loan's
    // schedule may have been redrawn by the payment being reversed, so it
    // goes back to the schedule it was disbursed with and is redrawn from
    // the balance as it now stands.
    const restored = await lock(c, tx.loan_account_id);
    const type = types.forLoan(restored);
    if (type.redrawsOnReversal) await buildSchedule(c, restored);
    await c.query(
      `UPDATE loan_installments SET principal_paid = 0, interest_paid = 0, fee_paid = 0,
         status = CASE WHEN status = 'GRACE' THEN 'GRACE' ELSE 'PENDING' END
       WHERE loan_id = $1`, [tx.loan_account_id]
    );
    const { rows: remaining } = await c.query(
      `SELECT COALESCE(SUM((allocation->>'principal')::numeric),0) AS p,
              COALESCE(SUM((allocation->>'interest')::numeric),0)
                + COALESCE(SUM((allocation->>'prepaidInterest')::numeric),0) AS i,
              COALESCE(SUM((allocation->>'fees')::numeric),0)      AS f
       FROM transactions
       WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT'
         AND reversed_by IS NULL AND id <> $2`,
      [tx.loan_account_id, tx.id]
    );
    const today = await orgToday(c);
    await applyToInstallments(c, tx.loan_account_id, {
      principal: Number(remaining[0].p), interest: Number(remaining[0].i), fees: Number(remaining[0].f),
    }, type.installmentScope(today, restored));
    await fees.resettle(c, tx.loan_account_id, Number(remaining[0].f));
    if (type.redrawsOnReversal) await reschedule(c, await lock(c, tx.loan_account_id), today);
    // Penalties charged after the payment's date on what it had paid are
    // worked out again now that it is owed.
    const valueOn = S.ymd(tx.value_date);
    const recharge = await penalties.reverseAfter(c, tx.loan_account_id, valueOn, { createdBy, reason: `reversal of ${tx.reference}` });
    const through = recharge.through;
    if (through && through > valueOn) {
      if (recharge.reversed.length) await penalties.accrueForLoan(c, tx.loan_account_id, { asOf: valueOn, createdBy });
      await penalties.accrueForLoan(c, tx.loan_account_id, { asOf: through, createdBy });
    }
  } else if (tx.kind === 'LOAN_DISBURSEMENT') {
    const { rows: [cur] } = await c.query('SELECT * FROM loan_accounts WHERE id = $1 FOR UPDATE', [tx.loan_account_id]);
    if (round2(cur.principal_disbursed) !== round2(tx.amount) || Number(cur.principal_paid) > 0) {
      throw err('DISBURSEMENT_REVERSAL_ONLY_FOR_A_SINGLE_UNPAID_DISBURSEMENT', 409);
    }
    await c.query(
      `UPDATE loan_accounts SET principal_disbursed = principal_disbursed - $1,
         principal_capitalized = 0, interest_accrued = 0, interest_accrual_carry = 0, tax_charged = 0, accrued_through = NULL,
         credit_balance = credit_balance + $3, next_billing_on = NULL,
         status = 'APPROVED', disbursed_on = NULL, disbursed_by = NULL, updated_at = now() WHERE id = $2`,
      [tx.amount, tx.loan_account_id, a.fromCreditBalance || 0]
    );
    // Funders get their money back and their pledges stand again.
    const { rows: funders } = await c.query("SELECT * FROM loan_funding_sources WHERE loan_id = $1 AND status = 'FUNDED'", [tx.loan_account_id]);
    for (const f of funders) {
      await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [f.amount, f.savings_account_id]);
      await c.query("UPDATE loan_funding_sources SET status = 'PLEDGED', funded_at = NULL WHERE id = $1", [f.id]);
    }
    await c.query("UPDATE loan_tranches SET status = 'PLANNED', disbursed_on = NULL, disbursed_amount = NULL, transaction_id = NULL WHERE loan_id = $1 AND status = 'DISBURSED'", [tx.loan_account_id]);
    await fees.undoDisbursementFees(c, tx.loan_account_id, { createdBy });
    await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [tx.loan_account_id]);
    await workflow.history(c, tx.loan_account_id, { from: 'ACTIVE', to: 'APPROVED', action: 'UNDO_DISBURSE', actor: createdBy, note: narration });
  }

  if (linked && tx.kind === 'LOAN_REPAYMENT') await savings.reverseTransaction(c, linked, { narration, createdBy, linked: true });

  const rev = await savings.record(c, {
    reference: savings.ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    loanAccountId: tx.loan_account_id, amount: -tx.amount, entryId: entry.entryId,
    allocation: { reversalOf: tx.reference, ...(linked ? { alsoReversed: linked } : {}) }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}
const a0 = (tx) => tx.allocation || {};

Object.assign(module.exports, {
  unwindPrepaidInterest, reverseTransaction, a0,
});
