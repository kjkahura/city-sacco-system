'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const tax = require('./tax');
const ledger = require('./ledger');
const workflow = require('./workflow');
const { err, round2 } = acct;

/**
 * Loan fees, after Mambu's "Loan Fees Setup".
 *
 * A product defines fees in loan_product_fees; each says when it happens
 * (fee_type) and how much (calculation). Applying one writes a loan_fees
 * row, raises the loan's fees_due, and under accrual accounting books
 * Dr Fee Receivable, Cr Fee Income. Paying it credits the receivable
 * (loans.paidCredit); waiving it reverses the entry.
 *
 *   MANUAL                    applied by a user when the event occurs
 *   DISBURSEMENT_DEDUCTED     taken out of what the member receives; settled at once
 *   DISBURSEMENT_CAPITALIZED  added to what the member repays; settled at once
 *   DISBURSEMENT_UPFRONT      due at disbursement, paid with a later payment
 *   PAYMENT_DUE               on the schedule, one share per installment
 *   LATE_REPAYMENT            applied when an installment goes overdue
 *
 * The legacy loan_products.processing_fee is an upfront flat fee called
 * "Processing fee"; a product may use it, the table, or both.
 */

const ymd = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);


async function productFees(c, productId, types = null) {
  const { rows } = await c.query(
    `SELECT * FROM loan_product_fees WHERE product_id = $1 AND is_active
       AND ($2::text[] IS NULL OR fee_type = ANY($2)) ORDER BY fee_type, code`,
    [productId, types]
  );
  return rows;
}

/** Clamp to the fee's min and max, when it has them. */
function clamp(fee, amount) {
  let a = round2(amount);
  if (fee.min_amount !== null && fee.min_amount !== undefined && a < Number(fee.min_amount)) a = round2(fee.min_amount);
  if (fee.max_amount !== null && fee.max_amount !== undefined && a > Number(fee.max_amount)) a = round2(fee.max_amount);
  return a;
}

/**
 * How much a fee comes to. `principal` is the approved amount, `count` the
 * number of installments, `installmentPrincipal` the principal of the
 * installment a late fee is for. A MANUAL flat fee with no amount takes the
 * amount the teller enters.
 */
function feeAmount(fee, { principal = 0, count = 1, installmentPrincipal = 0, entered = null } = {}) {
  switch (fee.calculation) {
    case 'FLAT':
      if (fee.amount === null || fee.amount === undefined) {
        if (entered === null || entered === undefined) throw err(`FEE_AMOUNT_REQUIRED: ${fee.code}`, 400);
        return clamp(fee, entered);
      }
      return clamp(fee, fee.amount);
    case 'FLAT_PER_INSTALLMENT': return clamp(fee, Number(fee.amount) / Math.max(1, count));
    case 'PERCENT_OF_AMOUNT': return clamp(fee, principal * Number(fee.percent) / 100);
    case 'PERCENT_PER_INSTALLMENT': return clamp(fee, principal * Number(fee.percent) / 100 / Math.max(1, count));
    case 'PERCENT_OF_INSTALLMENT_PRINCIPAL': return clamp(fee, installmentPrincipal * Number(fee.percent) / 100);
    default: throw err(`UNKNOWN_FEE_CALCULATION: ${fee.calculation}`);
  }
}

const glFor = (l, fee) => ({
  glIncome: fee?.gl_income || l.gl_fee_inc || l.gl_interest_inc,
  glReceivable: fee?.gl_receivable || l.gl_fee_rec,
});

/** Was this optional fee chosen for the loan? By code or id. */
const chosen = (fee, selected) => fee.required || (selected || []).some((s) => s === fee.code || s === fee.id);

/**
 * The fee due with each installment line (PAYMENT_DUE fees), keyed by
 * installment number. Called while the schedule is drawn.
 */
async function scheduledFees(c, l, lines) {
  const plan = {};
  if (!l.product_id || !lines.length) return plan;
  const fees = await productFees(c, l.product_id, ['PAYMENT_DUE']);
  const principal = Number(l.principal_disbursed || l.principal);
  for (const fee of fees) {
    if (!chosen(fee, l._selectedFees)) continue;
    for (const line of lines) {
      if (line.grace === 'PURE') continue;
      const share = feeAmount(fee, { principal, count: lines.length });
      // FLAT and PERCENT_OF_AMOUNT are the whole fee on every installment;
      // the per-installment calculations already divided by the count.
      plan[line.number] = round2((plan[line.number] || 0) + share);
    }
  }
  return plan;
}

/**
 * What the disbursement of `amount` settles: the product's disbursement
 * fees (required ones always, optional ones when `selected`), plus the
 * legacy processing fee. Returns the items and the deducted, capitalised
 * and upfront totals.
 */
async function disbursementFees(c, l, { amount, selected = [] }) {
  const fees = await productFees(c, l.product_id, ['DISBURSEMENT_DEDUCTED', 'DISBURSEMENT_CAPITALIZED', 'DISBURSEMENT_UPFRONT']);
  const known = new Set(fees.flatMap((f) => [f.code, f.id]));
  for (const s of selected) {
    if (!known.has(s)) {
      const all = await productFees(c, l.product_id);
      if (!all.some((f) => f.code === s || f.id === s)) throw err(`UNKNOWN_FEE: ${s}`, 400);
    }
  }
  // Each item carries the gross the member is charged (amount), the income
  // (net) and the tax, where the product taxes fees.
  const items = [];
  const push = (base) => {
    const tx = tax.split(l, 'FEE', base.net, { taxable: base.taxable });
    items.push({ ...base, amount: tx.gross, net: tx.income, tax: tx.tax });
  };
  for (const fee of fees) {
    if (!chosen(fee, selected)) continue;
    const amt = feeAmount(fee, { principal: amount, count: Number(l.term_months) });
    if (!(amt > 0)) continue;
    push({ productFeeId: fee.id, code: fee.code, name: fee.name, feeType: fee.fee_type, net: amt, taxable: fee.taxable !== false, ...glFor(l, fee) });
  }
  if (Number(l.processing_fee) > 0) {
    push({ productFeeId: null, code: 'PROCESSING', name: 'Processing fee', feeType: 'DISBURSEMENT_UPFRONT',
      net: round2(l.processing_fee), taxable: true, ...glFor(l, null) });
  }
  const sum = (type) => round2(items.filter((x) => x.feeType === type).reduce((s, x) => s + x.amount, 0));
  return { items, deducted: sum('DISBURSEMENT_DEDUCTED'), capitalized: sum('DISBURSEMENT_CAPITALIZED'), upfront: sum('DISBURSEMENT_UPFRONT') };
}

/**
 * Record a fee on a loan. `settled` fees (deducted or capitalised at
 * disbursement) were paid the moment they existed and are booked in the
 * disbursement entry; everything else becomes due and, under accrual,
 * Dr Fee Receivable, Cr Fee Income.
 */
async function recordFee(c, l, { productFeeId = null, name, feeType, amount, valueDate, createdBy, settled = false,
  installmentId = null, glIncome, glReceivable, note = null, taxable = true }) {
  const net = round2(amount);
  if (!(net > 0)) return null;
  const date = valueDate ? ymd(valueDate) : today();
  const gl = { glIncome: glIncome || l.gl_fee_inc || l.gl_interest_inc, glReceivable: glReceivable || l.gl_fee_rec };
  // Tax on fees, where the product charges it: the member owes the gross.
  const tx = tax.split(l, 'FEE', net, { taxable });
  const amt = tx.gross;

  let entryId = null;
  if (!settled) {
    await c.query('UPDATE loan_accounts SET fees_due = fees_due + $1, tax_charged = tax_charged + $3, updated_at = now() WHERE id = $2', [amt, l.id, tx.tax]);
    if (ledger.isAccrual(l)) {
      entryId = await ledger.post(c, l, {
        debits: [{ glCode: gl.glReceivable, amount: amt, memberId: l.member_id }],
        credits: tax.incomeCredits(l, tx, gl.glIncome, l.member_id),
        narration: `${name} ${l.account_no}`,
        sourceType: 'LOAN_FEE', sourceId: l.id, bookingDate: date, createdBy,
      });
    }
    if (['IN_ARREARS', 'LOCKED'].includes(l.status)) {
      await c.query('UPDATE loan_accounts SET charges_since_arrears = charges_since_arrears + $1 WHERE id = $2', [amt, l.id]);
    }
  } else if (tx.tax > 0) {
    await c.query('UPDATE loan_accounts SET tax_charged = tax_charged + $2 WHERE id = $1', [l.id, tx.tax]);
  }
  const { rows: [row] } = await c.query(
    `INSERT INTO loan_fees (loan_id, product_fee_id, installment_id, name, fee_type, amount, paid, applied_on, entry_id, status, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12) RETURNING *`,
    [l.id, productFeeId, installmentId, name, feeType, amt, settled ? amt : 0, date, entryId,
      settled ? 'PAID' : 'DUE', note, createdBy || 'SYSTEM']
  );
  await savings.record(c, {
    reference: savings.ref('LF'), kind: 'LOAN_FEE', memberId: l.member_id, loanAccountId: l.id,
    amount: amt, valueDate: date, entryId,
    allocation: { fee: name, feeType, feeId: row.id, settled: settled ? 'AT_DISBURSEMENT' : null, ...(tx.tax > 0 ? { tax: tx.tax, net } : {}) },
    narration: note, createdBy,
  });
  return row;
}

/**
 * Upfront fees on a fixed-term loan fall due with the first installment;
 * on a dynamic loan they are due at once and sit outside the schedule.
 */
async function placeUpfrontFees(c, l, items) {
  const total = round2(items.reduce((s, x) => s + x.amount, 0));
  if (!(total > 0) || ledger.isDynamic(l)) return;
  const { rows: [first] } = await c.query(
    'SELECT id FROM loan_installments WHERE loan_id = $1 ORDER BY number LIMIT 1', [l.id]);
  if (!first) return;
  await c.query('UPDATE loan_installments SET fee_due = fee_due + $1 WHERE id = $2', [total, first.id]);
  await c.query(
    `UPDATE loan_fees SET installment_id = $1 WHERE loan_id = $2 AND fee_type = 'DISBURSEMENT_UPFRONT' AND installment_id IS NULL`,
    [first.id, l.id]);
}

/**
 * Apply the PAYMENT_DUE fees sitting on installments due by `asOf`. A
 * fixed-term loan applies the whole schedule's fees at disbursement (they
 * are fixed with it); a dynamic loan applies each installment's on its due
 * date, from the EOD job or when a repayment arrives.
 */
async function applyPaymentDueFees(c, l, asOf) {
  const { rows } = await c.query(
    `SELECT i.* FROM loan_installments i
     WHERE i.loan_id = $1 AND i.fee_due > 0 AND i.due_date <= $2::date
       AND NOT EXISTS (SELECT 1 FROM loan_fees f WHERE f.installment_id = i.id AND f.fee_type = 'PAYMENT_DUE')
     ORDER BY i.number`,
    [l.id, asOf]
  );
  const fees = await productFees(c, l.product_id, ['PAYMENT_DUE']);
  const gl = glFor(l, fees[0]);
  let applied = 0;
  for (const inst of rows) {
    // Whatever share of this installment's fee the upfront fee did not
    // already account for is the payment-due fee.
    const { rows: [u] } = await c.query(
      `SELECT COALESCE(SUM(amount),0) AS a FROM loan_fees WHERE installment_id = $1 AND fee_type <> 'PAYMENT_DUE'`, [inst.id]);
    const amt = round2(inst.fee_due - Number(u.a));
    if (!(amt > 0)) continue;
    await recordFee(c, l, {
      productFeeId: fees[0]?.id || null, name: fees[0]?.name || 'Payment due fee', feeType: 'PAYMENT_DUE',
      amount: amt, valueDate: ymd(inst.due_date) > asOf ? asOf : inst.due_date, installmentId: inst.id, ...gl, createdBy: 'SYSTEM',
    });
    applied += 1;
  }
  return applied;
}

/**
 * Late repayment fees: one per installment that has gone OVERDUE (which
 * already honours the arrears tolerance), never twice for the same one.
 */
async function applyLateFees(c, l, asOf) {
  const fees = await productFees(c, l.product_id, ['LATE_REPAYMENT']);
  if (!fees.length) return 0;
  const { rows } = await c.query(
    `SELECT i.* FROM loan_installments i
     WHERE i.loan_id = $1 AND i.status = 'OVERDUE' AND i.due_date <= $2::date
       AND NOT EXISTS (SELECT 1 FROM loan_fees f WHERE f.installment_id = i.id AND f.fee_type = 'LATE_REPAYMENT')
     ORDER BY i.number`,
    [l.id, asOf]
  );
  let applied = 0;
  for (const inst of rows) {
    for (const fee of fees) {
      const amt = feeAmount(fee, {
        principal: Number(l.principal), count: Number(l.term_months), installmentPrincipal: Number(inst.principal_due),
      });
      const allowed = await workflow.capAllows(c, l, amt);
      if (!(allowed > 0)) continue;
      await recordFee(c, l, {
        productFeeId: fee.id, name: fee.name, feeType: 'LATE_REPAYMENT', amount: allowed, valueDate: asOf,
        installmentId: inst.id, ...glFor(l, fee), createdBy: 'SYSTEM', taxable: fee.taxable !== false,
      });
      await c.query('UPDATE loan_installments SET fee_due = fee_due + $1 WHERE id = $2', [allowed, inst.id]);
      applied += 1;
    }
  }
  return applied;
}

/** A predefined MANUAL fee, applied by a user. */
async function applyManualFee(c, loanId, { fee: feeRef, amount = null, note, valueDate, createdBy }) {
  const l = await ledger.lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  const { rows: [fee] } = await c.query(
    `SELECT * FROM loan_product_fees WHERE product_id = $1 AND is_active AND fee_type = 'MANUAL' AND (code = $2 OR id::text = $2)`,
    [l.product_id, String(feeRef)]);
  if (!fee) throw err(`UNKNOWN_MANUAL_FEE: ${feeRef}`, 404);
  const amt = feeAmount(fee, { principal: Number(l.principal), entered: amount });
  const row = await recordFee(c, l, {
    productFeeId: fee.id, name: fee.name, feeType: 'MANUAL', amount: amt, valueDate, note, createdBy, ...glFor(l, fee), taxable: fee.taxable !== false,
  });
  return row;
}

/** A fee with any name and amount; only if the product allows it. */
async function applyArbitraryFee(c, loanId, { name, amount, note, valueDate, createdBy }) {
  const l = await ledger.lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  if (!l.allow_arbitrary_fees) throw err('PRODUCT_DOES_NOT_ALLOW_ARBITRARY_FEES', 409);
  if (!name || !(round2(amount) > 0)) throw err('FEE_NAME_AND_AMOUNT_REQUIRED', 400);
  return recordFee(c, l, { name: String(name), feeType: 'MANUAL', amount, valueDate, note, createdBy, ...glFor(l, null) });
}

/** Waive the unpaid part of a fee, reversing its posting. */
async function waive(c, feeId, { reason = '', createdBy } = {}) {
  const { rows: [f] } = await c.query('SELECT * FROM loan_fees WHERE id = $1 FOR UPDATE', [feeId]);
  if (!f) throw err('FEE_NOT_FOUND', 404);
  if (f.status !== 'DUE') throw err(`FEE_NOT_WAIVABLE: ${f.status}`, 409);
  const l = await ledger.lock(c, f.loan_id);
  const remaining = round2(f.amount - f.paid);
  if (!(remaining > 0)) throw err('FEE_ALREADY_PAID', 409);

  let entryId = null;
  if (f.entry_id && ledger.isAccrual(l)) {
    // The original entry may have been partly paid down; reverse only what
    // is still open, as its own entry, so both sides stay traceable. The
    // tax share, if any, comes back out of the payable.
    const sp = tax.splitPaid(l, 'FEE', remaining);
    entryId = await ledger.post(c, l, {
      debits: tax.incomeCredits(l, sp, l.gl_fee_inc || l.gl_interest_inc, l.member_id),
      credits: [{ glCode: l.gl_fee_rec, amount: remaining, memberId: l.member_id }],
      narration: `Fee waived ${l.account_no}: ${reason}`,
      sourceType: 'LOAN_FEE_WAIVED', sourceId: l.id, createdBy,
    });
  }
  await c.query(
    `UPDATE loan_fees SET status = 'WAIVED', waived_at = now(), waived_by = $1, note = COALESCE(note || ' | ', '') || $2 WHERE id = $3`,
    [createdBy || 'SYSTEM', `waived: ${reason}`, feeId]);
  await c.query('UPDATE loan_accounts SET fees_due = fees_due - $1, updated_at = now() WHERE id = $2', [remaining, l.id]);
  if (f.installment_id) {
    await c.query('UPDATE loan_installments SET fee_due = GREATEST(0, fee_due - $1) WHERE id = $2', [remaining, f.installment_id]);
  }
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'LOAN_FEE_WAIVED','loan_fee',$2,$3,$4)`,
    [createdBy || 'SYSTEM', feeId, JSON.stringify(f), JSON.stringify({ reason, remaining })]);
  return savings.record(c, {
    reference: savings.ref('LFW'), kind: 'LOAN_FEE_WAIVED', memberId: l.member_id, loanAccountId: l.id,
    amount: -remaining, entryId, allocation: { feeId, fee: f.name, reason }, createdBy,
  });
}

/** Allocate `amount` of paid fees to DUE fee rows, oldest first. */
async function settle(c, loanId, amount) {
  let left = round2(amount);
  if (!(left > 0)) return;
  const { rows } = await c.query(
    "SELECT * FROM loan_fees WHERE loan_id = $1 AND status = 'DUE' ORDER BY applied_on, created_at", [loanId]);
  for (const f of rows) {
    if (left <= 0) break;
    const take = round2(Math.min(left, f.amount - f.paid));
    if (!(take > 0)) continue;
    await c.query(
      `UPDATE loan_fees SET paid = paid + $1, status = CASE WHEN paid + $1 >= amount THEN 'PAID' ELSE 'DUE' END WHERE id = $2`,
      [take, f.id]);
    left = round2(left - take);
  }
}

/** After a reversal: forget who paid what and reallocate the surviving total. */
async function resettle(c, loanId, totalPaid) {
  await c.query(
    "UPDATE loan_fees SET paid = 0, status = 'DUE' WHERE loan_id = $1 AND status IN ('DUE', 'PAID') AND fee_type <> 'DISBURSEMENT_DEDUCTED' AND fee_type <> 'DISBURSEMENT_CAPITALIZED'",
    [loanId]);
  await settle(c, loanId, totalPaid);
}

/** Undoing a disbursement removes the fees it created and their postings. */
async function undoDisbursementFees(c, loanId, { createdBy } = {}) {
  const { rows } = await c.query('SELECT * FROM loan_fees WHERE loan_id = $1', [loanId]);
  for (const f of rows) {
    if (f.entry_id) await acct.reverse(c, f.entry_id, 'Disbursement undone', createdBy);
  }
  await c.query('DELETE FROM loan_fees WHERE loan_id = $1', [loanId]);
  await c.query('UPDATE loan_accounts SET fees_due = 0, fees_paid = 0 WHERE id = $1', [loanId]);
}

async function forLoan(c, loanId) {
  const { rows } = await c.query(
    `SELECT f.*, i.number AS installment_number FROM loan_fees f
     JOIN loan_accounts l ON l.id = f.loan_id
     LEFT JOIN loan_installments i ON i.id = f.installment_id
     WHERE l.id::text = $1 OR l.account_no = $1 ORDER BY f.applied_on, f.created_at`, [loanId]);
  return rows;
}

module.exports = {
  productFees, feeAmount, scheduledFees, disbursementFees, recordFee, placeUpfrontFees,
  applyPaymentDueFees, applyLateFees, applyManualFee, applyArbitraryFee, waive, settle, resettle,
  undoDisbursementFees, forLoan,
};
