'use strict';

const { orgToday } = require('../lib/orgDate');
const express = require('express');
const B = require('../domain/branches');
const accruals = require('../domain/accruals');
const { json } = require('../lib/handlers');
const run = (fn, { write = false, status = 200 } = {}) => json(fn, { write, status });

/**
 * Branches (/api/branches) and the accounting administration that goes
 * with them (/api/accounting): inter-branch rules, closures, the tenant's
 * accounting settings, and the breakdown behind an aggregated accrual.
 */


const branches = express.Router();
branches.get('/', ...run((c) => B.list(c)));
branches.get('/:id', ...run((c, req) => B.detail(c, req.params.id)));
branches.post('/', ...run((c, req) => B.create(c, { ...req.body, createdBy: req.auth.email, user: req.auth }), { write: true, status: 201 }));
branches.patch('/:id', ...run((c, req) => B.update(c, req.params.id, { ...req.body, createdBy: req.auth.email, user: req.auth }), { write: true }));

const accounting = express.Router();
accounting.get('/inter-branch-rules', ...run((c) => B.rules(c)));
accounting.put('/inter-branch-rules', ...run((c, req) => B.setRules(c, req.body?.rules || req.body, { createdBy: req.auth.email }), { write: true }));
accounting.get('/closures', ...run((c, req) => B.closures(c, { includeDeleted: req.query.includeDeleted === 'true' })));
accounting.post('/closures', ...run((c, req) => B.close(c, { ...req.body, createdBy: req.auth.email }), { write: true, status: 201 }));
accounting.patch('/closures/:id', ...run((c, req) => B.updateClosure(c, req.params.id, { ...req.body, createdBy: req.auth.email }), { write: true }));
accounting.delete('/closures/:id', ...run((c, req) => B.reopen(c, req.params.id, { reason: req.body?.reason, createdBy: req.auth.email }), { write: true }));
accounting.get('/settings', ...run((c) => B.settings(c)));
accounting.put('/settings', ...run((c, req) => B.updateSettings(c, { ...req.body, createdBy: req.auth.email }), { write: true }));
accounting.get('/accruals/:entryId', ...run((c, req) => accruals.breakdown(c, req.params.entryId)));
accounting.post('/accruals/post', ...run(async (c, req) => accruals.flush(c, {
  date: req.body?.date || await orgToday(c), createdBy: req.auth.email,
}), { write: true }));

module.exports = { branches, accounting };
