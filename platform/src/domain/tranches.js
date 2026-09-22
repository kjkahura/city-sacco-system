'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * Tranched loans, after Mambu's "Loans with tranched disbursements": a loan
 * approved for one amount and paid out in parts, each with an expected
 * date. The loan is ACTIVE from the first tranche; interest runs on what has
 * actually been disbursed; the schedule for what remains is redrawn each
 * time a tranche lands. Tranches may be added, changed and removed while
 * the application is open and, for tranches not yet disbursed, while the
 * loan runs, so long as the total stays the approved amount.
 */

const L = () => require('./loans');
const ymd = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).slice(0, 10));

async function forLoan(c, loanId) {
  const { rows } = await c.query(
    `SELECT t.* FROM loan_tranches t JOIN loan_accounts l ON l.id = t.loan_id
     WHERE (l.id::text = $1 OR l.account_no = $1) AND t.status <> 'CANCELLED' ORDER BY t.number`, [loanId]);
  return rows;
}

/**
 * Replace the planned tranches. `tranches` is the full list of tranches not
 * yet disbursed: [{ amount, expectedOn }]. Disbursed ones stay as they are.
 */
async function setTranches(c, loanId, tranches, { createdBy } = {}) {
  const l = await L().lock(c, loanId);
  if (l.product_type !== 'TRANCHED') throw err('NOT_A_TRANCHED_LOAN', 409);
  if (!['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS'].includes(l.status)) {
    throw err(`CANNOT_EDIT_TRANCHES_IN_STATE: ${l.status}`, 409);
  }
  if (!Array.isArray(tranches) || !tranches.length) throw err('TRANCHES_REQUIRED', 400);
  const { rows: done } = await c.query(
    "SELECT * FROM loan_tranches WHERE loan_id = $1 AND status = 'DISBURSED' ORDER BY number", [l.id]);
  const disbursed = round2(done.reduce((s, t) => s + Number(t.disbursed_amount || t.amount), 0));
  const planned = tranches.map((t) => ({ amount: round2(t.amount), expectedOn: ymd(t.expectedOn) }));
  if (planned.some((t) => !(t.amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(t.expectedOn))) throw err('TRANCHE_NEEDS_AMOUNT_AND_DATE', 400);
  const total = round2(disbursed + planned.reduce((s, t) => s + t.amount, 0));
  if (total !== round2(l.principal)) throw err(`TRANCHES_MUST_SUM_TO_PRINCIPAL: ${total} of ${l.principal}`, 400);
  if (l.max_tranches && done.length + planned.length > Number(l.max_tranches)) throw err(`TOO_MANY_TRANCHES: product allows ${l.max_tranches}`, 400);
  for (let i = 1; i < planned.length; i += 1) {
    if (planned[i].expectedOn < planned[i - 1].expectedOn) throw err('TRANCHES_MUST_BE_IN_DATE_ORDER', 400);
  }
  await c.query("UPDATE loan_tranches SET status = 'CANCELLED' WHERE loan_id = $1 AND status = 'PLANNED'", [l.id]);
  let n = done.length;
  const out = [...done];
  for (const t of planned) {
    n += 1;
    const { rows } = await c.query(
      `INSERT INTO loan_tranches (loan_id, number, amount, expected_on) VALUES ($1,$2,$3,$4::date)
       ON CONFLICT (loan_id, number) DO UPDATE SET amount = EXCLUDED.amount, expected_on = EXCLUDED.expected_on, status = 'PLANNED'
       RETURNING *`, [l.id, n, t.amount, t.expectedOn]);
    out.push(rows[0]);
  }
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'TRANCHES_SET','loan_account',$2,$3)`,
    [createdBy || 'SYSTEM', l.id, JSON.stringify(planned)]);
  return out;
}

/** The next tranche waiting to be paid out, or null. */
async function nextPlanned(c, loanId) {
  const { rows: [t] } = await c.query(
    "SELECT * FROM loan_tranches WHERE loan_id = $1 AND status = 'PLANNED' ORDER BY number LIMIT 1", [loanId]);
  return t || null;
}

async function markDisbursed(c, trancheId, { amount, date, transactionId }) {
  await c.query(
    `UPDATE loan_tranches SET status = 'DISBURSED', disbursed_on = $2::date, disbursed_amount = $3, transaction_id = $4 WHERE id = $1`,
    [trancheId, date, amount, transactionId]);
}

/** Approval needs the tranches to add up. */
async function assertPlanned(c, l) {
  if (l.product_type !== 'TRANCHED') return;
  const rows = await forLoan(c, l.id);
  const total = round2(rows.reduce((s, t) => s + Number(t.amount), 0));
  if (!rows.length || total !== round2(l.principal)) throw err(`TRANCHES_MUST_SUM_TO_PRINCIPAL: ${total} of ${l.principal}`, 409);
}

module.exports = { forLoan, setTranches, nextPlanned, markDisbursed, assertPlanned };
