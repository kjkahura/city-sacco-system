'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { apiError, badRequest, notFound } = require('../lib/http');

/**
 * Loan products.
 *
 * A product is the pricing and accounting template every loan under it
 * follows: product type, interest method, rate, term, fee, penalty pricing,
 * eligibility rules, allocation order, accounting method, accrual method,
 * day count, prepayment handling, and the GL accounts each component posts
 * to. Until now the only way to create one was SQL.
 *
 * The product type (FIXED_TERM or DYNAMIC_TERM) decides how interest is
 * worked out on every loan under it and cannot be changed once the product
 * exists, as in Mambu: the loans already running were written under it.
 *
 * Changing a product does not touch loans already running: the rate is
 * copied onto the loan at application. The GL mappings and the accounting
 * method are read live, so changing those changes how existing loans post
 * from that moment on, which is also what Mambu does and is the right call:
 * the alternative is a product whose accounting can never be corrected.
 */

const router = express.Router();
const READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR', 'TELLER'];
const ADMIN = ['TENANT_ADMIN', 'MANAGER'];

const ENUMS = {
  product_type: ['FIXED_TERM', 'DYNAMIC_TERM'],
  method: ['FLAT', 'REDUCING', 'REDUCING_EQUAL_INSTALLMENTS'],
  prepayment_recalculation: ['NONE', 'REDUCE_INSTALLMENT_AMOUNT', 'REDUCE_NUMBER_OF_INSTALLMENTS'],
  accounting_method: ['ACCRUAL', 'CASH'],
  interest_accrual: ['DAILY', 'MONTHLY', 'NONE'],
  day_count: ['THIRTY_360', 'ACTUAL_365', 'ACTUAL_360', 'ACTUAL_ACTUAL'],
  penalty_basis: ['OVERDUE', 'OUTSTANDING'],
};

// camelCase on the wire, snake_case in the table.
const FIELDS = {
  name: 'name', description: 'description', productType: 'product_type', method: 'method',
  prepaymentRecalculation: 'prepayment_recalculation', accrueLateInterest: 'accrue_late_interest',
  monthlyRate: 'monthly_rate', maxTerm: 'max_term', processingFee: 'processing_fee',
  maxMultiplier: 'max_multiplier', minPrincipal: 'min_principal', maxPrincipal: 'max_principal',
  penaltyRate: 'penalty_rate', penaltyBasis: 'penalty_basis', penaltyGraceDays: 'penalty_grace_days',
  accountingMethod: 'accounting_method', interestAccrual: 'interest_accrual', dayCount: 'day_count',
  allocationOrder: 'allocation_order',
  enforceDepositMultiplier: 'enforce_deposit_multiplier',
  requireGuarantorCover: 'require_guarantor_cover', minCoverPercent: 'min_cover_percent',
  glPortfolio: 'gl_portfolio', glInterestInc: 'gl_interest_inc', glFeeInc: 'gl_fee_inc',
  glPenaltyInc: 'gl_penalty_inc', glInterestRec: 'gl_interest_rec', glFeeRec: 'gl_fee_rec',
  glPenaltyRec: 'gl_penalty_rec', glWriteoffExp: 'gl_writeoff_exp',
  isActive: 'is_active',
};

// Which GL type each mapping must point at. A portfolio account that is an
// income account would balance every entry and be wrong on every report.
const GL_TYPES = {
  gl_portfolio: ['ASSET'], gl_interest_rec: ['ASSET'], gl_fee_rec: ['ASSET'], gl_penalty_rec: ['ASSET'],
  gl_interest_inc: ['INCOME'], gl_fee_inc: ['INCOME'], gl_penalty_inc: ['INCOME'],
  gl_writeoff_exp: ['EXPENSE'],
};

const publicProduct = (p) => ({
  id: p.id, name: p.name, description: p.description,
  productType: p.product_type, method: p.method,
  prepaymentRecalculation: p.prepayment_recalculation, accrueLateInterest: p.accrue_late_interest,
  monthlyRate: Number(p.monthly_rate), annualRate: Math.round(Number(p.monthly_rate) * 1200) / 100,
  maxTerm: p.max_term, processingFee: Number(p.processing_fee), maxMultiplier: Number(p.max_multiplier),
  minPrincipal: p.min_principal === null ? null : Number(p.min_principal),
  maxPrincipal: p.max_principal === null ? null : Number(p.max_principal),
  penaltyRate: Number(p.penalty_rate), penaltyBasis: p.penalty_basis, penaltyGraceDays: p.penalty_grace_days,
  accountingMethod: p.accounting_method, interestAccrual: p.interest_accrual, dayCount: p.day_count,
  allocationOrder: p.allocation_order,
  enforceDepositMultiplier: p.enforce_deposit_multiplier,
  requireGuarantorCover: p.require_guarantor_cover, minCoverPercent: Number(p.min_cover_percent),
  gl: {
    portfolio: p.gl_portfolio, interestIncome: p.gl_interest_inc, feeIncome: p.gl_fee_inc,
    penaltyIncome: p.gl_penalty_inc, interestReceivable: p.gl_interest_rec,
    feeReceivable: p.gl_fee_rec, penaltyReceivable: p.gl_penalty_rec, writeOffExpense: p.gl_writeoff_exp,
  },
  isActive: p.is_active, updatedAt: p.updated_at,
});

async function validate(c, cols, { creating, before = null }) {
  const problems = [];
  for (const [col, allowed] of Object.entries(ENUMS)) {
    if (cols[col] !== undefined && !allowed.includes(cols[col])) {
      problems.push(`${col} must be one of ${allowed.join(', ')}`);
    }
  }
  if (before && cols.product_type !== undefined && cols.product_type !== before.product_type) {
    problems.push('product_type cannot be changed once a product exists; create a new product');
  }
  // Flat interest is charged on the original principal whatever the balance
  // does, which only makes sense when the schedule is fixed.
  const type = cols.product_type ?? before?.product_type ?? 'FIXED_TERM';
  const method = cols.method ?? before?.method ?? 'FLAT';
  if (type === 'DYNAMIC_TERM' && method === 'FLAT') {
    problems.push('a DYNAMIC_TERM product cannot use the FLAT method; use REDUCING or REDUCING_EQUAL_INSTALLMENTS');
  }
  for (const col of ['accrue_late_interest', 'enforce_deposit_multiplier', 'require_guarantor_cover', 'is_active']) {
    if (cols[col] !== undefined && typeof cols[col] !== 'boolean') problems.push(`${col} must be true or false`);
  }
  const nonNeg = ['monthly_rate', 'processing_fee', 'penalty_rate', 'penalty_grace_days', 'min_principal', 'max_principal'];
  for (const col of nonNeg) {
    if (cols[col] !== undefined && cols[col] !== null && !(Number(cols[col]) >= 0)) problems.push(`${col} must be zero or more`);
  }
  if (cols.max_term !== undefined && !(Number.isInteger(Number(cols.max_term)) && Number(cols.max_term) > 0)) {
    problems.push('max_term must be a positive whole number of months');
  }
  if (cols.max_multiplier !== undefined && !(Number(cols.max_multiplier) > 0)) problems.push('max_multiplier must be positive');
  if (cols.allocation_order !== undefined) {
    const o = cols.allocation_order;
    const want = ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'];
    if (!Array.isArray(o) || o.length !== 4 || want.some((w) => !o.includes(w))) {
      problems.push('allocation_order must list PENALTY, FEE, INTEREST and PRINCIPAL once each');
    }
  }
  if (creating && !cols.name) problems.push('name is required');

  // Every GL mapping named must exist, be active and be of the right type.
  const glCols = Object.keys(GL_TYPES).filter((k) => cols[k] !== undefined && cols[k] !== null);
  if (glCols.length) {
    const codes = glCols.map((k) => cols[k]);
    const { rows } = await c.query('SELECT code, type, is_active FROM gl_accounts WHERE code = ANY($1)', [codes]);
    for (const k of glCols) {
      const g = rows.find((r) => r.code === cols[k]);
      if (!g) problems.push(`${k}: no GL account ${cols[k]}`);
      else if (!g.is_active) problems.push(`${k}: GL account ${cols[k]} is inactive`);
      else if (!GL_TYPES[k].includes(g.type)) problems.push(`${k}: ${cols[k]} is ${g.type}, needs ${GL_TYPES[k].join(' or ')}`);
    }
  }
  return problems;
}

function toColumns(body) {
  const cols = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (FIELDS[k]) cols[FIELDS[k]] = v;
  }
  return cols;
}

router.get('/', requireAuth(...READER), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT p.*, (SELECT count(*)::int FROM loan_accounts l WHERE l.product_id = p.id) AS loans
       FROM loan_products p ORDER BY p.id`)).rows);
    res.json(rows.map((p) => ({ ...publicProduct(p), loans: p.loans })));
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth(...READER), async (req, res, next) => {
  try {
    const row = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      'SELECT * FROM loan_products WHERE id = $1', [req.params.id])).rows[0]);
    return row ? res.json(publicProduct(row)) : notFound(res, 'loan product');
  } catch (e) { next(e); }
});

router.post('/', requireAuth(...ADMIN), async (req, res, next) => {
  try {
    const id = String(req.body?.id || '').trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,16}$/.test(id)) return badRequest(res, 'PRODUCT_ID_MUST_BE_2_TO_16_UPPERCASE_ALPHANUMERIC');
    const cols = toColumns(req.body);
    // Required GL mappings for a new product; the rest have defaults.
    for (const k of ['gl_portfolio', 'gl_interest_inc']) {
      if (!cols[k]) return badRequest(res, `${k.toUpperCase()}_REQUIRED`);
    }
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
      return { row: rows[0] };
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
      const problems = await validate(c, cols, { creating: false, before });
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
      return { row: rows[0] };
    });
    if (out.missing) return notFound(res, 'loan product');
    if (out.problems) return apiError(res, 400, 400, 'INVALID_LOAN_PRODUCT', out.problems.join('; '));
    res.json(publicProduct(out.row));
  } catch (e) { next(e); }
});

module.exports = router;
