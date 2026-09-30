'use strict';

/**
 * Deposit accounts, split by concern. Each part takes an open tenant client
 * and fills its own exports; this index rebuilds the module's public API so
 * require('./savings') is unchanged. The accounting rules are described at
 * the top of core.js.
 *
 *   core.js          account states, the posting record, legs and product rules
 *   funds.js         blocked funds, seizures, holds and withholding tax
 *   interest.js      accrual, application, repricing, term and maturity
 *   transactions.js  deposits, withdrawals, transfers and fees
 *   reversals.js     reversing a transaction
 *   terms.js         an account's own terms, the interest rate, overdrafts
 *   lifecycle.js     opening, the account life cycle and closing
 *   daily.js         the end of day for deposits
 *
 * Each part requires only parts listed above it, so the require graph has
 * no cycles.
 */

const core = require('./core');
const funds = require('./funds');
const interest = require('./interest');
const transactions = require('./transactions');
const reversals = require('./reversals');
const terms = require('./terms');
const lifecycle = require('./lifecycle');
const daily = require('./daily');

module.exports = {
  blockFunds: funds.blockFunds, blocksOf: funds.blocksOf, unblockFunds: funds.unblockFunds, seizeFunds: funds.seizeFunds, createHold: funds.createHold, holdsOf: funds.holdsOf, reverseHold: funds.reverseHold, heldBack: core.heldBack, changeWithholdingTax: funds.changeWithholdingTax, withholdingHistory: funds.withholdingHistory,
  withholdingRate: funds.withholdingRate, repriceFrom: interest.repriceFrom, valueDay: core.valueDay,
  changeState: lifecycle.changeState, deleteAccount: lifecycle.deleteAccount, followArrears: core.followArrears, apiState: core.apiState, OPEN: core.OPEN, ACTIONS: lifecycle.ACTIONS,
  closeAccount: lifecycle.closeAccount, lockedFunding: core.lockedFunding, open: lifecycle.open, deposit: transactions.deposit, withdraw: transactions.withdraw, transfer: transactions.transfer, summary: core.summary, reverseTransaction: reversals.reverseTransaction, pledgedAmount: core.pledgedAmount, lock: core.lock, record: core.record, ref: core.ref,
  applyFee: transactions.applyFee, applyMonthlyFees: transactions.applyMonthlyFees, accrueInterest: interest.accrueInterest, applyInterest: interest.applyInterest, endOfDay: daily.endOfDay, isApplicationDate: interest.isApplicationDate,
  setOverdraftLimit: terms.setOverdraftLimit, writeOffOverdraft: terms.writeOffOverdraft, inLegs: core.inLegs, outLegs: core.outLegs, availableOf: core.availableOf, onDay: core.onDay, books: core.books,
  startMaturity: interest.startMaturity, undoMaturity: interest.undoMaturity, changeInterestRate: terms.changeInterestRate, updateAccount: terms.updateAccount, accountTerms: terms.accountTerms,
};
