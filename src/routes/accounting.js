'use strict';

const express = require('express');
const store = require('../store');
const acct = require('../domain/accounting');
const { apiError, notFound, paginate, withPaginationHeaders, applyFilterCriteria } = require('../lib/http');

const router = express.Router();
const { JOURNAL_ENTRIES, GL_ACCOUNTS } = store;

const wrap = (fn) => (req, res) => {
  try { return fn(req, res); }
  catch (e) { return apiError(res, e.status || 500, e.status || 500, e.message); }
};

// --- journal entries ------------------------------------------------------
router.get('/journalentries', wrap((req, res) => {
  let rows = JOURNAL_ENTRIES;
  const { from, to, glAccountCode } = req.query;
  if (glAccountCode) rows = rows.filter((e) => e.glAccountCode === glAccountCode);
  if (from) rows = rows.filter((e) => new Date(e.bookingDate) >= new Date(from));
  if (to) rows = rows.filter((e) => new Date(e.bookingDate) <= new Date(to));
  const p = paginate(req, rows);
  withPaginationHeaders(res, p).json(p.page);
}));

router.post('/journalentries/:search(:search)', wrap((req, res) => {
  const rows = applyFilterCriteria(JOURNAL_ENTRIES, req.body?.filterCriteria);
  const p = paginate(req, rows);
  withPaginationHeaders(res, p).json(p.page);
}));

router.get('/journalentries/:entryId', wrap((req, res) => {
  const lines = JOURNAL_ENTRIES.filter(
    (e) => e.entryId === req.params.entryId || e.parentEntryId === req.params.entryId
  );
  return lines.length ? res.json(lines) : notFound(res, 'journal entry');
}));

router.post('/journalentries', wrap((req, res) => {
  const { debits, credits, bookingDate, notes, currencyCode } = req.body || {};
  const result = acct.post({ debits, credits, bookingDate, notes, currencyCode });
  res.status(201).json(result.lines);
}));

// Mambu has no DELETE on a posted entry. Reversal is the only correction.
router.post('/journalentries/:entryId/reversal', wrap((req, res) =>
  res.status(201).json(acct.reverse(req.params.entryId, req.body?.notes).lines)));

// --- general ledger -------------------------------------------------------
router.get('/glaccounts', wrap((req, res) => {
  const type = req.query.type;
  let rows = GL_ACCOUNTS;
  if (type) rows = rows.filter((a) => String(a.type).toUpperCase() === String(type).toUpperCase());
  res.json(rows.map((a) => ({ ...a, balance: acct.balance(a.code || a.glCode) })));
}));

router.get('/glaccounts/:code', wrap((req, res) => {
  const a = acct.glAccount(req.params.code);
  if (!a) return notFound(res, 'gl account');
  res.json({ ...a, balance: acct.balance(req.params.code) });
}));

router.get('/glaccounts/:code/balance', wrap((req, res) =>
  res.json({ glCode: req.params.code, balance: acct.balance(req.params.code, req.query) })));

// --- reporting ------------------------------------------------------------
router.get('/trialbalance', wrap((req, res) => {
  const rows = acct.trialBalance(req.query);
  const totals = rows.reduce(
    (t, r) => ({ debit: acct.round2(t.debit + r.debit), credit: acct.round2(t.credit + r.credit) }),
    { debit: 0, credit: 0 }
  );
  res.json({ rows, totals, balanced: totals.debit === totals.credit });
}));

module.exports = router;
