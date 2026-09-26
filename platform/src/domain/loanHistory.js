'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const { err, round2 } = acct;
const { ymd, isoDate } = S;

/**
 * A member's loan history, after Mambu's "Reviewing a Client's Loan
 * History" and the Completed Loan Cycles on the overview:
 *
 *   closed loans     every closed loan with its amount, when and how it
 *                    closed (all obligations met, rejected, withdrawn,
 *                    rescheduled, refinanced, written off)
 *   max loan size    the largest amount the member was approved for among
 *                    those loans, marked on its row
 *   on-time rate     per loan, the share of its installments paid in full on
 *                    or before their due date; an installment paid late,
 *                    even inside an arrears tolerance, is not on time. The
 *                    overall rate is the average over the closed loans that
 *                    had installments.
 *   loan cycles      the loans closed with all obligations met (paid in
 *                    full or paid off early)
 *
 * When an installment was paid in full is worked out by replaying the
 * loan's repayments that stand (not reversed) over its installments in
 * order, as they were allocated. A dynamic loan whose schedule was redrawn
 * is replayed against the schedule it has now.
 *
 * Reads only; depends on accounting and the schedule arithmetic.
 */

const CLOSED_HOW = {
  CLOSED_REPAID: 'ALL_OBLIGATIONS_MET', CLOSED_REJECTED: 'REJECTED', CLOSED_WITHDRAWN: 'WITHDRAWN',
  CLOSED_RESCHEDULED: 'RESCHEDULED', CLOSED_REFINANCED: 'REFINANCED', CLOSED_WRITTEN_OFF: 'WRITTEN_OFF',
};

/** Installments of a loan with the date each was paid in full, or null. */
async function paidDates(c, loanId) {
  const { rows: insts } = await c.query(
    `SELECT number, due_date, principal_due, interest_due, fee_due FROM loan_installments
     WHERE loan_id = $1 AND status <> 'GRACE' AND principal_due + interest_due + fee_due > 0 ORDER BY number`, [loanId]);
  const { rows: pays } = await c.query(
    `SELECT value_date, allocation FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT' AND reversed_by IS NULL
     ORDER BY value_date, created_at`, [loanId]);
  const owe = insts.map((i) => ({
    number: i.number, dueDate: ymd(i.due_date),
    p: Number(i.principal_due), i: Number(i.interest_due), f: Number(i.fee_due), paidOn: null,
  }));
  for (const t of pays) {
    const a = t.allocation || {};
    let p = Number(a.principal || 0);
    let i = Number(a.interest || 0) + Number(a.prepaidInterest || 0);
    let f = Number(a.fees || 0);
    for (const x of owe) {
      if (!(p > 0.001 || i > 0.001 || f > 0.001)) break;
      if (x.paidOn) continue;
      const tp = Math.min(p, x.p); const ti = Math.min(i, x.i); const tf = Math.min(f, x.f);
      x.p = round2(x.p - tp); x.i = round2(x.i - ti); x.f = round2(x.f - tf);
      p = round2(p - tp); i = round2(i - ti); f = round2(f - tf);
      if (x.p <= 0 && x.i <= 0 && x.f <= 0) x.paidOn = ymd(t.value_date);
    }
  }
  return owe;
}

/**
 * The on-time repayment rate of one loan, as at `asOf` (its closing date
 * for a closed loan): installments paid on or before their due date over
 * installments due by then or already paid. Null when none count.
 */
async function onTimeRate(c, loanId, asOf) {
  const owe = await paidDates(c, loanId);
  const counted = owe.filter((x) => x.dueDate <= asOf || x.paidOn);
  if (!counted.length) return { rate: null, installments: 0, onTime: 0 };
  const onTime = counted.filter((x) => x.paidOn && x.paidOn <= x.dueDate).length;
  return { rate: round2(onTime * 100 / counted.length), installments: counted.length, onTime };
}

async function forMember(c, memberId) {
  const { rows: [m] } = await c.query('SELECT id, member_no, first_name, last_name FROM members WHERE id::text = $1 OR member_no = $1', [String(memberId)]);
  if (!m) throw err('MEMBER_NOT_FOUND', 404);
  const { rows } = await c.query(
    `SELECT l.id, l.account_no, l.product_id, p.name AS product_name, l.status, l.principal, l.principal_disbursed,
            l.approved_on, l.disbursed_on, l.closed_on, l.written_off_amount
     FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
     WHERE l.member_id = $1 ORDER BY COALESCE(l.closed_on, l.applied_on) DESC, l.account_no`, [m.id]);
  const today = isoDate(new Date());
  const closed = [];
  for (const l of rows.filter((x) => CLOSED_HOW[x.status])) {
    const asOf = l.closed_on ? ymd(l.closed_on) : today;
    const r = l.disbursed_on ? await onTimeRate(c, l.id, asOf) : { rate: null, installments: 0, onTime: 0 };
    closed.push({
      loanId: l.id, accountNo: l.account_no, product: l.product_name, status: l.status, closedAs: CLOSED_HOW[l.status],
      amount: Number(l.principal), disbursed: Number(l.principal_disbursed), approvedOn: l.approved_on ? ymd(l.approved_on) : null,
      closedOn: l.closed_on ? ymd(l.closed_on) : null, onTimeRate: r.rate, installmentsCounted: r.installments, installmentsOnTime: r.onTime,
    });
  }
  const approved = closed.filter((x) => x.approvedOn);
  const max = approved.length ? Math.max(...approved.map((x) => x.amount)) : null;
  for (const x of closed) x.maxLoanSize = max !== null && x.approvedOn !== null && x.amount === max;
  const rated = closed.filter((x) => x.onTimeRate !== null);
  const running = rows.filter((x) => ['ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(x.status));
  const current = [];
  for (const l of running) {
    const r = await onTimeRate(c, l.id, today);
    current.push({ loanId: l.id, accountNo: l.account_no, status: l.status, amount: Number(l.principal), onTimeRate: r.rate });
  }
  return {
    memberId: m.id, memberNo: m.member_no, name: `${m.first_name} ${m.last_name}`,
    completedLoanCycles: rows.filter((x) => x.status === 'CLOSED_REPAID').length,
    maxLoanSize: max,
    overallOnTimeRate: rated.length ? round2(rated.reduce((a, x) => a + x.onTimeRate, 0) / rated.length) : null,
    closedLoans: closed,
    runningLoans: current,
  };
}

/** The member's completed loan cycles, for a loan's overview. */
async function loanCycles(c, memberId) {
  const { rows: [r] } = await c.query("SELECT count(*)::int AS n FROM loan_accounts WHERE member_id = $1 AND status = 'CLOSED_REPAID'", [memberId]);
  return r.n;
}

module.exports = { forMember, onTimeRate, paidDates, loanCycles, CLOSED_HOW };
