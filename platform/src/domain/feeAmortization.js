'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const G = require('./eodGuard');
const { err, round2 } = acct;
const { ymd } = S;

/**
 * Fee amortisation, after Mambu's "Fee amortization": an up-front fee's
 * income is recognised over the loan instead of on the day it is charged.
 *
 * When the fee is applied (or the loan disbursed, for a deducted,
 * capitalised or upfront fee) its income is credited to deferred fee income
 * (a liability: the fee's own gl_deferred_income, else the product's
 * gl_deferred_fee_income, 200-350). Tax on the fee is payable at once and
 * is not deferred. A plan then spreads the income over periods
 * (loan_fee_amortization), and the end of day moves each period's share
 * from deferred fee income to fee income:
 *
 *   STRAIGHT_LINE            equal shares
 *   SUM_OF_YEARS_DIGITS      n, n-1, ... 1 parts of n(n+1)/2 (deducted fees)
 *   EFFECTIVE_INTEREST_RATE  the rate that discounts the installments to the
 *                            principal less the fee; each period recognises
 *                            that rate on the carrying amount less the
 *                            contractual interest (IFRS 9)
 *
 * and the periods are the loan's installments from the day of the fee
 * (INSTALLMENT_DUE_DATES, recognised on each due date, or
 * INSTALLMENT_DUE_DATES_DAILY, recognised a day at a time) or a custom
 * interval from that day (CUSTOM_INTERVAL, straight line). A loan that
 * closes recognises what is left; a reschedule or refinance either does the
 * same (END_ON_ORIGINAL) or carries the plan to the new loan
 * (CONTINUE_ON_NEW, same product only). Catch-up entries whose natural date
 * falls in a closed accounting period are posted on the processing date.
 */

const settingsOf = async (c, productFeeId) => {
  if (!productFeeId) return null;
  const { rows: [f] } = await c.query('SELECT * FROM loan_product_fees WHERE id = $1', [productFeeId]);
  return f || null;
};

const amortized = (fee) => Boolean(fee) && fee.amortization_profile && fee.amortization_profile !== 'NONE';

/** The deferred account a fee's income waits in. */
const deferredGl = (l, fee) => fee?.gl_deferred_income || l.gl_deferred_fee_income || '200-350';

/** Split `total` into rounded parts by weight; the last takes the rounding. */
function byWeights(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0) || 1;
  const out = weights.map((w) => round2(total * w / sum));
  out[out.length - 1] = round2(total - out.slice(0, -1).reduce((a, x) => a + x, 0));
  return out;
}

/**
 * EIR shares: r solves sum(CF_k / (1+r)^k) = principal - fee over the
 * periods; share_k = C_(k-1) r - interest_k. Rounded, the last takes the rest.
 */
function eirShares(fee, lines) {
  const P = lines.reduce((a, x) => a + x.principal, 0);
  const target = P - fee;
  if (!(target > 0) || !lines.length) return byWeights(fee, lines.map(() => 1));
  const pv = (r) => lines.reduce((a, x, k) => a + (x.principal + x.interest) / (1 + r) ** (k + 1), 0);
  let lo = -0.99; let hi = 10;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > target) lo = mid; else hi = mid;
  }
  const r = (lo + hi) / 2;
  let carrying = target;
  const raw = lines.map((x) => {
    const income = carrying * r;
    carrying = carrying + income - (x.principal + x.interest);
    return Math.max(0, income - x.interest);
  });
  const shares = raw.map((x) => round2(x));
  shares[shares.length - 1] = round2(fee - shares.slice(0, -1).reduce((a, x) => a + x, 0));
  return shares;
}

/**
 * Draw the plan for a loan fee whose income is deferred. Periods are the
 * installments falling due after `from`, or the product fee's custom
 * interval. With nothing to spread over, the income is recognised at once.
 */
async function plan(c, l, loanFee, fee, { from, createdBy } = {}) {
  const amount = round2(Number(loanFee.deferred || 0));
  if (!(amount > 0)) return [];
  const start = ymd(from || loanFee.applied_on);
  const { rowCount } = await c.query('SELECT 1 FROM loan_fee_amortization WHERE loan_fee_id = $1', [loanFee.id]);
  if (rowCount) return [];
  let periods = [];
  let lines = [];
  if (fee.amortization_frequency === 'CUSTOM_INTERVAL') {
    const iv = { unit: fee.amortization_interval_unit === 'YEARS' ? 'MONTHS' : fee.amortization_interval_unit,
      every: Number(fee.amortization_interval_count) * (fee.amortization_interval_unit === 'YEARS' ? 12 : 1) };
    for (let k = 0; k < Number(fee.amortization_intervals); k += 1) {
      periods.push({ start: S.isoDate(S.addInterval(start, iv, k)), end: S.isoDate(S.addInterval(start, iv, k + 1)) });
    }
  } else {
    const { rows } = await c.query(
      'SELECT * FROM loan_installments WHERE loan_id = $1 AND due_date > $2::date ORDER BY number', [l.id, start]);
    let prev = start;
    for (const i of rows) {
      periods.push({ start: prev, end: ymd(i.due_date) });
      lines.push({ principal: Number(i.principal_due), interest: Number(i.interest_due) });
      prev = ymd(i.due_date);
    }
  }
  if (!periods.length) {
    await recognise(c, l, [{ deferred: loanFee.gl_deferred, income: incomeGl(l, fee), amount }], start, createdBy, 'Fee income recognised');
    await c.query('UPDATE loan_fees SET recognised = recognised + $1 WHERE id = $2', [amount, loanFee.id]);
    return [];
  }
  const n = periods.length;
  let shares;
  if (fee.amortization_profile === 'SUM_OF_YEARS_DIGITS') shares = byWeights(amount, periods.map((_, k) => n - k));
  else if (fee.amortization_profile === 'EFFECTIVE_INTEREST_RATE') shares = eirShares(amount, lines);
  else shares = byWeights(amount, periods.map(() => 1));
  const daily = fee.amortization_frequency === 'INSTALLMENT_DUE_DATES_DAILY';
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const { rows: [r] } = await c.query(
      `INSERT INTO loan_fee_amortization (loan_fee_id, loan_id, number, period_start, period_end, amount, daily)
       VALUES ($1,$2,$3,$4::date,$5::date,$6,$7) RETURNING *`,
      [loanFee.id, l.id, k + 1, periods[k].start, periods[k].end, shares[k], daily]);
    out.push(r);
  }
  return out;
}

const incomeGl = (l, fee) => fee?.gl_income || l.gl_fee_inc || l.gl_interest_inc;

/** Post Dr Deferred Fee Income, Cr Fee Income for `lines` ({ deferred, income, amount }). */
async function recognise(c, l, lines, date, createdBy, narration) {
  const debits = [];
  const credits = [];
  for (const x of lines) {
    if (!(x.amount > 0)) continue;
    debits.push({ glCode: x.deferred, amount: x.amount, memberId: l.member_id });
    credits.push({ glCode: x.income, amount: x.amount, memberId: l.member_id });
  }
  if (!debits.length) return null;
  return ledger.post(c, l, {
    debits, credits, narration: `${narration} ${l.account_no}`,
    sourceType: 'LOAN_FEE_AMORTIZATION', sourceId: l.id, bookingDate: date, createdBy,
  });
}

/** Rows of a loan's plans with the accounts they post to. */
async function openRows(c, loanId, where = '', params = []) {
  const { rows } = await c.query(
    `SELECT a.*, f.gl_deferred, pf.gl_income FROM loan_fee_amortization a
     JOIN loan_fees f ON f.id = a.loan_fee_id
     LEFT JOIN loan_product_fees pf ON pf.id = f.product_fee_id
     WHERE a.loan_id = $1 AND a.status = 'OPEN' ${where} ORDER BY a.period_end, a.id`, [loanId, ...params]);
  return rows;
}

/**
 * The end-of-day step: recognise what each open period has earned by
 * `asOf`. A period on due dates is recognised whole on its end date; a
 * daily one in proportion to the days elapsed.
 */
async function run(c, { asOf = null, createdBy = 'EOD', loanId = null } = {}) {
  const date = asOf ? ymd(asOf) : S.isoDate(new Date());
  const { rows: loans } = await c.query(
    `SELECT DISTINCT loan_id FROM loan_fee_amortization WHERE status = 'OPEN' AND period_start < $1::date
       AND ${G.EXCLUDED_ID_SQL('loan_id')} AND ($2::uuid IS NULL OR loan_id = $2::uuid)`, [date, loanId]);
  let posted = 0;
  let total = 0;
  const run = await G.eachLoan(c, { job: 'amortizeFees', date }, loans.map((r) => r.loan_id), async (loanId) => {
    const l = await ledger.lock(c, loanId);
    const closed = await acct.closedThrough(c, l.branch_id || null);
    const byDate = new Map();
    for (const a of await openRows(c, l.id, 'AND a.period_start < $2::date', [date])) {
      const start = ymd(a.period_start);
      const end = ymd(a.period_end);
      let target;
      if (a.daily) {
        const span = Math.max(1, S.dayCount(start, end, 'ACTUAL_365'));
        target = round2(Number(a.amount) * Math.min(1, S.dayCount(start, date, 'ACTUAL_365') / span));
      } else {
        target = end <= date ? Number(a.amount) : 0;
      }
      const delta = round2(target - Number(a.recognised));
      if (!(delta > 0)) continue;
      // A period that ended before today is posted on its own date, unless
      // that date is in a closed period; then on the processing date.
      const on = !a.daily && end < date && (!closed || end > closed) ? end : date;
      if (!byDate.has(on)) byDate.set(on, []);
      byDate.get(on).push({ a, delta });
    }
    for (const [on, items] of byDate) {
      await recognise(c, l, items.map(({ a, delta }) => ({ deferred: a.gl_deferred, income: a.gl_income || incomeGl(l, null), amount: delta })),
        on, createdBy, 'Fee income amortised');
      for (const { a, delta } of items) {
        await c.query(
          `UPDATE loan_fee_amortization SET recognised = recognised + $1,
             status = CASE WHEN recognised + $1 >= amount THEN 'DONE' ELSE status END WHERE id = $2`, [delta, a.id]);
        await c.query('UPDATE loan_fees SET recognised = recognised + $1 WHERE id = $2', [delta, a.loan_fee_id]);
        posted += 1;
        total = round2(total + delta);
      }
    }
  });
  return { loans: loans.length, periods: posted, recognised: total, ...G.summary(run) };
}

/**
 * A loan that closes (paid off, written off, or settled by a reschedule or
 * top-up whose fees end here) recognises every share still deferred, in
 * one entry that a reversal of the closing payment can take back.
 */
async function recogniseRemaining(c, loanId, { date, createdBy, rows = null } = {}) {
  const l = await ledger.lock(c, loanId);
  const open = rows || await openRows(c, l.id);
  const items = open.map((a) => ({ a, delta: round2(Number(a.amount) - Number(a.recognised)) })).filter((x) => x.delta > 0);
  if (!items.length) {
    for (const a of open) await c.query("UPDATE loan_fee_amortization SET status = 'DONE' WHERE id = $1", [a.id]);
    return 0;
  }
  const on = date ? ymd(date) : S.isoDate(new Date());
  const entryId = await recognise(c, l, items.map(({ a, delta }) => ({ deferred: a.gl_deferred, income: a.gl_income || incomeGl(l, null), amount: delta })),
    on, createdBy, 'Deferred fee income recognised at closure');
  let total = 0;
  for (const { a, delta } of items) {
    await c.query(
      `UPDATE loan_fee_amortization SET recognised = amount, status = 'DONE', closure_entry_id = $2, closure_amount = $3 WHERE id = $1`,
      [a.id, entryId, delta]);
    await c.query('UPDATE loan_fees SET recognised = recognised + $1 WHERE id = $2', [delta, a.loan_fee_id]);
    total = round2(total + delta);
  }
  return total;
}

/** A reversal that reopens the loan takes back what its closure recognised. */
async function undoClosure(c, loanId, { createdBy, narration = 'Loan reopened' } = {}) {
  const { rows } = await c.query(
    'SELECT * FROM loan_fee_amortization WHERE loan_id = $1 AND closure_entry_id IS NOT NULL', [loanId]);
  const entries = [...new Set(rows.map((r) => r.closure_entry_id).filter(Boolean))];
  for (const e of entries) await acct.reverse(c, e, `${narration}: deferred fee income restored`, createdBy);
  for (const r of rows) {
    await c.query(
      `UPDATE loan_fee_amortization SET recognised = recognised - closure_amount, status = 'OPEN', closure_entry_id = NULL, closure_amount = NULL
       WHERE id = $1`, [r.id]);
    await c.query('UPDATE loan_fees SET recognised = recognised - $1 WHERE id = $2', [r.closure_amount || 0, r.loan_fee_id]);
  }
  return rows.length;
}

/**
 * A reschedule or refinance: plans whose fee continues on the new loan
 * move to it (the new loan must be under the same product); the rest are
 * recognised now.
 */
async function carryOver(c, oldLoan, newLoan, { date, createdBy } = {}) {
  const open = await openRows(c, oldLoan.id);
  if (!open.length) return { moved: 0, recognised: 0 };
  const { rows: cont } = await c.query(
    `SELECT DISTINCT a.loan_fee_id FROM loan_fee_amortization a JOIN loan_fees f ON f.id = a.loan_fee_id
     JOIN loan_product_fees pf ON pf.id = f.product_fee_id
     WHERE a.loan_id = $1 AND a.status = 'OPEN' AND pf.amortization_on_reschedule = 'CONTINUE_ON_NEW'`, [oldLoan.id]);
  const continuing = new Set(cont.map((r) => r.loan_fee_id));
  if (continuing.size && newLoan.product_id !== oldLoan.product_id) {
    throw err('FEE_AMORTIZATION_CONTINUES_ONLY_ON_THE_SAME_PRODUCT: reschedule or refinance under the same product', 409);
  }
  const moving = open.filter((a) => continuing.has(a.loan_fee_id));
  const ending = open.filter((a) => !continuing.has(a.loan_fee_id));
  if (moving.length) await c.query('UPDATE loan_fee_amortization SET loan_id = $1 WHERE id = ANY($2)', [newLoan.id, moving.map((a) => a.id)]);
  const recognised = ending.length ? await recogniseRemaining(c, oldLoan.id, { date, createdBy, rows: ending }) : 0;
  return { moved: moving.length, recognised };
}

/**
 * A fee waived or a disbursement undone: what was recognised goes back to
 * deferred fee income (Dr Fee Income, Cr Deferred), and the plan is
 * cancelled, so reversing the fee's own entry clears the deferred account.
 */
async function cancel(c, loanFeeId, { createdBy, narration = 'Fee cancelled' } = {}) {
  const { rows: [f] } = await c.query(
    `SELECT f.*, pf.gl_income FROM loan_fees f LEFT JOIN loan_product_fees pf ON pf.id = f.product_fee_id WHERE f.id = $1`, [loanFeeId]);
  if (!f || !(Number(f.deferred) > 0)) return 0;
  const l = await ledger.lock(c, f.loan_id);
  const back = round2(Number(f.recognised));
  if (back > 0) {
    await ledger.post(c, l, {
      debits: [{ glCode: f.gl_income || incomeGl(l, null), amount: back, memberId: l.member_id }],
      credits: [{ glCode: f.gl_deferred, amount: back, memberId: l.member_id }],
      narration: `${narration}: fee income taken back ${l.account_no}`,
      sourceType: 'LOAN_FEE_AMORTIZATION', sourceId: l.id, createdBy,
    });
  }
  await c.query("UPDATE loan_fee_amortization SET status = 'CANCELLED' WHERE loan_fee_id = $1 AND status <> 'CANCELLED'", [f.id]);
  await c.query('UPDATE loan_fees SET recognised = 0 WHERE id = $1', [f.id]);
  return back;
}

async function forLoan(c, loanId) {
  const l = await ledger.read(c, loanId);
  const { rows } = await c.query(
    `SELECT a.*, f.name AS fee_name FROM loan_fee_amortization a JOIN loan_fees f ON f.id = a.loan_fee_id
     WHERE a.loan_id = $1 ORDER BY f.applied_on, a.loan_fee_id, a.number`, [l.id]);
  return rows;
}

module.exports = {
  settingsOf, amortized, deferredGl, plan, run, recogniseRemaining, undoClosure, carryOver, cancel, forLoan, eirShares, byWeights,
};
