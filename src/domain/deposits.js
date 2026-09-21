'use strict';

const store = require('../store');
const acct = require('./accounting');
const { newKey } = require('../lib/resource');

const { SAVINGS, DEPOSIT_TRANSACTIONS, BLOCKS, TRANSACTION_CHANNELS } = store;
const round2 = acct.round2;

const GL = {
  BANK: '100-000-201',
  DEPOSITS: '200-000-101',
  OVERFLOW: '200-000-309',
  INTEREST_EXPENSE: '500-000-305',
  FEE_INCOME: '410-000-101',
};

const STATES = ['APPROVED', 'ACTIVE', 'ACTIVE_IN_ARREARS', 'MATURED', 'LOCKED', 'DORMANT', 'CLOSED', 'CLOSED_WITHDRAWN', 'CLOSED_REJECTED'];

const err = (code, status = 400) => Object.assign(new Error(code), { status });

function find(id) {
  return SAVINGS.find((a) => String(a.id) === String(id) || String(a.encodedKey) === String(id));
}

function normalise(acc) {
  if (!acc.encodedKey) acc.encodedKey = newKey();
  if (!acc.accountState) acc.accountState = 'ACTIVE';
  if (!acc.currencyCode) acc.currencyCode = 'KES';
  if (acc.balance === undefined) acc.balance = 0;
  if (acc.accruedInterest === undefined) acc.accruedInterest = 0;
  return acc;
}
SAVINGS.forEach(normalise);

function blockedAmount(acc) {
  return round2(BLOCKS.filter((b) => b.accountKey === acc.encodedKey && b.state === 'ACTIVE')
    .reduce((s, b) => s + Number(b.amount || 0), 0));
}

function balanceSummary(acc) {
  normalise(acc);
  const blocked = blockedAmount(acc);
  return {
    accountId: acc.id,
    totalBalance: round2(Number(acc.balance || 0)),
    availableBalance: round2(Number(acc.balance || 0) - blocked),
    blockedBalance: blocked,
    accruedInterest: round2(Number(acc.accruedInterest || 0)),
    overdraftAmount: 0,
    currencyCode: acc.currencyCode,
  };
}

function channel(id) {
  return TRANSACTION_CHANNELS.find((c) => c.id === id) || TRANSACTION_CHANNELS.find((c) => c.id === 'cash');
}

function record(acc, tx) {
  const row = {
    encodedKey: newKey(),
    transactionId: String(DEPOSIT_TRANSACTIONS.length + 5001),
    parentAccountKey: acc.encodedKey,
    accountId: acc.id,
    creationDate: new Date().toISOString(),
    valueDate: tx.valueDate || new Date().toISOString(),
    currencyCode: acc.currencyCode,
    adjustmentTransactionKey: null,
    ...tx,
  };
  DEPOSIT_TRANSACTIONS.push(row);
  return row;
}

function deposit(acc, { amount, channelId = 'mpesa', valueDate, notes = '' } = {}) {
  normalise(acc);
  if (!['ACTIVE', 'APPROVED', 'MATURED'].includes(acc.accountState)) throw err('ACCOUNT_NOT_ACTIVE', 409);
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw err('INVALID_DEPOSIT_AMOUNT');
  const ch = channel(channelId);

  const je = acct.post({
    debits: [{ glCode: ch.glAccountCode || GL.BANK, amount: amt }],
    credits: [{ glCode: GL.DEPOSITS, amount: amt }],
    notes: notes || `Deposit ${acc.id}`,
    accountKey: acc.encodedKey, channelId, bookingDate: valueDate || new Date().toISOString(),
  });

  acc.balance = round2(Number(acc.balance || 0) + amt);
  acc.last = (valueDate || new Date().toISOString()).slice(0, 10);
  return record(acc, { type: 'DEPOSIT', amount: amt, channelId, valueDate, notes, journalEntryId: je.entryId, runningBalance: acc.balance });
}

function withdraw(acc, { amount, channelId = 'mpesa', valueDate, notes = '' } = {}) {
  normalise(acc);
  if (acc.accountState !== 'ACTIVE') throw err('ACCOUNT_NOT_ACTIVE', 409);
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw err('INVALID_WITHDRAWAL_AMOUNT');
  const summary = balanceSummary(acc);
  if (amt > summary.availableBalance) throw err('INSUFFICIENT_AVAILABLE_BALANCE', 409);
  const ch = channel(channelId);

  const je = acct.post({
    debits: [{ glCode: GL.DEPOSITS, amount: amt }],
    credits: [{ glCode: ch.glAccountCode || GL.BANK, amount: amt }],
    notes: notes || `Withdrawal ${acc.id}`,
    accountKey: acc.encodedKey, channelId, bookingDate: valueDate || new Date().toISOString(),
  });

  acc.balance = round2(Number(acc.balance || 0) - amt);
  acc.last = (valueDate || new Date().toISOString()).slice(0, 10);
  return record(acc, { type: 'WITHDRAWAL', amount: amt, channelId, valueDate, notes, journalEntryId: je.entryId, runningBalance: acc.balance });
}

function transfer(fromAcc, { toAccountId, amount, valueDate, notes = '' } = {}) {
  const toAcc = find(toAccountId);
  if (!toAcc) throw err('DESTINATION_ACCOUNT_NOT_FOUND', 404);
  if (toAcc.encodedKey === fromAcc.encodedKey) throw err('SAME_ACCOUNT_TRANSFER', 400);
  const amt = round2(Number(amount));
  const summary = balanceSummary(fromAcc);
  if (amt > summary.availableBalance) throw err('INSUFFICIENT_AVAILABLE_BALANCE', 409);

  // Both legs sit inside member deposits, so the GL nets to zero. Still posted
  // so the movement is visible in the journal rather than implicit.
  const je = acct.post({
    debits: [{ glCode: GL.DEPOSITS, amount: amt }],
    credits: [{ glCode: GL.DEPOSITS, amount: amt }],
    notes: notes || `Transfer ${fromAcc.id} -> ${toAcc.id}`,
    accountKey: fromAcc.encodedKey, channelId: 'internal',
    bookingDate: valueDate || new Date().toISOString(),
  });

  fromAcc.balance = round2(Number(fromAcc.balance || 0) - amt);
  toAcc.balance = round2(Number(toAcc.balance || 0) + amt);

  const out = record(fromAcc, { type: 'TRANSFER', amount: -amt, channelId: 'internal', valueDate, notes, journalEntryId: je.entryId, transferDetails: { linkedAccountId: toAcc.id }, runningBalance: fromAcc.balance });
  record(toAcc, { type: 'TRANSFER', amount: amt, channelId: 'internal', valueDate, notes, journalEntryId: je.entryId, transferDetails: { linkedAccountId: fromAcc.id }, runningBalance: toAcc.balance });
  return out;
}

function applyFee(acc, { amount, feeName = 'Fee', notes = '' } = {}) {
  normalise(acc);
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw err('INVALID_FEE_AMOUNT');
  const je = acct.post({
    debits: [{ glCode: GL.DEPOSITS, amount: amt }],
    credits: [{ glCode: GL.FEE_INCOME, amount: amt }],
    notes: notes || `${feeName} ${acc.id}`, accountKey: acc.encodedKey,
  });
  acc.balance = round2(Number(acc.balance || 0) - amt);
  return record(acc, { type: 'FEE', amount: amt, feeName, notes, journalEntryId: je.entryId, runningBalance: acc.balance });
}

function applyInterest(acc, { annualRate = 0, notes = '' } = {}) {
  normalise(acc);
  const amt = round2((Number(acc.balance || 0) * Number(annualRate)) / 100 / 12);
  if (!(amt > 0)) return null;
  const je = acct.post({
    debits: [{ glCode: GL.INTEREST_EXPENSE, amount: amt }],
    credits: [{ glCode: GL.DEPOSITS, amount: amt }],
    notes: notes || `Interest ${acc.id}`, accountKey: acc.encodedKey,
  });
  acc.balance = round2(Number(acc.balance || 0) + amt);
  acc.accruedInterest = round2(Number(acc.accruedInterest || 0) + amt);
  return record(acc, { type: 'INTEREST_APPLIED', amount: amt, notes, journalEntryId: je.entryId, runningBalance: acc.balance });
}

function block(acc, { amount, reason = '', notes = '' } = {}) {
  normalise(acc);
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw err('INVALID_BLOCK_AMOUNT');
  if (amt > balanceSummary(acc).availableBalance) throw err('INSUFFICIENT_AVAILABLE_BALANCE', 409);
  const row = {
    encodedKey: newKey(), accountKey: acc.encodedKey, accountId: acc.id,
    amount: amt, reason, notes, state: 'ACTIVE', creationDate: new Date().toISOString(),
  };
  BLOCKS.push(row);
  return row;
}

function unblock(blockKey) {
  const b = BLOCKS.find((x) => x.encodedKey === blockKey);
  if (!b) throw err('BLOCK_NOT_FOUND', 404);
  b.state = 'RELEASED';
  b.releasedDate = new Date().toISOString();
  return b;
}

function seizeBlock(blockKey, { notes = '' } = {}) {
  const b = BLOCKS.find((x) => x.encodedKey === blockKey && x.state === 'ACTIVE');
  if (!b) throw err('BLOCK_NOT_FOUND', 404);
  const acc = find(b.accountId);
  const je = acct.post({
    debits: [{ glCode: GL.DEPOSITS, amount: b.amount }],
    credits: [{ glCode: GL.BANK, amount: b.amount }],
    notes: notes || `Seize block ${b.encodedKey}`, accountKey: acc.encodedKey,
  });
  b.state = 'SEIZED';
  acc.balance = round2(Number(acc.balance || 0) - b.amount);
  return record(acc, { type: 'SEIZE_BLOCK', amount: b.amount, notes, journalEntryId: je.entryId, runningBalance: acc.balance });
}

function adjustTransaction(transactionId, notes = 'Adjustment') {
  const tx = DEPOSIT_TRANSACTIONS.find((t) => t.transactionId === String(transactionId));
  if (!tx) throw err('TRANSACTION_NOT_FOUND', 404);
  if (tx.adjustmentTransactionKey) throw err('TRANSACTION_ALREADY_ADJUSTED', 409);
  const acc = find(tx.accountId);
  if (!acc) throw err('ACCOUNT_NOT_FOUND', 404);

  if (tx.journalEntryId) acct.reverse(tx.journalEntryId, notes);

  if (tx.type === 'DEPOSIT') acc.balance = round2(acc.balance - tx.amount);
  else if (tx.type === 'WITHDRAWAL' || tx.type === 'FEE') acc.balance = round2(acc.balance + tx.amount);
  else if (tx.type === 'TRANSFER') acc.balance = round2(acc.balance - tx.amount);

  const adj = record(acc, {
    type: `${tx.type}_ADJUSTMENT`, amount: -tx.amount, notes,
    originalTransactionId: tx.transactionId, runningBalance: acc.balance,
  });
  tx.adjustmentTransactionKey = adj.encodedKey;
  return adj;
}

function changeState(acc, action) {
  normalise(acc);
  const map = { APPROVE: 'ACTIVE', LOCK: 'LOCKED', UNLOCK: 'ACTIVE', CLOSE: 'CLOSED', REJECT: 'CLOSED_REJECTED', WITHDRAW: 'CLOSED_WITHDRAWN', MATURE: 'MATURED', DORMANT: 'DORMANT' };
  const next = map[String(action).toUpperCase()];
  if (!next) throw err(`UNSUPPORTED_ACTION: ${action}`);
  if (next === 'CLOSED' && round2(Number(acc.balance || 0)) !== 0) throw err('ACCOUNT_BALANCE_NOT_ZERO', 409);
  acc.accountState = next;
  return acc;
}

module.exports = {
  STATES, find, normalise, balanceSummary, blockedAmount, deposit, withdraw,
  transfer, applyFee, applyInterest, block, unblock, seizeBlock,
  adjustTransaction, changeState, record,
};
