'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requirePermission, forgetUser } = require('../tenancy/resolve');
const tokens = require('../auth/tokens');
const ROLE = require('../domain/roles');

/**
 * Roles (the reference platform's Administration > Access > Roles), /api/roles, and the
 * permission catalog. Changing a role changes the access of everyone who
 * holds it at once.
 */

const router = express.Router();
const read = (perm, fn) => [requirePermission(perm), async (req, res, next) => {
  try { res.json(await withTenantRead(req.tenant.schema_name, (c) => fn(c, req))); } catch (e) { next(e); }
}];
const write = (perm, fn, status = 200) => [requirePermission(perm), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, (c) => fn(c, req));
    // Everyone's cached access is stale once a role changes.
    forgetUser();
    for (const id of out?.baseMoved || []) await tokens.revokeAll(id);
    res.status(status).json(out?.role || out);
  } catch (e) { next(e); }
}];

router.get('/permissions', ...read('VIEW_ROLE', () => ROLE.catalog()));
router.get('/', ...read('VIEW_ROLE', (c) => ROLE.list(c)));
router.get('/:code', ...read('VIEW_ROLE', (c, req) => ROLE.get(c, req.params.code)));
router.post('/', ...write('CREATE_ROLE', (c, req) => ROLE.create(c, req.body, { createdBy: req.auth.email }), 201));
router.patch('/:code', ...write('EDIT_ROLE', (c, req) => ROLE.update(c, req.params.code, req.body, { createdBy: req.auth.email })));
router.put('/:code', ...write('EDIT_ROLE', (c, req) => ROLE.update(c, req.params.code, req.body, { createdBy: req.auth.email })));
router.delete('/:code', ...write('DELETE_ROLE', (c, req) => ROLE.remove(c, req.params.code, { createdBy: req.auth.email })));

module.exports = router;
