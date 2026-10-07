/**
 * Loan products and their fees.
 */

import { $, api, esc, money, navFilter, toast } from './base.js';
import { ask, card, table, view, wireRows } from './ui.js';
import { depositProductsSection } from './depositProducts.js';
import { appTabs } from './apps.js';

// --------------------------------------------------------------------------
// Loan products
// --------------------------------------------------------------------------

// The product form, in the order the reference platform's form runs: identity, type and
// interest, amount and term, schedule, repayment, arrears and penalties,
// controls, accounting. Blank optional fields are left unset.
export const opt = (f) => ({ ...f, required: false });
const PRODUCT_FIELDS = (p = {}) => [
  { label: 'Name', name: 'name', value: p.name || '' },
  { label: 'Category', name: 'category', options: ['PERSONAL', 'PURCHASE_FINANCING', 'MORTGAGE', 'SME', 'COMMERCIAL', 'UNCATEGORIZED'], value: p.category || 'UNCATEGORIZED' },
  { label: 'Account number pattern (# digit, @ letter, $ either)', name: 'idPattern', value: p.idPattern || 'LN######' },
  { label: 'Numbering', name: 'idMode', options: ['INCREMENTAL', 'RANDOM'], value: p.idMode || 'INCREMENTAL' },
  { label: 'New applications start as', name: 'initialState', options: ['PENDING_APPROVAL', 'PARTIAL_APPLICATION'], value: p.initialState || 'PENDING_APPROVAL' },
  { label: 'Product type (fixed once created)', name: 'productType', options: ['FIXED_TERM', 'DYNAMIC_TERM', 'INTEREST_FREE', 'TRANCHED', 'REVOLVING'], value: p.productType || 'FIXED_TERM' },
  opt({ label: 'Maximum tranches (tranched)', name: 'maxTranches', type: 'number', value: p.maxTranches ?? '' }),
  opt({ label: 'Revolving: installment principal method', name: 'revolvingRepaymentMethod', options: ['', 'PRINCIPAL_FLAT', 'PRINCIPAL_PERCENT', 'TOTAL_DUE_PERCENT'], value: p.revolving?.repaymentMethod || '' }),
  opt({ label: 'Revolving: amount or percent', name: 'revolvingRepaymentValue', type: 'number', step: '0.0001', value: p.revolving?.repaymentValue ?? '' }),
  opt({ label: 'Revolving: repayment floor', name: 'revolvingRepaymentFloor', type: 'number', step: '0.01', value: p.revolving?.repaymentFloor ?? '' }),
  opt({ label: 'Revolving: repayment ceiling', name: 'revolvingRepaymentCeiling', type: 'number', step: '0.01', value: p.revolving?.repaymentCeiling ?? '' }),
  { label: 'Revolving: hold overpayments as a credit balance', name: 'creditBalanceEnabled', options: ['false', 'true'], value: String(p.revolving?.creditBalanceEnabled ?? false) },
  opt({ label: 'Revolving: maximum credit balance', name: 'maxCreditBalance', type: 'number', step: '0.01', value: p.revolving?.maxCreditBalance ?? '' }),
  opt({ label: 'Revolving: credit balance GL (liability)', name: 'glCreditBalance', value: p.revolving?.glCreditBalance || '200-310' }),
  { label: 'Interest method', name: 'method', options: ['FLAT', 'REDUCING', 'REDUCING_EQUAL_INSTALLMENTS'], value: p.method || 'FLAT' },
  { label: 'Interest type', name: 'interestType', options: ['SIMPLE', 'CAPITALIZED', 'COMPOUND', 'COMPOUND_DAILY_REST'], value: p.interestType || 'SIMPLE' },
  { label: 'Simple interest base', name: 'simpleBase', options: ['PRINCIPAL_ONLY', 'PRINCIPAL_AND_INTEREST'], value: p.simpleBase || 'PRINCIPAL_ONLY' },
  { label: 'Interest applied', name: 'interestPosting', options: ['ON_REPAYMENT', 'ON_DISBURSEMENT'], value: p.interestPosting || 'ON_REPAYMENT' },
  { label: 'Rate quoted', name: 'rateFrequency', options: ['PER_MONTH', 'PER_YEAR', 'PER_WEEK', 'PER_DAY'], value: p.rateFrequency || 'PER_MONTH' },
  { label: 'Default rate, percent', name: 'monthlyRate', type: 'number', step: '0.0001', value: p.monthlyRate ?? 1 },
  opt({ label: 'Minimum rate', name: 'rateMin', type: 'number', step: '0.0001', value: p.rateMin ?? '' }),
  opt({ label: 'Maximum rate', name: 'rateMax', type: 'number', step: '0.0001', value: p.rateMax ?? '' }),
  { label: 'Prepayment on a dynamic loan', name: 'prepaymentRecalculation', options: ['REDUCE_INSTALLMENT_AMOUNT', 'REDUCE_NUMBER_OF_INSTALLMENTS', 'NONE'], value: p.prepaymentRecalculation || 'REDUCE_INSTALLMENT_AMOUNT' },
  { label: 'Accrue interest after maturity (dynamic)', name: 'accrueLateInterest', options: ['true', 'false'], value: String(p.accrueLateInterest ?? true) },
  opt({ label: 'Minimum amount', name: 'minPrincipal', type: 'number', step: '0.01', value: p.minPrincipal ?? '' }),
  opt({ label: 'Default amount', name: 'defaultPrincipal', type: 'number', step: '0.01', value: p.defaultPrincipal ?? '' }),
  opt({ label: 'Maximum amount', name: 'maxPrincipal', type: 'number', step: '0.01', value: p.maxPrincipal ?? '' }),
  opt({ label: 'Minimum installments', name: 'minTerm', type: 'number', value: p.minTerm ?? '' }),
  opt({ label: 'Default installments', name: 'defaultTerm', type: 'number', value: p.defaultTerm ?? '' }),
  { label: 'Maximum installments', name: 'maxTerm', type: 'number', value: p.maxTerm ?? 60 },
  { label: 'Repayment every', name: 'repaymentIntervalCount', type: 'number', value: p.repaymentIntervalCount ?? 1 },
  { label: 'Repayment interval unit', name: 'repaymentIntervalUnit', options: ['MONTHS', 'WEEKS', 'DAYS'], value: p.repaymentIntervalUnit || 'MONTHS' },
  opt({ label: 'Or fixed days of month, comma separated (e.g. 1,15)', name: 'fixedDaysOfMonth', value: (p.fixedDaysOfMonth || []).join(',') }),
  { label: 'Short month handling', name: 'shortMonthHandling', options: ['LAST_DAY', 'FIRST_OF_NEXT'], value: p.shortMonthHandling || 'LAST_DAY' },
  { label: 'Leftover principal goes on', name: 'residualInstallment', options: ['LAST', 'FIRST'], value: p.residualInstallment || 'LAST' },
  { label: 'Installment on a non-working day', name: 'nonWorkingDays', options: ['MOVE_FORWARD', 'MOVE_BACKWARD', 'DO_NOT_RESCHEDULE', 'EXTEND_SCHEDULE'], value: p.nonWorkingDays || 'MOVE_FORWARD' },
  { label: 'First due date offset, days', name: 'firstDueOffsetDays', type: 'number', value: p.firstDueOffsetDays ?? 0 },
  { label: 'Grace', name: 'graceType', options: ['NONE', 'PRINCIPAL', 'PURE'], value: p.graceType || 'NONE' },
  { label: 'Grace periods', name: 'gracePeriods', type: 'number', value: p.gracePeriods ?? 0 },
  opt({ label: 'Amortise over (periods, for a balloon)', name: 'amortizationPeriods', type: 'number', value: p.amortizationPeriods ?? '' }),
  { label: 'Rounding of payments', name: 'rounding', options: ['NONE', 'WHOLE', 'WHOLE_UP'], value: p.rounding || 'NONE' },
  { label: 'Processing fee (legacy upfront flat fee)', name: 'processingFee', type: 'number', step: '0.01', value: p.processingFee ?? 0 },
  { label: 'Allow arbitrary fees', name: 'allowArbitraryFees', options: ['false', 'true'], value: String(p.allowArbitraryFees ?? false) },
  { label: 'Times own deposits a member may borrow', name: 'maxMultiplier', type: 'number', step: '0.1', value: p.maxMultiplier ?? 3 },
  { label: 'Enforce that multiplier at approval', name: 'enforceDepositMultiplier', options: ['true', 'false'], value: String(p.enforceDepositMultiplier ?? true) },
  { label: 'Require securities cover (checked at approval and disbursement)', name: 'requireGuarantorCover', options: ['true', 'false'], value: String(p.requireGuarantorCover ?? false) },
  { label: 'Cover required, % of the loan', name: 'minCoverPercent', type: 'number', step: '0.01', value: p.minCoverPercent ?? 100 },
  { label: 'Member\'s own deposits count towards cover', name: 'coverCountsDeposits', options: ['true', 'false'], value: String(p.coverCountsDeposits ?? true) },
  { label: 'Securities: guarantors', name: 'enableGuarantors', options: ['true', 'false'], value: String(p.securities?.guarantors ?? true) },
  { label: 'Securities: collateral assets', name: 'enableCollateral', options: ['false', 'true'], value: String(p.securities?.collateral ?? false) },
  opt({ label: 'Tax rate, percent (blank: no tax)', name: 'taxRatePercent', type: 'number', step: '0.0001', value: p.tax?.ratePercent ?? '' }),
  { label: 'Tax method', name: 'taxMethod', options: ['EXCLUSIVE', 'INCLUSIVE'], value: p.tax?.method || 'EXCLUSIVE' },
  { label: 'Tax on interest', name: 'taxOnInterest', options: ['false', 'true'], value: String(p.tax?.onInterest ?? false) },
  { label: 'Tax on fees', name: 'taxOnFees', options: ['false', 'true'], value: String(p.tax?.onFees ?? false) },
  { label: 'Tax on penalties', name: 'taxOnPenalties', options: ['false', 'true'], value: String(p.tax?.onPenalties ?? false) },
  opt({ label: 'Taxes payable GL (liability)', name: 'glTaxPayable', value: p.tax?.glTaxPayable || '200-300' }),
  { label: 'Funding sources (P2P)', name: 'fundingEnabled', options: ['false', 'true'], value: String(!!p.funding) },
  { label: 'Funder interest allocation', name: 'funderAllocation', options: ['PERCENT_OF_FUNDING', 'FIXED_COMMISSIONS'], value: p.funding?.allocation || 'PERCENT_OF_FUNDING' },
  opt({ label: 'Organisation interest commission', name: 'orgCommission', type: 'number', step: '0.0001', value: p.funding?.orgCommission ?? '' }),
  opt({ label: 'Funder rate default (fixed commissions)', name: 'funderRateDefault', type: 'number', step: '0.0001', value: p.funding?.funderRateDefault ?? '' }),
  opt({ label: 'Funder rate minimum', name: 'funderRateMin', type: 'number', step: '0.0001', value: p.funding?.funderRateMin ?? '' }),
  opt({ label: 'Funder rate maximum', name: 'funderRateMax', type: 'number', step: '0.0001', value: p.funding?.funderRateMax ?? '' }),
  { label: 'Lock funders\' money at approval', name: 'lockFundsAtApproval', options: ['true', 'false'], value: String(p.funding?.lockFundsAtApproval ?? true) },
  { label: 'Arrears tolerance, days', name: 'arrearsToleranceDays', type: 'number', value: p.arrearsToleranceDays ?? 0 },
  opt({ label: 'Arrears tolerance days, minimum for a loan', name: 'arrearsToleranceDaysMin', type: 'number', value: p.arrearsToleranceDaysMin ?? '' }),
  opt({ label: 'Arrears tolerance days, maximum for a loan', name: 'arrearsToleranceDaysMax', type: 'number', value: p.arrearsToleranceDaysMax ?? '' }),
  opt({ label: 'Arrears tolerance, % of outstanding', name: 'arrearsTolerancePercent', type: 'number', step: '0.001', value: p.arrearsTolerancePercent ?? '' }),
  opt({ label: 'Arrears tolerance %, minimum for a loan', name: 'arrearsTolerancePercentMin', type: 'number', step: '0.001', value: p.arrearsTolerancePercentMin ?? '' }),
  opt({ label: 'Arrears tolerance %, maximum for a loan', name: 'arrearsTolerancePercentMax', type: 'number', step: '0.001', value: p.arrearsTolerancePercentMax ?? '' }),
  opt({ label: 'with a floor of', name: 'arrearsToleranceFloor', type: 'number', step: '0.01', value: p.arrearsToleranceFloor ?? '' }),
  { label: 'Count days in arrears from', name: 'arrearsCountFrom', options: ['OLDEST_LATE', 'FIRST_ARREARS'], value: p.arrearsCountFrom || 'OLDEST_LATE' },
  { label: 'Non-working days in tolerance', name: 'arrearsNonWorkingDays', options: ['INCLUDE', 'EXCLUDE'], value: p.arrearsNonWorkingDays || 'INCLUDE' },
  { label: 'Penalty rate, % a day (on outstanding principal: per the interest rate period)', name: 'penaltyRate', type: 'number', step: '0.001', value: p.penaltyRate ?? 0 },
  { label: 'Penalty basis', name: 'penaltyBasis', options: ['OVERDUE_ALL', 'OVERDUE_PRINCIPAL', 'OVERDUE_PRINCIPAL_INTEREST', 'OUTSTANDING_PRINCIPAL', 'NONE'], value: p.penaltyBasis || 'OVERDUE_ALL' },
  { label: 'Penalty tolerance, days', name: 'penaltyToleranceDays', type: 'number', value: p.penaltyToleranceDays ?? 0 },
  opt({ label: 'Cap on charges, % of principal (blank: none)', name: 'chargeCapPercent', type: 'number', step: '0.001', value: p.chargeCapPercent ?? '' }),
  { label: 'Cap base', name: 'chargeCapBase', options: ['OUTSTANDING_PRINCIPAL', 'ORIGINAL_PRINCIPAL'], value: p.chargeCapBase || 'OUTSTANDING_PRINCIPAL' },
  { label: 'Cap mode', name: 'chargeCapMode', options: ['HARD', 'SOFT'], value: p.chargeCapMode || 'HARD' },
  opt({ label: 'Lock after days in arrears (blank: never)', name: 'autoLockArrearsDays', type: 'number', value: p.autoLockArrearsDays ?? '' }),
  { label: 'Count accrued, unapplied charges towards the cap', name: 'capIncludesAccrued', options: ['false', 'true'], value: String(p.capIncludesAccrued ?? false) },
  opt({ label: 'Close a loan that owes nothing after days (blank: never)', name: 'autoClosePaidOffDays', type: 'number', value: p.autoClosePaidOffDays ?? '' }),
  { label: 'Settlement deposit accounts', name: 'settlementEnabled', options: ['false', 'true'], value: String(p.settlement?.enabled ?? false) },
  opt({ label: 'Settlement deposit product (blank: any)', name: 'settlementProductId', value: p.settlement?.productId || '' }),
  { label: 'Auto-set the member\'s account of that product', name: 'settlementAutoSet', options: ['false', 'true'], value: String(p.settlement?.autoSet ?? false) },
  { label: 'Auto-create one when there is none', name: 'settlementAutoCreate', options: ['false', 'true'], value: String(p.settlement?.autoCreate ?? false) },
  { label: 'Settlement transfers', name: 'settlementOption', options: ['FULL_DUES', 'PARTIAL', 'NONE'], value: p.settlement?.option || 'FULL_DUES' },
  { label: 'Offset: the linked deposit account lowers the balance interest is charged on (dynamic term, equal instalments, simple on principal and interest)', name: 'offsetEnabled', options: ['false', 'true'], value: String(p.offsetEnabled ?? false) },
  { label: 'Accounting (fixed once loans exist; use Change accounting method)', name: 'accountingMethod', options: ['ACCRUAL', 'CASH', 'NONE'], value: p.accountingMethod || 'ACCRUAL' },
  { label: 'Accrued interest reaches the ledger (ACCRUAL only)', name: 'interestAccruedAccounting', options: ['DAILY', 'MONTHLY', 'NONE'], value: p.interestAccruedAccounting || 'DAILY' },
  { label: 'Accrual entries', name: 'accrualGranularity', options: ['PER_ACCOUNT', 'AGGREGATED'], value: p.accrualGranularity || 'PER_ACCOUNT' },
  { label: 'Interest added to what is owed', name: 'interestAccrual', options: ['DAILY', 'MONTHLY', 'NONE'], value: p.interestAccrual || 'DAILY' },
  { label: 'Day count', name: 'dayCount', options: ['THIRTY_360', 'ACTUAL_365', 'ACTUAL_360', 'ACTUAL_ACTUAL', 'BUS_252'], value: p.dayCount || 'THIRTY_360' },
  { label: 'Interest rate source (INDEX: the rate above is the spread)', name: 'interestRateSource', options: ['FIXED', 'INDEX'], value: p.interestRateSource || 'FIXED' },
  { label: 'Index source (INDEX products)', name: 'indexSourceId', value: p.indexSourceId || '', required: false },
  { label: 'Rate floor', name: 'rateFloor', type: 'number', step: '0.0001', value: p.rateFloor ?? '', required: false },
  { label: 'Rate ceiling', name: 'rateCeiling', type: 'number', step: '0.0001', value: p.rateCeiling ?? '', required: false },
  { label: 'Review the index every', name: 'rateReviewCount', type: 'number', value: p.rateReviewCount ?? '', required: false },
  { label: 'Review unit', name: 'rateReviewUnit', options: ['MONTHS', 'WEEKS', 'DAYS'], value: p.rateReviewUnit || 'MONTHS' },
  { label: 'Adjustable rate periods on loans', name: 'adjustableRates', options: ['false', 'true'], value: String(p.adjustableRates ?? false) },
  { label: 'Allow negative spreads', name: 'allowNegativeRate', options: ['false', 'true'], value: String(p.allowNegativeRate ?? false) },
  { label: 'Payment allocation', name: 'paymentMethod', options: ['VERTICAL', 'HORIZONTAL'], value: p.paymentMethod || 'VERTICAL' },
  { label: 'Accept prepayments', name: 'allowPrepayments', options: ['true', 'false'], value: String(p.allowPrepayments ?? true) },
  { label: 'Interest on prepayments (dynamic)', name: 'prepaymentInterest', options: ['AUTOMATIC', 'MANUAL'], value: p.prepaymentInterest || 'AUTOMATIC' },
  { label: 'Prepayment allocation (dynamic equal installments)', name: 'prepaymentAllocation', options: ['UPCOMING_PENDING', 'NEXT_INSTALLMENTS'], value: p.prepaymentAllocation || 'UPCOMING_PENDING' },
  { label: 'Mark installment paid when (dynamic equal installments)', name: 'markPaidWhen', options: ['FULL_DUE', 'PRINCIPAL_EXPECTED'], value: p.markPaidWhen || 'FULL_DUE' },
  { label: 'Interest paid in advance (fixed term): a payment before the due date takes the whole interest of', name: 'interestPrepayment', options: ['NONE', 'NEXT_INSTALLMENT', 'ALL_INSTALLMENTS'], value: p.interestPrepayment || 'NONE' },
  { label: 'Accept postdated payments (fixed term)', name: 'allowPostdatedPayments', options: ['false', 'true'], value: String(p.allowPostdatedPayments ?? false) },
  { label: 'Schedule edits allowed (comma separated: PAYMENT_DATES, PRINCIPAL, INTEREST, FEES, PAYMENT_HOLIDAYS, NUMBER_OF_INSTALLMENTS)', name: 'scheduleEditing', value: (p.scheduleEditing || []).join(', '), required: false },
];

const PRODUCT_ENUM_FIELDS = ['category', 'idMode', 'initialState', 'productType', 'method', 'interestType', 'simpleBase', 'interestPosting',
  'rateFrequency', 'prepaymentRecalculation', 'repaymentIntervalUnit', 'shortMonthHandling', 'nonWorkingDays', 'residualInstallment', 'graceType', 'rounding',
  'arrearsCountFrom', 'arrearsNonWorkingDays', 'penaltyBasis', 'chargeCapBase', 'chargeCapMode', 'accountingMethod', 'interestAccrual', 'dayCount',
  'taxMethod', 'funderAllocation', 'interestAccruedAccounting', 'accrualGranularity', 'interestRateSource', 'rateReviewUnit',
  'paymentMethod', 'prepaymentInterest', 'prepaymentAllocation', 'markPaidWhen', 'interestPrepayment', 'settlementOption'];
const PRODUCT_NUM_FIELDS = ['monthlyRate', 'rateMin', 'rateMax', 'minPrincipal', 'defaultPrincipal', 'maxPrincipal', 'minTerm', 'defaultTerm', 'maxTerm',
  'repaymentIntervalCount', 'firstDueOffsetDays', 'gracePeriods', 'amortizationPeriods', 'processingFee', 'maxMultiplier',
  'arrearsToleranceDays', 'arrearsTolerancePercent', 'arrearsToleranceFloor', 'penaltyRate', 'penaltyToleranceDays',
  'chargeCapPercent', 'autoLockArrearsDays', 'maxTranches', 'revolvingRepaymentValue', 'revolvingRepaymentFloor', 'revolvingRepaymentCeiling',
  'maxCreditBalance', 'taxRatePercent', 'orgCommission', 'funderRateDefault', 'funderRateMin', 'funderRateMax',
  'rateFloor', 'rateCeiling', 'rateReviewCount',
  'arrearsToleranceDaysMin', 'arrearsToleranceDaysMax', 'arrearsTolerancePercentMin', 'arrearsTolerancePercentMax',
  'minCoverPercent', 'autoClosePaidOffDays'];
const PRODUCT_BOOL_FIELDS = ['accrueLateInterest', 'allowArbitraryFees', 'enforceDepositMultiplier', 'requireGuarantorCover',
  'creditBalanceEnabled', 'enableGuarantors', 'enableCollateral', 'taxOnInterest', 'taxOnFees', 'taxOnPenalties', 'fundingEnabled', 'lockFundsAtApproval',
  'adjustableRates', 'allowNegativeRate', 'allowPrepayments', 'allowPostdatedPayments', 'coverCountsDeposits', 'capIncludesAccrued',
  'settlementEnabled', 'settlementAutoSet', 'settlementAutoCreate', 'offsetEnabled'];
// Optional numbers that a blank field sets back to "unset".
const PRODUCT_NULLABLE = ['rateMin', 'rateMax', 'minPrincipal', 'defaultPrincipal', 'maxPrincipal', 'minTerm', 'defaultTerm',
  'amortizationPeriods', 'arrearsTolerancePercent', 'arrearsToleranceFloor', 'chargeCapPercent', 'autoLockArrearsDays',
  'maxTranches', 'revolvingRepaymentValue', 'revolvingRepaymentFloor', 'revolvingRepaymentCeiling', 'maxCreditBalance', 'taxRatePercent',
  'orgCommission', 'funderRateDefault', 'funderRateMin', 'funderRateMax', 'rateFloor', 'rateCeiling', 'rateReviewCount',
  'arrearsToleranceDaysMin', 'arrearsToleranceDaysMax', 'arrearsTolerancePercentMin', 'arrearsTolerancePercentMax', 'autoClosePaidOffDays'];

function productBody(d) {
  const out = { name: d.name, idPattern: d.idPattern };
  for (const k of PRODUCT_ENUM_FIELDS) if (d[k] !== undefined) out[k] = d[k];
  for (const k of PRODUCT_BOOL_FIELDS) if (d[k] !== undefined) out[k] = d[k] === 'true';
  for (const k of PRODUCT_NUM_FIELDS) {
    if (d[k] === undefined) continue;
    if (d[k] === '') { if (PRODUCT_NULLABLE.includes(k)) out[k] = null; continue; }
    out[k] = Number(d[k]);
  }
  if (d.scheduleEditing !== undefined) out.scheduleEditing = d.scheduleEditing.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (d.indexSourceId !== undefined) out.indexSourceId = d.indexSourceId.trim() ? d.indexSourceId.trim().toUpperCase() : null;
  if (d.fixedDaysOfMonth !== undefined) {
    out.fixedDaysOfMonth = d.fixedDaysOfMonth.trim() ? d.fixedDaysOfMonth.split(',').map((x) => Number(x.trim())).filter(Boolean) : null;
  }
  if (d.revolvingRepaymentMethod !== undefined) out.revolvingRepaymentMethod = d.revolvingRepaymentMethod || null;
  if (d.settlementProductId !== undefined) out.settlementProductId = d.settlementProductId.trim() ? d.settlementProductId.trim().toUpperCase() : null;
  // Mappings go only where the settings use them: a product refuses an
  // account it would never post to.
  const linked = out.accountingMethod !== 'NONE';
  if (d.glCreditBalance !== undefined) out.glCreditBalance = linked && out.creditBalanceEnabled ? d.glCreditBalance || null : null;
  if (d.glTaxPayable !== undefined) out.glTaxPayable = linked && (out.taxOnInterest || out.taxOnFees || out.taxOnPenalties) ? d.glTaxPayable || null : null;
  if (out.accountingMethod && out.accountingMethod !== 'ACCRUAL') out.interestAccruedAccounting = 'NONE';
  if (out.productType === 'INTEREST_FREE') out.monthlyRate = 0;
  return out;
}

const FEE_FIELDS = (f = {}) => [
  opt({ label: 'Code (blank: made from the name)', name: 'code', value: f.code || '' }),
  { label: 'Name', name: 'name', value: f.name || '' },
  { label: 'When', name: 'feeType', options: ['MANUAL', 'DISBURSEMENT_DEDUCTED', 'DISBURSEMENT_CAPITALIZED', 'DISBURSEMENT_UPFRONT', 'PAYMENT_DUE', 'LATE_REPAYMENT'], value: f.feeType || 'MANUAL' },
  { label: 'How much', name: 'calculation', options: ['FLAT', 'PERCENT_OF_AMOUNT', 'FLAT_PER_INSTALLMENT', 'PERCENT_PER_INSTALLMENT', 'PERCENT_OF_INSTALLMENT_PRINCIPAL'], value: f.calculation || 'FLAT' },
  opt({ label: 'Amount (flat)', name: 'amount', type: 'number', step: '0.01', value: f.amount ?? '' }),
  opt({ label: 'Percent', name: 'percent', type: 'number', step: '0.0001', value: f.percent ?? '' }),
  opt({ label: 'Minimum', name: 'minAmount', type: 'number', step: '0.01', value: f.minAmount ?? '' }),
  opt({ label: 'Maximum', name: 'maxAmount', type: 'number', step: '0.01', value: f.maxAmount ?? '' }),
  { label: 'Required', name: 'required', options: ['true', 'false'], value: String(f.required ?? true) },
  opt({ label: 'Fee income GL (blank: product default)', name: 'glIncome', value: f.glIncome || '' }),
  opt({ label: 'Fee receivable GL (blank: product default)', name: 'glReceivable', value: f.glReceivable || '' }),
  opt({ label: 'Fee write-off GL (blank: product default)', name: 'glWriteOff', value: f.glWriteOff || '' }),
  { label: 'Manual fee goes on (schedule allocation)', name: 'allocation', options: ['NEXT_INSTALLMENT', 'NO_ALLOCATION'], value: f.allocation || 'NEXT_INSTALLMENT' },
  { label: 'Amortise the income (accrual)', name: 'amortizationProfile', options: ['NONE', 'STRAIGHT_LINE', 'SUM_OF_YEARS_DIGITS', 'EFFECTIVE_INTEREST_RATE'], value: f.amortizationProfile || 'NONE' },
  { label: 'Amortisation frequency', name: 'amortizationFrequency', options: ['INSTALLMENT_DUE_DATES', 'INSTALLMENT_DUE_DATES_DAILY', 'CUSTOM_INTERVAL'], value: f.amortizationFrequency || 'INSTALLMENT_DUE_DATES' },
  opt({ label: 'Custom interval: every', name: 'amortizationIntervalCount', type: 'number', value: f.amortizationIntervalCount ?? '' }),
  { label: 'Custom interval unit', name: 'amortizationIntervalUnit', options: ['MONTHS', 'WEEKS', 'DAYS', 'YEARS'], value: f.amortizationIntervalUnit || 'MONTHS' },
  opt({ label: 'Custom interval: number of intervals', name: 'amortizationIntervals', type: 'number', value: f.amortizationIntervals ?? '' }),
  { label: 'On reschedule or refinance', name: 'amortizationOnReschedule', options: ['END_ON_ORIGINAL', 'CONTINUE_ON_NEW'], value: f.amortizationOnReschedule || 'END_ON_ORIGINAL' },
  opt({ label: 'Deferred fee income GL (blank: product default)', name: 'glDeferredIncome', value: f.glDeferredIncome || '' }),
  { label: 'Active', name: 'isActive', options: ['true', 'false'], value: String(f.isActive ?? true) },
];
function feeBody(d) {
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  return {
    code: d.code ? d.code.toUpperCase() : undefined, name: d.name, feeType: d.feeType, calculation: d.calculation,
    amount: num(d.amount), percent: num(d.percent), minAmount: num(d.minAmount), maxAmount: num(d.maxAmount),
    required: d.required === 'true', isActive: d.isActive === 'true',
    glIncome: d.glIncome || null, glReceivable: d.glReceivable || null, glWriteOff: d.glWriteOff || null,
    allocation: d.allocation || undefined, amortizationProfile: d.amortizationProfile || undefined,
    amortizationFrequency: d.amortizationFrequency || undefined,
    amortizationIntervalCount: num(d.amortizationIntervalCount), amortizationIntervals: num(d.amortizationIntervals),
    amortizationIntervalUnit: d.amortizationFrequency === 'CUSTOM_INTERVAL' ? d.amortizationIntervalUnit : null,
    amortizationOnReschedule: d.amortizationOnReschedule || undefined, glDeferredIncome: d.glDeferredIncome || null,
  };
}

async function productDetail(p0) {
  const r = await api('GET', `/api/loan-products/${p0.id}`);
  if (!r.ok) throw new Error(r.error);
  const p = r.body;
  const etag = r.etag;
  const words = {
    FLAT: 'Flat', REDUCING: 'Reducing', REDUCING_EQUAL_INSTALLMENTS: 'Reducing, equal installments',
    FIXED_TERM: 'Fixed term', DYNAMIC_TERM: 'Dynamic term', INTEREST_FREE: 'Interest free', TRANCHED: 'Tranched', REVOLVING: 'Revolving credit',
  };
  view().innerHTML = `
    <button class="secondary" id="back">← Products</button>
    <div class="toolbar"><h1>${esc(p.id)} · ${esc(p.name)}</h1><span class="spacer"></span>
      <button id="p-edit" class="secondary">Edit settings</button><button id="p-method" class="secondary">Change accounting method</button><button id="p-fee">Add fee</button></div>
    <div class="grid">
      ${card('Interest', `<dl class="kv">
        <dt>Type</dt><dd>${esc(words[p.productType] || p.productType)}</dd>
        <dt>Method</dt><dd>${esc(words[p.method] || p.method)}</dd>
        <dt>Interest type</dt><dd>${esc(p.interestType)}${p.simpleBase === 'PRINCIPAL_AND_INTEREST' ? ' on principal and interest' : ''}</dd>
        <dt>Rate</dt><dd>${p.monthlyRate}% ${esc(p.rateFrequency.replace('PER_', 'per ').toLowerCase())}${p.rateMin !== null || p.rateMax !== null ? ` (${p.rateMin ?? '…'} to ${p.rateMax ?? '…'})` : ''} · ${p.annualRate}% a year</dd>
        <dt>Applied</dt><dd>${esc(p.interestPosting)} · accrual ${esc(p.interestAccrual)} · ${esc(p.dayCount)}</dd>
        <dt>Prepayment</dt><dd>${esc(p.prepaymentRecalculation)}${p.accrueLateInterest ? '' : ' · stops at maturity'}</dd>
      </dl>`)}
      ${card('Schedule', `<dl class="kv">
        <dt>Amount</dt><dd>${p.minPrincipal ?? '…'} to ${p.maxPrincipal ?? '…'}${p.defaultPrincipal !== null ? `, default ${p.defaultPrincipal}` : ''}</dd>
        <dt>Installments</dt><dd>${p.minTerm ?? '…'} to ${p.maxTerm}${p.defaultTerm !== null ? `, default ${p.defaultTerm}` : ''}</dd>
        <dt>Falls</dt><dd>${p.fixedDaysOfMonth ? `on the ${p.fixedDaysOfMonth.join(' and ')} of the month` : `every ${p.repaymentIntervalCount} ${p.repaymentIntervalUnit.toLowerCase()}`}${p.firstDueOffsetDays ? `, first ${p.firstDueOffsetDays} days later` : ''}</dd>
        <dt>Grace</dt><dd>${p.graceType === 'NONE' ? 'none' : `${p.gracePeriods} ${p.graceType.toLowerCase()} period(s)`}</dd>
        <dt>Balloon</dt><dd>${p.amortizationPeriods ? `amortised over ${p.amortizationPeriods}` : 'none'}</dd>
        <dt>Rounding</dt><dd>${esc(p.rounding)}</dd>
        <dt>Numbering</dt><dd>${esc(p.idPattern)} ${esc(p.idMode.toLowerCase())}, next ${p.idNext} · starts ${esc(p.initialState)}</dd>
      </dl>`)}
      ${card('Arrears, penalties, controls', `<dl class="kv">
        <dt>Arrears tolerance</dt><dd>${p.arrearsToleranceDays} days${p.arrearsTolerancePercent !== null ? `, ${p.arrearsTolerancePercent}% of outstanding` : ''}${p.arrearsToleranceFloor !== null ? ` (floor ${p.arrearsToleranceFloor})` : ''} · ${esc(p.arrearsNonWorkingDays.toLowerCase())} non-working days · from ${esc(p.arrearsCountFrom)}</dd>
        <dt>Penalty</dt><dd>${p.penaltyBasis === 'NONE' ? 'none' : `${p.penaltyRate}% a day on ${esc(p.penaltyBasis)}, after ${p.penaltyToleranceDays} days`}</dd>
        <dt>Cap on charges</dt><dd>${p.chargeCapPercent === null ? 'none set' : `${p.chargeCapPercent}% of ${esc(p.chargeCapBase)}, ${esc(p.chargeCapMode)}`}</dd>
        <dt>Auto lock</dt><dd>${p.autoLockArrearsDays === null ? 'never' : `after ${p.autoLockArrearsDays} days in arrears`}</dd>
        <dt>Eligibility</dt><dd>${p.maxMultiplier}× deposits${p.enforceDepositMultiplier ? '' : ' (not enforced)'}${p.requireGuarantorCover ? `, ${p.minCoverPercent}% cover${p.coverCountsDeposits === false ? ' from guarantees and collateral only' : ' counting own deposits'}, at approval and disbursement` : ''}</dd>
        <dt>Settlement accounts</dt><dd id="p-settlement">${p.settlement?.enabled ? `${p.settlement.productId ? esc(p.settlement.productId) : 'any deposit product'} · ${esc(p.settlement.option.toLowerCase().replace(/_/g, ' '))}${p.settlement.autoSet ? ' · auto-set' : ''}${p.settlement.autoCreate ? ' · auto-create' : ''}` : 'not linked'}</dd>
        <dt>Accounting</dt><dd>${esc(p.accountingMethod)}${p.accountingMethod === 'ACCRUAL' ? ` · accrued interest to the ledger ${esc(p.interestAccruedAccounting)}, ${esc(p.accrualGranularity.toLowerCase().replace('_', ' '))}` : ''}</dd>
        <dt>GL rules</dt><dd>${p.accountingRules.length ? p.accountingRules.map((r) => `${esc(r.resource)} ${esc(r.glCode || '(default)')}`).join(' · ') : 'none: not linked to accounting'}</dd>
        <dt>Allocation</dt><dd>${p.allocationOrder.join(' → ')}</dd>
        <dt>Securities</dt><dd>${[p.securities.guarantors ? 'guarantors' : null, p.securities.collateral ? 'collateral' : null].filter(Boolean).join(', ') || 'none'}</dd>
        <dt>Tax</dt><dd>${p.tax.ratePercent === null ? 'none' : `${p.tax.ratePercent}% ${p.tax.method.toLowerCase()} on ${[p.tax.onInterest ? 'interest' : null, p.tax.onFees ? 'fees' : null, p.tax.onPenalties ? 'penalties' : null].filter(Boolean).join(', ') || 'nothing'}`}</dd>
        ${p.maxTranches ? `<dt>Tranches</dt><dd>up to ${p.maxTranches}</dd>` : ''}
        ${p.revolving ? `<dt>Revolving</dt><dd>${esc(p.revolving.repaymentMethod)} ${p.revolving.repaymentValue}${p.revolving.creditBalanceEnabled ? ` · credit balance up to ${p.revolving.maxCreditBalance ?? 'any'}` : ''}</dd>` : ''}
        ${p.funding ? `<dt>Funding</dt><dd>${esc(p.funding.allocation)} · commission ${p.funding.orgCommission}%</dd>` : ''}
      </dl>`)}
    </div>
    ${card('Fees', table([
    { label: 'Code', key: 'code' },
    { label: 'Fee', key: 'name' },
    { label: 'When', key: 'feeType' },
    { label: 'How much', value: (f) => (f.amount !== null ? money(f.amount) : `${f.percent}%`) + (f.calculation.includes('INSTALLMENT') ? ` ${f.calculation.toLowerCase().replace(/_/g, ' ')}` : '') },
    { label: 'Required', value: (f) => (f.required ? 'yes' : 'optional') },
    { label: 'Active', value: (f) => (f.isActive ? 'yes' : 'no') },
  ], p.fees || [], { onRow: true, empty: 'No fees defined. The legacy processing fee, if any, still applies.' }))}
    <p class="hint">Click a fee to change it.</p>`;

  $('#back').addEventListener('click', productsView);
  $('#p-edit').addEventListener('click', async () => {
    const d = await ask(PRODUCT_FIELDS(p), `Edit ${p.id}`);
    if (!d) return;
    const res = await api('PATCH', `/api/loan-products/${p.id}`, productBody(d), { ifMatch: etag });
    toast(res.ok ? `${p.id} saved` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productDetail(p);
  });
  $('#p-method').addEventListener('click', () => changeMethod('loan-products', p, productDetail));
  $('#p-fee').addEventListener('click', async () => {
    const d = await ask(FEE_FIELDS(), `New fee on ${p.id}`);
    if (!d) return;
    const res = await api('POST', `/api/loan-products/${p.id}/fees`, feeBody(d), { ifMatch: etag });
    toast(res.ok ? `Fee ${res.body.code} added` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productDetail(p);
  });
  wireRows(p.fees || [], async (f) => {
    const d = await ask(FEE_FIELDS(f).filter((x) => x.name !== 'code'), `Edit fee ${f.code}`);
    if (!d) return;
    const body = feeBody(d);
    delete body.code;
    const res = await api('PATCH', `/api/loan-products/${p.id}/fees/${f.id}`, body, { ifMatch: etag });
    toast(res.ok ? `Fee ${f.code} saved` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productDetail(p);
  });
  appTabs('LOAN_PRODUCT_VIEW', p.id);
}

const productState = { parts: ['loan', 'deposit'] };

/** Loan products, deposit products or both (filter.tab from the Products menu, filter.only from Administration). */
export async function productsView(filter) {
  const f = navFilter(filter);
  if (f) productState.parts = f.only || (f.tab ? [f.tab] : ['loan', 'deposit']);
  if (!productState.parts.includes('loan')) {
    view().innerHTML = '';
    return depositProductsSection();
  }
  const r = await api('GET', '/api/loan-products');
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Loan products</h1><span class="spacer"></span><button id="p-index" class="secondary">Index rates</button><button id="p-new">New product</button></div>
    <p class="hint">Rates are copied onto a loan when it is applied for, so changing a product does not
      reprice loans already running. The accounting method and GL accounts are read live.
      A fixed-term loan owes the interest on its schedule however it is paid; a dynamic-term loan
      pays interest on the actual balance for the actual days and its schedule is redrawn when it prepays.</p>
    ${table([
    { label: 'Id', key: 'id' },
    { label: 'Name', key: 'name' },
    { label: 'Type', value: (p) => ({ DYNAMIC_TERM: 'Dynamic', FIXED_TERM: 'Fixed', INTEREST_FREE: 'Interest free', TRANCHED: 'Tranched', REVOLVING: 'Revolving' }[p.productType] || p.productType) },
    { label: 'Method', value: (p) => ({ FLAT: 'Flat', REDUCING: 'Reducing', REDUCING_EQUAL_INSTALLMENTS: 'Reducing, equal installments' }[p.method] || p.method) },
    { label: 'Rate', num: true, value: (p) => `${p.monthlyRate}% ${p.rateFrequency.replace('PER_', '/').toLowerCase()}` },
    { label: 'Max term', num: true, key: 'maxTerm' },
    { label: 'Fees', num: true, value: (p) => `${p.feeCount}${p.processingFee > 0 ? ` + ${money(p.processingFee)}` : ''}` },
    { label: 'x deposits', num: true, value: (p) => `${p.maxMultiplier}${p.enforceDepositMultiplier ? '' : ' (not enforced)'}` },
    { label: 'Accounting', value: (p) => `${p.accountingMethod} · ${p.interestAccrual} · ${p.dayCount}` },
    { label: 'Loans', num: true, key: 'loans' },
    { label: 'Active', value: (p) => (p.isActive ? 'yes' : 'no') },
  ], r.body, { onRow: true, empty: 'No products' })}
    <p class="hint">Click a product to see and change its settings and fees.</p>`;

  wireRows(r.body, productDetail);

  $('#p-index').addEventListener('click', async () => {
    const list = await api('GET', '/api/index-rates');
    const current = (list.body || []).map((x) => `${x.id} ${x.current_rate ?? '-'}%`).join(', ') || 'none yet';
    const d = await ask([
      { label: `Index source id (now: ${current})`, name: 'id' },
      { label: 'Name (for a new source)', name: 'name', required: false },
      { label: 'Rate, %', name: 'rate', type: 'number', step: '0.0001' },
      { label: 'Valid from', name: 'validFrom', type: 'date' },
    ], 'Set an index rate');
    if (!d) return;
    const id = d.id.trim().toUpperCase();
    if (!(list.body || []).some((x) => x.id === id)) {
      const made = await api('POST', '/api/index-rates', { id, name: d.name || id });
      if (!made.ok) return toast(made.error, true);
    }
    const res = await api('POST', `/api/index-rates/${id}/rates`, { rate: Number(d.rate), validFrom: d.validFrom });
    toast(res.ok ? `${id} is ${d.rate}% from ${d.validFrom}; indexed loans take it at their next review` : res.error, !res.ok);
  });

  $('#p-new').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Id (2 to 16 letters, digits or underscore)', name: 'id' },
      ...PRODUCT_FIELDS(),
      { label: 'Portfolio GL account', name: 'glPortfolio', value: '100-100' },
      { label: 'Interest income GL account', name: 'glInterestInc', value: '400-100' },
      { label: 'Fee income GL account', name: 'glFeeInc', value: '400-200' },
    ], 'New loan product');
    if (!d) return;
    const body = { id: d.id, ...productBody(d) };
    if (body.accountingMethod !== 'NONE') Object.assign(body, { glPortfolio: d.glPortfolio, glInterestInc: d.glInterestInc, glFeeInc: d.glFeeInc });
    const res = await api('POST', '/api/loan-products', body);
    toast(res.ok ? `${res.body.id} created` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productsView();
  });
  if (productState.parts.includes('deposit')) depositProductsSection();
}

// A product's accounting method changes through its own action, after the
// previous month is closed; the open balances are converted and the change
// is recorded with its reason.
export async function changeMethod(kind, p, reload) {
  const d = await ask([
    { label: 'New accounting method', name: 'accountingMethod', options: ['ACCRUAL', 'CASH', 'NONE'], value: p.accountingMethod },
    { label: 'Accrued interest reaches the ledger (ACCRUAL only)', name: 'interestAccruedAccounting', options: ['DAILY', 'MONTHLY', 'NONE'], value: p.interestAccruedAccounting || 'NONE' },
    { label: 'Reason (kept with the change)', name: 'reason' },
  ], `Change the accounting method of ${p.id}`);
  if (!d) return;
  const res = await api('POST', `/api/${kind}/${p.id}/accounting-method`, {
    accountingMethod: d.accountingMethod, interestAccruedAccounting: d.accountingMethod === 'ACCRUAL' ? d.interestAccruedAccounting : 'NONE', reason: d.reason,
  });
  toast(res.ok ? `${p.id} is now ${d.accountingMethod}; ${res.body.accounts} account(s) converted` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
  if (res.ok) reload(p);
}
