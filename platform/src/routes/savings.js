'use strict';

const CTL = require('../domain/controls');
const { can } = require('../lib/permissions');

const reportRoutes = require('./reports');
const { orgToday } = require('../lib/orgDate');
const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth, requirePermission } = require('../tenancy/resolve');
const { notFound } = require('../lib/http');
const { pageQuery, sendPage, pageParams } = require('../lib/page');
const S = require('../domain/savings');
const CF = require('../domain/customFields');
const acct = require('../domain/accounting');
const LOANS = require('../domain/loans');
const LT = require('../domain/loanTransfers');

const router = express.Router();

const tx = (handler) => [
  requireAuth(),
  async (req, res, next) => {
    try {
      const out = await withTenant(req.tenant.schema_name, (c) =>
        handler(c, req, res, { actor: req.auth.email, user: req.auth }));
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

router.post('/', ...tx(async (c, req, res, { user }) => {
  res.status(201);
  return await S.open(c, { ...req.body, user });
}));

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

router.post('/:id/deposits', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  await CTL.assertWithinLimit(c, user, 'deposit', req.body?.amount);
  const t = await S.deposit(c, req.params.id, { ...req.body, createdBy: actor, user });
  return CF.applyToTransaction(c, t, req.body?.customFields, { user });
}));

router.post('/:id/withdrawals', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  // offsetPledge is for collecting a guarantor's pledge (./loanClosures), never from the wire.
  const { offsetPledge: _ignored, ...body } = req.body || {};
  await CTL.assertWithinLimit(c, user, 'withdrawal', body.amount);
  const t = await S.withdraw(c, req.params.id, { ...body, createdBy: actor, user });
  return CF.applyToTransaction(c, t, body.customFields, { user });
}));

router.post('/:id/transfers', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  return await S.transfer(c, req.params.id, { ...req.body, createdBy: actor, user });
}));

// Edit the account (the reference platform's Editing Accounts): its name, notes, custom fields and maximum
// balance at any time, and its terms before activation (../domain/savings updateAccount).
router.patch('/:id', ...tx((c, req, _res, { actor, user }) => S.updateAccount(c, req.params.id, req.body || {}, { createdBy: actor, user })));

// A fixed deposit's or savings plan's maturity (the reference platform's Activate Maturity and Undo Maturity).
router.post('/:id/maturity', ...tx((c, req, _res, { actor }) =>
  S.startMaturity(c, req.params.id, { termLength: req.body?.termLength ?? null, createdBy: actor })));
router.delete('/:id/maturity', ...tx((c, req, _res, { actor }) => S.undoMaturity(c, req.params.id, { createdBy: actor })));

// The account's credit interest rate from a value date (the reference platform's POST /deposits/{id}:changeInterestRate).
const changeRate = tx((c, req, _res, { actor, user }) => {
  // POST /savings/:id is shared with :changeState in the permission table; this one needs EDIT_SAVINGS_ACCOUNT.
  if (!can(user, 'EDIT_SAVINGS_ACCOUNT')) throw acct.err('PERMISSION_REQUIRED: EDIT_SAVINGS_ACCOUNT', 403);
  return S.changeInterestRate(c, req.params.id, {
    interestRate: req.body?.interestRate, valueDate: req.body?.valueDate || null, notes: req.body?.notes || null, createdBy: actor,
  });
});
router.post('/:id\\:changeInterestRate', ...changeRate);
router.post('/:id/interest-rate', ...changeRate);

// The account's state (the reference platform's POST /deposits/{id}:changeState): APPROVE,
// UNDO_APPROVE, LOCK, UNLOCK, CLOSE, CLOSE_WITHDRAW, CLOSE_REJECT,
// CLOSE_WRITE_OFF, and UNDO_ACTIVATE, UNDO_CLOSE_WRITE_OFF and REOPEN. Each
// action checks its own permission (../domain/savings ACTIONS).
const changeState = tx((c, req, _res, { actor, user }) =>
  S.changeState(c, req.params.id, req.body?.action, { notes: req.body?.notes || null, user, createdBy: actor }));
router.post('/:id\\:changeState', ...changeState);
router.post('/:id/state', ...changeState);

// Delete an account nothing was ever posted to (DELETE_SAVINGS_ACCOUNT).
router.delete('/:id', ...tx((c, req, _res, { actor }) => S.deleteAccount(c, req.params.id, { createdBy: actor })));

router.post('/:id/fees', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  if (req.body?.amount !== undefined) await CTL.assertWithinLimit(c, user, 'fee', req.body.amount);
  return await S.applyFee(c, req.params.id, { ...req.body, createdBy: actor });
}));

router.put('/:id/overdraft', ...tx((c, req, _res, { actor }) =>
  S.setOverdraftLimit(c, req.params.id, {
    limit: req.body?.limit, expiryDate: req.body && 'expiryDate' in req.body ? req.body.expiryDate : req.body?.overdraftExpiryDate,
    interestRate: req.body?.interestRate, interestSpread: req.body?.interestSpread, createdBy: actor,
  })));

// Close an empty account (the reference platform's Close).
router.post('/:id/close', ...tx(async (c, req, _res, { actor }) => S.closeAccount(c, req.params.id, { createdBy: actor, notes: req.body?.notes || null })));

router.post('/:id/overdraft/write-off', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await S.writeOffOverdraft(c, req.params.id, { ...req.body, createdBy: actor });
}));

// Bring interest up to a date, and apply it when that date is an
// application date (or when told to). The end of day does both for every
// account; this is for one.
router.post('/:id/interest', ...tx(async (c, req, _res, { actor }) => {
  const date = req.body?.date || await orgToday(c);
  const accrued = await S.accrueInterest(c, req.params.id, { date, createdBy: actor });
  const applied = req.body?.apply ? await S.applyInterest(c, req.params.id, { date, createdBy: actor }) : [];
  return { accrued, applied };
}));

router.post('/:id/branch', ...tx((c, req, _res, { actor }) =>
  require('../domain/branches').moveAccount(c, { kind: 'SAVINGS', accountId: req.params.id, branchId: req.body?.branchId, createdBy: actor })));

// A repayment of a loan made from this account (any member's loan), as
// The reference platform's Transfer from a deposit account to a loan.
router.post('/:id/loan-repayments', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  if (!req.body?.loanAccountId) throw acct.err('LOAN_ACCOUNT_REQUIRED', 400);
  await CTL.assertWithinLimit(c, req.auth, 'repayment', req.body.amount);
  return await LT.repayFromDeposit(c, req.body.loanAccountId, { ...req.body, savingsAccountId: req.params.id, createdBy: actor, user: req.auth });
}));

// Reversing one half of a transfer with a loan (a repayment made from this
// account, or a disbursement into it) reverses the loan transaction, which
// reverses both (the reference platform: the transfer is reversed from the deposit account).
router.post('/transactions/:reference/reversal', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  const { rows: [t] } = await c.query('SELECT allocation FROM transactions WHERE reference = $1', [req.params.reference]);
  if (t?.allocation?.loanTransfer?.reference) {
    return await LOANS.reverseTransaction(c, t.allocation.loanTransfer.reference, { ...req.body, createdBy: actor });
  }
  return await S.reverseTransaction(c, req.params.reference, { ...req.body, createdBy: actor });
}));

// --- accounting -----------------------------------------------------------

const accounting = express.Router();


// Trial balance: opening balance, debits, credits, net change and closing
// balance per account; ?zeroBalances=true, ?glTypes=, ?branchId=, ?format=.
accounting.get('/trial-balance', requirePermission('VIEW_ACCOUNTING_REPORTS'), reportRoutes.trialBalance);

accounting.get('/journal', requireAuth(), async (req, res, next) => {
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
         AND ($4::uuid[] IS NULL OR l.branch_id = ANY($4::uuid[]))
       ORDER BY e.booking_date DESC, e.id, l.line_no`,
      // A branch-limited user reads the lines of their branches (lib/ledgerScope).
      [req.query.from || null, req.query.to || null, req.query.glCode || null, req.ledgerBranches || null],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

// The rollup checked against the lines. An auditor's endpoint: it answers
// "can I trust the numbers on the other reports" with a recomputation.
accounting.get('/verify', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => acct.verifyRollup(c, {
      from: req.query.from || null, to: req.query.to || null,
    })));
  } catch (e) { next(e); }
});

accounting.get('/gl', requireAuth(), async (req, res, next) => {
  try {
    // One query for every balance. This used to be a query per account.
    res.json(await withTenantRead(req.tenant.schema_name, (c) => acct.balances(c, {
      from: req.query.from || null, to: req.query.to || null,
    })));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.accounting = accounting;
