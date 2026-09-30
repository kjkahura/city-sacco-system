'use strict';

const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const M = require('../domain/menus');
const { json } = require('../lib/handlers');
const read = (fn) => json((c, req) => fn(c, req));
const write = (fn, status = 200) => json((c, req) => fn(c, req), { write: true, status });

/**
 * The navigation and its menu items (the reference platform's Menu Items): GET /api/menu is
 * the signed-in user's navigation; /api/menu-items manages the items with
 * views. Anyone makes items for themselves; administrators share them.
 */

const menu = express.Router();
menu.get('/', requireAuth(), async (req, res, next) => {
  try { res.json(await withTenantRead(req.tenant.schema_name, (c) => M.navigation(c, req.auth))); } catch (e) { next(e); }
});

const items = express.Router();
items.get('/', ...read((c, req) => M.list(c, req.auth)));
items.post('/', ...write((c, req) => M.create(c, req.body, req.auth), 201));
items.put('/order', ...write((c, req) => M.rearrange(c, req.body?.ids || req.body, req.auth)));
items.patch('/:id', ...write((c, req) => M.update(c, req.params.id, req.body, req.auth)));
items.delete('/:id', ...write((c, req) => M.remove(c, req.params.id, req.auth)));

module.exports = { menu, items };
