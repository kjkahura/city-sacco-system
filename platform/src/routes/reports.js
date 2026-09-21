'use strict';

const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const R = require('../domain/reports');

const router = express.Router();
const READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'];

const report = (fn) => [
  requireAuth(...READER),
  async (req, res, next) => {
    try { res.json(await withTenantRead(req.tenant.schema_name, (c) => fn(c, req.query))); }
    catch (e) { next(e); }
  },
];

router.get('/balance-sheet', ...report((c, q) => R.balanceSheet(c, { asAt: q.asAt || null })));
router.get('/income-statement', ...report((c, q) =>
  R.incomeStatement(c, { from: q.from || null, to: q.to || null })));
router.get('/prudential', ...report((c, q) => R.prudentialRatios(c, { asAt: q.asAt || null })));
router.get('/portfolio-at-risk', ...report((c, q) => R.portfolioAtRisk(c, { asAt: q.asAt || null })));

router.get('/limits', requireAuth(...READER), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, async (c) =>
      (await c.query('SELECT * FROM prudential_limits ORDER BY code')).rows));
  } catch (e) { next(e); }
});

module.exports = router;
