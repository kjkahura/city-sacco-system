'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { badRequest } = require('../lib/http');
const PV = require('../domain/provisioning');
const CL = require('../domain/close');
const RT = require('../domain/returns');

/**
 * Provisioning, the year-end close, and regulatory returns.
 *
 * Everything that changes a number here is an accountant's or a manager's
 * decision, never a teller's, so the roles are tighter than the rest of the
 * API. Reading is open to auditors.
 */

const READER = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'];
const ACCOUNTANT = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT'];
const APPROVER = ['TENANT_ADMIN', 'MANAGER'];

const read = (fn, roles = READER) => [
  requireAuth(...roles),
  async (req, res, next) => {
    try { res.json(await withTenantRead(req.tenant.schema_name, (c) => fn(c, req))); }
    catch (e) { next(e); }
  },
];

const write = (fn, roles) => [
  requireAuth(...roles),
  async (req, res, next) => {
    try {
      res.json(await withTenant(req.tenant.schema_name, (c) =>
        fn(c, req, { actor: req.auth.email })));
    } catch (e) { next(e); }
  },
];

// --- provisioning ---------------------------------------------------------

const provisioning = express.Router();

provisioning.get('/bands', ...read((c) => PV.bands(c)));

provisioning.patch('/bands/:code', ...write((c, req, { actor }) =>
  PV.setBand(c, req.params.code, { ...req.body, createdBy: actor }), APPROVER));

// What the allowance should be, without posting anything.
provisioning.get('/preview', ...read((c, req) => PV.compute(c, { asAt: req.query.asAt || null })));

provisioning.post('/run', ...write((c, req, { actor }) =>
  PV.run(c, { asAt: req.body?.asAt || null, createdBy: actor }), ACCOUNTANT));

provisioning.post('/runs/:id/reverse', ...write((c, req, { actor }) =>
  PV.reverseRun(c, req.params.id, { reason: req.body?.reason || '', createdBy: actor }), APPROVER));

provisioning.get('/runs', ...read((c, req) => PV.history(c, { limit: req.query.limit })));

// --- financial years and the close ---------------------------------------

const periods = express.Router();

periods.get('/', ...read((c) => CL.years(c)));
periods.get('/settings', ...read((c) => CL.settings(c)));

periods.patch('/settings', ...write((c, req, { actor }) =>
  CL.setSettings(c, { ...req.body, createdBy: actor }), APPROVER));

periods.post('/', ...write((c, req, { actor }) =>
  CL.openYear(c, { ...req.body, createdBy: actor }), APPROVER));

periods.get('/:year/close-preview', ...read((c, req) => CL.preview(c, req.params.year)));

periods.post('/:year/close', ...write((c, req, { actor }) =>
  CL.close(c, req.params.year, { createdBy: actor }), APPROVER));

periods.post('/:year/reopen', ...write((c, req, { actor }) =>
  CL.reopen(c, req.params.year, { reason: req.body?.reason || '', createdBy: actor }), APPROVER));

// --- regulatory returns ---------------------------------------------------

const returns = express.Router();

returns.get('/', ...read((c) => RT.listTemplates(c)));
returns.get('/:code/definition', ...read((c, req) => RT.template(c, req.params.code)));

returns.get('/:code', ...read((c, req) => RT.render(c, req.params.code, {
  from: req.query.from || null, to: req.query.to || null, asAt: req.query.asAt || null,
})));

// Loading a template is loading the shape of a filing, so it is an admin
// action and it is audited.
returns.put('/:code', requireAuth('TENANT_ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const def = { ...(req.body || {}), code: req.params.code };
    if (!def.name) return badRequest(res, 'RETURN_TEMPLATE_NAME_REQUIRED');
    res.json(await withTenant(req.tenant.schema_name, (c) =>
      RT.loadTemplate(c, def, { createdBy: req.auth.email })));
  } catch (e) { next(e); }
});

module.exports = { provisioning, periods, returns };
