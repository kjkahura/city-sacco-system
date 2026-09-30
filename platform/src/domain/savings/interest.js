'use strict';

/**
 * Deposit accounts: interest accrual, application and repricing, term and maturity.
 */

const DR = require('../depositRules');
const { orgToday } = require('../../lib/orgDate');
const acct = require('../accounting');
const S = require('../schedule');
const accruals = require('../accruals');
const { recordAudit } = require('../../lib/auditLog');
const { err, round2 } = acct;
const core = require('./core');
const funds = require('./funds');

const weight = (prev, day, conv) => (conv === 'THIRTY_360' ? S.dayCount(prev, day, 'THIRTY_360') : 1);
// Whether interest is applied on a day: the calendar schedules, and the reference platform's (../depositRules).
const isApplicationDate = DR.isApplicationDate;

/**
 * The index rate of a source on each day of a range, from the rates in
 * force. With a review frequency (the reference platform's Interest Rate Review Frequency:
 * every `count` DAYS, WEEKS or MONTHS from the account's activation) a day
 * takes the rate in force on its latest review date; without one, the rate
 * in force that day.
 */
async function indexRates(c, sourceId, from, to, review = null) {
  if (!sourceId) return () => null;
  const { rows } = await c.query(
    `SELECT valid_from::text AS d, rate FROM index_rates WHERE source_id = $1 AND valid_from <= $2::date ORDER BY valid_from`, [sourceId, to]);
  const on = (day) => {
    let r = null;
    for (const x of rows) { if (x.d <= day) r = Number(x.rate); else break; }
    return r;
  };
  if (!review || !review.count || !review.unit || !review.anchor) return on;
  return (day) => on(DR.reviewDate(review.anchor, day, review.count, review.unit));
}

/**
 * Accrue interest through `date`: positive interest on a positive balance,
 * negative interest where the rate is below zero, overdraft interest on a
 * negative balance.
 *
 * Each day's balance is recorded in savings_daily_balances; for days the end
 * of day did not run on (a catch-up), the balance as it stands is used.
 * END_OF_DAY prices each day on that day's balance; MINIMUM prices the
 * period so far on its lowest balance and books the change.
 *
 * Under ACCRUAL with a GL accrual method, what has accrued is booked to the
 * payable (or receivable) as it changes, through ../accruals.
 */
/** What the accrual of an account needs for a range of days: its rules, and the index rates in force. */
async function accrualContext(c, a, start, date) {
  const conv = a.interest_day_count || 'ACTUAL_365';
  return {
    interestOn: Boolean(a.interest_paid_into_account) && !a.is_funding_account,
    conv, odConv: a.od_day_count || conv,
    threshold: a.min_balance_for_interest === null ? null : Number(a.min_balance_for_interest),
    cap: a.interest_max_balance === null || a.interest_max_balance === undefined ? null : Number(a.interest_max_balance),
    basis: a.interest_calc_balance || 'END_OF_DAY',
    // Locked accounts earn only if the product collects interest when locked;
    // after maturity only if it accrues after maturity (the reference platform).
    lockedOut: a.status === 'LOCKED' && a.collect_interest_when_locked === false,
    // A dormant account accrues no interest, credit or overdraft (the reference platform); its days are still recorded.
    dormant: a.status === 'DORMANT',
    maturity: a.maturity_date ? S.ymd(a.maturity_date) : null,
    creditIndex: await indexRates(c, a.interest_rate_terms === 'INDEX' ? a.interest_index_source_id : null, start, date,
      { count: a.interest_review_count, unit: a.interest_review_unit, anchor: S.ymd(a.activated_on || a.opened_on) }),
    odIndex: await indexRates(c, a.od_rate_terms === 'INDEX' ? a.od_index_source_id : null, start, date,
      { count: a.od_review_count, unit: a.od_review_unit, anchor: S.ymd(a.activated_on || a.opened_on) }),
  };
}

/**
 * One day's interest on an account: credit (or negative) interest on the
 * day's balance by the product's basis (not MINIMUM, which prices the
 * period), and overdraft interest on what is overdrawn.
 */
function dayInterest(a, x, d, bal, mv) {
  const dayMin = mv ? Math.min(Number(mv.open_balance), Number(mv.min_balance)) : bal;
  const dayAvg = mv ? Number(mv.sum_after) / Number(mv.movements) : bal;
  const w = weight(core.addDays(d, -1), d, x.conv);
  let pos = 0;
  let neg = 0;
  let od = 0;
  const earning = x.interestOn && !x.lockedOut && !x.dormant && !(x.maturity && d > x.maturity && !a.accrue_interest_after_maturity);
  if (earning && x.basis !== 'MINIMUM') {
    let b = x.basis === 'MINIMUM_DAILY' ? dayMin : x.basis === 'AVERAGE_DAILY' ? dayAvg : bal;
    if (x.basis === 'END_OF_DAY' && x.cap !== null) b = Math.min(b, x.cap);
    if (b > 0 && (x.threshold === null || b >= x.threshold)) {
      const r = DR.creditOn(a, b, d, { index: x.creditIndex(d) });
      const amt = r.amount * w / DR.yearDays(x.conv, d);
      if (amt >= 0) pos += amt; else neg += -amt;
    }
  }
  const odBal = a.od_calc_balance === 'MINIMUM_DAILY' ? dayMin : bal;
  if (odBal < 0 && !x.dormant) {
    const r = DR.overdraftRateOn(a, -odBal, { index: x.odIndex(d) });
    if (r > 0) od += -odBal * r / 100 * weight(core.addDays(d, -1), d, x.odConv) / DR.yearDays(x.odConv, d);
  }
  return { pos, neg, od };
}

/** Book to the ledger what has accrued and is not yet booked, under accrual accounting (../accruals). */
async function bookAccrued(c, a, u, date, narration, createdBy) {
  if (!(core.books(a) && core.accrues(a))) return null;
  const interestOn = Boolean(a.interest_paid_into_account) && !a.is_funding_account;
  const comps = [
    ['INTEREST', 'interest_accrued', 'interest_booked', a.gl_interest_exp, a.gl_interest_payable, interestOn],
    ['NEG_INTEREST', 'neg_interest_accrued', 'neg_interest_booked', a.gl_neg_interest_rec, a.gl_neg_interest_inc, interestOn && a.allow_negative_rate],
    ['OD_INTEREST', 'od_interest_accrued', 'od_interest_booked', a.gl_od_interest_rec, a.gl_od_interest_inc, Boolean(a.gl_od_interest_rec)],
  ];
  const lines = [];
  const sets = [];
  for (const [component, accruedCol, bookedCol, dr, cr, on] of comps) {
    if (!on) continue;
    const delta = round2(round2(u[accruedCol]) - Number(u[bookedCol]));
    if (delta === 0) continue;
    lines.push({ component, debitGl: dr, creditGl: cr, amount: delta });
    sets.push(`${bookedCol} = ${bookedCol} + ${delta}`);
  }
  if (!lines.length) return null;
  const entryId = await accruals.record(c, {
    kind: 'SAVINGS', product: { ...a, id: a.product_id }, accountId: a.id, memberId: a.member_id, branchId: a.branch_id,
    date, lines, narration, createdBy,
  });
  await c.query(`UPDATE savings_accounts SET ${sets.join(', ')} WHERE id = $1`, [a.id]);
  return entryId;
}

async function accrueInterest(c, accountId, { date, createdBy = 'EOD' } = {}) {
  const a = await core.lock(c, accountId);
  if (!core.OPEN.includes(a.status)) return null;
  const opened = S.ymd(a.opened_on);
  const start = a.accrued_through ? S.ymd(a.accrued_through) : core.addDays(opened, -1);
  if (date <= start) return null;
  const periodStart = a.period_started_on ? S.ymd(a.period_started_on) : opened;
  const x = await accrualContext(c, a, start, date);
  const { rows: intraday } = await c.query(
    'SELECT day::text AS d, open_balance, min_balance, sum_after, movements FROM savings_intraday_balances WHERE account_id = $1 AND day > $2::date AND day <= $3::date',
    [a.id, start, date]);
  const moves = new Map(intraday.map((m) => [m.d, m]));

  let pos = 0;
  let neg = 0;
  let od = 0;
  for (let d = core.addDays(start, 1); d <= date; d = core.addDays(d, 1)) {
    await c.query(
      'INSERT INTO savings_daily_balances (account_id, day, balance) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [a.id, d, a.balance]);
    const { rows: [snap] } = await c.query('SELECT balance FROM savings_daily_balances WHERE account_id = $1 AND day = $2', [a.id, d]);
    const day = dayInterest(a, x, d, Number(snap.balance), moves.get(d));
    pos += day.pos; neg += day.neg; od += day.od;
  }
  if (x.interestOn && x.basis === 'MINIMUM' && !x.lockedOut && !x.dormant) {
    const { rows: [m] } = await c.query(
      'SELECT min(balance) AS lo FROM savings_daily_balances WHERE account_id = $1 AND day BETWEEN $2 AND $3', [a.id, periodStart, date]);
    const lo = Number(m.lo);
    let days = 0;
    for (let d = periodStart; d <= date; d = core.addDays(d, 1)) days += weight(core.addDays(d, -1), d, x.conv);
    const r = lo > 0 && (x.threshold === null || lo >= x.threshold) ? DR.creditOn(a, lo, date, { index: x.creditIndex(date) }) : { amount: 0 };
    const target = r.amount * days / DR.yearDays(x.conv, date);
    // The period so far is priced again; what changes is booked (either side).
    pos = Math.max(target, 0) - Number(a.interest_accrued);
    neg = Math.max(-target, 0) - Number(a.neg_interest_accrued);
  }
  const { rows: [u] } = await c.query(
    `UPDATE savings_accounts SET interest_accrued = interest_accrued + $1, neg_interest_accrued = neg_interest_accrued + $2,
       od_interest_accrued = od_interest_accrued + $3, accrued_through = $4::date,
       period_started_on = COALESCE(period_started_on, opened_on)
     WHERE id = $5 RETURNING *`, [pos, neg, od, date, a.id]);
  // Book what has changed to the ledger.
  const entryId = await bookAccrued(c, a, u, date, `Deposit interest accrual ${a.account_no} to ${date}`, createdBy);
  return {
    accountId: a.id, through: date,
    interest: round2(u.interest_accrued), negative: round2(u.neg_interest_accrued), overdraft: round2(u.od_interest_accrued), entryId,
  };
}

/**
 * A backdated movement (or the reversal of one) of `delta` on `day`: the
 * recorded daily balances from that day to the last day accrued move by it,
 * the interest on those days is priced again, and the change is booked.
 * The movement counts from the start of its day. Under the MINIMUM
 * (period) basis the next accrual prices the period again itself.
 */
async function repriceFrom(c, accountId, day, delta, { createdBy } = {}) {
  const a = await core.lock(c, accountId);
  const through = a.accrued_through ? S.ymd(a.accrued_through) : null;
  if (!through || day > through || delta === 0 || day < core.repriceFloor(a)) return null;
  const x = await accrualContext(c, a, core.addDays(day, -1), through);
  const { rows } = await c.query(
    `SELECT d.day::text AS d, d.balance, m.open_balance, m.min_balance, m.sum_after, m.movements
       FROM savings_daily_balances d LEFT JOIN savings_intraday_balances m ON m.account_id = d.account_id AND m.day = d.day
      WHERE d.account_id = $1 AND d.day BETWEEN $2 AND $3 ORDER BY d.day`, [a.id, day, through]);
  let pos = 0;
  let neg = 0;
  let od = 0;
  for (const r of rows) {
    const mv = r.movements ? r : null;
    const was = dayInterest(a, x, r.d, Number(r.balance), mv);
    const moved = mv ? { open_balance: Number(r.open_balance) + delta, min_balance: Number(r.min_balance) + delta,
      sum_after: Number(r.sum_after) + delta * Number(r.movements), movements: r.movements } : null;
    const now = dayInterest(a, x, r.d, Number(r.balance) + delta, moved);
    pos += now.pos - was.pos; neg += now.neg - was.neg; od += now.od - was.od;
  }
  await c.query('UPDATE savings_daily_balances SET balance = balance + $2 WHERE account_id = $1 AND day BETWEEN $3 AND $4', [a.id, delta, day, through]);
  await c.query(`UPDATE savings_intraday_balances SET open_balance = open_balance + $2, min_balance = min_balance + $2, sum_after = sum_after + $2 * movements
                  WHERE account_id = $1 AND day BETWEEN $3 AND $4`, [a.id, delta, day, through]);
  if (x.basis === 'MINIMUM') { pos = 0; neg = 0; }
  const { rows: [u] } = await c.query(
    `UPDATE savings_accounts SET interest_accrued = GREATEST(0, interest_accrued + $2), neg_interest_accrued = GREATEST(0, neg_interest_accrued + $3),
       od_interest_accrued = GREATEST(0, od_interest_accrued + $4) WHERE id = $1 RETURNING *`, [a.id, pos, neg, od]);
  const entryId = await bookAccrued(c, a, u, await orgToday(c), `Interest priced again ${a.account_no} from ${day}`, createdBy || 'SYSTEM');
  return { from: day, through, interest: pos, negative: neg, overdraft: od, entryId };
}

/**
 * Apply what has accrued to the balance: positive interest (less
 * withholding tax), negative interest, overdraft interest. The sub-cent
 * remainder carries into the next period.
 */
async function applyInterest(c, accountId, { date, createdBy = 'EOD' } = {}) {
  let a = await core.lock(c, accountId);
  const out = [];
  const pos = round2(a.interest_accrued);
  const neg = round2(a.neg_interest_accrued);
  const odi = round2(a.od_interest_accrued);
  const recognised = core.books(a) && core.accrues(a);
  const mid = a.member_id;
  const br = a.branch_id;

  if (pos > 0) {
    const booked = recognised ? Number(a.interest_booked) : 0;
    const inn = core.inLegs(a, pos);
    let entryId = null;
    if (core.books(a)) {
      const debits = [];
      if (booked > 0) debits.push({ glCode: a.gl_interest_payable, amount: booked, memberId: mid, branchId: br });
      if (pos - booked > 0) debits.push({ glCode: a.gl_interest_exp, amount: round2(pos - booked), memberId: mid, branchId: br });
      entryId = (await acct.post(c, {
        debits, credits: inn.credits, narration: `Interest applied ${a.account_no}`,
        sourceType: 'SAVINGS_INTEREST_APPLIED', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
      })).entryId;
    }
    await c.query(
      `UPDATE savings_accounts SET balance = balance + $1, interest_accrued = interest_accrued - $1, interest_booked = 0,
         od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3 WHERE id = $4`,
      [pos, inn.allocation.odFees, inn.allocation.odInterest, a.id]);
    out.push(await core.record(c, {
      reference: core.ref('SI'), kind: 'SAVINGS_INTEREST_APPLIED', memberId: mid, savingsAccountId: a.id, amount: pos,
      valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, ...inn.allocation },
    }));
    const whtRate = await funds.withholdingRate(c, a, date);
    const wht = whtRate === null ? 0 : round2(pos * whtRate / 100);
    if (wht > 0) {
      a = await core.lock(c, a.id);
      const legs = core.outLegs(a, wht);
      let taxEntry = null;
      if (core.books(a)) {
        taxEntry = (await acct.post(c, {
          debits: legs.debits, credits: [{ glCode: a.gl_tax_payable, amount: wht, memberId: mid, branchId: br }],
          narration: `Withholding tax ${whtRate}% on interest ${a.account_no}`,
          sourceType: 'SAVINGS_WITHHOLDING_TAX', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
        })).entryId;
      }
      await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [wht, a.id]);
      out.push(await core.record(c, {
        reference: core.ref('WT'), kind: 'SAVINGS_WITHHOLDING_TAX', memberId: mid, savingsAccountId: a.id, amount: wht,
        valueDate: date, branchId: br, entryId: taxEntry, createdBy,
        allocation: { rate: whtRate, on: pos, interestReference: out[out.length - 1].reference, ...legs.allocation },
      }));
    }
  }

  if (neg > 0) {
    a = await core.lock(c, a.id);
    const room = round2(Number(a.balance) + Number(a.overdraft_limit || 0));
    const charge = a.allow_technical_overdraft ? neg : round2(Math.max(0, Math.min(neg, room)));
    if (charge > 0) {
      const booked = recognised ? Math.min(Number(a.neg_interest_booked), charge) : 0;
      const legs = core.outLegs(a, charge);
      let entryId = null;
      if (core.books(a)) {
        const credits = [];
        if (booked > 0) credits.push({ glCode: a.gl_neg_interest_rec, amount: booked, memberId: mid, branchId: br });
        if (charge - booked > 0) credits.push({ glCode: a.gl_neg_interest_inc, amount: round2(charge - booked), memberId: mid, branchId: br });
        entryId = (await acct.post(c, {
          debits: legs.debits, credits, narration: `Negative interest ${a.account_no}`,
          sourceType: 'SAVINGS_NEGATIVE_INTEREST', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
        })).entryId;
      }
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1, neg_interest_accrued = neg_interest_accrued - $2,
           neg_interest_booked = neg_interest_booked - $3 WHERE id = $4`, [charge, neg, booked, a.id]);
      out.push(await core.record(c, {
        reference: core.ref('SN'), kind: 'SAVINGS_NEGATIVE_INTEREST', memberId: mid, savingsAccountId: a.id, amount: charge,
        valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, ...legs.allocation },
      }));
    }
  }

  if (odi > 0) {
    a = await core.lock(c, a.id);
    const booked = recognised ? Number(a.od_interest_booked) : 0;
    const legs = core.outLegs(a, odi);
    // Under cash, the part that overdraws the account is owed, not earned.
    const cashDue = a.accounting_method === 'CASH' ? legs.allocation.odPrincipal : 0;
    const earned = round2(odi - cashDue);
    let entryId = null;
    if (core.books(a) && earned > 0) {
      const debits = a.accounting_method === 'CASH' ? legs.debits.filter((d) => d.glCode === a.gl_liability) : legs.debits;
      const credits = [];
      if (booked > 0) credits.push({ glCode: a.gl_od_interest_rec, amount: booked, memberId: mid, branchId: br });
      if (earned - booked > 0) credits.push({ glCode: a.gl_od_interest_inc, amount: round2(earned - booked), memberId: mid, branchId: br });
      entryId = (await acct.post(c, {
        debits, credits, narration: `Overdraft interest ${a.account_no}`,
        sourceType: 'OVERDRAFT_INTEREST_APPLIED', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
      })).entryId;
    }
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, od_interest_accrued = od_interest_accrued - $1,
         od_interest_booked = 0, od_interest_due = od_interest_due + $2 WHERE id = $3`, [odi, cashDue, a.id]);
    out.push(await core.record(c, {
      reference: core.ref('OI'), kind: 'OVERDRAFT_INTEREST_APPLIED', memberId: mid, savingsAccountId: a.id, amount: odi,
      valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, odInterestDue: cashDue, ...legs.allocation },
    }));
  }

  await c.query(
    `UPDATE savings_accounts SET last_interest_applied_on = $1::date, period_started_on = ($1::date + 1) WHERE id = $2`, [date, a.id]);
  return out;
}

// --------------------------------------------------------------------------
// Term and maturity (fixed deposits and savings plans)
// --------------------------------------------------------------------------

/**
 * Start the maturity period (the reference platform's Activate Maturity): once the opening
 * balance is reached, the term runs from today; its length is the one
 * given, the account's, or the product's default, within the product's
 * range. A fixed deposit takes no more deposits; neither pays out during
 * the term without MAKE_EARLY_WITHDRAWALS.
 */
async function startMaturity(c, accountId, { termLength = null, createdBy } = {}) {
  const a = await core.lock(c, accountId);
  if (!DR.hasTerm(a.product_type)) throw err(`MATURITY_IS_FOR_FIXED_DEPOSITS_AND_SAVINGS_PLANS: ${a.product_type}`, 409);
  if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (a.maturity_started_on) throw err(`MATURITY_ALREADY_STARTED: ${S.ymd(a.maturity_started_on)}`, 409);
  if (a.min_opening_balance !== null && Number(a.balance) < Number(a.min_opening_balance)) {
    throw err(`OPENING_BALANCE_NOT_REACHED: ${a.balance} of ${a.min_opening_balance}`, 409);
  }
  const n = Number(termLength ?? a.term_length ?? a.term_default);
  if (!(Number.isInteger(n) && n > 0)) throw err('TERM_LENGTH_IS_A_WHOLE_NUMBER', 400);
  if (a.term_min !== null && n < Number(a.term_min)) throw err(`TERM_BELOW_THE_PRODUCT_MINIMUM: ${a.term_min} ${a.term_unit}`, 400);
  if (a.term_max !== null && n > Number(a.term_max)) throw err(`TERM_ABOVE_THE_PRODUCT_MAXIMUM: ${a.term_max} ${a.term_unit}`, 400);
  const today = await orgToday(c);
  const due = DR.maturityDate(today, n, a.term_unit);
  const { rows: [r] } = await c.query(
    'UPDATE savings_accounts SET maturity_started_on = $2, maturity_date = $3, term_length = $4 WHERE id = $1 RETURNING *', [a.id, today, due, n]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_MATURITY_STARTED', entity: 'savings_account', entityId: a.id, after: JSON.stringify({ startedOn: today, maturityDate: due, term: `${n} ${a.term_unit}` }) });
  return r;
}

/** Undo the maturity before its date (the reference platform's Undo Maturity). */
async function undoMaturity(c, accountId, { createdBy } = {}) {
  const a = await core.lock(c, accountId);
  if (!a.maturity_started_on) throw err('MATURITY_NOT_STARTED', 409);
  if (a.status === 'MATURED' || S.ymd(a.maturity_date) <= await orgToday(c)) throw err(`ALREADY_MATURED: ${S.ymd(a.maturity_date)}`, 409);
  const { rows: [r] } = await c.query('UPDATE savings_accounts SET maturity_started_on = NULL, maturity_date = NULL WHERE id = $1 RETURNING *', [a.id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_MATURITY_UNDONE', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ startedOn: S.ymd(a.maturity_started_on), maturityDate: S.ymd(a.maturity_date) }) });
  return r;
}

Object.assign(module.exports, {
  weight, isApplicationDate, indexRates, accrualContext, dayInterest, bookAccrued, accrueInterest, repriceFrom, applyInterest, startMaturity, undoMaturity,
});
