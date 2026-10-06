'use strict';

const express = require('express');
const { withTenant } = require('../db/tenantContext');
const { requirePermission, forgetUser } = require('../tenancy/resolve');
const ROLE = require('../domain/roles');
const { json } = require('../lib/handlers');
const read = (perm, fn) => json((c, req) => fn(c, req), { guard: requirePermission(perm) });

/**
 * Roles (the reference platform's Administration > Access > Roles), /api/roles, and the
 * permission catalog. Changing a role changes the access of everyone who
 * holds it at once.
 */

const router = express.Router();
const write = (perm, fn, status = 200) => [requirePermission(perm), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, (c) => fn(c, req));
    // Everyone's cached access is stale once a role changes. Sessions carry on: the role, base role
    // and permissions are read afresh on every request, so a moved base role takes effect at once.
    forgetUser();
    res.status(status).json(out?.role || out);
  } catch (e) { next(e); }
}];

router.get('/permissions', ...read('VIEW_ROLE', () => ROLE.catalog()));
router.get('/', ...read('VIEW_ROLE', (c) => ROLE.list(c)));
router.get('/:code', ...read('VIEW_ROLE', (c, req) => ROLE.get(c, req.params.code)));
router.post('/', ...write('CREATE_ROLE', (c, req) => ROLE.create(c, req.body, { createdBy: req.auth.email, actor: req.auth }), 201));
router.patch('/:code', ...write('EDIT_ROLE', (c, req) => ROLE.update(c, req.params.code, req.body, { createdBy: req.auth.email, actor: req.auth })));
router.put('/:code', ...write('EDIT_ROLE', (c, req) => ROLE.update(c, req.params.code, req.body, { createdBy: req.auth.email, actor: req.auth })));
router.delete('/:code', ...write('DELETE_ROLE', (c, req) => ROLE.remove(c, req.params.code, { createdBy: req.auth.email, actor: req.auth })));

module.exports = router;
