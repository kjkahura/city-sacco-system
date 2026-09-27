'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const R = require('../domain/rates');

/**
 * Rate sources and their values (/api/index-rates), the reference platform's
 * Administration > Financial Setup > Rates: index interest rates, and
 * value-added and withholding tax rates (kind VAT or WITHHOLDING). A new
 * index value applies to indexed loans at their next review; a tax value
 * reaches its products on its date.
 */

const READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR', 'TELLER'];
const ADMIN = ['TENANT_ADMIN', 'MANAGER'];

const run = (fn, { write = false, status = 200 } = {}) => async (req, res, next) => {
  try {
    const out = await (write ? withTenant : withTenantRead)(req.tenant.schema_name, (c) => fn(c, req));
    res.status(status).json(out);
  } catch (e) { next(e); }
};

const router = express.Router();
router.get('/', requireAuth(...READER), run((c) => R.sources(c)));
router.post('/', requireAuth(...ADMIN), run((c, req) => R.addSource(c, { ...req.body, createdBy: req.auth.email }), { write: true, status: 201 }));
router.get('/:id/rates', requireAuth(...READER), run((c, req) => R.ratesOf(c, req.params.id)));
router.post('/:id/rates', requireAuth(...ADMIN), run((c, req) => R.setIndexRate(c, req.params.id, { ...req.body, createdBy: req.auth.email }), { write: true, status: 201 }));
router.patch('/:id', requireAuth(...ADMIN), run((c, req) => R.updateSource(c, req.params.id, req.body || {}, { createdBy: req.auth.email }), { write: true }));
router.delete('/:id', requireAuth(...ADMIN), run((c, req) => R.deleteSource(c, req.params.id, { createdBy: req.auth.email }), { write: true }));
router.patch('/:id/rates/:validFrom', requireAuth(...ADMIN), run((c, req) =>
  R.editIndexRate(c, req.params.id, req.params.validFrom, req.body || {}, { createdBy: req.auth.email }), { write: true }));
router.delete('/:id/rates/:validFrom', requireAuth(...ADMIN), run((c, req) =>
  R.deleteIndexRate(c, req.params.id, req.params.validFrom, { createdBy: req.auth.email }), { write: true }));
// The reference platform's TAX_RATE_UPDATE on demand (the end of day runs it every night).
router.post('/tax-update', requireAuth(...ADMIN), run((c, req) => R.updateTaxRates(c, { date: req.body?.date || undefined }), { write: true }));

module.exports = router;
