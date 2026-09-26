'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const types = require('./productTypes');
const fees = require('./fees');
const G = require('./eodGuard');
const { err, round2 } = acct;
const { ymd, isoDate } = S;

/**
 * Planned fees, after Mambu: manual fees placed on future installments
 * ahead of time, so the schedule shows them from the start. They can be
 * added, changed and removed until they are applied, before or after
 * disbursement, on any product with a schedule (not revolving).
 *
 * A planned fee is applied on its installment's due date by the end of day
 * (applyDue), unless the installment has been paid by then (SKIPPED). It
 * can also be applied early, now or on a later date (apply). Once applied
 * it is an ordinary fee on that installment: a transaction, its accounting,
 * and waivable. It is not applied on an installment in grace or a payment
 * holiday.
 */

const today = () => isoDate(new Date());
const OPEN = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS'];
const RUNNING = ['ACTIVE', 'IN_ARREARS'];

async function loanFor(c, loanId) {
  const l = await ledger.lock(c, loanId);
  if (!OPEN.includes(l.status)) throw err(`PLANNED_FEES_NOT_AVAILABLE_IN_STATE_${l.status}`, 409);
  const type = types.forLoan(l);
  if (!type.schedulesUpfront || l.product_type === 'REVOLVING') throw err('PLANNED_FEES_NEED_A_SCHEDULE', 409);
  return l;
}

async function installmentOf(c, l, number) {
  const n = Number(number);
  if (!(Number.isInteger(n) && n > 0)) throw err('INSTALLMENT_NUMBER_REQUIRED', 400);
  const { rows: [i] } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 AND number = $2', [l.id, n]);
  if (!i) {
    // Before disbursement there are no installments yet: the number must be within the term.
    if (Number(l.principal_disbursed) > 0 || n > Number(l.term_months)) throw err(`NO_INSTALLMENT_${n}`, 404);
    return null;
  }
  if (i.status === 'PAID') throw err(`INSTALLMENT_${n}_IS_PAID`, 409);
  if (i.status === 'GRACE' || i.payment_holiday) throw err(`INSTALLMENT_${n}_IS_IN_GRACE_OR_A_PAYMENT_HOLIDAY`, 409);
  return i;
}

/** The fee's name and amount: a product MANUAL fee (its amount unless one is given), or an arbitrary one where allowed. */
async function figure(c, l, { fee, name, amount }) {
  if (fee) {
    const { rows: [pf] } = await c.query(
      `SELECT * FROM loan_product_fees WHERE product_id = $1 AND is_active AND fee_type = 'MANUAL' AND (code = $2 OR id::text = $2)`,
      [l.product_id, String(fee)]);
    if (!pf) throw err(`UNKNOWN_MANUAL_FEE: ${fee}`, 404);
    const amt = amount !== undefined && amount !== null ? round2(amount) : fees.feeAmount(pf, { principal: await fees.percentBase(c, l) });
    return { productFeeId: pf.id, name: name || pf.name, amount: amt };
  }
  if (!l.allow_arbitrary_fees) throw err('NAME_A_MANUAL_FEE: the product does not allow arbitrary fees', 400);
  if (!name) throw err('FEE_NAME_AND_AMOUNT_REQUIRED', 400);
  return { productFeeId: null, name: String(name), amount: round2(amount) };
}

function checkApplyOn(applyOn, asOf) {
  if (applyOn === undefined || applyOn === null) return null;
  const d = String(applyOn).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw err(`INVALID_DATE: ${applyOn}`, 400);
  if (d <= (asOf || today())) throw err(`APPLY_ON_MUST_BE_AFTER_TODAY: ${d}`, 400);
  return d;
}

async function add(c, loanId, { installment, fee = null, name = null, amount = null, applyOn = null, note = null, asOf = null, createdBy } = {}) {
  const l = await loanFor(c, loanId);
  await installmentOf(c, l, installment);
  const f = await figure(c, l, { fee, name, amount });
  if (!(f.amount > 0)) throw err('PLANNED_FEE_AMOUNT_MUST_BE_POSITIVE', 400);
  const { rows: [r] } = await c.query(
    `INSERT INTO loan_planned_fees (loan_id, installment_number, product_fee_id, name, amount, apply_on, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8) RETURNING *`,
    [l.id, Number(installment), f.productFeeId, f.name, f.amount, checkApplyOn(applyOn, asOf), note, createdBy || 'SYSTEM']);
  return r;
}

async function lockPlanned(c, id) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_planned_fees WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw err('PLANNED_FEE_NOT_FOUND', 404);
  if (p.status !== 'PLANNED') throw err(`PLANNED_FEE_IS_${p.status}`, 409);
  return p;
}

/** Change the amount, installment, date or note of a planned fee not yet applied. */
async function edit(c, id, { installment, amount, applyOn, note, asOf = null, createdBy } = {}) {
  const p = await lockPlanned(c, id);
  const l = await loanFor(c, p.loan_id);
  const sets = [];
  const vals = [];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (installment !== undefined) { await installmentOf(c, l, installment); set('installment_number', Number(installment)); }
  if (amount !== undefined) {
    if (!(round2(amount) > 0)) throw err('PLANNED_FEE_AMOUNT_MUST_BE_POSITIVE', 400);
    set('amount', round2(amount));
  }
  if (applyOn !== undefined) set('apply_on', checkApplyOn(applyOn, asOf));
  if (note !== undefined) set('note', note);
  if (!sets.length) throw err('NO_UPDATABLE_FIELDS', 400);
  vals.push(id);
  const { rows: [r] } = await c.query(
    `UPDATE loan_planned_fees SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'PLANNED_FEE_CHANGED','loan_planned_fee',$2,$3,$4)`,
    [createdBy || 'SYSTEM', String(id), JSON.stringify(p), JSON.stringify(r)]);
  return r;
}

async function remove(c, id, { createdBy } = {}) {
  const p = await lockPlanned(c, id);
  const { rows: [r] } = await c.query(
    "UPDATE loan_planned_fees SET status = 'DELETED', reason = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, `deleted by ${createdBy || 'SYSTEM'}`]);
  return r || p;
}

/** Apply one planned fee now, on its installment. */
async function applyNow(c, p, { date, createdBy }) {
  const l = await ledger.lock(c, p.loan_id);
  if (!RUNNING.includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  const { rows: [i] } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 AND number = $2', [l.id, p.installment_number]);
  if (!i) throw err(`NO_INSTALLMENT_${p.installment_number}`, 409);
  const pf = await (async () => (p.product_fee_id ? (await c.query('SELECT * FROM loan_product_fees WHERE id = $1', [p.product_fee_id])).rows[0] : null))();
  const row = await fees.recordFee(c, l, {
    productFeeId: p.product_fee_id, name: p.name, feeType: 'PLANNED', amount: Number(p.amount), valueDate: date,
    installmentId: i.id, note: p.note, createdBy, ...fees.glFor(l, pf), taxable: pf ? pf.taxable !== false : true, amortize: pf,
  });
  if (row) await c.query('UPDATE loan_installments SET fee_due = fee_due + $1 WHERE id = $2', [row.amount, i.id]);
  if (row && i.status === 'PAID') await c.query("UPDATE loan_installments SET status = 'PARTIALLY_PAID' WHERE id = $1", [i.id]);
  const { rows: [r] } = await c.query(
    "UPDATE loan_planned_fees SET status = 'APPLIED', loan_fee_id = $2, updated_at = now() WHERE id = $1 RETURNING *", [p.id, row?.id || null]);
  return r;
}

/**
 * Apply planned fees early (Mambu's "Apply" and "Apply on Date"): with no
 * date, now; with a later date, they are applied by the end of day then.
 */
async function apply(c, loanId, { ids = null, applyOn = null, asOf = null, createdBy } = {}) {
  const l = await ledger.lock(c, loanId);
  const date = asOf ? ymd(asOf) : today();
  const { rows } = await c.query(
    `SELECT * FROM loan_planned_fees WHERE loan_id = $1 AND status = 'PLANNED' AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))
     ORDER BY installment_number, id FOR UPDATE`, [l.id, ids && ids.length ? ids.map(Number) : null]);
  if (!rows.length) throw err('NO_PLANNED_FEE_TO_APPLY', 409);
  const on = checkApplyOn(applyOn, date);
  const out = [];
  for (const p of rows) {
    if (on) {
      out.push((await c.query("UPDATE loan_planned_fees SET apply_on = $2::date, updated_at = now() WHERE id = $1 RETURNING *", [p.id, on])).rows[0]);
    } else {
      out.push(await applyNow(c, p, { date, createdBy }));
    }
  }
  return out;
}

/**
 * The end-of-day job: planned fees whose date has come are applied (a date
 * set to apply on, or the installment's due date); one whose installment
 * was paid before its due date is skipped.
 */
async function applyDue(c, { asOf = null, createdBy = 'EOD', loanId = null } = {}) {
  const date = asOf ? ymd(asOf) : today();
  const { rows } = await c.query(
    `SELECT p.*, i.status AS installment_status, i.due_date FROM loan_planned_fees p
     JOIN loan_accounts l ON l.id = p.loan_id
     JOIN loan_installments i ON i.loan_id = p.loan_id AND i.number = p.installment_number
     WHERE p.status = 'PLANNED' AND l.status IN ('ACTIVE', 'IN_ARREARS') AND ${G.EXCLUDED_SQL('l')}
       AND COALESCE(p.apply_on, i.due_date) <= $1::date AND ($2::uuid IS NULL OR l.id = $2::uuid)
     ORDER BY p.loan_id, p.installment_number, p.id`, [date, loanId]);
  const out = { due: rows.length, applied: 0, skipped: 0 };
  const byLoan = new Map();
  for (const p of rows) {
    if (!byLoan.has(p.loan_id)) byLoan.set(p.loan_id, []);
    byLoan.get(p.loan_id).push(p);
  }
  const run = await G.eachLoan(c, { job: 'applyPlannedFees', date }, [...byLoan.keys()], async (loanId) => {
    for (const p of byLoan.get(loanId)) {
      if (!p.apply_on && p.installment_status === 'PAID') {
        await c.query("UPDATE loan_planned_fees SET status = 'SKIPPED', reason = 'INSTALLMENT_PAID', updated_at = now() WHERE id = $1", [p.id]);
        out.skipped += 1;
        continue;
      }
      await applyNow(c, p, { date: p.apply_on ? ymd(p.apply_on) : ymd(p.due_date), createdBy });
      out.applied += 1;
    }
  });
  return { ...out, ...G.summary(run) };
}

async function forLoan(c, loanId) {
  const l = await ledger.read(c, loanId);
  const { rows } = await c.query(
    `SELECT p.*, i.due_date FROM loan_planned_fees p
     LEFT JOIN loan_installments i ON i.loan_id = p.loan_id AND i.number = p.installment_number
     WHERE p.loan_id = $1 AND p.status <> 'DELETED' ORDER BY p.installment_number, p.id`, [l.id]);
  return rows;
}

module.exports = { add, edit, remove, apply, applyDue, forLoan };
