'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const S = require('./schedule');
const { err, round2 } = acct;
const { ymd, isoDate, toUTC, dayCount, addMonths, annuityPayment, interestBetween } = S;

/**
 * Loan lifecycle, SQL-backed. Every function takes an open tenant client.
 *
 * Balance columns are only ever changed by SQL expressions on the numeric
 * type. Nothing is read into JS, adjusted and written back, so two tellers
 * posting repayments to the same loan cannot lose one of them.
 *
 * The schedule arithmetic lives in ./schedule (pure), fees in ./fees,
 * states and approvals in ./workflow. This module is where they meet the
 * ledger.
 */

// Product columns the loan carries around with it. The loan's own columns
// win where both exist (product_type is copied at application).
const PRODUCT_COLUMNS = `
  p.method, p.gl_portfolio, p.gl_interest_inc, p.gl_fee_inc, p.gl_penalty_inc,
  p.gl_interest_rec, p.gl_fee_rec, p.gl_penalty_rec, p.gl_writeoff_exp,
  p.accounting_method, p.interest_accrual, p.day_count, p.allocation_order,
  p.enforce_deposit_multiplier, p.require_guarantor_cover, p.min_cover_percent,
  p.prepayment_recalculation, p.accrue_late_interest,
  p.processing_fee, p.max_multiplier, p.monthly_rate AS product_rate,
  p.interest_type, p.simple_base, p.interest_posting, p.rate_frequency,
  p.repayment_interval_unit, p.repayment_interval_count, p.fixed_days_of_month, p.short_month_handling,
  p.grace_type, p.grace_periods AS product_grace_periods,
  p.amortization_periods AS product_amortization_periods, p.rounding,
  p.arrears_tolerance_days AS product_arrears_tolerance_days,
  p.arrears_tolerance_percent AS product_arrears_tolerance_percent,
  p.arrears_tolerance_floor, p.arrears_count_from, p.arrears_non_working_days,
  p.penalty_rate AS product_penalty_rate, p.penalty_basis, p.penalty_tolerance_days,
  p.charge_cap_percent, p.charge_cap_base, p.charge_cap_mode,
  p.auto_close_paid_off_days, p.auto_lock_arrears_days, p.allow_arbitrary_fees,
  p.min_principal, p.max_principal, p.name AS product_name`;

async function lock(c, loanId) {
  const { rows } = await c.query(
    `SELECT l.*, ${PRODUCT_COLUMNS}
     FROM loan_accounts l
     JOIN loan_products p ON p.id = l.product_id
     WHERE l.id::text = $1 OR l.account_no = $1
     FOR UPDATE OF l`,
    [loanId]
  );
  if (!rows.length) throw err('LOAN_NOT_FOUND', 404);
  return rows[0];
}

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

/** The loan's effective settings: its own override, else the product's. */
function effective(l) {
  return {
    penaltyRate: l.penalty_rate ?? l.product_penalty_rate ?? 0,
    gracePeriods: l.grace_periods ?? l.product_grace_periods ?? 0,
    amortization: l.amortization_periods ?? l.product_amortization_periods ?? null,
    arrearsToleranceDays: l.arrears_tolerance_days ?? l.product_arrears_tolerance_days ?? 0,
    arrearsTolerancePercent: l.arrears_tolerance_percent ?? l.product_arrears_tolerance_percent ?? null,
    firstDueOffsetDays: Number(l.first_due_offset_days || 0),
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

const isDynamic = (l) => l.product_type === 'DYNAMIC_TERM';
const isInterestFree = (l) => l.product_type === 'INTEREST_FREE' || !(Number(l.monthly_rate) > 0);

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

/** GL account credited when a component is paid. */
function paidCredit(l, component) {
  switch (component) {
    case 'PRINCIPAL': return l.gl_portfolio;
    case 'INTEREST':  return isAccrual(l) ? l.gl_interest_rec : l.gl_interest_inc;
    case 'FEE':       return isAccrual(l) ? l.gl_fee_rec : (l.gl_fee_inc || l.gl_interest_inc);
    case 'PENALTY':   return isAccrual(l) ? l.gl_penalty_rec : (l.gl_penalty_inc || l.gl_interest_inc);
    default: throw err(`UNKNOWN_COMPONENT: ${component}`);
  }
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
  const e = await acct.post(c, entry);
  return e.entryId;
}

// --------------------------------------------------------------------------
// Compatibility wrappers over the schedule engine, kept because tests and
// other modules call them by these names.
// --------------------------------------------------------------------------

/** Interest at `monthlyRate` percent per month between two dates, simple. */
function interestFor(base, monthlyRate, from, to, convention) {
  return interestBetween(base, { rate: monthlyRate, frequency: 'PER_MONTH', convention, interestType: 'SIMPLE' }, from, to);
}

const isMonthEnd = (d) => {
  const x = toUTC(d);
  return new Date(x.getTime() + 86400000).getUTCDate() === 1;
};

// --------------------------------------------------------------------------
// Schedule
// --------------------------------------------------------------------------

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

async function persistInstallments(c, loanId, installments) {
  for (const i of installments) {
    await c.query(
      `INSERT INTO loan_installments (loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [loanId, i.number, i.dueDate, i.nominalDue, i.principal, i.interest, i.fee || 0,
        i.grace === 'PURE' && !(i.fee > 0) ? 'GRACE' : 'PENDING']
    );
  }
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
    firstOffsetDays: e.firstDueOffsetDays,
    grace: { type: l.grace_type || 'NONE', periods: e.gracePeriods },
    amortization: e.amortization,
    rounding: l.rounding || 'NONE',
  };
}

/**
 * The schedule a loan is given at disbursement, on the product's repayment
 * interval, grace, amortisation and rounding. For a FIXED_TERM loan this
 * schedule is the contract; for a DYNAMIC_TERM loan it is the expectation
 * if every installment is paid on its date, and a prepayment regenerates it
 * (see reschedule).
 *
 * Payment-due fees and, on fixed-term loans, the upfront disbursement fees
 * are placed on the schedule by ./fees, which is called here.
 */
async function buildSchedule(c, l, { persist = true } = {}) {
  const fees = require('./fees');
  const count = Number(l.term_months);
  const principal = Number(l.principal_disbursed) > 0 ? principalOutstanding(l) : Number(l.principal);
  if (!principal || !count) throw err('LOAN_MISSING_PRINCIPAL_OR_TERM');
  const start = l.disbursed_on ? ymd(l.disbursed_on) : isoDate(new Date());

  const lines = S.draftSchedule({ start, count, principal, ...scheduleInputs(l) });
  const feePlan = await fees.scheduledFees(c, l, lines);
  const installments = [];
  for (const line of lines) {
    const dueDate = await shiftOffClosedDays(c, line.nominalDue);
    installments.push({ ...line, dueDate, fee: round2(feePlan[line.number] || 0) });
  }

  if (persist) {
    await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [l.id]);
    await persistInstallments(c, l.id, installments);
  }

  return {
    loanId: l.id,
    method: l.method,
    productType: l.product_type,
    totals: {
      principal,
      interest: round2(installments.reduce((s, i) => s + i.interest, 0)),
      fees: round2(installments.reduce((s, i) => s + i.fee, 0)),
    },
    installments,
  };
}

/**
 * Preview the schedule a loan would get, from a product and terms, without
 * a loan. What a teller shows a member before anything is written.
 */
async function previewSchedule(c, { productId, principal, termMonths, monthlyRate, disbursedOn, firstDueOffsetDays, gracePeriods, amortizationPeriods }) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  const l = {
    ...p, product_id: p.id, product_type: p.product_type, product_rate: p.monthly_rate,
    product_grace_periods: p.grace_periods, product_amortization_periods: p.amortization_periods,
    monthly_rate: monthlyRate ?? p.monthly_rate, principal, term_months: termMonths,
    disbursed_on: disbursedOn || null, first_due_offset_days: firstDueOffsetDays ?? p.first_due_offset_days,
    grace_periods: gracePeriods ?? null, amortization_periods: amortizationPeriods ?? null,
    principal_disbursed: 0, principal_capitalized: 0, principal_paid: 0, id: null,
  };
  return buildSchedule(c, l, { persist: false });
}

/**
 * Regenerate a DYNAMIC_TERM loan's future installments from its actual
 * outstanding balance, after a repayment on `asOf`.
 *
 * Installments already due keep their figures. Everything falling due after
 * `asOf` is redrawn over what remains of the principal once those are netted
 * off, the way the product says (Mambu's prepayment recalculation):
 *
 *   REDUCE_INSTALLMENT_AMOUNT       same number of installments, each smaller
 *   REDUCE_NUMBER_OF_INSTALLMENTS   same installment as before, fewer of them
 *   NONE                            the schedule stands as drawn
 *
 * The first redrawn period runs from `asOf` to its due date, so its interest
 * is the rest of the period on the new balance, plus whatever had accrued on
 * the old balance and is still unpaid.
 */
async function reschedule(c, l, asOf) {
  if (!isDynamic(l)) return null;
  if (!l.prepayment_recalculation || l.prepayment_recalculation === 'NONE') return null;
  const date = ymd(asOf);
  const { rows } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [l.id]);
  const past = rows.filter((r) => ymd(r.due_date) <= date);
  const future = rows.filter((r) => ymd(r.due_date) > date);
  if (!future.length) return null;

  const b = balances(l);
  const pastPrincipalStillDue = round2(past.reduce((s, r) => s + Math.max(0, r.principal_due - r.principal_paid), 0));
  const remaining = round2(b.principal - pastPrincipalStillDue);
  const inputs = scheduleInputs(l);
  const t = inputs.terms;

  let fixedShare = null;
  if (l.prepayment_recalculation === 'REDUCE_NUMBER_OF_INSTALLMENTS') {
    const P = Number(l.principal);
    const n = Number(l.term_months);
    const first = rows[0];
    const r = S.periodRate(t, ymd(l.disbursed_on), ymd(first.nominal_due));
    fixedShare = l.method === 'REDUCING_EQUAL_INSTALLMENTS' ? annuityPayment(P, r, inputs.amortization || n) : round2(P / (inputs.amortization || n));
  }

  const periods = future.map((r, i) => ({
    from: i === 0 ? toUTC(date) : toUTC(future[i - 1].nominal_due), to: toUTC(r.nominal_due),
  }));
  const amortization = inputs.amortization ? Math.max(future.length, inputs.amortization - past.length) : null;
  let lines = S.planInstallments({
    principal: remaining, terms: t, method: l.method, periods, fixedShare, amortization,
    rounding: inputs.rounding, extraFirstInterest: Math.max(0, b.interest),
  });
  if (lines.length > future.length) {
    // More periods than dates: fold the tail into the last dated line.
    const tail = lines.splice(future.length);
    const last = lines[lines.length - 1];
    last.principal = round2(last.principal + tail.reduce((s, x) => s + x.principal, 0));
    last.interest = round2(last.interest + tail.reduce((s, x) => s + x.interest, 0));
  }

  const installments = lines.map((line, i) => ({
    number: future[i].number, dueDate: ymd(future[i].due_date), nominalDue: ymd(future[i].nominal_due), ...line,
    fee: Math.max(0, round2(future[i].fee_due - future[i].fee_paid)),
  }));

  await c.query('DELETE FROM loan_installments WHERE loan_id = $1 AND id = ANY($2)', [l.id, future.map((r) => r.id)]);
  await persistInstallments(c, l.id, installments);
  await c.query(
    'UPDATE loan_accounts SET rescheduled_at = now(), reschedule_count = reschedule_count + 1 WHERE id = $1', [l.id]
  );
  return {
    recalculation: l.prepayment_recalculation, remaining, dropped: future.length - installments.length,
    installments,
  };
}

/** Last scheduled due date, or null when there is no schedule. */
async function maturityDate(c, loanId) {
  const { rows: [r] } = await c.query('SELECT max(due_date) AS d FROM loan_installments WHERE loan_id = $1', [loanId]);
  return r?.d ? ymd(r.d) : null;
}

/** Principal a FIXED_TERM loan's schedule says is still out at `date` (nominal period ends). */
function scheduledOutstanding(l, installments, date) {
  let out = principalOutstanding(l) + Number(l.principal_paid);
  for (const i of installments) {
    if (date >= ymd(i.nominal_due || i.due_date)) out -= Number(i.principal_due);
    else break;
  }
  return round2(Math.max(0, out));
}

/**
 * Interest a FIXED_TERM loan has earned by `date`, reading the schedule:
 * every period whose nominal end has passed counts in full, the period in
 * progress counts pro rata by the day count, and nothing accrues after the
 * final period. A fixed-term loan's interest is fixed; that is the point.
 *
 * Periods are measured on the nominal due dates, not the shifted ones, so a
 * due date pushed off a weekend does not spread a month's interest over
 * thirty-two days.
 */
function scheduledInterestThrough(l, installments, date, convention) {
  let from = ymd(l.disbursed_on);
  let total = 0;
  for (const i of installments) {
    const to = ymd(i.nominal_due || i.due_date);
    const interest = Number(i.interest_due);
    if (date >= to) { total += interest; from = to; continue; }
    if (date <= from) break;
    const periodDays = dayCount(from, to, convention) || 1;
    total += interest * dayCount(from, date, convention) / periodDays;
    break;
  }
  return round2(total);
}

// --------------------------------------------------------------------------
// Guarantors. The SACCO-specific piece: members pledge their own deposits.
// --------------------------------------------------------------------------

const OPEN_APPLICATION = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL'];

async function addGuarantor(c, loanId, { memberId, amount }) {
  const l = await lock(c, loanId);
  if (!OPEN_APPLICATION.includes(l.status)) {
    throw err(`CANNOT_ADD_GUARANTOR_IN_STATE: ${l.status}`, 409);
  }
  if (memberId === l.member_id) throw err('MEMBER_CANNOT_GUARANTEE_OWN_LOAN');
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_PLEDGE_AMOUNT');

  // The guarantor must actually have the deposits they are pledging, net of
  // anything already pledged elsewhere.
  const { rows: [bal] } = await c.query(
    'SELECT COALESCE(SUM(balance), 0) AS total FROM savings_accounts WHERE member_id = $1 AND status = $2',
    [memberId, 'ACTIVE']
  );
  const alreadyPledged = await savings.pledgedAmount(c, memberId);
  const free = round2(bal.total - alreadyPledged);
  if (amt > free) {
    throw err(`GUARANTOR_HAS_INSUFFICIENT_FREE_DEPOSITS: free ${free}, pledged ${amt}`, 409);
  }

  const { rows } = await c.query(
    `INSERT INTO loan_guarantors (loan_id, member_id, pledged_amount) VALUES ($1,$2,$3) RETURNING *`,
    [l.id, memberId, amt]
  );
  return rows[0];
}

async function guarantorCoverage(c, loanId) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(pledged_amount), 0) AS pledged
     FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED'`,
    [loanId]
  );
  return round2(r.pledged);
}

async function releaseGuarantors(c, loanId) {
  await c.query(
    "UPDATE loan_guarantors SET status = 'RELEASED' WHERE loan_id = $1 AND status = 'PLEDGED'",
    [loanId]
  );
}

// --------------------------------------------------------------------------
// Eligibility
// --------------------------------------------------------------------------

/**
 * The SACCO rules: you may borrow up to N times your own deposits, and the
 * loan must be covered by your deposits plus what guarantors have pledged.
 *
 * Returns the picture; `enforceEligibility` below is what refuses. Kept
 * separate so a teller can show a member the ceiling before an application
 * is written, and so approval and the preview cannot disagree about it.
 */
async function checkEligibility(c, { memberId, productId, principal, loanId = null }) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  const { rows: [d] } = await c.query(
    "SELECT COALESCE(SUM(balance), 0) AS total FROM savings_accounts WHERE member_id = $1 AND status = 'ACTIVE'",
    [memberId]
  );
  const deposits = round2(d.total);
  const requested = round2(principal);
  const ceiling = round2(deposits * Number(p.max_multiplier));
  const pledged = loanId ? await guarantorCoverage(c, loanId) : 0;
  const coverRequired = round2(requested * Number(p.min_cover_percent || 100) / 100);
  const cover = round2(deposits + pledged);

  const withinMultiplier = requested <= ceiling;
  const covered = cover >= coverRequired;
  const reasons = [];
  if (p.enforce_deposit_multiplier && !withinMultiplier) reasons.push('LOAN_EXCEEDS_DEPOSIT_MULTIPLIER');
  if (p.require_guarantor_cover && !covered) reasons.push('INSUFFICIENT_GUARANTOR_COVER');
  if (p.min_principal && requested < Number(p.min_principal)) reasons.push('BELOW_PRODUCT_MINIMUM');
  if (p.max_principal && requested > Number(p.max_principal)) reasons.push('ABOVE_PRODUCT_MAXIMUM');

  // Tenant-wide exposure controls (Mambu "Internal Controls").
  const controls = await require('./workflow').exposure(c, { memberId, loanId, requested });
  reasons.push(...controls.reasons);

  return {
    deposits,
    multiplier: Number(p.max_multiplier),
    ceiling,
    requested,
    eligible: withinMultiplier,                 // kept for older clients
    shortfall: round2(Math.max(0, requested - ceiling)),
    pledged,
    coverRequired,
    cover,
    coverShortfall: round2(Math.max(0, coverRequired - cover)),
    exposure: controls.exposure,
    rules: {
      depositMultiplier: p.enforce_deposit_multiplier ? (withinMultiplier ? 'MET' : 'BREACHED') : 'NOT_ENFORCED',
      guarantorCover: p.require_guarantor_cover ? (covered ? 'MET' : 'BREACHED') : 'NOT_ENFORCED',
      ...controls.rules,
    },
    approvable: reasons.length === 0,
    reasons,
  };
}

/** Refuse a loan that breaks a rule its product enforces. */
async function enforceEligibility(c, l) {
  const e = await checkEligibility(c, {
    memberId: l.member_id, productId: l.product_id, principal: l.principal, loanId: l.id,
  });
  if (!e.approvable) {
    throw err(`${e.reasons[0]}: deposits ${e.deposits}, pledged ${e.pledged}, requested ${e.requested}`, 409);
  }
  return e;
}

// --------------------------------------------------------------------------
// Account numbers
// --------------------------------------------------------------------------

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I or O, which read as 1 and 0
const DIGITS = '0123456789';
const pick = (s) => s[Math.floor(Math.random() * s.length)];

/**
 * Fill a product's id_pattern. '#' is a digit, '@' a letter, '$' either,
 * anything else literal. Under INCREMENTAL the run of '#' carries the
 * sequence number, zero-padded; under RANDOM every placeholder is drawn.
 */
function fillPattern(pattern, sequence = null) {
  const hashes = (pattern.match(/#/g) || []).length;
  let digits = sequence === null ? null : String(sequence).padStart(hashes, '0');
  if (digits && digits.length > hashes) {
    // The sequence outgrew the pattern; the extra digits go on the front of
    // the run rather than the number being refused.
    const extra = digits.length - hashes;
    pattern = pattern.replace('#', '#'.repeat(extra + 1));
  }
  let di = 0;
  let out = '';
  for (const ch of pattern) {
    if (ch === '#') out += digits ? digits[di++] : pick(DIGITS);
    else if (ch === '@') out += pick(LETTERS);
    else if (ch === '$') out += pick(LETTERS + DIGITS);
    else out += ch;
  }
  return out;
}

async function nextAccountNo(c, p) {
  const pattern = p.id_pattern || 'LN######';
  if ((p.id_mode || 'INCREMENTAL') === 'INCREMENTAL') {
    // Products that share a pattern share the series: the next number is
    // the larger of this product's counter and one past the highest number
    // already issued under the pattern's prefix, so two products numbered
    // LN###### never both issue LN000001.
    const prefix = pattern.split(/[#@$]/)[0];
    const { rows: [m] } = await c.query(
      `SELECT COALESCE(max(substring(account_no FROM '[0-9]+$')::bigint), 0) AS n
       FROM loan_accounts WHERE account_no LIKE $1 || '%' AND account_no ~ ('^' || $1 || '[A-Z0-9]*[0-9]+$')`,
      [prefix]);
    const { rows: [r] } = await c.query(
      `UPDATE loan_products SET id_next = GREATEST(id_next, $2::bigint + 1) + 1 WHERE id = $1 RETURNING id_next - 1 AS n`,
      [p.id, Number(m.n)]);
    return fillPattern(pattern, Number(r.n));
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = fillPattern(pattern);
    const { rowCount } = await c.query('SELECT 1 FROM loan_accounts WHERE account_no = $1', [candidate]);
    if (!rowCount) return candidate;
  }
  throw err(`ID_PATTERN_EXHAUSTED: ${pattern}`, 409);
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

/** A value must sit inside the product's band, when the product has one. */
function within(label, value, min, max) {
  if (min !== null && min !== undefined && Number(value) < Number(min)) throw err(`${label}_BELOW_PRODUCT_MINIMUM: ${min}`, 400);
  if (max !== null && max !== undefined && Number(value) > Number(max)) throw err(`${label}_ABOVE_PRODUCT_MAXIMUM: ${max}`, 400);
}

/**
 * Open a loan application under a product. The terms a member may choose
 * (amount, installments, rate, penalty rate, first due date offset, grace,
 * amortisation) each default from the product and must sit inside its
 * band. The account number follows the product's pattern and the initial
 * state is the product's: an application that still needs documents
 * starts PARTIAL_APPLICATION, one that is complete PENDING_APPROVAL.
 */
async function apply(c, { memberId, productId = 'NL01', principal, termMonths, monthlyRate, penaltyRate,
  firstDueOffsetDays, gracePeriods, amortizationPeriods, arrearsToleranceDays, purpose, notes, accountNo, createdBy }) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1 AND is_active', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);

  const amount = round2(principal ?? p.default_principal);
  if (!(amount > 0)) throw err('INVALID_PRINCIPAL', 400);
  const term = Number(termMonths ?? p.default_term);
  if (!(Number.isInteger(term) && term > 0)) throw err('INVALID_TERM', 400);
  if (term > p.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${p.max_term}`, 400);
  within('TERM', term, p.min_term, null);
  within('PRINCIPAL', amount, p.min_principal, p.max_principal);

  const free = p.product_type === 'INTEREST_FREE';
  const rate = free ? 0 : Number(monthlyRate ?? p.monthly_rate);
  if (!free && monthlyRate !== undefined) within('RATE', rate, p.rate_min, p.rate_max);
  if (free && Number(monthlyRate) > 0) throw err('INTEREST_FREE_PRODUCT_TAKES_NO_RATE', 400);

  let pen = null;
  if (penaltyRate !== undefined && penaltyRate !== null) {
    within('PENALTY_RATE', penaltyRate, p.penalty_rate_min, p.penalty_rate_max);
    pen = Number(penaltyRate);
  }
  const offset = Number(firstDueOffsetDays ?? p.first_due_offset_days ?? 0);
  if (firstDueOffsetDays !== undefined) within('FIRST_DUE_OFFSET', offset, p.first_due_offset_min, p.first_due_offset_max);
  if (gracePeriods !== undefined && gracePeriods !== null && Number(gracePeriods) >= term) throw err('GRACE_EXCEEDS_TERM', 400);
  if (amortizationPeriods !== undefined && amortizationPeriods !== null && Number(amortizationPeriods) < term) {
    throw err('AMORTIZATION_SHORTER_THAN_TERM', 400);
  }

  const controls = await require('./workflow').exposure(c, { memberId, requested: amount });
  if (controls.reasons.includes('ONE_ACTIVE_LOAN_PER_MEMBER')) throw err('MEMBER_ALREADY_HAS_AN_ACTIVE_LOAN', 409);

  const no = accountNo || await nextAccountNo(c, p);
  const status = p.initial_state || 'PENDING_APPROVAL';
  const { rows } = await c.query(
    `INSERT INTO loan_accounts (account_no, member_id, product_id, principal, term_months, monthly_rate,
                                product_type, status, penalty_rate, first_due_offset_days, grace_periods,
                                amortization_periods, arrears_tolerance_days, purpose, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [no, memberId, productId, amount, term, rate, p.product_type || 'FIXED_TERM', status, pen, offset,
      gracePeriods ?? null, amortizationPeriods ?? null, arrearsToleranceDays ?? null, purpose || null, notes || null]
  );
  await c.query(
    `INSERT INTO loan_state_history (loan_id, from_status, to_status, action, actor)
     VALUES ($1, NULL, $2, 'APPLY', $3)`, [rows[0].id, status, createdBy || 'SYSTEM']);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'LOAN_APPLIED','loan_account',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]
  );
  return rows[0];
}

/** State changes live in ./workflow; this keeps the historical entry point. */
async function changeState(c, loanId, action, opts = {}) {
  return require('./workflow').transition(c, loanId, action, opts);
}

/**
 * Disburse an approved loan. Fees the product defines for disbursement are
 * settled here: deducted fees come out of what the member receives,
 * capitalised fees are added to what they repay, upfront fees become due.
 * The schedule is drawn on the resulting principal. Under ON_DISBURSEMENT
 * posting the schedule's whole interest is applied at once.
 */
async function disburse(c, loanId, { amount, channelId = 'bank', valueDate, narration, createdBy, user = null, fees: selectedFees = [] } = {}) {
  const fees = require('./fees');
  const workflow = require('./workflow');
  const l = await lock(c, loanId);
  if (l.status !== 'APPROVED') throw err(`LOAN_NOT_APPROVED: ${l.status}`, 409);
  const amt = round2(amount ?? l.principal);
  if (!(amt > 0)) throw err('INVALID_DISBURSEMENT_AMOUNT');
  await workflow.assertMayDisburse(c, l, { actor: createdBy, amount: amt, user });

  const { rows: [ch] } = await c.query(
    'SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId]
  );
  if (!ch) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${channelId}`);
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const plan = await fees.disbursementFees(c, l, { amount: amt, selected: selectedFees });
  const paidOut = round2(amt - plan.deducted);
  if (!(paidOut > 0)) throw err('FEES_EXCEED_DISBURSEMENT', 400);

  // Dr Portfolio for the principal the member owes (amount plus anything
  // capitalised); Cr the channel for what leaves, Cr fee income (or the
  // receivable, cleared at once) for what was deducted.
  const debits = [{ glCode: l.gl_portfolio, amount: round2(amt + plan.capitalized), memberId: l.member_id }];
  const credits = [{ glCode: ch.gl_account_code, amount: paidOut, memberId: l.member_id }];
  for (const f of plan.items.filter((x) => x.feeType === 'DISBURSEMENT_DEDUCTED' || x.feeType === 'DISBURSEMENT_CAPITALIZED')) {
    credits.push({ glCode: f.glIncome, amount: f.amount, memberId: l.member_id });
  }
  const entryId = await post(c, l, {
    debits, credits,
    narration: narration || `Disbursement ${l.account_no}`,
    sourceType: 'LOAN_DISBURSEMENT', sourceId: l.id, channelId,
    bookingDate: date, createdBy,
  });

  const { rows } = await c.query(
    `UPDATE loan_accounts
     SET principal_disbursed = principal_disbursed + $1,
         principal_capitalized = principal_capitalized + $2,
         status = 'ACTIVE',
         disbursed_on = $3::date,
         accrued_through = $3::date,
         disbursed_by = $4,
         updated_at = now()
     WHERE id = $5 RETURNING *`,
    [amt, plan.capitalized, date, createdBy || null, l.id]
  );
  await workflow.history(c, l.id, { from: 'APPROVED', to: 'ACTIVE', action: 'DISBURSE', actor: createdBy });

  // Deducted and capitalised fees are recorded as paid the moment they
  // exist; upfront fees fall due, on the first installment for a fixed-term
  // loan and immediately for a dynamic one.
  for (const f of plan.items) {
    await fees.recordFee(c, l, {
      ...f, valueDate: date, createdBy,
      settled: f.feeType !== 'DISBURSEMENT_UPFRONT',
    });
  }
  const fresh = { ...l, ...rows[0], _selectedFees: selectedFees };
  const sched = await buildSchedule(c, fresh);
  await fees.placeUpfrontFees(c, fresh, plan.items.filter((x) => x.feeType === 'DISBURSEMENT_UPFRONT'));
  // A fixed-term loan's payment-due fees are fixed with its schedule and
  // applied now; a dynamic loan's fall due installment by installment.
  await fees.applyPaymentDueFees(c, fresh, isDynamic(l) ? date : '9999-12-31');

  if (l.interest_posting === 'ON_DISBURSEMENT' && !isDynamic(l) && sched.totals.interest > 0) {
    // The whole term's interest is applied on day one.
    const maturity = sched.installments[sched.installments.length - 1].nominalDue;
    await c.query(
      'UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, accrued_through = $2::date WHERE id = $3',
      [sched.totals.interest, maturity, l.id]);
    let ie = null;
    if (isAccrual(l)) {
      ie = await post(c, l, {
        debits: [{ glCode: l.gl_interest_rec, amount: sched.totals.interest, memberId: l.member_id }],
        credits: [{ glCode: l.gl_interest_inc, amount: sched.totals.interest, memberId: l.member_id }],
        narration: `Interest applied at disbursement ${l.account_no}`,
        sourceType: 'LOAN_INTEREST_ACCRUAL', sourceId: l.id, bookingDate: date, createdBy,
      });
    }
    await savings.record(c, {
      reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
      loanAccountId: l.id, amount: sched.totals.interest, valueDate: date, entryId: ie,
      allocation: { from: date, through: maturity, method: 'ON_DISBURSEMENT' }, createdBy,
    });
  }

  return savings.record(c, {
    reference: savings.ref('LD'), kind: 'LOAN_DISBURSEMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: amt, valueDate: date,
    entryId, narration, createdBy,
    allocation: { paidOut, deducted: plan.deducted, capitalized: plan.capitalized, upfront: plan.upfront },
  });
}

/**
 * Repayment allocation follows the product's `allocation_order` (default
 * penalty, fee, interest, principal). Anything left over goes to the
 * member's savings rather than sitting as an unexplained credit on the loan.
 *
 * Each component is credited to the account the accounting method says:
 * under accrual, the receivable that was debited when it was applied; under
 * cash, income. See paidCredit().
 */
async function repay(c, loanId, { amount, channelId = 'mpesa', valueDate, narration, createdBy } = {}) {
  const fees = require('./fees');
  let l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  let left = round2(amount);
  if (!(left > 0)) throw err('INVALID_REPAYMENT_AMOUNT');

  const ch = (await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId])).rows[0];
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);

  const asOf = valueDate ? ymd(valueDate) : isoDate(new Date());
  // Interest owed is brought up to the payment date first, so a prepayment
  // on a dynamic loan pays the interest it has actually earned (Mambu's
  // "apply interest on prepayments"); a capitalising product folds it into
  // principal at the same moment.
  if (isDynamic(l)) {
    await accrueInterest(c, l.id, { valueDate: asOf, createdBy });
    await fees.applyPaymentDueFees(c, l, asOf);
    l = await lock(c, l.id);
  }

  const b = balances(l);
  const due = { PENALTY: b.penalty, FEE: b.fees, INTEREST: b.interest, PRINCIPAL: b.principal };
  const paid = { PENALTY: 0, FEE: 0, INTEREST: 0, PRINCIPAL: 0 };
  const order = Array.isArray(l.allocation_order) && l.allocation_order.length === 4
    ? l.allocation_order : ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'];
  for (const component of order) {
    const t = round2(Math.min(left, Math.max(0, due[component])));
    paid[component] = t;
    left = round2(left - t);
  }
  const { PENALTY: penalty, FEE: feesPaid, INTEREST: interest, PRINCIPAL: principal } = paid;
  const surplus = round2(left);
  const total = round2(penalty + feesPaid + interest + principal + surplus);

  const credits = [];
  for (const component of order) {
    if (paid[component] > 0) {
      credits.push({ glCode: paidCredit(l, component), amount: paid[component], memberId: l.member_id });
    }
  }

  let surplusAccount = null;
  if (surplus > 0) {
    const { rows } = await c.query(
      `SELECT a.id, p.gl_liability FROM savings_accounts a
       JOIN savings_products p ON p.id = a.product_id
       WHERE a.member_id = $1 AND a.status = 'ACTIVE' ORDER BY a.opened_on LIMIT 1`,
      [l.member_id]
    );
    if (!rows.length) throw err('OVERPAYMENT_WITH_NO_SAVINGS_ACCOUNT_TO_RECEIVE_IT', 409);
    surplusAccount = rows[0];
    credits.push({ glCode: surplusAccount.gl_liability, amount: surplus, memberId: l.member_id });
  }

  // Under NONE the loan still needs the cash to land somewhere: the channel
  // and the savings surplus are booked, the loan side is not.
  const entryId = booksEntries(l)
    ? await post(c, l, {
      debits: [{ glCode: ch.gl_account_code, amount: total, memberId: l.member_id }],
      credits,
      narration: narration || `Repayment ${l.account_no}`,
      sourceType: 'LOAN_REPAYMENT', sourceId: l.id, channelId,
      bookingDate: asOf, createdBy,
    })
    : (surplus > 0 ? (await acct.post(c, {
      debits: [{ glCode: ch.gl_account_code, amount: surplus, memberId: l.member_id }],
      credits: [{ glCode: surplusAccount.gl_liability, amount: surplus, memberId: l.member_id }],
      narration: `Repayment surplus ${l.account_no}`, sourceType: 'LOAN_REPAYMENT', sourceId: l.id, channelId,
      bookingDate: asOf, createdBy,
    })).entryId : null);

  await c.query(
    `UPDATE loan_accounts SET
       penalty_paid = penalty_paid + $1, fees_paid = fees_paid + $2,
       interest_paid = interest_paid + $3, principal_paid = principal_paid + $4,
       updated_at = now()
     WHERE id = $5`,
    [penalty, feesPaid, interest, principal, l.id]
  );
  if (surplusAccount) {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2',
      [surplus, surplusAccount.id]);
  }

  const dynamic = isDynamic(l);
  // A fixed-term loan's payment settles its installments in order, however
  // early it comes. A dynamic loan's payment settles what has fallen due and
  // anything beyond that is a prepayment: it reduces the balance, and the
  // schedule for what remains is redrawn from that balance.
  await applyToInstallments(c, l.id, { principal, interest, fees: feesPaid }, dynamic ? { dueBy: asOf } : {});
  await fees.settle(c, l.id, feesPaid);

  const fresh = await lock(c, l.id);
  const after = balances(fresh);
  let rescheduled = null;
  if (after.total <= 0) {
    await c.query("UPDATE loan_accounts SET status = 'CLOSED_REPAID', closed_on = $2::date, updated_at = now() WHERE id = $1", [l.id, asOf]);
    await require('./workflow').history(c, l.id, { from: fresh.status, to: 'CLOSED_REPAID', action: 'PAID_OFF', actor: createdBy });
    await releaseGuarantors(c, l.id);
  } else if (fresh.status === 'IN_ARREARS') {
    await require('./workflow').refreshArrears(c, fresh, asOf);
  }
  if (dynamic && (principal > 0 || interest > 0)) rescheduled = await reschedule(c, fresh, asOf);

  return savings.record(c, {
    reference: savings.ref('LR'), kind: 'LOAN_REPAYMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: total, valueDate: asOf, entryId,
    allocation: {
      penalty, fees: feesPaid, interest, principal, surplus,
      ...(rescheduled ? { rescheduled: { recalculation: rescheduled.recalculation, dropped: rescheduled.dropped } } : {}),
    },
    narration, createdBy,
  });
}

/**
 * Spread paid amounts over installments, earliest first. With `dueBy`, only
 * installments due on or before that date take a share; what is left over
 * is a prepayment the caller deals with.
 */
async function applyToInstallments(c, loanId, { principal, interest, fees }, { dueBy = null } = {}) {
  const { rows } = await c.query(
    `SELECT * FROM loan_installments WHERE loan_id = $1 AND status NOT IN ('PAID', 'GRACE')
       AND ($2::date IS NULL OR due_date <= $2::date)
     ORDER BY number`,
    [loanId, dueBy]
  );
  let p = principal, i = interest, f = fees;
  for (const inst of rows) {
    if (!p && !i && !f) break;
    const pa = round2(Math.min(p, inst.principal_due - inst.principal_paid));
    const ia = round2(Math.min(i, inst.interest_due - inst.interest_paid));
    const fa = round2(Math.min(f, inst.fee_due - inst.fee_paid));
    p = round2(p - pa); i = round2(i - ia); f = round2(f - fa);

    await c.query(
      `UPDATE loan_installments SET
         principal_paid = principal_paid + $1,
         interest_paid = interest_paid + $2,
         fee_paid = fee_paid + $3,
         status = CASE
           WHEN principal_paid + $1 >= principal_due
            AND interest_paid + $2 >= interest_due
            AND fee_paid + $3 >= fee_due THEN 'PAID'
           WHEN principal_paid + $1 > 0 OR interest_paid + $2 > 0 THEN 'PARTIALLY_PAID'
           ELSE status END
       WHERE id = $4`,
      [pa, ia, fa, inst.id]
    );
  }
}

/**
 * Accrue interest through `valueDate`.
 *
 * Idempotent by construction: the loan records how far it has been accrued
 * (`accrued_through`) and each call books the days from there to the value
 * date, then moves the marker. Calling it twice for the same date books
 * nothing the second time; calling it after a missed week books the week.
 *
 *   DAILY    interest for the elapsed days, by the product's day count
 *   MONTHLY  one month's interest, on the last day of the month only
 *   NONE     never accrues; interest is owed on the schedule and booked
 *            when paid
 *
 * What a day of interest *is* depends on the product type:
 *
 *   FIXED_TERM    the schedule's interest, pro rata through the period in
 *                 progress (scheduledInterestThrough). Prepaying principal
 *                 does not lower it and paying late does not raise it, and
 *                 nothing accrues after the last period.
 *   DYNAMIC_TERM  the actual outstanding principal × the rate for the days
 *                 elapsed (SIMPLE), on principal plus unpaid interest
 *                 (SIMPLE with PRINCIPAL_AND_INTEREST, and COMPOUND), or
 *                 folded into principal on each due date (CAPITALIZED).
 *                 Past the last due date it keeps accruing only if the
 *                 product accrues late interest.
 *   INTEREST_FREE nothing, ever.
 *
 * Under ACCRUAL the entry is Dr Interest Receivable, Cr Interest Income.
 * Under CASH nothing is booked: the loan still tracks what is owed, and the
 * eventual payment credits income. CAPITALIZED interest books nothing at
 * accrual and Dr Portfolio, Cr Interest Income when it is capitalised.
 */
async function accrueInterest(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) return null;
  if (l.interest_accrual === 'NONE' || isInterestFree(l)) return null;
  if (l.interest_posting === 'ON_DISBURSEMENT' && !isDynamic(l)) return null;

  let date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const from = l.accrued_through || l.disbursed_on;
  if (!from) return null;
  const fromIso = ymd(from);
  if (date <= fromIso) return null;

  const t = terms(l);
  const dynamic = isDynamic(l);
  const capitalizing = l.interest_type === 'CAPITALIZED';
  const { rows: installments } = await c.query(
    'SELECT number, principal_due, interest_due, due_date, nominal_due FROM loan_installments WHERE loan_id = $1 ORDER BY number', [l.id]
  );

  if (dynamic && !l.accrue_late_interest && installments.length) {
    // Interest stops at maturity; penalties take over from there.
    const maturity = ymd(installments[installments.length - 1].nominal_due);
    if (fromIso >= maturity) return null;
    if (date > maturity) date = maturity;
  }

  // The base a period is priced on, at the start of the run.
  const unpaidInterest = Math.max(0, round2(l.interest_accrued - l.interest_paid));
  const onInterestToo = t.interestType === 'COMPOUND' || (t.interestType === 'SIMPLE' && l.simple_base === 'PRINCIPAL_AND_INTEREST');
  const base = dynamic
    ? round2(principalOutstanding(l) + (onInterestToo ? unpaidInterest : 0))
    : l.method === 'FLAT' ? Number(l.principal) : scheduledOutstanding(l, installments, fromIso);

  let amt = 0;
  const through = date;
  if (l.interest_accrual === 'MONTHLY') {
    if (!isMonthEnd(date)) return null;
    // Every month-end after the marker and up to the value date, in case
    // one was missed; each month priced as one period at the base.
    const start = toUTC(fromIso);
    const end = toUTC(date);
    for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m += 1) {
      const monthEnd = new Date(Date.UTC(y, m + 1, 0));
      if (monthEnd > end) break;
      if (monthEnd > start) amt = round2(amt + interestBetween(base, t, new Date(Date.UTC(y, m, 0)), monthEnd));
    }
  } else if (!dynamic && installments.length) {
    amt = round2(scheduledInterestThrough(l, installments, date, t.convention)
      - scheduledInterestThrough(l, installments, fromIso, t.convention));
  } else {
    amt = interestBetween(base, t, fromIso, date);
  }

  // A loan in arrears under a charge cap may not be charged past it.
  if (amt > 0 && l.status === 'IN_ARREARS') amt = await require('./workflow').capAllows(c, l, amt);

  await c.query(
    `UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, accrued_through = $2::date,
       charges_since_arrears = charges_since_arrears + CASE WHEN status = 'IN_ARREARS' THEN $1 ELSE 0 END,
       updated_at = now() WHERE id = $3`,
    [amt, through, l.id]
  );

  let recorded = null;
  if (amt > 0) {
    let entryId = null;
    if (isAccrual(l) && !capitalizing) {
      entryId = await post(c, l, {
        debits: [{ glCode: l.gl_interest_rec, amount: amt, memberId: l.member_id }],
        credits: [{ glCode: l.gl_interest_inc, amount: amt, memberId: l.member_id }],
        narration: `Interest accrual ${l.account_no} ${fromIso} to ${date}`,
        sourceType: 'LOAN_INTEREST_ACCRUAL', sourceId: l.id, bookingDate: date, createdBy,
      });
    }
    recorded = await savings.record(c, {
      reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
      loanAccountId: l.id, amount: amt, valueDate: date, entryId,
      allocation: {
        from: fromIso, through, base, dayCount: t.convention, method: l.interest_accrual,
        interestType: t.interestType, productType: l.product_type, basis: dynamic ? 'ACTUAL_BALANCE' : 'SCHEDULE',
      },
      createdBy,
    });
  }

  // Capitalising products fold the interest earned into principal on each
  // due date that this run crossed (and at repayment, which calls here first).
  if (capitalizing && dynamic) {
    const crossed = installments.some((i) => ymd(i.nominal_due) > fromIso && ymd(i.nominal_due) <= date);
    if (crossed) await capitalizeInterest(c, l.id, { valueDate: date, createdBy });
  }
  return recorded;
}

/**
 * Move a loan's unpaid accrued interest into principal (CAPITALIZED interest
 * type): Dr Portfolio, Cr Interest Income. From here on it is repaid, and
 * earns interest, as principal.
 */
async function capitalizeInterest(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  const amt = Math.max(0, round2(l.interest_accrued - l.interest_paid));
  if (!(amt > 0)) return null;
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  await c.query(
    `UPDATE loan_accounts SET interest_accrued = interest_accrued - $1,
       principal_capitalized = principal_capitalized + $1, updated_at = now() WHERE id = $2`, [amt, l.id]);
  const entryId = await post(c, l, {
    debits: [{ glCode: l.gl_portfolio, amount: amt, memberId: l.member_id }],
    credits: [{ glCode: l.gl_interest_inc, amount: amt, memberId: l.member_id }],
    narration: `Interest capitalised ${l.account_no}`,
    sourceType: 'LOAN_INTEREST_CAPITALIZED', sourceId: l.id, bookingDate: date, createdBy,
  });
  return savings.record(c, {
    reference: savings.ref('LC'), kind: 'LOAN_INTEREST_CAPITALIZED', memberId: l.member_id,
    loanAccountId: l.id, amount: amt, valueDate: date, entryId, createdBy,
  });
}

async function writeOff(c, loanId, { narration, createdBy } = {}) {
  const workflow = require('./workflow');
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  await workflow.assertMayWriteOff(c, l);
  const b = balances(l);
  if (b.total <= 0) throw err('NOTHING_TO_WRITE_OFF', 409);

  // Each component is cleared against the account that holds it: principal
  // out of the portfolio, and under accrual the interest, fee and penalty
  // receivables that were built up when they were applied. Under cash those
  // three were never recognised, so only the principal is booked.
  const credits = [{ glCode: writeOffCredit(l, 'PRINCIPAL'), amount: b.principal, memberId: l.member_id }];
  if (isAccrual(l)) {
    for (const [component, amount] of [['INTEREST', b.interest], ['FEE', b.fees], ['PENALTY', b.penalty]]) {
      if (amount > 0) credits.push({ glCode: writeOffCredit(l, component), amount, memberId: l.member_id });
    }
  }
  const booked = round2(credits.reduce((s2, x) => s2 + x.amount, 0));
  const entryId = await post(c, l, {
    debits: [{ glCode: l.gl_writeoff_exp, amount: booked, memberId: l.member_id }],
    credits: credits.filter((x) => x.amount > 0),
    narration: narration || `Write off ${l.account_no}`,
    sourceType: 'LOAN_WRITE_OFF', sourceId: l.id, createdBy,
  });
  await c.query(
    "UPDATE loan_accounts SET status = 'CLOSED_WRITTEN_OFF', closed_on = current_date, updated_at = now() WHERE id = $1", [l.id]
  );
  await workflow.history(c, l.id, { from: l.status, to: 'CLOSED_WRITTEN_OFF', action: 'WRITE_OFF', actor: createdBy, note: narration });
  // Guarantors are called, not released: their pledge is what covers this.
  await c.query(
    "UPDATE loan_guarantors SET status = 'CALLED' WHERE loan_id = $1 AND status = 'PLEDGED'", [l.id]
  );

  return savings.record(c, {
    reference: savings.ref('LW'), kind: 'LOAN_WRITE_OFF', memberId: l.member_id,
    loanAccountId: l.id, amount: b.total, entryId,
    allocation: b, narration, createdBy,
  });
}

async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy } = {}) {
  const { rows } = await c.query('SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]);
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.loan_account_id) throw err('NOT_A_LOAN_TRANSACTION');

  const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
  const a = tx.allocation || {};

  if (tx.kind === 'LOAN_REPAYMENT') {
    await c.query(
      `UPDATE loan_accounts SET
         penalty_paid = penalty_paid - $1, fees_paid = fees_paid - $2,
         interest_paid = interest_paid - $3, principal_paid = principal_paid - $4,
         status = CASE WHEN status = 'CLOSED_REPAID' THEN 'ACTIVE' ELSE status END,
         closed_on = CASE WHEN status = 'CLOSED_REPAID' THEN NULL ELSE closed_on END,
         updated_at = now()
       WHERE id = $5`,
      [a.penalty || 0, a.fees || 0, a.interest || 0, a.principal || 0, tx.loan_account_id]
    );
    if (a.surplus > 0) {
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1
         WHERE member_id = $2 AND status = 'ACTIVE'
           AND id = (SELECT id FROM savings_accounts WHERE member_id = $2 AND status = 'ACTIVE' ORDER BY opened_on LIMIT 1)`,
        [a.surplus, tx.member_id]
      );
    }
    // Rebuild installment allocation from what survives. A dynamic loan's
    // schedule may have been redrawn by the payment being reversed, so it
    // goes back to the schedule it was disbursed with and is redrawn from
    // the balance as it now stands.
    const restored = await lock(c, tx.loan_account_id);
    const dynamic = isDynamic(restored);
    if (dynamic) await buildSchedule(c, restored);
    await c.query(
      `UPDATE loan_installments SET principal_paid = 0, interest_paid = 0, fee_paid = 0,
         status = CASE WHEN status = 'GRACE' THEN 'GRACE' ELSE 'PENDING' END
       WHERE loan_id = $1`, [tx.loan_account_id]
    );
    const { rows: remaining } = await c.query(
      `SELECT COALESCE(SUM((allocation->>'principal')::numeric),0) AS p,
              COALESCE(SUM((allocation->>'interest')::numeric),0)  AS i,
              COALESCE(SUM((allocation->>'fees')::numeric),0)      AS f
       FROM transactions
       WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT'
         AND reversed_by IS NULL AND id <> $2`,
      [tx.loan_account_id, tx.id]
    );
    const today = isoDate(new Date());
    await applyToInstallments(c, tx.loan_account_id, {
      principal: Number(remaining[0].p), interest: Number(remaining[0].i), fees: Number(remaining[0].f),
    }, dynamic ? { dueBy: today } : {});
    await require('./fees').resettle(c, tx.loan_account_id, Number(remaining[0].f));
    if (dynamic) await reschedule(c, await lock(c, tx.loan_account_id), today);
  } else if (tx.kind === 'LOAN_DISBURSEMENT') {
    await c.query(
      `UPDATE loan_accounts SET principal_disbursed = principal_disbursed - $1,
         principal_capitalized = 0, interest_accrued = 0, accrued_through = NULL,
         status = 'APPROVED', disbursed_on = NULL, disbursed_by = NULL, updated_at = now() WHERE id = $2`,
      [tx.amount, tx.loan_account_id]
    );
    await require('./fees').undoDisbursementFees(c, tx.loan_account_id, { createdBy });
    await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [tx.loan_account_id]);
    await require('./workflow').history(c, tx.loan_account_id, { from: 'ACTIVE', to: 'APPROVED', action: 'UNDO_DISBURSE', actor: createdBy, note: narration });
  }

  const rev = await savings.record(c, {
    reference: savings.ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    loanAccountId: tx.loan_account_id, amount: -tx.amount, entryId: entry.entryId,
    allocation: { reversalOf: tx.reference }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

/**
 * Mark overdue installments and flip loans into arrears, honouring each
 * product's arrears tolerance (days, and percentage of outstanding with a
 * floor). The arrears logic itself lives in ./workflow so the EOD job, the
 * repayment path and the console read one definition.
 */
async function markArrears(c, { asOf = null } = {}) {
  return require('./workflow').markArrears(c, { asOf });
}

module.exports = {
  lock, balances, principalOutstanding, effective, terms, isDynamic, isInterestFree, isAccrual, booksEntries, post,
  buildSchedule, previewSchedule, shiftOffClosedDays, reschedule, maturityDate,
  apply, changeState, disburse, repay, accrueInterest, capitalizeInterest, writeOff,
  reverseTransaction, addGuarantor, guarantorCoverage, releaseGuarantors,
  checkEligibility, enforceEligibility, markArrears, applyToInstallments,
  dayCount, interestFor, isMonthEnd, paidCredit, writeOffCredit,
  addMonths, annuityPayment, scheduledInterestThrough, scheduledOutstanding,
  fillPattern, nextAccountNo, OPEN_APPLICATION,
};
