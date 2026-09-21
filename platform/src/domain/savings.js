'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * Savings. Every function takes an open tenant client.
 *
 * Balances are mutated in SQL on the numeric column, never read into JS,
 * changed, and written back. That closes the read-modify-write race two
 * tellers posting to the same account at once would otherwise hit, and it
 * keeps the arithmetic in exact decimal rather than binary float.
 */

async function lock(c, accountId) {
  const { rows } = await c.query(
    `SELECT a.*, p.gl_liability, p.gl_interest_exp, p.withdrawable, p.min_balance
     FROM savings_accounts a
     JOIN savings_products p ON p.id = a.product_id
     WHERE a.id = $1 OR a.account_no = $1::text
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

/** Amount pledged as loan security and therefore not withdrawable. */
async function pledgedAmount(c, memberId) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(pledged_amount), 0) AS total
     FROM loan_guarantors WHERE member_id = $1 AND status = 'PLEDGED'`,
    [memberId]
  );
  return round2(r.total);
}

async function summary(c, accountId) {
  const a = await lock(c, accountId);
  const pledged = await pledgedAmount(c, a.member_id);
  return {
    accountId: a.id,
    accountNo: a.account_no,
    memberId: a.member_id,
    status: a.status,
    balance: round2(a.balance),
    pledged,
    minBalance: round2(a.min_balance),
    available: round2(Math.max(0, a.balance - pledged - a.min_balance)),
  };
}

const ref = (kind) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

async function record(c, row) {
  const { rows } = await c.query(
    `INSERT INTO transactions
       (reference, kind, member_id, savings_account_id, loan_account_id, share_account_id,
        channel_id, amount, value_date, entry_id, allocation, narration, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, current_date),$10,$11,$12,$13)
     RETURNING *`,
    [row.reference, row.kind, row.memberId || null, row.savingsAccountId || null,
     row.loanAccountId || null, row.shareAccountId || null, row.channelId || null,
     row.amount, row.valueDate || null, row.entryId || null,
     JSON.stringify(row.allocation || {}), row.narration || null, row.createdBy || 'SYSTEM']
  );
  return rows[0];
}

async function deposit(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy }) {
  const a = await lock(c, accountId);
  if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');
  const ch = await channel(c, channelId);
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  const entry = await acct.post(c, {
    debits: [{ glCode: ch.gl_account_code, amount: amt, memberId: a.member_id }],
    credits: [{ glCode: a.gl_liability, amount: amt, memberId: a.member_id }],
    narration: narration || `Savings deposit ${a.account_no}`,
    sourceType: 'SAVINGS_DEPOSIT', channelId, bookingDate: valueDate, createdBy,
  });

  await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, a.id]);
  return record(c, {
    reference: ref('SD'), kind: 'SAVINGS_DEPOSIT', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate,
    entryId: entry.entryId, narration, createdBy,
  });
}

async function withdraw(c, accountId, { amount, channelId = 'cash', valueDate, narration, createdBy }) {
  const a = await lock(c, accountId);
  if (a.status !== 'ACTIVE') throw err(`ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (!a.withdrawable) throw err('PRODUCT_NOT_WITHDRAWABLE', 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');

  const pledged = await pledgedAmount(c, a.member_id);
  const available = round2(a.balance - pledged - a.min_balance);
  if (amt > available) {
    throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}, requested ${amt}` +
      (pledged ? ` (${pledged} pledged as loan security)` : ''), 409);
  }
  const ch = await channel(c, channelId);

  const entry = await acct.post(c, {
    debits: [{ glCode: a.gl_liability, amount: amt, memberId: a.member_id }],
    credits: [{ glCode: ch.gl_account_code, amount: amt, memberId: a.member_id }],
    narration: narration || `Savings withdrawal ${a.account_no}`,
    sourceType: 'SAVINGS_WITHDRAWAL', channelId, bookingDate: valueDate, createdBy,
  });

  // The CHECK constraint on savings_accounts.balance is the last line of
  // defence if the availability maths above is ever wrong.
  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, a.id]);
  return record(c, {
    reference: ref('SW'), kind: 'SAVINGS_WITHDRAWAL', memberId: a.member_id,
    savingsAccountId: a.id, channelId, amount: amt, valueDate,
    entryId: entry.entryId, narration, createdBy,
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
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_AMOUNT');

  const pledged = await pledgedAmount(c, from.member_id);
  const available = round2(from.balance - pledged - from.min_balance);
  if (amt > available) throw err(`INSUFFICIENT_AVAILABLE_BALANCE: available ${available}`, 409);

  const entry = await acct.post(c, {
    debits: [{ glCode: from.gl_liability, amount: amt, memberId: from.member_id }],
    credits: [{ glCode: to.gl_liability, amount: amt, memberId: to.member_id }],
    narration: narration || `Transfer ${from.account_no} to ${to.account_no}`,
    sourceType: 'SAVINGS_TRANSFER', channelId: 'internal', bookingDate: valueDate, createdBy,
  });

  await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [amt, from.id]);
  await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [amt, to.id]);

  return record(c, {
    reference: ref('ST'), kind: 'SAVINGS_TRANSFER', memberId: from.member_id,
    savingsAccountId: from.id, channelId: 'internal', amount: amt, valueDate,
    entryId: entry.entryId, allocation: { toAccountId: to.id, toAccountNo: to.account_no },
    narration, createdBy,
  });
}

/** Reverse a posted savings transaction. Never edits the original. */
async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy } = {}) {
  const { rows } = await c.query(
    'SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]
  );
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.savings_account_id) throw err('NOT_A_SAVINGS_TRANSACTION');

  const entry = await acct.reverse(c, tx.entry_id, narration, createdBy);

  const delta = tx.kind === 'SAVINGS_DEPOSIT' ? -tx.amount
    : tx.kind === 'SAVINGS_WITHDRAWAL' ? tx.amount
    : tx.kind === 'SAVINGS_TRANSFER' ? tx.amount
    : 0;
  await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [delta, tx.savings_account_id]);
  if (tx.kind === 'SAVINGS_TRANSFER' && tx.allocation?.toAccountId) {
    await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2',
      [tx.amount, tx.allocation.toAccountId]);
  }

  const rev = await record(c, {
    reference: ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    savingsAccountId: tx.savings_account_id, amount: -tx.amount,
    entryId: entry.entryId, allocation: { reversalOf: tx.reference }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

async function open(c, { memberId, productId = 'SAV01', accountNo }) {
  const no = accountNo || (await c.query(
    `SELECT 'SA' || lpad((count(*)+1)::text, 6, '0') AS n FROM savings_accounts`)).rows[0].n;
  const { rows } = await c.query(
    `INSERT INTO savings_accounts (account_no, member_id, product_id, status)
     VALUES ($1,$2,$3,'ACTIVE') RETURNING *`,
    [no, memberId, productId]
  );
  return rows[0];
}

module.exports = { open, deposit, withdraw, transfer, summary, reverseTransaction, pledgedAmount, lock, record, ref };
