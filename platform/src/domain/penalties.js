'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const { pageQuery } = require('../lib/page');
const { err, round2 } = acct;

/**
 * Late payment penalties.
 *
 * Charged per installment per day, and the unique index on
 * (installment_id, charged_on) means a rerun of the accrual cannot charge a
 * member twice for the same day. The database refuses it, so idempotence
 * does not depend on the job remembering what it did.
 *
 * Two bases, because SACCOs price this both ways:
 *   OVERDUE      rate on the amount actually in arrears (the fair one)
 *   OUTSTANDING  rate on the whole outstanding principal (the punitive one)
 */

function daysLate(dueDate, asOf) {
  const d = Math.floor((new Date(asOf) - new Date(dueDate)) / 86400000);
  return d > 0 ? d : 0;
}

/**
 * Accrue penalties for one loan as at a date.
 * Returns the charges created; an empty array is a normal outcome.
 */
async function accrueForLoan(c, loanId, { asOf = null, createdBy = 'EOD' } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);

  const { rows: [l] } = await c.query(
    `SELECT l.*, p.penalty_rate, p.penalty_basis, p.penalty_grace_days,
            p.gl_penalty_inc, p.gl_portfolio, p.gl_interest_inc
     FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
     WHERE l.id = $1 FOR UPDATE OF l`,
    [loanId]
  );
  if (!l) throw err('LOAN_NOT_FOUND', 404);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) return [];
  const rate = Number(l.penalty_rate) / 100;
  if (!(rate > 0)) return [];

  const { rows: overdue } = await c.query(
    `SELECT * FROM loan_installments
     WHERE loan_id = $1
       AND status <> 'PAID'
       AND due_date < $2::date
     ORDER BY number`,
    [l.id, date]
  );

  const glIncome = l.gl_penalty_inc || l.gl_interest_inc;
  const charges = [];

  for (const inst of overdue) {
    const late = daysLate(inst.due_date, date);
    if (late <= Number(l.penalty_grace_days)) continue;

    const arrears = round2(
      (inst.principal_due - inst.principal_paid)
      + (inst.interest_due - inst.interest_paid)
      + (inst.fee_due - inst.fee_paid)
    );
    if (arrears <= 0) continue;

    const basisAmount = l.penalty_basis === 'OUTSTANDING'
      ? round2(l.principal_disbursed - l.principal_paid)
      : arrears;
    const amount = round2(basisAmount * rate);
    if (!(amount > 0)) continue;

    // ON CONFLICT DO NOTHING rather than catching a unique violation:
    // inside a transaction, any statement error aborts the whole
    // transaction, so a caught 23505 would leave the connection dead for
    // every later statement. This returns zero rows instead of raising, so
    // a rerun is a genuine no-op.
    const { rows: ins } = await c.query(
      `INSERT INTO penalty_charges
         (loan_id, installment_id, charged_on, days_late, basis_amount, rate, amount)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7)
       ON CONFLICT (installment_id, charged_on) WHERE waived_at IS NULL DO NOTHING
       RETURNING *`,
      [l.id, inst.id, date, late, basisAmount, l.penalty_rate, amount]
    );
    if (!ins.length) continue;            // already charged for this day
    const inserted = ins[0];

    const entry = await acct.post(c, {
      debits: [{ glCode: l.gl_portfolio, amount, memberId: l.member_id }],
      credits: [{ glCode: glIncome, amount, memberId: l.member_id }],
      narration: `Penalty ${l.account_no} installment ${inst.number}, ${late} days late`,
      sourceType: 'LOAN_PENALTY', sourceId: l.id, bookingDate: date, createdBy,
    });
    await c.query('UPDATE penalty_charges SET entry_id = $1 WHERE id = $2', [entry.entryId, inserted.id]);
    await c.query(
      'UPDATE loan_accounts SET penalty_accrued = penalty_accrued + $1, updated_at = now() WHERE id = $2',
      [amount, l.id]
    );

    charges.push({ ...inserted, entryId: entry.entryId });
  }

  return charges;
}

async function accrueAll(c, { asOf = null, createdBy = 'EOD' } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const { rows } = await c.query(
    `SELECT DISTINCT l.id FROM loan_accounts l
     JOIN loan_products p ON p.id = l.product_id
     JOIN loan_installments i ON i.loan_id = l.id
     WHERE l.status IN ('ACTIVE','IN_ARREARS')
       AND p.penalty_rate > 0
       AND i.status <> 'PAID'
       AND i.due_date < $1::date`,
    [date]
  );
  let charged = 0;
  let total = 0;
  for (const r of rows) {
    const out = await accrueForLoan(c, r.id, { asOf: date, createdBy });
    charged += out.length;
    total = round2(total + out.reduce((s, x) => s + Number(x.amount), 0));
  }
  return { loansConsidered: rows.length, chargesCreated: charged, total };
}

/**
 * Waiving is a management decision and a common one, so it reverses the
 * posting rather than deleting the charge. The record of both the penalty
 * and the waiver stays visible.
 */
async function waive(c, chargeId, { reason = '', createdBy } = {}) {
  const { rows: [ch] } = await c.query(
    'SELECT * FROM penalty_charges WHERE id = $1 FOR UPDATE', [chargeId]);
  if (!ch) throw err('PENALTY_CHARGE_NOT_FOUND', 404);
  if (ch.waived_at) throw err('PENALTY_ALREADY_WAIVED', 409);

  if (ch.entry_id) await acct.reverse(c, ch.entry_id, `Penalty waived: ${reason}`, createdBy);

  await c.query(
    'UPDATE penalty_charges SET waived_at = now(), waived_by = $1 WHERE id = $2',
    [createdBy || 'SYSTEM', chargeId]
  );
  await c.query(
    'UPDATE loan_accounts SET penalty_accrued = penalty_accrued - $1, updated_at = now() WHERE id = $2',
    [ch.amount, ch.loan_id]
  );
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'PENALTY_WAIVED','penalty_charge',$2,$3,$4)`,
    [createdBy || 'SYSTEM', chargeId, JSON.stringify(ch), JSON.stringify({ reason })]
  );
  return { waived: true, amount: Number(ch.amount), reason };
}

/**
 * Every penalty charged on one loan. One row per installment per day, so a
 * loan two years in arrears has hundreds; paged for that reason.
 */
async function forLoan(c, loanId, { offset = 0, limit = 50 } = {}) {
  return pageQuery(
    c,
    `SELECT pc.*, i.number AS installment_number, i.due_date
     FROM penalty_charges pc
     LEFT JOIN loan_installments i ON i.id = pc.installment_id
     JOIN loan_accounts l ON l.id = pc.loan_id
     WHERE l.id::text = $1 OR l.account_no = $1
     ORDER BY pc.charged_on DESC, pc.id`,
    [loanId],
    { offset, limit }
  );
}

module.exports = { accrueForLoan, accrueAll, waive, forLoan, daysLate };
