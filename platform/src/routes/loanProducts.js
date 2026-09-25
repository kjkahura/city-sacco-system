'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { apiError, badRequest, notFound } = require('../lib/http');
const PA = require('../domain/productAccounting');

/**
 * Loan products, the whole configuration surface, after Mambu's loan
 * product form: identity and numbering, type and interest method, rate and
 * bands, amount and term, repayment interval and grace, balloon and
 * rounding, arrears and penalties, the charge cap, internal controls, fees,
 * eligibility, allocation order, and accounting.
 *
 * Changing a product does not touch loans already running: the rate and
 * type are copied onto the loan at application, the schedule is drawn at
 * disbursement. GL mappings and the accounting method are read live, so a
 * wrong mapping can be corrected. The settings that decide how interest is
 * computed (type, method, interest type, posting, rate frequency, day count,
 * interval) may not change once a loan exists under the product: a SACCO
 * that needs different arithmetic creates a new product. Mambu behaves the
 * same way for the product type and warns about the rest.
 */

const router = express.Router();
const READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR', 'TELLER'];
const ADMIN = ['TENANT_ADMIN', 'MANAGER'];

const ENUMS = {
  product_type: ['FIXED_TERM', 'DYNAMIC_TERM', 'INTEREST_FREE', 'TRANCHED', 'REVOLVING'],
  revolving_repayment_method: ['PRINCIPAL_FLAT', 'PRINCIPAL_PERCENT', 'TOTAL_DUE_PERCENT'],
  tax_method: ['EXCLUSIVE', 'INCLUSIVE'],
  funder_allocation: ['PERCENT_OF_FUNDING', 'FIXED_COMMISSIONS'],
  category: ['PERSONAL', 'PURCHASE_FINANCING', 'MORTGAGE', 'SME', 'COMMERCIAL', 'UNCATEGORIZED'],
  method: ['FLAT', 'REDUCING', 'REDUCING_EQUAL_INSTALLMENTS'],
  interest_type: ['SIMPLE', 'CAPITALIZED', 'COMPOUND', 'COMPOUND_DAILY_REST'],
  residual_installment: ['FIRST', 'LAST'],
  interest_rate_source: ['FIXED', 'INDEX'],
  rate_review_unit: ['DAYS', 'WEEKS', 'MONTHS'],
  simple_base: ['PRINCIPAL_ONLY', 'PRINCIPAL_AND_INTEREST'],
  interest_posting: ['ON_REPAYMENT', 'ON_DISBURSEMENT'],
  rate_frequency: ['PER_YEAR', 'PER_MONTH', 'PER_WEEK', 'PER_DAY'],
  prepayment_recalculation: ['NONE', 'REDUCE_INSTALLMENT_AMOUNT', 'REDUCE_NUMBER_OF_INSTALLMENTS'],
  accounting_method: ['ACCRUAL', 'CASH', 'NONE'],
  interest_accrual: ['DAILY', 'MONTHLY', 'NONE'],
  interest_accrued_accounting: ['NONE', 'DAILY', 'MONTHLY'],
  accrual_granularity: ['PER_ACCOUNT', 'AGGREGATED'],
  day_count: ['THIRTY_360', 'ACTUAL_365', 'ACTUAL_360', 'ACTUAL_ACTUAL', 'BUS_252'],
  penalty_basis: ['NONE', 'OVERDUE_PRINCIPAL', 'OVERDUE_PRINCIPAL_INTEREST', 'OVERDUE_ALL', 'OUTSTANDING_PRINCIPAL'],
  id_mode: ['RANDOM', 'INCREMENTAL'],
  initial_state: ['PARTIAL_APPLICATION', 'PENDING_APPROVAL'],
  repayment_interval_unit: ['MONTHS', 'WEEKS', 'DAYS'],
  short_month_handling: ['LAST_DAY', 'FIRST_OF_NEXT'],
  grace_type: ['NONE', 'PRINCIPAL', 'PURE'],
  rounding: ['NONE', 'WHOLE', 'WHOLE_UP'],
  non_working_days: ['DO_NOT_RESCHEDULE', 'MOVE_FORWARD', 'MOVE_BACKWARD', 'EXTEND_SCHEDULE'],
  arrears_count_from: ['FIRST_ARREARS', 'OLDEST_LATE'],
  arrears_non_working_days: ['INCLUDE', 'EXCLUDE'],
  charge_cap_base: ['ORIGINAL_PRINCIPAL', 'OUTSTANDING_PRINCIPAL'],
  charge_cap_mode: ['SOFT', 'HARD'],
};

// camelCase on the wire, snake_case in the table.
const FIELDS = {
  name: 'name', description: 'description', category: 'category',
  productType: 'product_type', method: 'method',
  interestType: 'interest_type', simpleBase: 'simple_base', interestPosting: 'interest_posting',
  rateFrequency: 'rate_frequency', monthlyRate: 'monthly_rate', rateMin: 'rate_min', rateMax: 'rate_max',
  prepaymentRecalculation: 'prepayment_recalculation', accrueLateInterest: 'accrue_late_interest',
  idPattern: 'id_pattern', idMode: 'id_mode', idNext: 'id_next', initialState: 'initial_state',
  minPrincipal: 'min_principal', maxPrincipal: 'max_principal', defaultPrincipal: 'default_principal',
  minTerm: 'min_term', maxTerm: 'max_term', defaultTerm: 'default_term',
  repaymentIntervalUnit: 'repayment_interval_unit', repaymentIntervalCount: 'repayment_interval_count',
  fixedDaysOfMonth: 'fixed_days_of_month', shortMonthHandling: 'short_month_handling', nonWorkingDays: 'non_working_days',
  residualInstallment: 'residual_installment',
  interestRateSource: 'interest_rate_source', indexSourceId: 'index_source_id', rateFloor: 'rate_floor', rateCeiling: 'rate_ceiling',
  rateReviewCount: 'rate_review_count', rateReviewUnit: 'rate_review_unit', adjustableRates: 'adjustable_rates',
  allowedIndexSources: 'allowed_index_sources', allowNegativeRate: 'allow_negative_rate', scheduleEditing: 'schedule_editing',
  firstDueOffsetDays: 'first_due_offset_days', firstDueOffsetMin: 'first_due_offset_min', firstDueOffsetMax: 'first_due_offset_max',
  graceType: 'grace_type', gracePeriods: 'grace_periods', amortizationPeriods: 'amortization_periods', rounding: 'rounding',
  processingFee: 'processing_fee', allowArbitraryFees: 'allow_arbitrary_fees',
  maxMultiplier: 'max_multiplier',
  penaltyRate: 'penalty_rate', penaltyRateMin: 'penalty_rate_min', penaltyRateMax: 'penalty_rate_max',
  penaltyBasis: 'penalty_basis', penaltyToleranceDays: 'penalty_tolerance_days',
  arrearsToleranceDays: 'arrears_tolerance_days', arrearsTolerancePercent: 'arrears_tolerance_percent',
  arrearsToleranceFloor: 'arrears_tolerance_floor', arrearsCountFrom: 'arrears_count_from',
  arrearsNonWorkingDays: 'arrears_non_working_days',
  chargeCapPercent: 'charge_cap_percent', chargeCapBase: 'charge_cap_base', chargeCapMode: 'charge_cap_mode',
  autoClosePaidOffDays: 'auto_close_paid_off_days', autoLockArrearsDays: 'auto_lock_arrears_days',
  accountingMethod: 'accounting_method', interestAccrual: 'interest_accrual', dayCount: 'day_count',
  interestAccruedAccounting: 'interest_accrued_accounting', accrualGranularity: 'accrual_granularity',
  allocationOrder: 'allocation_order',
  enforceDepositMultiplier: 'enforce_deposit_multiplier',
  requireGuarantorCover: 'require_guarantor_cover', minCoverPercent: 'min_cover_percent',
  glPortfolio: 'gl_portfolio', glInterestInc: 'gl_interest_inc', glFeeInc: 'gl_fee_inc',
  glPenaltyInc: 'gl_penalty_inc', glInterestRec: 'gl_interest_rec', glFeeRec: 'gl_fee_rec',
  glPenaltyRec: 'gl_penalty_rec', glWriteoffExp: 'gl_writeoff_exp', glRecoveries: 'gl_recoveries',
  isActive: 'is_active',
  maxTranches: 'max_tranches',
  revolvingRepaymentMethod: 'revolving_repayment_method', revolvingRepaymentValue: 'revolving_repayment_value',
  revolvingRepaymentFloor: 'revolving_repayment_floor', revolvingRepaymentCeiling: 'revolving_repayment_ceiling',
  creditBalanceEnabled: 'credit_balance_enabled', maxCreditBalance: 'max_credit_balance', glCreditBalance: 'gl_credit_balance',
  enableGuarantors: 'enable_guarantors', enableCollateral: 'enable_collateral',
  taxRatePercent: 'tax_rate_percent', taxMethod: 'tax_method', taxOnInterest: 'tax_on_interest', taxOnFees: 'tax_on_fees',
  taxOnPenalties: 'tax_on_penalties', glTaxPayable: 'gl_tax_payable',
  fundingEnabled: 'funding_enabled', funderAllocation: 'funder_allocation', orgCommission: 'org_commission',
  orgCommissionMin: 'org_commission_min', orgCommissionMax: 'org_commission_max',
  funderRateDefault: 'funder_rate_default', funderRateMin: 'funder_rate_min', funderRateMax: 'funder_rate_max',
  lockFundsAtApproval: 'lock_funds_at_approval',
};
// The old name for the penalty tolerance still works on the wire.
FIELDS.penaltyGraceDays = 'penalty_tolerance_days';

// Settings that change how a loan's interest is worked out. Frozen once a
// loan exists under the product.
const FROZEN_WITH_LOANS = ['product_type', 'method', 'interest_type', 'simple_base', 'interest_posting', 'interest_rate_source',
  'rate_frequency', 'day_count', 'repayment_interval_unit', 'repayment_interval_count', 'fixed_days_of_month',
  'tax_method', 'funding_enabled', 'funder_allocation'];

const num = (v) => (v === null || v === undefined ? null : Number(v));

const publicProduct = (p) => ({
  id: p.id, name: p.name, description: p.description, category: p.category,
  productType: p.product_type, method: p.method,
  interestType: p.interest_type, simpleBase: p.simple_base, interestPosting: p.interest_posting,
  rateFrequency: p.rate_frequency, monthlyRate: Number(p.monthly_rate), rate: Number(p.monthly_rate),
  rateMin: num(p.rate_min), rateMax: num(p.rate_max),
  annualRate: Math.round(require('../domain/schedule').annualRate(p.monthly_rate, p.rate_frequency, p.day_count) * 10000) / 100,
  prepaymentRecalculation: p.prepayment_recalculation, accrueLateInterest: p.accrue_late_interest,
  idPattern: p.id_pattern, idMode: p.id_mode, idNext: Number(p.id_next), initialState: p.initial_state,
  minPrincipal: num(p.min_principal), maxPrincipal: num(p.max_principal), defaultPrincipal: num(p.default_principal),
  minTerm: p.min_term, maxTerm: p.max_term, defaultTerm: p.default_term,
  repaymentIntervalUnit: p.repayment_interval_unit, repaymentIntervalCount: p.repayment_interval_count,
  fixedDaysOfMonth: p.fixed_days_of_month, shortMonthHandling: p.short_month_handling, nonWorkingDays: p.non_working_days,
  residualInstallment: p.residual_installment,
  interestRateSource: p.interest_rate_source, indexSourceId: p.index_source_id, rateFloor: num(p.rate_floor), rateCeiling: num(p.rate_ceiling),
  rateReviewCount: p.rate_review_count, rateReviewUnit: p.rate_review_unit, adjustableRates: p.adjustable_rates,
  allowedIndexSources: p.allowed_index_sources, allowNegativeRate: p.allow_negative_rate, scheduleEditing: p.schedule_editing || [],
  firstDueOffsetDays: p.first_due_offset_days, firstDueOffsetMin: p.first_due_offset_min, firstDueOffsetMax: p.first_due_offset_max,
  graceType: p.grace_type, gracePeriods: p.grace_periods, amortizationPeriods: p.amortization_periods, rounding: p.rounding,
  processingFee: Number(p.processing_fee), allowArbitraryFees: p.allow_arbitrary_fees,
  maxMultiplier: Number(p.max_multiplier),
  penaltyRate: Number(p.penalty_rate), penaltyRateMin: num(p.penalty_rate_min), penaltyRateMax: num(p.penalty_rate_max),
  penaltyBasis: p.penalty_basis, penaltyToleranceDays: p.penalty_tolerance_days, penaltyGraceDays: p.penalty_tolerance_days,
  arrearsToleranceDays: p.arrears_tolerance_days, arrearsTolerancePercent: num(p.arrears_tolerance_percent),
  arrearsToleranceFloor: num(p.arrears_tolerance_floor), arrearsCountFrom: p.arrears_count_from,
  arrearsNonWorkingDays: p.arrears_non_working_days,
  chargeCapPercent: num(p.charge_cap_percent), chargeCapBase: p.charge_cap_base, chargeCapMode: p.charge_cap_mode,
  autoClosePaidOffDays: p.auto_close_paid_off_days, autoLockArrearsDays: p.auto_lock_arrears_days,
  accountingMethod: p.accounting_method, interestAccrual: p.interest_accrual, dayCount: p.day_count,
  interestAccruedAccounting: p.interest_accrued_accounting, accrualGranularity: p.accrual_granularity,
  accountingRules: PA.resources('LOAN', p).filter((r) => r.used).map((r) => ({ resource: r.resource, glCode: r.glCode })),
  allocationOrder: p.allocation_order,
  enforceDepositMultiplier: p.enforce_deposit_multiplier,
  requireGuarantorCover: p.require_guarantor_cover, minCoverPercent: Number(p.min_cover_percent),
  gl: {
    portfolio: p.gl_portfolio, interestIncome: p.gl_interest_inc, feeIncome: p.gl_fee_inc,
    penaltyIncome: p.gl_penalty_inc, interestReceivable: p.gl_interest_rec,
    feeReceivable: p.gl_fee_rec, penaltyReceivable: p.gl_penalty_rec, writeOffExpense: p.gl_writeoff_exp, recoveries: p.gl_recoveries,
  },
  maxTranches: p.max_tranches,
  revolving: p.product_type === 'REVOLVING' ? {
    repaymentMethod: p.revolving_repayment_method, repaymentValue: num(p.revolving_repayment_value),
    repaymentFloor: num(p.revolving_repayment_floor), repaymentCeiling: num(p.revolving_repayment_ceiling),
    creditBalanceEnabled: p.credit_balance_enabled, maxCreditBalance: num(p.max_credit_balance), glCreditBalance: p.gl_credit_balance,
  } : null,
  securities: { guarantors: p.enable_guarantors, collateral: p.enable_collateral, requiredCoverPercent: p.require_guarantor_cover ? Number(p.min_cover_percent) : null },
  tax: { ratePercent: num(p.tax_rate_percent), method: p.tax_method, onInterest: p.tax_on_interest, onFees: p.tax_on_fees, onPenalties: p.tax_on_penalties, glTaxPayable: p.gl_tax_payable },
  funding: p.funding_enabled ? {
    allocation: p.funder_allocation, orgCommission: num(p.org_commission), orgCommissionMin: num(p.org_commission_min), orgCommissionMax: num(p.org_commission_max),
    funderRateDefault: num(p.funder_rate_default), funderRateMin: num(p.funder_rate_min), funderRateMax: num(p.funder_rate_max), lockFundsAtApproval: p.lock_funds_at_approval,
  } : null,
  isActive: p.is_active, updatedAt: p.updated_at,
  ...(p.fees ? { fees: p.fees.map(publicFee) } : {}),
});

const publicFee = (f) => ({
  id: f.id, code: f.code, name: f.name, feeType: f.fee_type, calculation: f.calculation,
  amount: num(f.amount), percent: num(f.percent), minAmount: num(f.min_amount), maxAmount: num(f.max_amount),
  required: f.required, glIncome: f.gl_income, glReceivable: f.gl_receivable, isActive: f.is_active, taxable: f.taxable,
});

const isBool = (v) => typeof v === 'boolean';
const isInt = (v) => Number.isInteger(Number(v));

async function validate(c, cols, { creating, before = null, loans = 0 }) {
  const problems = [];
  // Null clears a setting that may be unset (the revolving method on a
  // product that is not revolving); the rest must be one of the list.
  const NULLABLE_ENUMS = ['revolving_repayment_method', 'rate_review_unit'];
  for (const [col, allowed] of Object.entries(ENUMS)) {
    if (cols[col] === undefined) continue;
    if (cols[col] === null && NULLABLE_ENUMS.includes(col)) continue;
    if (!allowed.includes(cols[col])) problems.push(`${col} must be one of ${allowed.join(', ')}`);
  }
  const merged = { ...(before || {}), ...cols };
  const type = merged.product_type || 'FIXED_TERM';
  const method = merged.method || 'FLAT';

  if (before && cols.product_type !== undefined && cols.product_type !== before.product_type) {
    problems.push('product_type cannot be changed once a product exists; create a new product');
  }
  if (before && loans > 0) {
    const changed = FROZEN_WITH_LOANS.filter((k) => k !== 'product_type' && cols[k] !== undefined && JSON.stringify(cols[k]) !== JSON.stringify(before[k]));
    if (changed.length) problems.push(`${changed.join(', ')} cannot change while ${loans} loan(s) exist under the product; create a new product`);
  }
  if (cols.schedule_editing !== undefined) {
    const edits = cols.schedule_editing;
    const known = ['PAYMENT_DATES', 'PRINCIPAL', 'INTEREST', 'FEES', 'PAYMENT_HOLIDAYS', 'NUMBER_OF_INSTALLMENTS'];
    if (!Array.isArray(edits) || edits.some((x) => !known.includes(x))) problems.push(`schedule_editing lists any of ${known.join(', ')}`);
    else {
      const dynamic = ['DYNAMIC_TERM', 'TRANCHED'].includes(type);
      if (type === 'REVOLVING' && edits.length) problems.push('a REVOLVING loan has no schedule to edit');
      if (edits.includes('INTEREST') && dynamic) problems.push('a dynamic loan\'s interest follows its balance: INTEREST editing is for fixed-term products');
      if (edits.includes('NUMBER_OF_INSTALLMENTS') && !dynamic) problems.push('NUMBER_OF_INSTALLMENTS editing is for dynamic-term products');
      // As in Mambu, changing the number of installments brings dates and principal with it.
      if (edits.includes('NUMBER_OF_INSTALLMENTS')) cols.schedule_editing = [...new Set([...edits, 'PAYMENT_DATES', 'PRINCIPAL'])];
    }
  }
  if (merged.interest_rate_source === 'INDEX' || merged.adjustable_rates) {
    const what = merged.interest_rate_source === 'INDEX' ? 'an INDEX rate' : 'adjustable rates';
    if (method === 'FLAT') problems.push(`${what} cannot be FLAT: a flat product's interest is fixed from the start`);
    if (type === 'INTEREST_FREE') problems.push(`an INTEREST_FREE product cannot take ${what}`);
    const ids = [...new Set([...(merged.allowed_index_sources || []), ...(merged.index_source_id ? [merged.index_source_id] : [])])];
    if (ids.length) {
      const { rows: known } = await c.query('SELECT id FROM index_rate_sources WHERE id = ANY($1)', [ids]);
      const unknown = ids.filter((x) => !known.some((k) => k.id === x));
      if (unknown.length) problems.push(`unknown index rate source: ${unknown.join(', ')}`);
    }
  }
  if (merged.interest_rate_source === 'INDEX') {
    if (!merged.index_source_id) problems.push('an INDEX product needs index_source_id');
    if (!merged.rate_review_count || !merged.rate_review_unit) problems.push('an INDEX product needs rate_review_count and rate_review_unit');
  }
  if (merged.rate_floor !== null && merged.rate_floor !== undefined && merged.rate_ceiling !== null && merged.rate_ceiling !== undefined
    && Number(merged.rate_floor) > Number(merged.rate_ceiling)) problems.push('rate_floor exceeds rate_ceiling');
  if (['DYNAMIC_TERM', 'TRANCHED', 'REVOLVING'].includes(type) && method === 'FLAT') {
    problems.push(`a ${type} product cannot use the FLAT method; use REDUCING or REDUCING_EQUAL_INSTALLMENTS`);
  }
  if (type === 'REVOLVING' && merged.non_working_days === 'EXTEND_SCHEDULE') problems.push('a REVOLVING product bills on dates; EXTEND_SCHEDULE needs a schedule');
  if (type === 'TRANCHED' && (!merged.max_tranches || Number(merged.max_tranches) < 2)) problems.push('a TRANCHED product needs max_tranches of 2 or more');
  if (type === 'REVOLVING') {
    if (method !== 'REDUCING') problems.push('a REVOLVING product uses the REDUCING method');
    if (!merged.revolving_repayment_method || merged.revolving_repayment_value === null || merged.revolving_repayment_value === undefined) {
      problems.push('a REVOLVING product needs revolving_repayment_method and revolving_repayment_value');
    }
    if (merged.credit_balance_enabled && !merged.gl_credit_balance && merged.accounting_method !== 'NONE') problems.push('credit_balance_enabled needs gl_credit_balance');
  }
  const taxed = merged.tax_on_interest || merged.tax_on_fees || merged.tax_on_penalties;
  if (taxed && (merged.tax_rate_percent === null || merged.tax_rate_percent === undefined)) problems.push('taxing interest, fees or penalties needs tax_rate_percent');
  if (taxed && !merged.gl_tax_payable && merged.accounting_method !== 'NONE') problems.push('a taxed product linked to accounting needs gl_tax_payable');
  if (merged.funding_enabled) {
    if (!['FIXED_TERM', 'DYNAMIC_TERM'].includes(type)) problems.push('funding sources are available on FIXED_TERM and DYNAMIC_TERM products');
    if (merged.accounting_method === 'CASH') problems.push('a funded product uses ACCRUAL or NONE accounting');
    if (merged.org_commission === null || merged.org_commission === undefined) problems.push('a funded product needs org_commission');
  }
  if (type === 'INTEREST_FREE' && Number(merged.monthly_rate || 0) > 0) problems.push('an INTEREST_FREE product has no rate');
  if (merged.interest_type === 'CAPITALIZED' && type !== 'DYNAMIC_TERM') problems.push('CAPITALIZED interest needs a DYNAMIC_TERM product');
  const compounding = ['COMPOUND', 'COMPOUND_DAILY_REST'].includes(merged.interest_type);
  if (compounding && method === 'FLAT') problems.push(`${merged.interest_type} interest cannot be FLAT`);
  if (compounding && type === 'REVOLVING') problems.push(`${merged.interest_type} interest is not available on REVOLVING products`);
  if (merged.day_count === 'BUS_252' && merged.interest_type !== 'COMPOUND') problems.push('the BUS_252 day count needs COMPOUND interest');
  if (merged.simple_base === 'PRINCIPAL_AND_INTEREST' && !(type === 'DYNAMIC_TERM' && method === 'REDUCING_EQUAL_INSTALLMENTS')) {
    problems.push('PRINCIPAL_AND_INTEREST base needs a DYNAMIC_TERM, REDUCING_EQUAL_INSTALLMENTS product');
  }
  if (merged.interest_posting === 'ON_DISBURSEMENT' && type === 'DYNAMIC_TERM') problems.push('ON_DISBURSEMENT posting needs a FIXED_TERM product');

  for (const col of ['accrue_late_interest', 'enforce_deposit_multiplier', 'require_guarantor_cover', 'is_active', 'allow_arbitrary_fees',
    'credit_balance_enabled', 'enable_guarantors', 'enable_collateral', 'tax_on_interest', 'tax_on_fees', 'tax_on_penalties',
    'funding_enabled', 'lock_funds_at_approval', 'adjustable_rates', 'allow_negative_rate']) {
    if (cols[col] !== undefined && !isBool(cols[col])) problems.push(`${col} must be true or false`);
  }
  const nonNeg = ['monthly_rate', 'rate_min', 'rate_max', 'processing_fee', 'penalty_rate', 'penalty_rate_min', 'penalty_rate_max',
    'penalty_tolerance_days', 'arrears_tolerance_days', 'arrears_tolerance_percent', 'arrears_tolerance_floor',
    'min_principal', 'max_principal', 'default_principal', 'charge_cap_percent', 'first_due_offset_days', 'grace_periods',
    'revolving_repayment_value', 'revolving_repayment_floor', 'revolving_repayment_ceiling', 'max_credit_balance', 'tax_rate_percent',
    'org_commission', 'org_commission_min', 'org_commission_max', 'funder_rate_default', 'funder_rate_min', 'funder_rate_max'];
  // A product whose rate is an index plus a spread may allow a negative
  // spread (a discount on the index); its rate and band are the spread's.
  const spreadsMayBeNegative = merged.allow_negative_rate && (merged.interest_rate_source === 'INDEX' || merged.adjustable_rates);
  for (const col of nonNeg) {
    if (spreadsMayBeNegative && ['monthly_rate', 'rate_min', 'rate_max'].includes(col)) continue;
    if (cols[col] !== undefined && cols[col] !== null && !(Number(cols[col]) >= 0)) problems.push(`${col} must be zero or more`);
  }
  for (const col of ['max_term', 'min_term', 'default_term', 'repayment_interval_count', 'amortization_periods', 'auto_close_paid_off_days', 'auto_lock_arrears_days', 'id_next']) {
    if (cols[col] !== undefined && cols[col] !== null && !(isInt(cols[col]) && Number(cols[col]) > 0)) problems.push(`${col} must be a positive whole number`);
  }
  if (merged.min_term && merged.max_term && Number(merged.min_term) > Number(merged.max_term)) problems.push('min_term exceeds max_term');
  if (merged.min_principal && merged.max_principal && Number(merged.min_principal) > Number(merged.max_principal)) problems.push('min_principal exceeds max_principal');
  if (merged.rate_min !== null && merged.rate_max !== null && merged.rate_min !== undefined && merged.rate_max !== undefined
    && Number(merged.rate_min) > Number(merged.rate_max)) problems.push('rate_min exceeds rate_max');
  if (merged.amortization_periods && merged.max_term && Number(merged.amortization_periods) < Number(merged.max_term)) {
    problems.push('amortization_periods must be at least max_term (a balloon amortises over longer than the term)');
  }
  if (cols.max_multiplier !== undefined && !(Number(cols.max_multiplier) > 0)) problems.push('max_multiplier must be positive');
  if (cols.id_pattern !== undefined) {
    if (!/^[A-Za-z0-9#@$_-]{2,24}$/.test(cols.id_pattern) || !/[#@$]/.test(cols.id_pattern)) {
      problems.push('id_pattern must be 2 to 24 characters with at least one placeholder (# digit, @ letter, $ either)');
    }
  }
  if (cols.fixed_days_of_month !== undefined && cols.fixed_days_of_month !== null) {
    const d = cols.fixed_days_of_month;
    if (!Array.isArray(d) || !d.length || d.some((x) => !isInt(x) || x < 1 || x > 31)) problems.push('fixed_days_of_month must list days 1 to 31');
  }
  if (cols.allocation_order !== undefined) {
    const o = cols.allocation_order;
    const want = ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'];
    if (!Array.isArray(o) || o.length !== 4 || want.some((w) => !o.includes(w))) {
      problems.push('allocation_order must list PENALTY, FEE, INTEREST and PRINCIPAL once each');
    }
  }
  if (creating && !cols.name) problems.push('name is required');

  // The accounting method and GL mappings: which resources the product
  // needs follows from the method and the features switched on
  // (./domain/productAccounting). Changing the method, or when accrued
  // interest reaches the ledger, on a product with loans is a change of
  // accounting, done through POST /:id/accounting-method so that open
  // balances are converted rather than stranded.
  if (before && loans > 0) {
    const moved = ['accounting_method', 'interest_accrued_accounting'].filter((k) => cols[k] !== undefined && cols[k] !== before[k]);
    if (moved.length) problems.push(`ACCOUNTING_METHOD_CHANGES_THROUGH_CHANGE_ACTION: ${moved.join(', ')} cannot be edited while ${loans} loan(s) exist; use POST /api/loan-products/${before.id}/accounting-method`);
  }
  const base = before ? {} : await PA.tableDefaults(c, 'loan_products');
  const pa = await PA.validate(c, 'LOAN', { ...base, ...merged, accounting_method: merged.accounting_method || base.accounting_method || 'ACCRUAL' }, cols);
  problems.push(...pa.problems);
  Object.assign(cols, pa.fixes);
  return problems;
}

function toColumns(body) {
  const cols = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (FIELDS[k]) cols[FIELDS[k]] = v;
  }
  return cols;
}

async function loansUnder(c, productId) {
  const { rows: [r] } = await c.query('SELECT count(*)::int AS n FROM loan_accounts WHERE product_id = $1', [productId]);
  return r.n;
}

async function withFees(c, p) {
  const { rows } = await c.query('SELECT * FROM loan_product_fees WHERE product_id = $1 ORDER BY fee_type, code', [p.id]);
  return { ...p, fees: rows };
}

router.get('/', requireAuth(...READER), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT p.*, (SELECT count(*)::int FROM loan_accounts l WHERE l.product_id = p.id) AS loans,
              (SELECT count(*)::int FROM loan_product_fees f WHERE f.product_id = p.id AND f.is_active) AS fee_count
       FROM loan_products p ORDER BY p.id`)).rows);
    res.json(rows.map((p) => ({ ...publicProduct(p), loans: p.loans, feeCount: p.fee_count })));
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth(...READER), async (req, res, next) => {
  try {
    const row = await withTenantRead(req.tenant.schema_name, async (c) => {
      const p = (await c.query('SELECT * FROM loan_products WHERE id = $1', [req.params.id])).rows[0];
      return p ? withFees(c, p) : null;
    });
    return row ? res.json(publicProduct(row)) : notFound(res, 'loan product');
  } catch (e) { next(e); }
});

router.post('/', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const id = String(req.body?.id || '').trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,16}$/.test(id)) return badRequest(res, 'PRODUCT_ID_MUST_BE_2_TO_16_UPPERCASE_ALPHANUMERIC');
    const cols = toColumns(req.body);
    if (cols.product_type === 'INTEREST_FREE' && cols.monthly_rate === undefined) cols.monthly_rate = 0;
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const problems = await validate(c, cols, { creating: true });
      if (problems.length) return { problems };
      const keys = Object.keys(cols);
      const { rows } = await c.query(
        `INSERT INTO loan_products (id, ${keys.join(', ')})
         VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [id, ...keys.map((k) => cols[k])]
      );
      if (!rows.length) return { duplicate: true };
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, after)
         VALUES ($1,'LOAN_PRODUCT_CREATED','loan_product',$2,$3)`,
        [req.auth.email, id, JSON.stringify(rows[0])]);
      await PA.recordMappings(c, 'LOAN', id, null, rows[0], req.auth.email);
      return { row: await withFees(c, rows[0]) };
    });
    if (out.problems) return apiError(res, 400, 400, 'INVALID_LOAN_PRODUCT', out.problems.join('; '));
    if (out.duplicate) return apiError(res, 409, 409, 'LOAN_PRODUCT_EXISTS');
    res.status(201).json(publicProduct(out.row));
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const cols = toColumns(req.body);
    if (!Object.keys(cols).length) return badRequest(res, 'NO_UPDATABLE_FIELDS');
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [before] } = await c.query(
        'SELECT * FROM loan_products WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) return { missing: true };
      const loans = await loansUnder(c, before.id);
      const problems = await validate(c, cols, { creating: false, before, loans });
      if (problems.length) return { problems };
      const keys = Object.keys(cols);
      const { rows } = await c.query(
        `UPDATE loan_products SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [req.params.id, ...keys.map((k) => cols[k])]
      );
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
         VALUES ($1,'LOAN_PRODUCT_CHANGED','loan_product',$2,$3,$4)`,
        [req.auth.email, req.params.id, JSON.stringify(before), JSON.stringify(rows[0])]);
      await PA.recordMappings(c, 'LOAN', req.params.id, before, rows[0], req.auth.email);
      return { row: await withFees(c, rows[0]) };
    });
    if (out.missing) return notFound(res, 'loan product');
    if (out.problems) return apiError(res, 400, 400, 'INVALID_LOAN_PRODUCT', out.problems.join('; '));
    res.json(publicProduct(out.row));
  } catch (e) { next(e); }
});

// --- accounting method change and history ----------------------------------

router.post('/:id/accounting-method', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const b = req.body || {};
    const mappings = toColumns(b.mappings || {});
    for (const k of Object.keys(mappings)) if (!k.startsWith('gl_')) delete mappings[k];
    const out = await withTenant(req.tenant.schema_name, (c) => require('../domain/accountingChanges').changeLoanProduct(c, req.params.id, {
      method: b.accountingMethod, interestAccruedAccounting: b.interestAccruedAccounting, mappings, reason: b.reason, createdBy: req.auth.email,
    }));
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.get('/:id/accounting-changes', requireAuth(...READER), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => require('../domain/accountingChanges').history(c, 'LOAN', req.params.id)));
  } catch (e) { next(e); }
});

router.get('/:id/gl-mapping-history', requireAuth(...READER), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => PA.mappingHistory(c, 'LOAN', req.params.id)));
  } catch (e) { next(e); }
});

// --- fees -----------------------------------------------------------------

const FEE_FIELDS = {
  code: 'code', name: 'name', feeType: 'fee_type', calculation: 'calculation', amount: 'amount', percent: 'percent',
  minAmount: 'min_amount', maxAmount: 'max_amount', required: 'required', glIncome: 'gl_income',
  glReceivable: 'gl_receivable', glWriteOff: 'gl_writeoff', isActive: 'is_active', taxable: 'taxable',
};
const FEE_ENUMS = {
  fee_type: ['MANUAL', 'DISBURSEMENT_DEDUCTED', 'DISBURSEMENT_CAPITALIZED', 'DISBURSEMENT_UPFRONT', 'PAYMENT_DUE', 'LATE_REPAYMENT'],
  calculation: ['FLAT', 'FLAT_PER_INSTALLMENT', 'PERCENT_OF_AMOUNT', 'PERCENT_PER_INSTALLMENT', 'PERCENT_OF_INSTALLMENT_PRINCIPAL'],
};
const FITS = {
  MANUAL: ['FLAT', 'PERCENT_OF_AMOUNT'], DISBURSEMENT_DEDUCTED: ['FLAT', 'PERCENT_OF_AMOUNT'],
  DISBURSEMENT_CAPITALIZED: ['FLAT', 'PERCENT_OF_AMOUNT'], DISBURSEMENT_UPFRONT: ['FLAT', 'PERCENT_OF_AMOUNT'],
  PAYMENT_DUE: ['FLAT', 'FLAT_PER_INSTALLMENT', 'PERCENT_OF_AMOUNT', 'PERCENT_PER_INSTALLMENT'],
  LATE_REPAYMENT: ['FLAT', 'PERCENT_OF_AMOUNT', 'PERCENT_OF_INSTALLMENT_PRINCIPAL'],
};

async function validateFee(c, cols, before) {
  const problems = [];
  const m = { ...(before || {}), ...cols };
  for (const [col, allowed] of Object.entries(FEE_ENUMS)) {
    if (cols[col] !== undefined && !allowed.includes(cols[col])) problems.push(`${col} must be one of ${allowed.join(', ')}`);
  }
  if (!before && (!cols.code || !/^[A-Z0-9_]{2,16}$/.test(cols.code))) problems.push('code must be 2 to 16 uppercase letters, digits or underscore');
  if (!before && !cols.name) problems.push('name is required');
  if (m.fee_type && m.calculation && FITS[m.fee_type] && !FITS[m.fee_type].includes(m.calculation)) {
    problems.push(`${m.fee_type} fees may be ${FITS[m.fee_type].join(', ')}`);
  }
  const flat = ['FLAT', 'FLAT_PER_INSTALLMENT'].includes(m.calculation);
  if (flat && (m.amount === null || m.amount === undefined) && m.fee_type !== 'MANUAL') problems.push('a flat fee needs an amount (only a MANUAL fee may leave it to the teller)');
  if (!flat && m.calculation && (m.percent === null || m.percent === undefined)) problems.push('a percentage fee needs a percent');
  for (const col of ['amount', 'percent', 'min_amount', 'max_amount']) {
    if (cols[col] !== undefined && cols[col] !== null && !(Number(cols[col]) >= 0)) problems.push(`${col} must be zero or more`);
  }
  if (m.min_amount !== null && m.max_amount !== null && m.min_amount !== undefined && m.max_amount !== undefined
    && Number(m.min_amount) > Number(m.max_amount)) problems.push('min_amount exceeds max_amount');
  for (const col of ['required', 'is_active', 'taxable']) {
    if (cols[col] !== undefined && !isBool(cols[col])) problems.push(`${col} must be true or false`);
  }
  // A fee's own accounts: income (or a liability, for fees collected for a
  // third party), receivable and write-off. Detail accounts only.
  problems.push(...await PA.validateFeeAccounts(c, cols));
  return problems;
}

const feeCols = (body) => Object.fromEntries(Object.entries(body || {}).filter(([k]) => FEE_FIELDS[k]).map(([k, v]) => [FEE_FIELDS[k], v]));

router.get('/:id/fees', requireAuth(...READER), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      'SELECT * FROM loan_product_fees WHERE product_id = $1 ORDER BY fee_type, code', [req.params.id])).rows);
    res.json(rows.map(publicFee));
  } catch (e) { next(e); }
});

router.post('/:id/fees', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const cols = feeCols(req.body);
    if (cols.code) cols.code = String(cols.code).toUpperCase();
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [p] } = await c.query('SELECT id FROM loan_products WHERE id = $1', [req.params.id]);
      if (!p) return { missing: true };
      const problems = await validateFee(c, cols, null);
      if (problems.length) return { problems };
      const keys = Object.keys(cols);
      const { rows } = await c.query(
        `INSERT INTO loan_product_fees (product_id, ${keys.join(', ')})
         VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (product_id, code) DO NOTHING RETURNING *`,
        [p.id, ...keys.map((k) => cols[k])]);
      if (!rows.length) return { duplicate: true };
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'LOAN_PRODUCT_FEE_CREATED','loan_product_fee',$2,$3)`,
        [req.auth.email, rows[0].id, JSON.stringify(rows[0])]);
      return { row: rows[0] };
    });
    if (out.missing) return notFound(res, 'loan product');
    if (out.problems) return apiError(res, 400, 400, 'INVALID_FEE', out.problems.join('; '));
    if (out.duplicate) return apiError(res, 409, 409, 'FEE_CODE_EXISTS');
    res.status(201).json(publicFee(out.row));
  } catch (e) { next(e); }
});

router.patch('/:id/fees/:feeId', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const cols = feeCols(req.body);
    delete cols.code;
    if (!Object.keys(cols).length) return badRequest(res, 'NO_UPDATABLE_FIELDS');
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [before] } = await c.query(
        'SELECT * FROM loan_product_fees WHERE product_id = $1 AND (id::text = $2 OR code = $2) FOR UPDATE',
        [req.params.id, req.params.feeId]);
      if (!before) return { missing: true };
      // A fee that has been applied keeps its type and calculation; the
      // figures and GL accounts may still move. Mambu allows deactivating,
      // never deleting, a used fee.
      const { rows: [used] } = await c.query('SELECT count(*)::int AS n FROM loan_fees WHERE product_fee_id = $1', [before.id]);
      if (used.n > 0) {
        const frozen = ['fee_type', 'calculation'].filter((k) => cols[k] !== undefined && cols[k] !== before[k]);
        if (frozen.length) return { problems: [`${frozen.join(', ')} cannot change on a fee that has been applied ${used.n} time(s); deactivate it and add another`] };
      }
      const problems = await validateFee(c, cols, before);
      if (problems.length) return { problems };
      const keys = Object.keys(cols);
      const { rows } = await c.query(
        `UPDATE loan_product_fees SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [before.id, ...keys.map((k) => cols[k])]);
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'LOAN_PRODUCT_FEE_CHANGED','loan_product_fee',$2,$3,$4)`,
        [req.auth.email, before.id, JSON.stringify(before), JSON.stringify(rows[0])]);
      return { row: rows[0] };
    });
    if (out.missing) return notFound(res, 'fee');
    if (out.problems) return apiError(res, 400, 400, 'INVALID_FEE', out.problems.join('; '));
    res.json(publicFee(out.row));
  } catch (e) { next(e); }
});

router.delete('/:id/fees/:feeId', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [f] } = await c.query(
        'SELECT * FROM loan_product_fees WHERE product_id = $1 AND (id::text = $2 OR code = $2) FOR UPDATE', [req.params.id, req.params.feeId]);
      if (!f) return { missing: true };
      const { rows: [used] } = await c.query('SELECT count(*)::int AS n FROM loan_fees WHERE product_fee_id = $1', [f.id]);
      if (used.n > 0) return { used: used.n };
      await c.query('DELETE FROM loan_product_fees WHERE id = $1', [f.id]);
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'LOAN_PRODUCT_FEE_DELETED','loan_product_fee',$2,$3)`,
        [req.auth.email, f.id, JSON.stringify(f)]);
      return { ok: true };
    });
    if (out.missing) return notFound(res, 'fee');
    if (out.used) return apiError(res, 409, 409, 'FEE_HAS_BEEN_APPLIED', `applied ${out.used} time(s); deactivate it instead`);
    res.status(204).end();
  } catch (e) { next(e); }
});

// --- schedule preview -----------------------------------------------------

router.post('/:id/schedule-preview', requireAuth(...READER), async (req, res, next) => {
  try {
    const out = await withTenantRead(req.tenant.schema_name, (c) =>
      require('../domain/loans').previewSchedule(c, { ...req.body, productId: req.params.id }));
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.publicProduct = publicProduct;
module.exports.ENUMS = ENUMS;
