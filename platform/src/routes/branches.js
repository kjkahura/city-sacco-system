'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const B = require('../domain/branches');
const accruals = require('../domain/accruals');

/**
 * Branches (/api/branches) and the accounting administration that goes
 * with them (/api/accounting): inter-branch rules, closures, the tenant's
 * accounting settings, and the breakdown behind an aggregated accrual.
 */

const READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR', 'TELLER'];
const LEDGER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'];
const ADMIN = ['TENANT_ADMIN', 'MANAGER'];
const CLOSER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT'];

const run = (fn, { write = false, status = 200 } = {}) => async (req, res, next) => {
  try {
    const out = await (write ? withTenant : withTenantRead)(req.tenant.schema_name, (c) => fn(c, req));
    res.status(status).json(out);
  } catch (e) { next(e); }
};

const branches = express.Router();
branches.get('/', requireAuth(...READER), run((c) => B.list(c)));
branches.post('/', requireAuth(...ADMIN), run((c, req) => B.create(c, { ...req.body, createdBy: req.auth.email }), { write: true, status: 201 }));
branches.patch('/:id', requireAuth(...ADMIN), run((c, req) => B.update(c, req.params.id, { ...req.body, createdBy: req.auth.email }), { write: true }));

const accounting = express.Router();
accounting.get('/inter-branch-rules', requireAuth(...LEDGER), run((c) => B.rules(c)));
accounting.put('/inter-branch-rules', requireAuth(...ADMIN), run((c, req) => B.setRules(c, req.body?.rules || req.body, { createdBy: req.auth.email }), { write: true }));
accounting.get('/closures', requireAuth(...LEDGER), run((c, req) => B.closures(c, { includeDeleted: req.query.includeDeleted === 'true' })));
accounting.post('/closures', requireAuth(...CLOSER), run((c, req) => B.close(c, { ...req.body, createdBy: req.auth.email }), { write: true, status: 201 }));
accounting.delete('/closures/:id', requireAuth(...ADMIN), run((c, req) => B.reopen(c, req.params.id, { reason: req.body?.reason, createdBy: req.auth.email }), { write: true }));
accounting.get('/settings', requireAuth(...LEDGER), run((c) => B.settings(c)));
accounting.put('/settings', requireAuth(...ADMIN), run((c, req) => B.updateSettings(c, { ...req.body, createdBy: req.auth.email }), { write: true }));
accounting.get('/accruals/:entryId', requireAuth(...LEDGER), run((c, req) => accruals.breakdown(c, req.params.entryId)));
accounting.post('/accruals/post', requireAuth(...ADMIN), run((c, req) => accruals.flush(c, {
  date: req.body?.date || new Date().toISOString().slice(0, 10), createdBy: req.auth.email,
}), { write: true }));

module.exports = { branches, accounting };
