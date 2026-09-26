'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const ledger = require('./ledger');
const fees = require('./fees');
const funding = require('./funding');
const workflow = require('./workflow');
const provisioning = require('./provisioning');
const PA = require('./productAccounting');
const types = require('./productTypes');
const { accrueInterest, prepaidToPrincipal } = require('./interest');
const FA = require('./feeAmortization');
const { pageQuery } = require('../lib/page');
const { err, round2 } = acct;
const { lock, balances, isAccrual, interestAccrues, writeOffCredit, post, booksEntries } = ledger;

/**
 * Writing a loan off, and what comes after.
 *
 * The write-off clears each component of the balance against the account
 * that holds it. The principal is written off against the loan loss
 * allowance first, for the part of the allowance that stands for this loan
 * (./provisioning attributable), and the expense takes the rest, so the
 * provision built for a bad loan is used when the loan goes rather than
 * released while the expense is charged in full. Guarantors are called and
 * collateral is seized.
 *
 * The loan keeps what was written off (written_off_amount) and what has
 * been recovered since (recovered). Recoveries are income when they arrive
 * (Dr the channel or the guarantor's deposits, Cr Recoveries on Written-off
 * Loans), up to what was written off:
 *
 *   recover               money from the member, a sale of collateral or
 *                         anyone else, through a channel
 *   recoverFromGuarantor  taken from a called guarantor's deposits, up to
 *                         what they pledged; their deposits stay committed
 *                         for the rest of the pledge until it is recovered
 *                         or the call is released
 *   releaseCall           the SACCO forgoes the rest of a guarantor's pledge
 *
 * Reversing a write-off restores the loan exactly as it was (state,
 * guarantors, collateral) and is refused while recoveries stand against it;
 * reversing a recovery puts the money back where it came from.
 *
 * A write-off is requested and approved by different people (maker-checker)
 * unless the tenant turns that off (lending_controls.
 * write_off_requires_approval); the approver's approval limit applies to
 * the amount written off. It may be dated back, to no earlier than the last
 * repayment or disbursement on the loan; interest on a loan that accrues on
 * the actual balance is brought to that date first. Every write-off is in
 * the register, with who asked, who approved, why, and what has been
 * recovered since.
 */

const WRITABLE = ['ACTIVE', 'IN_ARREARS', 'LOCKED'];
const SOURCES = ['MEMBER', 'COLLATERAL', 'OTHER'];

const today = () => new Date().toISOString().slice(0, 10);
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// --------------------------------------------------------------------------
// The write-off
// --------------------------------------------------------------------------

/**
 * The date a write-off may carry: today by default; not in the future, not
 * before disbursement, and not before a repayment or disbursement already
 * on the loan (the write-off would then precede money that moved after it).
 */
async function writeOffDate(c, l, valueDate) {
  const date = valueDate ? ymd(valueDate) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('INVALID_VALUE_DATE', 400);
  if (date > today()) throw err('WRITE_OFF_CANNOT_BE_DATED_IN_THE_FUTURE', 400);
  if (l.disbursed_on && date < ymd(l.disbursed_on)) throw err(`WRITE_OFF_BEFORE_DISBURSEMENT: ${ymd(l.disbursed_on)}`, 400);
  const { rows: [t] } = await c.query(
    `SELECT max(value_date) AS d FROM transactions
     WHERE loan_account_id = $1 AND kind IN ('LOAN_REPAYMENT', 'LOAN_DISBURSEMENT') AND reversed_by IS NULL`, [l.id]);
  if (t?.d && date < ymd(t.d)) throw err(`WRITE_OFF_BEFORE_LAST_TRANSACTION: ${ymd(t.d)}`, 409);
  return date;
}

async function writeOff(c, loanId, { narration, createdBy, valueDate } = {}) {
  let l = await lock(c, loanId);
  if (!WRITABLE.includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  await workflow.assertMayWriteOff(c, l);
  const date = await writeOffDate(c, l, valueDate);
  // What is written off includes the interest earned to the date on a loan
  // that accrues on the actual balance. Interest already accrued past a
  // back date stays owed and is written off with the rest.
  if (types.forLoan(l).bringsInterestToDate && l.status !== 'LOCKED') {
    await accrueInterest(c, l.id, { valueDate: date, createdBy });
    l = await lock(c, l.id);
  }
  // Interest paid in advance and not earned reduces the principal written off.
  if (Number(l.interest_prepaid) > 0) {
    await prepaidToPrincipal(c, l.id, { valueDate: date, createdBy });
    l = await lock(c, l.id);
  }
  const b = balances(l);
  if (b.total <= 0) throw err('NOTHING_TO_WRITE_OFF', 409);

  // Each component is cleared against the account that holds it: principal
  // out of the portfolio, and under accrual the interest, fee and penalty
  // receivables that were built up when they were applied. Under cash those
  // three were never recognised, so only the principal is booked. A funded
  // loan's principal was never on the SACCO's books.
  const funded = await funding.isFunded(c, l.id);
  const credits = funded ? [] : [{ glCode: writeOffCredit(l, 'PRINCIPAL'), amount: b.principal, memberId: l.member_id }];
  const debits = [];
  if (isAccrual(l)) {
    if (interestAccrues(l) && b.interest > 0) credits.push({ glCode: writeOffCredit(l, 'INTEREST'), amount: b.interest, memberId: l.member_id });
    if (b.penalty > 0) credits.push({ glCode: writeOffCredit(l, 'PENALTY'), amount: b.penalty, memberId: l.member_id });
    // Each fee is written off against its own receivable and, where the fee
    // names one, its own write-off account.
    for (const f of await fees.writeOffLines(c, l, round2(b.fees + b.nonScheduledFees))) {
      credits.push({ glCode: f.glReceivable, amount: f.amount, memberId: l.member_id });
      if (f.glWriteOff !== l.gl_writeoff_exp) debits.push({ glCode: f.glWriteOff, amount: f.amount, memberId: l.member_id });
    }
  }
  // The principal against the allowance held for it, then the expense.
  const provision = !funded && booksEntries(l) && b.principal > 0 ? await provisioning.attributable(c, l, { asAt: date }) : { amount: 0 };
  const allowanceUsed = round2(Math.min(provision.amount || 0, b.principal));
  if (allowanceUsed > 0) debits.push({ glCode: provisioning.GL_ALLOWANCE, amount: allowanceUsed, memberId: l.member_id });
  const booked = round2(credits.reduce((s, x) => s + x.amount, 0));
  const covered = round2(debits.reduce((s, x) => s + x.amount, 0));
  if (round2(booked - covered) > 0) debits.push({ glCode: l.gl_writeoff_exp, amount: round2(booked - covered), memberId: l.member_id });
  const entryId = booked > 0 ? await post(c, l, {
    debits,
    credits: credits.filter((x) => x.amount > 0),
    narration: narration || `Write off ${l.account_no}`,
    sourceType: 'LOAN_WRITE_OFF', sourceId: l.id, bookingDate: date, createdBy,
  }) : null;

  // Guarantors are called, not released: their pledge is what covers this.
  // Collateral is seized. Both are remembered so a reversal restores them.
  const { rows: called } = await c.query(
    "UPDATE loan_guarantors SET status = 'CALLED' WHERE loan_id = $1 AND status = 'PLEDGED' RETURNING id", [l.id]);
  const { rows: seized } = await c.query(
    "UPDATE loan_collateral SET status = 'SEIZED', released_at = now() WHERE loan_id = $1 AND status = 'PLEDGED' RETURNING id", [l.id]);
  await c.query(
    `UPDATE loan_accounts SET status = 'CLOSED_WRITTEN_OFF', closed_on = $2::date,
       written_off_amount = $3, written_off_on = $2::date, written_off_by = $4, updated_at = now()
     WHERE id = $1`, [l.id, date, b.total, createdBy || 'SYSTEM']);
  await workflow.history(c, l.id, { from: l.status, to: 'CLOSED_WRITTEN_OFF', action: 'WRITE_OFF', actor: createdBy, note: narration });
  // Fee income still deferred is recognised as the loan leaves the books.
  await FA.recogniseRemaining(c, l.id, { date, createdBy });

  return savings.record(c, {
    reference: savings.ref('LW'), kind: 'LOAN_WRITE_OFF', memberId: l.member_id,
    loanAccountId: l.id, amount: b.total, valueDate: date, entryId,
    allocation: {
      ...b, allowanceUsed, provision,
      previousStatus: l.status, calledGuarantors: called.map((g) => g.id), seizedCollateral: seized.map((k) => k.id),
    },
    narration, createdBy,
  });
}

// --------------------------------------------------------------------------
// Requests and approval
// --------------------------------------------------------------------------

async function pending(c, loanId) {
  const { rows: [r] } = await c.query(
    "SELECT * FROM loan_write_off_requests WHERE loan_id = $1 AND status = 'PENDING' FOR UPDATE", [loanId]);
  return r || null;
}

async function audit(c, actor, action, id, after) {
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,$2,'loan_write_off_request',$3,$4)`,
    [actor || 'SYSTEM', action, id, JSON.stringify(after)]);
}

/**
 * Ask for a loan to be written off. The same checks as the write-off run
 * now, so a request that could never be approved is refused at once. Where
 * the tenant does not require approval the write-off happens here and the
 * request is recorded as approved by the same user.
 */
async function requestWriteOff(c, loanId, { reason, narration, valueDate, createdBy, user = null } = {}) {
  const why = String(reason ?? narration ?? '').trim();
  if (!why) throw err('A_WRITE_OFF_NEEDS_A_REASON', 400);
  const l = await lock(c, loanId);
  if (!WRITABLE.includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  await workflow.assertMayWriteOff(c, l);
  const date = await writeOffDate(c, l, valueDate);
  const b = balances(l);
  if (b.total <= 0) throw err('NOTHING_TO_WRITE_OFF', 409);
  const open = await pending(c, l.id);
  if (open) throw err(`WRITE_OFF_ALREADY_REQUESTED: by ${open.requested_by}`, 409);

  const ctl = await workflow.controls(c);
  const needsApproval = ctl.write_off_requires_approval !== false;
  const { rows: [req] } = await c.query(
    `INSERT INTO loan_write_off_requests (loan_id, reason, value_date, amount_at_request, requested_by)
     VALUES ($1,$2,$3::date,$4,$5) RETURNING *`, [l.id, why, date, b.total, createdBy || 'SYSTEM']);
  await audit(c, createdBy, 'LOAN_WRITE_OFF_REQUESTED', req.id, { loan: l.account_no, amount: b.total, valueDate: date, reason: why });
  if (needsApproval) return { request: req, transaction: null };
  return decide(c, l.id, { approve: true, createdBy, user, selfApproved: true });
}

/**
 * Approve or reject the pending request. The approver may not be the one
 * who asked, and the amount written off must be within their approval limit.
 */
async function decide(c, loanId, { approve, note = null, createdBy, user = null, selfApproved = false } = {}) {
  const l = await lock(c, loanId);
  const req = await pending(c, l.id);
  if (!req) throw err('NO_PENDING_WRITE_OFF', 404);
  if (!approve) {
    const { rows: [out] } = await c.query(
      `UPDATE loan_write_off_requests SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3
       WHERE id = $1 RETURNING *`, [req.id, createdBy || 'SYSTEM', note]);
    await audit(c, createdBy, 'LOAN_WRITE_OFF_REJECTED', req.id, { loan: l.account_no, note });
    return { request: out, transaction: null };
  }
  if (!selfApproved && req.requested_by === (createdBy || 'SYSTEM')) {
    throw err('WRITE_OFF_REQUESTER_CANNOT_APPROVE: a second person approves a write-off', 403);
  }
  const lim = await workflow.userLimits(c, user);
  const amount = balances(l).total;
  if (lim.approval !== null && amount > Number(lim.approval)) {
    throw err(`ABOVE_YOUR_APPROVAL_LIMIT: limit ${Number(lim.approval)}, write-off ${amount}`, 403);
  }
  const tx = await writeOff(c, l.id, { narration: req.reason, valueDate: req.value_date, createdBy });
  const { rows: [out] } = await c.query(
    `UPDATE loan_write_off_requests SET status = 'APPROVED', decided_by = $2, decided_at = now(), decision_note = $3, transaction_id = $4
     WHERE id = $1 RETURNING *`, [req.id, createdBy || 'SYSTEM', note || (selfApproved ? 'approval not required by the tenant' : null), tx.id]);
  await audit(c, createdBy, 'LOAN_WRITE_OFF_APPROVED', req.id, { loan: l.account_no, amount: Number(tx.amount), transaction: tx.reference });
  return { request: out, transaction: tx };
}

async function requestsFor(c, loanId) {
  const { rows } = await c.query(
    `SELECT r.* FROM loan_write_off_requests r JOIN loan_accounts l ON l.id = r.loan_id
     WHERE l.id::text = $1 OR l.account_no = $1 ORDER BY r.requested_at DESC`, [loanId]);
  return rows;
}

/** The approver's queue. */
async function pendingRequests(c, source = {}) {
  return pageQuery(c,
    `SELECT r.*, l.account_no, l.branch_id, m.member_no, m.first_name, m.last_name
     FROM loan_write_off_requests r JOIN loan_accounts l ON l.id = r.loan_id JOIN members m ON m.id = l.member_id
     WHERE r.status = 'PENDING' ORDER BY r.requested_at`, [], source);
}

// --------------------------------------------------------------------------
// The register
// --------------------------------------------------------------------------

/**
 * Every written-off loan in a period (by write-off date), with what was
 * written off by component, how much of it the allowance took, who asked
 * and who approved and why, what has been recovered since (from guarantors
 * among it) and what is still owed. Totals are for the whole period, not
 * the page, and add the recoveries received in the period on loans written
 * off at any time.
 */
async function register(c, { from = null, to = null, branchId = null, ...source } = {}) {
  const params = [from || null, to || null, branchId || null];
  const where = `l.status = 'CLOSED_WRITTEN_OFF'
    AND ($1::date IS NULL OR l.written_off_on >= $1::date) AND ($2::date IS NULL OR l.written_off_on <= $2::date)
    AND ($3::uuid IS NULL OR l.branch_id = $3::uuid)`;
  const base = `
    SELECT l.id, l.account_no, l.product_id, l.branch_id, m.member_no, m.first_name, m.last_name,
           l.written_off_on, l.written_off_by, l.written_off_amount::float8 AS written_off_amount,
           l.recovered::float8 AS recovered, (l.written_off_amount - l.recovered)::float8 AS outstanding,
           COALESCE((t.allocation->>'principal')::float8, 0) AS principal,
           COALESCE((t.allocation->>'interest')::float8, 0) AS interest,
           COALESCE((t.allocation->>'fees')::float8, 0) AS fees,
           COALESCE((t.allocation->>'penalty')::float8, 0) AS penalty,
           COALESCE((t.allocation->>'allowanceUsed')::float8, 0) AS allowance_used,
           t.reference AS write_off_reference,
           r.reason, r.requested_by, r.decided_by AS approved_by,
           (SELECT count(*)::int FROM loan_guarantors g WHERE g.loan_id = l.id AND g.status IN ('CALLED', 'RECOVERED')) AS guarantors_called,
           (SELECT COALESCE(sum(g.recovered), 0)::float8 FROM loan_guarantors g WHERE g.loan_id = l.id) AS recovered_from_guarantors
    FROM loan_accounts l
    JOIN members m ON m.id = l.member_id
    LEFT JOIN LATERAL (SELECT reference, allocation FROM transactions
                       WHERE loan_account_id = l.id AND kind = 'LOAN_WRITE_OFF' AND reversed_by IS NULL
                       ORDER BY created_at DESC LIMIT 1) t ON true
    LEFT JOIN LATERAL (SELECT reason, requested_by, decided_by FROM loan_write_off_requests
                       WHERE loan_id = l.id AND status = 'APPROVED' ORDER BY decided_at DESC LIMIT 1) r ON true
    WHERE ${where}`;
  const page = await pageQuery(c, `${base} ORDER BY l.written_off_on DESC, l.account_no`, params, source);
  const { rows: [tot] } = await c.query(
    `SELECT count(*)::int AS loans, COALESCE(sum(written_off_amount), 0)::float8 AS written_off,
            COALESCE(sum(principal), 0)::float8 AS principal, COALESCE(sum(interest), 0)::float8 AS interest,
            COALESCE(sum(fees), 0)::float8 AS fees, COALESCE(sum(penalty), 0)::float8 AS penalty,
            COALESCE(sum(allowance_used), 0)::float8 AS allowance_used,
            COALESCE(sum(recovered), 0)::float8 AS recovered, COALESCE(sum(outstanding), 0)::float8 AS outstanding
     FROM (${base}) x`, params);
  const { rows: [inPeriod] } = await c.query(
    `SELECT COALESCE(sum(t.amount), 0)::float8 AS amount, count(*)::int AS n
     FROM transactions t JOIN loan_accounts l ON l.id = t.loan_account_id
     WHERE t.kind = 'LOAN_RECOVERY' AND t.reversed_by IS NULL
       AND ($1::date IS NULL OR t.value_date >= $1::date) AND ($2::date IS NULL OR t.value_date <= $2::date)
       AND ($3::uuid IS NULL OR l.branch_id = $3::uuid)`, params);
  const r2 = (x) => round2(x);
  return {
    from, to, branchId,
    ...page,
    totals: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, k === 'loans' ? v : r2(v)])),
    recoveriesInPeriod: { amount: r2(inPeriod.amount), count: inPeriod.n },
  };
}

// --------------------------------------------------------------------------
// Recoveries
// --------------------------------------------------------------------------

async function writtenOff(c, loanId) {
  const l = await lock(c, loanId);
  if (l.status !== 'CLOSED_WRITTEN_OFF') throw err(`LOAN_NOT_WRITTEN_OFF: ${l.status}`, 409);
  return { l, left: round2(Number(l.written_off_amount) - Number(l.recovered)) };
}

/** Where recovered money is credited: Recoveries, or suspense for a product not linked to accounting. */
async function recoveryCredit(c, l, amount) {
  return { glCode: booksEntries(l) ? l.gl_recoveries : await PA.suspense(c), amount, memberId: l.member_id, branchId: l.branch_id };
}

/** Money recovered on a written-off loan through a channel. */
async function recover(c, loanId, { amount, channelId = 'cash', source = 'MEMBER', collateralId = null, valueDate, narration, createdBy } = {}) {
  const { l, left } = await writtenOff(c, loanId);
  if (!SOURCES.includes(source)) throw err(`RECOVERY_SOURCE_MUST_BE_ONE_OF: ${SOURCES.join(', ')} (guarantors: /guarantors/:id/recover)`, 400);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT', 400);
  if (amt > left) throw err(`RECOVERY_EXCEEDS_WRITTEN_OFF_BALANCE: ${left} left of ${Number(l.written_off_amount)}`, 409);
  if (collateralId) {
    const { rowCount } = await c.query("SELECT 1 FROM loan_collateral WHERE id = $1 AND loan_id = $2 AND status = 'SEIZED'", [collateralId, l.id]);
    if (!rowCount) throw err('COLLATERAL_NOT_SEIZED_ON_THIS_LOAN', 409);
  }
  const { rows: [ch] } = await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId]);
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);
  const date = valueDate ? ymd(valueDate) : today();

  // The cash is real whether or not the product is linked to accounting.
  const { entryId } = await acct.post(c, {
    debits: [{ glCode: ch.gl_account_code, amount: amt, memberId: l.member_id, branchId: l.branch_id }],
    credits: [await recoveryCredit(c, l, amt)],
    narration: narration || `Recovery on written-off loan ${l.account_no}`,
    sourceType: 'LOAN_RECOVERY', sourceId: l.id, channelId, bookingDate: date, createdBy, branchId: l.branch_id || null,
  });
  await c.query('UPDATE loan_accounts SET recovered = recovered + $1, updated_at = now() WHERE id = $2', [amt, l.id]);
  return savings.record(c, {
    reference: savings.ref('LR'), kind: 'LOAN_RECOVERY', memberId: l.member_id, loanAccountId: l.id,
    channelId, amount: amt, valueDate: date, entryId,
    allocation: { source, collateralId, left: round2(left - amt) },
    narration, createdBy,
  });
}

async function calledGuarantor(c, loanId, guarantorId) {
  const { rows: [g] } = await c.query(
    'SELECT * FROM loan_guarantors WHERE id = $1 AND loan_id = $2 FOR UPDATE', [guarantorId, loanId]);
  if (!g) throw err('GUARANTOR_NOT_FOUND_ON_THIS_LOAN', 404);
  if (g.status !== 'CALLED') throw err(`GUARANTOR_NOT_CALLED: ${g.status}`, 409);
  return { g, callLeft: round2(Number(g.pledged_amount) - Number(g.recovered)) };
}

/**
 * Take what a called guarantor owes from their deposits. Their other pledges
 * stay covered: only deposits beyond those (and beyond the account's minimum
 * balance) can be taken. The deposits need not be withdrawable; offsetting a
 * called pledge against them is what the pledge was for.
 */
async function recoverFromGuarantor(c, loanId, guarantorId, { amount = null, savingsAccountId = null, valueDate, narration, createdBy } = {}) {
  const { l, left } = await writtenOff(c, loanId);
  const { g, callLeft } = await calledGuarantor(c, l.id, guarantorId);
  const amt = round2(amount ?? Math.min(callLeft, left));
  if (!(amt > 0)) throw err('NOTHING_TO_RECOVER', 409);
  if (amt > callLeft) throw err(`EXCEEDS_CALLED_PLEDGE: ${callLeft} left of ${Number(g.pledged_amount)}`, 409);
  if (amt > left) throw err(`RECOVERY_EXCEEDS_WRITTEN_OFF_BALANCE: ${left} left`, 409);

  // Deposits committed elsewhere: every pledge the guarantor has, less the
  // part of this call being taken now.
  const otherCommitments = round2(await savings.pledgedAmount(c, g.member_id) - callLeft);
  const free = (a) => round2(Number(a.balance) - Number(a.min_balance || 0) - Math.max(0, otherCommitments));
  let a = null;
  if (savingsAccountId) {
    a = await savings.lock(c, savingsAccountId);
    if (a.member_id !== g.member_id) throw err('ACCOUNT_NOT_THE_GUARANTORS', 409);
  } else {
    const { rows } = await c.query(
      `SELECT a.id FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
       WHERE a.member_id = $1 AND a.status = 'ACTIVE' AND NOT p.is_funding_account ORDER BY a.opened_on, a.id`, [g.member_id]);
    for (const r of rows) {
      const cand = await savings.lock(c, r.id);
      if (free(cand) >= amt) { a = cand; break; }
    }
    if (!a) throw err(`GUARANTOR_HAS_INSUFFICIENT_DEPOSITS: no one account holds ${amt} beyond their other commitments`, 409);
  }
  if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (free(a) < amt) throw err(`GUARANTOR_HAS_INSUFFICIENT_DEPOSITS: ${Math.max(0, free(a))} free in ${a.account_no}`, 409);
  const date = valueDate ? ymd(valueDate) : today();

  // Dr the guarantor's deposits (or suspense), Cr Recoveries (or suspense).
  const debit = a.accounting_method !== 'NONE'
    ? savings.outLegs(a, amt).debits
    : [{ glCode: await PA.suspense(c), amount: amt, memberId: g.member_id, branchId: a.branch_id }];
  const credit = await recoveryCredit(c, l, amt);
  const both = debit.length === 1 && debit[0].glCode === credit.glCode;
  const entryId = both ? null : (await acct.post(c, {
    debits: debit, credits: [credit],
    narration: narration || `Guarantor recovery ${a.account_no} for written-off loan ${l.account_no}`,
    sourceType: 'LOAN_RECOVERY', sourceId: l.id, bookingDate: date, createdBy, branchId: l.branch_id || null,
  })).entryId;
  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, a.id]);
  await c.query(
    `UPDATE loan_guarantors SET recovered = recovered + $1,
       status = CASE WHEN recovered + $1 >= pledged_amount THEN 'RECOVERED' ELSE 'CALLED' END
     WHERE id = $2`, [amt, g.id]);
  await c.query('UPDATE loan_accounts SET recovered = recovered + $1, updated_at = now() WHERE id = $2', [amt, l.id]);
  return savings.record(c, {
    reference: savings.ref('LR'), kind: 'LOAN_RECOVERY', memberId: g.member_id, loanAccountId: l.id, savingsAccountId: a.id,
    amount: amt, valueDate: date, entryId, branchId: l.branch_id,
    allocation: { source: 'GUARANTOR', guarantorId: g.id, guarantorMemberId: g.member_id, savingsAccountId: a.id,
      callLeft: round2(callLeft - amt), left: round2(left - amt) },
    narration, createdBy,
  });
}

/** Forgo the rest of a called pledge: the guarantor's deposits are free again. */
async function releaseCall(c, loanId, guarantorId, { note = null, createdBy } = {}) {
  const { l } = await writtenOff(c, loanId);
  const { g, callLeft } = await calledGuarantor(c, l.id, guarantorId);
  const { rows: [out] } = await c.query("UPDATE loan_guarantors SET status = 'RELEASED' WHERE id = $1 RETURNING *", [g.id]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,'GUARANTOR_CALL_RELEASED','loan_guarantor',$2,$3,$4)`,
    [createdBy || 'SYSTEM', g.id, JSON.stringify({ status: 'CALLED', callLeft }), JSON.stringify({ status: 'RELEASED', note, loan: l.account_no })]);
  return out;
}

// --------------------------------------------------------------------------
// Reversal
// --------------------------------------------------------------------------

async function recordReversal(c, tx, entryId, { narration, createdBy }) {
  const rev = await savings.record(c, {
    reference: savings.ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    loanAccountId: tx.loan_account_id, savingsAccountId: tx.savings_account_id, amount: -tx.amount, entryId,
    allocation: { reversalOf: tx.reference }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

/**
 * Reverse a LOAN_WRITE_OFF or LOAN_RECOVERY transaction (already locked and
 * checked unreversed by the caller). A write-off comes back only when no
 * recovery stands against it, and the loan returns to the state, guarantors
 * and collateral it had.
 */
async function reverse(c, tx, { narration = 'Reversal', createdBy } = {}) {
  const l = await lock(c, tx.loan_account_id);
  const a = tx.allocation || {};
  if (tx.kind === 'LOAN_WRITE_OFF') {
    if (l.status !== 'CLOSED_WRITTEN_OFF') throw err(`LOAN_NOT_WRITTEN_OFF: ${l.status}`, 409);
    const { rows: [r] } = await c.query(
      "SELECT count(*)::int AS n FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_RECOVERY' AND reversed_by IS NULL", [l.id]);
    if (r.n > 0) throw err(`WRITE_OFF_HAS_RECOVERIES: reverse the ${r.n} recoveries first`, 409);
    const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
    // Write-offs recorded before these lists were kept restore every called
    // guarantor and seized asset on the loan.
    const guarantors = a.calledGuarantors
      || (await c.query("SELECT id FROM loan_guarantors WHERE loan_id = $1 AND status = 'CALLED'", [l.id])).rows.map((x) => x.id);
    const collateral = a.seizedCollateral
      || (await c.query("SELECT id FROM loan_collateral WHERE loan_id = $1 AND status = 'SEIZED'", [l.id])).rows.map((x) => x.id);
    await c.query("UPDATE loan_guarantors SET status = 'PLEDGED' WHERE id = ANY($1::uuid[]) AND status IN ('CALLED', 'RELEASED')", [guarantors]);
    await c.query("UPDATE loan_collateral SET status = 'PLEDGED', released_at = NULL WHERE id = ANY($1::uuid[])", [collateral]);
    const back = a.previousStatus || (l.arrears_since ? 'IN_ARREARS' : 'ACTIVE');
    await c.query(
      `UPDATE loan_accounts SET status = $2, closed_on = NULL, written_off_amount = 0, written_off_on = NULL,
         written_off_by = NULL, updated_at = now() WHERE id = $1`, [l.id, back]);
    await workflow.history(c, l.id, { from: l.status, to: back, action: 'UNDO_WRITE_OFF', actor: createdBy, note: narration });
    await FA.undoClosure(c, l.id, { createdBy, narration });
    return recordReversal(c, tx, entry.entryId, { narration, createdBy });
  }
  if (tx.kind === 'LOAN_RECOVERY') {
    const amt = Number(tx.amount);
    const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
    await c.query('UPDATE loan_accounts SET recovered = recovered - $1, updated_at = now() WHERE id = $2', [amt, l.id]);
    if (a.source === 'GUARANTOR') {
      await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, a.savingsAccountId]);
      await c.query("UPDATE loan_guarantors SET recovered = recovered - $1, status = 'CALLED' WHERE id = $2", [amt, a.guarantorId]);
    }
    return recordReversal(c, tx, entry.entryId, { narration, createdBy });
  }
  throw err(`NOT_A_WRITE_OFF_TRANSACTION: ${tx.kind}`, 409);
}

module.exports = {
  writeOff, requestWriteOff, decide, requestsFor, pendingRequests, register,
  recover, recoverFromGuarantor, releaseCall, reverse, SOURCES,
};
