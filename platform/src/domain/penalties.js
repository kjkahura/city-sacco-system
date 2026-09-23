'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const tax = require('./tax');
const L = require('./ledger');
const W = require('./workflow');
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
 * Mambu's four bases ("Loan Penalties Setup"), each a daily rate:
 *   OVERDUE_PRINCIPAL           principal in arrears
 *   OVERDUE_PRINCIPAL_INTEREST  principal and interest in arrears
 *   OVERDUE_ALL                 principal, interest and fees in arrears
 *   OUTSTANDING_PRINCIPAL       the whole outstanding principal, which is a
 *                               penalty interest rate on top of the rate
 * and NONE. The penalty tolerance period is the number of days late before
 * a penalty is applied; it is counted from the due date, so once it lapses
 * the penalty covers every late day. The rate is the product's unless the
 * loan carries its own. A loan in arrears under a charge cap has its
 * penalties capped like every other charge (workflow.capAllows).
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

  const l = await L.lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) return [];
  if (!l.penalty_basis || l.penalty_basis === 'NONE') return [];
  const effRate = Number(L.effective(l).penaltyRate);
  const rate = effRate / 100;
  if (!(rate > 0)) return [];
  const tolerance = Number(l.penalty_tolerance_days || 0);

  const { rows: overdue } = await c.query(
    `SELECT * FROM loan_installments
     WHERE loan_id = $1
       AND status NOT IN ('PAID', 'GRACE')
       AND due_date < $2::date
     ORDER BY number`,
    [l.id, date]
  );

  const glIncome = l.gl_penalty_inc || l.gl_interest_inc;
  const charges = [];

  for (const inst of overdue) {
    const late = daysLate(inst.due_date, date);
    if (late <= tolerance) continue;

    const overduePrincipal = round2(inst.principal_due - inst.principal_paid);
    const overdueInterest = round2(inst.interest_due - inst.interest_paid);
    const overdueFees = round2(inst.fee_due - inst.fee_paid);
    if (round2(overduePrincipal + overdueInterest + overdueFees) <= 0) continue;

    let basisAmount;
    switch (l.penalty_basis) {
      case 'OVERDUE_PRINCIPAL': basisAmount = overduePrincipal; break;
      case 'OVERDUE_PRINCIPAL_INTEREST': basisAmount = round2(overduePrincipal + overdueInterest); break;
      case 'OUTSTANDING_PRINCIPAL': basisAmount = L.principalOutstanding(l); break;
      default: basisAmount = round2(overduePrincipal + overdueInterest + overdueFees);
    }
    let amount = round2(Math.max(0, basisAmount) * rate);
    if (!(amount > 0)) continue;
    amount = await W.capAllows(c, l, amount);
    if (!(amount > 0)) break;
    // Tax on penalties, where the product charges it.
    const tx = tax.split(l, 'PENALTY', amount);
    amount = tx.gross;

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
      [l.id, inst.id, date, late, basisAmount, effRate, amount]
    );
    if (!ins.length) continue;            // already charged for this day
    const inserted = ins[0];

    // Penalty applied: Dr Penalty Receivable, Cr Penalty Income (accrual).
    // Under cash accounting nothing is booked until it is paid. It used to
    // debit the portfolio, which inflated the loan book with income that
    // had not been collected and then recognised it again on payment.
    let entryId = null;
    if (L.isAccrual(l)) {
      entryId = await L.post(c, l, {
        debits: [{ glCode: l.gl_penalty_rec, amount, memberId: l.member_id }],
        credits: tax.incomeCredits(l, tx, glIncome, l.member_id),
        narration: `Penalty ${l.account_no} installment ${inst.number}, ${late} days late`,
        sourceType: 'LOAN_PENALTY', sourceId: l.id, bookingDate: date, createdBy,
      });
      if (entryId) await c.query('UPDATE penalty_charges SET entry_id = $1 WHERE id = $2', [entryId, inserted.id]);
    }
    await c.query(
      `UPDATE loan_accounts SET penalty_accrued = penalty_accrued + $1, tax_charged = tax_charged + $3,
         charges_since_arrears = charges_since_arrears + CASE WHEN status = 'IN_ARREARS' THEN $1 ELSE 0 END,
         updated_at = now() WHERE id = $2`,
      [amount, l.id, tx.tax]
    );
    l.charges_since_arrears = Number(l.charges_since_arrears || 0) + amount;

    charges.push({ ...inserted, entryId });
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
       AND ${L.overrideSql('penaltyRate')} > 0
       AND p.penalty_basis <> 'NONE'
       AND i.status NOT IN ('PAID', 'GRACE')
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
