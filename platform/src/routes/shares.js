'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { notFound, paginate, withPaginationHeaders } = require('../lib/http');
const SH = require('../domain/shares');

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
      if (out === null) return notFound(res, 'share account');
      res.json(out);
    } catch (e) { next(e); }
  },
];

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT a.*, m.member_no, m.first_name, m.last_name
       FROM share_accounts a JOIN members m ON m.id = a.member_id
       ORDER BY a.account_no`)).rows);
    const p = paginate(req, rows);
    withPaginationHeaders(res, p).json(p.page);
  } catch (e) { next(e); }
});

router.get('/register', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) =>
      SH.register(c, { asAt: req.query.asAt || null })));
  } catch (e) { next(e); }
});

router.post('/', ...tx(async (c, req, res) => {
  res.status(201).json(await SH.open(c, req.body));
}, TELLER));

router.post('/:id/purchases', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await SH.purchase(c, req.params.id, { ...req.body, createdBy: actor }));
}, TELLER));

router.post('/:id/transfers', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await SH.transfer(c, req.params.id, { ...req.body, createdBy: actor }));
}, APPROVER));

router.get('/:id/movements', requireAuth(), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT mv.* FROM share_movements mv
       JOIN share_accounts a ON a.id = mv.account_id
       WHERE a.id = $1 OR a.account_no = $1::text
       ORDER BY mv.value_date DESC, mv.created_at DESC`, [req.params.id])).rows);
    res.json(rows);
  } catch (e) { next(e); }
});

// --- dividends ------------------------------------------------------------

const dividends = express.Router();

dividends.get('/', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, async (c) =>
      (await c.query('SELECT * FROM dividends ORDER BY financial_year DESC')).rows));
  } catch (e) { next(e); }
});

dividends.get('/:year/allocations', requireAuth(), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => (await c.query(
      `SELECT a.*, m.member_no, m.first_name, m.last_name
       FROM dividend_allocations a
       JOIN dividends d ON d.id = a.dividend_id
       JOIN members m ON m.id = a.member_id
       WHERE d.financial_year = $1 ORDER BY a.amount DESC`, [req.params.year])).rows);
    const p = paginate(req, rows);
    withPaginationHeaders(res, p).json(p.page);
  } catch (e) { next(e); }
});

// Declaring, allocating and paying a dividend are three deliberate steps,
// each approved separately, because that is how an AGM decision actually
// moves through a SACCO.
dividends.post('/', ...tx(async (c, req, res, { actor }) => {
  res.status(201).json(await SH.declare(c, { ...req.body, createdBy: actor }));
}, APPROVER));

dividends.post('/:year/allocate', ...tx((c, req, _res, { actor }) =>
  SH.allocate(c, Number(req.params.year), { createdBy: actor }), APPROVER));

dividends.post('/:year/pay', ...tx((c, req, _res, { actor }) =>
  SH.pay(c, Number(req.params.year), { createdBy: actor }), APPROVER));

module.exports = router;
module.exports.dividends = dividends;
