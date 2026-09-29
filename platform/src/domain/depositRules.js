'use strict';

/**
 * The rules a deposit product gives its accounts, after the reference platform's Deposit
 * Products pages: the product types, the interest rate on a day (fixed,
 * index plus spread, tiered per balance, band or period, and the period the
 * rate is given for), the days in a year, the interest posting dates, the
 * overdraft rate, the term, and the checks on a product's settings.
 *
 * Pure: nothing here reads the database, so ./savings (the money) and the
 * product routes share one set of rules.
 */

const TYPES = ['CURRENT_ACCOUNT', 'SAVINGS_ACCOUNT', 'FIXED_DEPOSIT', 'SAVINGS_PLAN', 'INVESTOR_ACCOUNT'];
const CATEGORIES = ['STORED_VALUE', 'DAILY_BANKING', 'PERSONAL_DEPOSIT', 'BUSINESS_BANKING', 'BUSINESS_DEPOSIT', 'UNCATEGORIZED'];
const RATE_TERMS = ['FIXED', 'INDEX', 'TIERED_BALANCE', 'TIERED_BANDS', 'TIERED_PERIOD'];
const OD_RATE_TERMS = ['FIXED', 'INDEX', 'TIERED_BALANCE'];
const FREQUENCIES = ['ANNUALIZED', 'EVERY_MONTH', 'EVERY_FOUR_WEEKS', 'EVERY_WEEK', 'EVERY_X_DAYS'];
const BALANCES = ['END_OF_DAY', 'MINIMUM', 'MINIMUM_DAILY', 'AVERAGE_DAILY'];
const DAY_COUNTS = ['ACTUAL_365', 'ACTUAL_360', 'THIRTY_360', 'ACTUAL_ACTUAL_ISDA'];
const CALENDAR = ['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL'];
const APPLICATIONS = [...CALENDAR, 'DAILY', 'FIRST_DAY_OF_MONTH', 'WEEKLY', 'EVERY_OTHER_WEEK', 'MONTHLY_FROM_ACTIVATION',
  'QUARTERLY_FROM_ACTIVATION', 'SEMI_ANNUAL_FROM_ACTIVATION', 'ANNUAL_FROM_ACTIVATION', 'FIXED_DATES', 'ON_MATURITY'];
const TERM_UNITS = ['DAYS', 'WEEKS', 'MONTHS'];
const ID_TYPES = ['RANDOM_PATTERN', 'INCREMENTAL_NUMBER'];
const MONTHLY_FEE_METHODS = ['END_OF_MONTH', 'FIRST_DAY_OF_MONTH', 'MONTHLY_FROM_ACTIVATION'];

const hasTerm = (type) => type === 'FIXED_DEPOSIT' || type === 'SAVINGS_PLAN';
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const utc = (iso) => new Date(`${ymd(iso)}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Days in the year a day belongs to, under a day count. */
function yearDays(conv, day) {
  if (conv === 'ACTUAL_360' || conv === 'THIRTY_360') return 360;
  if (conv === 'ACTUAL_ACTUAL_ISDA') return isLeap(Number(ymd(day).slice(0, 4))) ? 366 : 365;
  return 365;
}

/** The factor that turns a rate given per period into a rate per year. */
function annualFactor(p, Y) {
  switch (p.interest_rate_frequency) {
    case 'EVERY_MONTH': return 12;
    case 'EVERY_FOUR_WEEKS': return Y / 28;
    case 'EVERY_WEEK': return Y / 7;
    case 'EVERY_X_DAYS': return Y / Number(p.interest_rate_x_days || 1);
    default: return 1;
  }
}

/** The tier a value falls in: the first whose ending is at or above it, the last one past them all. */
function tierFor(tiers, value) {
  const list = Array.isArray(tiers) ? tiers : [];
  for (const t of list) if (t.ending === null || t.ending === undefined || value <= Number(t.ending)) return t;
  return list[list.length - 1] || null;
}

/**
 * The credit interest of one day on a balance, as a year's rate applied
 * over the whole year (the caller divides by the days in the year and
 * weights the day). `index` is the index rate on the day, when the product
 * is indexed. Returns { amount, rate }: amount = balance x rate / 100.
 */
function creditOn(a, balance, day, { index = null } = {}) {
  const terms = a.interest_rate_terms || 'FIXED';
  const Y = yearDays(a.interest_day_count, day);
  const f = annualFactor(a, Y);
  if (terms === 'TIERED_BANDS') {
    let amount = 0;
    let floor = 0;
    for (const t of a.interest_rate_tiers || []) {
      const top = t.ending === null || t.ending === undefined ? Infinity : Number(t.ending);
      const part = Math.max(0, Math.min(balance, top) - floor);
      amount += part * Number(t.rate) * f / 100;
      floor = top;
      if (balance <= top) break;
    }
    return { amount, rate: balance > 0 ? (amount * 100) / balance : 0 };
  }
  let rate;
  if (terms === 'INDEX') rate = (index === null ? 0 : Number(index)) + Number(a.interest_spread ?? a.interest_spread_default ?? 0);
  else if (terms === 'TIERED_BALANCE') rate = Number(tierFor(a.interest_rate_tiers, balance)?.rate || 0);
  else if (terms === 'TIERED_PERIOD') rate = Number(tierFor(a.interest_rate_tiers, Math.max(0, daysBetween(a.opened_on, day)))?.rate || 0);
  else rate = Number(a.interest_rate ?? a.annual_rate ?? 0);
  // An index rate is a year's rate already; a fixed or tiered one is given per the product's period.
  if (terms !== 'INDEX') rate *= f;
  return { amount: balance * rate / 100, rate };
}

/** The overdraft rate of one day on the overdrawn amount (a year's rate). Index plus spread is never below zero (the reference platform). */
function overdraftRateOn(a, overdrawn, { index = null } = {}) {
  const terms = a.od_rate_terms || 'FIXED';
  if (terms === 'INDEX') return Math.max(0, (index === null ? 0 : Number(index)) + Number(a.overdraft_spread ?? a.od_spread_default ?? 0));
  if (terms === 'TIERED_BALANCE') return Number(tierFor(a.od_rate_tiers, overdrawn)?.rate || 0);
  return Number(a.overdraft_annual_rate || 0);
}

/** The same day `n` months on, the day clamped to the month's end (31 Jan + 1 month = 28 or 29 Feb). */
function addMonths(iso, n, dayOfMonth = null) {
  const d = utc(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const day = Math.min(dayOfMonth || d.getUTCDate(), lastDay(ty, tm + 1));
  return new Date(Date.UTC(ty, tm, day)).toISOString().slice(0, 10);
}

/** The maturity date of a term started on a day. */
function maturityDate(start, length, unit) {
  const n = Number(length);
  if (unit === 'MONTHS') return addMonths(start, n);
  const days = unit === 'WEEKS' ? n * 7 : n;
  return new Date(utc(start).getTime() + days * 86400000).toISOString().slice(0, 10);
}

/** Whether a day is a monthly anniversary of another, every `every` months (clamped at month end). */
function isAnniversary(day, from, every) {
  if (!from) return false;
  const d = utc(day);
  const f = utc(from);
  const months = (d.getUTCFullYear() - f.getUTCFullYear()) * 12 + (d.getUTCMonth() - f.getUTCMonth());
  if (months <= 0 || months % every !== 0) return false;
  return addMonths(ymd(from), months, f.getUTCDate()) === ymd(day);
}

const isMonthEnd = (iso) => Number(ymd(iso).slice(8, 10)) === lastDay(Number(ymd(iso).slice(0, 4)), Number(ymd(iso).slice(5, 7)));

/**
 * Whether interest is applied on a day. `x` is the account (with its
 * product's columns) or, for the calendar schedules, just the schedule.
 */
function isApplicationDate(iso, x) {
  const freq = typeof x === 'string' ? x : x.interest_application;
  const acc = typeof x === 'string' ? {} : x;
  const day = ymd(iso);
  const m = Number(day.slice(5, 7));
  switch (freq) {
    case 'DAILY': return true;
    case 'FIRST_DAY_OF_MONTH': return day.slice(8, 10) === '01';
    case 'WEEKLY': case 'EVERY_OTHER_WEEK': {
      const n = acc.opened_on ? daysBetween(acc.opened_on, day) : 0;
      return n > 0 && n % (freq === 'WEEKLY' ? 7 : 14) === 0;
    }
    case 'MONTHLY_FROM_ACTIVATION': return isAnniversary(day, acc.opened_on, 1);
    case 'QUARTERLY_FROM_ACTIVATION': return isAnniversary(day, acc.opened_on, 3);
    case 'SEMI_ANNUAL_FROM_ACTIVATION': return isAnniversary(day, acc.opened_on, 6);
    case 'ANNUAL_FROM_ACTIVATION': return isAnniversary(day, acc.opened_on, 12);
    case 'FIXED_DATES': return (acc.interest_fixed_dates || []).includes(day.slice(5, 10));
    case 'ON_MATURITY': return Boolean(acc.maturity_date) && ymd(acc.maturity_date) === day;
    default:
      if (!isMonthEnd(day)) return false;
      if (freq === 'QUARTERLY') return m % 3 === 0;
      if (freq === 'SEMI_ANNUAL') return m === 6 || m === 12;
      if (freq === 'ANNUAL') return m === 12;
      return true;
  }
}

/** Whether a monthly fee falls due on a day, by its apply date method. */
function isMonthlyFeeDate(iso, method, openedOn) {
  if (method === 'FIRST_DAY_OF_MONTH') return ymd(iso).slice(8, 10) === '01';
  if (method === 'MONTHLY_FROM_ACTIVATION') return isAnniversary(iso, openedOn, 1);
  return isMonthEnd(iso);
}

function tiersProblems(tiers, label, { negative = false } = {}) {
  const out = [];
  if (!Array.isArray(tiers) || !tiers.length) return [`${label} needs at least one tier: [{ ending, rate }]`];
  let last = -Infinity;
  tiers.forEach((t, i) => {
    const open = t.ending === null || t.ending === undefined;
    if (open && i !== tiers.length - 1) out.push(`${label}: only the last tier may have no ending`);
    if (!open && !(Number(t.ending) > last)) out.push(`${label}: endings must rise`);
    if (!open) last = Number(t.ending);
    if (!Number.isFinite(Number(t.rate))) out.push(`${label}: each tier needs a rate`);
    if (Number(t.rate) < 0 && !negative) out.push(`${label}: a negative rate needs allow_negative_rate`);
  });
  return out;
}

function range(problems, label, min, def, max) {
  const [a, d, b] = [num(min), num(def), num(max)];
  if (a !== null && b !== null && a > b) problems.push(`${label}: the minimum is above the maximum`);
  if (d !== null && a !== null && d < a) problems.push(`${label}: the default is below the minimum`);
  if (d !== null && b !== null && d > b) problems.push(`${label}: the default is above the maximum`);
}

/**
 * The checks on a product's settings, merged (m: the product as it would
 * be saved; cols: what the request changes; accounts: how many accounts
 * the product has).
 */
function productProblems(m, cols, { before = null, accounts = 0 } = {}) {
  const p = [];
  const type = m.product_type;
  if (!TYPES.includes(type)) p.push(`product_type must be one of ${TYPES.join(', ')}`);
  if (m.category && !CATEGORIES.includes(m.category)) p.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if ((m.allow_overdraft || m.allow_technical_overdraft) && type !== 'CURRENT_ACCOUNT') p.push('overdrafts are for CURRENT_ACCOUNT products (the reference platform)');
  if (m.is_funding_account !== (type === 'INVESTOR_ACCOUNT')) p.push('a funding product is an INVESTOR_ACCOUNT, and an INVESTOR_ACCOUNT is a funding product');
  // New account numbers.
  if (m.id_generator_type && !ID_TYPES.includes(m.id_generator_type)) p.push(`id_generator_type must be one of ${ID_TYPES.join(', ')}`);
  if (m.id_generator_type === 'INCREMENTAL_NUMBER' && !/^[1-9][0-9]{0,17}$/.test(String(m.id_pattern || ''))) p.push('an INCREMENTAL_NUMBER id_pattern is the first number, digits only (the reference platform: letters may not be used)');
  if (m.id_generator_type === 'RANDOM_PATTERN' && !/^[A-Za-z0-9#@$_-]{1,32}$/.test(String(m.id_pattern || '')) ) p.push('a RANDOM_PATTERN id_pattern is up to 32 characters: # a digit, @ a letter, $ either');
  if (m.id_generator_type === 'RANDOM_PATTERN' && !/[#@$]/.test(String(m.id_pattern || ''))) p.push('a RANDOM_PATTERN id_pattern needs at least one #, @ or $');
  if (!m.id_generator_type && cols.id_pattern) p.push('id_pattern needs id_generator_type');
  // Interest.
  for (const [col, list] of [['interest_rate_terms', RATE_TERMS], ['interest_rate_frequency', FREQUENCIES], ['interest_calc_balance', BALANCES],
    ['interest_day_count', DAY_COUNTS], ['interest_application', APPLICATIONS], ['od_rate_terms', OD_RATE_TERMS]]) {
    if (m[col] !== undefined && m[col] !== null && !list.includes(m[col])) p.push(`${col} must be one of ${list.join(', ')}`);
  }
  if (m.od_day_count && !DAY_COUNTS.includes(m.od_day_count)) p.push(`od_day_count must be one of ${DAY_COUNTS.join(', ')}`);
  if (m.od_calc_balance && !['END_OF_DAY', 'MINIMUM_DAILY'].includes(m.od_calc_balance)) p.push('od_calc_balance must be END_OF_DAY or MINIMUM_DAILY');
  if (m.term_unit && !TERM_UNITS.includes(m.term_unit)) p.push(`term_unit must be one of ${TERM_UNITS.join(', ')}`);
  if (m.interest_rate_frequency === 'EVERY_X_DAYS' && !(Number(m.interest_rate_x_days) > 0)) p.push('EVERY_X_DAYS needs interest_rate_x_days');
  const terms = m.interest_rate_terms || 'FIXED';
  if (terms === 'FIXED') {
    range(p, 'the interest rate', m.interest_rate_min, m.annual_rate, m.interest_rate_max);
    if ((num(m.interest_rate_min) ?? 0) < 0 && !m.allow_negative_rate) p.push('a negative interest_rate_min needs allow_negative_rate');
  }
  if (terms === 'INDEX') {
    if (!m.interest_index_source_id) p.push('INDEX interest needs interest_index_source_id');
    range(p, 'the interest spread', m.interest_spread_min, m.interest_spread_default, m.interest_spread_max);
  }
  if (terms.startsWith('TIERED')) p.push(...tiersProblems(m.interest_rate_tiers, 'interest_rate_tiers', { negative: m.allow_negative_rate }));
  if (m.interest_max_balance !== null && m.interest_max_balance !== undefined && m.interest_calc_balance !== 'END_OF_DAY') {
    p.push('interest_max_balance is for the END_OF_DAY balance (the reference platform)');
  }
  if (m.interest_application === 'FIXED_DATES') {
    const dates = m.interest_fixed_dates || [];
    if (!dates.length || dates.length > 12) p.push('FIXED_DATES needs 1 to 12 interest_fixed_dates (MM-DD)');
    if (dates.some((x) => !/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(String(x)))) p.push('interest_fixed_dates are MM-DD');
  }
  if (m.interest_application === 'ON_MATURITY' && !hasTerm(type)) p.push('ON_MATURITY is for FIXED_DEPOSIT and SAVINGS_PLAN products');
  if (m.accrue_interest_after_maturity && !hasTerm(type)) p.push('accrue_interest_after_maturity is for FIXED_DEPOSIT and SAVINGS_PLAN products');
  // Deposits, withdrawals and the term.
  if (hasTerm(type)) {
    if (!m.term_unit || !(Number(m.term_default) > 0)) p.push('a FIXED_DEPOSIT or SAVINGS_PLAN needs term_unit and term_default');
    range(p, 'the term', m.term_min, m.term_default, m.term_max);
    if (m.dormancy_days) p.push('dormancy is not for products with a maturity date (the reference platform)');
  } else {
    for (const col of ['term_unit', 'term_min', 'term_max', 'term_default', 'recommended_deposit_amount']) {
      if (m[col] !== null && m[col] !== undefined) p.push(`${col} is for FIXED_DEPOSIT and SAVINGS_PLAN products`);
    }
  }
  range(p, 'the opening balance', m.min_opening_balance, m.default_opening_balance, m.max_opening_balance);
  // Overdrafts.
  const od = m.od_rate_terms || 'FIXED';
  if (m.allow_overdraft || m.allow_technical_overdraft) {
    if (od === 'FIXED') range(p, 'the overdraft rate', m.od_rate_min, m.overdraft_annual_rate, m.od_rate_max);
    if (od === 'INDEX') {
      if (!m.od_index_source_id) p.push('INDEX overdraft interest needs od_index_source_id');
      range(p, 'the overdraft spread', m.od_spread_min, m.od_spread_default, m.od_spread_max);
    }
    if (od === 'TIERED_BALANCE') p.push(...tiersProblems(m.od_rate_tiers, 'od_rate_tiers'));
  }
  // What cannot change once accounts exist.
  if (before && accounts > 0) {
    const frozen = ['product_type', 'id_generator_type', 'interest_rate_terms', 'term_unit', 'od_rate_terms']
      .filter((k) => cols[k] !== undefined && cols[k] !== before[k])
      // A savings account given overdrafts is a current account (the reference platform's definition).
      .filter((k) => !(k === 'product_type' && before.product_type === 'SAVINGS_ACCOUNT' && cols.product_type === 'CURRENT_ACCOUNT'));
    if (frozen.length) p.push(`${frozen.join(', ')} cannot change while ${accounts} account(s) exist; create a new product`);
    if (before.allow_technical_overdraft && cols.allow_technical_overdraft === false) {
      p.push('technical overdrafts can be turned off only while the product has no accounts (the reference platform)');
    }
  }
  return p;
}

/**
 * The latest review date on or before `day` for a rate reviewed every
 * `count` DAYS, WEEKS or MONTHS from `anchor` (the account's activation).
 * Before the anchor, the anchor itself.
 */
function reviewDate(anchor, day, count, unit) {
  const a = ymd(anchor);
  const d = ymd(day);
  if (d <= a) return a;
  if (unit === 'MONTHS') {
    let k = 0;
    while (addMonths(a, (k + 1) * count) <= d) k += 1;
    return addMonths(a, k * count);
  }
  const step = count * (unit === 'WEEKS' ? 7 : 1);
  const days = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const k = Math.floor(days / step);
  return new Date(Date.parse(`${a}T00:00:00Z`) + k * step * 86400000).toISOString().slice(0, 10);
}
const REVIEW_UNITS = ['DAYS', 'WEEKS', 'MONTHS'];

module.exports = {
  reviewDate, REVIEW_UNITS,
  TYPES, CATEGORIES, RATE_TERMS, OD_RATE_TERMS, FREQUENCIES, BALANCES, DAY_COUNTS, APPLICATIONS, TERM_UNITS, ID_TYPES, MONTHLY_FEE_METHODS,
  hasTerm, yearDays, annualFactor, tierFor, creditOn, overdraftRateOn, addMonths, maturityDate, isAnniversary, isMonthEnd,
  isApplicationDate, isMonthlyFeeDate, productProblems,
};
