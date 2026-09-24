'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * Loan loss provisioning.
 *
 * Every loan is classified by how many days its oldest unpaid installment is
 * overdue, each band carries a rate, and the allowance is the sum of
 * outstanding principal in each band times that band's rate.
 *
 * Two things this deliberately does not do.
 *
 * It ships no rates. `provision_bands.rate_percent` starts NULL and a run
 * refuses to proceed until every band has one, because the rates are a
 * regulatory figure and a default nobody checked would quietly become the
 * number a board relies on.
 *
 * It posts the movement, never the balance. The allowance is a standing
 * contra-asset: if it already holds 400,000 and the calculation says it
 * should hold 550,000, the entry is 150,000, not 550,000. Posting the
 * required balance every month is the classic provisioning bug and it
 * inflates the allowance without limit.
 */

const GL_ALLOWANCE = '100-150';
const GL_EXPENSE = '500-300';

/** The bands, ordered, with a flag for whether the tenant has configured them. */
async function bands(c) {
  const { rows } = await c.query(
    'SELECT * FROM provision_bands ORDER BY sort_order, min_days');
  return rows;
}

async function assertConfigured(c) {
  const rows = await bands(c);
  if (!rows.length) throw err('PROVISION_BANDS_NOT_DEFINED', 409);
  const unset = rows.filter((b) => b.rate_percent === null).map((b) => b.code);
  if (unset.length) {
    throw err(`PROVISION_RATES_NOT_CONFIGURED: ${unset.join(', ')}`, 409);
  }
  return rows;
}

/** Set or change one band. Rates are a board decision, so it is audited. */
async function setBand(c, code, { ratePercent, minDays, maxDays, label, sourceNote, createdBy } = {}) {
  const { rows: [before] } = await c.query(
    'SELECT * FROM provision_bands WHERE code = $1 FOR UPDATE', [code]);
  if (!before) throw err('PROVISION_BAND_NOT_FOUND', 404);

  const { rows } = await c.query(
    `UPDATE provision_bands SET
       rate_percent = COALESCE($2, rate_percent),
       min_days     = COALESCE($3, min_days),
       max_days     = CASE WHEN $4::boolean THEN $5::int ELSE max_days END,
       label        = COALESCE($6, label),
       source_note  = COALESCE($7, source_note),
       updated_at   = now()
     WHERE code = $1 RETURNING *`,
    [code, ratePercent ?? null, minDays ?? null,
     maxDays !== undefined, maxDays ?? null, label ?? null, sourceNote ?? null]
  );

  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'PROVISION_BAND_CHANGED','provision_band',$2,$3,$4)`,
    [createdBy || 'SYSTEM', code, JSON.stringify(before), JSON.stringify(rows[0])]
  );
  return rows[0];
}

/**
 * What the allowance should be as at a date, band by band.
 *
 * Classification is by the oldest unpaid installment, the same arrears
 * measure the PAR report uses, so the two reports cannot disagree about
 * which loans are in trouble.
 */
async function compute(c, { asAt = null } = {}) {
  const date = asAt || new Date().toISOString().slice(0, 10);
  const configured = await assertConfigured(c);

  const { rows } = await c.query(
    `WITH arrears AS (
       SELECT l.id,
              COALESCE(GREATEST(0, MAX($1::date - i.due_date)), 0) AS days_late,
              GREATEST(l.principal_disbursed - l.principal_paid, 0) AS outstanding
       FROM loan_accounts l
       LEFT JOIN loan_installments i
         ON i.loan_id = l.id AND i.status <> 'PAID' AND i.due_date < $1::date
       WHERE l.status IN ('ACTIVE','IN_ARREARS')
       GROUP BY l.id
     )
     SELECT b.code, b.label, b.min_days, b.max_days, b.rate_percent,
            count(a.id)::int AS loans,
            COALESCE(SUM(a.outstanding), 0) AS outstanding
     FROM provision_bands b
     LEFT JOIN arrears a
       ON a.days_late >= b.min_days
      AND (b.max_days IS NULL OR a.days_late <= b.max_days)
     GROUP BY b.code, b.label, b.min_days, b.max_days, b.rate_percent, b.sort_order
     ORDER BY b.sort_order, b.min_days`,
    [date]
  );

  const lines = rows.map((r) => ({
    band: r.code,
    label: r.label,
    daysFrom: r.min_days,
    daysTo: r.max_days,
    rate: Number(r.rate_percent),
    loans: r.loans,
    outstanding: round2(r.outstanding),
    required: round2(Number(r.outstanding) * Number(r.rate_percent) / 100),
  }));

  const required = round2(lines.reduce((s, l) => s + l.required, 0));
  // Debit-positive balance of a contra-asset is negative; the allowance held
  // is the credit balance.
  const held = round2(-(await acct.balance(c, GL_ALLOWANCE, { to: date })));

  return {
    asAt: date,
    bands: configured.length,
    lines,
    requiredTotal: required,
    heldTotal: held,
    movement: round2(required - held),
    portfolioOutstanding: round2(lines.reduce((s, l) => s + l.outstanding, 0)),
  };
}

/**
 * The part of the allowance that stands for one loan: its outstanding
 * principal at its band's rate, the same arithmetic the run uses, capped by
 * what the allowance actually holds. A write-off uses this much of the
 * allowance before it charges the expense; the next run then finds the loan
 * gone and the allowance already lower by its share, so nothing is charged
 * twice. Nothing is attributed while the bands have no rates.
 */
async function attributable(c, l, { asAt = null } = {}) {
  const date = asAt || new Date().toISOString().slice(0, 10);
  const rows = await bands(c);
  if (!rows.length || rows.some((b) => b.rate_percent === null)) return { amount: 0, reason: 'PROVISION_RATES_NOT_CONFIGURED' };
  const { rows: [a] } = await c.query(
    `SELECT COALESCE(GREATEST(0, MAX($2::date - i.due_date)), 0) AS days_late,
            GREATEST(l.principal_disbursed - l.principal_paid, 0) AS outstanding
     FROM loan_accounts l
     LEFT JOIN loan_installments i ON i.loan_id = l.id AND i.status <> 'PAID' AND i.due_date < $2::date
     WHERE l.id = $1 GROUP BY l.id`, [l.id, date]);
  const days = Number(a?.days_late || 0);
  const outstanding = round2(a?.outstanding || 0);
  const band = rows.find((b) => days >= b.min_days && (b.max_days === null || days <= b.max_days));
  if (!band) return { amount: 0, reason: 'NO_BAND', daysLate: days };
  const required = round2(outstanding * Number(band.rate_percent) / 100);
  const held = round2(-(await acct.balance(c, GL_ALLOWANCE, { to: date })));
  return {
    band: band.code, rate: Number(band.rate_percent), daysLate: days, outstanding, required, held,
    amount: round2(Math.max(0, Math.min(required, held, outstanding))),
  };
}

/**
 * Post the movement for a date.
 *
 * Idempotent through the database: a partial unique index allows one POSTED
 * run per as-at date, so a rerun inserts nothing and returns ALREADY_RUN
 * rather than provisioning twice. ON CONFLICT DO NOTHING rather than
 * catching 23505, because a caught unique violation inside a transaction
 * leaves the whole transaction aborted.
 */
async function run(c, { asAt = null, createdBy = 'SYSTEM' } = {}) {
  const calc = await compute(c, { asAt });
  const date = calc.asAt;

  const { rows: claim } = await c.query(
    `INSERT INTO provision_runs
       (as_at, required_total, previous_total, movement, gl_allowance, gl_expense, status, created_by)
     VALUES ($1::date,$2,$3,$4,$5,$6,'POSTED',$7)
     ON CONFLICT (as_at) WHERE status = 'POSTED' DO NOTHING
     RETURNING *`,
    [date, calc.requiredTotal, calc.heldTotal, calc.movement, GL_ALLOWANCE, GL_EXPENSE, createdBy]
  );
  if (!claim.length) return { ...calc, skipped: 'ALREADY_RUN' };
  const runRow = claim[0];

  for (const l of calc.lines) {
    await c.query(
      `INSERT INTO provision_run_lines (run_id, band_code, loans, outstanding, rate, required)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [runRow.id, l.band, l.loans, l.outstanding, l.rate, l.required]
    );
  }

  let entryId = null;
  if (calc.movement !== 0) {
    const amount = Math.abs(calc.movement);
    // A rise charges the expense and builds the allowance. A fall releases
    // it back, which is a credit to the same expense account rather than to
    // income: the release is a correction of an earlier charge.
    const entry = calc.movement > 0
      ? await acct.post(c, {
        debits: [{ glCode: GL_EXPENSE, amount }],
        credits: [{ glCode: GL_ALLOWANCE, amount }],
        narration: `Loan loss provision as at ${date}`,
        sourceType: 'LOAN_LOSS_PROVISION', sourceId: runRow.id, bookingDate: date, createdBy,
      })
      : await acct.post(c, {
        debits: [{ glCode: GL_ALLOWANCE, amount }],
        credits: [{ glCode: GL_EXPENSE, amount }],
        narration: `Loan loss provision release as at ${date}`,
        sourceType: 'LOAN_LOSS_PROVISION', sourceId: runRow.id, bookingDate: date, createdBy,
      });
    entryId = entry.entryId;
    await c.query('UPDATE provision_runs SET entry_id = $1 WHERE id = $2', [entryId, runRow.id]);
  }

  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'PROVISION_RUN','provision_run',$2,$3)`,
    [createdBy, runRow.id, JSON.stringify({ asAt: date, movement: calc.movement, entryId })]
  );

  return { ...calc, runId: runRow.id, entryId, posted: true };
}

/** Undo a run by reversing its entry. The run stays on the record. */
async function reverseRun(c, runId, { reason = '', createdBy = 'SYSTEM' } = {}) {
  const { rows: [r] } = await c.query(
    'SELECT * FROM provision_runs WHERE id = $1 FOR UPDATE', [runId]);
  if (!r) throw err('PROVISION_RUN_NOT_FOUND', 404);
  if (r.status === 'REVERSED') throw err('PROVISION_RUN_ALREADY_REVERSED', 409);

  if (r.entry_id) {
    await acct.reverse(c, r.entry_id, `Provision run reversed: ${reason}`, createdBy);
  }
  await c.query("UPDATE provision_runs SET status = 'REVERSED' WHERE id = $1", [runId]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'PROVISION_RUN_REVERSED','provision_run',$2,$3,$4)`,
    [createdBy, runId, JSON.stringify(r), JSON.stringify({ reason })]
  );
  return { runId, reversed: true, reason };
}

async function history(c, { limit = 24 } = {}) {
  const { rows } = await c.query(
    `SELECT r.*, COALESCE(json_agg(json_build_object(
              'band', l.band_code, 'loans', l.loans, 'outstanding', l.outstanding,
              'rate', l.rate, 'required', l.required) ORDER BY l.id)
            FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS lines
     FROM provision_runs r
     LEFT JOIN provision_run_lines l ON l.run_id = r.id
     GROUP BY r.id
     ORDER BY r.as_at DESC
     LIMIT $1`,
    [Math.min(200, Math.max(1, Number(limit) || 24))]
  );
  return rows;
}

module.exports = {
  bands, setBand, compute, run, reverseRun, history, attributable,
  GL_ALLOWANCE, GL_EXPENSE,
};
