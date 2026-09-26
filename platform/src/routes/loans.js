'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { notFound } = require('../lib/http');
const { pageQuery, sendPage, pageParams } = require('../lib/page');
const L = require('../domain/loans');
const P = require('../domain/penalties');
const F = require('../domain/fees');
const W = require('../domain/workflow');
const R = require('../domain/restructure');
const TR = require('../domain/tranches');
const SEC = require('../domain/securities');
const FU = require('../domain/funding');
const RV = require('../domain/revolving');
const WO = require('../domain/writeOffs');
const RATES = require('../domain/rates');
const SE = require('../domain/scheduleEdits');
const PDP = require('../domain/postdated');
const PF = require('../domain/plannedFees');
const FA = require('../domain/feeAmortization');
const SL = require('../domain/settlementLinks');
const SETTLE = require('../domain/settlement');
const CTL = require('../domain/controls');

const router = express.Router();

/** Every handler runs inside one tenant transaction. */
// The handler returns its result and the wrapper sends it after COMMIT. A
// handler that wants 201 sets res.status(201) and returns; it never sends
// the body itself, or the client could hear "created" for a transaction
// that then fails to commit, or read before the row is visible.
const tx = (handler, roles = []) => [
  requireAuth(...roles),
  async (req, res, next) => {
    try {
      const out = await withTenant(req.tenant.schema_name, (c) =>
        handler(c, req, res, { actor: req.auth.email, user: req.auth }));
      if (out === undefined) return;
      if (out === null) return notFound(res, 'loan');
      res.json(out);
    } catch (e) { next(e); }
  },
];

const read = (handler) => [
  requireAuth(),
  async (req, res, next) => {
    try {
      const out = await withTenantRead(req.tenant.schema_name, (c) => handler(c, req));
      return out === null ? notFound(res, 'loan') : res.json(out);
    } catch (e) { next(e); }
  },
];

const APPROVER = ['TENANT_ADMIN', 'MANAGER'];
const TELLER = ['TENANT_ADMIN', 'MANAGER', 'TELLER'];

// --- tenant-wide lending controls ------------------------------------------

// The write-off register and the approver's queue. Declared before /:id so
// the words are not read as account numbers.
router.get('/write-offs', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => WO.register(c, req.query)));
  } catch (e) { next(e); }
});
router.get('/write-off-requests', requireAuth(), async (req, res, next) => {
  try {
    sendPage(res, await withTenantRead(req.tenant.schema_name, (c) => WO.pendingRequests(c, req.query)));
  } catch (e) { next(e); }
});

// Review every indexed or adjustable loan's rate (the end of day does this).
router.post('/rates/review', ...tx((c, req, _res, { actor }) =>
  RATES.reviewAll(c, { date: req.body?.asOf, createdBy: actor }), APPROVER));

router.get('/controls', requireAuth(), async (req, res, next) => {
  try { res.json(await withTenantRead(req.tenant.schema_name, (c) => W.controls(c))); } catch (e) { next(e); }
});
router.patch('/controls', ...tx((c, req, _res, { actor }) => W.updateControls(c, req.body, { actor }), ['TENANT_ADMIN']));
router.post('/controls/run', ...tx((c, req) => W.enforceControls(c, req.body), APPROVER));
// Each user's approval and disbursement limits.
router.get('/controls/users', requireAuth(...APPROVER), async (req, res, next) => {
  try { res.json(await withTenantRead(req.tenant.schema_name, (c) => CTL.staffLimits(c, req.tenant.id))); } catch (e) { next(e); }
});
router.patch('/controls/users/:userId', ...tx((c, req, _res, { actor }) =>
  CTL.setUserLimits(c, req.tenant.id, req.params.userId, req.body || {}, { actor }), ['TENANT_ADMIN']));

// --- list and read --------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT l.*, m.member_no, m.first_name, m.last_name
       FROM loan_accounts l JOIN members m ON m.id = l.member_id
       WHERE ($1::text IS NULL OR l.status = $1::text)
         AND ($2::uuid IS NULL OR l.member_id = $2::uuid)
       ORDER BY l.created_at DESC, l.id`,
      [req.query.status || null, req.query.memberId || null],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

router.get('/:id', ...read(async (c, req) => {
  const { rows } = await c.query(
    `SELECT l.*, m.member_no, m.first_name, m.last_name,
            r.account_no AS refinances_account_no, pl.account_no AS parent_account_no, lp.schedule_editing,
            lp.allow_postdated_payments, lp.interest_prepayment, lp.settlement_enabled, lp.settlement_option,
            (SELECT sa.account_no FROM savings_accounts sa WHERE sa.id = l.settlement_account_id) AS settlement_account_no,
            COALESCE(l.settings_snapshot->>'penalty_basis', lp.penalty_basis) AS penalty_basis,
            COALESCE(l.penalty_rate, lp.penalty_rate) AS penalty_rate,
            (SELECT count(*)::int FROM loan_postdated_payments pp WHERE pp.loan_id = l.id AND pp.status = 'PENDING') AS postdated_pending
     FROM loan_accounts l JOIN members m ON m.id = l.member_id
     JOIN loan_products lp ON lp.id = l.product_id
     LEFT JOIN loan_accounts r ON r.id = l.refinance_of
     LEFT JOIN loan_accounts pl ON pl.id = l.parent_loan_id
     WHERE l.id::text = $1 OR l.account_no = $1`, [req.params.id]);
  if (!rows.length) return null;
  // Days late and days in arrears (Mambu's two counters), on the loan's own settings.
  const indicators = await W.arrearsIndicators(c, await L.read(c, rows[0].id), req.query.asOf || null);
  return { ...rows[0], balances: L.balances(rows[0]), days_late: indicators.daysLate, days_in_arrears: indicators.daysInArrears };
}));

router.get('/:id/balances', ...read(async (c, req) => {
  const { rows } = await c.query(
    'SELECT * FROM loan_accounts WHERE id::text = $1 OR account_no = $1', [req.params.id]);
  return rows.length ? L.balances(rows[0]) : null;
}));

router.get('/:id/schedule', ...read(async (c, req) => {
  const { rows } = await c.query(
    `SELECT i.*, (SELECT COALESCE(sum(p.amount), 0) FROM loan_planned_fees p
                  WHERE p.loan_id = i.loan_id AND p.installment_number = i.number AND p.status = 'PLANNED') AS planned_fees
     FROM loan_installments i
     JOIN loan_accounts l ON l.id = i.loan_id
     WHERE l.id::text = $1 OR l.account_no = $1 ORDER BY i.number`, [req.params.id]);
  return rows;
}));

router.get('/:id/transactions', requireAuth(), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT t.* FROM transactions t
       JOIN loan_accounts l ON l.id = t.loan_account_id
       WHERE l.id::text = $1 OR l.account_no = $1
       ORDER BY t.created_at DESC, t.id`,
      [req.params.id],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

router.get('/:id/guarantors', ...read(async (c, req) => {
  const { rows } = await c.query(
    `SELECT g.*, m.member_no, m.first_name, m.last_name
     FROM loan_guarantors g
     JOIN members m ON m.id = g.member_id
     JOIN loan_accounts l ON l.id = g.loan_id
     WHERE l.id::text = $1 OR l.account_no = $1`, [req.params.id]);
  return rows;
}));

// --- application and eligibility -----------------------------------------

router.post('/eligibility', ...tx(async (c, req) =>
  L.checkEligibility(c, {
    memberId: req.body.memberId,
    productId: req.body.productId || 'NL01',
    principal: req.body.principal,
    loanId: req.body.loanId || null,
  }), TELLER));

// The picture approval will judge a specific application by, guarantors
// included. Read-only: nothing is decided here.
router.get('/:id/eligibility', ...read(async (c, req) => {
  const { rows: [l] } = await c.query(
    'SELECT * FROM loan_accounts WHERE id::text = $1 OR account_no = $1', [req.params.id]);
  if (!l) return null;
  return L.checkEligibility(c, {
    memberId: l.member_id, productId: l.product_id, principal: l.principal, loanId: l.id,
  });
}));

router.post('/', ...tx(async (c, req, res, { actor }) => {
  const loan = await L.apply(c, { ...req.body, createdBy: actor });
  res.status(201);
  return loan;
}, TELLER));

router.post('/:id/guarantors', ...tx(async (c, req, res) => {
  const g = await L.addGuarantor(c, req.params.id, req.body);
  res.status(201);
  return g;
}, TELLER));

// --- state ----------------------------------------------------------------
//
// One endpoint per action in the life cycle (workflow.ACTIONS), plus the
// names the first API used. Approving, undoing, rejecting and locking are
// management decisions; requesting approval, withdrawing and setting an
// application incomplete are a teller's.

const STATE_ROUTES = {
  'request-approval': 'REQUEST_APPROVAL', submit: 'REQUEST_APPROVAL', 'set-incomplete': 'SET_INCOMPLETE',
  approve: 'APPROVE', 'undo-approve': 'UNDO_APPROVE',
  reject: 'REJECT', 'undo-reject': 'UNDO_REJECT', withdraw: 'WITHDRAW', 'undo-withdraw': 'UNDO_WITHDRAW',
  lock: 'LOCK', unlock: 'UNLOCK', close: 'CLOSE',
};
const TELLER_ACTIONS = ['REQUEST_APPROVAL', 'SET_INCOMPLETE', 'WITHDRAW'];
for (const [path, action] of Object.entries(STATE_ROUTES)) {
  const roles = TELLER_ACTIONS.includes(action) ? TELLER : APPROVER;
  router.post(`/:id/${path}`, ...tx((c, req, _res, { actor, user }) =>
    W.transition(c, req.params.id, action, { createdBy: actor, user, note: req.body?.note, reason: req.body?.reason }), roles));
}

router.get('/:id/history', ...read((c, req) => W.historyOf(c, req.params.id)));

// Amendments: the terms while the application is open, the narrative
// afterwards. The domain layer decides which is which.
router.patch('/:id', ...tx((c, req, _res, { actor }) => W.amend(c, req.params.id, req.body, { actor }), TELLER));

// --- tranches, securities, funding, credit balance -------------------------

router.get('/:id/tranches', ...read((c, req) => TR.forLoan(c, req.params.id)));
router.put('/:id/tranches', ...tx((c, req, _res, { actor }) => TR.setTranches(c, req.params.id, req.body?.tranches || req.body, { createdBy: actor }), TELLER));

router.get('/:id/collateral', ...read((c, req) => SEC.forLoan(c, req.params.id)));
router.post('/:id/collateral', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await SEC.addCollateral(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));
router.post('/collateral/:collateralId/release', ...tx((c, req, _res, { actor }) =>
  SEC.releaseCollateral(c, req.params.collateralId, { ...req.body, createdBy: actor }), APPROVER));

router.get('/:id/funding', ...read(async (c, req) => {
  const { rows: [l] } = await c.query('SELECT id FROM loan_accounts WHERE id::text = $1 OR account_no = $1', [req.params.id]);
  return l ? FU.fundingOf(c, l.id) : null;
}));
router.post('/:id/funding', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await FU.addFundingSource(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));
router.delete('/funding/:fundingId', ...tx((c, req, _res, { actor }) => FU.removeFundingSource(c, req.params.fundingId, { createdBy: actor }), TELLER));

router.post('/:id/credit-balance-deposits', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await RV.depositToCreditBalance(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));
router.post('/revolving/bill', ...tx((c, req) => RV.billAll(c, req.body), APPROVER));

// --- fees -----------------------------------------------------------------

router.get('/:id/fees', ...read((c, req) => F.forLoan(c, req.params.id)));
router.post('/:id/fees', ...tx(async (c, req, res, { actor }) => {
  const body = { ...req.body, createdBy: actor };
  const out = body.fee ? await F.applyManualFee(c, req.params.id, body) : await F.applyArbitraryFee(c, req.params.id, body);
  res.status(201);
  return out;
}, TELLER));
router.post('/fees/:feeId/waive', ...tx((c, req, _res, { actor }) =>
  F.waive(c, req.params.feeId, { ...req.body, createdBy: actor }), APPROVER));

// --- money ----------------------------------------------------------------

router.post('/:id/disbursements', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  const { rows: [a] } = await c.query(
    'SELECT refinance_of FROM loan_accounts WHERE id::text = $1 OR account_no = $1', [req.params.id]);
  if (a?.refinance_of) return R.disburseRefinance(c, req.params.id, { ...req.body, createdBy: actor, user });
  return await L.disburse(c, req.params.id, { ...req.body, createdBy: actor, user });
}, APPROVER));

router.post('/:id/repayments', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  return await L.repay(c, req.params.id, { ...req.body, createdBy: actor, user });
}, TELLER));

router.post('/:id/accrue-interest', ...tx(async (c, req, res, { actor }) => {
  const out = await L.accrueInterest(c, req.params.id, { ...req.body, createdBy: actor });
  res.status(out ? 201 : 200).json(out || { accrued: 0 });
}, APPROVER));

// A reschedule closes the loan and opens a linked one at once: a management
// decision, and no new money leaves.
router.post('/:id/reschedule', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await R.restructure(c, req.params.id, { ...req.body, kind: 'RESCHEDULE', createdBy: actor });
}, APPROVER));

// A top-up (refinance) is an application like any other: recorded here,
// approved by someone with the authority, paid out by /disbursements on the
// application, which settles the running loan first.
router.post('/:id/refinance', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await R.requestRefinance(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));
router.get('/:id/refinance-quote', ...read((c, req) => R.quote(c, req.params.id)));

// A write-off is asked for by one person and approved by another (unless
// the tenant turns the approval off, in which case it happens at once).
router.post('/:id/write-off', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  return await WO.requestWriteOff(c, req.params.id, { ...req.body, createdBy: actor, user });
}, TELLER));
router.get('/:id/write-off', ...read((c, req) => WO.requestsFor(c, req.params.id)));
router.get('/:id/rates', ...read((c, req) => RATES.historyOf(c, req.params.id)));

// Schedule editing, payment holidays and the monthly due day, as far as the
// product allows (./scheduleEdits).
router.put('/:id/schedule', ...tx((c, req, _res, { actor }) => SE.editSchedule(c, req.params.id, { ...req.body, createdBy: actor }), APPROVER));
router.post('/:id/payment-holiday', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return SE.paymentHoliday(c, req.params.id, { ...req.body, createdBy: actor });
}, APPROVER));
router.post('/:id/due-day', ...tx((c, req, _res, { actor }) => SE.changeDueDay(c, req.params.id, { ...req.body, createdBy: actor }), APPROVER));
router.get('/:id/schedule-edits', ...read((c, req) => SE.editsOf(c, req.params.id)));
// The schedule an application will be drawn with: the product's, or one
// edited on the application (PUT /:id/schedule works before disbursement too).
router.get('/:id/application-schedule', ...read((c, req) => SE.applicationSchedule(c, req.params.id)));
router.get('/:id/schedule/editable', ...read((c, req) => SE.editable(c, req.params.id, req.query)));
router.delete('/:id/application-schedule', ...tx((c, req, _res, { actor }) => SE.clearApplicationSchedule(c, req.params.id, { createdBy: actor }), APPROVER));

// Postdated payments (fixed term): recorded now, applied by the end of day
// on their value date (./postdated).
router.get('/:id/postdated-payments', ...read((c, req) => PDP.forLoan(c, req.params.id)));
router.post('/:id/postdated-payments', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return req.body?.installments ? PDP.forInstallments(c, req.params.id, { ...req.body, createdBy: actor })
    : PDP.schedule(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));
router.post('/postdated-payments/:paymentId/cancel', ...tx((c, req, _res, { actor }) =>
  PDP.cancel(c, req.params.paymentId, { ...req.body, createdBy: actor }), TELLER));
// Penalty rate on a running loan (Mambu's Edit Penalty Rate), and its history.
router.post('/:id/penalty-rate', ...tx((c, req, _res, { actor }) => P.changeRate(c, req.params.id, { ...req.body, createdBy: actor }), APPROVER));
router.get('/:id/penalty-rate-changes', ...read((c, req) => P.rateChanges(c, req.params.id)));

// Planned fees: manual fees placed on installments ahead of time (./plannedFees).
router.get('/:id/planned-fees', ...read((c, req) => PF.forLoan(c, req.params.id)));
router.post('/:id/planned-fees', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return PF.add(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));
router.post('/:id/planned-fees/apply', ...tx((c, req, _res, { actor }) => PF.apply(c, req.params.id, { ...req.body, createdBy: actor }), TELLER));
router.patch('/planned-fees/:plannedId', ...tx((c, req, _res, { actor }) => PF.edit(c, req.params.plannedId, { ...req.body, createdBy: actor }), TELLER));
router.delete('/planned-fees/:plannedId', ...tx((c, req, _res, { actor }) => PF.remove(c, req.params.plannedId, { createdBy: actor }), TELLER));
router.post('/planned-fees/run', ...tx((c, req) => PF.applyDue(c, { ...req.body }), APPROVER));

// Fee amortisation plans and the recognition run.
router.get('/:id/fee-amortization', ...read((c, req) => FA.forLoan(c, req.params.id)));
router.post('/fee-amortization/run', ...tx((c, req) => FA.run(c, { ...req.body }), APPROVER));

router.post('/postdated-payments/run', ...tx((c, req) => PDP.applyDue(c, { ...req.body }), APPROVER));
router.post('/:id/rates/review', ...tx((c, req, _res, { actor }) =>
  RATES.reviewLoan(c, req.params.id, { date: req.body?.asOf, createdBy: actor }).then((x) => x || { changed: false }), APPROVER));
router.post('/:id/write-off/approve', ...tx(async (c, req, res, { actor, user }) => {
  res.status(201);
  return await WO.decide(c, req.params.id, { approve: true, note: req.body?.note, createdBy: actor, user });
}, APPROVER));
router.post('/:id/write-off/reject', ...tx((c, req, _res, { actor, user }) =>
  WO.decide(c, req.params.id, { approve: false, note: req.body?.note, createdBy: actor, user }), APPROVER));

// After a write-off: money recovered through a channel (a teller receipt),
// taken from a called guarantor's deposits, or a call forgone (management).
router.post('/:id/recoveries', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await L.recover(c, req.params.id, { ...req.body, createdBy: actor });
}, TELLER));
router.post('/:id/guarantors/:guarantorId/recover', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await L.recoverFromGuarantor(c, req.params.id, req.params.guarantorId, { ...req.body, createdBy: actor });
}, APPROVER));
router.post('/:id/guarantors/:guarantorId/release-call', ...tx((c, req, _res, { actor }) =>
  L.releaseCall(c, req.params.id, req.params.guarantorId, { ...req.body, createdBy: actor }), APPROVER));

// A loan's settlement account moves with it (./settlementLinks).
router.post('/:id/branch', ...tx((c, req, _res, { actor }) =>
  SL.moveLoan(c, req.params.id, { branchId: req.body?.branchId, createdBy: actor }), APPROVER));

// Settlement deposit accounts.
router.get('/:id/settlement-account', ...read((c, req) => SL.forLoan(c, req.params.id)));
router.put('/:id/settlement-account', ...tx((c, req, _res, { actor }) => SL.link(c, req.params.id, { ...req.body, createdBy: actor }), TELLER));
router.delete('/:id/settlement-account', ...tx((c, req, _res, { actor }) => SL.unlink(c, req.params.id, { ...req.body, createdBy: actor }), TELLER));
router.post('/settlement/run', ...tx((c, req) => SETTLE.run(c, { ...req.body }), APPROVER));

// Corrections are reversals. There is no PUT or DELETE on a transaction.
router.post('/transactions/:reference/reversal', ...tx(async (c, req, res, { actor }) => {
  res.status(201);
  return await L.reverseTransaction(c, req.params.reference, { ...req.body, createdBy: actor });
}, APPROVER));

router.get('/:id/penalties', requireAuth(), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) =>
      P.forLoan(c, req.params.id, pageParams(req.query)));
    sendPage(res, page);
  } catch (e) { next(e); }
});

router.post('/:id/penalties/accrue', ...tx((c, req, _res, { actor }) =>
  P.accrueForLoan(c, req.params.id, { ...req.body, createdBy: actor }), APPROVER));

// Waiving reverses the posting rather than deleting the charge, so both the
// penalty and the decision to waive it stay on the record.
router.post('/penalties/:chargeId/waive', ...tx((c, req, _res, { actor }) =>
  P.waive(c, req.params.chargeId, { ...req.body, createdBy: actor }), APPROVER));

router.post('/penalties/run', ...tx((c, req) => P.accrueAll(c, req.body), APPROVER));

router.post('/arrears/run', ...tx((c, req) => L.markArrears(c, req.body), APPROVER));
router.post('/fees/run', ...tx(async (c, req) => {
  const asOf = req.body?.asOf || new Date().toISOString().slice(0, 10);
  const { rows } = await c.query("SELECT id FROM loan_accounts WHERE status IN ('ACTIVE','IN_ARREARS')");
  let due = 0, late = 0;
  for (const r of rows) {
    const l = await L.lock(c, r.id);
    if (L.productType(l).paymentDueFeesByCalendar) due += await F.applyPaymentDueFees(c, l, asOf);
    late += await F.applyLateFees(c, l, asOf);
  }
  return { loans: rows.length, paymentDueApplied: due, lateFeesApplied: late };
}, APPROVER));

module.exports = router;
