'use strict';

const acct = require('./accounting');

/**
 * What a product's accounting settings require, after Mambu's "Linking
 * Products to Accounting".
 *
 * A product has a method (NONE, CASH or ACCRUAL), a GL accrual method (when
 * accrued interest reaches the ledger under ACCRUAL: DAILY, MONTHLY or NONE)
 * and one GL account per financial resource. Which resources it needs is
 * derived, never listed by hand: the method decides the receivables and
 * payables, and the features the product has switched on (tax, overdraft,
 * negative rates, revolving credit balances) add their own. A resource the
 * product needs and lacks is refused by name; one it cannot use, supplied
 * anyway, is refused too, so a product never carries a mapping that nothing
 * posts to.
 *
 * Depends on accounting only.
 */

const ALL = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const METHODS = ['NONE', 'CASH', 'ACCRUAL'];
const ACCRUED = ['NONE', 'DAILY', 'MONTHLY'];
const GRANULARITY = ['PER_ACCOUNT', 'AGGREGATED'];

const accrues = (p) => p.accounting_method === 'ACCRUAL' && (p.interest_accrued_accounting || 'NONE') !== 'NONE';
const loanTaxed = (p) => Boolean(p.tax_on_interest || p.tax_on_fees || p.tax_on_penalties);
const depositInterest = (p) => Boolean(p.interest_paid_into_account) && !p.is_funding_account;
const depositOverdraft = (p) => Boolean(p.allow_overdraft || p.allow_technical_overdraft);

// Loan resources. `optional` resources fall back to another account when
// unset (fee and penalty income to interest income), as the product always
// has; the rest must be mapped whenever they are used.
const LOAN = {
  portfolioControl:   { column: 'gl_portfolio',    types: ['ASSET'],     when: () => true },
  interestIncome:     { column: 'gl_interest_inc', types: ['INCOME'],    when: () => true },
  feeIncome:          { column: 'gl_fee_inc',      types: ALL,           when: () => true, optional: true },
  penaltyIncome:      { column: 'gl_penalty_inc',  types: ['INCOME'],    when: () => true, optional: true },
  writeOffExpense:    { column: 'gl_writeoff_exp', types: ['EXPENSE'],   when: () => true },
  interestReceivable: { column: 'gl_interest_rec', types: ['ASSET'],     when: (p) => accrues(p) },
  feeReceivable:      { column: 'gl_fee_rec',      types: ['ASSET'],     when: (p) => p.accounting_method === 'ACCRUAL' },
  penaltyReceivable:  { column: 'gl_penalty_rec',  types: ['ASSET'],     when: (p) => p.accounting_method === 'ACCRUAL' },
  taxesPayable:       { column: 'gl_tax_payable',  types: ['LIABILITY'], when: (p) => loanTaxed(p) },
  creditBalance:      { column: 'gl_credit_balance', types: ['LIABILITY'], when: (p) => p.product_type === 'REVOLVING' && p.credit_balance_enabled },
};

// Deposit resources. The transaction source is the channel's GL account.
const DEPOSIT = {
  savingsControl:         { column: 'gl_liability',        types: ['LIABILITY', 'EQUITY'], when: () => true },
  feeIncome:              { column: 'gl_fee_inc',          types: ALL,                    when: () => true },
  interestExpense:        { column: 'gl_interest_exp',     types: ['EXPENSE', 'INCOME'],   when: (p) => depositInterest(p) },
  interestPayable:        { column: 'gl_interest_payable', types: ['LIABILITY', 'ASSET'],  when: (p) => depositInterest(p) && accrues(p) },
  taxesPayable:           { column: 'gl_tax_payable',      types: ['LIABILITY'],           when: (p) => depositInterest(p) && p.withholding_tax_percent !== null && p.withholding_tax_percent !== undefined },
  negativeInterestIncome: { column: 'gl_neg_interest_inc', types: ['INCOME', 'EXPENSE'],   when: (p) => depositInterest(p) && Boolean(p.allow_negative_rate) },
  negativeInterestReceivable: { column: 'gl_neg_interest_rec', types: ['ASSET', 'LIABILITY'], when: (p) => depositInterest(p) && Boolean(p.allow_negative_rate) && accrues(p) },
  overdraftPortfolioControl:  { column: 'gl_od_portfolio',    types: ['ASSET'],               when: (p) => depositOverdraft(p) },
  overdraftWriteOffExpense:   { column: 'gl_od_writeoff',     types: ['EXPENSE'],             when: (p) => depositOverdraft(p) },
  overdraftInterestIncome:    { column: 'gl_od_interest_inc', types: ['INCOME', 'EXPENSE'],   when: (p) => depositOverdraft(p) },
  overdraftInterestReceivable: { column: 'gl_od_interest_rec', types: ['ASSET', 'LIABILITY'], when: (p) => depositOverdraft(p) && accrues(p) },
};

const CATALOG = { LOAN, DEPOSIT };

/** The resources a product uses, with the GL account each is mapped to. */
function resources(kind, p) {
  const out = [];
  for (const [name, r] of Object.entries(CATALOG[kind])) {
    const used = p.accounting_method !== 'NONE' && r.when(p);
    out.push({ resource: name, column: r.column, types: r.types, used, optional: Boolean(r.optional), glCode: p[r.column] || null });
  }
  return out;
}

async function glAccounts(c, codes) {
  if (!codes.length) return [];
  const { rows } = await c.query(
    `SELECT g.code, g.type, g.is_active,
            EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_code = g.code) AS is_header
     FROM gl_accounts g WHERE g.code = ANY($1)`, [codes]);
  return rows;
}

/** A GL account a rule points at must exist, be active, be a detail account and have an allowed type. */
function glProblem(label, code, g, types) {
  if (!g) return `${label}: no GL account ${code}`;
  if (!g.is_active) return `${label}: GL account ${code} is inactive`;
  if (g.is_header) return `HEADER_GL_ACCOUNT_NOT_ALLOWED: ${label} ${code} is a header account; map a detail account under it`;
  if (!types.includes(g.type)) return `INVALID_RULE_GLACCOUNT_TYPE: ${label} ${code} is ${g.type}, needs ${types.join(' or ')}`;
  return null;
}

/**
 * Check a product's accounting settings.
 *
 *   merged    the product as it will be (stored row overlaid with the change)
 *   explicit  the columns the caller actually sent
 *
 * Returns { problems, fixes }: problems refuse the save; fixes are columns
 * to set alongside it (the GL accrual method dropping to NONE when a product
 * moves to CASH or NONE and the caller did not say).
 */
async function validate(c, kind, merged, explicit = {}) {
  const problems = [];
  const fixes = {};
  const p = { ...merged };
  if (!METHODS.includes(p.accounting_method)) problems.push(`accounting_method must be one of ${METHODS.join(', ')}`);
  if (p.interest_accrued_accounting !== undefined && !ACCRUED.includes(p.interest_accrued_accounting)) {
    problems.push(`interest_accrued_accounting must be one of ${ACCRUED.join(', ')}`);
  }
  if (p.accrual_granularity !== undefined && !GRANULARITY.includes(p.accrual_granularity)) {
    problems.push(`accrual_granularity must be one of ${GRANULARITY.join(', ')}`);
  }
  if (p.accounting_method !== 'ACCRUAL' && (p.interest_accrued_accounting || 'NONE') !== 'NONE') {
    if (explicit.interest_accrued_accounting !== undefined && explicit.interest_accrued_accounting !== 'NONE') {
      problems.push(`INTEREST_ACCRUED_METHOD_INVALID: under ${p.accounting_method} the interest accrued method must be NONE`);
    } else {
      fixes.interest_accrued_accounting = 'NONE';
      p.interest_accrued_accounting = 'NONE';
    }
  }
  if (kind === 'DEPOSIT' && p.is_funding_account) {
    if (p.accounting_method === 'ACCRUAL') problems.push('a funding account product uses NONE or CASH accounting');
    if (p.interest_paid_into_account) problems.push('a funding account earns no interest');
    if (depositOverdraft(p)) problems.push('a funding account cannot be overdrawn');
  }

  const list = resources(kind, p);
  const codes = [...new Set(list.filter((r) => r.glCode && (r.used || explicit[r.column])).map((r) => r.glCode))];
  const gls = await glAccounts(c, codes);
  for (const r of list) {
    const sent = explicit[r.column] !== undefined && explicit[r.column] !== null;
    if (r.used && !r.optional && !r.glCode) {
      problems.push(`MISSING_ACCOUNTING_RULE: ${r.resource} (${r.column}) is required under ${p.accounting_method}`);
      continue;
    }
    if (!r.used && sent) {
      problems.push(`NOT_REQUIRED_ACCOUNTING_RULE: ${r.resource} (${r.column}) is not used ${p.accounting_method === 'NONE'
        ? 'by a product not linked to accounting' : `by this product under ${p.accounting_method}`}`);
      continue;
    }
    if (r.glCode && (r.used || sent)) {
      const bad = glProblem(`${r.resource} (${r.column})`, r.glCode, gls.find((g) => g.code === r.glCode), r.types);
      if (bad) problems.push(bad);
    }
  }
  return { problems, fixes };
}

/** Check a fee's own GL accounts (income, receivable, write-off). */
async function validateFeeAccounts(c, fee) {
  const checks = [['gl_income', ['INCOME', 'LIABILITY']], ['gl_receivable', ['ASSET']], ['gl_writeoff', ['EXPENSE']]]
    .filter(([col]) => fee[col]);
  const gls = await glAccounts(c, checks.map(([col]) => fee[col]));
  return checks.map(([col, types]) => glProblem(col, fee[col], gls.find((g) => g.code === fee[col]), types)).filter(Boolean);
}

/** Write one history row per GL mapping that changed. */
async function recordMappings(c, kind, productId, before, after, actor) {
  const cols = kind === 'LOAN_FEE' || kind === 'DEPOSIT_FEE'
    ? ['gl_income', 'gl_receivable', 'gl_writeoff'].map((col) => ({ resource: col, column: col }))
    : Object.entries(CATALOG[kind]).map(([resource, r]) => ({ resource, column: r.column }));
  for (const { resource, column } of cols) {
    const was = before ? before[column] || null : null;
    const now = after[column] || null;
    if (was === now || (after[column] === undefined)) continue;
    await c.query(
      `INSERT INTO product_gl_mapping_history (product_kind, product_id, resource, gl_code, changed_by)
       VALUES ($1,$2,$3,$4,$5)`, [kind, productId, resource, now, actor || 'SYSTEM']);
  }
}

async function mappingHistory(c, kind, productId) {
  const { rows } = await c.query(
    `SELECT resource, gl_code, effective_from, changed_by FROM product_gl_mapping_history
     WHERE product_kind = $1 AND product_id = $2 ORDER BY effective_from, id`, [kind, productId]);
  return rows;
}

/**
 * The literal defaults a product table gives its columns (text, numeric and
 * boolean), so a product being created is validated as it will be stored.
 */
async function tableDefaults(c, table) {
  const { rows } = await c.query(
    `SELECT column_name, column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_default IS NOT NULL`, [table]);
  const out = {};
  for (const r of rows) {
    const d = r.column_default;
    let m;
    if ((m = d.match(/^'([^']*)'::(text|character varying)$/))) out[r.column_name] = m[1];
    else if (d === 'true' || d === 'false') out[r.column_name] = d === 'true';
    else if ((m = d.match(/^\(?(-?[0-9.]+)\)?(::numeric)?$/))) out[r.column_name] = Number(m[1]);
  }
  return out;
}

/** The tenant's suspense account, the cash side of products not linked to accounting. */
async function suspense(c) {
  const { rows: [r] } = await c.query('SELECT gl_suspense FROM accounting_settings WHERE only_row');
  return r?.gl_suspense || '290-900';
}

module.exports = {
  CATALOG, METHODS, ACCRUED, GRANULARITY, resources, validate, validateFeeAccounts, tableDefaults,
  recordMappings, mappingHistory, suspense, accrues, round2: acct.round2,
};
