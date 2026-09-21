'use strict';

const express = require('express');
const store = require('../store');
const D = require('../domain/deposits');
const { resourceRouter } = require('../lib/resource');
const { notFound, badRequest, apiError, paginate, withPaginationHeaders, shape, applyFilterCriteria } = require('../lib/http');

const router = express.Router();
const { SAVINGS, DEPOSIT_TRANSACTIONS, BLOCKS } = store;

const wrap = (fn) => (req, res) => {
  try { return fn(req, res); }
  catch (e) { return apiError(res, e.status || 500, e.status || 500, e.message); }
};

const load = (req, res, next) => {
  const acc = D.find(req.params.id);
  if (!acc) return notFound(res, 'deposit account');
  req.acc = D.normalise(acc);
  next();
};

// --- transactions ---------------------------------------------------------
router.get('/transactions', wrap((req, res) => {
  const p = paginate(req, DEPOSIT_TRANSACTIONS);
  withPaginationHeaders(res, p).json(p.page);
}));

router.post('/transactions/search', wrap((req, res) => {
  const rows = applyFilterCriteria(DEPOSIT_TRANSACTIONS, req.body?.filterCriteria);
  const p = paginate(req, rows);
  withPaginationHeaders(res, p).json(p.page);
}));

router.get('/transactions/:transactionId', wrap((req, res) => {
  const tx = DEPOSIT_TRANSACTIONS.find((t) => t.transactionId === String(req.params.transactionId));
  return tx ? res.json(tx) : notFound(res, 'deposit transaction');
}));

router.post('/transactions/:transactionId/adjustment', wrap((req, res) =>
  res.status(201).json(D.adjustTransaction(req.params.transactionId, req.body?.notes))));

// Bulk deposits, used for payroll runs.
router.post('/transactions/bulk', wrap((req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body?.transactions || [];
  const results = { succeeded: [], failed: [] };
  for (const item of items) {
    try {
      const acc = D.find(item.accountId);
      if (!acc) throw Object.assign(new Error('ACCOUNT_NOT_FOUND'), { status: 404 });
      results.succeeded.push(D.deposit(acc, item));
    } catch (e) {
      results.failed.push({ accountId: item.accountId, error: e.message });
    }
  }
  res.status(results.failed.length ? 207 : 201).json(results);
}));

// --- per-account ----------------------------------------------------------
router.get('/:id/balances', load, wrap((req, res) => res.json(D.balanceSummary(req.acc))));

router.get('/:id/transactions', load, wrap((req, res) => {
  const rows = DEPOSIT_TRANSACTIONS.filter((t) => t.accountId === req.acc.id);
  const p = paginate(req, rows);
  withPaginationHeaders(res, p).json(p.page);
}));

router.post('/:id/deposit-transactions', load, wrap((req, res) =>
  res.status(201).json(D.deposit(req.acc, req.body))));

router.post('/:id/withdrawal-transactions', load, wrap((req, res) =>
  res.status(201).json(D.withdraw(req.acc, req.body))));

router.post('/:id/transfer-transactions', load, wrap((req, res) =>
  res.status(201).json(D.transfer(req.acc, req.body))));

router.post('/:id/fee-transactions', load, wrap((req, res) =>
  res.status(201).json(D.applyFee(req.acc, req.body))));

router.post('/:id/interest-available-transactions', load, wrap((req, res) => {
  const tx = D.applyInterest(req.acc, req.body);
  return tx ? res.status(201).json(tx) : badRequest(res, 'NO_INTEREST_TO_APPLY');
}));

// --- blocks ---------------------------------------------------------------
router.get('/:id/blocks', load, wrap((req, res) =>
  res.json(BLOCKS.filter((b) => b.accountId === req.acc.id))));

router.post('/:id/blocks', load, wrap((req, res) =>
  res.status(201).json(D.block(req.acc, req.body))));

router.delete('/blocks/:blockKey', wrap((req, res) => res.json(D.unblock(req.params.blockKey))));

router.post('/blocks/:blockKey/seize', wrap((req, res) =>
  res.status(201).json(D.seizeBlock(req.params.blockKey, req.body))));

// --- state ----------------------------------------------------------------
router.post('/:id/state', load, wrap((req, res) => {
  if (!req.body?.action) return badRequest(res, 'MISSING_ACTION', 'action');
  return res.json(D.changeState(req.acc, req.body.action));
}));

// --- baseline CRUD --------------------------------------------------------
router.use(resourceRouter(SAVINGS, {
  name: 'deposit account',
  altIdFields: ['encodedKey'],
  map: (a) => ({ ...D.normalise(a), ...D.balanceSummary(a) }),
  onCreate: (row) => {
    row.accountState = row.accountState || 'APPROVED';
    row.balance = Number(row.balance || 0);
    row.accruedInterest = 0;
  },
}));

module.exports = router;
