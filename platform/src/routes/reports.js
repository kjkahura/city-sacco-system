'use strict';

const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { pageParams, pageQuery, sendPage } = require('../lib/page');
const R = require('../domain/reports');

const router = express.Router();
const READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'];

const report = (fn) => [
  requireAuth(...READER),
  async (req, res, next) => {
    try { res.json(await withTenantRead(req.tenant.schema_name, (c) => fn(c, req.query, req))); }
    catch (e) { next(e); }
  },
];

// A statement returns every line by default, because that is what a
// statement is. Paging engages only when the caller asks for it, and the
// totals stay whole either way.
const lines = (q) => (q.limit === undefined ? { offset: 0, limit: null } : pageParams(q));

router.get('/balance-sheet', ...report((c, q) =>
  R.balanceSheet(c, { asAt: q.asAt || null, ...lines(q) })));

router.get('/income-statement', ...report((c, q) =>
  R.incomeStatement(c, { from: q.from || null, to: q.to || null, ...lines(q) })));

router.get('/prudential', ...report((c, q) => R.prudentialRatios(c, { asAt: q.asAt || null })));

router.get('/portfolio-at-risk', ...report((c, q) => R.portfolioAtRisk(c, { asAt: q.asAt || null })));

// The loan-by-loan version behind the buckets. Unbounded, so always paged.
router.get('/portfolio-at-risk/loans', ...report((c, q) =>
  R.portfolioAtRiskLoans(c, {
    asAt: q.asAt || null,
    bucket: q.bucket || null,
    ...pageParams(q),
  })));

router.get('/limits', requireAuth(...READER), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, async (c) =>
      (await c.query('SELECT * FROM prudential_limits ORDER BY code')).rows));
  } catch (e) { next(e); }
});

router.get('/audit-log', requireAuth(...READER), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT id, actor, action, entity, entity_id, created_at
       FROM audit_log
       WHERE ($1::text IS NULL OR action = $1::text)
         AND ($2::text IS NULL OR entity = $2::text)
       ORDER BY created_at DESC, id DESC`,
      [req.query.action || null, req.query.entity || null],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

module.exports = router;
