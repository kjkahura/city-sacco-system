'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const { err, round2 } = acct;

/**
 * Loan lifecycle, SQL-backed. Every function takes an open tenant client.
 *
 * Balance columns are only ever changed by SQL expressions on the numeric
 * type. Nothing is read into JS, adjusted and written back, so two tellers
 * posting repayments to the same loan cannot lose one of them.
 */

const TRANSITIONS = {
  SUBMIT:   { from: ['DRAFT'], to: 'PENDING_APPROVAL' },
  APPROVE:  { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  UNAPPROVE:{ from: ['APPROVED'], to: 'PENDING_APPROVAL' },
  REJECT:   { from: ['DRAFT', 'PENDING_APPROVAL'], to: 'CLOSED_REJECTED' },
  WITHDRAW: { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'], to: 'CLOSED_WITHDRAWN' },
};

async function lock(c, loanId) {
  const { rows } = await c.query(
    `SELECT l.*, p.method, p.gl_portfolio, p.gl_interest_inc, p.gl_fee_inc, p.gl_penalty_inc,
            p.gl_interest_rec, p.gl_fee_rec, p.gl_penalty_rec, p.gl_writeoff_exp,
            p.accounting_method, p.interest_accrual, p.day_count, p.allocation_order,
            p.enforce_deposit_multiplier, p.require_guarantor_cover, p.min_cover_percent,
            p.processing_fee, p.max_multiplier, p.monthly_rate AS product_rate
     FROM loan_accounts l
     JOIN loan_products p ON p.id = l.product_id
     WHERE l.id::text = $1 OR l.account_no = $1
     FOR UPDATE OF l`,
    [loanId]
  );
  if (!rows.length) throw err('LOAN_NOT_FOUND', 404);
  return rows[0];
}

function balances(l) {
  const principal = round2(l.principal_disbursed - l.principal_paid);
  const interest = round2(l.interest_accrued - l.interest_paid);
  const fees = round2(l.fees_due - l.fees_paid);
  const penalty = round2(l.penalty_accrued - l.penalty_paid);
  return {
    principal, interest, fees, penalty,
    total: round2(principal + interest + fees + penalty),
  };
}

// --------------------------------------------------------------------------
// Accounting rules
//
// Modelled on the rules Mambu publishes for loan products ("Linking Products
// to Accounting"). Under ACCRUAL, applying interest, a fee or a penalty
// debits that component's receivable and credits its income; paying it
// credits the receivable; writing it off clears the receivable against the
// write-off expense. Under CASH nothing is recognised until paid, and the
// payment credits income directly. Income is recognised exactly once either
// way, which the code before this did not manage: it credited interest
// income at accrual and again at repayment.
// --------------------------------------------------------------------------

const isAccrual = (l) => l.accounting_method !== 'CASH';

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

// --------------------------------------------------------------------------
// Day count conventions
//
// Interest accrues per day, as it does in Mambu, so a member who repays early
// owes interest for the days they had the money and a late payer keeps
// accruing. A rate quoted per month is annualised as twelve times the
// monthly rate and spread over the year by the product's convention.
//
// THIRTY_360 is the default because SACCO products are quoted per month:
// under 30E/360 every calendar month is deemed thirty days, so "1% a month"
// accrues to exactly 1% over any month, and the accrued interest on an
// installment date equals the schedule's figure. The ACTUAL_* conventions
// are what banks use and what Mambu defaults to.
// --------------------------------------------------------------------------

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
/** YYYY-MM-DD from a string or a Date. pg hands DATE back as a local-midnight Date. */
const ymd = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  : String(d).slice(0, 10));
const toUTC = (d) => new Date(`${ymd(d)}T00:00:00Z`);
const isoDate = (d) => d.toISOString().slice(0, 10);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const lastDayOfFeb = (d) => d.getUTCMonth() === 1 && d.getUTCDate() === (isLeap(d.getUTCFullYear()) ? 29 : 28);

/** Days from `from` (exclusive) to `to` (inclusive) under a convention. */
function dayCount(from, to, convention) {
  const a = toUTC(from);
  const b = toUTC(to);
  if (b <= a) return 0;
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

/**
 * Interest on `base` at `monthlyRate` percent per month from `from`
 * (exclusive) to `to` (inclusive). ACTUAL_ACTUAL walks the days because a
 * period can straddle a leap year and each day is a fraction of its own year.
 */
function interestFor(base, monthlyRate, from, to, convention) {
  const annual = Number(monthlyRate) * 12 / 100;
  if (convention === 'ACTUAL_ACTUAL') {
    let total = 0;
    for (let d = toUTC(from); d < toUTC(to);) {
      d = new Date(d.getTime() + DAY_MS);
      total += base * annual / (isLeap(d.getUTCFullYear()) ? 366 : 365);
    }
    return round2(total);
  }
  const days = dayCount(from, to, convention);
  const yearDays = convention === 'ACTUAL_365' ? 365 : 360;
  return round2(base * annual * days / yearDays);
}

const isMonthEnd = (d) => {
  const x = toUTC(d);
  const next = new Date(x.getTime() + DAY_MS);
  return next.getUTCDate() === 1;
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

/**
 * Flat-rate schedule: interest is a fixed percentage of original principal
 * each period, which is how the Kenyan SACCO products here are priced.
 * REDUCING is modelled but products default to FLAT.
 */
async function buildSchedule(c, l, { persist = true } = {}) {
  const principal = Number(l.principal);
  const months = Number(l.term_months);
  const rate = Number(l.monthly_rate ?? l.product_rate) / 100;
  if (!principal || !months) throw err('LOAN_MISSING_PRINCIPAL_OR_TERM');

  const start = l.disbursed_on ? new Date(l.disbursed_on) : new Date();
  const perPrincipal = round2(principal / months);
  const installments = [];

  let remaining = principal;
  let outstanding = principal;
  for (let n = 1; n <= months; n += 1) {
    const interest = l.method === 'REDUCING'
      ? round2(outstanding * rate)
      : round2(principal * rate);

    const principalAmt = n === months ? round2(remaining) : perPrincipal;
    remaining = round2(remaining - principalAmt);
    outstanding = round2(outstanding - principalAmt);

    const due = new Date(start);
    due.setUTCMonth(due.getUTCMonth() + n);
    const dueDate = await shiftOffClosedDays(c, due.toISOString().slice(0, 10));

    installments.push({
      number: n,
      dueDate,
      principal: principalAmt,
      interest,
      fee: n === 1 ? round2(l.processing_fee || 0) : 0,
    });
  }

  if (persist) {
    await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [l.id]);
    for (const i of installments) {
      await c.query(
        `INSERT INTO loan_installments (loan_id, number, due_date, principal_due, interest_due, fee_due)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [l.id, i.number, i.dueDate, i.principal, i.interest, i.fee]
      );
    }
  }

  return {
    loanId: l.id,
    method: l.method,
    totals: {
      principal,
      interest: round2(installments.reduce((s, i) => s + i.interest, 0)),
      fees: round2(installments.reduce((s, i) => s + i.fee, 0)),
    },
    installments,
  };
}

// --------------------------------------------------------------------------
// Guarantors. The SACCO-specific piece: members pledge their own deposits.
// --------------------------------------------------------------------------

async function addGuarantor(c, loanId, { memberId, amount }) {
  const l = await lock(c, loanId);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(l.status)) {
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
    rules: {
      depositMultiplier: p.enforce_deposit_multiplier ? (withinMultiplier ? 'MET' : 'BREACHED') : 'NOT_ENFORCED',
      guarantorCover: p.require_guarantor_cover ? (covered ? 'MET' : 'BREACHED') : 'NOT_ENFORCED',
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
// Lifecycle
// --------------------------------------------------------------------------

async function apply(c, { memberId, productId = 'NL01', principal, termMonths, accountNo, createdBy }) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1 AND is_active', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  if (termMonths > p.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${p.max_term}`, 400);

  const no = accountNo || (await c.query(
    `SELECT 'LN' || lpad((count(*)+1)::text, 6, '0') AS n FROM loan_accounts`)).rows[0].n;

  const { rows } = await c.query(
    `INSERT INTO loan_accounts (account_no, member_id, product_id, principal, term_months, monthly_rate, status)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING_APPROVAL') RETURNING *`,
    [no, memberId, productId, round2(principal), termMonths, p.monthly_rate]
  );
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'LOAN_APPLIED','loan_account',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]
  );
  return rows[0];
}

async function changeState(c, loanId, action, { createdBy } = {}) {
  const l = await lock(c, loanId);
  const t = TRANSITIONS[String(action).toUpperCase()];
  if (!t) throw err(`UNSUPPORTED_ACTION: ${action}`);
  if (!t.from.includes(l.status)) {
    throw err(`INVALID_STATE_TRANSITION: ${l.status} -> ${t.to}`, 409);
  }
  // Approval is where the rules bite. Applying is a request and a teller may
  // record one for any amount; approving it is the credit decision.
  if (t.to === 'APPROVED') await enforceEligibility(c, l);
  const { rows } = await c.query(
    `UPDATE loan_accounts SET status = $1, updated_at = now(),
       approved_on = CASE WHEN $1 = 'APPROVED' THEN current_date ELSE approved_on END
     WHERE id = $2 RETURNING *`,
    [t.to, l.id]
  );
  if (['CLOSED_REJECTED', 'CLOSED_WITHDRAWN'].includes(t.to)) await releaseGuarantors(c, l.id);

  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,$2,'loan_account',$3,$4,$5)`,
    [createdBy || 'SYSTEM', `LOAN_${t.to}`, l.id,
     JSON.stringify({ status: l.status }), JSON.stringify({ status: t.to })]
  );
  return rows[0];
}

async function disburse(c, loanId, { amount, channelId = 'bank', valueDate, narration, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (l.status !== 'APPROVED') throw err(`LOAN_NOT_APPROVED: ${l.status}`, 409);
  const amt = round2(amount ?? l.principal);
  if (!(amt > 0)) throw err('INVALID_DISBURSEMENT_AMOUNT');

  const { rows: [ch] } = await c.query(
    'SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId]
  );
  if (!ch) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${channelId}`);
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const entry = await acct.post(c, {
    debits: [{ glCode: l.gl_portfolio, amount: amt, memberId: l.member_id }],
    credits: [{ glCode: ch.gl_account_code, amount: amt, memberId: l.member_id }],
    narration: narration || `Disbursement ${l.account_no}`,
    sourceType: 'LOAN_DISBURSEMENT', sourceId: l.id, channelId,
    bookingDate: valueDate, createdBy,
  });

  const { rows } = await c.query(
    `UPDATE loan_accounts
     SET principal_disbursed = principal_disbursed + $1,
         fees_due = fees_due + $2,
         status = 'ACTIVE',
         disbursed_on = COALESCE($3::date, current_date),
         accrued_through = COALESCE($3::date, current_date),
         updated_at = now()
     WHERE id = $4 RETURNING *`,
    [amt, round2(l.processing_fee || 0), valueDate || null, l.id]
  );

  // Fee applied: Dr Fee Receivable, Cr Fee Income (accrual). Under cash
  // accounting nothing is booked until the fee is paid; the loan still
  // carries it as due.
  if (Number(l.processing_fee) > 0 && isAccrual(l)) {
    await acct.post(c, {
      debits: [{ glCode: l.gl_fee_rec, amount: l.processing_fee, memberId: l.member_id }],
      credits: [{ glCode: l.gl_fee_inc || l.gl_interest_inc, amount: l.processing_fee, memberId: l.member_id }],
      narration: `Processing fee ${l.account_no}`,
      sourceType: 'LOAN_FEE', sourceId: l.id, bookingDate: valueDate, createdBy,
    });
  }

  const fresh = { ...rows[0], method: l.method, product_rate: l.product_rate, processing_fee: l.processing_fee };
  await buildSchedule(c, fresh);

  return savings.record(c, {
    reference: savings.ref('LD'), kind: 'LOAN_DISBURSEMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: amt, valueDate,
    entryId: entry.entryId, narration, createdBy,
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
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  let left = round2(amount);
  if (!(left > 0)) throw err('INVALID_REPAYMENT_AMOUNT');

  const ch = (await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId])).rows[0];
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);

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
  const { PENALTY: penalty, FEE: fees, INTEREST: interest, PRINCIPAL: principal } = paid;
  const surplus = round2(left);
  const total = round2(penalty + fees + interest + principal + surplus);

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

  const entry = await acct.post(c, {
    debits: [{ glCode: ch.gl_account_code, amount: total, memberId: l.member_id }],
    credits,
    narration: narration || `Repayment ${l.account_no}`,
    sourceType: 'LOAN_REPAYMENT', sourceId: l.id, channelId,
    bookingDate: valueDate, createdBy,
  });

  await c.query(
    `UPDATE loan_accounts SET
       penalty_paid = penalty_paid + $1, fees_paid = fees_paid + $2,
       interest_paid = interest_paid + $3, principal_paid = principal_paid + $4,
       updated_at = now()
     WHERE id = $5`,
    [penalty, fees, interest, principal, l.id]
  );
  if (surplusAccount) {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2',
      [surplus, surplusAccount.id]);
  }

  await applyToInstallments(c, l.id, { principal, interest, fees });

  const after = balances((await lock(c, l.id)));
  if (after.total <= 0) {
    await c.query("UPDATE loan_accounts SET status = 'CLOSED_REPAID', updated_at = now() WHERE id = $1", [l.id]);
    await releaseGuarantors(c, l.id);
  }

  return savings.record(c, {
    reference: savings.ref('LR'), kind: 'LOAN_REPAYMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: total, valueDate, entryId: entry.entryId,
    allocation: { penalty, fees, interest, principal, surplus },
    narration, createdBy,
  });
}

async function applyToInstallments(c, loanId, { principal, interest, fees }) {
  const { rows } = await c.query(
    `SELECT * FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID' ORDER BY number`,
    [loanId]
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
 * The old implementation booked one whole month per call, so a nightly job
 * booked thirty months of interest in thirty days.
 *
 *   DAILY    interest for the elapsed days, by the product's day count
 *   MONTHLY  one month's interest, on the last day of the month only
 *   NONE     never accrues; interest is owed on the schedule and booked
 *            when paid
 *
 * Under ACCRUAL the entry is Dr Interest Receivable, Cr Interest Income.
 * Under CASH nothing is booked: the loan still tracks what is owed, and the
 * eventual payment credits income.
 */
async function accrueInterest(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) return null;
  if (l.interest_accrual === 'NONE') return null;

  const date = valueDate ? ymd(valueDate) : isoDate(new Date());
  const from = l.accrued_through || l.disbursed_on;
  if (!from) return null;
  const fromIso = ymd(from);
  if (date <= fromIso) return null;

  const rate = Number(l.monthly_rate);
  const base = l.method === 'REDUCING'
    ? round2(l.principal_disbursed - l.principal_paid)
    : Number(l.principal);

  let amt = 0;
  let through = date;
  if (l.interest_accrual === 'MONTHLY') {
    if (!isMonthEnd(date)) return null;
    // Every month-end after the marker and up to the value date, in case
    // one was missed.
    const start = toUTC(fromIso);
    const end = toUTC(date);
    let months = 0;
    for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m += 1) {
      const monthEnd = new Date(Date.UTC(y, m + 1, 0));
      if (monthEnd > end) break;
      if (monthEnd > start) months += 1;
    }
    amt = round2(base * rate / 100 * months);
  } else {
    amt = interestFor(base, rate, fromIso, date, l.day_count || 'THIRTY_360');
    through = date;
  }

  await c.query(
    'UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, accrued_through = $2::date, updated_at = now() WHERE id = $3',
    [amt, through, l.id]
  );
  if (!(amt > 0)) return null;

  let entryId = null;
  if (isAccrual(l)) {
    const entry = await acct.post(c, {
      debits: [{ glCode: l.gl_interest_rec, amount: amt, memberId: l.member_id }],
      credits: [{ glCode: l.gl_interest_inc, amount: amt, memberId: l.member_id }],
      narration: `Interest accrual ${l.account_no} ${fromIso} to ${date}`,
      sourceType: 'LOAN_INTEREST_ACCRUAL', sourceId: l.id, bookingDate: date, createdBy,
    });
    entryId = entry.entryId;
  }
  return savings.record(c, {
    reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
    loanAccountId: l.id, amount: amt, valueDate: date, entryId,
    allocation: { from: fromIso, through, base, dayCount: l.day_count, method: l.interest_accrual },
    createdBy,
  });
}

async function writeOff(c, loanId, { narration, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
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
  const entry = await acct.post(c, {
    debits: [{ glCode: l.gl_writeoff_exp, amount: booked, memberId: l.member_id }],
    credits: credits.filter((x) => x.amount > 0),
    narration: narration || `Write off ${l.account_no}`,
    sourceType: 'LOAN_WRITE_OFF', sourceId: l.id, createdBy,
  });
  await c.query(
    "UPDATE loan_accounts SET status = 'CLOSED_WRITTEN_OFF', updated_at = now() WHERE id = $1", [l.id]
  );
  // Guarantors are called, not released: their pledge is what covers this.
  await c.query(
    "UPDATE loan_guarantors SET status = 'CALLED' WHERE loan_id = $1 AND status = 'PLEDGED'", [l.id]
  );

  return savings.record(c, {
    reference: savings.ref('LW'), kind: 'LOAN_WRITE_OFF', memberId: l.member_id,
    loanAccountId: l.id, amount: b.total, entryId: entry.entryId,
    allocation: b, narration, createdBy,
  });
}

async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy } = {}) {
  const { rows } = await c.query('SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]);
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.loan_account_id) throw err('NOT_A_LOAN_TRANSACTION');

  const entry = await acct.reverse(c, tx.entry_id, narration, createdBy);
  const a = tx.allocation || {};

  if (tx.kind === 'LOAN_REPAYMENT') {
    await c.query(
      `UPDATE loan_accounts SET
         penalty_paid = penalty_paid - $1, fees_paid = fees_paid - $2,
         interest_paid = interest_paid - $3, principal_paid = principal_paid - $4,
         status = CASE WHEN status = 'CLOSED_REPAID' THEN 'ACTIVE' ELSE status END,
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
    // Rebuild installment allocation from what survives.
    await c.query(
      `UPDATE loan_installments SET principal_paid = 0, interest_paid = 0, fee_paid = 0, status = 'PENDING'
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
    await applyToInstallments(c, tx.loan_account_id, {
      principal: Number(remaining[0].p), interest: Number(remaining[0].i), fees: Number(remaining[0].f),
    });
  } else if (tx.kind === 'LOAN_DISBURSEMENT') {
    await c.query(
      `UPDATE loan_accounts SET principal_disbursed = principal_disbursed - $1,
         status = 'APPROVED', disbursed_on = NULL, updated_at = now() WHERE id = $2`,
      [tx.amount, tx.loan_account_id]
    );
  }

  const rev = await savings.record(c, {
    reference: savings.ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    loanAccountId: tx.loan_account_id, amount: -tx.amount, entryId: entry.entryId,
    allocation: { reversalOf: tx.reference }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

/** Mark overdue installments and flip the loan into arrears. */
async function markArrears(c, { asOf = null } = {}) {
  await c.query(
    `UPDATE loan_installments SET status = 'OVERDUE'
     WHERE status IN ('PENDING','PARTIALLY_PAID')
       AND due_date < COALESCE($1::date, current_date)`,
    [asOf]
  );
  const { rows } = await c.query(
    `UPDATE loan_accounts l SET status = 'IN_ARREARS', updated_at = now()
     WHERE l.status = 'ACTIVE'
       AND EXISTS (SELECT 1 FROM loan_installments i WHERE i.loan_id = l.id AND i.status = 'OVERDUE')
     RETURNING l.id, l.account_no`
  );
  return rows;
}

module.exports = {
  TRANSITIONS, lock, balances, buildSchedule, shiftOffClosedDays,
  apply, changeState, disburse, repay, accrueInterest, writeOff,
  reverseTransaction, addGuarantor, guarantorCoverage, releaseGuarantors,
  checkEligibility, enforceEligibility, markArrears, applyToInstallments,
  dayCount, interestFor, isMonthEnd, paidCredit, writeOffCredit,
};
