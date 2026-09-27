'use strict';

const L = require('./loans');
const SV = require('./savings');
const workflow = require('./workflow');
const { scheduledInterestThrough } = require('./productTypes/fixedTerm');

/**
 * A loan brought across from another system, as the Excel import's Loan
 * Accounts, Loan Schedule and Loan Transactions sheets describe it and as
 * The reference platform's external migration API (POST /loans/migrate) sends it. One
 * builder serves both, so a loan migrated either way is the same loan.
 *
 * What it does, in order:
 *
 *  - Opens the application under the product (its bands, custom fields and
 *    exposure rules apply), then puts it in the state it had: pending
 *    approval, approved, withdrawn, rejected, active, closed (repaid) or
 *    written off.
 *  - For a disbursed loan, draws the schedule: the one given, or the
 *    product's from the disbursement date (a dynamic-term loan always takes
 *    the product's, as in the reference platform, because its schedule is worked out again on
 *    every prepayment).
 *  - Marks what was paid: from the schedule given; or by replaying the
 *    loan's transactions (disbursement, repayments, fees, penalties) against
 *    the schedule in date order; or, with only balances, by applying the
 *    principal repaid to the oldest installments first, leaving exactly the
 *    principal in arrears unpaid where that is given.
 *  - Sets the balances, marks arrears on the product's rules as at the
 *    migration date, and exempts installments already late at that date
 *    from the late fee, with their penalty counting from then.
 *
 * Nothing is posted to the general ledger: the import's opening trial
 * balance carries the money (the reference platform: no accounting is logged for imported
 * transactions). Transactions replayed are recorded in the loan's history
 * with no journal entry.
 */

const err = (m, status = 400) => Object.assign(new Error(m), { status });
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sum = (list, f) => round2(list.reduce((t, x) => t + Number(f(x) || 0), 0));

const STATES = {
  ACTIVE: 'ACTIVE', PENDING_APPROVAL: 'PENDING_APPROVAL', APPROVED: 'APPROVED',
  CLOSED: 'CLOSED_REPAID', WITHDRAWN: 'CLOSED_WITHDRAWN', REJECTED: 'CLOSED_REJECTED', WRITTEN_OFF: 'CLOSED_WRITTEN_OFF',
};
const DISBURSED = ['ACTIVE', 'CLOSED', 'WRITTEN_OFF'];
const UNITS = { D: 'DAYS', W: 'WEEKS', M: 'MONTHS', Y: 'MONTHS', DAYS: 'DAYS', WEEKS: 'WEEKS', MONTHS: 'MONTHS', YEARS: 'MONTHS' };
const TX_TYPES = ['DISBURSEMENT', 'REPAYMENT', 'FEE', 'PENALTY'];

/** The state a sheet or a request names, in the form this builder uses. */
function normState(v) {
  if (v === null || v === undefined || v === '') return 'ACTIVE';
  const s = String(v).trim().toUpperCase().replace(/[\s-]+/g, '_');
  const alias = { IN_ARREARS: 'ACTIVE', CLOSED_REPAID: 'CLOSED', REPAID: 'CLOSED', PAID_OFF: 'CLOSED', PENDING: 'PENDING_APPROVAL',
    CLOSED_WRITTEN_OFF: 'WRITTEN_OFF', WRITTENOFF: 'WRITTEN_OFF', CLOSED_WITHDRAWN: 'WITHDRAWN', CLOSED_REJECTED: 'REJECTED' };
  const out = alias[s] || s;
  if (!STATES[out]) throw err(`Account state must be one of Active, Pending Approval, Approved, Closed, Withdrawn, Rejected, Written Off`);
  return out;
}

/**
 * Check a loan on its own, before the database: what a sheet row or a
 * request must say for its state. Returns a list of messages (empty when
 * the loan is consistent).
 */
function check(spec, { asOf }) {
  const out = [];
  const state = spec.state;
  const txs = spec.transactions || [];
  if (DISBURSED.includes(state)) {
    if (!txs.length && !spec.disbursedOn) out.push({ field: 'disbursedOn', message: 'A disbursed loan needs its disbursement date (or a DISBURSEMENT transaction)' });
    const needsSchedule = !(spec.schedule && spec.schedule.length);
    if (!txs.length && needsSchedule && ['ACTIVE', 'WRITTEN_OFF'].includes(state) && (spec.principalOutstanding === null || spec.principalOutstanding === undefined)) {
      out.push({ field: 'principalOutstanding', message: `A loan in state ${state} needs its principal outstanding` });
    }
  } else {
    if (txs.length) out.push({ field: 'state', message: `A loan in state ${state} has no transactions` });
    if (spec.schedule && spec.schedule.length) out.push({ field: 'state', message: `A loan in state ${state} has no schedule` });
  }
  if (state === 'CLOSED' && !txs.length) {
    const owed = ['principalOutstanding', 'interestOutstanding', 'feesOutstanding', 'penaltyOutstanding'].some((k) => Number(spec[k] || 0) > 0);
    if (owed) out.push({ field: 'principalOutstanding', message: 'A closed loan owes nothing; import it as Active or Written Off' });
  }
  if (['CLOSED', 'WRITTEN_OFF', 'WITHDRAWN', 'REJECTED'].includes(state) && spec.closedOn && asOf && spec.closedOn > asOf) {
    out.push({ field: 'closedOn', message: `Closed on ${spec.closedOn} is after the migration date ${asOf}` });
  }
  if (spec.principalInterval !== null && spec.principalInterval !== undefined && Number(spec.principalInterval) !== 1) {
    out.push({ field: 'principalInterval', message: 'Principal paid less often than every installment is not supported; use 1' });
  }
  for (const [a, b, label] of [['appliedOn', 'approvedOn', 'Date applied is after the date approved'], ['approvedOn', 'disbursedOn', 'Date approved is after the date disbursed']]) {
    if (spec[a] && spec[b] && spec[a] > spec[b]) out.push({ field: a, message: label });
  }
  if (spec.firstRepaymentDate && spec.disbursedOn && spec.firstRepaymentDate <= spec.disbursedOn) {
    out.push({ field: 'firstRepaymentDate', message: 'The repayment start date must be after the disbursement date' });
  }
  if (txs.length) {
    if (txs[0].type !== 'DISBURSEMENT') out.push({ field: 'transactions', message: 'A loan\'s transactions start with its DISBURSEMENT' });
    if (txs.filter((t) => t.type === 'DISBURSEMENT').length > 1) out.push({ field: 'transactions', message: 'A loan has one DISBURSEMENT' });
    for (let i = 1; i < txs.length; i += 1) {
      if (txs[i].date < txs[i - 1].date) { out.push({ field: 'transactions', message: `Transactions must be in date order: ${txs[i].date} comes after ${txs[i - 1].date}` }); break; }
    }
    for (const t of txs) {
      if (!TX_TYPES.includes(t.type)) out.push({ field: 'transactions', message: `Transaction type ${t.type} is not one of ${TX_TYPES.join(', ')}` });
      if (asOf && t.date > asOf) out.push({ field: 'transactions', message: `A transaction on ${t.date} is after the migration date ${asOf}` });
      if (!(Number(t.amount) > 0)) out.push({ field: 'transactions', message: 'A transaction amount must be more than zero' });
    }
  }
  if (spec.principalInArrears !== null && spec.principalInArrears !== undefined
    && Number(spec.principalInArrears) > Number(spec.principalOutstanding || 0)) {
    out.push({ field: 'principalInArrears', message: 'Principal in arrears is more than the principal outstanding' });
  }
  return out;
}

async function historyRow(c, loanId, from, to, actor, note) {
  await workflow.history(c, loanId, { from, to, action: 'IMPORT', actor, note });
}

/** The installments a loan has, in order. */
const installmentsOf = async (c, loanId) => (await c.query(
  'SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [loanId])).rows;

async function saveInstallment(c, i) {
  await c.query(
    `UPDATE loan_installments SET principal_paid = $2, interest_paid = $3, fee_paid = $4, fee_due = $5 WHERE id = $1`,
    [i.id, round2(i.principal_paid), round2(i.interest_paid), round2(i.fee_paid), round2(i.fee_due)]);
}

async function setStatuses(c, loanId) {
  await c.query(
    `UPDATE loan_installments SET status = CASE
        WHEN principal_paid >= principal_due AND interest_paid >= interest_due AND fee_paid >= fee_due THEN 'PAID'
        WHEN principal_paid + interest_paid + fee_paid > 0 THEN 'PARTIALLY_PAID'
        WHEN status = 'GRACE' THEN 'GRACE'
        ELSE 'PENDING' END
     WHERE loan_id = $1`, [loanId]);
}

/**
 * Principal repaid without a schedule saying where: the oldest installments
 * first. Where the principal in arrears is given, exactly that much stays
 * unpaid on the installments already due (the latest of them), and the rest
 * of what is owed on the latest installments not yet due; everything before
 * is paid.
 */
function allocatePrincipal(insts, { principal, outstanding, inArrears = null, asOf }) {
  const out = insts.map((i) => ({ ...i, principal_paid: Number(i.principal_due) }));
  const due = out.filter((i) => i.due_date < asOf);
  const future = out.filter((i) => i.due_date >= asOf);
  let unpaidDue;
  let unpaidFuture;
  if (inArrears === null || inArrears === undefined) {
    // Oldest first: whatever is owed sits on the latest installments.
    const futurePrincipal = sum(future, (i) => i.principal_due);
    unpaidFuture = Math.min(outstanding, futurePrincipal);
    unpaidDue = round2(outstanding - unpaidFuture);
  } else {
    unpaidDue = round2(inArrears);
    unpaidFuture = round2(outstanding - unpaidDue);
  }
  if (unpaidDue > sum(due, (i) => i.principal_due) + 0.001) throw err(`Principal in arrears ${unpaidDue} is more than the principal due by the migration date`);
  if (unpaidFuture > sum(future, (i) => i.principal_due) + 0.001) {
    throw err(`The principal outstanding leaves ${unpaidFuture} on installments not yet due, which carry only ${sum(future, (i) => i.principal_due)}`);
  }
  const leave = (list, amount) => {
    let left = amount;
    for (const i of [...list].reverse()) {
      if (!(left > 0)) break;
      const take = round2(Math.min(left, Number(i.principal_due)));
      i.principal_paid = round2(Number(i.principal_due) - take);
      left = round2(left - take);
    }
  };
  leave(due, unpaidDue);
  leave(future, unpaidFuture);
  if (round2(sum(out, (i) => i.principal_due) - sum(out, (i) => i.principal_paid)) !== round2(outstanding)) {
    throw err('The principal outstanding does not fit the schedule');
  }
  void principal;
  return out;
}

/**
 * Fees on the schedule that were due by the migration date (or were paid
 * already) are recorded as applied, with what was paid on them, so the end
 * of day does not charge them again as payment-due fees. Fees on later
 * installments become due on their dates in the ordinary way.
 */
async function recordInstallmentFees(c, l, asOf, createdBy) {
  const insts = await installmentsOf(c, l.id);
  for (const i of insts) {
    if (!(Number(i.fee_due) > 0) || !(i.due_date <= asOf || Number(i.fee_paid) > 0)) continue;
    const { rows: fees } = await c.query(
      "SELECT * FROM loan_fees WHERE installment_id = $1 AND status <> 'WAIVED' ORDER BY fee_type = 'PAYMENT_DUE' DESC, created_at", [i.id]);
    const others = sum(fees.filter((f) => f.fee_type !== 'PAYMENT_DUE'), (f) => f.amount);
    const scheduled = round2(Number(i.fee_due) - others);
    if (scheduled > 0 && !fees.some((f) => f.fee_type === 'PAYMENT_DUE')) {
      const { rows: [f] } = await c.query(
        `INSERT INTO loan_fees (loan_id, installment_id, name, fee_type, amount, paid, applied_on, status, note, created_by)
         VALUES ($1,$2,'Scheduled fee','PAYMENT_DUE',$3,0,$4::date,'DUE','data import',$5) RETURNING *`,
        [l.id, i.id, scheduled, i.due_date <= asOf ? i.due_date : asOf, createdBy]);
      fees.unshift(f);
    }
    let paid = round2(i.fee_paid);
    for (const f of fees) {
      const take = round2(Math.min(paid, Number(f.amount)));
      await c.query(`UPDATE loan_fees SET paid = $2, status = CASE WHEN $2 >= amount THEN 'PAID' ELSE 'DUE' END WHERE id = $1`, [f.id, take]);
      paid = round2(paid - take);
    }
  }
}

/**
 * Replay a fixed-term loan's transactions against its schedule, in the
 * order given. Repayments are allocated installment by installment in the
 * product's allocation order (penalty, fee, interest, principal unless the
 * product says otherwise), interest never beyond what the schedule has
 * earned by the payment date; fees and penalties go on the first unpaid
 * installment (the reference platform). More paid than is owed is an error.
 */
async function replay(c, l, txs, { createdBy, importId }) {
  const insts = await installmentsOf(c, l.id);
  const t = L.terms(l);
  const order = Array.isArray(l.allocation_order) && l.allocation_order.length === 4 ? l.allocation_order : ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'];
  const penalty = new Map(insts.map((i) => [i.id, { due: 0, paid: 0, rows: new Map() }]));
  const unpaid = (i) => round2(Number(i.principal_due) - i.principal_paid) > 0 || round2(Number(i.interest_due) - i.interest_paid) > 0
    || round2(Number(i.fee_due) - i.fee_paid) > 0 || round2(penalty.get(i.id).due - penalty.get(i.id).paid) > 0;
  for (const i of insts) Object.assign(i, { principal_paid: 0, interest_paid: 0, fee_paid: 0, fee_due: Number(i.fee_due) });
  let interestPaid = 0;
  let penaltyPaid = 0;
  const record = async (kind, x, allocation) => SV.record(c, {
    reference: SV.ref('MG'), kind, memberId: l.member_id, loanAccountId: l.id, amount: x.amount, valueDate: x.date,
    narration: x.notes || 'Imported transaction', createdBy, allocation: { imported: true, importId: importId || null, ...allocation },
  });

  for (const x of txs) {
    const amount = round2(x.amount);
    if (x.type === 'DISBURSEMENT') {
      await record('LOAN_DISBURSEMENT', x, { paidOut: amount });
      continue;
    }
    if (x.type === 'FEE' || x.type === 'PENALTY') {
      const first = insts.find(unpaid);
      if (!first) throw err(`A ${x.type.toLowerCase()} on ${x.date} has no unpaid installment to go on: the whole schedule is paid`);
      if (x.type === 'FEE') {
        first.fee_due = round2(first.fee_due + amount);
        const { rows: [f] } = await c.query(
          `INSERT INTO loan_fees (loan_id, installment_id, name, fee_type, amount, paid, applied_on, status, note, created_by)
           VALUES ($1,$2,'Imported fee','MANUAL',$3,0,$4::date,'DUE',$5,$6) RETURNING id`,
          [l.id, first.id, amount, x.date, x.notes || 'data import', createdBy]);
        await record('LOAN_FEE', x, { fee: 'Imported fee', feeType: 'MANUAL', feeId: f.id, installment: first.number });
      } else {
        const p = penalty.get(first.id);
        p.due = round2(p.due + amount);
        p.rows.set(x.date, round2((p.rows.get(x.date) || 0) + amount));
      }
      continue;
    }
    // REPAYMENT
    let left = amount;
    const earned = scheduledInterestThrough(l, insts, x.date, t.convention);
    const split = { principal: 0, interest: 0, fee: 0, penalty: 0 };
    for (const i of insts) {
      if (!(left > 0)) break;
      for (const comp of order) {
        if (!(left > 0)) break;
        let owed = 0;
        if (comp === 'PENALTY') owed = round2(penalty.get(i.id).due - penalty.get(i.id).paid);
        else if (comp === 'FEE') owed = round2(i.fee_due - i.fee_paid);
        else if (comp === 'INTEREST') {
          owed = round2(Number(i.interest_due) - i.interest_paid);
          if (i.due_date > x.date) owed = Math.max(0, Math.min(owed, round2(earned - interestPaid)));
        } else owed = round2(Number(i.principal_due) - i.principal_paid);
        const take = round2(Math.min(left, owed));
        if (!(take > 0)) continue;
        if (comp === 'PENALTY') { penalty.get(i.id).paid = round2(penalty.get(i.id).paid + take); penaltyPaid = round2(penaltyPaid + take); split.penalty += take; }
        else if (comp === 'FEE') { i.fee_paid = round2(i.fee_paid + take); split.fee += take; }
        else if (comp === 'INTEREST') { i.interest_paid = round2(i.interest_paid + take); interestPaid = round2(interestPaid + take); split.interest += take; }
        else { i.principal_paid = round2(i.principal_paid + take); split.principal += take; }
        left = round2(left - take);
      }
    }
    if (left > 0) throw err(`The repayment of ${amount} on ${x.date} is ${left} more than the loan owed`);
    await record('LOAN_REPAYMENT', x, Object.fromEntries(Object.entries(split).map(([k, v]) => [k, round2(v)])));
  }
  for (const i of insts) await saveInstallment(c, i);
  // Penalties, as charges brought across; one row per installment and day.
  for (const i of insts) {
    for (const [date, amount] of penalty.get(i.id).rows) {
      await c.query(
        `INSERT INTO penalty_charges (loan_id, installment_id, charged_on, days_late, basis_amount, rate, amount, imported, period_from, days_charged)
         VALUES ($1,$2,$3::date,GREATEST(0, $3::date - $4::date),0,0,$5,true,$3::date,0)`, [l.id, i.id, date, i.due_date, amount]);
    }
  }
  return {
    penaltyDue: sum([...penalty.values()], (p) => p.due), penaltyPaid,
    principal: sum(insts, (i) => i.principal_paid),
  };
}

/**
 * Build one migrated loan. `spec` is the normalised loan (see check()); the
 * caller resolved the member. Returns { loan, installments, principalOutstanding,
 * warnings }.
 */
async function migrate(c, spec, { asOf, importId = null, createdBy, user = null }) {
  const warnings = [];
  const state = spec.state || 'ACTIVE';
  const txs = spec.transactions || [];
  const problems = check(spec, { asOf });
  if (problems.length) throw err(problems.map((p) => p.message).join('; '));
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [spec.productId]);
  if (!p) throw err(`No loan product ${spec.productId}`);
  const type = p.product_type || 'FIXED_TERM';
  if (!['FIXED_TERM', 'DYNAMIC_TERM'].includes(type)) throw err(`Loans under ${type} products are not imported; open them in the system`);
  if (p.interest_rate_source === 'INDEX') throw err('Loans with an index interest rate are not imported; open them in the system');
  if (type === 'DYNAMIC_TERM' && spec.schedule && spec.schedule.length) {
    throw err('A dynamic-term loan\'s schedule is worked out by the product and cannot be imported; leave it off the Loan Schedule sheet');
  }
  if (type === 'DYNAMIC_TERM' && txs.length) throw err('Transactions are replayed on fixed-term loans only; give a dynamic-term loan its balances');
  if (spec.repaymentUnit || spec.repaymentEvery) {
    const unit = UNITS[String(spec.repaymentUnit || '').toUpperCase()] || p.repayment_interval_unit;
    let every = Number(spec.repaymentEvery || 1);
    if (['Y', 'YEARS'].includes(String(spec.repaymentUnit || '').toUpperCase())) every *= 12;
    if (unit !== p.repayment_interval_unit || every !== Number(p.repayment_interval_count || 1)) {
      throw err(`Product ${p.id} repays every ${p.repayment_interval_count || 1} ${String(p.repayment_interval_unit).toLowerCase()}; the loan says every ${every} ${unit.toLowerCase()}`);
    }
  }
  const disbursement = txs.find((x) => x.type === 'DISBURSEMENT');
  const principal = disbursement ? round2(disbursement.amount) : round2(spec.principal);
  if (disbursement && spec.principal && round2(spec.principal) !== principal) {
    warnings.push(`The DISBURSEMENT transaction (${principal}) replaces the loan amount on the account (${spec.principal})`);
  }
  const disbursedOn = disbursement ? disbursement.date : spec.disbursedOn;

  const l0 = await L.apply(c, {
    memberId: spec.memberId, productId: spec.productId, principal, termMonths: spec.installments,
    ...(spec.rate !== null && spec.rate !== undefined ? { monthlyRate: spec.rate } : {}),
    ...(spec.gracePeriods !== null && spec.gracePeriods !== undefined ? { gracePeriods: spec.gracePeriods } : {}),
    accountNo: spec.accountNo, ...(spec.branchId !== undefined ? { branchId: spec.branchId } : {}),
    purpose: spec.purpose || null, notes: spec.notes || null, name: spec.name || null,
    customFields: spec.customFields || {}, createdBy, user,
  });
  if (l0.rate_plan) throw err('Loans with adjustable interest periods are not imported; open them in the system');
  const applied = spec.appliedOn || spec.approvedOn || disbursedOn || asOf;
  await c.query(
    `UPDATE loan_accounts SET applied_on = $2::date, import_id = $3, migration_fields = $4, first_repayment_date = $5::date WHERE id = $1`,
    [l0.id, applied, importId, spec.migrationFields ? JSON.stringify(spec.migrationFields) : null, spec.firstRepaymentDate || null]);

  if (state === 'PENDING_APPROVAL') {
    await c.query("UPDATE loan_accounts SET status = 'PENDING_APPROVAL' WHERE id = $1", [l0.id]);
    await historyRow(c, l0.id, l0.status, 'PENDING_APPROVAL', createdBy, 'data import');
    return { loan: await L.lock(c, l0.id), installments: 0, principalOutstanding: 0, warnings };
  }
  if (state === 'APPROVED' || state === 'WITHDRAWN' || state === 'REJECTED') {
    const approvedOn = state === 'APPROVED' ? (spec.approvedOn || applied) : spec.approvedOn || null;
    await c.query(`UPDATE loan_accounts SET status = $2, approved_on = $3::date, approved_by = CASE WHEN $3::date IS NULL THEN NULL ELSE $4 END,
                     closed_on = CASE WHEN $2 LIKE 'CLOSED%' THEN $5::date ELSE NULL END WHERE id = $1`,
      [l0.id, STATES[state], approvedOn, createdBy, spec.closedOn || approvedOn || applied]);
    if (state === 'APPROVED') await workflow.freezeSettings(c, l0.id);
    await historyRow(c, l0.id, l0.status, STATES[state], createdBy, 'data import');
    return { loan: await L.lock(c, l0.id), installments: 0, principalOutstanding: 0, warnings };
  }

  // Disbursed: active, closed or written off.
  await c.query(
    `UPDATE loan_accounts SET status = 'ACTIVE', approved_on = $2::date, approved_by = $3, disbursed_on = $4::date,
       disbursed_by = $3, principal_disbursed = principal WHERE id = $1`,
    [l0.id, spec.approvedOn || disbursedOn, createdBy, disbursedOn]);
  await workflow.freezeSettings(c, l0.id);
  let l = await L.lock(c, l0.id);
  const given = spec.schedule && spec.schedule.length ? [...spec.schedule].sort((a, b) => a.number - b.number) : null;
  if (given) {
    await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [l.id]);
    for (const s of given) {
      await c.query(
        `INSERT INTO loan_installments (loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due,
           principal_paid, interest_paid, fee_paid, status)
         VALUES ($1,$2,$3::date,$3::date,$4,$5,$6,$7,$8,$9,'PENDING')`,
        [l.id, s.number, s.dueDate, s.principalDue, s.interestDue, s.feesDue || 0,
          txs.length ? 0 : s.principalPaid || 0, txs.length ? 0 : s.interestPaid || 0, txs.length ? 0 : s.feesPaid || 0]);
    }
  } else {
    await L.buildSchedule(c, l);
  }

  let penaltyDue = 0;
  let penaltyPaid = 0;
  let interestAccrued = null;
  let insts = await installmentsOf(c, l.id);
  if (txs.length) {
    const r = await replay(c, l, txs, { createdBy, importId });
    penaltyDue = r.penaltyDue;
    penaltyPaid = r.penaltyPaid;
    insts = await installmentsOf(c, l.id);
    const t = L.terms(l);
    const through = state === 'ACTIVE' ? asOf : (spec.closedOn || asOf);
    interestAccrued = Math.max(scheduledInterestThrough(l, insts, through, t.convention), sum(insts, (i) => i.interest_paid));
    for (const [k, v] of [['principalOutstanding', round2(principal - r.principal)]]) {
      if (spec[k] !== null && spec[k] !== undefined && round2(spec[k]) !== v) warnings.push(`The transactions leave ${v} principal outstanding; the account sheet says ${spec[k]} (the transactions are used)`);
    }
  } else if (state === 'CLOSED') {
    for (const i of insts) Object.assign(i, { principal_paid: Number(i.principal_due), interest_paid: Number(i.interest_due), fee_paid: Number(i.fee_due) });
    for (const i of insts) await saveInstallment(c, i);
  } else if (given && spec.schedulePaid !== false) {
    // The schedule says what was paid; its penalties are brought across.
    for (const s of given) {
      if (!(Number(s.penaltyDue) > 0)) continue;
      const inst = insts.find((i) => i.number === s.number);
      await c.query(
        `INSERT INTO penalty_charges (loan_id, installment_id, charged_on, days_late, basis_amount, rate, amount, imported, period_from, days_charged)
         VALUES ($1,$2,$3::date,GREATEST(0, $3::date - $4::date),0,0,$5,true,$3::date,0)`,
        [l.id, inst.id, asOf, inst.due_date, round2(s.penaltyDue)]);
      penaltyDue = round2(penaltyDue + Number(s.penaltyDue));
      penaltyPaid = round2(penaltyPaid + Number(s.penaltyPaid || 0));
    }
  } else {
    const outstanding = round2(spec.principalOutstanding || 0);
    const placed = allocatePrincipal(insts, { principal, outstanding, inArrears: spec.principalInArrears ?? null, asOf });
    for (const i of placed) {
      const full = round2(i.principal_paid) >= round2(i.principal_due);
      i.interest_paid = full ? Number(i.interest_due) : 0;
      // Fees on an unpaid installment already due are in the fees
      // outstanding the account gives; later ones come due in the ordinary way.
      if (full) i.fee_paid = Number(i.fee_due);
      else if (i.due_date <= asOf && !given) i.fee_due = 0;
      await saveInstallment(c, i);
    }
    // A schedule given without paid amounts may still carry penalties.
    for (const s of given || []) {
      if (!(Number(s.penaltyDue) > 0)) continue;
      const inst = insts.find((i) => i.number === s.number);
      await c.query(
        `INSERT INTO penalty_charges (loan_id, installment_id, charged_on, days_late, basis_amount, rate, amount, imported, period_from, days_charged)
         VALUES ($1,$2,$3::date,GREATEST(0, $3::date - $4::date),0,0,$5,true,$3::date,0)`,
        [l.id, inst.id, asOf, inst.due_date, round2(s.penaltyDue)]);
      penaltyDue = round2(penaltyDue + Number(s.penaltyDue));
    }
  }
  await setStatuses(c, l.id);
  await recordInstallmentFees(c, l, asOf, createdBy);

  // Fees still owed from the old system, when the product drew the
  // schedule: one fee on the oldest unpaid installment.
  const feesLeft = round2(spec.feesOutstanding || 0);
  if (!given && !txs.length && feesLeft > 0 && state !== 'CLOSED') {
    const { rows: [first] } = await c.query(
      "SELECT id FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID' ORDER BY number LIMIT 1", [l.id]);
    if (first) await c.query("UPDATE loan_installments SET fee_due = fee_due + $2, status = CASE WHEN status = 'PAID' THEN 'PARTIALLY_PAID' ELSE status END WHERE id = $1", [first.id, feesLeft]);
    await c.query(
      `INSERT INTO loan_fees (loan_id, installment_id, name, fee_type, amount, paid, applied_on, status, note, created_by)
       VALUES ($1,$2,'Fees brought forward','MANUAL',$3,0,$4::date,'DUE','data import',$5)`,
      [l.id, first ? first.id : null, feesLeft, asOf, createdBy]);
  }
  if (!txs.length && !given && Number(spec.penaltyOutstanding || 0) > 0) penaltyDue = round2(spec.penaltyOutstanding);
  if (!txs.length && given && !penaltyDue && Number(spec.penaltyOutstanding || 0) > 0) penaltyDue = round2(spec.penaltyOutstanding);

  insts = await installmentsOf(c, l.id);
  const { rows: [fees] } = await c.query(
    "SELECT COALESCE(sum(amount),0) AS due, COALESCE(sum(paid),0) AS paid FROM loan_fees WHERE loan_id = $1 AND status <> 'WAIVED'", [l.id]);
  const principalPaid = sum(insts, (i) => i.principal_paid);
  const interestPaid = sum(insts, (i) => i.interest_paid);
  if (interestAccrued === null) interestAccrued = round2(interestPaid + Number(spec.interestOutstanding || 0));
  const interestFromArrears = round2(spec.interestFromArrears || 0);
  let credit = 0;
  if (Number(spec.redrawBalance || 0) > 0) {
    if (!p.credit_balance_enabled) throw err(`Product ${p.id} does not keep a credit balance, so a redraw balance cannot be migrated`);
    credit = round2(spec.redrawBalance);
  }
  await c.query(
    `UPDATE loan_accounts SET principal_paid = $2::numeric, interest_paid = $3::numeric, interest_accrued = $4::numeric,
       fees_due = $5::numeric, fees_paid = $6::numeric, penalty_accrued = $7::numeric, penalty_paid = $8::numeric,
       interest_from_arrears_accrued = $9::numeric, credit_balance = $10::numeric
     WHERE id = $1`,
    [l.id, principalPaid, interestPaid, round2(interestAccrued), fees.due, fees.paid, penaltyDue, penaltyPaid, interestFromArrears, credit]);
  l = await L.lock(c, l.id);
  const outstanding = L.principalOutstanding(l);

  if (state === 'CLOSED') {
    const b = L.balances(l);
    const owed = round2(b.principal + b.interest + b.fees + b.penalty);
    if (owed > 0) throw err(`A closed loan owes nothing, but this one would owe ${owed}`);
    const on = spec.closedOn || (txs.length ? txs[txs.length - 1].date : null) || asOf;
    await c.query("UPDATE loan_accounts SET status = 'CLOSED_REPAID', closed_on = $2::date, accrued_through = $2::date WHERE id = $1", [l.id, on]);
    await historyRow(c, l.id, l0.status, 'CLOSED_REPAID', createdBy, 'data import');
  } else if (state === 'WRITTEN_OFF') {
    const b = L.balances(l);
    const on = spec.closedOn || asOf;
    await c.query(
      `UPDATE loan_accounts SET status = 'CLOSED_WRITTEN_OFF', closed_on = $2::date, accrued_through = $2::date,
         written_off_amount = $3, written_off_on = $2::date, written_off_by = $4 WHERE id = $1`,
      [l.id, on, round2(b.principal + b.interest + b.fees + b.penalty), createdBy]);
    await historyRow(c, l.id, l0.status, 'CLOSED_WRITTEN_OFF', createdBy, 'data import');
  } else {
    if (!(round2(outstanding + L.balances(l).interest + L.balances(l).fees + L.balances(l).penalty) > 0)) {
      throw err('An active loan owes something; one that owes nothing is imported as Closed');
    }
    await c.query('UPDATE loan_accounts SET accrued_through = $2::date WHERE id = $1', [l.id, asOf]);
    await historyRow(c, l.id, l0.status, 'ACTIVE', createdBy, `data import, balances at ${asOf}`);
    // Arrears on the product's rules, as at the migration date.
    await workflow.markArrears(c, { asOf, loanId: l.id });
    if (spec.lastSetToArrearsDate) {
      await c.query("UPDATE loan_accounts SET arrears_since = $2::date WHERE id = $1 AND status = 'IN_ARREARS'", [l.id, spec.lastSetToArrearsDate]);
    }
    // Late before the migration date: no late fee, and penalties count from
    // the migration date (a forfeited marker covers the days before, unless
    // a penalty brought across already does).
    const { rows: late } = await c.query(
      `UPDATE loan_installments SET late_fee_exempt = true
       WHERE loan_id = $1 AND due_date < $2::date AND status NOT IN ('PAID', 'GRACE') RETURNING id, due_date`, [l.id, asOf]);
    for (const i of late) {
      await c.query(
        `INSERT INTO penalty_charges (loan_id, installment_id, charged_on, days_late, basis_amount, rate, amount, forfeited, period_from, days_charged)
         SELECT $1,$2,$3::date,($3::date - $4::date),0,0,0,true,$4::date,0
         WHERE NOT EXISTS (SELECT 1 FROM penalty_charges WHERE installment_id = $2 AND charged_on >= $3::date AND reversed_at IS NULL)`,
        [l.id, i.id, asOf, i.due_date]);
    }
  }
  l = await L.lock(c, l.id);
  return { loan: l, installments: insts.length, principalOutstanding: state === 'ACTIVE' ? L.principalOutstanding(l) : 0, warnings };
}

/**
 * The reference platform's external migration request (POST /loans/migrate), in this
 * builder's terms. The reference platform names are accepted and so are this API's own.
 */
function fromApiBody(body = {}, { asOf }) {
  const a = body.loanAccount || body;
  const mf = body.migrationFields || {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
  const day = (v) => (v ? String(v).slice(0, 10) : null);
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    accountNo: pick(a.id, a.accountNo),
    member: pick(a.accountHolderKey, a.memberId, a.memberNo),
    productId: pick(a.productTypeKey, a.productId),
    principal: num(pick(a.loanAmount, a.principal)),
    installments: num(pick(a.scheduleSettings?.repaymentInstallments, a.installments, a.termMonths)),
    rate: num(pick(a.interestSettings?.interestRate, a.rate, a.monthlyRate)),
    gracePeriods: num(pick(a.scheduleSettings?.gracePeriod, a.gracePeriods)),
    disbursedOn: day(pick(a.disbursementDetails?.disbursementDate, a.disbursedOn)),
    approvedOn: day(pick(a.approvedDate, a.approvedOn)),
    appliedOn: day(pick(a.creationDate, a.appliedOn)),
    firstRepaymentDate: day(pick(body.firstRepaymentDate, a.disbursementDetails?.firstRepaymentDate, a.firstRepaymentDate)),
    principalOutstanding: num(pick(a.balances?.principalBalance, a.principalOutstanding)),
    // The reference platform splits interest owed into what is due (interest) and what has
    // accrued but is not yet due (interestAccrued); here both are owed.
    interestOutstanding: mf.interest !== undefined || mf.interestAccrued !== undefined
      ? round2(Number(mf.interest || 0) + Number(mf.interestAccrued || 0)) : num(a.interestOutstanding),
    feesOutstanding: num(pick(a.balances?.feesBalance, a.feesOutstanding)),
    penaltyOutstanding: num(pick(a.balances?.penaltyBalance, a.penaltyOutstanding)),
    principalInArrears: num(mf.principalInArrears),
    interestFromArrears: round2(Number(mf.interestFromArrears || 0) + Number(mf.interestFromArrearsAccrued || 0)),
    lastSetToArrearsDate: day(mf.lastSetToArrearsDate),
    redrawBalance: num(mf.redrawBalance),
    migrationFields: Object.keys(mf).length ? mf : null,
    state: normState(pick(a.accountState, a.state)),
    closedOn: day(pick(a.closedDate, a.closedOn)),
    branchId: pick(a.assignedBranchKey, a.branchId),
    purpose: a.purpose || null,
    notes: a.notes || null,
    name: a.loanName || null,
    schedule: Array.isArray(body.schedule) ? body.schedule.map((x, i) => ({
      number: x.number ?? i + 1, dueDate: day(x.dueDate), principalDue: num(pick(x.principalDue, x.principalExpected)) || 0,
      interestDue: num(pick(x.interestDue, x.interestExpected)) || 0, feesDue: num(pick(x.feesDue, x.feesExpected)), penaltyDue: num(pick(x.penaltyDue, x.penaltyExpected)),
      principalPaid: num(x.principalPaid), interestPaid: num(x.interestPaid), feesPaid: num(x.feesPaid), penaltyPaid: num(x.penaltyPaid),
    })) : null,
    schedulePaid: Array.isArray(body.schedule) && body.schedule.some((x) => ['principalPaid', 'interestPaid', 'feesPaid', 'penaltyPaid'].some((k) => x[k] !== undefined && x[k] !== null)),
    transactions: Array.isArray(body.transactions) ? body.transactions.map((x) => ({ ...x, type: String(x.type || '').toUpperCase(), date: day(x.date), amount: Number(x.amount) })) : [],
    customFields: a.customFields || {},
    asOf,
  };
}

module.exports = { migrate, check, normState, fromApiBody, allocatePrincipal, STATES, TX_TYPES };
