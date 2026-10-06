'use strict';

const { notAfterToday } = require('../lib/valueDates');

const CTL = require('../domain/controls');
const { can } = require('../lib/permissions');

const reportRoutes = require('./reports');
const { orgToday } = require('../lib/orgDate');
const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { requireAuth, requirePermission } = require('../tenancy/resolve');
const { notFound } = require('../lib/http');
const { pageQuery, sendPage } = require('../lib/page');
const S = require('../domain/savings');
const CF = require('../domain/customFields');
const acct = require('../domain/accounting');
const LOANS = require('../domain/loans');
const LT = require('../domain/loanTransfers');
const H = require('../lib/handlers');
const { json } = H;
const tx = (handler) => H.tx(handler, 'savings account');

const router = express.Router();

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

// Bulk deposits (the reference platform's POST /deposits/deposit-transactions:bulk): each
// deposit posts on its own, under the same checks as one; the outcome is
// kept under a process key for GET /api/bulks/:key.
const bulkDeposits = tx(async (c, req, res, { actor, user }) => {
  const list = Array.isArray(req.body?.transactions) ? req.body.transactions : null;
  if (!list || !list.length) throw acct.err('TRANSACTIONS_IS_A_LIST', 400);
  if (list.length > 1000) throw acct.err('AT_MOST_1000_TRANSACTIONS', 400);
  const items = [];
  const errors = [];
  for (const [index, t] of list.entries()) {
    await c.query('SAVEPOINT bulk_item');
    try {
      await CTL.assertWithinLimit(c, user, 'deposit', t.amount);
      const d = await S.deposit(c, String(t.accountId || ''), {
        amount: t.amount, channelId: t.transactionDetails?.transactionChannelId || t.channelId || 'cash', valueDate: t.valueDate || undefined,
        narration: t.notes || null, createdBy: actor, user,
      });
      await CF.applyToTransaction(c, d, t.customFields, { user });
      await c.query('RELEASE SAVEPOINT bulk_item');
      items.push({ index, accountId: t.accountId, externalId: t.externalId || null, transactionReference: d.reference, amount: Number(d.amount) });
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT bulk_item');
      errors.push({ index, accountId: t.accountId, externalId: t.externalId || null, errorReason: e.message });
    }
  }
  const key = `BULK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  const status = errors.length ? (items.length ? 'COMPLETED_WITH_ERRORS' : 'FAILED') : 'COMPLETED';
  await c.query(`INSERT INTO bulk_processes (process_key, kind, status, items, errors, created_by, finished_at)
    VALUES ($1,'DEPOSIT',$2,$3,$4,$5,now())`, [key, status, JSON.stringify(items), JSON.stringify(errors), actor]);
  res.status(202);
  return { bulkProcessKey: key, status, processed: items.length, failed: errors.length };
});
router.post('/deposit-transactions\\:bulk', ...bulkDeposits);

// Reverse several transactions at once (the reference platform's bulk deposit corrections), each on its own.
router.post('/transactions/reversals', ...tx(async (c, req, _res, { actor }) => {
  const refs = Array.isArray(req.body?.references) ? req.body.references : null;
  if (!refs || !refs.length) throw acct.err('REFERENCES_IS_A_LIST', 400);
  if (refs.length > 1000) throw acct.err('AT_MOST_1000_REFERENCES', 400);
  const done = [];
  const errors = [];
  for (const r of refs) {
    await c.query('SAVEPOINT bulk_rev');
    try {
      const { rows: [t] } = await c.query('SELECT allocation FROM transactions WHERE reference = $1', [String(r)]);
      const rev = t?.allocation?.loanTransfer?.reference
        ? await LOANS.reverseTransaction(c, t.allocation.loanTransfer.reference, { narration: req.body?.notes || 'Reversal', createdBy: actor })
        : await S.reverseTransaction(c, String(r), { narration: req.body?.notes || 'Reversal', createdBy: actor });
      await c.query('RELEASE SAVEPOINT bulk_rev');
      done.push({ reference: r, reversal: rev.reference });
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT bulk_rev');
      errors.push({ reference: r, errorReason: e.message });
    }
  }
  return { reversed: done, errors };
}));

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
  // Money leaving an account by transfer is held to the user's withdrawal limit, as cash is.
  await CTL.assertWithinLimit(c, user, 'withdrawal', req.body?.amount);
  const t = await S.transfer(c, req.params.id, { ...req.body, createdBy: actor, user });
  return CF.applyToTransaction(c, t, req.body?.customFields, { user });
}));

// Blocked funds (the reference platform's /deposits/{id}/blocks) and seizures (/seizure-transactions), BLOCK_AND_SEIZE_FUNDS.
router.get('/:id/blocks', ...tx((c, req) => S.blocksOf(c, req.params.id)));
router.post('/:id/blocks', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return S.blockFunds(c, req.params.id, { externalReferenceId: req.body?.externalReferenceId, amount: req.body?.amount, notes: req.body?.notes || null, createdBy: actor });
}));
router.delete('/:id/blocks/:reference', ...tx((c, req, _res, { actor }) => S.unblockFunds(c, req.params.id, req.params.reference, { createdBy: actor })));
router.post('/:id/seizure-transactions', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  return S.seizeFunds(c, req.params.id, { blockId: req.body?.blockId, amount: req.body?.amount,
    channelId: req.body?.transactionChannelId || req.body?.channelId || 'bank', notes: req.body?.notes || null, createdBy: actor, user });
}));

// Transaction holds (the reference platform's /deposits/{id}/authorizationholds): CREATE_HOLDS, VIEW_HOLDS, DELETE_HOLDS.
// A deposit or withdrawal naming holdExternalReferenceId settles one (UPDATE_HOLDS).
router.get('/:id/authorizationholds', ...tx((c, req) => S.holdsOf(c, req.params.id, { status: req.query.status || null })));
router.post('/:id/authorizationholds', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return S.createHold(c, req.params.id, { ...req.body, createdBy: actor });
}));
router.delete('/:id/authorizationholds/:reference', ...tx((c, req, _res, { actor }) => S.reverseHold(c, req.params.id, req.params.reference, { createdBy: actor })));

// The account's own withholding tax source (the reference platform's :changeWithholdingTax) and its history.
router.post('/:id\\:changeWithholdingTax', ...tx((c, req, _res, { actor, user }) => {
  if (!can(user, 'EDIT_SAVINGS_ACCOUNT')) throw acct.err('PERMISSION_REQUIRED: EDIT_SAVINGS_ACCOUNT', 403);
  const b = req.body || {};
  return S.changeWithholdingTax(c, req.params.id, { sourceId: 'withholdingTaxSourceKey' in b ? b.withholdingTaxSourceKey : b.sourceId, createdBy: actor });
}));
router.get('/:id/withholdingtaxes', ...tx((c, req) => S.withholdingHistory(c, req.params.id)));

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
  await notAfterToday(c, req.body?.valueDate);
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
  await notAfterToday(c, req.body?.date, 'date');
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
accounting.get('/verify', ...json((c, req) => acct.verifyRollup(c, {
      from: req.query.from || null, to: req.query.to || null,
    })));

accounting.get('/gl', requireAuth(), async (req, res, next) => {
  try {
    // One query for every balance. This used to be a query per account.
    res.json(await withTenantRead(req.tenant.schema_name, (c) => acct.balances(c, {
      from: req.query.from || null, to: req.query.to || null,
    })));
  } catch (e) { next(e); }
});

// The outcome of a bulk process (the reference platform's GET /bulks/{processKey}).
const bulks = express.Router();
bulks.get('/:key', requireAuth(), async (req, res, next) => {
  try {
    const { rows: [b] } = await withTenantRead(req.tenant.schema_name, (c) => c.query('SELECT * FROM bulk_processes WHERE process_key = $1', [req.params.key]));
    if (!b) return notFound(res, 'bulk process');
    res.json({ bulkProcessKey: b.process_key, kind: b.kind, status: b.status, processedItems: b.items, errors: b.errors,
      createdBy: b.created_by, creationDate: b.created_at, finishedDate: b.finished_at });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.accounting = accounting;
module.exports.bulks = bulks;
module.exports.bulkDeposits = bulkDeposits;
