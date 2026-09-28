'use strict';

const { pool } = require('../db/pool');
const { withTenant } = require('../db/tenantContext');
const L = require('../domain/loans');
const P = require('../domain/penalties');
const F = require('../domain/fees');
const W = require('../domain/workflow');
const RATES = require('../domain/rates');
const PDP = require('../domain/postdated');
const PF = require('../domain/plannedFees');
const SETTLE = require('../domain/settlement');
const FA = require('../domain/feeAmortization');
const P2 = require('../domain/provisioning');
const CL = require('../domain/close');
const G = require('../domain/eodGuard');
const CAL = require('../domain/calendar');
const ORG = require('../domain/organization');
const EX = require('../domain/eodExclusions');
const PORTFOLIO = require('../domain/portfolio');
const AREP = require('../domain/accountingReports');

/**
 * End-of-day processing.
 *
 * Idempotent by construction: platform.job_runs has a unique index on
 * (schema_name, job, business_date) for any non-failed row, so a second run
 * for the same business date is rejected by the database rather than by a
 * flag someone might forget to check. Interest cannot be accrued twice
 * because the ledger says it already happened.
 */

async function claim(tenant, job, businessDate) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO platform.job_runs (tenant_id, schema_name, job, business_date, status)
       VALUES ($1,$2,$3,$4,'RUNNING') RETURNING *`,
      [tenant.id, tenant.schema_name, job, businessDate]
    );
    return rows[0];
  } catch (e) {
    if (e.code === '23505') {
      return null;  // already run, or running, for this date
    }
    throw e;
  }
}

async function finish(runId, status, detail = {}, error = null) {
  await pool.query(
    `UPDATE platform.job_runs SET status=$1, detail=$2, error=$3, finished_at=now() WHERE id=$4`,
    [status, JSON.stringify(detail), error, runId]
  );
}

const JOBS = {
  /**
   * Re-date open loans after a holiday or non-working day change, before
   * anything reads their due dates (./calendar sync).
   */
  async syncCalendar(tenant) {
    return withTenant(tenant.schema_name, (c) => CAL.sync(c, { createdBy: 'EOD' }));
  },

  /** The reference platform's TAX_RATE_UPDATE: products with a tax rate source take its value for the day. */
  async updateTaxRates(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => RATES.updateTaxRates(c, { date: businessDate }));
  },

  /**
   * Review indexed and adjustable loan rates before the night's interest,
   * so interest from a change date is at the new rate.
   */
  async reviewRates(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => RATES.reviewAll(c, { date: businessDate, createdBy: 'EOD' }));
  },

  /**
   * Accrue a period's interest on every active loan. Each loan in its own
   * savepoint: one that fails is left out of the end of day (./eodGuard)
   * and the rest are accrued.
   */
  async accrueInterest(tenant, businessDate) {
    return withTenant(tenant.schema_name, async (c) => {
      const { rows } = await c.query(
        `SELECT l.id FROM loan_accounts l WHERE (l.status IN ('ACTIVE','IN_ARREARS') OR (l.status = 'LOCKED' AND NOT l.lock_interest)) AND ${G.EXCLUDED_SQL('l')}`);
      let accrued = 0;
      let total = 0;
      const run = await G.eachLoan(c, { job: 'accrueInterest', date: businessDate }, rows, async (id) => {
        const tx = await L.accrueInterest(c, id, { valueDate: businessDate, createdBy: 'EOD' });
        if (tx) { accrued += 1; total += Number(tx.amount); }
      });
      return { loans: rows.length, accrued, total: Math.round(total * 100) / 100, ...G.summary(run) };
    });
  },

  /**
   * Apply the postdated payments whose value date has come, as repayments
   * on that date. After accrueInterest, so an installment falling due today
   * has all its interest earned when its payment arrives, and before
   * markArrears, so a loan paid by one is not marked late.
   */
  async applyPostdatedPayments(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => PDP.applyDue(c, { asOf: businessDate, createdBy: 'EOD' }));
  },

  /**
   * Charge late payment penalties. Runs after markArrears so the arrears
   * state is current, and is safe to rerun: the unique index on
   * (installment_id, charged_on) refuses a second charge for the same day.
   */
  async accruePenalties(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => P.accrueAll(c, { asOf: businessDate }));
  },

  /**
   * Fees that fall due by the calendar: a dynamic loan's payment-due fees
   * on their installment dates, and late repayment fees on installments
   * that have gone overdue (so after markArrears). Both are once-only per
   * installment by construction.
   */
  async applyFees(tenant, businessDate) {
    return withTenant(tenant.schema_name, async (c) => {
      const { rows } = await c.query(
        `SELECT l.id FROM loan_accounts l WHERE (l.status IN ('ACTIVE','IN_ARREARS') OR (l.status = 'LOCKED' AND NOT l.lock_fees)) AND ${G.EXCLUDED_SQL('l')}`);
      let due = 0; let late = 0;
      const run = await G.eachLoan(c, { job: 'applyFees', date: businessDate }, rows, async (id) => {
        const l = await L.lock(c, id);
        if (L.productType(l).paymentDueFeesByCalendar) due += await F.applyPaymentDueFees(c, l, businessDate);
        late += await F.applyLateFees(c, l, businessDate);
      });
      return { loans: rows.length, paymentDueApplied: due, lateFeesApplied: late, ...G.summary(run) };
    });
  },

  /**
   * Take what linked loans owe from their settlement deposit accounts.
   * After the night's interest and postdated payments, before arrears, so
   * a loan paid this way on its due date is never marked late.
   */
  async collectSettlements(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => SETTLE.run(c, { asOf: businessDate, createdBy: 'EOD' }));
  },

  /**
   * Planned fees whose date has come: on their installment's due date, or
   * the date they were set to apply on. Before markArrears, so a planned
   * fee falls due with its installment.
   */
  async applyPlannedFees(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => PF.applyDue(c, { asOf: businessDate, createdBy: 'EOD' }));
  },

  /** Recognise the fee income each amortisation period has earned. */
  async amortizeFees(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => FA.run(c, { asOf: businessDate, createdBy: 'EOD' }));
  },

  /**
   * The lending controls: lock loans that have hit their product's charge
   * cap or sat in arrears past its limit. After penalties and fees, so the
   * night's charges count.
   */
  async enforceControls(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => W.enforceControls(c, { asOf: businessDate }));
  },

  /**
   * Deposits: interest accrued through the business date on every open
   * account (positive, negative and overdraft), applied on the product's
   * application dates with withholding tax, and monthly fees on the last
   * day of the month.
   */
  async accrueSavings(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => require('../domain/savings').endOfDay(c, { date: businessDate }));
  },

  /**
   * Post the accruals waiting for the end of the day (aggregated products)
   * or the month (monthly GL accrual). Last of the posting jobs, so it
   * carries everything the night accrued.
   */
  async postAccruals(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => require('../domain/accruals').flush(c, { date: businessDate }));
  },

  /** Close the books automatically every N days, when the tenant has asked for it. */
  async autoClosure(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => require('../domain/branches').autoClose(c, { date: businessDate }));
  },

  /**
   * The day's loan positions, for reports on past dates (../domain/portfolio).
   * Last, so the positions show the day after its arrears, penalties and
   * closures. A rerun for a date before yesterday stores nothing: the loan
   * tables hold the present, not that day.
   */
  async snapshotPortfolio(tenant, businessDate) {
    return withTenant(tenant.schema_name, async (c) => {
      try {
        return await PORTFOLIO.snapshot(c, { date: businessDate, takenBy: 'EOD' });
      } catch (e) {
        if (/SNAPSHOT_DATE_MUST_BE_TODAY_OR_YESTERDAY/.test(e.message)) return { skipped: 'PAST_BUSINESS_DATE' };
        throw e;
      }
    });
  },

  /** Remove accounting reports past their 24 hours, and audit trail events past the tenant's retention. */
  async pruneReports(tenant) {
    const days = (await require('../lib/accessPreferences').of(tenant.id)).auditRetentionDays;
    return withTenant(tenant.schema_name, async (c) => ({
      accountingReports: await AREP.prune(c), auditEvents: (await require('./auditTrail').prune(c, days)).pruned,
    }));
  },

  /**
   * Revolving loans: generate the installment for every billing date that
   * has come, interest brought up to the date first.
   */
  async billRevolving(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => require('../domain/revolving').billAll(c, { asOf: businessDate }));
  },

  /** Flag overdue installments and move loans into arrears. */
  async markArrears(tenant, businessDate) {
    return withTenant(tenant.schema_name, async (c) => {
      const flagged = await L.markArrears(c, { asOf: businessDate });
      return { flagged: flagged.length, loans: flagged.map((r) => r.account_no), ...(flagged.guard ? G.summary(flagged.guard) : {}) };
    });
  },

  /**
   * Make sure the financial year covering the business date exists.
   *
   * First in the daily sequence, so on 1 January the new calendar year is
   * open before anything posts into it, and nobody has to remember. It also
   * covers a tenant that has never opened a year at all. Idempotent: a year
   * that already exists is left alone, and the database refuses an overlap
   * if someone has opened an unusual year by hand.
   */
  async ensureFinancialYear(tenant, businessDate) {
    return withTenant(tenant.schema_name, (c) => CL.ensureYearFor(c, businessDate, { createdBy: 'EOD' }));
  },

  /**
   * Loan loss provisioning, daily.
   *
   * Running it every night keeps the allowance tracking the portfolio rather
   * than jumping once a month, and each run posts only the movement since
   * the last one, so the entries are small. Until someone has entered the
   * rates the job records a skip, not a failure: a nightly FAILED row for a
   * tenant that has simply not configured provisioning yet would bury the
   * failures that matter.
   */
  async provision(tenant, businessDate) {
    return withTenant(tenant.schema_name, async (c) => {
      try {
        return await P2.run(c, { asAt: businessDate, createdBy: 'EOD' });
      } catch (e) {
        if (/PROVISION_RATES_NOT_CONFIGURED|PROVISION_BANDS_NOT_DEFINED/.test(e.message)) {
          return { skipped: 'RATES_NOT_CONFIGURED', detail: e.message };
        }
        throw e;
      }
    });
  },

  /** Dormancy: no activity in the configured window. */
  async markDormant(tenant, businessDate, { months = 12 } = {}) {
    return withTenant(tenant.schema_name, async (c) => {
      const { rows } = await c.query(
        `UPDATE savings_accounts a SET status = 'DORMANT'
         WHERE a.status = 'ACTIVE'
           AND NOT EXISTS (
             SELECT 1 FROM transactions t
             WHERE t.savings_account_id = a.id
               AND t.value_date > $1::date - ($2 || ' months')::interval
           )
           AND a.opened_on < $1::date - ($2 || ' months')::interval
         RETURNING a.account_no`,
        [businessDate, months]
      );
      return { dormant: rows.length };
    });
  },
};

/** Run one job for one tenant, once per business date. */
async function runJob(tenant, job, { businessDate = null, force = false } = {}) {
  const date = businessDate || ORG.localClock(tenant.timezone || 'Africa/Nairobi').date;
  const fn = JOBS[job];
  if (!fn) throw new Error(`UNKNOWN_JOB: ${job}`);

  if (force) {
    await pool.query(
      "UPDATE platform.job_runs SET status='FAILED', error='superseded by forced rerun' " +
      'WHERE schema_name=$1 AND job=$2 AND business_date=$3',
      [tenant.schema_name, job, date]
    );
  }

  const run = await claim(tenant, job, date);
  if (!run) return { tenant: tenant.slug, job, businessDate: date, skipped: 'ALREADY_RUN' };

  try {
    const detail = await fn(tenant, date);
    await finish(run.id, 'SUCCEEDED', detail);
    return { tenant: tenant.slug, job, businessDate: date, ...detail };
  } catch (e) {
    await finish(run.id, 'FAILED', {}, e.message.slice(0, 1000));
    return { tenant: tenant.slug, job, businessDate: date, ok: false, error: e.message };
  }
}

/**
 * The daily sequence, run across every active tenant. Order matters: the year has to exist before anything
 * posts, arrears before penalties (penalties read arrears state), and
 * provisioning last because it reads the arrears the others just produced.
 */
const DEFAULT_JOBS = ['ensureFinancialYear', 'syncCalendar', 'billRevolving', 'reviewRates', 'updateTaxRates', 'accrueInterest', 'applyPostdatedPayments', 'accrueSavings', 'applyPlannedFees', 'collectSettlements', 'markArrears', 'accruePenalties',
  'applyFees', 'amortizeFees', 'enforceControls', 'provision', 'postAccruals', 'autoClosure', 'snapshotPortfolio', 'pruneReports'];

async function runAll({ businessDate = null, jobs = DEFAULT_JOBS, force = false } = {}) {
  const { rows: tenants } = await pool.query(
    "SELECT id, slug, schema_name, timezone FROM platform.tenants WHERE status = 'ACTIVE' ORDER BY slug");
  const results = [];
  for (const t of tenants) {
    // One tenant failing must not stop the rest of the fleet.
    results.push(...(await runTenant(t, { businessDate, jobs, force, trigger: 'MANUAL', createdBy: 'PLATFORM' })).jobs);
  }
  return results;
}

/**
 * The end of day for one tenant, on its own business date (its local date
 * unless given), recorded in eod_completions when any job ran: the state,
 * the jobs that failed and the loans left out that day (the reference platform's EOD
 * completion notification, Accounts Updated).
 */
async function runTenant(tenant, { businessDate = null, jobs = DEFAULT_JOBS, force = false, trigger = 'MANUAL', createdBy = 'SYSTEM' } = {}) {
  const date = businessDate || ORG.localClock(tenant.timezone || 'Africa/Nairobi').date;
  const started = new Date();
  const out = [];
  for (const job of jobs) out.push(await runJob(tenant, job, { businessDate: date, force }));
  const ran = out.filter((r) => !r.skipped);
  let completion = null;
  if (ran.length) {
    completion = await withTenant(tenant.schema_name, async (c) => {
      const { rows: [x] } = await c.query(
        'SELECT count(*)::int AS n FROM loan_eod_exclusions WHERE business_date = $1::date AND included_at IS NULL', [date]);
      const failedJobs = ran.filter((r) => r.ok === false).length;
      const { rows: [row] } = await c.query(
        `INSERT INTO eod_completions (business_date, trigger, state, started_at, failed_jobs, failed_loans, failed_deposits, jobs, created_by)
         VALUES ($1::date,$2,$3,$4,$5,$6,0,$7,$8) RETURNING *`,
        [date, trigger, failedJobs ? 'FAILED' : 'COMPLETE', started.toISOString(), failedJobs, x.n,
          JSON.stringify(out.map((r) => ({ job: r.job, ok: r.ok !== false, skipped: r.skipped || null, error: r.error || null }))), createdBy]);
      return row;
    });
  }
  return { tenant: tenant.slug, businessDate: date, jobs: out, completion };
}

/**
 * The scheduler's hourly call: every active tenant in AUTOMATIC mode whose
 * local hour is the end-of-day hour runs its end of day for its local date;
 * a tenant in MANUAL mode is left for its own Run Now (the reference platform's EOD
 * Processing setting). A tenant set to retry loans left out has them tried
 * again every hour.
 */
async function runScheduled({ eodHour = Number(process.env.EOD_HOUR ?? 22), at = new Date() } = {}) {
  const { rows: tenants } = await pool.query(
    "SELECT id, slug, schema_name, timezone FROM platform.tenants WHERE status = 'ACTIVE' ORDER BY slug");
  const results = [];
  for (const t of tenants) {
    try {
      const clock = ORG.localClock(t.timezone || 'Africa/Nairobi', at);
      const s = await withTenant(t.schema_name, (c) => ORG.settings(c));
      if (s && s.eod_retry_excluded) {
        const retried = await withTenant(t.schema_name, (c) => EX.retryAll(c, { createdBy: 'EOD_RETRY' }));
        if (retried.tried) results.push({ tenant: t.slug, retried });
      }
      if (clock.hour !== eodHour || !s || s.eod_mode !== 'AUTOMATIC') continue;
      const r = await runTenant(t, { businessDate: clock.date, trigger: 'AUTOMATIC', createdBy: 'EOD' });
      results.push({ tenant: t.slug, businessDate: r.businessDate, completion: r.completion ? r.completion.state : 'ALREADY_RUN' });
    } catch (e) {
      results.push({ tenant: t.slug, ok: false, error: e.message });
    }
  }
  return results;
}

async function history({ slug = null, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT j.*, t.slug FROM platform.job_runs j
     LEFT JOIN platform.tenants t ON t.id = j.tenant_id
     WHERE ($1::text IS NULL OR t.slug = $1)
     ORDER BY j.started_at DESC LIMIT $2`,
    [slug, limit]
  );
  return rows;
}

module.exports = {
  runTenant, runScheduled, JOBS, DEFAULT_JOBS, runJob, runAll, history };
