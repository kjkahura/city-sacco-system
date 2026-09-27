'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const savings = require('./savings');
const types = require('./productTypes');
const { reschedule } = require('./installments');
const { accrueInterest } = require('./interest');
const G = require('./eodGuard');
const { err } = acct;
const { ymd, isoDate, addInterval, addDays } = S;

/**
 * Index interest rates and Adjustable Interest Rates, after the reference platform.
 *
 * A loan whose rate can move carries rate periods (loan_rate_periods), each
 * FIXED (a rate) or INDEX (an index source and a spread, within a floor and
 * ceiling, reviewed every N days, weeks or months), valid from a date:
 *
 *   INDEX product        one INDEX period, from disbursement, on the
 *                        product's source with the loan's spread
 *   adjustable rates     the periods the loan was opened with (a fixed rate
 *                        for two years, then the index plus a spread, say)
 *
 * loan_accounts.monthly_rate stays the rate in force, which the rest of the
 * system reads. A review (the end of day runs one for every such loan)
 * works out what the rate should be on the day:
 *
 *   FIXED period   its rate, from the day the period starts
 *   INDEX period   the index value on the latest review date plus the
 *                  spread, clamped to the floor and ceiling (and to zero:
 *                  a negative spread may lower the rate, not make it
 *                  negative), from that review date
 *
 * and when it differs from the rate in force changes it: interest is
 * brought to the change date at the old rate, the rate changes, the change
 * is recorded (loan_rate_changes), and the schedule's future installments
 * are redrawn on the new rate (an equal-installment loan gets a new
 * payment). On a loan that earns interest on the actual balance the change
 * takes effect on its date. On a fixed-term loan, whose schedule is the
 * contract, it takes effect from the next due date, so the installment in
 * progress keeps the amount it was drawn with, as the reference platform does for the
 * upcoming installment.
 */

const addPeriod = (d, count, unit, times) => addInterval(d, { unit, every: count }, times);

/** The index value in force on a date: the latest value dated on or before it. */
async function indexRateOn(c, sourceId, date) {
  const { rows: [r] } = await c.query(
    'SELECT rate, valid_from FROM index_rates WHERE source_id = $1 AND valid_from <= $2::date ORDER BY valid_from DESC LIMIT 1',
    [sourceId, date]);
  return r ? Number(r.rate) : null;
}

/** Index plus spread, within the floor and ceiling, never below zero. */
function clampRate(index, spread, floor, ceiling) {
  let r = Number(index) + Number(spread);
  if (floor !== null && floor !== undefined) r = Math.max(r, Number(floor));
  if (ceiling !== null && ceiling !== undefined) r = Math.min(r, Number(ceiling));
  return Math.round(Math.max(0, r) * 10000) / 10000;
}

async function periodsOf(c, loanId) {
  const { rows } = await c.query('SELECT * FROM loan_rate_periods WHERE loan_id = $1 ORDER BY valid_from', [loanId]);
  return rows;
}

// --------------------------------------------------------------------------
// Opening: the periods a loan is given
// --------------------------------------------------------------------------

/**
 * Record the rate periods for a new application. An INDEX product gets one
 * INDEX period on its source with the loan's rate as the spread; a product
 * with adjustable rates takes the periods given (`ratePeriods`), each
 * checked against what the product allows.
 */
async function planPeriods(c, loan, p, ratePeriods) {
  const given = Array.isArray(ratePeriods) && ratePeriods.length ? ratePeriods : null;
  if (given && !p.adjustable_rates) throw err('PRODUCT_DOES_NOT_TAKE_ADJUSTABLE_RATES', 400);
  if (!given && p.interest_rate_source !== 'INDEX') return [];
  const rows = given ? given.map((x) => ({
    validFrom: x.validFrom, source: x.source || x.interestRateSource || 'FIXED', indexSourceId: x.indexSourceId ?? null,
    rate: x.source === 'INDEX' || x.interestRateSource === 'INDEX' ? (x.spread ?? x.rate) : x.rate,
    floor: x.floor ?? x.rateFloor ?? null, ceiling: x.ceiling ?? x.rateCeiling ?? null,
    reviewCount: x.reviewCount ?? null, reviewUnit: x.reviewUnit ?? null,
  })) : [{
    validFrom: ymd(loan.applied_on || new Date()), source: 'INDEX', indexSourceId: p.index_source_id, rate: Number(loan.monthly_rate),
    floor: null, ceiling: null, reviewCount: null, reviewUnit: null,
  }];

  const allowedIndex = new Set([...(p.allowed_index_sources || []), ...(p.index_source_id ? [p.index_source_id] : [])]);
  let prev = null;
  for (const r of rows) {
    if (!r.validFrom || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.validFrom).slice(0, 10))) throw err('RATE_PERIOD_NEEDS_A_VALID_FROM_DATE', 400);
    r.validFrom = String(r.validFrom).slice(0, 10);
    if (prev && r.validFrom <= prev) throw err('RATE_PERIODS_MUST_BE_IN_DATE_ORDER', 400);
    prev = r.validFrom;
    if (!['FIXED', 'INDEX'].includes(r.source)) throw err(`UNKNOWN_RATE_SOURCE: ${r.source}`, 400);
    if (!(Number.isFinite(Number(r.rate)))) throw err('RATE_PERIOD_NEEDS_A_RATE_OR_SPREAD', 400);
    r.rate = Number(r.rate);
    if (r.source === 'FIXED') {
      if (r.rate < 0) throw err('A_FIXED_RATE_CANNOT_BE_NEGATIVE', 400);
      if (p.rate_min !== null && r.rate < Number(p.rate_min)) throw err(`RATE_BELOW_PRODUCT_MINIMUM: ${p.rate_min}`, 400);
      if (p.rate_max !== null && r.rate > Number(p.rate_max)) throw err(`RATE_ABOVE_PRODUCT_MAXIMUM: ${p.rate_max}`, 400);
    } else {
      if (!r.indexSourceId) r.indexSourceId = p.index_source_id;
      if (!allowedIndex.has(r.indexSourceId)) throw err(`INDEX_SOURCE_NOT_ALLOWED_BY_PRODUCT: ${r.indexSourceId}`, 400);
      if (r.rate < 0 && !p.allow_negative_rate) throw err('NEGATIVE_SPREAD_NOT_ALLOWED_BY_PRODUCT', 400);
      r.floor = r.floor ?? p.rate_floor;
      r.ceiling = r.ceiling ?? p.rate_ceiling;
      r.reviewCount = r.reviewCount ?? p.rate_review_count;
      r.reviewUnit = r.reviewUnit ?? p.rate_review_unit;
      if (!r.reviewCount || !r.reviewUnit) throw err('INDEX_RATE_PERIOD_NEEDS_A_REVIEW_FREQUENCY', 400);
      if (r.floor !== null && r.ceiling !== null && Number(r.floor) > Number(r.ceiling)) throw err('RATE_FLOOR_ABOVE_CEILING', 400);
    }
  }
  const { rows: known } = await c.query('SELECT id FROM index_rate_sources WHERE id = ANY($1)',
    [[...new Set(rows.filter((r) => r.source === 'INDEX').map((r) => r.indexSourceId))]]);
  const missing = rows.filter((r) => r.source === 'INDEX' && !known.some((k) => k.id === r.indexSourceId));
  if (missing.length) throw err(`UNKNOWN_INDEX_RATE_SOURCE: ${missing[0].indexSourceId}`, 400);

  for (const r of rows) {
    await c.query(
      `INSERT INTO loan_rate_periods (loan_id, valid_from, source, index_source_id, rate, floor, ceiling, review_count, review_unit)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9)`,
      [loan.id, r.validFrom, r.source, r.source === 'INDEX' ? r.indexSourceId : null, r.rate,
        r.source === 'INDEX' ? r.floor : null, r.source === 'INDEX' ? r.ceiling : null,
        r.source === 'INDEX' ? r.reviewCount : null, r.source === 'INDEX' ? r.reviewUnit : null]);
  }
  await c.query('UPDATE loan_accounts SET rate_plan = $2 WHERE id = $1', [loan.id, given ? 'ADJUSTABLE' : 'INDEX']);
  // Before disbursement an adjustable loan quotes its first period's fixed
  // rate; an indexed one is priced at disbursement.
  if (given && rows[0].source === 'FIXED') await c.query('UPDATE loan_accounts SET monthly_rate = $2 WHERE id = $1', [loan.id, rows[0].rate]);
  return rows;
}

// --------------------------------------------------------------------------
// What the rate should be
// --------------------------------------------------------------------------

/**
 * The rate the periods give on `date`, with the date it took effect: the
 * start of a FIXED period, or the latest review date of an INDEX period
 * (reviews run every review_count review_units from the later of the
 * period's start and the disbursement).
 */
async function rateOn(c, l, periods, date) {
  if (!periods.length) return null;
  const active = [...periods].reverse().find((p) => ymd(p.valid_from) <= date) || periods[0];
  const start = ymd(active.valid_from);
  if (active.source === 'FIXED') {
    return { rate: Number(active.rate), from: start > date ? date : start, source: 'FIXED', spread: null, index: null, indexSourceId: null };
  }
  const anchor = l.disbursed_on && ymd(l.disbursed_on) > start ? ymd(l.disbursed_on) : start;
  let review = anchor > date ? date : anchor;
  for (let k = 1; k < 2000; k += 1) {
    const next = isoDate(addPeriod(anchor, active.review_count, active.review_unit, k));
    if (next > date) break;
    review = next;
  }
  const index = await indexRateOn(c, active.index_source_id, review);
  if (index === null) throw err(`NO_INDEX_RATE_ON: ${active.index_source_id} has no value on or before ${review}`, 409);
  return {
    rate: clampRate(index, active.rate, active.floor, active.ceiling), from: review, source: 'INDEX',
    spread: Number(active.rate), index, indexSourceId: active.index_source_id,
  };
}

async function recordChange(c, l, { reviewedOn, effectiveFrom, target, reason, createdBy }) {
  await c.query(
    `INSERT INTO loan_rate_changes (loan_id, reviewed_on, effective_from, old_rate, new_rate, source, index_source_id, index_rate, spread, reason, created_by)
     VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [l.id, reviewedOn, effectiveFrom, l.monthly_rate === null ? null : Number(l.monthly_rate), target.rate, target.source,
      target.indexSourceId, target.index, target.spread, reason, createdBy || 'SYSTEM']);
}

// --------------------------------------------------------------------------
// Disbursement and review
// --------------------------------------------------------------------------

/**
 * At the first disbursement: an indexed loan's period starts that day; an
 * adjustable loan's periods move with the disbursement date when asked
 * (`shift`, the reference platform's shiftAdjustableInterestPeriods), stay as opened when
 * told not to, and are refused if the dates differ and nobody said which.
 * The rate in force is set from the periods on the day.
 */
async function start(c, l, { date, shift, createdBy } = {}) {
  const periods = await periodsOf(c, l.id);
  if (!periods.length) return null;
  const first = ymd(periods[0].valid_from);
  if (l.rate_plan === 'INDEX') {
    await c.query('UPDATE loan_rate_periods SET valid_from = $2::date WHERE loan_id = $1', [l.id, date]);
  } else if (first !== date) {
    if (shift === undefined || shift === null) {
      throw err(`ADJUSTABLE_RATE_PERIODS_START_ON_${first}: disburse on that date or pass shiftAdjustableInterestPeriods`, 409);
    }
    if (shift === true || shift === 'true') {
      const days = Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${first}T00:00:00Z`)) / 86400000);
      // Later dates first, so moving forward never collides with the next period's key.
      const order = days > 0 ? 'DESC' : 'ASC';
      const { rows } = await c.query(`SELECT valid_from FROM loan_rate_periods WHERE loan_id = $1 ORDER BY valid_from ${order}`, [l.id]);
      for (const r of rows) {
        await c.query('UPDATE loan_rate_periods SET valid_from = valid_from + $3::int WHERE loan_id = $1 AND valid_from = $2::date',
          [l.id, ymd(r.valid_from), days]);
      }
    }
  }
  const target = await rateOn(c, { ...l, disbursed_on: date }, await periodsOf(c, l.id), date);
  await recordChange(c, l, { reviewedOn: date, effectiveFrom: date, target, reason: 'DISBURSEMENT', createdBy });
  await c.query('UPDATE loan_accounts SET monthly_rate = $2 WHERE id = $1', [l.id, target.rate]);
  return target;
}

/**
 * Review one loan's rate as at `date` and change it if the periods say so.
 * Returns the change made, or null.
 */
async function reviewLoan(c, loanId, { date, createdBy = 'EOD' } = {}) {
  const asOf = date ? ymd(date) : isoDate(new Date());
  let l = await ledger.lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) return null;
  const periods = await periodsOf(c, l.id);
  if (!periods.length) return null;
  const target = await rateOn(c, l, periods, asOf);
  if (Math.abs(target.rate - Number(l.monthly_rate)) < 0.00005) return null;

  const type = types.forLoan(l);
  const accrued = l.accrued_through ? ymd(l.accrued_through) : ymd(l.disbursed_on);
  let effective = target.from < accrued ? accrued : target.from;
  if (type.basis === 'SCHEDULE') {
    // A fixed-term schedule changes at a due date: the next one on or after
    // the review, so the installment in progress keeps its amount.
    const { rows: [n] } = await c.query(
      `SELECT min(nominal_due)::text AS d FROM loan_installments WHERE loan_id = $1 AND nominal_due >= $2::date`, [l.id, effective]);
    if (!n?.d) return null;              // past the last installment: nothing left to reprice
    effective = n.d;
  }
  if (effective > asOf) return null;     // takes effect on a later review

  // Interest to the change date at the old rate, then the new rate from it.
  await accrueInterest(c, l.id, { valueDate: effective, createdBy });
  l = await ledger.lock(c, l.id);
  const oldRate = Number(l.monthly_rate);
  await recordChange(c, l, { reviewedOn: asOf, effectiveFrom: effective, target, reason: target.source === 'INDEX' ? 'INDEX_REVIEW' : 'RATE_PERIOD', createdBy });
  await c.query('UPDATE loan_accounts SET monthly_rate = $2, updated_at = now() WHERE id = $1', [l.id, target.rate]);
  l = await ledger.lock(c, l.id);
  const redrawn = await reschedule(c, l, effective, { rateChange: true });
  return {
    loanId: l.id, accountNo: l.account_no, oldRate, newRate: target.rate, effectiveFrom: effective,
    source: target.source, index: target.index, spread: target.spread, redrawn: Boolean(redrawn),
  };
}

/** Review every loan with rate periods; the end of day runs this before accrual. */
async function reviewAll(c, { date, createdBy = 'EOD' } = {}) {
  const { rows } = await c.query(
    `SELECT DISTINCT l.id FROM loan_accounts l JOIN loan_rate_periods p ON p.loan_id = l.id
     WHERE l.status IN ('ACTIVE', 'IN_ARREARS') AND ${G.EXCLUDED_SQL('l')}`);
  const changed = [];
  const run = await G.eachLoan(c, { job: 'reviewRates', date: date ? ymd(date) : isoDate(new Date()) }, rows, async (id) => {
    const out = await reviewLoan(c, id, { date, createdBy });
    if (out) changed.push(out);
  });
  return { loans: rows.length, changed: changed.length, changes: changed, ...G.summary(run) };
}

// --------------------------------------------------------------------------
// Changing a running loan's rate by hand
// --------------------------------------------------------------------------

/**
 * Change a running loan's interest rate (the reference platform's Edit Interest Rate), or
 * the spread of an indexed rate (Edit Interest Spread), from a date: today,
 * a date to come, or a back date. The change is a new rate period
 * (loan_rate_periods) from that date; a loan that had none gets one for the
 * rate it was opened on first, so its history reads from disbursement. The
 * rate review applies it: at once for a date that has come, at the end of
 * the day it arrives for a later one. As with any review, a fixed-term loan
 * takes a new rate at its next due date and its schedule is redrawn from
 * there. Several changes may be made; the latest period in force wins.
 *
 * A change cannot be dated before a repayment on the loan (the reference platform), nor
 * before the day interest has been accrued to: interest already accrued
 * here stands for the reference platform's Interest Applied, which a change may not precede
 * either. Every change is a LOAN_RATE_CHANGED transaction, non-financial,
 * as the reference platform lists it with the loan's transactions.
 */
async function changeRate(c, loanId, { rate = null, spread = null, effectiveFrom = null, note = null, createdBy } = {}) {
  const l = await ledger.lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`RATE_NOT_CHANGEABLE_IN_STATE_${l.status}`, 409);
  if (l.product_type === 'INTEREST_FREE') throw err('AN_INTEREST_FREE_LOAN_HAS_NO_RATE', 409);
  const today = isoDate(new Date());
  const date = effectiveFrom ? ymd(effectiveFrom) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('INVALID_EFFECTIVE_DATE', 400);
  if (l.disbursed_on && date < ymd(l.disbursed_on)) throw err(`RATE_CHANGE_BEFORE_DISBURSEMENT: ${ymd(l.disbursed_on)}`, 400);
  const { rows: [paid] } = await c.query(
    `SELECT max(value_date)::text AS d FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT' AND reversed_by IS NULL`, [l.id]);
  if (paid?.d && date < paid.d) throw err(`RATE_CHANGE_BEFORE_A_REPAYMENT: the last is dated ${paid.d}`, 409);
  const accrued = l.accrued_through ? ymd(l.accrued_through) : null;
  if (accrued && date < accrued) throw err(`RATE_CHANGE_BEFORE_INTEREST_ALREADY_ACCRUED: interest is accrued through ${accrued}`, 409);

  let periods = await periodsOf(c, l.id);
  if (!periods.length) {
    await c.query(`INSERT INTO loan_rate_periods (loan_id, valid_from, source, rate) VALUES ($1,$2::date,'FIXED',$3)`,
      [l.id, ymd(l.disbursed_on), Number(l.monthly_rate)]);
    await c.query("UPDATE loan_accounts SET rate_plan = 'ADJUSTABLE' WHERE id = $1 AND rate_plan IS NULL", [l.id]);
    periods = await periodsOf(c, l.id);
  }
  const active = [...periods].reverse().find((p) => ymd(p.valid_from) <= date) || periods[0];
  const { rows: [prod] } = await c.query('SELECT rate_min, rate_max, allow_negative_rate FROM loan_products WHERE id = $1', [l.product_id]);
  let value;
  if (active.source === 'INDEX') {
    if (spread === null || spread === undefined || spread === '') throw err('AN_INDEXED_RATE_CHANGES_BY_ITS_SPREAD: give spread', 400);
    value = Number(spread);
    if (!Number.isFinite(value)) throw err('INVALID_SPREAD', 400);
    if (value < 0 && !prod.allow_negative_rate) throw err('NEGATIVE_SPREAD_NOT_ALLOWED_BY_PRODUCT', 400);
  } else {
    if (rate === null || rate === undefined || rate === '') throw err('GIVE_THE_NEW_RATE', 400);
    value = Number(rate);
    if (!(Number.isFinite(value) && value >= 0)) throw err('INVALID_RATE', 400);
    if (prod.rate_min !== null && value < Number(prod.rate_min)) throw err(`RATE_BELOW_PRODUCT_MINIMUM: ${prod.rate_min}`, 400);
    if (prod.rate_max !== null && value > Number(prod.rate_max)) throw err(`RATE_ABOVE_PRODUCT_MAXIMUM: ${prod.rate_max}`, 400);
  }
  const before = Number(active.rate);
  await c.query(
    `INSERT INTO loan_rate_periods (loan_id, valid_from, source, index_source_id, rate, floor, ceiling, review_count, review_unit)
     VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (loan_id, valid_from) DO UPDATE SET rate = EXCLUDED.rate`,
    [l.id, date, active.source, active.index_source_id, value, active.floor, active.ceiling, active.review_count, active.review_unit]);
  const applied = date <= today ? await reviewLoan(c, l.id, { date: today, createdBy }) : null;
  const tx = await savings.record(c, {
    reference: savings.ref('LRC'), kind: 'LOAN_RATE_CHANGED', memberId: l.member_id, loanAccountId: l.id, amount: 0, valueDate: date,
    allocation: { source: active.source, [active.source === 'INDEX' ? 'spread' : 'rate']: { from: before, to: value }, effectiveFrom: date,
      appliedNow: Boolean(applied), ...(applied ? { rateInForce: applied.newRate, takesEffect: applied.effectiveFrom } : {}) },
    narration: note, createdBy,
  });
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'LOAN_RATE_CHANGED','loan_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', l.id, JSON.stringify({ source: active.source, value: before }), JSON.stringify({ value, effectiveFrom: date, note })]);
  return { loanId: l.id, source: active.source, from: before, to: value, effectiveFrom: date, applied, transaction: tx };
}

async function historyOf(c, loanId) {
  const l = await ledger.read(c, loanId);
  const { rows: changes } = await c.query('SELECT * FROM loan_rate_changes WHERE loan_id = $1 ORDER BY effective_from, id', [l.id]);
  return { plan: l.rate_plan, rate: Number(l.monthly_rate), periods: await periodsOf(c, l.id), changes };
}

// --------------------------------------------------------------------------
// Index rate sources (Administration)
// --------------------------------------------------------------------------

const SOURCE_KINDS = ['INTEREST', 'VAT', 'WITHHOLDING'];

/**
 * A rate source (the reference platform's Rate Source): an index interest rate, a
 * value-added tax rate for loan products, or a withholding tax rate for
 * deposit products.
 */
async function addSource(c, { id, name, notes = null, kind = 'INTEREST', createdBy }) {
  if (!id || !name) throw err('AN_INDEX_SOURCE_NEEDS_AN_ID_AND_A_NAME', 400);
  const k = String(kind || 'INTEREST').toUpperCase();
  if (!SOURCE_KINDS.includes(k)) throw err(`RATE_SOURCE_KIND_IS_ONE_OF: ${SOURCE_KINDS.join(', ')}`, 400);
  const { rows: [r] } = await c.query(
    'INSERT INTO index_rate_sources (id, name, notes, kind, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING *',
    [String(id).toUpperCase(), name, notes, k, createdBy || 'SYSTEM']);
  if (!r) throw err(`INDEX_SOURCE_EXISTS: ${id}`, 409);
  return r;
}

async function findSource(c, id) {
  const { rows: [s] } = await c.query('SELECT * FROM index_rate_sources WHERE id = $1', [String(id).toUpperCase()]);
  if (!s) throw err(`UNKNOWN_INDEX_RATE_SOURCE: ${id}`, 404);
  return s;
}

/** Where a source is used: products and running loans. */
async function sourceUse(c, id) {
  const { rows: [u] } = await c.query(
    `SELECT (SELECT count(*) FROM loan_products WHERE index_source_id = $1 OR tax_source_id = $1 OR $1 = ANY(COALESCE(allowed_index_sources, '{}')))
          + (SELECT count(*) FROM savings_products WHERE withholding_source_id = $1)
          + (SELECT count(*) FROM loan_rate_periods p JOIN loan_accounts l ON l.id = p.loan_id
              WHERE p.index_source_id = $1 AND l.status IN ('APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED')) AS n`, [id]);
  return Number(u.n);
}

async function updateSource(c, id, { name, notes } = {}, { createdBy } = {}) {
  const s = await findSource(c, id);
  const { rows: [after] } = await c.query('UPDATE index_rate_sources SET name = COALESCE($2, name), notes = COALESCE($3, notes) WHERE id = $1 RETURNING *',
    [s.id, name || null, notes ?? null]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'INDEX_SOURCE_CHANGED','index_rate',$2,$3,$4)`,
    [createdBy || 'SYSTEM', s.id, JSON.stringify(s), JSON.stringify(after)]);
  return after;
}

/** A source and all its values, if nothing uses it (the reference platform warns; here it is refused). */
async function deleteSource(c, id, { createdBy } = {}) {
  const s = await findSource(c, id);
  const n = await sourceUse(c, s.id);
  if (n > 0) throw err(`RATE_SOURCE_IN_USE: ${s.id} is used by ${n} product(s) or running loan(s)`, 409);
  await c.query('DELETE FROM index_rate_sources WHERE id = $1', [s.id]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'INDEX_SOURCE_DELETED','index_rate',$2,$3)`,
    [createdBy || 'SYSTEM', s.id, JSON.stringify(s)]);
  return { deleted: s.id };
}

/** A value already in force that something uses is history: it cannot be edited or deleted. */
async function assertValueChangeable(c, s, validFrom) {
  if (ymd(validFrom) < isoDate(new Date()) && await sourceUse(c, s.id) > 0) {
    throw err(`RATE_VALUE_IN_USE: ${s.id} from ${ymd(validFrom)} is in force for accounts using it`, 409);
  }
}

async function editIndexRate(c, sourceId, validFrom, { rate, notes } = {}, { createdBy } = {}) {
  const s = await findSource(c, sourceId);
  const { rows: [before] } = await c.query('SELECT * FROM index_rates WHERE source_id = $1 AND valid_from = $2::date', [s.id, ymd(validFrom)]);
  if (!before) throw err(`NO_VALUE_FROM: ${ymd(validFrom)}`, 404);
  await assertValueChangeable(c, s, before.valid_from);
  if (rate !== undefined && !Number.isFinite(Number(rate))) throw err('RATE_MUST_BE_A_NUMBER', 400);
  const { rows: [after] } = await c.query(
    'UPDATE index_rates SET rate = COALESCE($3, rate), notes = COALESCE($4, notes) WHERE source_id = $1 AND valid_from = $2::date RETURNING *',
    [s.id, ymd(validFrom), rate === undefined ? null : Number(rate), notes ?? null]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'INDEX_RATE_CHANGED','index_rate',$2,$3,$4)`,
    [createdBy || 'SYSTEM', s.id, JSON.stringify(before), JSON.stringify(after)]);
  if (s.kind !== 'INTEREST') await updateTaxRates(c, { date: isoDate(new Date()) });
  return after;
}

async function deleteIndexRate(c, sourceId, validFrom, { createdBy } = {}) {
  const s = await findSource(c, sourceId);
  const { rows: [before] } = await c.query('SELECT * FROM index_rates WHERE source_id = $1 AND valid_from = $2::date', [s.id, ymd(validFrom)]);
  if (!before) throw err(`NO_VALUE_FROM: ${ymd(validFrom)}`, 404);
  await assertValueChangeable(c, s, before.valid_from);
  await c.query('DELETE FROM index_rates WHERE source_id = $1 AND valid_from = $2::date', [s.id, ymd(validFrom)]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'INDEX_RATE_DELETED','index_rate',$2,$3)`,
    [createdBy || 'SYSTEM', s.id, JSON.stringify(before)]);
  if (s.kind !== 'INTEREST') await updateTaxRates(c, { date: isoDate(new Date()) });
  return { deleted: { sourceId: s.id, validFrom: ymd(validFrom) } };
}

/**
 * The reference platform's TAX_RATE_UPDATE: each loan product with a VAT source and each
 * deposit product with a withholding tax source takes the source's value in
 * force on `date`. Products without a source keep their own percentage.
 */
async function updateTaxRates(c, { date = isoDate(new Date()) } = {}) {
  const { rows: loans } = await c.query(
    `UPDATE loan_products p SET tax_rate_percent = r.rate, updated_at = now()
     FROM (SELECT DISTINCT ON (source_id) source_id, rate FROM index_rates WHERE valid_from <= $1::date ORDER BY source_id, valid_from DESC) r
     WHERE p.tax_source_id = r.source_id AND p.tax_rate_percent IS DISTINCT FROM r.rate RETURNING p.id, p.tax_rate_percent`, [date]);
  const { rows: deposits } = await c.query(
    `UPDATE savings_products p SET withholding_tax_percent = r.rate
     FROM (SELECT DISTINCT ON (source_id) source_id, rate FROM index_rates WHERE valid_from <= $1::date ORDER BY source_id, valid_from DESC) r
     WHERE p.withholding_source_id = r.source_id AND p.withholding_tax_percent IS DISTINCT FROM r.rate RETURNING p.id, p.withholding_tax_percent`, [date]);
  return { date, loanProducts: loans, depositProducts: deposits };
}

/** A new value of an index from a date. Values already in force are history and are not changed. */
async function setIndexRate(c, sourceId, { validFrom, rate, notes = null, createdBy }) {
  if (!validFrom || !Number.isFinite(Number(rate))) throw err('AN_INDEX_RATE_NEEDS_A_DATE_AND_A_RATE', 400);
  const { rows: [existing] } = await c.query('SELECT * FROM index_rates WHERE source_id = $1 AND valid_from = $2::date', [sourceId, validFrom]);
  const { rowCount } = await c.query('SELECT 1 FROM index_rate_sources WHERE id = $1', [sourceId]);
  if (!rowCount) throw err(`UNKNOWN_INDEX_RATE_SOURCE: ${sourceId}`, 404);
  if (existing) await assertValueChangeable(c, { id: sourceId }, existing.valid_from);
  const { rows: [r] } = await c.query(
    `INSERT INTO index_rates (source_id, valid_from, rate, notes, created_by) VALUES ($1,$2::date,$3,$4,$5)
     ON CONFLICT (source_id, valid_from) DO UPDATE SET rate = EXCLUDED.rate, notes = EXCLUDED.notes, created_by = EXCLUDED.created_by
     RETURNING *`, [sourceId, validFrom, Number(rate), notes, createdBy || 'SYSTEM']);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'INDEX_RATE_SET','index_rate',$2,$3)`,
    [createdBy || 'SYSTEM', sourceId, JSON.stringify(r)]);
  // A tax rate already in force reaches its products at once.
  const { rows: [src] } = await c.query('SELECT kind FROM index_rate_sources WHERE id = $1', [sourceId]);
  if (src.kind !== 'INTEREST' && ymd(r.valid_from) <= isoDate(new Date())) await updateTaxRates(c, { date: isoDate(new Date()) });
  return r;
}

async function sources(c) {
  const { rows } = await c.query(
    `SELECT s.*, (SELECT rate FROM index_rates r WHERE r.source_id = s.id AND r.valid_from <= current_date ORDER BY valid_from DESC LIMIT 1) AS current_rate
     FROM index_rate_sources s ORDER BY s.id`);
  return rows;
}

async function ratesOf(c, sourceId) {
  const { rows } = await c.query('SELECT * FROM index_rates WHERE source_id = $1 ORDER BY valid_from DESC', [sourceId]);
  return rows;
}

module.exports = {
  planPeriods, start, reviewLoan, reviewAll, historyOf, rateOn, clampRate, indexRateOn, changeRate,
  addSource, setIndexRate, sources, ratesOf, updateSource, deleteSource, editIndexRate, deleteIndexRate, updateTaxRates, sourceUse, SOURCE_KINDS,
};
