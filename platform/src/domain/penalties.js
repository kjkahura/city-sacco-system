'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const tax = require('./tax');
const L = require('./ledger');
const W = require('./workflow');
const { pageQuery } = require('../lib/page');
const S = require('./schedule');
const { err, round2 } = acct;

/**
 * Late payment penalties, after Mambu's "Loan Penalties Setup".
 *
 * Mambu's four bases, and NONE:
 *   OVERDUE_PRINCIPAL           principal in arrears x daily rate x days late
 *   OVERDUE_PRINCIPAL_INTEREST  principal and interest in arrears
 *   OVERDUE_ALL                 principal, interest and fees in arrears
 *   OUTSTANDING_PRINCIPAL       the whole outstanding principal, a penalty
 *                               interest rate on top of the rate; its rate
 *                               is per the product's interest rate period
 *                               (a year, a month, a week or a day), the
 *                               other three are daily rates
 *
 * A penalty accrues from the first late day. Nothing is applied while the
 * installment is inside the tolerance: the penalty tolerance and the arrears
 * tolerance, whichever is longer (Mambu's worked examples). The first charge
 * after it covers every late day since the due date, and each charge after
 * that the days since the last (penalty_charges.period_from and
 * days_charged), so a day the end of day missed is covered by the next run.
 * Where the product excludes non-working days, weekends and holidays count
 * neither towards the tolerance nor towards the penalty.
 *
 * What has accrued and is not applied (inside the tolerance, or on a locked
 * loan) is shown on the loan as penalty_unapplied and not posted. A loan
 * locked by hand or for days in arrears keeps accruing and is charged the
 * whole of it at the first run after it is unlocked; a loan locked by the
 * charge cap forfeits those days (a charge of nothing marks them covered).
 *
 * The unique index on (installment_id, charged_on) still means a rerun on
 * the same day charges nothing more. A backdated repayment or a reversal
 * takes back the unpaid charges after its date (reverseAfter) and charges
 * those days again on what is then owed (loans.repay, reverseTransaction).
 */

function daysLate(dueDate, asOf) {
  const d = Math.floor((new Date(asOf) - new Date(dueDate)) / 86400000);
  return d > 0 ? d : 0;
}

/**
 * Late days after `from` up to and including `to`: every day, or only the
 * working days when non-working days are excluded.
 */
async function countDays(c, from, to, excludeNonWorking) {
  if (!(to > from)) return 0;
  if (!excludeNonWorking) return daysLate(from, to);
  const { rows: [r] } = await c.query(
    `SELECT count(*)::int AS n FROM generate_series($1::date + 1, $2::date, interval '1 day') AS d
     WHERE EXTRACT(dow FROM d) NOT IN (0, 6) AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = d::date)`, [from, to]);
  return r.n;
}

/** The fraction of the basis one late day costs. */
function dailyRate(l, ratePercent) {
  const r = Number(ratePercent) / 100;
  if (l.penalty_basis !== 'OUTSTANDING_PRINCIPAL') return r;
  const f = l.rate_frequency || 'PER_MONTH';
  const days = f === 'PER_YEAR' ? S.yearDays(l.day_count || 'THIRTY_360') : f === 'PER_MONTH' ? 30 : f === 'PER_WEEK' ? 7 : 1;
  return r / days;
}

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** The last day any penalty on the loan was worked out to (waived and forfeited charges count). */
async function chargedThrough(c, loanId) {
  const { rows: [r] } = await c.query(
    'SELECT max(charged_on) AS d FROM penalty_charges WHERE loan_id = $1 AND reversed_at IS NULL', [loanId]);
  return r?.d ? ymd(r.d) : null;
}

/**
 * Accrue penalties for one loan as at a date.
 * Returns the charges created; an empty array is a normal outcome.
 */
async function accrueForLoan(c, loanId, { asOf = null, createdBy = 'EOD' } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);

  const l = await L.lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(l.status)) return [];
  const setUnapplied = async (v) => {
    if (round2(v) !== round2(l.penalty_unapplied || 0)) {
      await c.query('UPDATE loan_accounts SET penalty_unapplied = $1 WHERE id = $2', [round2(v), l.id]);
    }
  };
  const effRate = Number(L.effective(l).penaltyRate);
  if (!l.penalty_basis || l.penalty_basis === 'NONE' || !(effRate > 0)) { await setUnapplied(0); return []; }
  const perDay = dailyRate(l, effRate);
  const e = L.effective(l);
  const threshold = Math.max(Number(l.penalty_tolerance_days || 0), Number(e.arrearsToleranceDays || 0));
  const amountTolerance = e.arrearsTolerancePercent !== null || (l.arrears_tolerance_floor !== null && l.arrears_tolerance_floor !== undefined);
  const exclude = l.arrears_non_working_days === 'EXCLUDE';
  const locked = l.status === 'LOCKED';
  const forfeit = locked && l.locked_reason === 'CAPPED';

  const { rows: overdue } = await c.query(
    `SELECT i.*, (SELECT max(pc.charged_on) FROM penalty_charges pc WHERE pc.installment_id = i.id AND pc.reversed_at IS NULL) AS through
     FROM loan_installments i
     WHERE i.loan_id = $1 AND i.status NOT IN ('PAID', 'GRACE') AND i.due_date < $2::date
     ORDER BY i.number`,
    [l.id, date]
  );

  const glIncome = l.gl_penalty_inc || l.gl_interest_inc;
  const charges = [];
  // Like interest, a penalty is worked out unrounded and the fraction of a
  // minor unit it leaves is carried to the next charge on the loan, so a
  // month of daily penalties is the month's penalty (penalty_accrual_carry).
  const decimals = await L.currencyDecimals(c);
  let carry = Number(l.penalty_accrual_carry || 0);
  let unapplied = 0;

  for (const inst of overdue) {
    const due = ymd(inst.due_date);
    const from = inst.through ? ymd(inst.through) : due;
    if (from >= date) continue;
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
    const days = await countDays(c, from, date, exclude);
    if (!(days > 0)) continue;
    const late = exclude ? await countDays(c, due, date, true) : daysLate(due, date);

    // Inside the tolerance, short of the arrears amount tolerance, or on a
    // loan locked by hand: accrued, not applied.
    const waiting = late <= threshold || (amountTolerance && inst.status !== 'OVERDUE') || (locked && !forfeit);
    if (waiting) { unapplied += Math.max(0, basisAmount) * perDay * days; continue; }

    if (forfeit) {
      await c.query(
        `INSERT INTO penalty_charges (loan_id, installment_id, charged_on, days_late, basis_amount, rate, amount, period_from, days_charged, forfeited)
         VALUES ($1,$2,$3::date,$4,$5,$6,0,$7::date,$8,true) ON CONFLICT (installment_id, charged_on) WHERE waived_at IS NULL AND reversed_at IS NULL DO NOTHING`,
        [l.id, inst.id, date, daysLate(due, date), basisAmount, effRate, from, days]);
      continue;
    }

    const iterCarry = carry;
    const exact = Math.max(0, basisAmount) * perDay * days + carry;
    let amount = S.roundTo(exact, decimals);
    const nextCarry = exact - amount;
    if (!(amount > 0)) { carry = exact; continue; }
    const allowed = await W.capAllows(c, l, amount);
    if (!(allowed > 0)) { carry = 0; break; }
    // What the cap refuses is not carried forward.
    carry = allowed < amount ? 0 : nextCarry;
    amount = allowed;
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
         (loan_id, installment_id, charged_on, days_late, basis_amount, rate, amount, period_from, days_charged, tax)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8::date,$9,$10)
       ON CONFLICT (installment_id, charged_on) WHERE waived_at IS NULL AND reversed_at IS NULL DO NOTHING
       RETURNING *`,
      [l.id, inst.id, date, daysLate(due, date), basisAmount, effRate, amount, from, days, tx.tax]
    );
    if (!ins.length) { carry = iterCarry; continue; }  // already charged for this day
    const inserted = ins[0];

    // Penalty applied: Dr Penalty Receivable, Cr Penalty Income (accrual).
    // Under cash accounting nothing is booked until it is paid.
    let entryId = null;
    if (L.isAccrual(l)) {
      entryId = await L.post(c, l, {
        debits: [{ glCode: l.gl_penalty_rec, amount, memberId: l.member_id }],
        credits: tax.incomeCredits(l, tx, glIncome, l.member_id),
        narration: `Penalty ${l.account_no} installment ${inst.number}, ${days} day(s) to ${date}`,
        sourceType: 'LOAN_PENALTY', sourceId: l.id, bookingDate: date, createdBy,
      });
      if (entryId) await c.query('UPDATE penalty_charges SET entry_id = $1 WHERE id = $2', [entryId, inserted.id]);
    }
    await c.query(
      `UPDATE loan_accounts SET penalty_accrued = penalty_accrued + $1, tax_charged = tax_charged + $3,
         charges_since_arrears = charges_since_arrears + CASE WHEN status IN ('IN_ARREARS', 'LOCKED') THEN $1 ELSE 0 END,
         updated_at = now() WHERE id = $2`,
      [amount, l.id, tx.tax]
    );
    l.charges_since_arrears = Number(l.charges_since_arrears || 0) + amount;

    charges.push({ ...inserted, entryId });
  }
  if (carry !== Number(l.penalty_accrual_carry || 0)) {
    await c.query('UPDATE loan_accounts SET penalty_accrual_carry = $1 WHERE id = $2', [carry, l.id]);
  }
  await setUnapplied(unapplied);

  return charges;
}

async function accrueAll(c, { asOf = null, createdBy = 'EOD' } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const { rows } = await c.query(
    `SELECT DISTINCT l.id FROM loan_accounts l
     JOIN loan_products p ON p.id = l.product_id
     LEFT JOIN loan_installments i ON i.loan_id = l.id AND i.status NOT IN ('PAID', 'GRACE') AND i.due_date < $1::date
     WHERE l.status IN ('ACTIVE', 'IN_ARREARS', 'LOCKED')
       AND ((${L.overrideSql('penaltyRate')} > 0 AND ${L.settingSql('penalty_basis')} <> 'NONE' AND i.id IS NOT NULL)
            OR l.penalty_unapplied > 0)`,
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
 * Take back the penalties charged after `date` that are still unpaid,
 * newest first, so they can be worked out again on what was owed after a
 * repayment dated `date` or once a repayment is reversed. A charge that has
 * been paid stays. Returns the charges taken back and the last day that had
 * been charged to, which the caller charges again up to.
 */
async function reverseAfter(c, loanId, date, { createdBy, reason = 'recalculated' } = {}) {
  const l = await L.lock(c, loanId);
  const through = await chargedThrough(c, l.id);
  if (!through || through <= date) return { reversed: [], through };
  let unpaid = round2(Number(l.penalty_accrued) - Number(l.penalty_paid));
  const { rows } = await c.query(
    `SELECT * FROM penalty_charges WHERE loan_id = $1 AND reversed_at IS NULL AND waived_at IS NULL AND charged_on > $2::date
     ORDER BY charged_on DESC, created_at DESC`, [l.id, date]);
  const reversed = [];
  for (const ch of rows) {
    const amt = Number(ch.amount);
    if (amt > unpaid + 0.001) break;
    if (ch.entry_id) await acct.reverse(c, ch.entry_id, `Penalty recalculated: ${reason}`, createdBy);
    await c.query('UPDATE penalty_charges SET reversed_at = now(), reversed_by = $2, reversal_reason = $3 WHERE id = $1',
      [ch.id, createdBy || 'SYSTEM', reason]);
    if (amt > 0) {
      await c.query(
        `UPDATE loan_accounts SET penalty_accrued = penalty_accrued - $1, tax_charged = tax_charged - $3,
           charges_since_arrears = GREATEST(0, charges_since_arrears - $1), updated_at = now() WHERE id = $2`,
        [amt, l.id, Number(ch.tax || 0)]);
    }
    unpaid = round2(unpaid - amt);
    reversed.push(ch);
  }
  return { reversed, through };
}

/**
 * Change a running loan's penalty rate (Mambu's Edit Penalty Rate), within
 * the product's band. Penalties already applied stand; what accrues from
 * here, and what has accrued and is not yet applied, is at the new rate.
 */
async function changeRate(c, loanId, { rate, note = null, asOf = null, createdBy } = {}) {
  const l = await L.lock(c, loanId);
  if (!['APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(l.status)) throw err(`PENALTY_RATE_NOT_CHANGEABLE_IN_STATE_${l.status}`, 409);
  if (!l.penalty_basis || l.penalty_basis === 'NONE') throw err('THE_PRODUCT_CHARGES_NO_PENALTIES', 409);
  const v = Number(rate);
  if (!(Number.isFinite(v) && v >= 0)) throw err('INVALID_PENALTY_RATE', 400);
  L.within('PENALTY_RATE', v, l.penalty_rate_min, l.penalty_rate_max);
  const before = L.effective(l).penaltyRate;
  const date = asOf ? String(asOf).slice(0, 10) : new Date().toISOString().slice(0, 10);
  await c.query('UPDATE loan_accounts SET penalty_rate = $1, updated_at = now() WHERE id = $2', [v, l.id]);
  const { rows: [r] } = await c.query(
    `INSERT INTO loan_penalty_rate_changes (loan_id, from_rate, to_rate, changed_on, note, created_by)
     VALUES ($1,$2,$3,$4::date,$5,$6) RETURNING *`, [l.id, before, v, date, note, createdBy || 'SYSTEM']);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'LOAN_PENALTY_RATE_CHANGED','loan_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', l.id, JSON.stringify({ penaltyRate: before }), JSON.stringify({ penaltyRate: v, note })]);
  return r;
}

async function rateChanges(c, loanId) {
  const l = await L.read(c, loanId);
  const { rows } = await c.query('SELECT * FROM loan_penalty_rate_changes WHERE loan_id = $1 ORDER BY created_at, id', [l.id]);
  return rows;
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
  if (ch.reversed_at) throw err('PENALTY_CHARGE_WAS_RECALCULATED', 409);
  if (ch.forfeited) throw err('PENALTY_CHARGE_WAS_FORFEITED', 409);

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

module.exports = { accrueForLoan, accrueAll, waive, forLoan, daysLate, countDays, dailyRate, chargedThrough, reverseAfter, changeRate, rateChanges };
