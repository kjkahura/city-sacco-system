'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { apiError, badRequest, notFound } = require('../lib/http');
const PA = require('../domain/productAccounting');
const B = require('../domain/branches');
const CF = require('../domain/customFields');
const AC = require('../domain/accountingChanges');
const CA = require('../domain/creditArrangements');
const DR = require('../domain/depositRules');
const { json } = require('../lib/handlers');

/**
 * Deposit products: interest, withholding tax, overdrafts, fees, and the
 * accounting method with its GL mappings (see ../domain/productAccounting
 * for which mappings each setting requires).
 */

const router = express.Router();

const FIELDS = {
  name: 'name', description: 'description', isActive: 'is_active',
  annualRate: 'annual_rate', minBalance: 'min_balance', withdrawable: 'withdrawable', isFundingAccount: 'is_funding_account',
  accountingMethod: 'accounting_method', interestAccruedAccounting: 'interest_accrued_accounting', accrualGranularity: 'accrual_granularity',
  interestPaidIntoAccount: 'interest_paid_into_account', interestCalcBalance: 'interest_calc_balance',
  interestDayCount: 'interest_day_count', interestApplication: 'interest_application',
  minBalanceForInterest: 'min_balance_for_interest', allowNegativeRate: 'allow_negative_rate',
  withholdingTaxPercent: 'withholding_tax_percent',
  allowOverdraft: 'allow_overdraft', maxOverdraftLimit: 'max_overdraft_limit', overdraftAnnualRate: 'overdraft_annual_rate',
  allowTechnicalOverdraft: 'allow_technical_overdraft',
  glSavingsControl: 'gl_liability', glLiability: 'gl_liability', glInterestExpense: 'gl_interest_exp', glInterestExp: 'gl_interest_exp',
  glInterestPayable: 'gl_interest_payable', glFeeIncome: 'gl_fee_inc', glFeeInc: 'gl_fee_inc', glTaxPayable: 'gl_tax_payable',
  glNegativeInterestIncome: 'gl_neg_interest_inc', glNegativeInterestReceivable: 'gl_neg_interest_rec',
  glOverdraftPortfolio: 'gl_od_portfolio', glOverdraftWriteOff: 'gl_od_writeoff',
  glOverdraftInterestIncome: 'gl_od_interest_inc', glOverdraftInterestReceivable: 'gl_od_interest_rec',
  // Deposit Products (the reference platform): type, numbering, interest, limits, term, dormancy, fees, overdraft interest.
  productType: 'product_type', category: 'category', idGeneratorType: 'id_generator_type', idPattern: 'id_pattern',
  interestRateTerms: 'interest_rate_terms', interestRateMin: 'interest_rate_min', interestRateMax: 'interest_rate_max',
  interestRateFrequency: 'interest_rate_frequency', interestRateXDays: 'interest_rate_x_days',
  interestIndexSourceId: 'interest_index_source_id', interestSpreadMin: 'interest_spread_min', interestSpreadMax: 'interest_spread_max',
  interestSpreadDefault: 'interest_spread_default', interestRateTiers: 'interest_rate_tiers', interestMaxBalance: 'interest_max_balance',
  interestFixedDates: 'interest_fixed_dates', collectInterestWhenLocked: 'collect_interest_when_locked',
  accrueInterestAfterMaturity: 'accrue_interest_after_maturity', recommendedDepositAmount: 'recommended_deposit_amount',
  maxWithdrawalAmount: 'max_withdrawal_amount', minOpeningBalance: 'min_opening_balance', maxOpeningBalance: 'max_opening_balance',
  defaultOpeningBalance: 'default_opening_balance', termUnit: 'term_unit', termMin: 'term_min', termMax: 'term_max',
  termDefault: 'term_default', dormancyDays: 'dormancy_days', allowArbitraryFees: 'allow_arbitrary_fees',
  overdraftRateTerms: 'od_rate_terms', overdraftRateMin: 'od_rate_min', overdraftRateMax: 'od_rate_max',
  overdraftIndexSourceId: 'od_index_source_id', overdraftSpreadMin: 'od_spread_min', overdraftSpreadMax: 'od_spread_max',
  overdraftSpreadDefault: 'od_spread_default', overdraftRateTiers: 'od_rate_tiers', overdraftDayCount: 'od_day_count',
  overdraftCalcBalance: 'od_calc_balance',
  // Deposit Accounts (the reference platform): the state a new account starts in, and offset.
  initialState: 'initial_state', allowOffset: 'allow_offset',
  // The reference platform's Interest Rate Review Frequency, for index rates.
  interestReviewCount: 'interest_review_count', interestReviewUnit: 'interest_review_unit',
  overdraftReviewCount: 'od_review_count', overdraftReviewUnit: 'od_review_unit',
};
const ENUMS = {
  interest_calc_balance: DR.BALANCES,
  interest_day_count: DR.DAY_COUNTS,
  interest_application: DR.APPLICATIONS,
  initial_state: ['ACTIVE', 'PENDING_APPROVAL', 'APPROVED'],
};
const BOOLS = ['is_active', 'withdrawable', 'is_funding_account', 'interest_paid_into_account', 'allow_negative_rate',
  'allow_overdraft', 'allow_technical_overdraft', 'collect_interest_when_locked', 'accrue_interest_after_maturity', 'allow_arbitrary_fees', 'allow_offset'];
// Settings that change how interest is worked out or what the account is,
// frozen once accounts exist.
const FROZEN_WITH_ACCOUNTS = ['is_funding_account', 'interest_calc_balance', 'interest_day_count'];

const num = (v) => (v === null || v === undefined ? null : Number(v));

const publicProduct = (p) => ({
  id: p.id, name: p.name, description: p.description, isActive: p.is_active, isFundingAccount: p.is_funding_account,
  productType: p.product_type, category: p.category,
  newAccounts: { idGeneratorType: p.id_generator_type || null, idPattern: p.id_pattern || null },
  limits: {
    recommendedDepositAmount: num(p.recommended_deposit_amount), maxWithdrawalAmount: num(p.max_withdrawal_amount),
    openingBalance: { min: num(p.min_opening_balance), max: num(p.max_opening_balance), default: num(p.default_opening_balance) },
  },
  term: p.term_unit ? { unit: p.term_unit, min: p.term_min, max: p.term_max, default: p.term_default } : null,
  dormancyDays: p.dormancy_days ?? null, allowArbitraryFees: p.allow_arbitrary_fees,
  initialState: p.initial_state || 'ACTIVE', allowOffset: Boolean(p.allow_offset),
  availableBranches: p.branch_ids || null, availableFor: p.available_for || ['INDIVIDUALS'], withholdingSourceId: p.withholding_source_id || null, customFields: p.custom_fields || {},
  creditArrangementRequirement: p.credit_arrangement_requirement || 'NOT_REQUIRED',
  withdrawable: p.withdrawable, minBalance: Number(p.min_balance),
  interest: {
    paidIntoAccount: p.interest_paid_into_account, annualRate: Number(p.annual_rate), calcBalance: p.interest_calc_balance,
    dayCount: p.interest_day_count, application: p.interest_application, minBalanceForInterest: num(p.min_balance_for_interest),
    allowNegativeRate: p.allow_negative_rate, withholdingTaxPercent: num(p.withholding_tax_percent),
    rateTerms: p.interest_rate_terms, rateMin: num(p.interest_rate_min), rateMax: num(p.interest_rate_max),
    rateFrequency: p.interest_rate_frequency, rateXDays: p.interest_rate_x_days ?? null,
    indexSourceId: p.interest_index_source_id || null,
    spread: { min: num(p.interest_spread_min), max: num(p.interest_spread_max), default: num(p.interest_spread_default) },
    tiers: p.interest_rate_tiers || [], maxBalance: num(p.interest_max_balance), fixedDates: p.interest_fixed_dates || [],
    collectWhenLocked: p.collect_interest_when_locked, accrueAfterMaturity: p.accrue_interest_after_maturity,
    review: p.interest_review_count ? { count: p.interest_review_count, unit: p.interest_review_unit } : null,
  },
  overdraft: {
    allowed: p.allow_overdraft, maxLimit: num(p.max_overdraft_limit), annualRate: Number(p.overdraft_annual_rate),
    technicalAllowed: p.allow_technical_overdraft,
    rateTerms: p.od_rate_terms, rateMin: num(p.od_rate_min), rateMax: num(p.od_rate_max), indexSourceId: p.od_index_source_id || null,
    spread: { min: num(p.od_spread_min), max: num(p.od_spread_max), default: num(p.od_spread_default) },
    tiers: p.od_rate_tiers || [], dayCount: p.od_day_count || p.interest_day_count, calcBalance: p.od_calc_balance,
    review: p.od_review_count ? { count: p.od_review_count, unit: p.od_review_unit } : null,
  },
  accountingMethod: p.accounting_method, interestAccruedAccounting: p.interest_accrued_accounting,
  accrualGranularity: p.accrual_granularity,
  accountingRules: PA.resources('DEPOSIT', p).filter((r) => r.used).map((r) => ({ resource: r.resource, glCode: r.glCode })),
  gl: {
    savingsControl: p.gl_liability, interestExpense: p.gl_interest_exp, interestPayable: p.gl_interest_payable,
    feeIncome: p.gl_fee_inc, taxPayable: p.gl_tax_payable, negativeInterestIncome: p.gl_neg_interest_inc,
    negativeInterestReceivable: p.gl_neg_interest_rec, overdraftPortfolio: p.gl_od_portfolio,
    overdraftWriteOff: p.gl_od_writeoff, overdraftInterestIncome: p.gl_od_interest_inc,
    overdraftInterestReceivable: p.gl_od_interest_rec,
  },
  fees: (p.fees || []).map((f) => ({ id: f.id, code: f.code, name: f.name, trigger: f.trigger, applyDateMethod: f.apply_date_method || null,
    amount: num(f.amount), glIncome: f.gl_income, isActive: f.is_active })),
  accounts: p.accounts === undefined ? undefined : p.accounts,
});

// The reference platform's "available for": INDIVIDUALS and GROUPS (PURE_GROUPS is read as GROUPS).
function availableFor(body) {
  const v = body.availableFor !== undefined ? body.availableFor : body.availabilitySettings?.availableFor;
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  const out = [...new Set(list.map((x) => (String(x).toUpperCase() === 'PURE_GROUPS' ? 'GROUPS' : String(x).toUpperCase())))];
  if (!out.length || out.some((x) => !['INDIVIDUALS', 'GROUPS'].includes(x))) {
    throw Object.assign(new Error('AVAILABLE_FOR_IS_A_LIST_OF: INDIVIDUALS, GROUPS'), { status: 400 });
  }
  return out;
}

function toColumns(body) {
  const cols = {};
  for (const [k, v] of Object.entries(body || {})) if (FIELDS[k]) cols[FIELDS[k]] = v;
  if (body && body.availableBranches !== undefined) cols.branch_ids = body.availableBranches;
  if (body && body.withholdingSourceId !== undefined) cols.withholding_source_id = body.withholdingSourceId;
  if (body) { const af = availableFor(body); if (af !== undefined) cols.available_for = af; }
  if (body && body.creditArrangementRequirement !== undefined) cols.credit_arrangement_requirement = body.creditArrangementRequirement;
  for (const k of ['interest_rate_tiers', 'od_rate_tiers']) if (cols[k] !== undefined) cols[k] = JSON.stringify(cols[k] || []);
  for (const k of ['interest_review_unit', 'od_review_unit', 'initial_state', 'product_type', 'category', 'id_generator_type', 'interest_rate_terms', 'interest_rate_frequency', 'term_unit', 'od_rate_terms']) {
    if (typeof cols[k] === 'string') cols[k] = cols[k].toUpperCase();
  }
  for (const k of ['interest_index_source_id', 'od_index_source_id']) if (typeof cols[k] === 'string') cols[k] = cols[k].toUpperCase();
  return cols;
}

async function accountsUnder(c, id) {
  const { rows: [r] } = await c.query('SELECT count(*)::int AS n FROM savings_accounts WHERE product_id = $1', [id]);
  return r.n;
}

async function validate(c, cols, { before = null, accounts = 0 } = {}) {
  const problems = [];
  for (const [col, allowed] of Object.entries(ENUMS)) {
    if (cols[col] !== undefined && !allowed.includes(cols[col])) problems.push(`${col} must be one of ${allowed.join(', ')}`);
  }
  for (const col of BOOLS) if (cols[col] !== undefined && typeof cols[col] !== 'boolean') problems.push(`${col} must be true or false`);
  for (const col of ['min_balance', 'min_balance_for_interest', 'max_overdraft_limit', 'overdraft_annual_rate']) {
    if (cols[col] !== undefined && cols[col] !== null && !(Number(cols[col]) >= 0)) problems.push(`${col} must be zero or more`);
  }
  if (cols.withholding_tax_percent !== undefined && cols.withholding_tax_percent !== null
    && !(Number(cols.withholding_tax_percent) >= 0 && Number(cols.withholding_tax_percent) <= 100)) problems.push('withholding_tax_percent must be 0 to 100');
  // The type follows the settings where the request does not name one: a
  // funding product is an investor account, and a product given overdrafts
  // a current account (the reference platform's definition); a fixed deposit or savings plan
  // posts interest on maturity unless told otherwise.
  const base = { ...(before ? {} : await PA.tableDefaults(c, 'savings_products')), ...(before || {}) };
  if (cols.product_type === undefined) {
    if (cols.is_funding_account === true) cols.product_type = 'INVESTOR_ACCOUNT';
    else if (cols.is_funding_account === false && base.product_type === 'INVESTOR_ACCOUNT') cols.product_type = 'SAVINGS_ACCOUNT';
    else if ((cols.allow_overdraft === true || cols.allow_technical_overdraft === true) && (!before || base.product_type === 'SAVINGS_ACCOUNT')) cols.product_type = 'CURRENT_ACCOUNT';
  }
  if (cols.product_type !== undefined && cols.is_funding_account === undefined) cols.is_funding_account = cols.product_type === 'INVESTOR_ACCOUNT';
  if (!before && DR.hasTerm(cols.product_type) && cols.interest_application === undefined) cols.interest_application = 'ON_MATURITY';
  const m = { ...base, ...cols };
  if (typeof m.interest_rate_tiers === 'string') m.interest_rate_tiers = JSON.parse(m.interest_rate_tiers);
  if (typeof m.od_rate_tiers === 'string') m.od_rate_tiers = JSON.parse(m.od_rate_tiers);
  problems.push(...DR.productProblems(m, cols, { before, accounts }));
  for (const [col, kind] of [['interest_index_source_id', 'INTEREST'], ['od_index_source_id', 'INTEREST']]) {
    if (cols[col]) {
      const { rows: [src] } = await c.query('SELECT kind FROM index_rate_sources WHERE id = $1', [cols[col]]);
      if (!src || src.kind !== kind) problems.push(`${col} must be an interest rate source`);
    }
  }
  if (m.annual_rate !== undefined && m.annual_rate !== null && Number(m.annual_rate) < 0 && !m.allow_negative_rate) {
    problems.push('a negative annual_rate needs allow_negative_rate');
  }
  if (m.allow_overdraft === false && m.max_overdraft_limit) problems.push('max_overdraft_limit needs allow_overdraft');
  // An index rate's review frequency: a whole number of DAYS, WEEKS or MONTHS, both given, on an INDEX rate.
  for (const [cnt, unit, terms, what] of [['interest_review_count', 'interest_review_unit', 'interest_rate_terms', 'the interest rate'],
    ['od_review_count', 'od_review_unit', 'od_rate_terms', 'the overdraft rate']]) {
    if (cols[cnt] === undefined && cols[unit] === undefined) continue;
    const n = m[cnt];
    if ((n === null || n === undefined) !== (m[unit] === null || m[unit] === undefined)) problems.push(`${cnt} and ${unit} are given together`);
    else if (n !== null && n !== undefined) {
      if (!(Number.isInteger(Number(n)) && Number(n) > 0)) problems.push(`${cnt} is a whole number above zero`);
      if (!DR.REVIEW_UNITS.includes(m[unit])) problems.push(`${unit} must be one of ${DR.REVIEW_UNITS.join(', ')}`);
      if (m[terms] !== 'INDEX') problems.push(`a review frequency is for an INDEX rate: ${what} is ${m[terms] || 'FIXED'}`);
    }
  }
  if (!before && !cols.name) problems.push('name is required');
  if (before && accounts > 0) {
    const changed = FROZEN_WITH_ACCOUNTS.filter((k) => cols[k] !== undefined && cols[k] !== before[k]);
    if (changed.length) problems.push(`${changed.join(', ')} cannot change while ${accounts} account(s) exist; create a new product`);
    const moved = ['accounting_method', 'interest_accrued_accounting'].filter((k) => cols[k] !== undefined && cols[k] !== before[k]);
    if (moved.length) problems.push(`ACCOUNTING_METHOD_CHANGES_THROUGH_CHANGE_ACTION: ${moved.join(', ')} cannot be edited while ${accounts} account(s) exist; use POST /api/deposit-products/${before.id}/accounting-method`);
    if (cols.allow_overdraft === false && before.allow_overdraft) {
      const { rows: [o] } = await c.query('SELECT count(*)::int AS n FROM savings_accounts WHERE product_id = $1 AND (overdraft_limit > 0 OR balance < 0)', [before.id]);
      if (o.n) problems.push(`allow_overdraft cannot be turned off while ${o.n} account(s) have an overdraft`);
    }
    if (cols.allow_offset === false && before.allow_offset) {
      const { rows: [o] } = await c.query(
        `SELECT count(*)::int AS n FROM loan_accounts l JOIN loan_products lp ON lp.id = l.product_id JOIN savings_accounts a ON a.id = l.settlement_account_id
          WHERE a.product_id = $1 AND lp.offset_enabled AND l.status NOT LIKE 'CLOSED%'`, [before.id]);
      if (o.n) problems.push(`allow_offset cannot be turned off while its accounts offset ${o.n} loan(s)`);
    }
  }
  const pa = await PA.validate(c, 'DEPOSIT', m, cols);
  problems.push(...pa.problems);
  Object.assign(cols, pa.fixes);
  return problems;
}

async function withFees(c, p) {
  const { rows } = await c.query('SELECT * FROM savings_product_fees WHERE product_id = $1 ORDER BY code', [p.id]);
  return { ...p, fees: rows };
}

/**
 * A change to the product's rates, for the accounts it already has (the reference platform):
 * the credit rate reaches all existing accounts (applyTo ALL_ACCOUNTS, the
 * default: each follows the product's rate again) or new accounts only
 * (NEW_ACCOUNTS: each existing account keeps the rate it had). The new rate
 * accrues from the next accrual; what has accrued stays. The overdraft rate
 * reaches new accounts only, as in the reference platform.
 */
async function rateChanges(c, before, cols, body, { actor }) {
  const scope = String(body.applyTo || 'ALL_ACCOUNTS').toUpperCase();
  if (!['ALL_ACCOUNTS', 'NEW_ACCOUNTS'].includes(scope)) throw Object.assign(new Error('APPLY_TO_IS_ALL_ACCOUNTS_OR_NEW_ACCOUNTS'), { status: 400 });
  const today = (await c.query('SELECT current_date::text AS d')).rows[0].d;
  const open = "status NOT IN ('CLOSED')";
  if (cols.annual_rate !== undefined && Number(cols.annual_rate) !== Number(before.annual_rate)) {
    if (scope === 'NEW_ACCOUNTS') {
      if ((before.interest_rate_terms || 'FIXED') !== 'FIXED') {
        throw Object.assign(new Error('NEW_ACCOUNTS_ONLY_IS_FOR_A_FIXED_RATE: tiered and index products change for every account'), { status: 400 });
      }
      await c.query(`UPDATE savings_accounts SET interest_rate = $2 WHERE product_id = $1 AND interest_rate IS NULL AND ${open}`, [before.id, before.annual_rate]);
    } else {
      await c.query(`UPDATE savings_accounts SET interest_rate = NULL WHERE product_id = $1 AND ${open}`, [before.id]);
    }
    await c.query(`INSERT INTO savings_interest_rate_changes (product_id, kind, scope, value_date, old_rate, new_rate, notes, created_by)
      VALUES ($1,'CREDIT',$2,$3,$4,$5,$6,$7)`, [before.id, scope, today, before.annual_rate, cols.annual_rate, body.notes || null, actor]);
  }
  if (cols.overdraft_annual_rate !== undefined && Number(cols.overdraft_annual_rate) !== Number(before.overdraft_annual_rate)) {
    await c.query(`UPDATE savings_accounts SET overdraft_rate = $2 WHERE product_id = $1 AND overdraft_rate IS NULL AND ${open}`,
      [before.id, before.overdraft_annual_rate]);
    await c.query(`INSERT INTO savings_interest_rate_changes (product_id, kind, scope, value_date, old_rate, new_rate, notes, created_by)
      VALUES ($1,'OVERDRAFT','NEW_ACCOUNTS',$2,$3,$4,$5,$6)`, [before.id, today, before.overdraft_annual_rate, cols.overdraft_annual_rate, body.notes || null, actor]);
  }
}

// A product that never had an account is deleted (the reference platform); one that had is deactivated instead.
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [p] } = await c.query('SELECT * FROM savings_products WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!p) return { missing: true };
      const n = await accountsUnder(c, p.id);
      if (n) return { used: n };
      await c.query('SAVEPOINT product_delete');
      try {
        await c.query('DELETE FROM savings_interest_rate_changes WHERE product_id = $1', [p.id]);
        await c.query('DELETE FROM savings_product_fees WHERE product_id = $1', [p.id]);
        await c.query('DELETE FROM savings_products WHERE id = $1', [p.id]);
        await c.query('RELEASE SAVEPOINT product_delete');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT product_delete');
        if (e.code === '23503') return { referenced: e.table };
        throw e;
      }
      await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'DEPOSIT_PRODUCT_DELETED','savings_product',$2,$3)`,
        [req.auth.email, p.id, JSON.stringify(p)]);
      return { ok: true };
    });
    if (out.missing) return notFound(res, 'deposit product');
    if (out.used) return apiError(res, 409, 409, `PRODUCT_HAS_ACCOUNTS: ${out.used}; deactivate it instead`);
    if (out.referenced) return apiError(res, 409, 409, `PRODUCT_IS_REFERENCED: ${out.referenced}`);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT p.*, (SELECT count(*)::int FROM savings_accounts a WHERE a.product_id = p.id) AS accounts
       FROM savings_products p ORDER BY p.id`)).rows);
    res.json(rows.map(publicProduct));
  } catch (e) { next(e); }
});

// The mappings a product would need for a method and features, before it is
// saved: what the console shows as the form changes.
router.post('/accounting-rules', requireAuth(), async (req, res, next) => {
  try {
    const p = { accounting_method: 'CASH', interest_accrued_accounting: 'NONE', ...toColumns(req.body) };
    res.json(PA.resources('DEPOSIT', p).map((r) => ({ resource: r.resource, column: r.column, types: r.types, used: r.used, glCode: r.glCode })));
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const row = await withTenantRead(req.tenant.schema_name, async (c) => {
      const p = (await c.query(
        'SELECT p.*, (SELECT count(*)::int FROM savings_accounts a WHERE a.product_id = p.id) AS accounts FROM savings_products p WHERE p.id = $1',
        [req.params.id])).rows[0];
      return p ? withFees(c, p) : null;
    });
    return row ? res.json(publicProduct(row)) : notFound(res, 'deposit product');
  } catch (e) { next(e); }
});

/**
 * Branch availability (IDs or codes; null for every branch), the
 * withholding tax source (its value becomes the product's percentage, ./rates
 * updateTaxRates) and the product's custom field values.
 */
async function resolveExtras(c, cols, body, { user, before = null } = {}) {
  if (cols.branch_ids !== undefined) cols.branch_ids = await B.resolveBranchIds(c, cols.branch_ids);
  if (cols.withholding_source_id !== undefined) {
    if (cols.withholding_source_id) {
      const { rows: [src] } = await c.query('SELECT * FROM index_rate_sources WHERE id = $1', [String(cols.withholding_source_id).toUpperCase()]);
      if (!src || src.kind !== 'WITHHOLDING') throw Object.assign(new Error(`WITHHOLDING_SOURCE_MUST_BE_A_WITHHOLDING_RATE_SOURCE: ${cols.withholding_source_id}`), { status: 400 });
      cols.withholding_source_id = src.id;
      const { rows: [r] } = await c.query('SELECT rate FROM index_rates WHERE source_id = $1 AND valid_from <= current_date ORDER BY valid_from DESC LIMIT 1', [src.id]);
      if (r) cols.withholding_tax_percent = Number(r.rate);
    } else cols.withholding_source_id = null;
  }
  if (!before || (body && body.customFields !== undefined)) {
    cols.custom_fields = JSON.stringify(await CF.prepare(c, 'SAVINGS_PRODUCT', {
      patch: (body && body.customFields) || {}, previous: before ? before.custom_fields : {}, user, recordId: before ? before.id : null, creating: !before,
    }));
  }
}

router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const id = String(req.body?.id || '').trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,16}$/.test(id)) return badRequest(res, 'PRODUCT_ID_MUST_BE_2_TO_16_UPPERCASE_ALPHANUMERIC');
    const cols = toColumns(req.body);
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      await resolveExtras(c, cols, req.body, { user: req.auth });
      if (cols.credit_arrangement_requirement !== undefined) cols.credit_arrangement_requirement = await CA.assertRequirement(c, 'DEPOSIT', null, cols.credit_arrangement_requirement);
      const problems = await validate(c, cols);
      if (problems.length) return { problems };
      const keys = Object.keys(cols);
      const { rows } = await c.query(
        `INSERT INTO savings_products (id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (id) DO NOTHING RETURNING *`, [id, ...keys.map((k) => cols[k])]);
      if (!rows.length) return { duplicate: true };
      await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DEPOSIT_PRODUCT_CREATED','savings_product',$2,$3)`,
        [req.auth.email, id, JSON.stringify(rows[0])]);
      await PA.recordMappings(c, 'DEPOSIT', id, null, rows[0], req.auth.email);
      return { row: await withFees(c, rows[0]) };
    });
    if (out.problems) return apiError(res, 400, 400, 'INVALID_DEPOSIT_PRODUCT', out.problems.join('; '));
    if (out.duplicate) return apiError(res, 409, 409, 'DEPOSIT_PRODUCT_EXISTS');
    res.status(201).json(publicProduct(out.row));
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth(), async (req, res, next) => {
  try {
    const cols = toColumns(req.body);
    if (!Object.keys(cols).length && req.body?.customFields === undefined) return badRequest(res, 'NO_UPDATABLE_FIELDS');
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [before] } = await c.query('SELECT * FROM savings_products WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) return { missing: true };
      const accounts = await accountsUnder(c, before.id);
      await resolveExtras(c, cols, req.body, { user: req.auth, before });
      if (cols.credit_arrangement_requirement !== undefined) cols.credit_arrangement_requirement = await CA.assertRequirement(c, 'DEPOSIT', before.id, cols.credit_arrangement_requirement);
      const problems = await validate(c, cols, { before, accounts });
      if (problems.length) return { problems };
      await rateChanges(c, before, cols, req.body || {}, { actor: req.auth.email });
      const keys = Object.keys(cols);
      const { rows: [after] } = await c.query(
        `UPDATE savings_products SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [before.id, ...keys.map((k) => cols[k])]);
      await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'DEPOSIT_PRODUCT_CHANGED','savings_product',$2,$3,$4)`,
        [req.auth.email, before.id, JSON.stringify(before), JSON.stringify(after)]);
      await PA.recordMappings(c, 'DEPOSIT', before.id, before, after, req.auth.email);
      return { row: await withFees(c, after) };
    });
    if (out.missing) return notFound(res, 'deposit product');
    if (out.problems) return apiError(res, 400, 400, 'INVALID_DEPOSIT_PRODUCT', out.problems.join('; '));
    res.json(publicProduct(out.row));
  } catch (e) { next(e); }
});

// --- accounting method change and history ----------------------------------

router.post('/:id/accounting-method', requireAuth(), async (req, res, next) => {
  try {
    const b = req.body || {};
    const mappings = toColumns(b.mappings || {});
    for (const k of Object.keys(mappings)) if (!k.startsWith('gl_')) delete mappings[k];
    const out = await withTenant(req.tenant.schema_name, (c) => AC.changeDepositProduct(c, req.params.id, {
      method: b.accountingMethod, interestAccruedAccounting: b.interestAccruedAccounting, mappings, reason: b.reason, createdBy: req.auth.email,
    }));
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.get('/:id/accounting-changes', ...json((c, req) => AC.history(c, 'DEPOSIT', req.params.id)));

router.get('/:id/gl-mapping-history', ...json((c, req) => PA.mappingHistory(c, 'DEPOSIT', req.params.id)));

// --- fees -----------------------------------------------------------------

const FEE_FIELDS = { code: 'code', name: 'name', trigger: 'trigger', amount: 'amount', glIncome: 'gl_income', isActive: 'is_active',
  applyDateMethod: 'apply_date_method' };
const feeCols = (body) => Object.fromEntries(Object.entries(body || {}).filter(([k]) => FEE_FIELDS[k]).map(([k, v]) => [FEE_FIELDS[k], v]));

async function validateFee(c, cols, before) {
  const problems = [];
  const m = { ...(before || {}), ...cols };
  if (!before && (!cols.code || !/^[A-Z0-9_]{2,16}$/.test(cols.code))) problems.push('code must be 2 to 16 uppercase letters, digits or underscore');
  if (!before && !cols.name) problems.push('name is required');
  if (m.trigger && !['MANUAL', 'MONTHLY'].includes(m.trigger)) problems.push('trigger must be MANUAL or MONTHLY');
  if (m.trigger === 'MONTHLY' && !(Number(m.amount) > 0)) problems.push('a MONTHLY fee needs an amount');
  // A monthly fee is dated monthly from activation, on the first day of every month (the reference platform), or on the last day (the platform's first rule).
  if (m.trigger === 'MONTHLY' && !m.apply_date_method) cols.apply_date_method = m.apply_date_method = 'END_OF_MONTH';
  if (m.trigger !== 'MONTHLY' && m.apply_date_method) {
    if (cols.apply_date_method) problems.push('apply_date_method is for MONTHLY fees');
    else cols.apply_date_method = null;
  }
  if (m.trigger === 'MONTHLY' && !DR.MONTHLY_FEE_METHODS.includes(m.apply_date_method)) problems.push(`apply_date_method must be one of ${DR.MONTHLY_FEE_METHODS.join(', ')}`);
  if (cols.amount !== undefined && cols.amount !== null && !(Number(cols.amount) >= 0)) problems.push('amount must be zero or more');
  problems.push(...await PA.validateFeeAccounts(c, cols));
  return problems;
}

router.post('/:id/fees', requireAuth(), async (req, res, next) => {
  try {
    const cols = feeCols(req.body);
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [p] } = await c.query('SELECT id FROM savings_products WHERE id = $1', [req.params.id]);
      if (!p) return { missing: true };
      const problems = await validateFee(c, cols, null);
      if (problems.length) return { problems };
      const keys = Object.keys(cols);
      const { rows } = await c.query(
        `INSERT INTO savings_product_fees (product_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (product_id, code) DO NOTHING RETURNING *`, [p.id, ...keys.map((k) => cols[k])]);
      if (!rows.length) return { duplicate: true };
      await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DEPOSIT_PRODUCT_FEE_CREATED','savings_product_fee',$2,$3)`,
        [req.auth.email, rows[0].id, JSON.stringify(rows[0])]);
      await PA.recordMappings(c, 'DEPOSIT_FEE', `${p.id}:${rows[0].code}`, null, rows[0], req.auth.email);
      return { row: rows[0] };
    });
    if (out.missing) return notFound(res, 'deposit product');
    if (out.problems) return apiError(res, 400, 400, 'INVALID_FEE', out.problems.join('; '));
    if (out.duplicate) return apiError(res, 409, 409, 'FEE_CODE_EXISTS');
    res.status(201).json(out.row);
  } catch (e) { next(e); }
});

router.patch('/:id/fees/:feeId', requireAuth(), async (req, res, next) => {
  try {
    const cols = feeCols(req.body);
    delete cols.code;
    if (!Object.keys(cols).length) return badRequest(res, 'NO_UPDATABLE_FIELDS');
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [before] } = await c.query(
        'SELECT * FROM savings_product_fees WHERE product_id = $1 AND (id::text = $2 OR code = $2) FOR UPDATE', [req.params.id, req.params.feeId]);
      if (!before) return { missing: true };
      const problems = await validateFee(c, cols, before);
      if (problems.length) return { problems };
      const keys = Object.keys(cols);
      const { rows: [after] } = await c.query(
        `UPDATE savings_product_fees SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [before.id, ...keys.map((k) => cols[k])]);
      await PA.recordMappings(c, 'DEPOSIT_FEE', `${req.params.id}:${before.code}`, before, after, req.auth.email);
      return { row: after };
    });
    if (out.missing) return notFound(res, 'fee');
    if (out.problems) return apiError(res, 400, 400, 'INVALID_FEE', out.problems.join('; '));
    res.json(out.row);
  } catch (e) { next(e); }
});

// A fee is deleted only if it was never applied (the reference platform); otherwise it is deactivated.
router.delete('/:id/fees/:feeId', requireAuth(), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [f] } = await c.query(
        'SELECT * FROM savings_product_fees WHERE product_id = $1 AND (id::text = $2 OR code = $2) FOR UPDATE', [req.params.id, req.params.feeId]);
      if (!f) return { missing: true };
      const { rows: [n] } = await c.query(
        `SELECT count(*)::int AS n FROM transactions t JOIN savings_accounts a ON a.id = t.savings_account_id
          WHERE a.product_id = $1 AND t.kind = 'SAVINGS_FEE' AND t.allocation->>'fee' = $2`, [req.params.id, f.code]);
      if (n.n) return { applied: n.n };
      await c.query('DELETE FROM savings_product_fees WHERE id = $1', [f.id]);
      await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'DEPOSIT_PRODUCT_FEE_DELETED','savings_product_fee',$2,$3)`,
        [req.auth.email, f.id, JSON.stringify(f)]);
      return { ok: true };
    });
    if (out.missing) return notFound(res, 'fee');
    if (out.applied) return apiError(res, 409, 409, `FEE_HAS_BEEN_APPLIED: ${out.applied} time(s); deactivate it instead`);
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
