'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const X = require('../lib/export');
const V = require('../domain/customViews');
const PERMS = require('../lib/permissions');

/**
 * Custom views (the reference platform's Custom Views), mounted under /api/views, and the
 * ?viewfilter= parameter on the list endpoints (the reference platform's custom views with
 * API v1). Every signed-in user may make views for themselves; usage rights
 * are an administrator's to give (../domain/customViews).
 */

const router = express.Router();

const read = (fn) => [requireAuth(), async (req, res, next) => {
  try { res.json(await withTenantRead(req.tenant.schema_name, (c) => fn(c, req))); } catch (e) { next(e); }
}];
const write = (fn, status = 200) => [requireAuth(), async (req, res, next) => {
  try { res.status(status).json(await withTenant(req.tenant.schema_name, (c) => fn(c, req))); } catch (e) { next(e); }
}];
const page = (q) => ({ offset: q.offset, limit: q.limit });

router.get('/entities', requireAuth(), (req, res) => res.json(V.entities(req.auth)));
router.get('/fields/:entity', ...read((c, req) => V.describe(c, req.params.entity, req.auth)));
router.get('/', ...read((c, req) => V.list(c, req.auth, {
  entity: req.query.entity || null, favouritesOnly: ['true', '1'].includes(String(req.query.favourites || '')),
  menuItemId: req.query.menuItemId || null,
})));
router.post('/', ...write((c, req) => V.create(c, req.body, req.auth), 201));

async function sendExport(req, res, out, title) {
  const fmt = X.format(req.query.format || 'xlsx');
  if (!fmt) throw Object.assign(new Error('FORMAT_MUST_BE_CSV_OR_XLSX'), { status: 400 });
  if (!PERMS.can(req.auth, 'EXPORT_TO_EXCEL')) throw Object.assign(new Error('PERMISSION_REQUIRED: EXPORT_TO_EXCEL'), { status: 403 });
  const e = V.exportOf(out, title);
  e.header = [['Organization', req.tenant.name], ...e.header];
  if (out.truncated) res.set('x-export-truncated', 'true');
  X.send(res, fmt, e, `${req.tenant.slug}-${String(title).replace(/\s+/g, '-').toLowerCase()}`);
}

// A temporary view: run once, not kept. ?format= downloads it.
router.post('/run', requireAuth(), async (req, res, next) => {
  try {
    const whole = Boolean(req.query.format);
    const out = await withTenantRead(req.tenant.schema_name, (c) => V.execute(c, req.body || {}, req.auth, whole ? { all: true } : page(req.query)));
    if (whole) return sendExport(req, res, out, `${V.entityOf(out.definition.entity).label} view`);
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/:id', ...read((c, req) => V.get(c, req.params.id, req.auth)));
router.put('/:id', ...write((c, req) => V.update(c, req.params.id, req.body, req.auth)));
router.patch('/:id', ...write((c, req) => V.update(c, req.params.id, req.body, req.auth)));
router.delete('/:id', ...write((c, req) => V.remove(c, req.params.id, req.auth)));
router.post('/:id/copy', ...write((c, req) => V.copy(c, req.params.id, req.body, req.auth), 201));
router.put('/:id/favourite', ...write((c, req) => V.favourite(c, req.params.id, req.auth, true)));
router.delete('/:id/favourite', ...write((c, req) => V.favourite(c, req.params.id, req.auth, false)));
router.get('/:id/run', ...read((c, req) => V.run(c, req.params.id, req.auth, page(req.query))));
router.get('/:id/export', requireAuth(), async (req, res, next) => {
  try {
    const out = await withTenantRead(req.tenant.schema_name, (c) => V.run(c, req.params.id, req.auth, { all: true }));
    await sendExport(req, res, out, out.view.name);
  } catch (e) { next(e); }
});

/**
 * ?viewfilter={view id} on a list endpoint: the records the view matches,
 * paged (items-total, items-offset, items-limit headers), as the view's
 * columns (resultType=BASIC, the default), whole records (FULL_DETAILS), or
 * the count and column totals (SUMMARY). Without the parameter the request
 * goes on to the endpoint, unless `required` (an endpoint that only exists
 * for views).
 */
function viewfilter(entity, { required = false } = {}) {
  return [async (req, res, next) => {
    if (!req.query.viewfilter) {
      if (required) return next(Object.assign(new Error(`VIEWFILTER_REQUIRED: this endpoint lists ${entity} through a custom view`), { status: 400 }));
      return next('route');
    }
    return next();
  }, requireAuth(), async (req, res, next) => {
    try {
      const out = await withTenantRead(req.tenant.schema_name, (c) => V.forApi(c, String(req.query.viewfilter), entity, req.auth, {
        resultType: req.query.resultType || 'BASIC', offset: req.query.offset, limit: req.query.limit,
      }));
      if (out.kind === 'SUMMARY') return res.json(out.body);
      res.set('items-total', String(out.total));
      res.set('items-offset', String(out.offset));
      res.set('items-limit', String(out.limit));
      res.json(out.items);
    } catch (e) { next(e); }
  }];
}

module.exports = router;
module.exports.viewfilter = viewfilter;
