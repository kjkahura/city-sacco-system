'use strict';

const { pool } = require('../db/pool');
const { withTenant } = require('../db/tenantContext');
const L = require('../domain/loans');

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

  /** Flag overdue installments and move loans into arrears. */
  async markArrears(tenant, businessDate) {
    return withTenant(tenant.schema_name, async (c) => {
      const flagged = await L.markArrears(c, { asOf: businessDate });
      return { flagged: flagged.length, loans: flagged.map((r) => r.account_no) };
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

/** Run the full end-of-day sequence across every active tenant. */
async function runAll({ businessDate = null, jobs = ['accrueInterest', 'markArrears'], force = false } = {}) {
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

module.exports = { JOBS, runJob, runAll, history };
