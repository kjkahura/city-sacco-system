'use strict';

const express = require('express');
const store = require('../store');
const L = require('../domain/loans');
const { resourceRouter } = require('../lib/resource');
const { notFound, badRequest, apiError, paginate, withPaginationHeaders, shape, applyFilterCriteria } = require('../lib/http');

const router = express.Router();
const { LOANS, LOAN_TRANSACTIONS } = store;

const wrap = (fn) => (req, res) => {
  try { return fn(req, res); }
  catch (e) { return apiError(res, e.status || 500, e.status || 500, e.message); }
};

const load = (req, res, next) => {
  const loan = L.find(req.params.id);
  if (!loan) return notFound(res, 'loan account');
  req.loan = L.normalise(loan);
  next();
};

// --- transactions across all accounts ------------------------------------
router.get('/transactions', wrap((req, res) => {
  const p = paginate(req, LOAN_TRANSACTIONS);
  withPaginationHeaders(res, p).json(p.page);
}));

router.post('/transactions/search', wrap((req, res) => {
  const rows = applyFilterCriteria(LOAN_TRANSACTIONS, req.body?.filterCriteria);
  const p = paginate(req, rows);
  withPaginationHeaders(res, p).json(p.page);
}));

router.get('/transactions/:transactionId', wrap((req, res) => {
  const tx = LOAN_TRANSACTIONS.find((t) => t.transactionId === String(req.params.transactionId));
  return tx ? res.json(tx) : notFound(res, 'loan transaction');
}));

router.post('/transactions/:transactionId/adjustment', wrap((req, res) =>
  res.status(201).json(L.adjustTransaction(req.params.transactionId, req.body?.notes))));

// --- per-account ----------------------------------------------------------
router.get('/:id/balances', load, wrap((req, res) => res.json(L.balances(req.loan))));

router.get('/:id/schedule', load, wrap((req, res) => res.json(L.getSchedule(req.loan))));

router.get('/:id/schedule/preview', load, wrap((req, res) =>
  res.json(L.buildSchedule({ ...req.loan, ...req.query }, { preview: true }))));

router.post('/:id/schedule:preview', load, wrap((req, res) =>
  res.json(L.buildSchedule({ ...req.loan, ...req.body }, { preview: true }))));

router.get('/:id/installments', load, wrap((req, res) =>
  res.json(L.getSchedule(req.loan).installments)));

router.get('/:id/transactions', load, wrap((req, res) => {
  const rows = LOAN_TRANSACTIONS.filter((t) => t.accountId === req.loan.id);
  const p = paginate(req, rows);
  withPaginationHeaders(res, p).json(p.page);
}));

router.get('/:id/repayments', load, wrap((req, res) =>
  res.json(LOAN_TRANSACTIONS.filter((t) => t.accountId === req.loan.id && t.type === 'REPAYMENT'))));

// --- state changes --------------------------------------------------------
router.post('/:id/state', load, wrap((req, res) => {
  const action = req.body?.action;
  if (!action) return badRequest(res, 'MISSING_ACTION', 'action');
  return res.json(L.changeState(req.loan, action, req.body));
}));

for (const [path, action] of Object.entries({
  'submit-for-approval': 'SUBMIT_FOR_APPROVAL',
  approve: 'APPROVE',
  'undo-approve': 'UNDO_APPROVE',
  reject: 'REJECT',
  withdraw: 'WITHDRAW',
  close: 'CLOSE',
  reopen: 'REOPEN',
})) {
  router.post(`/:id/${path}`, load, wrap((req, res) =>
    res.json(L.changeState(req.loan, action, req.body))));
}

// --- money movement -------------------------------------------------------
router.post('/:id/disbursement-transactions', load, wrap((req, res) =>
  res.status(201).json(L.disburse(req.loan, req.body))));

router.post('/:id/repayment-transactions', load, wrap((req, res) =>
  res.status(201).json(L.repay(req.loan, req.body))));

router.post('/:id/fee-transactions', load, wrap((req, res) =>
  res.status(201).json(L.applyFee(req.loan, req.body))));

router.post('/:id/interest-applied-transactions', load, wrap((req, res) => {
  const tx = L.accrueInterest(req.loan, req.body);
  return tx ? res.status(201).json(tx) : badRequest(res, 'NO_INTEREST_TO_ACCRUE');
}));

router.post('/:id/payoff', load, wrap((req, res) =>
  res.status(201).json(L.payOff(req.loan, req.body))));

router.get('/:id/payoff/preview', load, wrap((req, res) =>
  res.json(L.previewPayOff(req.loan, req.query.asOf))));

// --- restructuring --------------------------------------------------------
router.post('/:id/writeoff-transactions', load, wrap((req, res) =>
  res.status(201).json(L.writeOff(req.loan, req.body))));

router.post('/:id/writeoff-transactions/undo', load, wrap((req, res) =>
  res.status(201).json(L.undoWriteOff(req.loan))));

router.post('/:id/reschedule', load, wrap((req, res) =>
  res.status(201).json(L.reschedule(req.loan, req.body))));

router.post('/:id/refinance', load, wrap((req, res) =>
  res.status(201).json(L.refinance(req.loan, req.body))));

// --- field-level changes --------------------------------------------------
for (const [path, field] of Object.entries({
  'interest-rate': 'interestRate',
  term: 'duration',
  'due-dates': 'dueDateOffset',
  'arrears-settings': 'arrearsSettings',
  'periodic-payment': 'periodicPayment',
  'repayment-value': 'repaymentValue',
})) {
  router.post(`/:id/${path}`, load, wrap((req, res) => {
    const value = req.body?.value ?? req.body?.[field];
    if (value === undefined) return badRequest(res, 'MISSING_VALUE', field);
    req.loan[field] = value;
    req.loan.lastModifiedDate = new Date().toISOString();
    if (['interestRate', 'duration'].includes(field)) L.buildSchedule(req.loan);
    return res.json(req.loan);
  }));
}

// --- baseline CRUD (mounted last so the action paths win) ------------------
router.use(resourceRouter(LOANS, {
  name: 'loan account',
  altIdFields: ['encodedKey'],
  map: (l) => ({ ...L.normalise(l), ...L.balances(l) }),
  validate: (b) => (!b.principal && !b.amount ? 'MISSING_PRINCIPAL' : null),
  onCreate: (row, body) => {
    row.accountState = 'PENDING_APPROVAL';
    row.status = 'PENDING_APPROVAL';
    row.principal = Number(body.principal ?? body.amount);
    row.duration = Number(body.duration ?? body.termInMonths ?? 12);
    row.principalDisbursed = 0;
    row.principalPaid = 0;
    row.interestPaid = 0;
    row.feesPaid = 0;
    row.interestAccrued = 0;
  },
}));

module.exports = router;
