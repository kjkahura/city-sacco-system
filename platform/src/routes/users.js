'use strict';

const express = require('express');
const { requireAuth } = require('../tenancy/resolve');
const U = require('../tenancy/users');
const { withTenantRead } = require('../db/tenantContext');
const V = require('../domain/customViews');

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
// The custom views a user can see (the reference platform API v1: GET /users/{user}/views?for=).
// A user may ask for their own; an administrator for anyone's.
router.get('/:id/views', requireAuth(), async (req, res, next) => {
  try {
    const self = ['me', req.auth.sub, String(req.auth.email).toLowerCase()].includes(String(req.params.id).toLowerCase());
    if (!self && req.auth.role !== 'TENANT_ADMIN') throw Object.assign(new Error('ONLY_YOUR_OWN_VIEWS'), { status: 403 });
    const target = self ? req.auth : await U.get(req.tenant, req.params.id).then((u) => ({ sub: u.id, email: u.email, role: u.role }));
    res.json(await withTenantRead(req.tenant.schema_name, (c) => V.forUser(c, target, { for: req.query.for || null })));
  } catch (e) { next(e); }
});
router.patch('/:id', ...wrap(OWNER, (req) => U.update(req.tenant, req.params.id, req.body || {}, actor(req))));
router.post('/:id/reset-password', ...wrap(OWNER, (req) => U.resetPassword(req.tenant, req.params.id, actor(req))));
router.post('/:id/reset-mfa', ...wrap(OWNER, (req) => U.resetMfa(req.tenant, req.params.id, actor(req))));

module.exports = router;
