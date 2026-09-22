'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { notFound } = require('../lib/http');
const { pageQuery, sendPage, pageParams } = require('../lib/page');
const L = require('../domain/loans');
const P = require('../domain/penalties');

const router = express.Router();

/** Every handler runs inside one tenant transaction. */
const tx = (handler, roles = []) => [
  requireAuth(...roles),
  async (req, res, next) => {
    try {
      const out = await withTenant(req.tenant.schema_name, (c) =>
        handler(c, req, res, { actor: req.auth.email }));
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
    `SELECT l.*, m.member_no, m.first_name, m.last_name
     FROM loan_accounts l JOIN members m ON m.id = l.member_id
     WHERE l.id::text = $1 OR l.account_no = $1`, [req.params.id]);
  if (!rows.length) return null;
  return { ...rows[0], balances: L.balances(rows[0]) };
}));

router.get('/:id/balances', ...read(async (c, req) => {
  const { rows } = await c.query(
    'SELECT * FROM loan_accounts WHERE id::text = $1 OR account_no = $1', [req.params.id]);
  return rows.length ? L.balances(rows[0]) : null;
}));

router.get('/:id/schedule', ...read(async (c, req) => {
  const { rows } = await c.query(
    `SELECT i.* FROM loan_installments i
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
  }), TELLER));

router.post('/', ...tx(async (c, req, res, { actor }) => {
  const loan = await L.apply(c, { ...req.body, createdBy: actor });
  res.status(201).json(loan);
}, TELLER));

router.post('/:id/guarantors', ...tx(async (c, req, res) => {
  const g = await L.addGuarantor(c, req.params.id, req.body);
  res.status(201).json(g);
}, TELLER));

// --- state ----------------------------------------------------------------

for (const [path, action] of Object.entries({
  submit: 'SUBMIT', approve: 'APPROVE', 'undo-approve': 'UNAPPROVE',
  reject: 'REJECT', withdraw: 'WITHDRAW',
})) {
  const roles = ['approve', 'undo-approve', 'reject'].includes(path) ? APPROVER : TELLER;
  router.post(`/:id/${path}`, ...tx((c, req, _res, { actor }) =>
    L.changeState(c, req.params.id, action, { createdBy: actor }), roles));
}

// --- money ----------------------------------------------------------------

router.post('/:id/disbursements', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await L.disburse(c, req.params.id, { ...req.body, createdBy: actor }));
}, APPROVER));

router.post('/:id/repayments', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await L.repay(c, req.params.id, { ...req.body, createdBy: actor }));
}, TELLER));

router.post('/:id/accrue-interest', ...tx(async (c, req, res, { actor }) => {
  const out = await L.accrueInterest(c, req.params.id, { ...req.body, createdBy: actor });
  res.status(out ? 201 : 200).json(out || { accrued: 0 });
}, APPROVER));

router.post('/:id/write-off', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await L.writeOff(c, req.params.id, { ...req.body, createdBy: actor }));
}, APPROVER));

// Corrections are reversals. There is no PUT or DELETE on a transaction.
router.post('/transactions/:reference/reversal', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await L.reverseTransaction(c, req.params.reference, { ...req.body, createdBy: actor }));
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

module.exports = router;
