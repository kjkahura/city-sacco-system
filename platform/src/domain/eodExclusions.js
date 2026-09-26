'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const types = require('./productTypes');
const workflow = require('./workflow');
const fees = require('./fees');
const penalties = require('./penalties');
const revolving = require('./revolving');
const rates = require('./rates');
const plannedFees = require('./plannedFees');
const FA = require('./feeAmortization');
const loans = require('./loans');
const postdated = require('./postdated');
const settlement = require('./settlement');
const { pageQuery } = require('../lib/page');
const { err } = acct;
const { isoDate, ymd } = S;

/**
 * The loans the end of day has left out (./eodGuard), and bringing one back.
 *
 * A loan is left out when it breaks an end-of-day job. While it is out no
 * interest is accrued on it and no penalty, fee or bill is applied, as in
 * Mambu. Once someone has fixed what was wrong, including it again runs, for
 * that loan alone and in the end of day's order, every loan job it missed up
 * to today: billing, the rate review, interest, postdated payments, planned
 * fees, the settlement transfer, arrears, penalties, fees, fee amortisation
 * and the lending controls. Each of those is idempotent and covers the days
 * since it last ran, so the loan is brought fully up to date. If the loan
 * still fails, the inclusion fails with the error and the loan stays out.
 *
 * This module stands above ./loans, like ./restructure.
 */

async function list(c, { all = false, ...source } = {}) {
  return pageQuery(c,
    `SELECT x.*, l.account_no, l.status AS loan_status, l.product_id, m.member_no, m.first_name, m.last_name
     FROM loan_eod_exclusions x JOIN loan_accounts l ON l.id = x.loan_id JOIN members m ON m.id = l.member_id
     WHERE ($1::boolean OR x.included_at IS NULL)
     ORDER BY x.included_at IS NULL DESC, x.excluded_at DESC`, [all === true || all === 'true'], source);
}

async function forLoan(c, loanId) {
  const l = await ledger.read(c, loanId);
  const { rows } = await c.query('SELECT * FROM loan_eod_exclusions WHERE loan_id = $1 ORDER BY excluded_at DESC', [l.id]);
  return { loanId: l.id, excluded: rows.some((r) => !r.included_at), history: rows };
}

/** Every loan job the end of day runs, for one loan, up to `date`. */
async function catchUp(c, loanId, date, createdBy) {
  const done = {};
  let l = await ledger.lock(c, loanId);
  if (types.forLoan(l) === types.BY_TYPE.REVOLVING) {
    let billed = 0;
    for (let n = 0; n < 60; n += 1) { if (!(await revolving.bill(c, l.id, { date, createdBy }))) break; billed += 1; }
    done.billRevolving = billed;
  }
  done.reviewRates = Boolean(await rates.reviewLoan(c, l.id, { date, createdBy }));
  done.accrueInterest = Number((await loans.accrueInterest(c, l.id, { valueDate: date, createdBy }))?.amount || 0);
  done.applyPostdatedPayments = (await postdated.applyDue(c, { asOf: date, createdBy, loanId: l.id })).applied;
  done.applyPlannedFees = (await plannedFees.applyDue(c, { asOf: date, createdBy, loanId: l.id })).applied;
  done.collectSettlements = (await settlement.run(c, { asOf: date, createdBy, loanId: l.id })).transferred;
  done.markArrears = (await workflow.markArrears(c, { asOf: date, loanId: l.id })).length;
  done.accruePenalties = (await penalties.accrueForLoan(c, l.id, { asOf: date, createdBy })).length;
  l = await ledger.lock(c, l.id);
  if (['ACTIVE', 'IN_ARREARS'].includes(l.status)) {
    done.paymentDueFees = types.forLoan(l).paymentDueFeesByCalendar ? await fees.applyPaymentDueFees(c, l, date) : 0;
    done.lateFees = await fees.applyLateFees(c, l, date);
  }
  done.amortizeFees = (await FA.run(c, { asOf: date, createdBy, loanId: l.id })).periods;
  const ctl = await workflow.enforceControls(c, { asOf: date, loanId: l.id });
  done.enforceControls = { capped: ctl.capped, lockedForArrears: ctl.lockedForArrears, closed: ctl.closed };
  return done;
}

/**
 * Bring a loan back into the end of day, caught up to `asOf` (today by
 * default). Refused while the loan is not on the list.
 */
async function include(c, loanId, { asOf = null, note = null, createdBy } = {}) {
  const l = await ledger.lock(c, loanId);
  const { rows: [x] } = await c.query(
    'SELECT * FROM loan_eod_exclusions WHERE loan_id = $1 AND included_at IS NULL FOR UPDATE', [l.id]);
  if (!x) throw err('LOAN_IS_NOT_EXCLUDED_FROM_THE_END_OF_DAY', 409);
  const date = asOf ? ymd(asOf) : isoDate(new Date());
  // Off the list first, so the jobs run for it.
  await c.query('UPDATE loan_eod_exclusions SET included_at = now(), included_by = $2 WHERE id = $1', [x.id, createdBy || 'SYSTEM']);
  let done;
  try {
    done = await catchUp(c, l.id, date, createdBy || 'EOD');
  } catch (e) {
    // Still broken: the whole inclusion is rolled back and the loan stays out.
    throw err(`LOAN_STILL_FAILS: ${String(e.message).slice(0, 300)}`, 409);
  }
  // A job that failed on it again has put it back on the list: the
  // inclusion fails and the loan stays out, as it was.
  const { rows: [again] } = await c.query(
    'SELECT job, error FROM loan_eod_exclusions WHERE loan_id = $1 AND included_at IS NULL', [l.id]);
  if (again) throw err(`LOAN_STILL_FAILS_IN_${again.job}: ${again.error}`, 409);
  await c.query('UPDATE loan_eod_exclusions SET catch_up = $2 WHERE id = $1', [x.id, JSON.stringify({ asOf: date, ...done })]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'LOAN_INCLUDED_IN_EOD','loan_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', l.id, JSON.stringify({ job: x.job, businessDate: ymd(x.business_date), error: x.error }),
      JSON.stringify({ note, catchUp: done })]);
  return { loanId: l.id, accountNo: l.account_no, excludedSince: ymd(x.business_date), job: x.job, caughtUpTo: date, catchUp: done };
}

module.exports = { list, forLoan, include, catchUp };
