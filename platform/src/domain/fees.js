'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const tax = require('./tax');
const ledger = require('./ledger');
const workflow = require('./workflow');
const types = require('./productTypes');
const FA = require('./feeAmortization');
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
 *
 * Where a manual fee goes (Mambu's schedule allocation): on the next
 * installment not yet due (NEXT_INSTALLMENT, the default; failing that the
 * last unpaid one), so it falls due and is paid with it, or into a balance
 * of its own outside the schedule (NO_ALLOCATION, Mambu's non-scheduled
 * fees: ns_fees_due), which counts in the loan's total, never falls due and
 * is paid only by a custom repayment. A fee whose income is amortised is
 * credited to deferred fee income (./feeAmortization).
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

/**
 * What a "% of disbursement amount" fee is a percentage of once the loan is
 * disbursed: the amount disbursed plus any capitalised disbursement fees
 * (Mambu's examples: 1,000 less a deducted 100 is still 1,000; 1,000 plus a
 * capitalised 100 is 1,100). Before disbursement, the approved amount.
 */
async function percentBase(c, l) {
  if (!(Number(l.principal_disbursed) > 0)) return Number(l.principal);
  const { rows: [r] } = await c.query(
    "SELECT COALESCE(sum(amount), 0) AS a FROM loan_fees WHERE loan_id = $1 AND fee_type = 'DISBURSEMENT_CAPITALIZED' AND status <> 'WAIVED'", [l.id]);
  return round2(Number(l.principal_disbursed) + Number(r.a));
}

/**
 * The installment a fee applied on `date` goes on: the next one not yet
 * paid, not in grace or a payment holiday, due on or after the date; if
 * every one of those has passed, the last one still unpaid.
 */
async function nextInstallment(c, loanId, date) {
  const { rows: [n] } = await c.query(
    `SELECT id FROM loan_installments WHERE loan_id = $1 AND status NOT IN ('PAID', 'GRACE') AND NOT payment_holiday
       AND due_date >= $2::date ORDER BY number LIMIT 1`, [loanId, date]);
  if (n) return n.id;
  const { rows: [o] } = await c.query(
    `SELECT id FROM loan_installments WHERE loan_id = $1 AND status NOT IN ('PAID', 'GRACE') ORDER BY number DESC LIMIT 1`, [loanId]);
  return o ? o.id : null;
}

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
async function disbursementFees(c, l, { amount, selected = [], later = false }) {
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
    // On a later tranche a required fee becomes optional (Mambu: they are
    // meant to be charged once in the loan's life): only a fee chosen for
    // this disbursement applies.
    if (later ? !(selected || []).some((s) => s === fee.code || s === fee.id) : !chosen(fee, selected)) continue;
    const amt = feeAmount(fee, { principal: amount, count: Number(l.term_months) });
    if (!(amt > 0)) continue;
    const deferring = FA.amortized(fee) && ledger.isAccrual(l);
    push({ productFeeId: fee.id, code: fee.code, name: fee.name, feeType: fee.fee_type, net: amt, taxable: fee.taxable !== false, ...glFor(l, fee),
      amortize: deferring ? fee : null, ...(deferring ? { glIncome: FA.deferredGl(l, fee) } : {}) });
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
  installmentId = null, glIncome, glReceivable, note = null, taxable = true, allocation = null, amortize = null, booked = true }) {
  const net = round2(amount);
  if (!(net > 0)) return null;
  const date = valueDate ? ymd(valueDate) : today();
  const gl = { glIncome: glIncome || l.gl_fee_inc || l.gl_interest_inc, glReceivable: glReceivable || l.gl_fee_rec };
  const nonScheduled = allocation === 'NO_ALLOCATION';
  // Tax on fees, where the product charges it: the member owes the gross.
  const tx = tax.split(l, 'FEE', net, { taxable });
  const amt = tx.gross;
  // An amortised fee's income waits in deferred fee income (accrual only).
  const deferring = FA.amortized(amortize) && ledger.isAccrual(l) && !nonScheduled;
  const glDeferred = deferring ? FA.deferredGl(l, amortize) : null;

  let entryId = null;
  if (!settled) {
    const balance = nonScheduled ? 'ns_fees_due' : 'fees_due';
    await c.query(`UPDATE loan_accounts SET ${balance} = ${balance} + $1, tax_charged = tax_charged + $3, updated_at = now() WHERE id = $2`, [amt, l.id, tx.tax]);
    // A fee moved from another loan (`booked` false) was recognised there;
    // the caller moves its receivable.
    if (ledger.isAccrual(l) && booked) {
      entryId = await ledger.post(c, l, {
        debits: [{ glCode: gl.glReceivable, amount: amt, memberId: l.member_id }],
        credits: tax.incomeCredits(l, tx, deferring ? glDeferred : gl.glIncome, l.member_id),
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
  let placeOn = installmentId;
  if (!placeOn && !settled && !nonScheduled && allocation === 'NEXT_INSTALLMENT') {
    placeOn = await nextInstallment(c, l.id, date);
    if (placeOn) await c.query('UPDATE loan_installments SET fee_due = fee_due + $1 WHERE id = $2', [amt, placeOn]);
  }
  const { rows: [row] } = await c.query(
    `INSERT INTO loan_fees (loan_id, product_fee_id, installment_id, name, fee_type, amount, paid, applied_on, entry_id, status, note, created_by,
       non_scheduled, deferred, gl_deferred)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [l.id, productFeeId, placeOn, name, feeType, amt, settled ? amt : 0, date, entryId,
      settled ? 'PAID' : 'DUE', note, createdBy || 'SYSTEM', nonScheduled, deferring ? tx.income : 0, glDeferred]
  );
  // Disbursement fees are planned once the schedule is drawn (planPending).
  if (deferring && !String(feeType).startsWith('DISBURSEMENT_')) await FA.plan(c, l, row, amortize, { from: date, createdBy });
  await savings.record(c, {
    reference: savings.ref('LF'), kind: 'LOAN_FEE', memberId: l.member_id, loanAccountId: l.id,
    amount: amt, valueDate: date, entryId,
    allocation: {
      fee: name, feeType, feeId: row.id, settled: settled ? 'AT_DISBURSEMENT' : null, ...(tx.tax > 0 ? { tax: tx.tax, net } : {}),
      ...(nonScheduled ? { nonScheduled: true } : {}), ...(deferring ? { deferred: tx.income } : {}),
    },
    narration: note, createdBy,
  });
  return row;
}

/** Plan the amortisation of disbursement fees once the schedule exists. */
async function planPending(c, l, { date, createdBy } = {}) {
  const { rows } = await c.query(
    `SELECT f.* FROM loan_fees f WHERE f.loan_id = $1 AND f.deferred > 0
       AND NOT EXISTS (SELECT 1 FROM loan_fee_amortization a WHERE a.loan_fee_id = f.id)`, [l.id]);
  for (const f of rows) {
    const fee = await FA.settingsOf(c, f.product_fee_id);
    if (FA.amortized(fee)) await FA.plan(c, l, f, fee, { from: date || f.applied_on, createdBy });
  }
}

/**
 * Upfront fees on a fixed-term loan fall due with the first installment;
 * on a dynamic loan they are due at once and sit outside the schedule.
 */
async function placeUpfrontFees(c, l, items) {
  const total = round2(items.reduce((s, x) => s + x.amount, 0));
  if (!(total > 0) || !types.forLoan(l).upfrontFeesOnSchedule) return;
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
  const base = await percentBase(c, l);
  for (const inst of rows) {
    for (const fee of fees) {
      const amt = feeAmount(fee, {
        principal: base, count: Number(l.term_months), installmentPrincipal: Number(inst.principal_due),
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

const ALLOCATIONS = ['NEXT_INSTALLMENT', 'NO_ALLOCATION'];
function allocationFor(given, fallback) {
  if (given === undefined || given === null) return fallback || 'NEXT_INSTALLMENT';
  if (!ALLOCATIONS.includes(given)) throw err(`ALLOCATION_IS_ONE_OF: ${ALLOCATIONS.join(', ')}`, 400);
  return given;
}

// A fee may be applied by hand to a loan in any running state, locked
// included (Mambu: any state but closed; before disbursement the product's
// disbursement fees are the ones that apply).
const FEE_STATES = ['ACTIVE', 'IN_ARREARS', 'LOCKED'];

/**
 * Where and when a fee applied by hand lands. A back date is allowed as far
 * as the last repayment (Mambu: no repayment entered after the date), never
 * a future one. `installmentNumber` puts it on that installment (Mambu's
 * fixed-term option, open to any loan with a schedule), which must not be
 * paid; otherwise the allocation decides.
 */
async function placement(c, l, { valueDate, installmentNumber, allocation }) {
  const date = valueDate ? ymd(valueDate) : today();
  if (date > today()) throw err('A_FEE_CANNOT_BE_DATED_IN_THE_FUTURE', 400);
  if (valueDate && date < today()) {
    if (l.disbursed_on && date < ymd(l.disbursed_on)) throw err(`FEE_BEFORE_DISBURSEMENT: ${ymd(l.disbursed_on)}`, 400);
    const { rows: [later] } = await c.query(
      `SELECT reference, value_date FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT' AND reversed_by IS NULL
         AND value_date > $2::date LIMIT 1`, [l.id, date]);
    if (later) throw err(`FEE_BEFORE_A_LATER_REPAYMENT: ${later.reference} is dated ${ymd(later.value_date)}`, 409);
  }
  if (installmentNumber === undefined || installmentNumber === null || installmentNumber === '') return { date, installmentId: null };
  if (allocation === 'NO_ALLOCATION') throw err('A_FEE_ON_AN_INSTALLMENT_IS_ON_THE_SCHEDULE: drop NO_ALLOCATION', 400);
  const { rows: [i] } = await c.query('SELECT id, status FROM loan_installments WHERE loan_id = $1 AND number = $2', [l.id, Number(installmentNumber)]);
  if (!i) throw err(`NO_INSTALLMENT_${installmentNumber}`, 404);
  if (i.status === 'PAID') throw err(`INSTALLMENT_${installmentNumber}_IS_PAID`, 409);
  return { date, installmentId: i.id };
}

async function placeOnInstallment(c, row, installmentId) {
  if (!row || !installmentId) return row;
  await c.query('UPDATE loan_installments SET fee_due = fee_due + $1, status = CASE WHEN status = \'GRACE\' THEN \'PENDING\' ELSE status END WHERE id = $2', [row.amount, installmentId]);
  return row;
}

/**
 * A predefined MANUAL fee, applied by a user. `allocation` chooses, for
 * this application, the schedule (NEXT_INSTALLMENT) or none (NO_ALLOCATION);
 * the fee's own setting otherwise.
 */
async function applyManualFee(c, loanId, { fee: feeRef, amount = null, note, valueDate, createdBy, allocation, installmentNumber = null }) {
  const l = await ledger.lock(c, loanId);
  if (!FEE_STATES.includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  const { rows: [fee] } = await c.query(
    `SELECT * FROM loan_product_fees WHERE product_id = $1 AND is_active AND fee_type = 'MANUAL' AND (code = $2 OR id::text = $2)`,
    [l.product_id, String(feeRef)]);
  if (!fee) throw err(`UNKNOWN_MANUAL_FEE: ${feeRef}`, 404);
  const where = await placement(c, l, { valueDate, installmentNumber, allocation });
  const amt = feeAmount(fee, { principal: await percentBase(c, l), entered: amount });
  const row = await recordFee(c, l, {
    productFeeId: fee.id, name: fee.name, feeType: 'MANUAL', amount: amt, valueDate: where.date, note, createdBy, ...glFor(l, fee), taxable: fee.taxable !== false,
    allocation: allocationFor(allocation, fee.allocation), amortize: fee, installmentId: where.installmentId,
  });
  return placeOnInstallment(c, row, where.installmentId);
}

/** A fee with any name and amount; only if the product allows it. */
async function applyArbitraryFee(c, loanId, { name, amount, note, valueDate, createdBy, allocation, installmentNumber = null }) {
  const l = await ledger.lock(c, loanId);
  if (!FEE_STATES.includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  if (!l.allow_arbitrary_fees) throw err('PRODUCT_DOES_NOT_ALLOW_ARBITRARY_FEES', 409);
  if (!name || !(round2(amount) > 0)) throw err('FEE_NAME_AND_AMOUNT_REQUIRED', 400);
  const where = await placement(c, l, { valueDate, installmentNumber, allocation });
  const row = await recordFee(c, l, { name: String(name), feeType: 'MANUAL', amount, valueDate: where.date, note, createdBy, ...glFor(l, null),
    allocation: allocationFor(allocation, 'NEXT_INSTALLMENT'), installmentId: where.installmentId });
  return placeOnInstallment(c, row, where.installmentId);
}

/**
 * Adjust a fee (Mambu's Adjust on a Fee Applied transaction): taken back as
 * if it had never been applied, for a fee applied by mistake or with the
 * wrong amount. Only a fee nothing has been paid on; its own entry is
 * reversed (an amortised fee's recognised income first goes back to
 * deferred), the balance and the installment come down, and the fee's
 * transaction is marked reversed. To remove what is left of a fee partly
 * paid, waive it or reduce the balance.
 */
async function adjust(c, feeId, { reason = '', createdBy } = {}) {
  const { rows: [f] } = await c.query('SELECT * FROM loan_fees WHERE id = $1 FOR UPDATE', [feeId]);
  if (!f) throw err('FEE_NOT_FOUND', 404);
  if (f.status !== 'DUE') throw err(`FEE_NOT_ADJUSTABLE: ${f.status}`, 409);
  if (Number(f.paid) > 0) throw err('FEE_PARTLY_PAID: waive it or reduce the balance instead', 409);
  if (String(f.fee_type).startsWith('DISBURSEMENT_')) throw err('A_DISBURSEMENT_FEE_IS_UNDONE_WITH_THE_DISBURSEMENT', 409);
  const l = await ledger.lock(c, f.loan_id);
  if (Number(f.deferred) > 0) await FA.cancel(c, f.id, { createdBy, narration: 'Fee adjusted' });
  const entry = f.entry_id ? await acct.reverse(c, f.entry_id, `Fee adjusted: ${reason}`, createdBy) : { entryId: null };
  const { rows: [orig] } = await c.query(
    "SELECT * FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_FEE' AND allocation->>'feeId' = $2 AND reversed_by IS NULL LIMIT 1",
    [l.id, f.id]);
  const taxed = Number(orig?.allocation?.tax || 0);
  const amt = round2(f.amount);
  const balance = f.non_scheduled ? 'ns_fees_due' : 'fees_due';
  await c.query(
    `UPDATE loan_accounts SET ${balance} = ${balance} - $1, tax_charged = tax_charged - $3,
       charges_since_arrears = GREATEST(0, charges_since_arrears - CASE WHEN status IN ('IN_ARREARS', 'LOCKED') THEN $1 ELSE 0 END),
       updated_at = now() WHERE id = $2`, [amt, l.id, taxed]);
  if (f.installment_id) await c.query('UPDATE loan_installments SET fee_due = GREATEST(fee_paid, fee_due - $1) WHERE id = $2', [amt, f.installment_id]);
  await c.query(
    `UPDATE loan_fees SET status = 'ADJUSTED', waived_at = now(), waived_by = $1, note = COALESCE(note || ' | ', '') || $2 WHERE id = $3`,
    [createdBy || 'SYSTEM', `adjusted: ${reason}`, f.id]);
  const tx = await savings.record(c, {
    reference: savings.ref('LFA'), kind: 'LOAN_FEE_ADJUSTED', memberId: l.member_id, loanAccountId: l.id,
    amount: -amt, entryId: entry.entryId, allocation: { feeId: f.id, fee: f.name, reason, reversalOf: orig?.reference || null }, narration: reason, createdBy,
  });
  if (orig) await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [tx.id, orig.id]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'LOAN_FEE_ADJUSTED','loan_fee',$2,$3,$4)`,
    [createdBy || 'SYSTEM', f.id, JSON.stringify(f), JSON.stringify({ reason })]);
  return tx;
}

/** Waive the unpaid part of a fee, reversing its posting. */
async function waive(c, feeId, { reason = '', createdBy } = {}) {
  const { rows: [f] } = await c.query('SELECT * FROM loan_fees WHERE id = $1 FOR UPDATE', [feeId]);
  if (!f) throw err('FEE_NOT_FOUND', 404);
  if (f.status !== 'DUE') throw err(`FEE_NOT_WAIVABLE: ${f.status}`, 409);
  const l = await ledger.lock(c, f.loan_id);
  const remaining = round2(f.amount - f.paid);
  if (!(remaining > 0)) throw err('FEE_ALREADY_PAID', 409);

  const { rows: [pf] } = f.product_fee_id
    ? await c.query('SELECT * FROM loan_product_fees WHERE id = $1', [f.product_fee_id]) : { rows: [null] };
  const g = glFor(l, pf);

  let entryId = null;
  if (f.entry_id && ledger.isAccrual(l)) {
    // An amortised fee: what was recognised goes back to deferred fee
    // income first; the part already paid is then recognised for good, and
    // the unpaid part comes off deferred income with the waiver.
    const deferred = Number(f.deferred) > 0;
    if (deferred) {
      await FA.cancel(c, f.id, { createdBy, narration: 'Fee waived' });
      const paidIncome = round2(Number(f.deferred) * Number(f.paid) / Number(f.amount));
      if (paidIncome > 0) {
        await ledger.post(c, l, {
          debits: [{ glCode: f.gl_deferred, amount: paidIncome, memberId: l.member_id }],
          credits: [{ glCode: g.glIncome, amount: paidIncome, memberId: l.member_id }],
          narration: `Fee income on the part paid before the waiver ${l.account_no}`,
          sourceType: 'LOAN_FEE_AMORTIZATION', sourceId: l.id, createdBy,
        });
      }
    }
    // The original entry may have been partly paid down; reverse only what
    // is still open, as its own entry, so both sides stay traceable. The
    // tax share, if any, comes back out of the payable.
    const sp = tax.splitPaid(l, 'FEE', remaining, { taxable: pf ? pf.taxable !== false : true });
    entryId = await ledger.post(c, l, {
      debits: tax.incomeCredits(l, sp, deferred ? f.gl_deferred : g.glIncome, l.member_id),
      credits: [{ glCode: g.glReceivable, amount: remaining, memberId: l.member_id }],
      narration: `Fee waived ${l.account_no}: ${reason}`,
      sourceType: 'LOAN_FEE_WAIVED', sourceId: l.id, createdBy,
    });
  }
  await c.query(
    `UPDATE loan_fees SET status = 'WAIVED', waived_at = now(), waived_by = $1, note = COALESCE(note || ' | ', '') || $2 WHERE id = $3`,
    [createdBy || 'SYSTEM', `waived: ${reason}`, feeId]);
  const balance = f.non_scheduled ? 'ns_fees_due' : 'fees_due';
  await c.query(`UPDATE loan_accounts SET ${balance} = ${balance} - $1, updated_at = now() WHERE id = $2`, [remaining, l.id]);
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

/**
 * Allocate `amount` of paid fees to DUE fee rows, oldest first: the
 * scheduled fees, or with `nonScheduled` the fees kept off the schedule.
 */
async function settle(c, loanId, amount, { nonScheduled = false } = {}) {
  let left = round2(amount);
  if (!(left > 0)) return;
  const { rows } = await c.query(
    "SELECT * FROM loan_fees WHERE loan_id = $1 AND status = 'DUE' AND non_scheduled = $2 ORDER BY applied_on, created_at", [loanId, nonScheduled]);
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

/**
 * Outstanding fees in the order settle() pays them, with each fee's own GL
 * accounts: the scheduled ones, the non-scheduled ones (`nonScheduled`
 * true), or all of them (`nonScheduled` null).
 */
async function outstanding(c, l, { nonScheduled = false } = {}) {
  const { rows } = await c.query(
    `SELECT f.*, pf.gl_income, pf.gl_receivable, pf.gl_writeoff, COALESCE(pf.taxable, true) AS taxable
     FROM loan_fees f LEFT JOIN loan_product_fees pf ON pf.id = f.product_fee_id
     WHERE f.loan_id = $1 AND f.status = 'DUE' AND ($2::boolean IS NULL OR f.non_scheduled = $2)
     ORDER BY f.non_scheduled, f.applied_on, f.created_at`, [l.id, nonScheduled]);
  return rows;
}

/**
 * The credit lines for `amount` paid towards fees: under accrual each fee's
 * receivable, under cash each fee's income (and tax payable where the fee is
 * taxed). Anything not matched to a fee row goes to the product's accounts.
 */
async function settlementCredits(c, l, amount, { nonScheduled = false } = {}) {
  let left = round2(amount);
  if (!(left > 0)) return [];
  const out = [];
  for (const f of await outstanding(c, l, { nonScheduled })) {
    if (left <= 0) break;
    const take = round2(Math.min(left, f.amount - f.paid));
    if (!(take > 0)) continue;
    left = round2(left - take);
    if (ledger.isAccrual(l)) {
      out.push({ glCode: f.gl_receivable || l.gl_fee_rec, amount: take, memberId: l.member_id });
    } else {
      const sp = tax.splitPaid(l, 'FEE', take, { taxable: f.taxable });
      out.push(...tax.incomeCredits(l, sp, f.gl_income || l.gl_fee_inc || l.gl_interest_inc, l.member_id));
    }
  }
  if (left > 0) out.push(...ledger.creditsFor(l, 'FEE', left, l.member_id));
  return out;
}

/** What writing off `total` of fees clears, fee by fee (scheduled and not): its receivable and its write-off account. */
async function writeOffLines(c, l, total) {
  let left = round2(total);
  if (!(left > 0)) return [];
  const out = [];
  for (const f of await outstanding(c, l, { nonScheduled: null })) {
    if (left <= 0) break;
    const take = round2(Math.min(left, f.amount - f.paid));
    if (!(take > 0)) continue;
    left = round2(left - take);
    out.push({ amount: take, glReceivable: f.gl_receivable || l.gl_fee_rec, glWriteOff: f.gl_writeoff || l.gl_writeoff_exp });
  }
  if (left > 0) out.push({ amount: left, glReceivable: l.gl_fee_rec, glWriteOff: l.gl_writeoff_exp });
  return out;
}

/** After a reversal: forget who paid what and reallocate the surviving total. */
async function resettle(c, loanId, totalPaid, { nonScheduled = false } = {}) {
  await c.query(
    `UPDATE loan_fees SET paid = 0, status = 'DUE' WHERE loan_id = $1 AND status IN ('DUE', 'PAID') AND non_scheduled = $2
       AND fee_type <> 'DISBURSEMENT_DEDUCTED' AND fee_type <> 'DISBURSEMENT_CAPITALIZED'`,
    [loanId, nonScheduled]);
  await settle(c, loanId, totalPaid, { nonScheduled });
}

/** Undoing a disbursement removes the fees it created and their postings. */
async function undoDisbursementFees(c, loanId, { createdBy } = {}) {
  const { rows } = await c.query('SELECT * FROM loan_fees WHERE loan_id = $1', [loanId]);
  for (const f of rows) {
    // Income already recognised from deferred fee income goes back first.
    if (Number(f.deferred) > 0) await FA.cancel(c, f.id, { createdBy, narration: 'Disbursement undone' });
    if (f.entry_id) await acct.reverse(c, f.entry_id, 'Disbursement undone', createdBy);
  }
  await c.query("UPDATE loan_planned_fees SET status = 'PLANNED', loan_fee_id = NULL, reason = NULL WHERE loan_id = $1 AND status IN ('APPLIED', 'SKIPPED')", [loanId]);
  await c.query('DELETE FROM loan_fees WHERE loan_id = $1', [loanId]);
  await c.query('UPDATE loan_accounts SET fees_due = 0, fees_paid = 0, ns_fees_due = 0, ns_fees_paid = 0 WHERE id = $1', [loanId]);
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
  settlementCredits, writeOffLines, outstanding, percentBase, nextInstallment, planPending, glFor,
  productFees, feeAmount, scheduledFees, disbursementFees, recordFee, placeUpfrontFees,
  applyPaymentDueFees, applyLateFees, applyManualFee, applyArbitraryFee, waive, adjust, settle, resettle,
  undoDisbursementFees, forLoan,
};
