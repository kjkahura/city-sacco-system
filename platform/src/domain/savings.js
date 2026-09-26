'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const PA = require('./productAccounting');
const accruals = require('./accruals');
const { err, round2 } = acct;

/**
 * Deposit accounts. Every function takes an open tenant client.
 *
 * Balances are mutated in SQL on the numeric column, never read into JS,
 * changed, and written back. That closes the read-modify-write race two
 * tellers posting to the same account at once would otherwise hit, and it
 * keeps the arithmetic in exact decimal rather than binary float.
 *
 * Accounting follows the product, after Mambu's deposit rules:
 *
 *   Deposit                  Dr Transaction Source      Cr Savings Control
 *   Withdrawal               Dr Savings Control         Cr Transaction Source
 *   Fee applied              Dr Savings Control         Cr Fee Income
 *   Withholding tax          Dr Savings Control         Cr Taxes Payable
 *   Interest accrued         Dr Interest Expense        Cr Interest Payable      (ACCRUAL)
 *   Interest applied         Dr Interest Payable        Cr Savings Control       (ACCRUAL)
 *                            Dr Interest Expense        Cr Savings Control       (CASH)
 *   Negative interest        Dr Neg. Interest Rec.      Cr Neg. Interest Income  (accrued, ACCRUAL)
 *                            Dr Savings Control         Cr Neg. Interest Rec./Income
 *   Overdraft withdrawal     Dr Overdraft Portfolio     Cr Transaction Source
 *   Overdraft repaid         Dr Transaction Source      Cr Overdraft Portfolio
 *   Overdraft interest       Dr OD Interest Receivable  Cr OD Interest Income    (accrued, ACCRUAL)
 *                            Dr Overdraft Portfolio     Cr OD Interest Rec.      (applied, ACCRUAL)
 *   Overdraft write-off      Dr OD Write-off Expense    Cr Overdraft Portfolio
 *
 * Under CASH, overdraft interest and fees applied to an overdrawn balance
 * are owed but not yet income (od_interest_due, od_fees_due); the deposit
 * that pays them recognises them. Under NONE the product's legs are not
 * posted and the channel's leg goes against the tenant's suspense account.
 *
 * A movement that crosses zero is split: the part above zero moves Savings
 * Control, the part below moves the Overdraft Portfolio.
 */

const PRODUCT_COLUMNS = `
  p.name AS product_name, p.gl_liability, p.gl_interest_exp, p.gl_interest_payable, p.gl_fee_inc, p.gl_tax_payable,
  p.gl_neg_interest_inc, p.gl_neg_interest_rec, p.gl_od_portfolio, p.gl_od_writeoff, p.gl_od_interest_inc,
  p.gl_od_interest_rec, p.withdrawable, p.min_balance, p.annual_rate, p.is_funding_account,
  p.accounting_method, p.interest_accrued_accounting, p.accrual_granularity, p.interest_paid_into_account,
  p.interest_calc_balance, p.interest_day_count, p.interest_application, p.min_balance_for_interest,
  p.allow_negative_rate, p.withholding_tax_percent, p.allow_overdraft, p.max_overdraft_limit,
  p.overdraft_annual_rate, p.allow_technical_overdraft`;

async function lock(c, accountId) {
  const { rows } = await c.query(
    `SELECT a.*, ${PRODUCT_COLUMNS}
     FROM savings_accounts a
     JOIN savings_products p ON p.id = a.product_id
     WHERE a.id::text = $1 OR a.account_no = $1
     FOR UPDATE OF a`,
    [accountId]
  );
  if (!rows.length) throw err('SAVINGS_ACCOUNT_NOT_FOUND', 404);
  return rows[0];
}

async function channel(c, id) {
  const { rows } = await c.query(
    'SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [id]
  );
  if (!rows.length) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${id}`);
  return rows[0];
}

const books = (a) => a.accounting_method !== 'NONE';
const accrues = (a) => PA.accrues(a);

/**
 * What a member's deposits are committed to: guarantor pledges on others'
 * loans (called ones until recovered or released), and funding pledged on
 * approved loans not yet disbursed.
 */
async function pledgedAmount(c, memberId) {
  // A called pledge (the loan was written off) stays committed for what has
  // not yet been recovered from it.
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'PLEDGED' THEN pledged_amount ELSE pledged_amount - recovered END), 0) AS total
     FROM loan_guarantors WHERE member_id = $1 AND status IN ('PLEDGED', 'CALLED')`,
    [memberId]
  );
  const locked = await lockedFunding(c, memberId);
  return round2(Number(r.total) + locked);
}

/**
 * Funding pledged from a member's funding accounts to approved loans not yet
 * disbursed, where the product locks funds at approval. Kept here rather
 * than in ./funding because savings sits below the loan modules.
 */
async function lockedFunding(c, memberId) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(f.amount), 0) AS t
     FROM loan_funding_sources f
     JOIN loan_accounts l ON l.id = f.loan_id
     JOIN loan_products p ON p.id = l.product_id
     WHERE f.member_id = $1 AND f.status = 'PLEDGED' AND l.status = 'APPROVED' AND p.lock_funds_at_approval`, [memberId]);
  return round2(r.t);
}

/** What may be withdrawn: the balance plus the authorised overdraft, less pledges and the minimum balance. */
function availableOf(a, pledged) {
  return round2(Number(a.balance) + Number(a.overdraft_limit || 0) - pledged - Number(a.min_balance || 0));
}

async function summary(c, accountId) {
  const a = await lock(c, accountId);
  const pledged = await pledgedAmount(c, a.member_id);
  return {
    accountId: a.id,
    accountNo: a.account_no,
    memberId: a.member_id,
    productId: a.product_id,
    branchId: a.branch_id,
    status: a.status,
    balance: round2(a.balance),
    pledged,
    minBalance: round2(a.min_balance),
    overdraftLimit: round2(a.overdraft_limit),
    overdrawn: round2(Math.max(0, -Number(a.balance))),
    available: round2(Math.max(0, availableOf(a, pledged))),
    interest: {
      accrued: round2(a.interest_accrued), negativeAccrued: round2(a.neg_interest_accrued),
      overdraftAccrued: round2(a.od_interest_accrued), accruedThrough: a.accrued_through ? S.ymd(a.accrued_through) : null,
      lastApplied: a.last_interest_applied_on ? S.ymd(a.last_interest_applied_on) : null,
    },
    overdraftChargesDue: { interest: round2(a.od_interest_due), fees: round2(a.od_fees_due) },
  };
}

const ref = (kind) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

async function record(c, row) {
  const { rows } = await c.query(
    `INSERT INTO transactions
       (reference, kind, member_id, savings_account_id, loan_account_id, share_account_id,
        channel_id, amount, value_date, entry_id, allocation, narration, created_by, branch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, current_date),$10,$11,$12,$13,
             COALESCE($14::uuid, (SELECT branch_id FROM loan_accounts WHERE id = $5::uuid),
                      (SELECT branch_id FROM savings_accounts WHERE id = $4::uuid)))
     RETURNING *`,
    [row.reference, row.kind, row.memberId || null, row.savingsAccountId || null,
     row.loanAccountId || null, row.shareAccountId || null, row.channelId || null,
     row.amount, row.valueDate || null, row.entryId || null,
     JSON.stringify(row.allocation || {}), row.narration || null, row.createdBy || 'SYSTEM', row.branchId || null]
  );
  return rows[0];
}

// --------------------------------------------------------------------------
// Legs: how money into or out of an account splits across the GL
// --------------------------------------------------------------------------

/**
 * Money into an account pays, in order: overdraft fees then overdraft
 * interest owed under cash accounting (recognised as income now), the rest
 * of the overdraft (Overdraft Portfolio), and what is left becomes balance
 * (Savings Control).
 */
function inLegs(a, amount) {
  const bal = Number(a.balance);
  let left = round2(amount);
  const odFees = round2(Math.min(left, Number(a.od_fees_due || 0)));
  left = round2(left - odFees);
  const odInterest = round2(Math.min(left, Number(a.od_interest_due || 0)));
  left = round2(left - odInterest);
  const overdrawn = round2(Math.max(0, -bal) - Number(a.od_fees_due || 0) - Number(a.od_interest_due || 0));
  const odPrincipal = round2(Math.min(left, Math.max(0, overdrawn)));
  const savings = round2(left - odPrincipal);
  const credits = [];
  if (books(a)) {
    const mid = a.member_id;
    const br = a.branch_id;
    if (odFees > 0) credits.push({ glCode: a.gl_fee_inc, amount: odFees, memberId: mid, branchId: br });
    if (odInterest > 0) credits.push({ glCode: a.gl_od_interest_inc, amount: odInterest, memberId: mid, branchId: br });
    if (odPrincipal > 0) credits.push({ glCode: a.gl_od_portfolio, amount: odPrincipal, memberId: mid, branchId: br });
    if (savings > 0) credits.push({ glCode: a.gl_liability, amount: savings, memberId: mid, branchId: br });
  }
  return { credits, allocation: { odFees, odInterest, odPrincipal, savings } };
}

/** Money out of an account: Savings Control down to zero, the Overdraft Portfolio below it. */
function outLegs(a, amount) {
  const bal = Number(a.balance);
  const savings = round2(Math.min(amount, Math.max(0, bal)));
  const odPrincipal = round2(amount - savings);
  const debits = [];
  if (books(a)) {
    if (savings > 0) debits.push({ glCode: a.gl_liability, amount: savings, memberId: a.member_id, branchId: a.branch_id });
    if (odPrincipal > 0) {
      if (!a.gl_od_portfolio) throw err('PRODUCT_HAS_NO_OVERDRAFT_PORTFOLIO_ACCOUNT', 409);
      debits.push({ glCode: a.gl_od_portfolio, amount: odPrincipal, memberId: a.member_id, branchId: a.branch_id });
    }
  }
  return { debits, allocation: { savings, odPrincipal } };
}

/**
 * Post a movement between a channel and an account. Under NONE the channel
 * still moves (the cash is real) and its other side is the suspense account.
 */
async function postWithChannel(c, a, { channelGl, amount, direction, productLegs, narration, sourceType, channelId, valueDate, createdBy, tellerBranch }) {
  const chLeg = { glCode: channelGl, amount, memberId: a.member_id, branchId: tellerBranch || a.branch_id };
  let legs = productLegs;
  if (!books(a)) legs = [{ glCode: await PA.suspense(c), amount, memberId: a.member_id, branchId: a.branch_id }];
  const e = await acct.post(c, {
    debits: direction === 'IN' ? [chLeg] : legs,
    credits: direction === 'IN' ? legs : [chLeg],
    narration, sourceType, channelId, bookingDate: valueDate, createdBy, branchId: a.branch_id,
  });
  return e.entryId;
}

// --------------------------------------------------------------------------
// Deposits, withdrawals, transfers
// --------------------------------------------------------------------------

async function deposit(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy, branchId = null }) {
  const a = await lock(c, accountId);
  if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  const ch = await channel(c, channelId);
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const legs = inLegs(a, amt);
  const entryId = await postWithChannel(c, a, {
    channelGl: ch.gl_account_code, amount: amt, direction: 'IN', productLegs: legs.credits,
    narration: narration || `Savings deposit ${a.account_no}`, sourceType: 'SAVINGS_DEPOSIT', channelId,
    valueDate, createdBy, tellerBranch: branchId,
  });
  await c.query(
    `UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3
     WHERE id = $4`, [amt, legs.allocation.odFees, legs.allocation.odInterest, a.id]);
  return record(c, {
    reference: ref('SD'), kind: 'SAVINGS_DEPOSIT', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate, branchId: a.branch_id,
    entryId, narration, createdBy, allocation: legs.allocation,
  });
}

async function withdraw(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy, branchId = null }) {
  const a = await lock(c, accountId);
  if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (!a.withdrawable) throw err('PRODUCT_NOT_WITHDRAWABLE', 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');

  const pledged = await pledgedAmount(c, a.member_id);
  const available = availableOf(a, pledged);
  if (amt > available) {
    throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}, requested ${amt}` +
      (pledged ? ` (${pledged} pledged as loan security)` : ''), 409);
  }
  const ch = await channel(c, channelId);
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const legs = outLegs(a, amt);
  const entryId = await postWithChannel(c, a, {
    channelGl: ch.gl_account_code, amount: amt, direction: 'OUT', productLegs: legs.debits,
    narration: narration || `Savings withdrawal ${a.account_no}`, sourceType: 'SAVINGS_WITHDRAWAL', channelId,
    valueDate, createdBy, tellerBranch: branchId,
  });

  // The floor trigger on savings_accounts is the last line of defence if
  // the availability maths above is ever wrong.
  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, a.id]);
  return record(c, {
    reference: ref('SW'), kind: 'SAVINGS_WITHDRAWAL', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate, branchId: a.branch_id,
    entryId, narration, createdBy, allocation: legs.allocation,
  });
}

async function transfer(c, fromId, { toAccountId, amount, valueDate, narration, createdBy }) {
  // Lock in a deterministic order so two opposing transfers cannot deadlock.
  const ids = [fromId, toAccountId];
  const first = ids.slice().sort()[0];
  await lock(c, first);

  const from = await lock(c, fromId);
  const to = await lock(c, toAccountId);
  if (from.id === to.id) throw err('SAME_ACCOUNT_TRANSFER');
  if (to.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${to.status}`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');

  const pledged = await pledgedAmount(c, from.member_id);
  const available = availableOf(from, pledged);
  if (amt > available) throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}`, 409);

  const out = outLegs(from, amt);
  const inn = inLegs(to, amt);
  const suspense = await PA.suspense(c);
  const debits = books(from) ? out.debits : [{ glCode: suspense, amount: amt, memberId: from.member_id, branchId: from.branch_id }];
  const credits = books(to) ? inn.credits : [{ glCode: suspense, amount: amt, memberId: to.member_id, branchId: to.branch_id }];
  let entryId = null;
  if (books(from) || books(to)) {
    entryId = (await acct.post(c, {
      debits, credits,
      narration: narration || `Transfer ${from.account_no} to ${to.account_no}`,
      sourceType: 'SAVINGS_TRANSFER', channelId: 'internal', bookingDate: valueDate, createdBy, branchId: from.branch_id,
    })).entryId;
  }

  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, from.id]);
  await c.query(
    `UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3
     WHERE id = $4`, [amt, inn.allocation.odFees, inn.allocation.odInterest, to.id]);

  return record(c, {
    reference: ref('ST'), kind: 'SAVINGS_TRANSFER', memberId: from.member_id,
    savingsAccountId: from.id, channelId: 'internal', amount: amt, valueDate, branchId: from.branch_id,
    entryId, allocation: { toAccountId: to.id, toAccountNo: to.account_no, from: out.allocation, to: inn.allocation },
    narration, createdBy,
  });
}

// --------------------------------------------------------------------------
// Fees
// --------------------------------------------------------------------------

/**
 * Charge a fee. The part the balance covers is income now; the part that
 * overdraws the account is income now under accrual (it joins the overdraft
 * portfolio) and when paid under cash (od_fees_due). A fee may use the
 * authorised overdraft; beyond it only a product with technical overdrafts
 * lets the charge through.
 */
async function applyFee(c, accountId, { feeCode = null, amount = null, name = null, valueDate, createdBy, narration } = {}) {
  const a = await lock(c, accountId);
  if (!['ACTIVE', 'DORMANT', 'LOCKED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  let fee = null;
  if (feeCode) {
    const { rows: [f] } = await c.query(
      'SELECT * FROM savings_product_fees WHERE product_id = $1 AND (code = $2 OR id::text = $2) AND is_active', [a.product_id, feeCode]);
    if (!f) throw err(`UNKNOWN_FEE: ${feeCode}`, 404);
    fee = f;
  }
  const amt = round2(amount ?? fee?.amount);
  if (!(amt > 0)) throw err('FEE_NEEDS_AN_AMOUNT', 400);
  const room = round2(Number(a.balance) + Number(a.overdraft_limit || 0));
  if (amt > room && !a.allow_technical_overdraft) throw err(`INSUFFICIENT_BALANCE_FOR_FEE: room ${room}, fee ${amt}`, 409);

  const out = outLegs(a, amt);
  const cashDue = a.accounting_method === 'CASH' ? out.allocation.odPrincipal : 0;
  const recognised = round2(amt - cashDue);
  let entryId = null;
  if (books(a) && recognised > 0) {
    const debits = out.debits.filter((d) => d.glCode === a.gl_liability);
    if (a.accounting_method !== 'CASH' && out.allocation.odPrincipal > 0) debits.push(...out.debits.filter((d) => d.glCode === a.gl_od_portfolio));
    entryId = (await acct.post(c, {
      debits,
      credits: [{ glCode: fee?.gl_income || a.gl_fee_inc, amount: recognised, memberId: a.member_id, branchId: a.branch_id }],
      narration: narration || `${fee?.name || name || 'Fee'} ${a.account_no}`,
      sourceType: 'SAVINGS_FEE', bookingDate: valueDate, createdBy, branchId: a.branch_id,
    })).entryId;
  }
  await c.query('UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2 WHERE id = $3', [amt, cashDue, a.id]);
  return record(c, {
    reference: ref('SF'), kind: 'SAVINGS_FEE', memberId: a.member_id, savingsAccountId: a.id,
    amount: amt, valueDate, branchId: a.branch_id, entryId, createdBy, narration,
    allocation: { fee: fee?.code || null, name: fee?.name || name, ...out.allocation, odFeesDue: cashDue },
  });
}

/** Monthly fees on every open account of products that charge them. Runs on the last day of the month. */
async function applyMonthlyFees(c, { date, createdBy = 'EOD' } = {}) {
  if (!accruals.isMonthEnd(date)) return { charged: 0, skipped: 0 };
  const { rows } = await c.query(
    `SELECT a.id, f.code FROM savings_accounts a
     JOIN savings_product_fees f ON f.product_id = a.product_id AND f.trigger = 'MONTHLY' AND f.is_active
     WHERE a.status IN ('ACTIVE','DORMANT')
       AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.savings_account_id = a.id AND t.kind = 'SAVINGS_FEE'
                         AND t.value_date = $1::date AND t.allocation->>'fee' = f.code AND t.reversed_by IS NULL)
     ORDER BY a.account_no`, [date]);
  let charged = 0;
  const skipped = [];
  for (const r of rows) {
    await c.query('SAVEPOINT fee');
    try {
      await applyFee(c, r.id, { feeCode: r.code, valueDate: date, createdBy });
      await c.query('RELEASE SAVEPOINT fee');
      charged += 1;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT fee');
      skipped.push({ accountId: r.id, fee: r.code, reason: e.message });
    }
  }
  return { charged, skipped: skipped.length, detail: skipped };
}

// --------------------------------------------------------------------------
// Interest
// --------------------------------------------------------------------------

const DAY = 86400000;
const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const yearDays = (conv) => (conv === 'ACTUAL_360' || conv === 'THIRTY_360' ? 360 : 365);
const weight = (prev, day, conv) => (conv === 'THIRTY_360' ? S.dayCount(prev, day, 'THIRTY_360') : 1);

function isApplicationDate(iso, freq) {
  if (!accruals.isMonthEnd(iso)) return false;
  const m = Number(iso.slice(5, 7));
  switch (freq) {
    case 'QUARTERLY': return m % 3 === 0;
    case 'SEMI_ANNUAL': return m === 6 || m === 12;
    case 'ANNUAL': return m === 12;
    default: return true;
  }
}

/**
 * Accrue interest through `date`: positive interest on a positive balance,
 * negative interest where the rate is below zero, overdraft interest on a
 * negative balance.
 *
 * Each day's balance is recorded in savings_daily_balances; for days the end
 * of day did not run on (a catch-up), the balance as it stands is used.
 * END_OF_DAY prices each day on that day's balance; MINIMUM prices the
 * period so far on its lowest balance and books the change.
 *
 * Under ACCRUAL with a GL accrual method, what has accrued is booked to the
 * payable (or receivable) as it changes, through ./accruals.
 */
async function accrueInterest(c, accountId, { date, createdBy = 'EOD' } = {}) {
  const a = await lock(c, accountId);
  if (!['ACTIVE', 'DORMANT', 'LOCKED'].includes(a.status)) return null;
  const interestOn = Boolean(a.interest_paid_into_account) && !a.is_funding_account;
  const odRate = Number(a.overdraft_annual_rate || 0);
  const opened = S.ymd(a.opened_on);
  const start = a.accrued_through ? S.ymd(a.accrued_through) : addDays(opened, -1);
  if (date <= start) return null;
  const periodStart = a.period_started_on ? S.ymd(a.period_started_on) : opened;
  const conv = a.interest_day_count || 'ACTUAL_365';
  const Y = yearDays(conv);
  const rate = Number(a.annual_rate || 0);
  const threshold = a.min_balance_for_interest === null ? null : Number(a.min_balance_for_interest);

  let pos = 0;
  let od = 0;
  for (let d = addDays(start, 1); d <= date; d = addDays(d, 1)) {
    await c.query(
      'INSERT INTO savings_daily_balances (account_id, day, balance) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [a.id, d, a.balance]);
    const { rows: [snap] } = await c.query('SELECT balance FROM savings_daily_balances WHERE account_id = $1 AND day = $2', [a.id, d]);
    const bal = Number(snap.balance);
    const w = weight(addDays(d, -1), d, conv);
    if (interestOn && a.interest_calc_balance === 'END_OF_DAY' && bal > 0 && (threshold === null || bal >= threshold)) {
      pos += bal * rate / 100 * w / Y;
    }
    if (bal < 0 && odRate > 0) od += -bal * odRate / 100 * w / Y;
  }
  if (interestOn && a.interest_calc_balance === 'MINIMUM') {
    const { rows: [m] } = await c.query(
      'SELECT min(balance) AS lo FROM savings_daily_balances WHERE account_id = $1 AND day BETWEEN $2 AND $3', [a.id, periodStart, date]);
    const lo = Number(m.lo);
    let days = 0;
    for (let d = periodStart; d <= date; d = addDays(d, 1)) days += weight(addDays(d, -1), d, conv);
    const target = lo > 0 && (threshold === null || lo >= threshold) ? lo * rate / 100 * days / Y : 0;
    const current = Number(a.interest_accrued) - Number(a.neg_interest_accrued);
    pos = target - current;
  }
  const posAdd = rate >= 0 ? pos : 0;
  const negAdd = rate < 0 ? -pos : 0;
  const { rows: [u] } = await c.query(
    `UPDATE savings_accounts SET interest_accrued = interest_accrued + $1, neg_interest_accrued = neg_interest_accrued + $2,
       od_interest_accrued = od_interest_accrued + $3, accrued_through = $4::date,
       period_started_on = COALESCE(period_started_on, opened_on)
     WHERE id = $5 RETURNING *`, [posAdd, negAdd, od, date, a.id]);

  // Book what has changed to the ledger.
  let entryId = null;
  if (books(a) && accrues(a)) {
    const comps = [
      ['INTEREST', 'interest_accrued', 'interest_booked', a.gl_interest_exp, a.gl_interest_payable, interestOn],
      ['NEG_INTEREST', 'neg_interest_accrued', 'neg_interest_booked', a.gl_neg_interest_rec, a.gl_neg_interest_inc, interestOn && a.allow_negative_rate],
      ['OD_INTEREST', 'od_interest_accrued', 'od_interest_booked', a.gl_od_interest_rec, a.gl_od_interest_inc, Boolean(a.gl_od_interest_rec)],
    ];
    const lines = [];
    const sets = [];
    for (const [component, accruedCol, bookedCol, dr, cr, on] of comps) {
      if (!on) continue;
      const delta = round2(round2(u[accruedCol]) - Number(u[bookedCol]));
      if (delta === 0) continue;
      lines.push({ component, debitGl: dr, creditGl: cr, amount: delta });
      sets.push(`${bookedCol} = ${bookedCol} + ${delta}`);
    }
    if (lines.length) {
      entryId = await accruals.record(c, {
        kind: 'SAVINGS', product: { ...a, id: a.product_id }, accountId: a.id, memberId: a.member_id, branchId: a.branch_id,
        date, lines, narration: `Deposit interest accrual ${a.account_no} to ${date}`, createdBy,
      });
      await c.query(`UPDATE savings_accounts SET ${sets.join(', ')} WHERE id = $1`, [a.id]);
    }
  }
  return {
    accountId: a.id, through: date,
    interest: round2(u.interest_accrued), negative: round2(u.neg_interest_accrued), overdraft: round2(u.od_interest_accrued), entryId,
  };
}

/**
 * Apply what has accrued to the balance: positive interest (less
 * withholding tax), negative interest, overdraft interest. The sub-cent
 * remainder carries into the next period.
 */
async function applyInterest(c, accountId, { date, createdBy = 'EOD' } = {}) {
  let a = await lock(c, accountId);
  const out = [];
  const pos = round2(a.interest_accrued);
  const neg = round2(a.neg_interest_accrued);
  const odi = round2(a.od_interest_accrued);
  const recognised = books(a) && accrues(a);
  const mid = a.member_id;
  const br = a.branch_id;

  if (pos > 0) {
    const booked = recognised ? Number(a.interest_booked) : 0;
    const inn = inLegs(a, pos);
    let entryId = null;
    if (books(a)) {
      const debits = [];
      if (booked > 0) debits.push({ glCode: a.gl_interest_payable, amount: booked, memberId: mid, branchId: br });
      if (pos - booked > 0) debits.push({ glCode: a.gl_interest_exp, amount: round2(pos - booked), memberId: mid, branchId: br });
      entryId = (await acct.post(c, {
        debits, credits: inn.credits, narration: `Interest applied ${a.account_no}`,
        sourceType: 'SAVINGS_INTEREST_APPLIED', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
      })).entryId;
    }
    await c.query(
      `UPDATE savings_accounts SET balance = balance + $1, interest_accrued = interest_accrued - $1, interest_booked = 0,
         od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3 WHERE id = $4`,
      [pos, inn.allocation.odFees, inn.allocation.odInterest, a.id]);
    out.push(await record(c, {
      reference: ref('SI'), kind: 'SAVINGS_INTEREST_APPLIED', memberId: mid, savingsAccountId: a.id, amount: pos,
      valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, ...inn.allocation },
    }));
    const wht = a.withholding_tax_percent === null ? 0 : round2(pos * Number(a.withholding_tax_percent) / 100);
    if (wht > 0) {
      a = await lock(c, a.id);
      const legs = outLegs(a, wht);
      let taxEntry = null;
      if (books(a)) {
        taxEntry = (await acct.post(c, {
          debits: legs.debits, credits: [{ glCode: a.gl_tax_payable, amount: wht, memberId: mid, branchId: br }],
          narration: `Withholding tax ${a.withholding_tax_percent}% on interest ${a.account_no}`,
          sourceType: 'SAVINGS_WITHHOLDING_TAX', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
        })).entryId;
      }
      await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [wht, a.id]);
      out.push(await record(c, {
        reference: ref('WT'), kind: 'SAVINGS_WITHHOLDING_TAX', memberId: mid, savingsAccountId: a.id, amount: wht,
        valueDate: date, branchId: br, entryId: taxEntry, createdBy,
        allocation: { rate: Number(a.withholding_tax_percent), on: pos, ...legs.allocation },
      }));
    }
  }

  if (neg > 0) {
    a = await lock(c, a.id);
    const room = round2(Number(a.balance) + Number(a.overdraft_limit || 0));
    const charge = a.allow_technical_overdraft ? neg : round2(Math.max(0, Math.min(neg, room)));
    if (charge > 0) {
      const booked = recognised ? Math.min(Number(a.neg_interest_booked), charge) : 0;
      const legs = outLegs(a, charge);
      let entryId = null;
      if (books(a)) {
        const credits = [];
        if (booked > 0) credits.push({ glCode: a.gl_neg_interest_rec, amount: booked, memberId: mid, branchId: br });
        if (charge - booked > 0) credits.push({ glCode: a.gl_neg_interest_inc, amount: round2(charge - booked), memberId: mid, branchId: br });
        entryId = (await acct.post(c, {
          debits: legs.debits, credits, narration: `Negative interest ${a.account_no}`,
          sourceType: 'SAVINGS_NEGATIVE_INTEREST', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
        })).entryId;
      }
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1, neg_interest_accrued = neg_interest_accrued - $2,
           neg_interest_booked = neg_interest_booked - $3 WHERE id = $4`, [charge, neg, booked, a.id]);
      out.push(await record(c, {
        reference: ref('SN'), kind: 'SAVINGS_NEGATIVE_INTEREST', memberId: mid, savingsAccountId: a.id, amount: charge,
        valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, ...legs.allocation },
      }));
    }
  }

  if (odi > 0) {
    a = await lock(c, a.id);
    const booked = recognised ? Number(a.od_interest_booked) : 0;
    const legs = outLegs(a, odi);
    // Under cash, the part that overdraws the account is owed, not earned.
    const cashDue = a.accounting_method === 'CASH' ? legs.allocation.odPrincipal : 0;
    const earned = round2(odi - cashDue);
    let entryId = null;
    if (books(a) && earned > 0) {
      const debits = a.accounting_method === 'CASH' ? legs.debits.filter((d) => d.glCode === a.gl_liability) : legs.debits;
      const credits = [];
      if (booked > 0) credits.push({ glCode: a.gl_od_interest_rec, amount: booked, memberId: mid, branchId: br });
      if (earned - booked > 0) credits.push({ glCode: a.gl_od_interest_inc, amount: round2(earned - booked), memberId: mid, branchId: br });
      entryId = (await acct.post(c, {
        debits, credits, narration: `Overdraft interest ${a.account_no}`,
        sourceType: 'OVERDRAFT_INTEREST_APPLIED', sourceId: a.id, bookingDate: date, createdBy, branchId: br,
      })).entryId;
    }
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, od_interest_accrued = od_interest_accrued - $1,
         od_interest_booked = 0, od_interest_due = od_interest_due + $2 WHERE id = $3`, [odi, cashDue, a.id]);
    out.push(await record(c, {
      reference: ref('OI'), kind: 'OVERDRAFT_INTEREST_APPLIED', memberId: mid, savingsAccountId: a.id, amount: odi,
      valueDate: date, branchId: br, entryId, createdBy, allocation: { booked, odInterestDue: cashDue, ...legs.allocation },
    }));
  }

  await c.query(
    `UPDATE savings_accounts SET last_interest_applied_on = $1::date, period_started_on = ($1::date + 1) WHERE id = $2`, [date, a.id]);
  return out;
}

/** The end of day for deposits: accrue every open account, apply on application dates, charge monthly fees. */
async function endOfDay(c, { date, createdBy = 'EOD' } = {}) {
  const { rows } = await c.query(
    `SELECT a.id, p.interest_application FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
     WHERE a.status IN ('ACTIVE','DORMANT','LOCKED') ORDER BY a.account_no`);
  let accrued = 0;
  let applied = 0;
  for (const r of rows) {
    const x = await accrueInterest(c, r.id, { date, createdBy });
    if (x) accrued += 1;
    if (isApplicationDate(date, r.interest_application)) {
      const done = await applyInterest(c, r.id, { date, createdBy });
      if (done.length) applied += 1;
    }
  }
  const fees = await applyMonthlyFees(c, { date, createdBy });
  return { accounts: rows.length, accrued, applied, fees };
}

// --------------------------------------------------------------------------
// Overdrafts
// --------------------------------------------------------------------------

async function setOverdraftLimit(c, accountId, { limit, createdBy } = {}) {
  const a = await lock(c, accountId);
  const lim = round2(limit);
  if (!(lim >= 0)) throw err('INVALID_OVERDRAFT_LIMIT', 400);
  if (lim > 0 && !a.allow_overdraft) throw err('PRODUCT_DOES_NOT_ALLOW_OVERDRAFTS', 409);
  if (a.max_overdraft_limit !== null && lim > Number(a.max_overdraft_limit)) throw err(`OVERDRAFT_LIMIT_ABOVE_PRODUCT_MAXIMUM: ${a.max_overdraft_limit}`, 400);
  if (Number(a.balance) < -lim && !a.allow_technical_overdraft) throw err(`BALANCE_ALREADY_BELOW_THAT_LIMIT: ${a.balance}`, 409);
  const { rows: [r] } = await c.query('UPDATE savings_accounts SET overdraft_limit = $1 WHERE id = $2 RETURNING *', [lim, a.id]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'OVERDRAFT_LIMIT_SET','savings_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', a.id, JSON.stringify({ overdraftLimit: Number(a.overdraft_limit) }), JSON.stringify({ overdraftLimit: lim })]);
  return r;
}

/**
 * Write off an overdraft: the balance returns to zero. Under accrual the
 * portfolio (principal, applied interest and fees) and any accrued overdraft
 * interest go to the write-off expense; under cash, charges owed but never
 * recognised are simply cleared.
 */
async function writeOffOverdraft(c, accountId, { narration, createdBy } = {}) {
  const a = await lock(c, accountId);
  const overdrawn = round2(-Number(a.balance));
  if (!(overdrawn > 0)) throw err('ACCOUNT_IS_NOT_OVERDRAWN', 409);
  const cashCharges = round2(Number(a.od_fees_due) + Number(a.od_interest_due));
  const portfolio = round2(overdrawn - cashCharges);
  const accruedOd = round2(a.od_interest_booked);
  let entryId = null;
  if (books(a)) {
    const credits = [];
    if (portfolio > 0) credits.push({ glCode: a.gl_od_portfolio, amount: portfolio, memberId: a.member_id, branchId: a.branch_id });
    if (accruedOd > 0) credits.push({ glCode: a.gl_od_interest_rec, amount: accruedOd, memberId: a.member_id, branchId: a.branch_id });
    const total = round2(portfolio + accruedOd);
    if (total > 0) {
      entryId = (await acct.post(c, {
        debits: [{ glCode: a.gl_od_writeoff, amount: total, memberId: a.member_id, branchId: a.branch_id }],
        credits, narration: narration || `Overdraft write-off ${a.account_no}`,
        sourceType: 'OVERDRAFT_WRITE_OFF', sourceId: a.id, createdBy, branchId: a.branch_id,
      })).entryId;
    }
  }
  await c.query(
    `UPDATE savings_accounts SET balance = 0, od_fees_due = 0, od_interest_due = 0, od_interest_accrued = 0,
       od_interest_booked = 0, overdraft_limit = 0 WHERE id = $1`, [a.id]);
  return record(c, {
    reference: ref('OW'), kind: 'OVERDRAFT_WRITE_OFF', memberId: a.member_id, savingsAccountId: a.id, amount: overdrawn,
    branchId: a.branch_id, entryId, createdBy, narration,
    allocation: { portfolio, accruedInterest: accruedOd, cashChargesCleared: cashCharges },
  });
}

// --------------------------------------------------------------------------
// Reversal
// --------------------------------------------------------------------------

const REVERSIBLE = ['SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER', 'SAVINGS_FEE'];

/**
 * Reverse a posted deposit transaction. Never edits the original. One half
 * of a transfer with a loan (a repayment from this account, a disbursement
 * into it) is reversed with its loan transaction, which reverses both; on
 * its own (`linked` false) it is refused.
 */
async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy, linked = false } = {}) {
  const { rows } = await c.query(
    'SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]
  );
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.savings_account_id) throw err('NOT_A_SAVINGS_TRANSACTION');
  if (!REVERSIBLE.includes(tx.kind)) throw err(`CANNOT_REVERSE_${tx.kind}`, 409);
  if (tx.allocation?.loanTransfer && !linked) {
    throw err(`LINKED_TO_A_LOAN_TRANSACTION: reverse ${tx.allocation.loanTransfer.reference}, which reverses both`, 409);
  }

  const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
  const al = tx.allocation || {};
  const amt = Number(tx.amount);

  if (tx.kind === 'SAVINGS_DEPOSIT') {
    await c.query(
      `UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2, od_interest_due = od_interest_due + $3
       WHERE id = $4`, [amt, al.odFees || 0, al.odInterest || 0, tx.savings_account_id]);
  } else if (tx.kind === 'SAVINGS_WITHDRAWAL') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
  } else if (tx.kind === 'SAVINGS_FEE') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2 WHERE id = $3',
      [amt, al.odFeesDue || 0, tx.savings_account_id]);
  } else if (tx.kind === 'SAVINGS_TRANSFER') {
    await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, tx.savings_account_id]);
    if (al.toAccountId) {
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1, od_fees_due = od_fees_due + $2, od_interest_due = od_interest_due + $3
         WHERE id = $4`, [amt, al.to?.odFees || 0, al.to?.odInterest || 0, al.toAccountId]);
    }
  }

  const rev = await record(c, {
    reference: ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    savingsAccountId: tx.savings_account_id, amount: -tx.amount, branchId: tx.branch_id,
    entryId: entry.entryId, allocation: { reversalOf: tx.reference }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

// --------------------------------------------------------------------------
// Opening
// --------------------------------------------------------------------------

async function open(c, { memberId, productId = 'SAV01', accountNo, branchId = undefined, overdraftLimit = 0, openedOn = null }) {
  const { rows: [p] } = await c.query('SELECT * FROM savings_products WHERE id = $1', [productId]);
  if (!p) throw err('UNKNOWN_DEPOSIT_PRODUCT', 404);
  if (p.is_active === false) throw err('DEPOSIT_PRODUCT_INACTIVE', 409);
  const lim = round2(overdraftLimit || 0);
  if (lim > 0 && !p.allow_overdraft) throw err('PRODUCT_DOES_NOT_ALLOW_OVERDRAFTS', 409);
  if (lim > 0 && p.max_overdraft_limit !== null && lim > Number(p.max_overdraft_limit)) {
    throw err(`OVERDRAFT_LIMIT_ABOVE_PRODUCT_MAXIMUM: ${p.max_overdraft_limit}`, 400);
  }
  const { rows: [m] } = await c.query('SELECT branch_id FROM members WHERE id = $1', [memberId]);
  if (!m) throw err('MEMBER_NOT_FOUND', 404);
  const no = accountNo || (await c.query(
    `SELECT 'SA' || lpad((count(*)+1)::text, 6, '0') AS n FROM savings_accounts`)).rows[0].n;
  const { rows } = await c.query(
    `INSERT INTO savings_accounts (account_no, member_id, product_id, status, branch_id, overdraft_limit, opened_on, period_started_on)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,COALESCE($6::date, current_date),COALESCE($6::date, current_date)) RETURNING *`,
    [no, memberId, productId, branchId === undefined ? m.branch_id : branchId, lim, openedOn]
  );
  return rows[0];
}

module.exports = {
  lockedFunding, open, deposit, withdraw, transfer, summary, reverseTransaction, pledgedAmount, lock, record, ref,
  applyFee, applyMonthlyFees, accrueInterest, applyInterest, endOfDay, isApplicationDate,
  setOverdraftLimit, writeOffOverdraft, inLegs, outLegs, availableOf, books,
};
