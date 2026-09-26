'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const savings = require('./savings');
const ledger = require('./ledger');
const loans = require('./loans');
const { err, round2 } = acct;
const { ymd, isoDate } = S;

/**
 * Money moved between a loan and a deposit account, after Mambu's
 * "Disbursing a loan to a deposit account" and "Enter a repayment from a
 * deposit account".
 *
 *   disburseToDeposit  the loan is paid out into one of the member's own
 *                      deposit accounts: a Disbursement on the loan and a
 *                      Deposit on the account. The account must be active,
 *                      not a funding account and not overdrawn, and both
 *                      products linked to the ledger or neither (Mambu:
 *                      the same accounting rules).
 *   repayFromDeposit   a repayment taken from a deposit account, the
 *                      member's own or anyone else's (member A may repay
 *                      member B's loan): a Withdrawal on the account and a
 *                      Repayment on the loan. The deposit account's rules
 *                      stand (withdrawable, minimum balance, pledges,
 *                      overdraft only where allowed).
 *
 * Both halves go through the transfer channel (290-210 Loan Transfer
 * Clearing), which nets to nothing, and each transaction names the other.
 * Reversing either half reverses both (./loans reverseTransaction; the
 * savings reversal route sends the deposit half there).
 *
 * This module stands above ./loans, like ./restructure.
 */

const CHANNEL = 'transfer';

async function link(c, loanTx, savingsTx) {
  await c.query('UPDATE transactions SET allocation = allocation || $2::jsonb WHERE id = $1',
    [loanTx.id, JSON.stringify({ transfer: { savingsReference: savingsTx.reference, savingsAccountId: savingsTx.savings_account_id } })]);
  await c.query('UPDATE transactions SET allocation = allocation || $2::jsonb WHERE id = $1',
    [savingsTx.id, JSON.stringify({ loanTransfer: { reference: loanTx.reference, loanAccountId: loanTx.loan_account_id } })]);
  const { rows: [a] } = await c.query('SELECT * FROM transactions WHERE id = $1', [loanTx.id]);
  const { rows: [b] } = await c.query('SELECT * FROM transactions WHERE id = $1', [savingsTx.id]);
  return { loanTransaction: a, savingsTransaction: b };
}

/** Pay the loan out into a deposit account of its member. */
async function disburseToDeposit(c, loanId, { savingsAccountId = null, valueDate = null, narration = null, createdBy, user = null, ...rest } = {}) {
  const l = await ledger.lock(c, loanId);
  const target = savingsAccountId || l.disbursement_savings_account_id;
  if (!target) throw err('A_DEPOSIT_ACCOUNT_IS_REQUIRED', 400);
  const a = await savings.lock(c, String(target));
  if (a.member_id !== l.member_id) throw err('DISBURSEMENT_ACCOUNT_BELONGS_TO_ANOTHER_MEMBER', 409);
  if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (a.is_funding_account) throw err('A_FUNDING_ACCOUNT_CANNOT_RECEIVE_A_DISBURSEMENT', 409);
  if (Number(a.balance) < 0) throw err('ACCOUNT_IS_OVERDRAWN: a loan is disbursed only into an account with a positive balance', 409);
  if ((l.accounting_method === 'NONE') !== (a.accounting_method === 'NONE')) {
    throw err('DEPOSIT_ACCOUNT_ACCOUNTING_DIFFERS: both products must be linked to the ledger, or neither', 409);
  }
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const loanTx = await loans.disburse(c, l.id, {
    ...rest, channelId: CHANNEL, valueDate: date, createdBy, user,
    narration: narration || `Disbursement of ${l.account_no} into ${a.account_no}`,
  });
  const paidOut = round2(loanTx.allocation?.paidOut ?? loanTx.amount);
  const savingsTx = await savings.deposit(c, a.id, {
    amount: paidOut, channelId: CHANNEL, valueDate: date, createdBy,
    narration: `Disbursement of loan ${l.account_no}`,
  });
  return link(c, loanTx, savingsTx);
}

/** Repay a loan from a deposit account (any member's). */
async function repayFromDeposit(c, loanId, { savingsAccountId, amount, valueDate = null, narration = null, createdBy, user = null, ...rest } = {}) {
  if (!savingsAccountId) throw err('A_DEPOSIT_ACCOUNT_IS_REQUIRED', 400);
  const l = await ledger.lock(c, loanId);
  const a = await savings.lock(c, String(savingsAccountId));
  if (a.is_funding_account) throw err('A_FUNDING_ACCOUNT_CANNOT_REPAY_A_LOAN', 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_REPAYMENT_AMOUNT', 400);
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const savingsTx = await savings.withdraw(c, a.id, {
    amount: amt, channelId: CHANNEL, valueDate: date, createdBy,
    narration: `Repayment of loan ${l.account_no}`,
  });
  const loanTx = await loans.repay(c, l.id, {
    ...rest, amount: amt, channelId: CHANNEL, valueDate: date, createdBy, user,
    narration: narration || `Repayment from ${a.account_no}${a.member_id !== l.member_id ? ' (another member)' : ''}`,
  });
  return link(c, loanTx, savingsTx);
}

module.exports = { disburseToDeposit, repayFromDeposit, CHANNEL };
