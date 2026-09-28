'use strict';

const express = require('express');
const { requireAuth, userState } = require('../tenancy/resolve');
const U = require('../tenancy/users');
const { withTenantRead } = require('../db/tenantContext');
const V = require('../domain/customViews');
const PERMS = require('../lib/permissions');

/**
 * Tenant user management (the reference platform's Users and Access Control), /api/users.
 * VIEW_USER_DETAILS lists and reads users, CREATE_USER and EDIT_USER change
 * them (lib/routePermissions); only an administrator resets someone else's
 * password. Custom field values on users are set through
 * /api/custom-fields/values/USER/:id.
 */

const router = express.Router();
const wrap = (fn, status = 200) => [requireAuth(), async (req, res, next) => {
  try { res.status(status).json(await fn(req)); } catch (e) { next(e); }
}];
const actor = (req) => ({ actor: req.auth.email, actorId: req.auth.sub, actorUser: req.auth });

router.get('/', ...wrap((req) => U.list(req.tenant, { status: req.query.status || null, role: req.query.role || null })));
router.get('/roles', ...wrap(() => U.ROLES));
router.get('/audit', ...wrap((req) => U.auditTrail(req.tenant, { limit: req.query.limit })));
router.post('/', ...wrap((req) => U.create(req.tenant, req.body || {}, actor(req)), 201));
router.get('/:id', ...wrap((req) => U.get(req.tenant, req.params.id)));
router.get('/:id/logins', ...wrap(async (req) => U.logins(req.tenant, { email: (await U.get(req.tenant, req.params.id)).email, limit: req.query.limit })));
router.post('/:id/unlock', ...wrap((req) => U.unlock(req.tenant, req.params.id, actor(req))));
// The custom views a user can see (the reference platform API v1: GET /users/{user}/views?for=).
// A user may ask for their own; an administrator for anyone's.
router.get('/:id/views', requireAuth(), async (req, res, next) => {
  try {
    const self = ['me', req.auth.sub, String(req.auth.email).toLowerCase()].includes(String(req.params.id).toLowerCase());
    if (!self && !PERMS.can(req.auth, 'VIEW_USER_DETAILS')) throw Object.assign(new Error('ONLY_YOUR_OWN_VIEWS'), { status: 403 });
    let target = req.auth;
    if (!self) {
      const u = await U.get(req.tenant, req.params.id);
      const st = await userState(u.id, req.tenant.schema_name, req.tenant.id);
      target = { sub: u.id, email: u.email, role: st.role, roleCode: st.roleCode, permissions: st.permissions, branchId: st.branchId };
    }
    res.json(await withTenantRead(req.tenant.schema_name, (c) => V.forUser(c, target, { for: req.query.for || null })));
  } catch (e) { next(e); }
});
router.patch('/:id', ...wrap((req) => U.update(req.tenant, req.params.id, req.body || {}, actor(req))));
router.post('/:id/reset-password', ...wrap((req) => U.resetPassword(req.tenant, req.params.id, actor(req))));
router.post('/:id/reset-mfa', ...wrap((req) => U.resetMfa(req.tenant, req.params.id, actor(req))));

module.exports = router;
