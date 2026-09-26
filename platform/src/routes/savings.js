'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { notFound } = require('../lib/http');
const { pageQuery, sendPage, pageParams } = require('../lib/page');
const S = require('../domain/savings');
const acct = require('../domain/accounting');
const LOANS = require('../domain/loans');
const LT = require('../domain/loanTransfers');

const router = express.Router();
const TELLER = ['TENANT_ADMIN', 'MANAGER', 'TELLER'];
const APPROVER = ['TENANT_ADMIN', 'MANAGER'];

const tx = (handler, roles = []) => [
  requireAuth(...roles),
  async (req, res, next) => {
    try {
      const out = await withTenant(req.tenant.schema_name, (c) =>
        handler(c, req, res, { actor: req.auth.email }));
      if (out === undefined) return;
      if (out === null) return notFound(res, 'savings account');
      res.json(out);
    } catch (e) { next(e); }
  },
];

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT a.*, m.member_no, m.first_name, m.last_name
       FROM savings_accounts a JOIN members m ON m.id = a.member_id
       WHERE ($1::uuid IS NULL OR a.member_id = $1::uuid)
       ORDER BY a.account_no`,
      [req.query.memberId || null],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

router.post('/', ...tx(async (c, req, res) => {
  res.status(201);
  return await S.open(c, req.body);
}, TELLER));

router.get('/:id/balance', ...tx((c, req) => S.summary(c, req.params.id)));

router.get('/:id/transactions', requireAuth(), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT t.* FROM transactions t
       JOIN savings_accounts a ON a.id = t.savings_account_id
       WHERE a.id::text = $1 OR a.account_no = $1
       ORDER BY t.created_at DESC, t.id`,
      [req.params.id],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

router.post('/:id/deposits', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await S.deposit(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));

router.post('/:id/withdrawals', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await S.withdraw(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));

router.post('/:id/transfers', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await S.transfer(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));

router.post('/:id/fees', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await S.applyFee(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));

router.put('/:id/overdraft', ...tx((c, req, _res, { actor }) =>
  S.setOverdraftLimit(c, req.params.id, { limit: req.body?.limit, createdBy: actor }), APPROVER));

router.post('/:id/overdraft/write-off', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await S.writeOffOverdraft(c, req.params.id, { ...req.body, createdBy: actor });
}, APPROVER));

// Bring interest up to a date, and apply it when that date is an
// application date (or when told to). The end of day does both for every
// account; this is for one.
router.post('/:id/interest', ...tx(async (c, req, _res, { actor }) => {
  const date = req.body?.date || new Date().toISOString().slice(0, 10);
  const accrued = await S.accrueInterest(c, req.params.id, { date, createdBy: actor });
  const applied = req.body?.apply ? await S.applyInterest(c, req.params.id, { date, createdBy: actor }) : [];
  return { accrued, applied };
}, APPROVER));

router.post('/:id/branch', ...tx((c, req, _res, { actor }) =>
  require('../domain/branches').moveAccount(c, { kind: 'SAVINGS', accountId: req.params.id, branchId: req.body?.branchId, createdBy: actor }), APPROVER));

// A repayment of a loan made from this account (any member's loan), as
// Mambu's Transfer from a deposit account to a loan.
router.post('/:id/loan-repayments', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  if (!req.body?.loanAccountId) throw acct.err('LOAN_ACCOUNT_REQUIRED', 400);
  return await LT.repayFromDeposit(c, req.body.loanAccountId, { ...req.body, savingsAccountId: req.params.id, createdBy: actor, user: req.auth });
}, TELLER));

// Reversing one half of a transfer with a loan (a repayment made from this
// account, or a disbursement into it) reverses the loan transaction, which
// reverses both (Mambu: the transfer is reversed from the deposit account).
router.post('/transactions/:reference/reversal', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  const { rows: [t] } = await c.query('SELECT allocation FROM transactions WHERE reference = $1', [req.params.reference]);
  if (t?.allocation?.loanTransfer?.reference) {
    return await LOANS.reverseTransaction(c, t.allocation.loanTransfer.reference, { ...req.body, createdBy: actor });
  }
  return await S.reverseTransaction(c, req.params.reference, { ...req.body, createdBy: actor });
}, APPROVER));

// --- accounting -----------------------------------------------------------

const accounting = express.Router();

const LEDGER_READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'];

accounting.get('/trial-balance', requireAuth(...LEDGER_READER), async (req, res, next) => {
  try {
    // Unlike the statements, the trial balance pages by default: it is the
    // one report that lists every account that moved, and a mature chart of
    // accounts is long.
    const { offset, limit } = pageParams(req.query);
    res.json(await withTenantRead(req.tenant.schema_name, (c) => acct.trialBalance(c, {
      from: req.query.from || null, to: req.query.to || null, offset, limit, branchId: req.query.branchId || null,
    })));
  } catch (e) { next(e); }
});

accounting.get('/journal', requireAuth(...LEDGER_READER), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT e.id AS entry_id, e.booking_date, e.narration, e.source_type, e.channel_id,
              e.reversal_of, l.gl_code, g.name AS gl_name, l.direction, l.amount, l.line_no
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN gl_accounts g ON g.code = l.gl_code
       WHERE ($1::date IS NULL OR e.booking_date >= $1::date)
         AND ($2::date IS NULL OR e.booking_date <= $2::date)
         AND ($3::text IS NULL OR l.gl_code = $3::text)
       ORDER BY e.booking_date DESC, e.id, l.line_no`,
      [req.query.from || null, req.query.to || null, req.query.glCode || null],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

// The rollup checked against the lines. An auditor's endpoint: it answers
// "can I trust the numbers on the other reports" with a recomputation.
accounting.get('/verify', requireAuth(...LEDGER_READER), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => acct.verifyRollup(c, {
      from: req.query.from || null, to: req.query.to || null,
    })));
  } catch (e) { next(e); }
});

accounting.get('/gl', requireAuth(...LEDGER_READER), async (req, res, next) => {
  try {
    // One query for every balance. This used to be a query per account.
    res.json(await withTenantRead(req.tenant.schema_name, (c) => acct.balances(c, {
      from: req.query.from || null, to: req.query.to || null,
    })));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.accounting = accounting;
