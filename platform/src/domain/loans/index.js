'use strict';

/**
 * Loan accounts, split by concern. Each part takes an open tenant client and
 * fills its own exports; this index rebuilds the module's public API,
 * including the re-exports of the modules below it, so require('./loans')
 * is unchanged. The layer notes are at the top of core.js.
 *
 *   core.js          account numbers, the application, state changes, unlinked posting, arrears
 *   disbursement.js  disbursing a loan
 *   repayment.js     allocating and taking a repayment, interest paid in advance
 *   reversals.js     reversing a loan transaction
 *
 * Write-offs, recoveries and their reversal live in ../writeOffs.
 */

const S = require('../schedule');
const ledger = require('../ledger');
const eligibility = require('../eligibility');
const installments = require('../installments');
const interest = require('../interest');
const types = require('../productTypes');
const writeOffs = require('../writeOffs');
const { buildSchedule, reschedule, applyToInstallments } = installments;
const { accrueInterest } = interest;
const { fillPattern } = require('../accountNumbers');
const { writeOff } = writeOffs;
const core = require('./core');
const disbursement = require('./disbursement');
const repayment = require('./repayment');
const reversals = require('./reversals');

module.exports = {
  // Lifecycle, defined here.
  apply: core.apply, changeState: core.changeState, disburse: disbursement.disburse, repay: repayment.repay, writeOff, reverseTransaction: reversals.reverseTransaction, markArrears: core.markArrears, assertNoLaterRepayment: repayment.assertNoLaterRepayment,
  fillPattern, nextAccountNo: core.nextAccountNo,

  // Re-exported so existing callers keep one import.
  ...ledger,
  isDynamic: types.isDynamic, isRevolving: types.isRevolving, isTranched: types.isTranched, isInterestFree: types.isInterestFree,
  productType: types.forLoan,
  dayCount: S.dayCount, addMonths: S.addMonths, annuityPayment: S.annuityPayment,
  buildSchedule, previewSchedule: installments.previewSchedule, reschedule,
  maturityDate: installments.maturityDate, applyToInstallments,
  scheduledInterestThrough: installments.scheduledInterestThrough,
  scheduledOutstanding: installments.scheduledOutstanding,
  accrueInterest, capitalizeInterest: interest.capitalizeInterest,
  OPEN_APPLICATION: eligibility.OPEN_APPLICATION,
  addGuarantor: eligibility.addGuarantor, guarantorCoverage: eligibility.guarantorCoverage,
  releaseGuarantors: eligibility.releaseGuarantors,
  checkEligibility: eligibility.checkEligibility, enforceEligibility: eligibility.enforceEligibility,
  recover: writeOffs.recover, recoverFromGuarantor: writeOffs.recoverFromGuarantor, releaseCall: writeOffs.releaseCall,
};
