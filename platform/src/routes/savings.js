'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { notFound, paginate, withPaginationHeaders } = require('../lib/http');
const S = require('../domain/savings');
const acct = require('../domain/accounting');

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
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT a.*, m.member_no, m.first_name, m.last_name
       FROM savings_accounts a JOIN members m ON m.id = a.member_id
       ${req.query.memberId ? 'WHERE a.member_id = $1' : ''}
       ORDER BY a.account_no`,
      req.query.memberId ? [req.query.memberId] : []
    )).rows);
    const p = paginate(req, rows);
    withPaginationHeaders(res, p).json(p.page);
  } catch (e) { next(e); }
});

router.post('/', ...tx(async (c, req, res) => {
  res.status(201).json(await S.open(c, req.body));
}, TELLER));

router.get('/:id/balance', ...tx((c, req) => S.summary(c, req.params.id)));

router.get('/:id/transactions', requireAuth(), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT t.* FROM transactions t
       JOIN savings_accounts a ON a.id = t.savings_account_id
       WHERE a.id = $1 OR a.account_no = $1::text
       ORDER BY t.created_at DESC`, [req.params.id])).rows);
    const p = paginate(req, rows);
    withPaginationHeaders(res, p).json(p.page);
  } catch (e) { next(e); }
});

router.post('/:id/deposits', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await S.deposit(c, req.params.id, { ...req.body, createdBy: actor }));
}, TELLER));

router.post('/:id/withdrawals', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await S.withdraw(c, req.params.id, { ...req.body, createdBy: actor }));
}, TELLER));

router.post('/:id/transfers', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await S.transfer(c, req.params.id, { ...req.body, createdBy: actor }));
}, TELLER));

router.post('/transactions/:reference/reversal', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await S.reverseTransaction(c, req.params.reference, { ...req.body, createdBy: actor }));
}, APPROVER));

// --- accounting -----------------------------------------------------------

const accounting = express.Router();

accounting.get('/trial-balance', requireAuth('TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'),
  async (req, res, next) => {
    try {
      res.json(await withTenantRead(req.tenant.schema_name, (c) => acct.trialBalance(c, req.query)));
    } catch (e) { next(e); }
  });

accounting.get('/journal', requireAuth('TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'),
  async (req, res, next) => {
    try {
      const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
        `SELECT e.id AS entry_id, e.booking_date, e.narration, e.source_type, e.channel_id,
                e.reversal_of, l.gl_code, g.name AS gl_name, l.direction, l.amount, l.line_no
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
         JOIN gl_accounts g ON g.code = l.gl_code
         WHERE ($1::date IS NULL OR e.booking_date >= $1::date)
           AND ($2::date IS NULL OR e.booking_date <= $2::date)
         ORDER BY e.booking_date DESC, e.id, l.line_no`,
        [req.query.from || null, req.query.to || null])).rows);
      const p = paginate(req, rows);
      withPaginationHeaders(res, p).json(p.page);
    } catch (e) { next(e); }
  });

accounting.get('/gl', requireAuth('TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'),
  async (req, res, next) => {
    try {
      res.json(await withTenantRead(req.tenant.schema_name, async (c) => {
        const { rows } = await c.query('SELECT * FROM gl_accounts ORDER BY code');
        return Promise.all(rows.map(async (a) => ({ ...a, balance: await acct.balance(c, a.code) })));
      }));
    } catch (e) { next(e); }
  });

module.exports = router;
module.exports.accounting = accounting;
