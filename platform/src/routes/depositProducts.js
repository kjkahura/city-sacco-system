'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { apiError, badRequest, notFound } = require('../lib/http');
const PA = require('../domain/productAccounting');
const AC = require('../domain/accountingChanges');

/**
 * Deposit products: interest, withholding tax, overdrafts, fees, and the
 * accounting method with its GL mappings (see ../domain/productAccounting
 * for which mappings each setting requires).
 */

const router = express.Router();
const READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR', 'TELLER'];
const ADMIN = ['TENANT_ADMIN', 'MANAGER'];

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
};
const ENUMS = {
  interest_calc_balance: ['END_OF_DAY', 'MINIMUM'],
  interest_day_count: ['ACTUAL_365', 'ACTUAL_360', 'THIRTY_360'],
  interest_application: ['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL'],
};
const BOOLS = ['is_active', 'withdrawable', 'is_funding_account', 'interest_paid_into_account', 'allow_negative_rate',
  'allow_overdraft', 'allow_technical_overdraft'];
// Settings that change how interest is worked out or what the account is,
// frozen once accounts exist.
const FROZEN_WITH_ACCOUNTS = ['is_funding_account', 'interest_calc_balance', 'interest_day_count'];

const num = (v) => (v === null || v === undefined ? null : Number(v));

const publicProduct = (p) => ({
  id: p.id, name: p.name, description: p.description, isActive: p.is_active, isFundingAccount: p.is_funding_account,
  withdrawable: p.withdrawable, minBalance: Number(p.min_balance),
  interest: {
    paidIntoAccount: p.interest_paid_into_account, annualRate: Number(p.annual_rate), calcBalance: p.interest_calc_balance,
    dayCount: p.interest_day_count, application: p.interest_application, minBalanceForInterest: num(p.min_balance_for_interest),
    allowNegativeRate: p.allow_negative_rate, withholdingTaxPercent: num(p.withholding_tax_percent),
  },
  overdraft: {
    allowed: p.allow_overdraft, maxLimit: num(p.max_overdraft_limit), annualRate: Number(p.overdraft_annual_rate),
    technicalAllowed: p.allow_technical_overdraft,
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
  fees: (p.fees || []).map((f) => ({ id: f.id, code: f.code, name: f.name, trigger: f.trigger, amount: num(f.amount), glIncome: f.gl_income, isActive: f.is_active })),
  accounts: p.accounts === undefined ? undefined : p.accounts,
});

function toColumns(body) {
  const cols = {};
  for (const [k, v] of Object.entries(body || {})) if (FIELDS[k]) cols[FIELDS[k]] = v;
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
  const m = { ...(before ? {} : await PA.tableDefaults(c, 'savings_products')), ...(before || {}), ...cols };
  if (m.annual_rate !== undefined && m.annual_rate !== null && Number(m.annual_rate) < 0 && !m.allow_negative_rate) {
    problems.push('a negative annual_rate needs allow_negative_rate');
  }
  if (m.allow_overdraft === false && m.max_overdraft_limit) problems.push('max_overdraft_limit needs allow_overdraft');
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

router.get('/', requireAuth(...READER), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT p.*, (SELECT count(*)::int FROM savings_accounts a WHERE a.product_id = p.id) AS accounts
       FROM savings_products p ORDER BY p.id`)).rows);
    res.json(rows.map(publicProduct));
  } catch (e) { next(e); }
});

// The mappings a product would need for a method and features, before it is
// saved: what the console shows as the form changes.
router.post('/accounting-rules', requireAuth(...READER), async (req, res, next) => {
  try {
    const p = { accounting_method: 'CASH', interest_accrued_accounting: 'NONE', ...toColumns(req.body) };
    res.json(PA.resources('DEPOSIT', p).map((r) => ({ resource: r.resource, column: r.column, types: r.types, used: r.used, glCode: r.glCode })));
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth(...READER), async (req, res, next) => {
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

router.post('/', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const id = String(req.body?.id || '').trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,16}$/.test(id)) return badRequest(res, 'PRODUCT_ID_MUST_BE_2_TO_16_UPPERCASE_ALPHANUMERIC');
    const cols = toColumns(req.body);
    const out = await withTenant(req.tenant.schema_name, async (c) => {
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

router.patch('/:id', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const cols = toColumns(req.body);
    if (!Object.keys(cols).length) return badRequest(res, 'NO_UPDATABLE_FIELDS');
    const out = await withTenant(req.tenant.schema_name, async (c) => {
      const { rows: [before] } = await c.query('SELECT * FROM savings_products WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) return { missing: true };
      const accounts = await accountsUnder(c, before.id);
      const problems = await validate(c, cols, { before, accounts });
      if (problems.length) return { problems };
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

router.post('/:id/accounting-method', requireAuth(...ADMIN), async (req, res, next) => {
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

router.get('/:id/accounting-changes', requireAuth(...READER), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => AC.history(c, 'DEPOSIT', req.params.id)));
  } catch (e) { next(e); }
});

router.get('/:id/gl-mapping-history', requireAuth(...READER), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => PA.mappingHistory(c, 'DEPOSIT', req.params.id)));
  } catch (e) { next(e); }
});

// --- fees -----------------------------------------------------------------

const FEE_FIELDS = { code: 'code', name: 'name', trigger: 'trigger', amount: 'amount', glIncome: 'gl_income', isActive: 'is_active' };
const feeCols = (body) => Object.fromEntries(Object.entries(body || {}).filter(([k]) => FEE_FIELDS[k]).map(([k, v]) => [FEE_FIELDS[k], v]));

async function validateFee(c, cols, before) {
  const problems = [];
  const m = { ...(before || {}), ...cols };
  if (!before && (!cols.code || !/^[A-Z0-9_]{2,16}$/.test(cols.code))) problems.push('code must be 2 to 16 uppercase letters, digits or underscore');
  if (!before && !cols.name) problems.push('name is required');
  if (m.trigger && !['MANUAL', 'MONTHLY'].includes(m.trigger)) problems.push('trigger must be MANUAL or MONTHLY');
  if (m.trigger === 'MONTHLY' && !(Number(m.amount) > 0)) problems.push('a MONTHLY fee needs an amount');
  if (cols.amount !== undefined && cols.amount !== null && !(Number(cols.amount) >= 0)) problems.push('amount must be zero or more');
  problems.push(...await PA.validateFeeAccounts(c, cols));
  return problems;
}

router.post('/:id/fees', requireAuth(...ADMIN), async (req, res, next) => {
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

router.patch('/:id/fees/:feeId', requireAuth(...ADMIN), async (req, res, next) => {
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

module.exports = router;
