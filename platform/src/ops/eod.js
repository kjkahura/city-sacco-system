'use strict';

const { pool } = require('../db/pool');
const { withTenant } = require('../db/tenantContext');
const L = require('../domain/loans');
const P = require('../domain/penalties');
const F = require('../domain/fees');
const W = require('../domain/workflow');
const P2 = require('../domain/provisioning');
const CL = require('../domain/close');

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
  /** Accrue a period's interest on every active loan. */
  async accrueInterest(tenant, businessDate) {
    return withTenant(tenant.schema_name, async (c) => {
      const { rows } = await c.query(
        "SELECT id FROM loan_accounts WHERE status IN ('ACTIVE','IN_ARREARS')");
      let accrued = 0;
      let total = 0;
      for (const l of rows) {
        const tx = await L.accrueInterest(c, l.id, { valueDate: businessDate, createdBy: 'EOD' });
        if (tx) { accrued += 1; total += Number(tx.amount); }
      }
      return { loans: rows.length, accrued, total: Math.round(total * 100) / 100 };
    });
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
      const { rows } = await c.query("SELECT id FROM loan_accounts WHERE status IN ('ACTIVE','IN_ARREARS')");
      let due = 0; let late = 0;
      for (const r of rows) {
        const l = await L.lock(c, r.id);
        if (L.isDynamic(l)) due += await F.applyPaymentDueFees(c, l, businessDate);
        late += await F.applyLateFees(c, l, businessDate);
      }
      return { loans: rows.length, paymentDueApplied: due, lateFeesApplied: late };
    });
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
      return { flagged: flagged.length, loans: flagged.map((r) => r.account_no) };
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
  const date = businessDate || new Date().toISOString().slice(0, 10);
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
const DEFAULT_JOBS = ['ensureFinancialYear', 'billRevolving', 'accrueInterest', 'accrueSavings', 'markArrears', 'accruePenalties',
  'applyFees', 'enforceControls', 'provision', 'postAccruals', 'autoClosure'];

async function runAll({ businessDate = null, jobs = DEFAULT_JOBS, force = false } = {}) {
  const { rows: tenants } = await pool.query(
    "SELECT id, slug, schema_name FROM platform.tenants WHERE status = 'ACTIVE' ORDER BY slug");
  const results = [];
  for (const t of tenants) {
    for (const job of jobs) {
      // One tenant failing must not stop the rest of the fleet.
      results.push(await runJob(t, job, { businessDate, force }));
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

module.exports = { JOBS, DEFAULT_JOBS, runJob, runAll, history };
