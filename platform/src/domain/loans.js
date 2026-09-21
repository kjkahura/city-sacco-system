'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const { err, round2 } = acct;

/**
 * Loan lifecycle, SQL-backed. Every function takes an open tenant client.
 *
 * Balance columns are only ever changed by SQL expressions on the numeric
 * type. Nothing is read into JS, adjusted and written back, so two tellers
 * posting repayments to the same loan cannot lose one of them.
 */

const TRANSITIONS = {
  SUBMIT:   { from: ['DRAFT'], to: 'PENDING_APPROVAL' },
  APPROVE:  { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  UNAPPROVE:{ from: ['APPROVED'], to: 'PENDING_APPROVAL' },
  REJECT:   { from: ['DRAFT', 'PENDING_APPROVAL'], to: 'CLOSED_REJECTED' },
  WITHDRAW: { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'], to: 'CLOSED_WITHDRAWN' },
};

async function lock(c, loanId) {
  const { rows } = await c.query(
    `SELECT l.*, p.method, p.gl_portfolio, p.gl_interest_inc, p.gl_fee_inc,
            p.processing_fee, p.max_multiplier, p.monthly_rate AS product_rate
     FROM loan_accounts l
     JOIN loan_products p ON p.id = l.product_id
     WHERE l.id = $1 OR l.account_no = $1::text
     FOR UPDATE OF l`,
    [loanId]
  );
  if (!rows.length) throw err('LOAN_NOT_FOUND', 404);
  return rows[0];
}

function balances(l) {
  const principal = round2(l.principal_disbursed - l.principal_paid);
  const interest = round2(l.interest_accrued - l.interest_paid);
  const fees = round2(l.fees_due - l.fees_paid);
  const penalty = round2(l.penalty_accrued - l.penalty_paid);
  return {
    principal, interest, fees, penalty,
    total: round2(principal + interest + fees + penalty),
  };
}

// --------------------------------------------------------------------------
// Schedule
// --------------------------------------------------------------------------

async function shiftOffClosedDays(c, iso) {
  // Weekends and anything in the holidays table push the due date forward.
  // A repayment cannot fall due on a day the SACCO is shut.
  const { rows: [r] } = await c.query(
    `WITH RECURSIVE d(day, n) AS (
       SELECT $1::date, 0
       UNION ALL
       SELECT day + 1, n + 1 FROM d
       WHERE n < 10 AND (
         EXTRACT(dow FROM day) IN (0, 6)
         OR EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = day)
       )
     )
     SELECT max(day) AS day FROM d`,
    [iso]
  );
  return r.day;
}

/**
 * Flat-rate schedule: interest is a fixed percentage of original principal
 * each period, which is how the Kenyan SACCO products here are priced.
 * REDUCING is modelled but products default to FLAT.
 */
async function buildSchedule(c, l, { persist = true } = {}) {
  const principal = Number(l.principal);
  const months = Number(l.term_months);
  const rate = Number(l.monthly_rate ?? l.product_rate) / 100;
  if (!principal || !months) throw err('LOAN_MISSING_PRINCIPAL_OR_TERM');

  const start = l.disbursed_on ? new Date(l.disbursed_on) : new Date();
  const perPrincipal = round2(principal / months);
  const installments = [];

  let remaining = principal;
  let outstanding = principal;
  for (let n = 1; n <= months; n += 1) {
    const interest = l.method === 'REDUCING'
      ? round2(outstanding * rate)
      : round2(principal * rate);

    const principalAmt = n === months ? round2(remaining) : perPrincipal;
    remaining = round2(remaining - principalAmt);
    outstanding = round2(outstanding - principalAmt);

    const due = new Date(start);
    due.setUTCMonth(due.getUTCMonth() + n);
    const dueDate = await shiftOffClosedDays(c, due.toISOString().slice(0, 10));

    installments.push({
      number: n,
      dueDate,
      principal: principalAmt,
      interest,
      fee: n === 1 ? round2(l.processing_fee || 0) : 0,
    });
  }

  if (persist) {
    await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [l.id]);
    for (const i of installments) {
      await c.query(
        `INSERT INTO loan_installments (loan_id, number, due_date, principal_due, interest_due, fee_due)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [l.id, i.number, i.dueDate, i.principal, i.interest, i.fee]
      );
    }
  }

  return {
    loanId: l.id,
    method: l.method,
    totals: {
      principal,
      interest: round2(installments.reduce((s, i) => s + i.interest, 0)),
      fees: round2(installments.reduce((s, i) => s + i.fee, 0)),
    },
    installments,
  };
}

// --------------------------------------------------------------------------
// Guarantors. The SACCO-specific piece: members pledge their own deposits.
// --------------------------------------------------------------------------

async function addGuarantor(c, loanId, { memberId, amount }) {
  const l = await lock(c, loanId);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(l.status)) {
    throw err(`CANNOT_ADD_GUARANTOR_IN_STATE: ${l.status}`, 409);
  }
  if (memberId === l.member_id) throw err('MEMBER_CANNOT_GUARANTEE_OWN_LOAN');
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_PLEDGE_AMOUNT');

  // The guarantor must actually have the deposits they are pledging, net of
  // anything already pledged elsewhere.
  const { rows: [bal] } = await c.query(
    'SELECT COALESCE(SUM(balance), 0) AS total FROM savings_accounts WHERE member_id = $1 AND status = $2',
    [memberId, 'ACTIVE']
  );
  const alreadyPledged = await savings.pledgedAmount(c, memberId);
  const free = round2(bal.total - alreadyPledged);
  if (amt > free) {
    throw err(`GUARANTOR_HAS_INSUFFICIENT_FREE_DEPOSITS: free ${free}, pledged ${amt}`, 409);
  }

  const { rows } = await c.query(
    `INSERT INTO loan_guarantors (loan_id, member_id, pledged_amount) VALUES ($1,$2,$3) RETURNING *`,
    [l.id, memberId, amt]
  );
  return rows[0];
}

async function guarantorCoverage(c, loanId) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(pledged_amount), 0) AS pledged
     FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED'`,
    [loanId]
  );
  return round2(r.pledged);
}

async function releaseGuarantors(c, loanId) {
  await c.query(
    "UPDATE loan_guarantors SET status = 'RELEASED' WHERE loan_id = $1 AND status = 'PLEDGED'",
    [loanId]
  );
}

// --------------------------------------------------------------------------
// Eligibility
// --------------------------------------------------------------------------

/** The SACCO rule: you may borrow up to N times your own deposits. */
async function checkEligibility(c, { memberId, productId, principal }) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  const { rows: [d] } = await c.query(
    "SELECT COALESCE(SUM(balance), 0) AS total FROM savings_accounts WHERE member_id = $1 AND status = 'ACTIVE'",
    [memberId]
  );
  const deposits = round2(d.total);
  const ceiling = round2(deposits * Number(p.max_multiplier));
  return {
    deposits,
    multiplier: Number(p.max_multiplier),
    ceiling,
    requested: round2(principal),
    eligible: round2(principal) <= ceiling,
    shortfall: round2(Math.max(0, principal - ceiling)),
  };
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

async function apply(c, { memberId, productId = 'NL01', principal, termMonths, accountNo, createdBy }) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1 AND is_active', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  if (termMonths > p.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${p.max_term}`, 400);

  const no = accountNo || (await c.query(
    `SELECT 'LN' || lpad((count(*)+1)::text, 6, '0') AS n FROM loan_accounts`)).rows[0].n;

  const { rows } = await c.query(
    `INSERT INTO loan_accounts (account_no, member_id, product_id, principal, term_months, monthly_rate, status)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING_APPROVAL') RETURNING *`,
    [no, memberId, productId, round2(principal), termMonths, p.monthly_rate]
  );
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'LOAN_APPLIED','loan_account',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]
  );
  return rows[0];
}

async function changeState(c, loanId, action, { createdBy } = {}) {
  const l = await lock(c, loanId);
  const t = TRANSITIONS[String(action).toUpperCase()];
  if (!t) throw err(`UNSUPPORTED_ACTION: ${action}`);
  if (!t.from.includes(l.status)) {
    throw err(`INVALID_STATE_TRANSITION: ${l.status} -> ${t.to}`, 409);
  }
  const { rows } = await c.query(
    `UPDATE loan_accounts SET status = $1, updated_at = now(),
       approved_on = CASE WHEN $1 = 'APPROVED' THEN current_date ELSE approved_on END
     WHERE id = $2 RETURNING *`,
    [t.to, l.id]
  );
  if (['CLOSED_REJECTED', 'CLOSED_WITHDRAWN'].includes(t.to)) await releaseGuarantors(c, l.id);

  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,$2,'loan_account',$3,$4,$5)`,
    [createdBy || 'SYSTEM', `LOAN_${t.to}`, l.id,
     JSON.stringify({ status: l.status }), JSON.stringify({ status: t.to })]
  );
  return rows[0];
}

async function disburse(c, loanId, { amount, channelId = 'bank', valueDate, narration, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (l.status !== 'APPROVED') throw err(`LOAN_NOT_APPROVED: ${l.status}`, 409);
  const amt = round2(amount ?? l.principal);
  if (!(amt > 0)) throw err('INVALID_DISBURSEMENT_AMOUNT');

  const { rows: [ch] } = await c.query(
    'SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId]
  );
  if (!ch) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${channelId}`);
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const entry = await acct.post(c, {
    debits: [{ glCode: l.gl_portfolio, amount: amt, memberId: l.member_id }],
    credits: [{ glCode: ch.gl_account_code, amount: amt, memberId: l.member_id }],
    narration: narration || `Disbursement ${l.account_no}`,
    sourceType: 'LOAN_DISBURSEMENT', sourceId: l.id, channelId,
    bookingDate: valueDate, createdBy,
  });

  const { rows } = await c.query(
    `UPDATE loan_accounts
     SET principal_disbursed = principal_disbursed + $1,
         fees_due = fees_due + $2,
         status = 'ACTIVE',
         disbursed_on = COALESCE($3::date, current_date),
         updated_at = now()
     WHERE id = $4 RETURNING *`,
    [amt, round2(l.processing_fee || 0), valueDate || null, l.id]
  );

  // Fee is income at disbursement, carried on the loan until repaid.
  if (Number(l.processing_fee) > 0) {
    await acct.post(c, {
      debits: [{ glCode: l.gl_portfolio, amount: l.processing_fee, memberId: l.member_id }],
      credits: [{ glCode: l.gl_fee_inc || l.gl_interest_inc, amount: l.processing_fee, memberId: l.member_id }],
      narration: `Processing fee ${l.account_no}`,
      sourceType: 'LOAN_FEE', sourceId: l.id, bookingDate: valueDate, createdBy,
    });
  }

  const fresh = { ...rows[0], method: l.method, product_rate: l.product_rate, processing_fee: l.processing_fee };
  await buildSchedule(c, fresh);

  return savings.record(c, {
    reference: savings.ref('LD'), kind: 'LOAN_DISBURSEMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: amt, valueDate,
    entryId: entry.entryId, narration, createdBy,
  });
}

/**
 * Repayment allocation: penalty, then fees, then interest, then principal.
 * Anything left over goes to the member's savings rather than sitting as an
 * unexplained credit on the loan.
 */
async function repay(c, loanId, { amount, channelId = 'mpesa', valueDate, narration, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  let left = round2(amount);
  if (!(left > 0)) throw err('INVALID_REPAYMENT_AMOUNT');

  const ch = (await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId])).rows[0];
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);

  const b = balances(l);
  const take = (due) => { const t = round2(Math.min(left, Math.max(0, due))); left = round2(left - t); return t; };
  const penalty = take(b.penalty);
  const fees = take(b.fees);
  const interest = take(b.interest);
  const principal = take(b.principal);
  const surplus = round2(left);
  const total = round2(penalty + fees + interest + principal + surplus);

  const credits = [];
  if (principal) credits.push({ glCode: l.gl_portfolio, amount: principal, memberId: l.member_id });
  if (interest) credits.push({ glCode: l.gl_interest_inc, amount: interest, memberId: l.member_id });
  if (fees) credits.push({ glCode: l.gl_portfolio, amount: fees, memberId: l.member_id });
  if (penalty) credits.push({ glCode: l.gl_interest_inc, amount: penalty, memberId: l.member_id });

  let surplusAccount = null;
  if (surplus > 0) {
    const { rows } = await c.query(
      `SELECT a.id, p.gl_liability FROM savings_accounts a
       JOIN savings_products p ON p.id = a.product_id
       WHERE a.member_id = $1 AND a.status = 'ACTIVE' ORDER BY a.opened_on LIMIT 1`,
      [l.member_id]
    );
    if (!rows.length) throw err('OVERPAYMENT_WITH_NO_SAVINGS_ACCOUNT_TO_RECEIVE_IT', 409);
    surplusAccount = rows[0];
    credits.push({ glCode: surplusAccount.gl_liability, amount: surplus, memberId: l.member_id });
  }

  const entry = await acct.post(c, {
    debits: [{ glCode: ch.gl_account_code, amount: total, memberId: l.member_id }],
    credits,
    narration: narration || `Repayment ${l.account_no}`,
    sourceType: 'LOAN_REPAYMENT', sourceId: l.id, channelId,
    bookingDate: valueDate, createdBy,
  });

  await c.query(
    `UPDATE loan_accounts SET
       penalty_paid = penalty_paid + $1, fees_paid = fees_paid + $2,
       interest_paid = interest_paid + $3, principal_paid = principal_paid + $4,
       updated_at = now()
     WHERE id = $5`,
    [penalty, fees, interest, principal, l.id]
  );
  if (surplusAccount) {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2',
      [surplus, surplusAccount.id]);
  }

  await applyToInstallments(c, l.id, { principal, interest, fees });

  const after = balances((await lock(c, l.id)));
  if (after.total <= 0) {
    await c.query("UPDATE loan_accounts SET status = 'CLOSED_REPAID', updated_at = now() WHERE id = $1", [l.id]);
    await releaseGuarantors(c, l.id);
  }

  return savings.record(c, {
    reference: savings.ref('LR'), kind: 'LOAN_REPAYMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: total, valueDate, entryId: entry.entryId,
    allocation: { penalty, fees, interest, principal, surplus },
    narration, createdBy,
  });
}

async function applyToInstallments(c, loanId, { principal, interest, fees }) {
  const { rows } = await c.query(
    `SELECT * FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID' ORDER BY number`,
    [loanId]
  );
  let p = principal, i = interest, f = fees;
  for (const inst of rows) {
    if (!p && !i && !f) break;
    const pa = round2(Math.min(p, inst.principal_due - inst.principal_paid));
    const ia = round2(Math.min(i, inst.interest_due - inst.interest_paid));
    const fa = round2(Math.min(f, inst.fee_due - inst.fee_paid));
    p = round2(p - pa); i = round2(i - ia); f = round2(f - fa);

    await c.query(
      `UPDATE loan_installments SET
         principal_paid = principal_paid + $1,
         interest_paid = interest_paid + $2,
         fee_paid = fee_paid + $3,
         status = CASE
           WHEN principal_paid + $1 >= principal_due
            AND interest_paid + $2 >= interest_due
            AND fee_paid + $3 >= fee_due THEN 'PAID'
           WHEN principal_paid + $1 > 0 OR interest_paid + $2 > 0 THEN 'PARTIALLY_PAID'
           ELSE status END
       WHERE id = $4`,
      [pa, ia, fa, inst.id]
    );
  }
}

async function accrueInterest(c, loanId, { valueDate, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) return null;
  const rate = Number(l.monthly_rate) / 100;
  const base = l.method === 'REDUCING'
    ? round2(l.principal_disbursed - l.principal_paid)
    : Number(l.principal);
  const amt = round2(base * rate);
  if (!(amt > 0)) return null;

  const entry = await acct.post(c, {
    debits: [{ glCode: '100-300', amount: amt, memberId: l.member_id }],
    credits: [{ glCode: l.gl_interest_inc, amount: amt, memberId: l.member_id }],
    narration: `Interest accrual ${l.account_no}`,
    sourceType: 'LOAN_INTEREST_ACCRUAL', sourceId: l.id, bookingDate: valueDate, createdBy,
  });
  await c.query(
    'UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, updated_at = now() WHERE id = $2',
    [amt, l.id]
  );
  return savings.record(c, {
    reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
    loanAccountId: l.id, amount: amt, valueDate, entryId: entry.entryId, createdBy,
  });
}

async function writeOff(c, loanId, { narration, createdBy } = {}) {
  const l = await lock(c, loanId);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  const b = balances(l);
  if (b.total <= 0) throw err('NOTHING_TO_WRITE_OFF', 409);

  const entry = await acct.post(c, {
    debits: [{ glCode: '500-300', amount: b.total, memberId: l.member_id }],
    credits: [{ glCode: l.gl_portfolio, amount: b.total, memberId: l.member_id }],
    narration: narration || `Write off ${l.account_no}`,
    sourceType: 'LOAN_WRITE_OFF', sourceId: l.id, createdBy,
  });
  await c.query(
    "UPDATE loan_accounts SET status = 'CLOSED_WRITTEN_OFF', updated_at = now() WHERE id = $1", [l.id]
  );
  // Guarantors are called, not released: their pledge is what covers this.
  await c.query(
    "UPDATE loan_guarantors SET status = 'CALLED' WHERE loan_id = $1 AND status = 'PLEDGED'", [l.id]
  );

  return savings.record(c, {
    reference: savings.ref('LW'), kind: 'LOAN_WRITE_OFF', memberId: l.member_id,
    loanAccountId: l.id, amount: b.total, entryId: entry.entryId,
    allocation: b, narration, createdBy,
  });
}

async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy } = {}) {
  const { rows } = await c.query('SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]);
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.loan_account_id) throw err('NOT_A_LOAN_TRANSACTION');

  const entry = await acct.reverse(c, tx.entry_id, narration, createdBy);
  const a = tx.allocation || {};

  if (tx.kind === 'LOAN_REPAYMENT') {
    await c.query(
      `UPDATE loan_accounts SET
         penalty_paid = penalty_paid - $1, fees_paid = fees_paid - $2,
         interest_paid = interest_paid - $3, principal_paid = principal_paid - $4,
         status = CASE WHEN status = 'CLOSED_REPAID' THEN 'ACTIVE' ELSE status END,
         updated_at = now()
       WHERE id = $5`,
      [a.penalty || 0, a.fees || 0, a.interest || 0, a.principal || 0, tx.loan_account_id]
    );
    if (a.surplus > 0) {
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1
         WHERE member_id = $2 AND status = 'ACTIVE'
           AND id = (SELECT id FROM savings_accounts WHERE member_id = $2 AND status = 'ACTIVE' ORDER BY opened_on LIMIT 1)`,
        [a.surplus, tx.member_id]
      );
    }
    // Rebuild installment allocation from what survives.
    await c.query(
      `UPDATE loan_installments SET principal_paid = 0, interest_paid = 0, fee_paid = 0, status = 'PENDING'
       WHERE loan_id = $1`, [tx.loan_account_id]
    );
    const { rows: remaining } = await c.query(
      `SELECT COALESCE(SUM((allocation->>'principal')::numeric),0) AS p,
              COALESCE(SUM((allocation->>'interest')::numeric),0)  AS i,
              COALESCE(SUM((allocation->>'fees')::numeric),0)      AS f
       FROM transactions
       WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT'
         AND reversed_by IS NULL AND id <> $2`,
      [tx.loan_account_id, tx.id]
    );
    await applyToInstallments(c, tx.loan_account_id, {
      principal: Number(remaining[0].p), interest: Number(remaining[0].i), fees: Number(remaining[0].f),
    });
  } else if (tx.kind === 'LOAN_DISBURSEMENT') {
    await c.query(
      `UPDATE loan_accounts SET principal_disbursed = principal_disbursed - $1,
         status = 'APPROVED', disbursed_on = NULL, updated_at = now() WHERE id = $2`,
      [tx.amount, tx.loan_account_id]
    );
  }

  const rev = await savings.record(c, {
    reference: savings.ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    loanAccountId: tx.loan_account_id, amount: -tx.amount, entryId: entry.entryId,
    allocation: { reversalOf: tx.reference }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

/** Mark overdue installments and flip the loan into arrears. */
async function markArrears(c, { asOf = null } = {}) {
  await c.query(
    `UPDATE loan_installments SET status = 'OVERDUE'
     WHERE status IN ('PENDING','PARTIALLY_PAID')
       AND due_date < COALESCE($1::date, current_date)`,
    [asOf]
  );
  const { rows } = await c.query(
    `UPDATE loan_accounts l SET status = 'IN_ARREARS', updated_at = now()
     WHERE l.status = 'ACTIVE'
       AND EXISTS (SELECT 1 FROM loan_installments i WHERE i.loan_id = l.id AND i.status = 'OVERDUE')
     RETURNING l.id, l.account_no`
  );
  return rows;
}

module.exports = {
  TRANSITIONS, lock, balances, buildSchedule, shiftOffClosedDays,
  apply, changeState, disburse, repay, accrueInterest, writeOff,
  reverseTransaction, addGuarantor, guarantorCoverage, releaseGuarantors,
  checkEligibility, markArrears, applyToInstallments,
};
