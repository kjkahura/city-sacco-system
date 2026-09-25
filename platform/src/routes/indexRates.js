'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const R = require('../domain/rates');

/**
 * Index rate sources and their values (/api/index-rates), Mambu's
 * Administration > Financial Setup > Rates. A new value applies to indexed
 * loans at their next review.
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

module.exports = router;
