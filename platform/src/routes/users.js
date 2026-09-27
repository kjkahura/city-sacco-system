'use strict';

const express = require('express');
const { requireAuth } = require('../tenancy/resolve');
const U = require('../tenancy/users');

/**
 * Tenant user management (the reference platform's Users and Access Control), /api/users.
 * Tenant administrators manage staff; managers and auditors may look.
 * Custom field values on users are set through /api/custom-fields/values/USER/:id.
 */

const OWNER = ['TENANT_ADMIN'];
const READERS = ['TENANT_ADMIN', 'MANAGER', 'AUDITOR'];
const router = express.Router();
const wrap = (roles, fn, status = 200) => [requireAuth(...roles), async (req, res, next) => {
  try { res.status(status).json(await fn(req)); } catch (e) { next(e); }
}];
const actor = (req) => ({ actor: req.auth.email, actorId: req.auth.sub });

router.get('/', ...wrap(READERS, (req) => U.list(req.tenant, { status: req.query.status || null, role: req.query.role || null })));
router.get('/roles', ...wrap(READERS, () => U.ROLES));
router.get('/audit', ...wrap(OWNER, (req) => U.auditTrail(req.tenant, { limit: req.query.limit })));
router.post('/', ...wrap(OWNER, (req) => U.create(req.tenant, req.body || {}, actor(req)), 201));
router.get('/:id', ...wrap(READERS, (req) => U.get(req.tenant, req.params.id)));
router.patch('/:id', ...wrap(OWNER, (req) => U.update(req.tenant, req.params.id, req.body || {}, actor(req))));
router.post('/:id/reset-password', ...wrap(OWNER, (req) => U.resetPassword(req.tenant, req.params.id, actor(req))));
router.post('/:id/reset-mfa', ...wrap(OWNER, (req) => U.resetMfa(req.tenant, req.params.id, actor(req))));

module.exports = router;
