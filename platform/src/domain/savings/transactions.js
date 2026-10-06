'use strict';

/**
 * Deposit accounts: deposits, withdrawals, transfers and fees.
 */

const CA = require('../creditArrangements');
const DR = require('../depositRules');
const acct = require('../accounting');
const S = require('../schedule');
const PA = require('../productAccounting');
const channels = require('../channels');
const { err, round2 } = acct;
const core = require('./core');
const interest = require('./interest');

// --------------------------------------------------------------------------
// Deposits, withdrawals, transfers
// --------------------------------------------------------------------------

async function deposit(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy, branchId = null, user = null, holdExternalReferenceId = null }) {
  const a = await core.lock(c, accountId);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  const hold = await core.holdToSettle(c, a, holdExternalReferenceId, 'CRDT', amt, { valueDate, user });
  const { day } = await core.valueDay(c, a, valueDate, user);
  core.assertMayCredit(a, amt, { user, day });
  const ch = await channels.assertUsable(c, channelId, { side: 'SAVINGS', type: 'DEPOSIT', amount: amt, productId: a.product_id, user });
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const legs = core.inLegs(a, amt);
  const entryId = await core.postWithChannel(c, a, {
    channelGl: ch.gl_account_code, amount: amt, direction: 'IN', productLegs: legs.credits,
    narration: narration || `Savings deposit ${a.account_no}`, sourceType: 'SAVINGS_DEPOSIT', channelId,
    valueDate, createdBy, tellerBranch: branchId,
  });
  await c.query(
    `UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3
     WHERE id = $4`, [amt, legs.allocation.odFees, legs.allocation.odInterest, a.id]);
  await core.touch(c, a, day);
  const repriced = await interest.repriceFrom(c, a.id, day, amt, { createdBy });
  const t = await core.record(c, {
    reference: core.ref('SD'), kind: 'SAVINGS_DEPOSIT', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate, branchId: a.branch_id,
    entryId, narration, createdBy, allocation: { ...legs.allocation, ...(repriced ? { repricedFrom: day } : {}), ...(hold ? { hold: hold.external_reference_id } : {}) },
  });
  if (hold) await core.settleHold(c, hold, t);
  return t;
}
async function withdraw(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy, branchId = null, offsetPledge = null, user = null, holdExternalReferenceId = null }) {
  const locked = await core.lock(c, accountId);
  // A guarantor's pledge being made at the same moment waits (../eligibility addGuarantor).
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`member-funds:${locked.member_id}`]);
  const hold = await core.holdToSettle(c, locked, holdExternalReferenceId, 'DBIT', round2(amount), { valueDate, user });
  const { day } = await core.valueDay(c, locked, valueDate, user);
  const a = core.onDay(locked, day);
  // `offsetPledge`: a guarantor's pledge being collected (../loanClosures
  // collectSecurities). The deposits it was pledged from need not be
  // withdrawable, and that pledge does not hold them back.
  const offsetting = offsetPledge !== null && offsetPledge !== undefined;
  if (!a.withdrawable && !offsetting) throw err('PRODUCT_NOT_WITHDRAWABLE', 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  core.assertMayDebit(a, amt, { user, day, offsetting });

  const pledged = round2(await core.pledgedAmount(c, a.member_id) - (offsetting ? Number(offsetPledge) : 0));
  // Blocked funds and debit holds are not available (the reference platform); the hold this
  // withdrawal settles is.
  const hb = await core.heldBack(c, a.id);
  const available = round2(core.availableOf(a, pledged) - hb.blocked - hb.holds + (hold ? Number(hold.amount) : 0));
  if (amt > available) {
    throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}, requested ${amt}` +
      (pledged ? ` (${pledged} pledged as loan security)` : '') + (hb.blocked ? ` (${hb.blocked} blocked)` : '') + (hb.holds ? ` (${hb.holds} on hold)` : ''), 409);
  }
  if (user) await core.assertBackdatedFloor(c, a, day, -amt);
  // Into a linked overdraft: the credit arrangement's state, expiry and limit.
  await CA.onOverdraw(c, a, amt, day);
  const ch = await channels.assertUsable(c, channelId, { side: 'SAVINGS', type: 'WITHDRAWAL', amount: amt, productId: a.product_id, user });
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const legs = core.outLegs(a, amt);
  const entryId = await core.postWithChannel(c, a, {
    channelGl: ch.gl_account_code, amount: amt, direction: 'OUT', productLegs: legs.debits,
    narration: narration || `Savings withdrawal ${a.account_no}`, sourceType: 'SAVINGS_WITHDRAWAL', channelId,
    valueDate, createdBy, tellerBranch: branchId,
  });

  // The floor trigger on savings_accounts is the last line of defence if
  // the availability maths above is ever wrong.
  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, a.id]);
  if (!offsetting) await core.touch(c, a, day);
  const repriced = await interest.repriceFrom(c, a.id, day, -amt, { createdBy });
  const t = await core.record(c, {
    reference: core.ref('SW'), kind: 'SAVINGS_WITHDRAWAL', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate, branchId: a.branch_id,
    entryId, narration, createdBy, allocation: { ...legs.allocation, ...(repriced ? { repricedFrom: day } : {}), ...(hold ? { hold: hold.external_reference_id } : {}) },
  });
  if (hold) await core.settleHold(c, hold, t);
  return t;
}
async function transfer(c, fromId, { toAccountId, amount, valueDate, narration, createdBy, user = null }) {
  // Lock in a deterministic order so two opposing transfers cannot deadlock.
  const ids = [fromId, toAccountId];
  const first = ids.slice().sort()[0];
  await core.lock(c, first);

  const fromLocked = await core.lock(c, fromId);
  const to = await core.lock(c, toAccountId);
  // Both account rows first, then the member's funds lock, the same order as a withdrawal
  // (row, then funds), so a transfer and a withdrawal on the same member cannot deadlock.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`member-funds:${fromLocked.member_id}`]);
  const { day } = await core.valueDay(c, fromLocked, valueDate, user);
  const from = core.onDay(fromLocked, day);
  if (from.id === to.id) throw err('SAME_ACCOUNT_TRANSFER');
  // To another holder's account (the reference platform's inter-client transfer).
  if (from.member_id !== to.member_id) core.need(user, 'MAKE_INTER_CLIENTS_TRANSFERS');
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  core.assertMayDebit(from, amt, { user, day });
  core.assertMayCredit(to, amt, { user, day, source: 'TRANSFER' });

  const pledged = await core.pledgedAmount(c, from.member_id);
  const hb = await core.heldBack(c, from.id);
  const available = round2(core.availableOf(from, pledged) - hb.blocked - hb.holds);
  if (amt > available) throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}`, 409);
  if (user) await core.assertBackdatedFloor(c, from, day, -amt);
  await CA.onOverdraw(c, from, amt, day);

  const out = core.outLegs(from, amt);
  const inn = core.inLegs(to, amt);
  const suspense = await PA.suspense(c);
  const debits = core.books(from) ? out.debits : [{ glCode: suspense, amount: amt, memberId: from.member_id, branchId: from.branch_id }];
  const credits = core.books(to) ? inn.credits : [{ glCode: suspense, amount: amt, memberId: to.member_id, branchId: to.branch_id }];
  let entryId = null;
  if (core.books(from) || core.books(to)) {
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
  await core.touch(c, from, day);
  await core.touch(c, to, day);
  const r1 = await interest.repriceFrom(c, from.id, day, -amt, { createdBy });
  const r2 = await interest.repriceFrom(c, to.id, day, amt, { createdBy });

  return core.record(c, {
    reference: core.ref('ST'), kind: 'SAVINGS_TRANSFER', memberId: from.member_id,
    savingsAccountId: from.id, channelId: 'internal', amount: amt, valueDate, branchId: from.branch_id,
    entryId, allocation: { toAccountId: to.id, toAccountNo: to.account_no, from: out.allocation, to: inn.allocation, ...(r1 || r2 ? { repricedFrom: day } : {}) },
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
  const a = await core.lock(c, accountId);
  // A locked account takes no transactions (the reference platform).
  if (a.status === 'LOCKED') throw err('ACCOUNT_LOCKED: unlock it first', 409);
  if (!['ACTIVE', 'IN_ARREARS', 'DORMANT', 'MATURED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  let fee = null;
  if (feeCode) {
    const { rows: [f] } = await c.query(
      'SELECT * FROM savings_product_fees WHERE product_id = $1 AND (code = $2 OR id::text = $2) AND is_active', [a.product_id, feeCode]);
    if (!f) throw err(`UNKNOWN_FEE: ${feeCode}`, 404);
    fee = f;
  }
  // A fee not defined on the product (the reference platform's arbitrary fee) only where the product allows them.
  if (!fee && a.allow_arbitrary_fees === false) throw err(`ARBITRARY_FEES_NOT_ALLOWED: product ${a.product_id}; define the fee on the product`, 409);
  const amt = round2(amount ?? fee?.amount);
  if (!(amt > 0)) throw err('FEE_NEEDS_AN_AMOUNT', 400);
  const room = round2(Number(a.balance) + Number(a.overdraft_limit || 0));
  if (amt > room && !a.allow_technical_overdraft) throw err(`INSUFFICIENT_BALANCE_FOR_FEE: room ${room}, fee ${amt}`, 409);

  const out = core.outLegs(a, amt);
  const cashDue = a.accounting_method === 'CASH' ? out.allocation.odPrincipal : 0;
  const recognised = round2(amt - cashDue);
  let entryId = null;
  if (core.books(a) && recognised > 0) {
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
  return core.record(c, {
    reference: core.ref('SF'), kind: 'SAVINGS_FEE', memberId: a.member_id, savingsAccountId: a.id,
    amount: amt, valueDate, branchId: a.branch_id, entryId, createdBy, narration,
    allocation: { fee: fee?.code || null, name: fee?.name || name, ...out.allocation, odFeesDue: cashDue },
  });
}

/**
 * Monthly fees on every open account of products that charge them, dated
 * by each fee's apply date method: the last day of the month (the
 * platform's first rule), the first day of every month, or monthly from
 * the account's activation (the reference platform). A dormant account is charged no
 * automated fee, and a locked one nothing (the reference platform).
 */
async function applyMonthlyFees(c, { date, createdBy = 'EOD' } = {}) {
  const { rows: all } = await c.query(
    `SELECT a.id, a.opened_on, f.code, COALESCE(f.apply_date_method, 'END_OF_MONTH') AS method FROM savings_accounts a
     JOIN savings_product_fees f ON f.product_id = a.product_id AND f.trigger = 'MONTHLY' AND f.is_active
     WHERE a.status IN ('ACTIVE','IN_ARREARS','MATURED')
       AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.savings_account_id = a.id AND t.kind = 'SAVINGS_FEE'
                         AND t.value_date = $1::date AND t.allocation->>'fee' = f.code AND t.reversed_by IS NULL)
     ORDER BY a.account_no`, [date]);
  const rows = all.filter((r) => DR.isMonthlyFeeDate(date, r.method, S.ymd(r.opened_on)));
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

Object.assign(module.exports, {
  deposit, withdraw, transfer, applyFee, applyMonthlyFees,
});
