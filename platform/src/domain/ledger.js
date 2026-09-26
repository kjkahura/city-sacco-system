'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const tax = require('./tax');
const { err, round2 } = acct;
const { toUTC, interestBetween, ymd, isoDate, addDays } = S;

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
    band: ['arrears_tolerance_days_min', 'arrears_tolerance_days_max'],
  },
  arrearsTolerancePercent: {
    column: 'arrears_tolerance_percent', mode: 'INHERIT', label: 'ARREARS_TOLERANCE_PERCENT', fallback: null,
    band: ['arrears_tolerance_percent_min', 'arrears_tolerance_percent_max'],
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
  'gl_interest_rec', 'gl_fee_rec', 'gl_penalty_rec', 'gl_writeoff_exp', 'gl_recoveries',
  'accounting_method', 'interest_accrual', 'interest_accrued_accounting', 'accrual_granularity', 'day_count', 'allocation_order',
  'enforce_deposit_multiplier', 'require_guarantor_cover', 'min_cover_percent',
  'prepayment_recalculation', 'accrue_late_interest',
  'processing_fee', 'max_multiplier',
  'interest_type', 'simple_base', 'interest_posting', 'rate_frequency',
  'repayment_interval_unit', 'repayment_interval_count', 'fixed_days_of_month', 'short_month_handling',
  'grace_type', 'rounding', 'non_working_days', 'residual_installment', 'schedule_editing',
  'payment_method', 'allow_prepayments', 'prepayment_interest', 'prepayment_allocation', 'mark_paid_when',
  'interest_prepayment', 'gl_deferred_interest', 'allow_postdated_payments', 'gl_deferred_fee_income',
  'cover_counts_deposits', 'cap_includes_accrued', 'settlement_enabled', 'settlement_product_id', 'settlement_auto_set',
  'settlement_auto_create', 'settlement_option', 'allow_custom_allocation',
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
  return withSnapshot(rows[0]);
}

/**
 * The product settings frozen on the loan at approval (settings_snapshot):
 * the penalty method and tolerance and the arrears floor and counting
 * rules. They stand in for the product's own, so a later change to the
 * product reaches only loans still pending.
 */
const SNAPSHOT_SETTINGS = ['penalty_basis', 'penalty_tolerance_days', 'arrears_tolerance_floor', 'arrears_count_from', 'arrears_non_working_days'];
function withSnapshot(l) {
  const snap = l.settings_snapshot;
  if (snap && typeof snap === 'object') for (const k of SNAPSHOT_SETTINGS) if (Object.prototype.hasOwnProperty.call(snap, k)) l[k] = snap[k];
  return l;
}
/** SQL for a snapshot setting's value, for set-based queries over loans `l` joined to products `p`. */
const settingSql = (col, loan = 'l', product = 'p') => `COALESCE((${loan}.settings_snapshot->>'${col}')${['penalty_tolerance_days'].includes(col) ? '::int' : col === 'arrears_tolerance_floor' ? '::numeric' : ''}, ${product}.${col})`;

/** The same read without the row lock, for quotes in a read-only transaction. */
const read = (c, loanId) => lock(c, loanId, { forUpdate: false });

/** Outstanding principal: disbursed plus anything capitalised, less paid. */
const principalOutstanding = (l) => round2(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - Number(l.principal_paid));

function balances(l) {
  const principal = principalOutstanding(l);
  const interest = round2(l.interest_accrued - l.interest_paid);
  const fees = round2(l.fees_due - l.fees_paid);
  const penalty = round2(l.penalty_accrued - l.penalty_paid);
  // Fees applied with no allocation to the schedule: owed, but outside the
  // fees due, and paid only by a custom repayment.
  const nonScheduledFees = round2(Number(l.ns_fees_due || 0) - Number(l.ns_fees_paid || 0));
  return {
    principal, interest, fees, penalty, nonScheduledFees,
    total: round2(principal + interest + fees + penalty + nonScheduledFees),
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
  const charges = round2(b.interest + b.fees + b.penalty + b.nonScheduledFees);
  const capitalized = arrears === 'CAPITALIZE' ? charges : 0;
  return {
    balances: b, charges, capitalized, writtenOff: arrears === 'WRITE_OFF' ? charges : 0,
    amount: round2(b.principal + capitalized),
  };
}

/**
 * The settlement of a running loan for a reschedule or a top-up, after
 * Mambu: the principal outstanding (less what a reschedule writes off when
 * it reduces the amount, `principal` being the new amount), and of the
 * interest, fees and penalties owed, what is capitalised onto the new loan
 * (`capitalize` { interest, fees, penalty }, amounts; or all of them under
 * CAPITALIZE and none under WRITE_OFF) and what is written off (the rest).
 * Unpaid late repayment and payment-due fees move to the new loan as fees
 * (`carryFees`, Mambu's rule) and are neither capitalised nor written off.
 */
async function settlementPlan(c, l, { arrears = 'CAPITALIZE', capitalize = null, carryFees = true, principal = null } = {}) {
  const b = balances(l);
  const carried = carryFees ? (await c.query(
    `SELECT f.id, f.name, f.fee_type, f.product_fee_id, round(f.amount - f.paid, 2)::float8 AS left,
            COALESCE(pf.gl_receivable, NULL) AS gl_receivable
     FROM loan_fees f LEFT JOIN loan_product_fees pf ON pf.id = f.product_fee_id
     WHERE f.loan_id = $1 AND f.status = 'DUE' AND NOT f.non_scheduled AND f.fee_type IN ('LATE_REPAYMENT', 'PAYMENT_DUE')
       AND f.amount > f.paid ORDER BY f.applied_on, f.created_at`, [l.id])).rows : [];
  let carriedTotal = 0;
  const moving = [];
  for (const f of carried) {
    const take = round2(Math.min(Number(f.left), Math.max(0, round2(b.fees - carriedTotal))));
    if (!(take > 0)) break;
    carriedTotal = round2(carriedTotal + take);
    moving.push({ ...f, left: take });
  }
  const pool = {
    interest: Math.max(0, b.interest),
    fees: round2(Math.max(0, round2(b.fees - carriedTotal)) + Math.max(0, b.nonScheduledFees)),
    penalty: Math.max(0, b.penalty),
  };
  let cap;
  if (capitalize && typeof capitalize === 'object') {
    cap = {};
    for (const k of ['interest', 'fees', 'penalty']) {
      const v = capitalize[k] === undefined || capitalize[k] === null ? 0 : round2(capitalize[k]);
      if (!(v >= 0)) throw err(`CAPITALIZE_AMOUNT_INVALID: ${k}`, 400);
      if (v > pool[k]) throw err(`CAPITALIZE_EXCEEDS_WHAT_IS_OWED: ${k} owes ${pool[k]}`, 400);
      cap[k] = v;
    }
  } else if (arrears === 'WRITE_OFF') {
    cap = { interest: 0, fees: 0, penalty: 0 };
  } else {
    cap = { ...pool };
  }
  const wo = { interest: round2(pool.interest - cap.interest), fees: round2(pool.fees - cap.fees), penalty: round2(pool.penalty - cap.penalty) };
  let reduce = 0;
  if (principal !== null && principal !== undefined && principal !== '') {
    const p = round2(principal);
    if (!(p > 0)) throw err('INVALID_PRINCIPAL', 400);
    if (p > b.principal) throw err(`A_RESCHEDULE_KEEPS_OR_REDUCES_THE_PRINCIPAL: outstanding ${b.principal}`, 400);
    reduce = round2(b.principal - p);
  }
  const capitalized = round2(cap.interest + cap.fees + cap.penalty);
  const writtenOff = round2(wo.interest + wo.fees + wo.penalty);
  return {
    balances: b, pool, cap, wo, reduce, carried: moving, carriedTotal, capitalized, writtenOff,
    principal: round2(b.principal - reduce),
    amount: round2(b.principal - reduce + capitalized),
  };
}

/** The tenant currency's minor units (accounting_settings.currency_decimals). */
async function currencyDecimals(c) {
  const { rows: [r] } = await c.query('SELECT currency_decimals FROM accounting_settings LIMIT 1');
  return r ? Number(r.currency_decimals) : 2;
}

/** Every holiday on the calendar, for BUS/252. */
async function holidaySet(c) {
  const { rows } = await c.query('SELECT holiday_date::text AS d FROM holidays');
  return new Set(rows.map((r) => r.d));
}

/**
 * The loan's terms with what the calendar and currency add: the holidays a
 * BUS/252 count needs, and the currency's decimals.
 */
async function termsFor(c, l) {
  const t = terms(l);
  if (t.convention === 'BUS_252') t.holidays = await holidaySet(c);
  t.decimals = await currencyDecimals(c);
  return t;
}

/**
 * The schedule engine's inputs, with the calendar and currency (termsFor).
 * What buildSchedule, preview and reschedule use.
 */
async function scheduleInputsFor(c, l) {
  const inputs = scheduleInputs(l);
  inputs.terms = await termsFor(c, l);
  inputs.decimals = inputs.terms.decimals;
  return inputs;
}

/**
 * The offset that puts the first due date on the loan's first repayment
 * date (Mambu's first repayment date, set on the application or at
 * disbursement): the days between one interval after disbursement and that
 * date, or, on fixed days of the month, the days to just before it.
 */
function firstRepaymentOffset(l, interval, fixedDays) {
  if (!l.first_repayment_date || !l.disbursed_on) return null;
  const start = ymd(l.disbursed_on);
  const target = ymd(l.first_repayment_date);
  const days = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
  if (Array.isArray(fixedDays) && fixedDays.length) return Math.max(0, days(start, target) - 1);
  return days(isoDate(S.addInterval(start, interval, 1)), target);
}

/** The schedule engine's inputs for this loan. */
function scheduleInputs(l) {
  const e = effective(l);
  const interval = { unit: l.repayment_interval_unit || 'MONTHS', every: Number(l.repayment_interval_count || 1) };
  const firstOffset = firstRepaymentOffset(l, interval, l.fixed_days_of_month);
  // Capitalized interest on Declining Balance: every installment but the
  // last is interest only (the interest capitalises on its due date) and
  // the whole principal falls due at the end, as in Mambu.
  const capitalizedReducing = l.interest_type === 'CAPITALIZED' && l.method === 'REDUCING';
  return {
    terms: terms(l),
    method: l.method,
    interval,
    fixedDays: l.fixed_days_of_month,
    shortMonth: l.short_month_handling || 'LAST_DAY',
    firstOffsetDays: firstOffset === null ? (e.firstDueOffsetDays || 0) : firstOffset,
    grace: capitalizedReducing
      ? { type: 'PRINCIPAL', periods: Math.max(0, Number(l.term_months) - 1) }
      : { type: l.grace_type || 'NONE', periods: e.gracePeriods || 0 },
    amortization: e.amortizationPeriods,
    rounding: l.rounding || 'NONE',
    nonWorkingDays: l.non_working_days || 'MOVE_FORWARD',
    residual: l.residual_installment || 'LAST',
  };
}

const NON_WORKING_DAY_RULES = ['DO_NOT_RESCHEDULE', 'MOVE_FORWARD', 'MOVE_BACKWARD', 'EXTEND_SCHEDULE'];

/**
 * The days the SACCO is shut between two dates: weekends and anything in
 * the holidays table. Returns a predicate on YYYY-MM-DD.
 */
async function closedDays(c, fromIso, toIso) {
  const { rows } = await c.query(
    'SELECT holiday_date::text AS d FROM holidays WHERE holiday_date BETWEEN $1::date AND $2::date', [fromIso, toIso]);
  const holidays = new Set(rows.map((r) => r.d));
  return (iso) => {
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return dow === 0 || dow === 6 || holidays.has(iso);
  };
}

/**
 * The due date for a nominal date that may fall on a non-working day, by the
 * product's rule. EXTEND_SCHEDULE moves whole periods and is applied when the
 * schedule is drawn (./schedule draftSchedule skipDate); a date that still
 * lands on a closed day (a revolving bill, say) moves forward. MOVE_BACKWARD
 * never goes back to or before `notBefore` (disbursement, or the previous
 * installment); it moves forward instead.
 */
async function shiftOffClosedDays(c, iso, rule = 'MOVE_FORWARD', { notBefore = null } = {}) {
  const day = ymd(iso);
  if (rule === 'DO_NOT_RESCHEDULE') return day;
  const closed = await closedDays(c, isoDate(addDays(day, -14)), isoDate(addDays(day, 14)));
  if (!closed(day)) return day;
  if (rule === 'MOVE_BACKWARD') {
    let d = day;
    for (let n = 0; n < 14 && closed(d); n += 1) d = isoDate(addDays(d, -1));
    if (!closed(d) && (!notBefore || d > ymd(notBefore))) return d;
  }
  let d = day;
  for (let n = 0; n < 14 && closed(d); n += 1) d = isoDate(addDays(d, 1));
  return d;
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
  PRODUCT_COLUMNS, lock, read, principalOutstanding, balances, settlement, settlementPlan, terms,
  scheduleInputs, scheduleInputsFor, termsFor, currencyDecimals, holidaySet, shiftOffClosedDays, closedDays, NON_WORKING_DAY_RULES,
  isAccrual, booksEntries, interestAccrues, paidCredit, creditsFor, writeOffCredit, post,
  interestFor, isMonthEnd, SNAPSHOT_SETTINGS, withSnapshot, settingSql,
};
