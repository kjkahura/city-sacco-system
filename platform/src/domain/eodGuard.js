'use strict';

const acct = require('./accounting');
const { err } = acct;

/**
 * One broken loan must not stop the end of day for every other loan, after
 * Mambu's "Automated EOD Account Exclusion Processing".
 *
 * The loan jobs (interest, billing, rate reviews, arrears, penalties, fees,
 * planned fees, fee amortisation, the lending controls) work loan by loan
 * through eachLoan: every loan in its own savepoint. When one throws, what
 * it did is rolled back, the loan goes on the exclusion list with the job,
 * the business date and the error, and the job carries on with the rest.
 * The job's result lists the loans it left out.
 *
 * From then on the end of day skips the loan (EXCLUDED_SQL in the jobs'
 * queries, and the check here), as Mambu does: nothing is accrued, charged
 * or billed on it while it is out. Postdated payments and settlement
 * transfers wait for it. Someone fixes the loan and includes it again
 * (./eodExclusions), which catches up everything the end of day missed.
 *
 * Two kinds of failure are not the loan's fault and are never a reason to
 * leave a loan out: errors from the database or the connection (lost
 * connection, out of resources, a serialization failure, a lock timeout),
 * which fail the job as before; and a failure that is everywhere. When more
 * than a tenth of the loans a job looks at fail (and at least three), the
 * job stops and fails with the first error, and nothing is left out: that is
 * a fault in the system, not in the loans, and leaving them all out would
 * hide it.
 *
 * Depends on accounting only, so any loan module may use it.
 */

/** SQL: the loan `alias` is not on the exclusion list. */
const EXCLUDED_SQL = (alias = 'l') =>
  `NOT EXISTS (SELECT 1 FROM loan_eod_exclusions x WHERE x.loan_id = ${alias}.id AND x.included_at IS NULL)`;
/** The same, for a query that has only the loan id in column `col`. */
const EXCLUDED_ID_SQL = (col) =>
  `NOT EXISTS (SELECT 1 FROM loan_eod_exclusions x WHERE x.loan_id = ${col} AND x.included_at IS NULL)`;

// SQLSTATE classes that are the database's, not the loan's: connection
// (08), insufficient resources (53), operator intervention (57), system
// (58), internal (XX), transaction rollback (40), object in use (55).
const SYSTEMIC = /^(08|53|57|58|XX|40|55)/;
const systemic = (e) => typeof e?.code === 'string' && SYSTEMIC.test(e.code);

/** The loans on the list now. */
async function excludedSet(c) {
  const { rows } = await c.query('SELECT loan_id FROM loan_eod_exclusions WHERE included_at IS NULL');
  return new Set(rows.map((r) => r.loan_id));
}

async function exclude(c, loanId, { job, date, error }) {
  const message = String(error?.message || error).slice(0, 1000);
  const code = error?.code ? String(error.code) : (message.match(/^[A-Z][A-Z0-9_]+/) || [null])[0];
  const { rows: [x] } = await c.query(
    `INSERT INTO loan_eod_exclusions (loan_id, job, business_date, error, error_code)
     VALUES ($1,$2,$3::date,$4,$5)
     ON CONFLICT (loan_id) WHERE included_at IS NULL DO NOTHING RETURNING *`,
    [loanId, job, date, message, code]);
  if (x) {
    await c.query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ('EOD','LOAN_EXCLUDED_FROM_EOD','loan_account',$1,$2)`,
      [loanId, JSON.stringify({ job, businessDate: date, error: message })]);
  }
  return x || null;
}

/**
 * Run `fn(loanId)` for each loan, each in its own savepoint, skipping loans
 * on the exclusion list and putting on it any loan that fails. Returns the
 * results of the loans that ran, how many were skipped, and the loans left
 * out this time.
 */
async function eachLoan(c, { job, date }, ids, fn) {
  const list = [...new Set(ids.map((x) => (typeof x === 'object' ? x.id : x)))];
  const out = { considered: list.length, results: [], skipped: 0, excluded: [] };
  if (!list.length) return out;
  const excluded = await excludedSet(c);
  const limit = Math.max(3, Math.ceil(list.length / 10));
  for (const id of list) {
    if (excluded.has(id)) { out.skipped += 1; continue; }
    await c.query('SAVEPOINT eod_loan');
    try {
      const r = await fn(id);
      await c.query('RELEASE SAVEPOINT eod_loan');
      out.results.push(r);
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT eod_loan');
      if (systemic(e)) throw e;
      if (out.excluded.length + 1 > limit) {
        throw err(`EOD_TOO_MANY_LOAN_FAILURES: ${out.excluded.length + 1} of ${list.length} loans failed in ${job}; `
          + `nothing was left out. First error: ${out.excluded[0]?.error || e.message}`, 500);
      }
      await exclude(c, id, { job, date, error: e });
      excluded.add(id);
      const { rows: [l] } = await c.query('SELECT account_no FROM loan_accounts WHERE id = $1', [id]);
      out.excluded.push({ loanId: id, accountNo: l?.account_no || null, error: String(e.message).slice(0, 300) });
    }
  }
  return out;
}

/** What a job reports about the loans it skipped or left out. */
const summary = (run) => ({
  ...(run.skipped ? { skippedExcluded: run.skipped } : {}),
  ...(run.excluded.length ? { excluded: run.excluded } : {}),
});

module.exports = { EXCLUDED_SQL, EXCLUDED_ID_SQL, eachLoan, excludedSet, exclude, systemic, summary };
