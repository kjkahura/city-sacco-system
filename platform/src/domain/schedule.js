'use strict';

/**
 * The schedule engine: dates, rates and installment lines, with no database
 * in it. Everything here is a pure function of the product's settings and
 * the loan's terms, which is what makes it testable to the cent.
 *
 * Vocabulary, after Mambu:
 *   method          FLAT | REDUCING | REDUCING_EQUAL_INSTALLMENTS
 *   interestType    SIMPLE | CAPITALIZED | COMPOUND | COMPOUND_DAILY_REST
 *   rateFrequency   PER_YEAR | PER_MONTH | PER_WEEK | PER_DAY (what the rate is quoted in)
 *   dayCount        THIRTY_360 | ACTUAL_365 | ACTUAL_360 | ACTUAL_ACTUAL | BUS_252
 *   decimals        the currency's minor units (2 for KES, 0 for UGX), for
 *                   amounts worked out from a rate
 *   interval        { unit: MONTHS | WEEKS | DAYS, every: n } or fixed days of month
 *   grace           NONE | PRINCIPAL (interest-only periods) | PURE (nothing due)
 *   amortization    periods to amortise over; longer than the term gives a balloon
 *   rounding        NONE | WHOLE | WHOLE_UP, applied to each payment
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
/** Round to a currency's minor units. */
const roundTo = (n, decimals = 2) => {
  const f = 10 ** decimals;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};
const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');

// --------------------------------------------------------------------------
// Dates
// --------------------------------------------------------------------------

/** YYYY-MM-DD from a string or a Date. pg hands DATE back as a local-midnight Date. */
const ymd = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  : String(d).slice(0, 10));
const toUTC = (d) => new Date(`${ymd(d)}T00:00:00Z`);
const isoDate = (d) => d.toISOString().slice(0, 10);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const lastDayOfFeb = (d) => d.getUTCMonth() === 1 && d.getUTCDate() === (isLeap(d.getUTCFullYear()) ? 29 : 28);
const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const addDays = (d, n) => new Date(toUTC(d).getTime() + n * DAY_MS);

/**
 * `months` calendar months after `d`, clamped to the month end: the 31st of
 * January plus one month is the 28th of February, not the 3rd of March.
 */
function addMonths(d, months) {
  const x = toUTC(d);
  const day = x.getUTCDate();
  const target = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + months, 1));
  target.setUTCDate(Math.min(day, daysInMonth(target.getUTCFullYear(), target.getUTCMonth())));
  return target;
}

/** One repayment interval after `d`. */
function addInterval(d, { unit = 'MONTHS', every = 1 } = {}, times = 1) {
  const n = every * times;
  if (unit === 'MONTHS') return addMonths(d, n);
  if (unit === 'WEEKS') return addDays(d, 7 * n);
  return addDays(d, n);
}

/**
 * Days from `from` (exclusive) to `to` (inclusive) under a convention.
 * BUS_252 counts business days only: not Saturdays or Sundays, and not the
 * dates in `holidays` (a Set of YYYY-MM-DD), Brazil's convention.
 */
function dayCount(from, to, convention, holidays = null) {
  const a = toUTC(from);
  const b = toUTC(to);
  if (b <= a) return 0;
  if (convention === 'BUS_252') {
    let n = 0;
    for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6 && !(holidays && holidays.has(isoDate(d)))) n += 1;
    }
    return n;
  }
  if (convention === 'THIRTY_360') {
    // 30E/360 (ISDA): 31sts become 30ths, the last day of February becomes
    // the 30th, so every month counts thirty days.
    let d1 = a.getUTCDate(); let d2 = b.getUTCDate();
    if (d1 === 31 || lastDayOfFeb(a)) d1 = 30;
    if (d2 === 31 || lastDayOfFeb(b)) d2 = 30;
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 360
      + (b.getUTCMonth() - a.getUTCMonth()) * 30 + (d2 - d1);
  }
  return Math.round((b - a) / DAY_MS);
}

const yearDays = (convention) => (convention === 'BUS_252' ? 252
  : convention === 'ACTUAL_365' || convention === 'ACTUAL_ACTUAL' ? 365 : 360);

/**
 * The nominal due dates of a schedule: `count` of them, from `start`.
 *
 * Interval products fall every interval from the first due date, which is
 * one interval after `start` plus `firstOffsetDays`. Fixed-days products
 * fall on the given days of each month (payday loans: 1 and 15), with a day
 * the month does not have moved to its last day or to the 1st of the next.
 */
function nominalDueDates({ start, count, interval = { unit: 'MONTHS', every: 1 }, fixedDays = null,
  shortMonth = 'LAST_DAY', firstOffsetDays = 0 }) {
  const dates = [];
  if (Array.isArray(fixedDays) && fixedDays.length) {
    const days = [...new Set(fixedDays.map(Number))].filter((d) => d >= 1 && d <= 31).sort((a, b) => a - b);
    const floor = addDays(start, Math.max(0, firstOffsetDays));
    let y = toUTC(floor).getUTCFullYear();
    let m = toUTC(floor).getUTCMonth();
    for (let guard = 0; dates.length < count && guard < count * 12 + 24; guard += 1) {
      for (const day of days) {
        if (dates.length >= count) break;
        let d;
        if (day <= daysInMonth(y, m)) d = new Date(Date.UTC(y, m, day));
        else if (shortMonth === 'FIRST_OF_NEXT') d = new Date(Date.UTC(y, m + 1, 1));
        else d = new Date(Date.UTC(y, m, daysInMonth(y, m)));
        if (d > toUTC(floor) && (!dates.length || d > dates[dates.length - 1])) dates.push(d);
      }
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
    return dates;
  }
  const first = addDays(addInterval(start, interval, 1), firstOffsetDays);
  for (let n = 0; n < count; n += 1) dates.push(n === 0 ? first : addInterval(first, interval, n));
  return dates;
}

// --------------------------------------------------------------------------
// Rates
// --------------------------------------------------------------------------

const PERIODS_PER_YEAR = { PER_YEAR: 1, PER_MONTH: 12, PER_WEEK: 52, PER_DAY: 365 };

/**
 * The nominal annual rate as a fraction: a rate quoted per month is twelve
 * times that, per week fifty-two times, per day 365 (or 360 under a 360-day
 * convention).
 */
function annualRate(rate, frequency = 'PER_MONTH', convention = 'THIRTY_360') {
  const r = Number(rate) / 100;
  if (frequency === 'PER_DAY') return r * yearDays(convention);
  return r * (PERIODS_PER_YEAR[frequency] || 12);
}

/** Effective annual rate under compounding at the quoted frequency. */
function effectiveAnnualRate(rate, frequency = 'PER_MONTH', convention = 'THIRTY_360') {
  const r = Number(rate) / 100;
  const n = frequency === 'PER_DAY' ? yearDays(convention) : (PERIODS_PER_YEAR[frequency] || 12);
  return (1 + r) ** n - 1;
}

/**
 * Interest on `base` from `from` (exclusive) to `to` (inclusive).
 *
 *   SIMPLE / CAPITALIZED   base × annual × days / yearDays
 *   COMPOUND               base × ((1 + effective annual) ^ (days / yearDays) − 1)
 *   COMPOUND_DAILY_REST    base × ((1 + annual / yearDays) ^ days − 1)
 *
 * ACTUAL_ACTUAL walks the days because a period can straddle a leap year.
 *
 * The amount is rounded to the cent unless `exact` is asked for: interest
 * accrual keeps the unrounded amount and rounds only what it posts (see
 * ./interest), so a year of daily accruals adds up to the year's interest
 * instead of drifting by a fraction of a cent a day.
 */
function interestBetween(base, terms, from, to, { exact = false } = {}) {
  const raw = rawInterestBetween(base, terms, from, to);
  return exact ? raw : round2(raw);
}

function rawInterestBetween(base, { rate, frequency = 'PER_MONTH', convention = 'THIRTY_360', interestType = 'SIMPLE', holidays = null }, from, to) {
  if (!(base > 0) || !(Number(rate) > 0)) return 0;
  if (interestType === 'COMPOUND_DAILY_REST') {
    // Daily rest: the nominal annual rate over the days in the year, each
    // day's interest added to the balance the next day earns on.
    const annual = annualRate(rate, frequency, convention);
    if (convention === 'ACTUAL_ACTUAL') {
      let factor = 1;
      for (let d = toUTC(from); d < toUTC(to);) {
        d = addDays(d, 1);
        factor *= 1 + annual / (isLeap(d.getUTCFullYear()) ? 366 : 365);
      }
      return base * (factor - 1);
    }
    return base * ((1 + annual / yearDays(convention)) ** dayCount(from, to, convention, holidays) - 1);
  }
  if (interestType === 'COMPOUND') {
    const E = effectiveAnnualRate(rate, frequency, convention);
    if (convention === 'ACTUAL_ACTUAL') {
      let factor = 1;
      for (let d = toUTC(from); d < toUTC(to);) {
        d = addDays(d, 1);
        factor *= (1 + E) ** (1 / (isLeap(d.getUTCFullYear()) ? 366 : 365));
      }
      return base * (factor - 1);
    }
    return base * ((1 + E) ** (dayCount(from, to, convention, holidays) / yearDays(convention)) - 1);
  }
  const annual = annualRate(rate, frequency, convention);
  if (convention === 'ACTUAL_ACTUAL') {
    let total = 0;
    for (let d = toUTC(from); d < toUTC(to);) {
      d = addDays(d, 1);
      total += base * annual / (isLeap(d.getUTCFullYear()) ? 366 : 365);
    }
    return total;
  }
  return base * annual * dayCount(from, to, convention, holidays) / yearDays(convention);
}

/** The rate for one period running from `from` to `to`, as a fraction of the base. */
function periodRate(terms, from, to) {
  return interestBetween(1, terms, from, to, { exact: true });
}

/** The payment that clears `principal` at `rate` per period in `n` equal payments. */
function annuityPayment(principal, rate, n, decimals = 2) {
  if (!(n > 0)) return roundTo(principal, decimals);
  if (!(rate > 0)) return roundTo(principal / n, decimals);
  return roundTo(principal * rate / (1 - (1 + rate) ** -n), decimals);
}

/**
 * The monthly payment under daily rest (Mambu's "Compound Interest with
 * Daily Rest"): the annuity at the daily rate over the loan's days, scaled
 * back to a month. PMT(daily, months / 12 × Y, −P) × Y / 12.
 */
function dailyRestPayment(principal, terms, months, decimals = 2) {
  const Y = yearDays(terms.convention === 'ACTUAL_ACTUAL' ? 'ACTUAL_365' : terms.convention);
  const daily = annualRate(terms.rate, terms.frequency, terms.convention) / Y;
  const days = months / 12 * Y;
  if (!(daily > 0)) return roundTo(principal / months, decimals);
  return roundTo(principal * daily / (1 - (1 + daily) ** -days) * Y / 12, decimals);
}

// --------------------------------------------------------------------------
// Lines
// --------------------------------------------------------------------------

/**
 * The installment lines for `principal`.
 *
 * `periods` is the list of periods to draw, each { from, to } (nominal
 * dates) so a period's interest is its own length at the product's rate;
 * under 30E/360 a calendar month is exactly the monthly rate.
 *
 *   FLAT                         interest on the original principal, principal in equal shares
 *   REDUCING                     interest on the outstanding, principal in equal shares
 *   REDUCING_EQUAL_INSTALLMENTS  the same payment every period, principal = payment − interest
 *
 * `grace` takes the first periods: PRINCIPAL grace lines carry interest
 * only, PURE grace lines carry nothing and their interest is spread over
 * the lines that follow. `amortization` longer than the number of paying
 * periods amortises as if the loan ran that long and leaves the balance on
 * the last line (a balloon). `fixedShare` pins each period's principal (or
 * payment) and runs for as many periods as that takes, which is how a
 * dynamic loan reduces its number of installments. `extraFirstInterest` is
 * interest already accrued that the first line must carry. The last line
 * takes the remainder so the lines always sum to the principal, unless
 * `residual` is FIRST, when the first paying line takes it. Amounts are
 * rounded to `decimals`.
 */
function planInstallments(opts) {
  let lines = planOnce(opts);
  // Mambu lets the product put the leftover principal (from a longer first
  // period, or rounding) on the first installment instead of the last.
  // Moving principal to the first line lowers the interest after it, so
  // the amount is found in a few passes until the last line is regular.
  if (opts.residual !== 'FIRST' || opts.fixedShare) return lines;
  let extra = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const paying = lines.filter((x) => !x.grace);
    if (paying.length < 3) return lines;
    const last = paying[paying.length - 1];
    const prev = paying[paying.length - 2];
    const regular = opts.method === 'REDUCING_EQUAL_INSTALLMENTS' ? prev.principal + prev.interest - last.interest : prev.principal;
    const delta = roundTo(last.principal - regular, opts.decimals ?? 2);
    if (!delta) return lines;
    extra = roundTo(extra + delta, opts.decimals ?? 2);
    lines = planOnce({ ...opts, firstExtraPrincipal: extra });
  }
  return lines;
}

function planOnce({ principal, terms, method, periods, flatBase = null, grace = { type: 'NONE', periods: 0 },
  amortization = null, rounding = 'NONE', fixedShare = null, extraFirstInterest = 0, decimals = 2, firstExtraPrincipal = 0 }) {
  const rnd = (n) => roundTo(n, decimals);
  const P = rnd(principal);
  const lines = [];
  if (!(P > 0) || !periods.length) return lines;

  const equal = method === 'REDUCING_EQUAL_INSTALLMENTS';
  const graceN = grace && grace.type !== 'NONE' ? Math.min(Number(grace.periods) || 0, periods.length - 1) : 0;
  const paying = fixedShare ? Infinity : periods.length - graceN;
  const amortizeOver = Math.max(amortization || 0, paying === Infinity ? 0 : paying);
  // The annuity is priced on a regular period: the second paying period
  // where there is one, since the first may be longer or shorter (a first
  // due date offset). A longer first period then carries more interest and
  // less principal, and the principal left over lands on the last
  // installment, or the first under residual FIRST, as in Mambu.
  const refPeriod = periods[Math.min(graceN + (periods.length - graceN > 1 ? 1 : 0), periods.length - 1)];
  const rRef = periodRate(terms, refPeriod.from, refPeriod.to);
  const monthly = periods.length && (toUTC(periods[periods.length - 1].to) - toUTC(periods[0].from)) / periods.length / DAY_MS >= 27;
  const payment = equal ? (fixedShare ?? (terms.interestType === 'COMPOUND_DAILY_REST' && monthly
    ? dailyRestPayment(P, terms, amortizeOver, decimals) : annuityPayment(P, rRef, amortizeOver, decimals))) : null;
  const share = equal ? null : (fixedShare ?? rnd(P / amortizeOver));
  const minUnit = 1 / 10 ** decimals;

  let outstanding = P;
  let deferred = 0;          // interest from PURE grace periods, spread later
  let payingLeft = paying === Infinity ? Infinity : paying;
  let first = true;
  let i = 0;
  for (; i < (fixedShare ? 1000 : periods.length) && outstanding > 0; i += 1) {
    const period = periods[Math.min(i, periods.length - 1)];
    const base = method === 'FLAT' ? (flatBase ?? P) : outstanding;
    let interest = rnd(interestBetween(base, terms, period.from, period.to, { exact: true }));
    if (i === 0) interest = rnd(interest + (extraFirstInterest || 0));

    if (i < graceN) {
      if (grace.type === 'PURE') { deferred = rnd(deferred + interest); interest = 0; }
      lines.push({ principal: 0, interest, grace: grace.type });
      continue;
    }
    if (deferred > 0) {
      const perLine = rnd(deferred / payingLeft);
      interest = rnd(interest + (payingLeft === 1 ? deferred : perLine));
      deferred = rnd(deferred - (payingLeft === 1 ? deferred : perLine));
    }

    let principalAmt = equal ? rnd(payment - interest) : share;
    if (first && firstExtraPrincipal) principalAmt = rnd(principalAmt + firstExtraPrincipal);
    first = false;
    if (rounding !== 'NONE') {
      const total = principalAmt + interest;
      const rounded = rounding === 'WHOLE_UP' ? Math.ceil(total) : Math.round(total);
      principalAmt = rnd(rounded - interest);
    }
    const isLast = fixedShare ? principalAmt >= outstanding : (payingLeft === 1 || i === periods.length - 1);
    if (isLast || principalAmt > outstanding) principalAmt = outstanding;
    if (!(principalAmt > 0) && !isLast) principalAmt = minUnit;   // a payment below interest never amortises
    outstanding = rnd(outstanding - principalAmt);
    lines.push({ principal: principalAmt, interest });
    payingLeft -= 1;
    if (isLast) break;
  }
  if (outstanding > 0 && lines.length) {
    const last = lines[lines.length - 1];
    last.principal = rnd(last.principal + outstanding);
  }
  return lines;
}

/**
 * A whole schedule: nominal dates from the loan's terms, periods between
 * them, and the lines on those periods.
 */
function draftSchedule({ start, count, principal, terms, method, interval, fixedDays, shortMonth, firstOffsetDays,
  grace, amortization, rounding, extraFirstInterest = 0, skipDate = null, decimals = 2, residual = 'LAST' }) {
  // `skipDate` (Mambu's Extend Schedule for non-working days): a date it
  // refuses is dropped and every later installment takes the next date in
  // the sequence, so the loan runs longer by the periods skipped and the
  // installment after a skipped date covers both periods.
  let dates = nominalDueDates({ start, count: skipDate ? count + 60 : count, interval, fixedDays, shortMonth, firstOffsetDays });
  if (skipDate) {
    dates = dates.filter((d) => !skipDate(isoDate(d))).slice(0, count);
    if (dates.length < count) throw Object.assign(new Error('NON_WORKING_DAYS_LEAVE_NO_DUE_DATES: every candidate date is a non-working day'), { status: 409 });
  }
  const periods = dates.map((to, i) => ({ from: i === 0 ? toUTC(start) : dates[i - 1], to }));
  const lines = planInstallments({ principal, terms, method, periods, grace, amortization, rounding, extraFirstInterest, decimals, residual });
  return lines.map((line, i) => ({ number: i + 1, nominalDue: isoDate(dates[i]), ...line }));
}

module.exports = {
  round2, roundTo, ymd, toUTC, isoDate, isLeap, addDays, addMonths, addInterval, daysInMonth,
  dayCount, yearDays, nominalDueDates,
  annualRate, effectiveAnnualRate, interestBetween, periodRate, annuityPayment, dailyRestPayment,
  planInstallments, draftSchedule,
};
