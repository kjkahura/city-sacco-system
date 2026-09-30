'use strict';

/**
 * Deposit accounts: blocked funds and seizures, transaction holds, and withholding tax.
 */

const { orgToday } = require('../../lib/orgDate');
const acct = require('../accounting');
const channels = require('../channels');
const { recordAudit } = require('../../lib/auditLog');
const { err, round2 } = acct;
const core = require('./core');

// --------------------------------------------------------------------------
// Blocked funds and seizures (the reference platform's Blocking Funds in Deposit Accounts)
// --------------------------------------------------------------------------

const BLOCKABLE = ['ACTIVE', 'IN_ARREARS', 'LOCKED', 'DORMANT'];
const blockOut = (b) => ({
  externalReferenceId: b.reference, accountKey: b.account_id, amount: Number(b.amount), seizedAmount: Number(b.seized),
  state: b.state, notes: b.notes, creationDate: b.created_at, closedDate: b.closed_at || null,
});

/** Block an amount (it may exceed the available balance). Interest accrues on the total balance still. */
async function blockFunds(c, accountId, { externalReferenceId = null, amount, notes = null, createdBy } = {}) {
  const a = await core.lock(c, accountId);
  if (!BLOCKABLE.includes(a.status)) throw err(`FUNDS_ARE_BLOCKED_ON_OPEN_ACCOUNTS: the account is ${a.status}`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT', 400);
  const refId = externalReferenceId ? String(externalReferenceId).slice(0, 64) : core.ref('BLK');
  const { rows: [dupe] } = await c.query('SELECT 1 FROM savings_blocks WHERE account_id = $1 AND reference = $2', [a.id, refId]);
  if (dupe) throw err(`BLOCK_REFERENCE_IN_USE: ${refId}`, 409);
  const { rows: [b] } = await c.query(
    'INSERT INTO savings_blocks (account_id, reference, amount, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [a.id, refId, amt, notes, createdBy || 'SYSTEM']);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_FUNDS_BLOCKED', entity: 'savings_account', entityId: a.id, after: JSON.stringify({ reference: refId, amount: amt, notes }) });
  return blockOut(b);
}

async function blocksOf(c, accountId) {
  const a = await core.lock(c, accountId);
  const { rows } = await c.query('SELECT * FROM savings_blocks WHERE account_id = $1 ORDER BY created_at', [a.id]);
  return rows.map(blockOut);
}

/** Unblock what is still blocked of a pending block (the reference platform: only a pending block, on an open account). */
async function unblockFunds(c, accountId, reference, { createdBy } = {}) {
  const a = await core.lock(c, accountId);
  if (!BLOCKABLE.includes(a.status)) throw err(`FUNDS_ARE_UNBLOCKED_ON_OPEN_ACCOUNTS: the account is ${a.status}`, 409);
  const { rows: [b] } = await c.query('SELECT * FROM savings_blocks WHERE account_id = $1 AND reference = $2 FOR UPDATE', [a.id, String(reference)]);
  if (!b) throw err(`BLOCK_NOT_FOUND: ${reference}`, 404);
  if (b.state !== 'PENDING') throw err(`BLOCK_IS_${b.state}`, 409);
  const { rows: [u] } = await c.query("UPDATE savings_blocks SET state = 'UNBLOCKED', closed_at = now() WHERE id = $1 RETURNING *", [b.id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_FUNDS_UNBLOCKED', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ reference: b.reference, amount: Number(b.amount), seized: Number(b.seized) }) });
  return blockOut(u);
}

/**
 * Seize blocked funds (the reference platform's seizure transaction, "Seized Amount"): all or
 * part of what a pending block still holds, no more than the balance. The
 * money leaves through the channel given (bank by default). The block is
 * SEIZED once nothing of it is left.
 */
async function seizeFunds(c, accountId, { blockId, amount, channelId = 'bank', notes = null, createdBy, user = null } = {}) {
  const a = await core.lock(c, accountId);
  if (!BLOCKABLE.includes(a.status)) throw err(`FUNDS_ARE_SEIZED_ON_OPEN_ACCOUNTS: the account is ${a.status}`, 409);
  const { rows: [b] } = await c.query('SELECT * FROM savings_blocks WHERE account_id = $1 AND (reference = $2 OR id::text = $2) FOR UPDATE',
    [a.id, String(blockId || '')]);
  if (!b) throw err(`BLOCK_NOT_FOUND: ${blockId}`, 404);
  if (b.state !== 'PENDING') throw err(`BLOCK_IS_${b.state}`, 409);
  const left = round2(Number(b.amount) - Number(b.seized));
  const amt = round2(amount ?? left);
  if (!(amt > 0)) throw err('INVALID_AMOUNT', 400);
  if (amt > left) throw err(`ABOVE_WHAT_THE_BLOCK_HOLDS: ${left}`, 409);
  if (amt > round2(a.balance)) throw err(`ABOVE_THE_BALANCE: ${round2(a.balance)}`, 409);
  const ch = await channels.assertUsable(c, channelId, { side: 'SAVINGS', type: 'WITHDRAWAL', amount: amt, productId: a.product_id, user });
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);
  const legs = core.outLegs(a, amt);
  const entryId = await core.postWithChannel(c, a, {
    channelGl: ch.gl_account_code, amount: amt, direction: 'OUT', productLegs: legs.debits,
    narration: notes || `Seizure ${a.account_no} (${b.reference})`, sourceType: 'SAVINGS_SEIZURE', channelId, createdBy,
  });
  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, a.id]);
  const seized = round2(Number(b.seized) + amt);
  await c.query('UPDATE savings_blocks SET seized = $2, state = $3, closed_at = CASE WHEN $3 = \'SEIZED\' THEN now() END WHERE id = $1',
    [b.id, seized, seized >= Number(b.amount) ? 'SEIZED' : 'PENDING']);
  return core.record(c, {
    reference: core.ref('SZ'), kind: 'SAVINGS_SEIZURE', memberId: a.member_id, savingsAccountId: a.id, channelId, amount: amt,
    branchId: a.branch_id, entryId, narration: notes, createdBy, allocation: { blockId: b.id, block: b.reference, ...legs.allocation },
  });
}

// --------------------------------------------------------------------------
// Transaction holds (the reference platform's Transaction Holds)
// --------------------------------------------------------------------------

const holdOut = (h) => ({
  externalReferenceId: h.external_reference_id, accountKey: h.account_id, creditDebitIndicator: h.indicator, amount: Number(h.amount),
  status: h.state, notes: h.notes, creationDate: h.created_at, closedDate: h.closed_at || null, transactionKey: h.transaction_id || null,
});

/**
 * Hold an amount (the reference platform's POST /deposits/{id}/authorizationholds): a debit
 * (DBIT) no larger than what is available, which it makes unavailable, or
 * a credit (CRDT) on its way. The external reference is unique and at most
 * 32 characters. Holds on deposit accounts do not expire.
 */
async function createHold(c, accountId, { externalReferenceId, amount, creditDebitIndicator = 'DBIT', notes = null, createdBy } = {}) {
  const a = await core.lock(c, accountId);
  const ind = String(creditDebitIndicator || 'DBIT').toUpperCase();
  if (!['DBIT', 'CRDT'].includes(ind)) throw err('CREDIT_DEBIT_INDICATOR_IS_DBIT_OR_CRDT', 400);
  const refId = String(externalReferenceId || '').trim();
  if (!refId || refId.length > 32) throw err('EXTERNAL_REFERENCE_ID_IS_1_TO_32_CHARACTERS', 400);
  const open = ind === 'DBIT' ? ['ACTIVE', 'IN_ARREARS', 'MATURED', 'DORMANT'] : ['ACTIVE', 'IN_ARREARS', 'APPROVED', 'DORMANT'];
  if (!open.includes(a.status)) throw err(`A_${ind}_HOLD_IS_NOT_TAKEN_ON_A_${a.status}_ACCOUNT`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT', 400);
  const { rows: [dupe] } = await c.query('SELECT 1 FROM savings_holds WHERE external_reference_id = $1', [refId]);
  if (dupe) throw err(`EXTERNAL_REFERENCE_ID_IN_USE: ${refId}`, 409);
  if (ind === 'DBIT') {
    const day = await orgToday(c);
    const hb = await core.heldBack(c, a.id);
    const available = round2(core.availableOf(core.onDay(a, day), await core.pledgedAmount(c, a.member_id)) - hb.blocked - hb.holds);
    if (amt > available) throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}, requested ${amt}`, 409);
  }
  const { rows: [h] } = await c.query(
    'INSERT INTO savings_holds (account_id, external_reference_id, indicator, amount, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [a.id, refId, ind, amt, notes, createdBy || 'SYSTEM']);
  return holdOut(h);
}

async function holdsOf(c, accountId, { status = null } = {}) {
  const a = await core.lock(c, accountId);
  const { rows } = await c.query('SELECT * FROM savings_holds WHERE account_id = $1 AND ($2::text IS NULL OR state = $2) ORDER BY created_at',
    [a.id, status ? String(status).toUpperCase() : null]);
  return rows.map(holdOut);
}

/** Reverse a pending hold (the reference platform: DELETE /deposits/{id}/authorizationholds/{ref}); it no longer holds anything. */
async function reverseHold(c, accountId, reference, { createdBy } = {}) {
  const a = await core.lock(c, accountId);
  const { rows: [h] } = await c.query('SELECT * FROM savings_holds WHERE external_reference_id = $1 AND account_id = $2 FOR UPDATE', [String(reference), a.id]);
  if (!h) throw err(`HOLD_NOT_FOUND: ${reference}`, 404);
  if (h.state !== 'PENDING') throw err(`HOLD_IS_${h.state}`, 409);
  const { rows: [u] } = await c.query("UPDATE savings_holds SET state = 'REVERSED', closed_at = now() WHERE id = $1 RETURNING *", [h.id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_HOLD_REVERSED', entity: 'savings_account', entityId: a.id, before: JSON.stringify(holdOut(h)) });
  return holdOut(u);
}

/** Pending blocks and holds keep an account open (closing it, or its holder's exit, waits for them). */
async function assertNothingPending(c, a) {
  const hb = await core.heldBack(c, a.id);
  if (hb.blocked > 0) throw err(`ACCOUNT_HAS_BLOCKED_FUNDS: ${hb.blocked}; unblock or seize them first`, 409);
  const { rows: [h] } = await c.query("SELECT count(*)::int AS n FROM savings_holds WHERE account_id = $1 AND state = 'PENDING'", [a.id]);
  if (h.n) throw err(`ACCOUNT_HAS_PENDING_HOLDS: ${h.n}; settle or reverse them first`, 409);
}

// --------------------------------------------------------------------------
// Withholding tax per account (the reference platform's :changeWithholdingTax)
// --------------------------------------------------------------------------

/** The withholding tax rate on interest applied on a day: the account's own source in force then, or the product's percentage. */
async function withholdingRate(c, a, date) {
  if (!a.withholding_source_id) return a.withholding_tax_percent === null || a.withholding_tax_percent === undefined ? null : Number(a.withholding_tax_percent);
  const { rows: [r] } = await c.query(
    'SELECT rate FROM index_rates WHERE source_id = $1 AND valid_from <= $2::date ORDER BY valid_from DESC LIMIT 1', [a.withholding_source_id, date]);
  return r ? Number(r.rate) : null;
}

/**
 * Give the account its own withholding tax source, from today (null goes
 * back to the product's). The change is kept (the reference platform's GET
 * /deposits/{id}/withholdingtaxes).
 */
async function changeWithholdingTax(c, accountId, { sourceId, createdBy } = {}) {
  const a = await core.lock(c, accountId);
  if (!core.OPEN.includes(a.status) && !['PENDING_APPROVAL', 'APPROVED'].includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  const src = sourceId === null || sourceId === undefined || sourceId === '' ? null : String(sourceId).toUpperCase();
  if (src) {
    const { rows: [r] } = await c.query('SELECT kind FROM index_rate_sources WHERE id = $1', [src]);
    if (!r || r.kind !== 'WITHHOLDING') throw err(`NOT_A_WITHHOLDING_TAX_SOURCE: ${src}`, 400);
    if (core.books(a) && !a.gl_tax_payable) throw err(`THE_PRODUCT_HAS_NO_TAXES_PAYABLE_ACCOUNT: ${a.product_id}`, 409);
    if (!a.interest_paid_into_account) throw err('WITHHOLDING_TAX_NEEDS_INTEREST_PAID_INTO_THE_ACCOUNT', 409);
  }
  const today = await orgToday(c);
  await c.query('UPDATE savings_accounts SET withholding_source_id = $2 WHERE id = $1', [a.id, src]);
  await c.query('INSERT INTO savings_withholding_changes (account_id, source_id, valid_from, created_by) VALUES ($1,$2,$3,$4)',
    [a.id, src, today, createdBy || 'SYSTEM']);
  const u = await core.lock(c, a.id);
  return { accountId: a.id, withholdingTaxSourceKey: src, validFrom: today, rate: await withholdingRate(c, u, today) };
}

async function withholdingHistory(c, accountId) {
  const a = await core.lock(c, accountId);
  const { rows } = await c.query('SELECT source_id, valid_from::text, created_by, created_at FROM savings_withholding_changes WHERE account_id = $1 ORDER BY created_at', [a.id]);
  return rows.map((r) => ({ withholdingTaxSourceKey: r.source_id, validFrom: r.valid_from, createdBy: r.created_by, creationDate: r.created_at }));
}

Object.assign(module.exports, {
  BLOCKABLE, blockOut, blockFunds, blocksOf, unblockFunds, seizeFunds, holdOut, createHold, holdsOf, reverseHold, assertNothingPending, withholdingRate, changeWithholdingTax, withholdingHistory,
});
