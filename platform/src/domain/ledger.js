'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const tax = require('./tax');
const { err, round2 } = acct;
const { toUTC, interestBetween } = S;

/**
 * The loan core every other loan module stands on: reading a loan with its
 * product, the balances derived from it, which settings are the loan's own
 * and which the product's, and the accounting rules that decide where each
 * component is booked.
 *
 * This module depends only on accounting, the pure schedule engine and tax.
 * Nothing here requires another loan module, so everything else can require
 * it at the top of the file without a cycle. The layers, bottom up:
 *
 *   accounting, schedule
 *   tax, savings, controls
 *   ledger
 *   eligibility, funding, tranches
 *   securities
 *   workflow
 *   fees, penalties
 *   installments
 *   interest
 *   revolving
 *   loans (apply, disburse, repay, write-off, reversal)
 *   restructure
 *
 * A module may require anything below it and nothing above it.
 */

// --------------------------------------------------------------------------
// Overrides: what a loan may carry of its own instead of the product's value
//
//   SNAPSHOT  copied from the product when the loan is opened and fixed from
//             then on. Changing the product changes new loans only.
//   INHERIT   the loan's column is NULL unless someone set it, and NULL means
//             "follow the product" at the time it is read. Changing the
//             product changes every loan that has not set its own value.
//
// Everything not listed here belongs to the product and is read through the
// join in lock(): a loan cannot carry its own day count, method, fees or GL
// accounts. The core terms (principal, number of installments) are the
// loan's by definition and are not overrides.
//
// This list is the single definition used by lock() (which product columns
// to bring alongside), effective(), overrideSql() for set-based SQL, and
// resolveOverrides() for application and amendment.
// --------------------------------------------------------------------------

const OVERRIDES = {
  monthlyRate: {
    column: 'monthly_rate', alias: 'product_rate', mode: 'SNAPSHOT', label: 'RATE', band: ['rate_min', 'rate_max'],
    snapshot: (p) => (p.product_type === 'INTEREST_FREE' ? 0 : Number(p.monthly_rate)),
    check(v, { product }) {
      if (product.product_type === 'INTEREST_FREE') {
        if (v > 0) throw err('INTEREST_FREE_PRODUCT_TAKES_NO_RATE', 400);
        return 'SKIP_BAND';
      }
      return null;
    },
  },
  firstDueOffsetDays: {
    column: 'first_due_offset_days', mode: 'SNAPSHOT', label: 'FIRST_DUE_OFFSET', fallback: 0,
    band: ['first_due_offset_min', 'first_due_offset_max'],
  },
  penaltyRate: {
    column: 'penalty_rate', mode: 'INHERIT', label: 'PENALTY_RATE', fallback: 0,
    band: ['penalty_rate_min', 'penalty_rate_max'],
  },
  gracePeriods: {
    column: 'grace_periods', mode: 'INHERIT', label: 'GRACE_PERIODS', fallback: 0,
    check(v, { term }) { if (term && v >= term) throw err('GRACE_EXCEEDS_TERM', 400); return null; },
  },
  amortizationPeriods: {
    column: 'amortization_periods', mode: 'INHERIT', label: 'AMORTIZATION_PERIODS', fallback: null,
    check(v, { term }) { if (term && v < term) throw err('AMORTIZATION_SHORTER_THAN_TERM', 400); return null; },
  },
  arrearsToleranceDays: {
    column: 'arrears_tolerance_days', mode: 'INHERIT', label: 'ARREARS_TOLERANCE_DAYS', fallback: 0,
  },
  arrearsTolerancePercent: {
    column: 'arrears_tolerance_percent', mode: 'INHERIT', label: 'ARREARS_TOLERANCE_PERCENT', fallback: null,
  },
  revolvingRepaymentValue: {
    column: 'revolving_repayment_value', mode: 'INHERIT', label: 'REVOLVING_REPAYMENT_VALUE', fallback: 0,
    appliesTo: (p) => p.product_type === 'REVOLVING',
  },
  orgCommission: {
    column: 'org_commission', mode: 'INHERIT', label: 'ORG_COMMISSION', fallback: 0,
    band: ['org_commission_min', 'org_commission_max'],
    appliesTo: (p) => Boolean(p.funding_enabled),
  },
};
for (const o of Object.values(OVERRIDES)) o.alias = o.alias || `product_${o.column}`;

/** The loan's effective value for each override: its own, else the product's. */
function effective(l) {
  const out = {};
  for (const [key, o] of Object.entries(OVERRIDES)) {
    const own = l[o.column];
    const value = o.mode === 'SNAPSHOT'
      ? own ?? o.fallback ?? null
      : own ?? l[o.alias] ?? o.fallback ?? null;
    out[key] = value === null ? null : Number(value);
  }
  return out;
}

/** SQL for an override's effective value, for set-based queries over loans `l` joined to products `p`. */
function overrideSql(key, loan = 'l', product = 'p') {
  const o = OVERRIDES[key];
  if (!o) throw new Error(`UNKNOWN_OVERRIDE: ${key}`);
  if (o.mode === 'SNAPSHOT') return `${loan}.${o.column}`;
  const fallback = o.fallback === null || o.fallback === undefined ? '' : `, ${o.fallback}`;
  return `COALESCE(${loan}.${o.column}, ${product}.${o.column}${fallback})`;
}

/** A value must sit inside the product's band, when the product has one. */
function within(label, value, min, max) {
  if (min !== null && min !== undefined && Number(value) < Number(min)) throw err(`${label}_BELOW_PRODUCT_MINIMUM: ${min}`, 400);
  if (max !== null && max !== undefined && Number(value) > Number(max)) throw err(`${label}_ABOVE_PRODUCT_MAXIMUM: ${max}`, 400);
}

/**
 * Validate the overrides in `given` (keyed by the names above) against
 * product `p` and return the loan columns to write.
 *
 *   opening  true when the loan is being opened: SNAPSHOT values not given
 *            are copied from the product, INHERIT values not given are NULL.
 *   term     the number of installments the checks measure against.
 *   current  the loan as it stands, when amending: values not being changed
 *            are re-checked against a changed term.
 *
 * A value outside the product's band, an override the product does not use
 * (orgCommission without funding, revolvingRepaymentValue on a term loan),
 * or clearing a SNAPSHOT value is refused.
 */
function resolveOverrides(p, given = {}, { opening = false, term = null, current = null } = {}) {
  const out = {};
  for (const [key, o] of Object.entries(OVERRIDES)) {
    const has = given[key] !== undefined;
    const used = !o.appliesTo || o.appliesTo(p);

    if (!has) {
      if (opening) {
        out[o.column] = o.mode === 'SNAPSHOT'
          ? (o.snapshot ? o.snapshot(p) : Number(p[o.column] ?? o.fallback ?? 0))
          : null;
      } else if (current && o.check && current[o.column] !== null && current[o.column] !== undefined) {
        o.check(Number(current[o.column]), { product: p, term });
      }
      continue;
    }

    const v = given[key];
    if (v === null) {
      if (o.mode === 'SNAPSHOT') throw err(`${o.label}_CANNOT_BE_CLEARED`, 400);
      out[o.column] = null;
      continue;
    }
    if (!used) throw err(`${o.label}_NOT_USED_BY_THIS_PRODUCT`, 400);
    const n = Number(v);
    if (!Number.isFinite(n)) throw err(`INVALID_${o.label}`, 400);
    const skip = o.check ? o.check(n, { product: p, term }) === 'SKIP_BAND' : false;
    if (o.band && !skip) within(o.label, n, p[o.band[0]], p[o.band[1]]);
    out[o.column] = n;
  }
  return out;
}

// --------------------------------------------------------------------------
// Reading a loan
// --------------------------------------------------------------------------

// Product columns the loan carries around with it. Where a name exists on
// both tables the loan's wins; the product's value of each override comes
// in under its alias (product_penalty_rate and so on), from OVERRIDES.
const PRODUCT_ONLY = [
  'method', 'gl_portfolio', 'gl_interest_inc', 'gl_fee_inc', 'gl_penalty_inc',
  'gl_interest_rec', 'gl_fee_rec', 'gl_penalty_rec', 'gl_writeoff_exp',
  'accounting_method', 'interest_accrual', 'interest_accrued_accounting', 'accrual_granularity', 'day_count', 'allocation_order',
  'enforce_deposit_multiplier', 'require_guarantor_cover', 'min_cover_percent',
  'prepayment_recalculation', 'accrue_late_interest',
  'processing_fee', 'max_multiplier',
  'interest_type', 'simple_base', 'interest_posting', 'rate_frequency',
  'repayment_interval_unit', 'repayment_interval_count', 'fixed_days_of_month', 'short_month_handling',
  'grace_type', 'rounding',
  'arrears_tolerance_floor', 'arrears_count_from', 'arrears_non_working_days',
  'penalty_basis', 'penalty_tolerance_days',
  'charge_cap_percent', 'charge_cap_base', 'charge_cap_mode',
  'auto_close_paid_off_days', 'auto_lock_arrears_days', 'allow_arbitrary_fees',
  'min_principal', 'max_principal',
  'max_tranches', 'revolving_repayment_method', 'revolving_repayment_floor', 'revolving_repayment_ceiling',
  'credit_balance_enabled', 'max_credit_balance', 'gl_credit_balance',
  'enable_guarantors', 'enable_collateral',
  'tax_rate_percent', 'tax_method', 'tax_on_interest', 'tax_on_fees', 'tax_on_penalties', 'gl_tax_payable',
  'funding_enabled', 'funder_allocation', 'funder_rate_default', 'funder_rate_min', 'funder_rate_max',
  'lock_funds_at_approval',
];

const PRODUCT_COLUMNS = (() => {
  const cols = PRODUCT_ONLY.map((c) => `p.${c}`);
  cols.push('p.name AS product_name');
  const bands = new Set();
  for (const o of Object.values(OVERRIDES)) {
    cols.push(`p.${o.column} AS ${o.alias}`);
    for (const b of o.band || []) bands.add(b);
  }
  for (const b of bands) if (!PRODUCT_ONLY.includes(b)) cols.push(`p.${b}`);
  return cols.join(', ');
})();

async function lock(c, loanId, { forUpdate = true } = {}) {
  const { rows } = await c.query(
    `SELECT l.*, ${PRODUCT_COLUMNS}
     FROM loan_accounts l
     JOIN loan_products p ON p.id = l.product_id
     WHERE l.id::text = $1 OR l.account_no = $1
     ${forUpdate ? 'FOR UPDATE OF l' : ''}`,
    [loanId]
  );
  if (!rows.length) throw err('LOAN_NOT_FOUND', 404);
  return rows[0];
}

/** The same read without the row lock, for quotes in a read-only transaction. */
const read = (c, loanId) => lock(c, loanId, { forUpdate: false });

/** Outstanding principal: disbursed plus anything capitalised, less paid. */
const principalOutstanding = (l) => round2(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - Number(l.principal_paid));

function balances(l) {
  const principal = principalOutstanding(l);
  const interest = round2(l.interest_accrued - l.interest_paid);
  const fees = round2(l.fees_due - l.fees_paid);
  const penalty = round2(l.penalty_accrued - l.penalty_paid);
  return {
    principal, interest, fees, penalty,
    total: round2(principal + interest + fees + penalty),
  };
}

/** The pricing terms the schedule engine works from. */
function terms(l) {
  const free = l.product_type === 'INTEREST_FREE';
  return {
    rate: free ? 0 : Number(l.monthly_rate),
    frequency: l.rate_frequency || 'PER_MONTH',
    convention: l.day_count || 'THIRTY_360',
    interestType: l.interest_type || 'SIMPLE',
  };
}

// Product-type predicates (isDynamic, isRevolving, ...) live with the
// strategies in ./productTypes, which stand on this module.

/**
 * What settling a running loan costs, for a reschedule or a top-up: the
 * principal outstanding, and the interest, fees and penalties owed when they
 * are CAPITALIZED onto the new loan (WRITTEN_OFF ones are not paid).
 */
function settlement(l, arrears = 'CAPITALIZE') {
  const b = balances(l);
  const charges = round2(b.interest + b.fees + b.penalty);
  const capitalized = arrears === 'CAPITALIZE' ? charges : 0;
  return {
    balances: b, charges, capitalized, writtenOff: arrears === 'WRITE_OFF' ? charges : 0,
    amount: round2(b.principal + capitalized),
  };
}

/** The schedule engine's inputs for this loan. */
function scheduleInputs(l) {
  const e = effective(l);
  return {
    terms: terms(l),
    method: l.method,
    interval: { unit: l.repayment_interval_unit || 'MONTHS', every: Number(l.repayment_interval_count || 1) },
    fixedDays: l.fixed_days_of_month,
    shortMonth: l.short_month_handling || 'LAST_DAY',
    firstOffsetDays: e.firstDueOffsetDays || 0,
    grace: { type: l.grace_type || 'NONE', periods: e.gracePeriods || 0 },
    amortization: e.amortizationPeriods,
    rounding: l.rounding || 'NONE',
  };
}

async function shiftOffClosedDays(c, iso) {
  // Weekends and anything in the holidays table push the due date forward.
  // A repayment cannot fall due on a day the SACCO is shut.
  const { rows: [r] } = await c.query(
    `WITH RECURSIVE d(day, n) AS (
       SELECT $1::date, 0
       UNION ALL
       SELECT day + 1, n + 1 FROM d
       WHERE n < 10 AND (
         EXTRACT(dow FROM day) IN (0, 6)
         OR EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = day)
       )
     )
     SELECT max(day) AS day FROM d`,
    [iso]
  );
  return r.day;
}

// --------------------------------------------------------------------------
// Accounting rules
//
// Modelled on the rules Mambu publishes for loan products ("Linking Products
// to Accounting"). Under ACCRUAL, applying interest, a fee or a penalty
// debits that component's receivable and credits its income; paying it
// credits the receivable; writing it off clears the receivable against the
// write-off expense. Under CASH nothing is recognised until paid, and the
// payment credits income directly. Under NONE the product is not linked to
// the ledger at all: balances are kept, no journal entries are written.
// --------------------------------------------------------------------------

const isAccrual = (l) => l.accounting_method !== 'CASH' && l.accounting_method !== 'NONE';
const booksEntries = (l) => l.accounting_method !== 'NONE';

/**
 * Whether accrued interest reaches the ledger before it is paid: accrual
 * accounting with a GL accrual method (DAILY or MONTHLY). Under accrual with
 * the method NONE, fees and penalties still go through their receivables
 * but interest is recognised when paid, as under cash.
 */
const interestAccrues = (l) => isAccrual(l) && (l.interest_accrued_accounting || 'DAILY') !== 'NONE';

/** GL account credited when a component is paid. */
function paidCredit(l, component) {
  switch (component) {
    case 'PRINCIPAL': return l.gl_portfolio;
    case 'INTEREST':  return interestAccrues(l) ? l.gl_interest_rec : l.gl_interest_inc;
    case 'FEE':       return isAccrual(l) ? l.gl_fee_rec : (l.gl_fee_inc || l.gl_interest_inc);
    case 'PENALTY':   return isAccrual(l) ? l.gl_penalty_rec : (l.gl_penalty_inc || l.gl_interest_inc);
    default: throw err(`UNKNOWN_COMPONENT: ${component}`);
  }
}

/**
 * The credit lines for `amount` paid towards a component: the receivable
 * under accrual; under cash, income and, where the product taxes that
 * component, the tax payable share.
 */
function creditsFor(l, component, amount, memberId) {
  if (!(amount > 0)) return [];
  const viaReceivable = component === 'INTEREST' ? interestAccrues(l) : isAccrual(l);
  if (viaReceivable || component === 'PRINCIPAL') return [{ glCode: paidCredit(l, component), amount, memberId }];
  const s = tax.splitPaid(l, component, amount);
  return tax.incomeCredits(l, s, paidCredit(l, component), memberId);
}

/** GL account credited when a component is written off (accrual only). */
function writeOffCredit(l, component) {
  switch (component) {
    case 'PRINCIPAL': return l.gl_portfolio;
    case 'INTEREST':  return l.gl_interest_rec;
    case 'FEE':       return l.gl_fee_rec;
    case 'PENALTY':   return l.gl_penalty_rec;
    default: throw err(`UNKNOWN_COMPONENT: ${component}`);
  }
}

/**
 * Post an entry unless the product is not linked to accounting. Returns the
 * entry id or null, so callers record what was booked without branching.
 */
async function post(c, l, entry) {
  if (!booksEntries(l)) return null;
  const e = await acct.post(c, { branchId: l.branch_id || null, ...entry });
  return e.entryId;
}

// --------------------------------------------------------------------------
// Small helpers kept under the names tests and older modules use
// --------------------------------------------------------------------------

/** Interest at `monthlyRate` percent per month between two dates, simple. */
function interestFor(base, monthlyRate, from, to, convention) {
  return interestBetween(base, { rate: monthlyRate, frequency: 'PER_MONTH', convention, interestType: 'SIMPLE' }, from, to);
}

const isMonthEnd = (d) => {
  const x = toUTC(d);
  return new Date(x.getTime() + 86400000).getUTCDate() === 1;
};

module.exports = {
  OVERRIDES, effective, overrideSql, resolveOverrides, within,
  PRODUCT_COLUMNS, lock, read, principalOutstanding, balances, settlement, terms,
  scheduleInputs, shiftOffClosedDays,
  isAccrual, booksEntries, interestAccrues, paidCredit, creditsFor, writeOffCredit, post,
  interestFor, isMonthEnd,
};
