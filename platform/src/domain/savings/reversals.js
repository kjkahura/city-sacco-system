'use strict';

/**
 * Deposit accounts: reversing a transaction.
 */

const acct = require('../accounting');
const S = require('../schedule');
const { err, round2 } = acct;
const core = require('./core');
const interest = require('./interest');

// --------------------------------------------------------------------------
// Reversal
// --------------------------------------------------------------------------

const REVERSIBLE = ['SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER', 'SAVINGS_FEE', 'SAVINGS_SEIZURE',
  'SAVINGS_INTEREST_APPLIED', 'SAVINGS_WITHHOLDING_TAX'];

/** Refuse a reversal that would take an account without a technical overdraft below what it may owe. */
async function assertMayLower(c, id, amt) {
  const a = await core.lock(c, id);
  if (!a.allow_technical_overdraft && Number(a.balance) - amt < -Number(a.overdraft_limit || 0)) {
    throw err(`REVERSAL_WOULD_OVERDRAW: ${a.account_no} would go to ${round2(Number(a.balance) - amt)}`, 409);
  }
}

/**
 * Reverse a posted deposit transaction (the reference platform's Adjusting Transactions).
 * Never edits the original. The account must be open. A deposit,
 * withdrawal, transfer, fee or seizure dated after the last interest
 * application has the interest from its date priced again. Interest
 * applied goes back to accrued, with its withholding tax; only the latest
 * application is reversed. One half of a transfer with a loan (a repayment
 * from this account, a disbursement into it) is reversed with its loan
 * transaction, which reverses both; on its own (`linked` false) it is
 * refused.
 */
async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy, linked = false } = {}) {
  const { rows } = await c.query(
    'SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]
  );
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.savings_account_id) throw err('NOT_A_SAVINGS_TRANSACTION');
  if (!REVERSIBLE.includes(tx.kind)) throw err(`CANNOT_REVERSE_${tx.kind}`, 409);
  // The reference platform: reversals on offset deposit accounts are not supported.
  const { rows: [off] } = await c.query(
    `SELECT l.account_no FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
      WHERE l.settlement_account_id = ANY($1::uuid[]) AND p.offset_enabled AND l.status NOT LIKE 'CLOSED%' LIMIT 1`,
    [[tx.savings_account_id, tx.allocation?.toAccountId].filter(Boolean)]);
  if (off) throw err(`REVERSAL_NOT_SUPPORTED_ON_AN_OFFSET_ACCOUNT: the account offsets loan ${off.account_no}`, 409);
  if (tx.allocation?.loanTransfer && !linked) {
    throw err(`LINKED_TO_A_LOAN_TRANSACTION: reverse ${tx.allocation.loanTransfer.reference}, which reverses both`, 409);
  }
  // The reference platform: the account must be open to adjust its transactions.
  const { rows: closed } = await c.query("SELECT account_no FROM savings_accounts WHERE id = ANY($1::uuid[]) AND status = 'CLOSED'",
    [[tx.savings_account_id, tx.allocation?.toAccountId].filter(Boolean)]);
  if (closed.length) throw err(`ACCOUNT_IS_CLOSED: ${closed.map((r) => r.account_no).join(', ')}`, 409);

  const al = tx.allocation || {};
  const amt = Number(tx.amount);
  const day = tx.value_date ? S.ymd(tx.value_date) : null;
  const extra = [];

  if (tx.kind === 'SAVINGS_INTEREST_APPLIED') {
    const { rows: [later] } = await c.query(
      `SELECT reference FROM transactions WHERE savings_account_id = $1 AND kind = 'SAVINGS_INTEREST_APPLIED' AND reversed_by IS NULL
          AND id <> $2 AND (value_date > $3 OR (value_date = $3 AND created_at > $4)) LIMIT 1`,
      [tx.savings_account_id, tx.id, tx.value_date, tx.created_at]);
    if (later) throw err(`REVERSE_THE_LATEST_INTEREST_APPLICATION_FIRST: ${later.reference}`, 409);
    await assertMayLower(c, tx.savings_account_id, amt);
  } else if (['SAVINGS_DEPOSIT'].includes(tx.kind)) {
    await assertMayLower(c, tx.savings_account_id, amt);
  } else if (tx.kind === 'SAVINGS_TRANSFER' && al.toAccountId) {
    await assertMayLower(c, al.toAccountId, amt);
  }

  const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
  let repriced = null;

  if (tx.kind === 'SAVINGS_DEPOSIT') {
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2, od_interest_due = od_interest_due + $3
       WHERE id = $4`, [amt, al.odFees || 0, al.odInterest || 0, tx.savings_account_id]);
    repriced = await interest.repriceFrom(c, tx.savings_account_id, day, -amt, { createdBy });
  } else if (tx.kind === 'SAVINGS_WITHDRAWAL') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
    repriced = await interest.repriceFrom(c, tx.savings_account_id, day, amt, { createdBy });
  } else if (tx.kind === 'SAVINGS_FEE') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2 WHERE id = $3',
      [amt, al.odFeesDue || 0, tx.savings_account_id]);
    repriced = await interest.repriceFrom(c, tx.savings_account_id, day, amt, { createdBy });
  } else if (tx.kind === 'SAVINGS_TRANSFER') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
    repriced = await interest.repriceFrom(c, tx.savings_account_id, day, amt, { createdBy });
    if (al.toAccountId) {
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2, od_interest_due = od_interest_due + $3
         WHERE id = $4`, [amt, al.to?.odFees || 0, al.to?.odInterest || 0, al.toAccountId]);
      await interest.repriceFrom(c, al.toAccountId, day, -amt, { createdBy });
    }
  } else if (tx.kind === 'SAVINGS_SEIZURE') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
    await c.query("UPDATE savings_blocks SET seized = seized - $2, state = 'PENDING', closed_at = NULL WHERE id = $1", [al.blockId, amt]);
    repriced = await interest.repriceFrom(c, tx.savings_account_id, day, amt, { createdBy });
  } else if (tx.kind === 'SAVINGS_WITHHOLDING_TAX') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
  } else if (tx.kind === 'SAVINGS_INTEREST_APPLIED') {
    // The interest goes back to accrued (and booked, as far as it was), to be applied again.
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, interest_accrued = interest_accrued + $1, interest_booked = interest_booked + $2,
         od_fees_due = od_fees_due + $3, od_interest_due = od_interest_due + $4 WHERE id = $5`,
      [amt, Number(al.booked || 0), al.odFees || 0, al.odInterest || 0, tx.savings_account_id]);
    // Its withholding tax is reversed with it.
    const { rows: taxes } = await c.query(
      `SELECT reference FROM transactions WHERE savings_account_id = $1 AND kind = 'SAVINGS_WITHHOLDING_TAX' AND reversed_by IS NULL
          AND (allocation->>'interestReference' = $2 OR (allocation->>'interestReference' IS NULL AND value_date = $3 AND created_at >= $4))`,
      [tx.savings_account_id, tx.reference, tx.value_date, tx.created_at]);
    for (const t of taxes) extra.push(await reverseTransaction(c, t.reference, { narration, createdBy }));
    // The account's last application moves back when nothing else was applied that day.
    const { rows: [other] } = await c.query(
      `SELECT 1 FROM transactions WHERE savings_account_id = $1 AND value_date = $2 AND reversed_by IS NULL AND id <> $3
          AND kind IN ('SAVINGS_INTEREST_APPLIED', 'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED') LIMIT 1`,
      [tx.savings_account_id, tx.value_date, tx.id]);
    if (!other) {
      const { rows: [prev] } = await c.query(
        `SELECT max(value_date)::text AS d FROM transactions WHERE savings_account_id = $1 AND reversed_by IS NULL AND id <> $2
            AND kind IN ('SAVINGS_INTEREST_APPLIED', 'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED')`, [tx.savings_account_id, tx.id]);
      await c.query(
        `UPDATE savings_accounts SET last_interest_applied_on = $2::date,
           period_started_on = COALESCE($2::date + 1, activated_on, opened_on) WHERE id = $1`, [tx.savings_account_id, prev.d]);
    }
  }

  const rev = await core.record(c, {
    reference: core.ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    savingsAccountId: tx.savings_account_id, amount: -tx.amount, branchId: tx.branch_id,
    entryId: entry.entryId, allocation: { reversalOf: tx.reference, ...(repriced ? { repricedFrom: day } : {}),
      ...(extra.length ? { alsoReversed: extra.map((x) => x.allocation.reversalOf) } : {}) }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

Object.assign(module.exports, {
  REVERSIBLE, assertMayLower, reverseTransaction,
});
