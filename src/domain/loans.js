'use strict';

const store = require('../store');
const acct = require('./accounting');
const { newKey } = require('../lib/resource');

const { LOANS, LOAN_PRODUCTS, LOAN_TRANSACTIONS, LOAN_SCHEDULES, HOLIDAYS, HOLIDAY_SHIFT } = store;
const round2 = acct.round2;

const GL = {
  BANK: '100-000-201',
  INTEREST_RECEIVABLE: '100-000-401',
  DEPOSITS: '200-000-101',
};

// Mambu loan account states.
const STATES = [
  'PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE',
  'ACTIVE_IN_ARREARS', 'CLOSED', 'CLOSED_WRITTEN_OFF', 'CLOSED_REJECTED',
  'CLOSED_WITHDRAWN', 'CLOSED_REPAID', 'CLOSED_RESCHEDULED', 'CLOSED_REFINANCED',
];

// Which state changes Mambu permits, keyed by the action name.
const TRANSITIONS = {
  SUBMIT_FOR_APPROVAL: { from: ['PARTIAL_APPLICATION'], to: 'PENDING_APPROVAL' },
  APPROVE:             { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  UNDO_APPROVE:        { from: ['APPROVED'], to: 'PENDING_APPROVAL' },
  REJECT:              { from: ['PARTIAL_APPLICATION', 'PENDING_APPROVAL'], to: 'CLOSED_REJECTED' },
  WITHDRAW:            { from: ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED'], to: 'CLOSED_WITHDRAWN' },
  CLOSE:               { from: ['ACTIVE', 'ACTIVE_IN_ARREARS', 'APPROVED'], to: 'CLOSED' },
  REOPEN:              { from: ['CLOSED', 'CLOSED_REJECTED', 'CLOSED_WITHDRAWN'], to: 'PENDING_APPROVAL' },
};

const err = (code, status = 400) => Object.assign(new Error(code), { status });

function find(id) {
  return LOANS.find((l) => String(l.id) === String(id) || String(l.encodedKey) === String(id));
}

function productFor(loan) {
  return LOAN_PRODUCTS.find((p) => p.id === loan.productId) || LOAN_PRODUCTS[0];
}

/** Normalise the loose seed rows into the state machine's vocabulary. */
function normalise(loan) {
  if (!loan.accountState) {
    const legacy = String(loan.status || '').toUpperCase();
    loan.accountState = legacy === 'ACTIVE' ? 'ACTIVE' : legacy === 'CLOSED' ? 'CLOSED_REPAID' : 'PENDING_APPROVAL';
  }
  if (loan.principalDisbursed === undefined) {
    loan.principalDisbursed = loan.accountState.startsWith('ACTIVE') ? Number(loan.principal || 0) : 0;
  }
  if (loan.principalPaid === undefined) loan.principalPaid = 0;
  if (loan.interestPaid === undefined) loan.interestPaid = 0;
  if (loan.feesPaid === undefined) loan.feesPaid = 0;
  if (loan.interestAccrued === undefined) loan.interestAccrued = 0;
  if (loan.penaltyAccrued === undefined) loan.penaltyAccrued = 0;
  if (!loan.encodedKey) loan.encodedKey = newKey();
  if (!loan.currencyCode) loan.currencyCode = 'KES';
  return loan;
}
LOANS.forEach(normalise);

function balances(loan) {
  normalise(loan);
  const principalBalance = round2(Number(loan.principalDisbursed || 0) - Number(loan.principalPaid || 0));
  const interestBalance = round2(Number(loan.interestAccrued || 0) - Number(loan.interestPaid || 0));
  const feesBalance = round2(Number(loan.feesDue || 0) - Number(loan.feesPaid || 0));
  const penaltyBalance = round2(Number(loan.penaltyAccrued || 0) - Number(loan.penaltyPaid || 0));
  return {
    principalBalance,
    interestBalance,
    feesBalance,
    penaltyBalance,
    totalBalance: round2(principalBalance + interestBalance + feesBalance + penaltyBalance),
    principalDue: principalBalance,
    interestDue: interestBalance,
  };
}

// --------------------------------------------------------------------------
// Schedule
// --------------------------------------------------------------------------

const isHoliday = (iso) => HOLIDAYS?.some?.((h) => String(h.date).slice(0, 10) === iso.slice(0, 10));

/** Shift a due date off a holiday or weekend, forward, the way Mambu does. */
function adjustDueDate(date) {
  const d = new Date(date);
  for (let i = 0; i < 10; i++) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !isHoliday(iso)) break;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Flat-rate declining-installment schedule, which is what the seed products
 * describe (rate is a flat monthly percentage of original principal).
 */
function buildSchedule(loan, { preview = false } = {}) {
  normalise(loan);
  const product = productFor(loan);
  const principal = Number(loan.principal || 0);
  const months = Number(loan.duration || loan.termInMonths || 0);
  const monthlyRate = Number(loan.interestRate ?? product?.rate ?? 0) / 100;
  if (!principal || !months) throw err('LOAN_MISSING_PRINCIPAL_OR_TERM');

  const principalPerInstallment = round2(principal / months);
  const interestPerInstallment = round2(principal * monthlyRate);
  const start = new Date(loan.disbDate || loan.disbursementDate || new Date().toISOString());

  const installments = [];
  let principalRemaining = principal;
  for (let n = 1; n <= months; n++) {
    const due = new Date(start);
    due.setUTCMonth(due.getUTCMonth() + n);
    const principalAmount = n === months ? round2(principalRemaining) : principalPerInstallment;
    principalRemaining = round2(principalRemaining - principalAmount);
    installments.push({
      number: n,
      encodedKey: `${loan.encodedKey}-INST-${n}`,
      parentAccountKey: loan.encodedKey,
      dueDate: adjustDueDate(due),
      state: 'PENDING',
      principal: { amount: { expected: principalAmount, paid: 0, due: principalAmount } },
      interest: { amount: { expected: interestPerInstallment, paid: 0, due: interestPerInstallment } },
      fee: { amount: { expected: n === 1 ? Number(product?.fee || 0) : 0, paid: 0, due: n === 1 ? Number(product?.fee || 0) : 0 } },
      penalty: { amount: { expected: 0, paid: 0, due: 0 } },
      totalDue: round2(principalAmount + interestPerInstallment + (n === 1 ? Number(product?.fee || 0) : 0)),
    });
  }

  const schedule = {
    accountId: loan.id,
    currency: { code: loan.currencyCode },
    totals: {
      principal: principal,
      interest: round2(interestPerInstallment * months),
      fees: Number(product?.fee || 0),
      total: round2(principal + interestPerInstallment * months + Number(product?.fee || 0)),
    },
    installments,
  };
  if (!preview) LOAN_SCHEDULES[loan.id] = schedule;
  return schedule;
}

const getSchedule = (loan) => LOAN_SCHEDULES[loan.id] || buildSchedule(loan);

// --------------------------------------------------------------------------
// State changes
// --------------------------------------------------------------------------

function changeState(loan, action, { notes = '', userKey = 'SYSTEM' } = {}) {
  normalise(loan);
  const t = TRANSITIONS[String(action).toUpperCase()];
  if (!t) throw err(`UNSUPPORTED_ACTION: ${action}`);
  if (!t.from.includes(loan.accountState)) {
    throw err(`INVALID_STATE_TRANSITION: ${loan.accountState} -> ${t.to}`, 409);
  }
  const previous = loan.accountState;
  loan.accountState = t.to;
  loan.status = t.to;
  loan.lastModifiedDate = new Date().toISOString();
  if (t.to === 'APPROVED') loan.approvedDate = new Date().toISOString();
  recordTransaction(loan, {
    type: action.toUpperCase(),
    amount: 0,
    notes: notes || `${previous} -> ${t.to}`,
    userKey,
  });
  return loan;
}

// --------------------------------------------------------------------------
// Transactions
// --------------------------------------------------------------------------

function recordTransaction(loan, tx) {
  const row = {
    encodedKey: newKey(),
    transactionId: String(LOAN_TRANSACTIONS.length + 1001),
    parentAccountKey: loan.encodedKey,
    accountId: loan.id,
    creationDate: new Date().toISOString(),
    valueDate: tx.valueDate || new Date().toISOString(),
    currencyCode: loan.currencyCode,
    adjustmentTransactionKey: null,
    ...tx,
  };
  LOAN_TRANSACTIONS.push(row);
  return row;
}

function disburse(loan, { amount, channelId = 'bank', valueDate, notes = '' } = {}) {
  normalise(loan);
  if (loan.accountState !== 'APPROVED') throw err('LOAN_NOT_APPROVED', 409);
  const product = productFor(loan);
  const amt = round2(Number(amount ?? loan.principal));
  if (!(amt > 0)) throw err('INVALID_DISBURSEMENT_AMOUNT');

  const je = acct.post({
    debits: [{ glCode: product.glAsset, amount: amt }],
    credits: [{ glCode: GL.BANK, amount: amt }],
    notes: notes || `Disbursement ${loan.id}`,
    accountKey: loan.encodedKey,
    channelId,
    bookingDate: valueDate || new Date().toISOString(),
  });

  loan.principalDisbursed = round2(Number(loan.principalDisbursed || 0) + amt);
  loan.accountState = 'ACTIVE';
  loan.status = 'ACTIVE';
  loan.disbDate = (valueDate || new Date().toISOString()).slice(0, 10);
  loan.feesDue = round2(Number(loan.feesDue || 0) + Number(product?.fee || 0));
  buildSchedule(loan);

  return recordTransaction(loan, {
    type: 'DISBURSEMENT', amount: amt, channelId, valueDate, notes,
    journalEntryId: je.entryId, balances: balances(loan),
  });
}

/** Mambu allocation order: penalty, then fees, then interest, then principal. */
function repay(loan, { amount, channelId = 'mpesa', valueDate, notes = '' } = {}) {
  normalise(loan);
  if (!loan.accountState.startsWith('ACTIVE')) throw err('LOAN_NOT_ACTIVE', 409);
  let remaining = round2(Number(amount));
  if (!(remaining > 0)) throw err('INVALID_REPAYMENT_AMOUNT');

  const b = balances(loan);
  const product = productFor(loan);
  const take = (due) => { const t = Math.min(remaining, Math.max(0, due)); remaining = round2(remaining - t); return round2(t); };

  const penalty = take(b.penaltyBalance);
  const fees = take(b.feesBalance);
  const interest = take(b.interestBalance);
  const principal = take(b.principalBalance);
  const overpaid = remaining;

  const total = round2(penalty + fees + interest + principal + overpaid);
  const credits = [];
  if (principal) credits.push({ glCode: product.glAsset, amount: principal });
  if (interest) credits.push({ glCode: product.glIncome, amount: interest });
  if (fees) credits.push({ glCode: product.glIncome, amount: fees });
  if (penalty) credits.push({ glCode: product.glIncome, amount: penalty });
  if (overpaid) credits.push({ glCode: GL.DEPOSITS, amount: overpaid });

  const je = acct.post({
    debits: [{ glCode: GL.BANK, amount: total }],
    credits,
    notes: notes || `Repayment ${loan.id}`,
    accountKey: loan.encodedKey,
    channelId,
    bookingDate: valueDate || new Date().toISOString(),
  });

  loan.principalPaid = round2(Number(loan.principalPaid || 0) + principal);
  loan.interestPaid = round2(Number(loan.interestPaid || 0) + interest);
  loan.feesPaid = round2(Number(loan.feesPaid || 0) + fees);
  loan.penaltyPaid = round2(Number(loan.penaltyPaid || 0) + penalty);

  applyToSchedule(loan, principal, interest, fees);

  const after = balances(loan);
  if (after.totalBalance <= 0) { loan.accountState = 'CLOSED_REPAID'; loan.status = 'CLOSED_REPAID'; }

  return recordTransaction(loan, {
    type: 'REPAYMENT', amount: total, channelId, valueDate, notes,
    journalEntryId: je.entryId,
    affectedAmounts: { principalAmount: principal, interestAmount: interest, feesAmount: fees, penaltyAmount: penalty, overpaymentAmount: overpaid },
    balances: after,
  });
}

function applyToSchedule(loan, principal, interest, fees) {
  const sch = getSchedule(loan);
  let p = principal, i = interest, f = fees;
  for (const inst of sch.installments) {
    if (inst.state === 'PAID') continue;
    const pa = Math.min(p, inst.principal.amount.due); inst.principal.amount.paid += pa; inst.principal.amount.due = round2(inst.principal.amount.due - pa); p = round2(p - pa);
    const ia = Math.min(i, inst.interest.amount.due); inst.interest.amount.paid += ia; inst.interest.amount.due = round2(inst.interest.amount.due - ia); i = round2(i - ia);
    const fa = Math.min(f, inst.fee.amount.due); inst.fee.amount.paid += fa; inst.fee.amount.due = round2(inst.fee.amount.due - fa); f = round2(f - fa);
    if (!inst.principal.amount.due && !inst.interest.amount.due && !inst.fee.amount.due) inst.state = 'PAID';
    else if (inst.principal.amount.paid || inst.interest.amount.paid) inst.state = 'PARTIALLY_PAID';
    if (!p && !i && !f) break;
  }
}

function applyFee(loan, { amount, feeName = 'Manual fee', channelId = 'internal', notes = '' }) {
  normalise(loan);
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw err('INVALID_FEE_AMOUNT');
  const product = productFor(loan);
  const je = acct.post({
    debits: [{ glCode: product.glAsset, amount: amt }],
    credits: [{ glCode: product.glIncome, amount: amt }],
    notes: notes || `${feeName} ${loan.id}`,
    accountKey: loan.encodedKey, channelId,
  });
  loan.feesDue = round2(Number(loan.feesDue || 0) + amt);
  return recordTransaction(loan, { type: 'FEE', amount: amt, feeName, channelId, notes, journalEntryId: je.entryId, balances: balances(loan) });
}

function accrueInterest(loan, { asOf = new Date().toISOString() } = {}) {
  normalise(loan);
  if (!loan.accountState.startsWith('ACTIVE')) return null;
  const product = productFor(loan);
  const monthlyRate = Number(loan.interestRate ?? product?.rate ?? 0) / 100;
  const amt = round2(Number(loan.principal || 0) * monthlyRate);
  if (!(amt > 0)) return null;
  const je = acct.post({
    debits: [{ glCode: GL.INTEREST_RECEIVABLE, amount: amt }],
    credits: [{ glCode: product.glIncome, amount: amt }],
    notes: `Interest accrual ${loan.id}`,
    accountKey: loan.encodedKey, bookingDate: asOf,
  });
  loan.interestAccrued = round2(Number(loan.interestAccrued || 0) + amt);
  return recordTransaction(loan, { type: 'INTEREST_APPLIED', amount: amt, valueDate: asOf, journalEntryId: je.entryId, balances: balances(loan) });
}

function writeOff(loan, { notes = '' } = {}) {
  normalise(loan);
  if (!loan.accountState.startsWith('ACTIVE')) throw err('LOAN_NOT_ACTIVE', 409);
  const b = balances(loan);
  const product = productFor(loan);
  const je = acct.post({
    debits: [{ glCode: product.glIncome, amount: b.totalBalance }],
    credits: [{ glCode: product.glAsset, amount: b.totalBalance }],
    notes: notes || `Write off ${loan.id}`,
    accountKey: loan.encodedKey,
  });
  loan.writeOffAmount = b.totalBalance;
  loan.writeOffJournalEntryId = je.entryId;
  loan.accountState = 'CLOSED_WRITTEN_OFF';
  loan.status = 'CLOSED_WRITTEN_OFF';
  return recordTransaction(loan, { type: 'WRITE_OFF', amount: b.totalBalance, notes, journalEntryId: je.entryId, balances: balances(loan) });
}

function undoWriteOff(loan) {
  normalise(loan);
  if (loan.accountState !== 'CLOSED_WRITTEN_OFF') throw err('LOAN_NOT_WRITTEN_OFF', 409);
  acct.reverse(loan.writeOffJournalEntryId, `Undo write off ${loan.id}`);
  loan.accountState = 'ACTIVE';
  loan.status = 'ACTIVE';
  delete loan.writeOffAmount;
  return recordTransaction(loan, { type: 'WRITE_OFF_ADJUSTMENT', amount: 0, balances: balances(loan) });
}

function adjustTransaction(transactionId, notes = 'Adjustment') {
  const tx = LOAN_TRANSACTIONS.find((t) => t.transactionId === String(transactionId));
  if (!tx) throw err('TRANSACTION_NOT_FOUND', 404);
  if (tx.adjustmentTransactionKey) throw err('TRANSACTION_ALREADY_ADJUSTED', 409);
  const loan = find(tx.accountId);
  if (!loan) throw err('LOAN_NOT_FOUND', 404);

  if (tx.journalEntryId) acct.reverse(tx.journalEntryId, notes);

  if (tx.type === 'REPAYMENT' && tx.affectedAmounts) {
    const a = tx.affectedAmounts;
    loan.principalPaid = round2(loan.principalPaid - (a.principalAmount || 0));
    loan.interestPaid = round2(loan.interestPaid - (a.interestAmount || 0));
    loan.feesPaid = round2(loan.feesPaid - (a.feesAmount || 0));
    loan.penaltyPaid = round2((loan.penaltyPaid || 0) - (a.penaltyAmount || 0));
    if (loan.accountState === 'CLOSED_REPAID') { loan.accountState = 'ACTIVE'; loan.status = 'ACTIVE'; }
  }
  if (tx.type === 'DISBURSEMENT') loan.principalDisbursed = round2(loan.principalDisbursed - tx.amount);

  const adj = recordTransaction(loan, {
    type: `${tx.type}_ADJUSTMENT`, amount: -tx.amount, notes,
    originalTransactionId: tx.transactionId, balances: balances(loan),
  });
  tx.adjustmentTransactionKey = adj.encodedKey;
  return adj;
}

function payOff(loan, { channelId = 'bank', notes = '' } = {}) {
  const b = balances(loan);
  if (b.totalBalance <= 0) throw err('LOAN_ALREADY_SETTLED', 409);
  return repay(loan, { amount: b.totalBalance, channelId, notes: notes || `Pay off ${loan.id}` });
}

function previewPayOff(loan, _asOf) {
  const b = balances(loan);
  return { accountId: loan.id, payOffAmount: b.totalBalance, breakdown: b, asOf: _asOf || new Date().toISOString() };
}

function reschedule(loan, { termInMonths, interestRate, notes = '' } = {}) {
  normalise(loan);
  if (!loan.accountState.startsWith('ACTIVE')) throw err('LOAN_NOT_ACTIVE', 409);
  const b = balances(loan);
  loan.accountState = 'CLOSED_RESCHEDULED';
  loan.status = 'CLOSED_RESCHEDULED';

  const child = normalise({
    ...loan,
    id: `${loan.id}-R${(loan.rescheduleCount || 0) + 1}`,
    encodedKey: newKey(),
    parentAccountKey: loan.encodedKey,
    accountState: 'ACTIVE',
    status: 'ACTIVE',
    principal: b.principalBalance,
    principalDisbursed: b.principalBalance,
    principalPaid: 0, interestPaid: 0, feesPaid: 0, interestAccrued: 0,
    duration: Number(termInMonths || loan.duration),
    interestRate: interestRate ?? loan.interestRate,
    rescheduleCount: (loan.rescheduleCount || 0) + 1,
    disbDate: new Date().toISOString().slice(0, 10),
  });
  LOANS.unshift(child);
  buildSchedule(child);
  recordTransaction(loan, { type: 'RESCHEDULE', amount: b.principalBalance, notes, childAccountId: child.id });
  return child;
}

function refinance(loan, { topUpAmount = 0, termInMonths, notes = '' } = {}) {
  normalise(loan);
  if (!loan.accountState.startsWith('ACTIVE')) throw err('LOAN_NOT_ACTIVE', 409);
  const b = balances(loan);
  loan.accountState = 'CLOSED_REFINANCED';
  loan.status = 'CLOSED_REFINANCED';

  const child = normalise({
    ...loan,
    id: `${loan.id}-F${(loan.refinanceCount || 0) + 1}`,
    encodedKey: newKey(),
    parentAccountKey: loan.encodedKey,
    accountState: 'APPROVED',
    status: 'APPROVED',
    principal: round2(b.principalBalance + Number(topUpAmount || 0)),
    principalDisbursed: 0, principalPaid: 0, interestPaid: 0, feesPaid: 0, interestAccrued: 0,
    duration: Number(termInMonths || loan.duration),
    refinanceCount: (loan.refinanceCount || 0) + 1,
  });
  LOANS.unshift(child);
  recordTransaction(loan, { type: 'REFINANCE', amount: b.principalBalance, notes, childAccountId: child.id });
  return child;
}

module.exports = {
  STATES, TRANSITIONS, find, normalise, balances, buildSchedule, getSchedule,
  adjustDueDate, changeState, disburse, repay, applyFee, accrueInterest,
  writeOff, undoWriteOff, adjustTransaction, payOff, previewPayOff,
  reschedule, refinance, recordTransaction, productFor,
};
