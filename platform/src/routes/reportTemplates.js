'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requirePermission } = require('../tenancy/resolve');
const PERMS = require('../lib/permissions');
const RT = require('../domain/reportTemplates');
const render = require('../lib/reportRender');

/**
 * Report templates (in place of the reference platform's Jasper reports), /api/report-templates.
 * VIEW_REPORTS lists and runs the templates a user's role may see;
 * CREATE_REPORTS, EDIT_REPORTS and DELETE_REPORTS manage them.
 *
 * POST /api/report-templates         { name, reportType, description, definition, usageRights }
 * GET  /api/report-templates?type=LOAN
 * GET  /api/report-templates/{id}/template   the file, to download
 * POST /api/report-templates/{id}/run?format=json|html|pdf|xlsx|csv   { parameters, recordId }
 */

const router = express.Router();
const read = (perm, fn) => [requirePermission(perm), async (req, res, next) => {
  try { res.json(await withTenantRead(req.tenant.schema_name, (c) => fn(c, req))); } catch (e) { next(e); }
}];
const write = (perm, fn, status = 200) => [requirePermission(perm), async (req, res, next) => {
  try { res.status(status).json(await withTenant(req.tenant.schema_name, (c) => fn(c, req))); } catch (e) { next(e); }
}];
const safe = (s) => String(s || 'report').replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase();

router.get('/', ...read('VIEW_REPORTS', (c, req) => RT.list(c, req.auth, { type: req.query.type || null })));
router.post('/', ...write('CREATE_REPORTS', (c, req) => RT.create(c, req.body, req.auth), 201));
router.put('/order', ...write('EDIT_REPORTS', (c, req) => RT.rearrange(c, req.body?.ids || req.body)));
router.get('/:id', ...read('VIEW_REPORTS', (c, req) => RT.get(c, req.params.id, req.auth)));
router.patch('/:id', ...write('EDIT_REPORTS', (c, req) => RT.update(c, req.params.id, req.body, req.auth)));
router.delete('/:id', ...write('DELETE_REPORTS', (c, req) => RT.remove(c, req.params.id, req.auth)));
router.get('/:id/template', requirePermission('VIEW_REPORTS'), async (req, res, next) => {
  try {
    const t = await withTenantRead(req.tenant.schema_name, (c) => RT.get(c, req.params.id, req.auth));
    res.set('content-type', 'application/json; charset=utf-8');
    res.set('content-disposition', `attachment; filename="${safe(t.fileName || t.name).replace(/\.json$/, '')}.json"`);
    res.send(JSON.stringify(t.definition, null, 2));
  } catch (e) { next(e); }
});

async function run(req, res, next) {
  try {
    const fmt = String(req.query.format || 'json').toLowerCase();
    if (fmt !== 'json' && !render.TYPES[fmt]) throw Object.assign(new Error('FORMAT_IS_ONE_OF: json, html, pdf, xlsx, csv'), { status: 400 });
    if (['xlsx', 'csv'].includes(fmt) && !PERMS.can(req.auth, 'EXPORT_TO_EXCEL')) throw Object.assign(new Error('PERMISSION_REQUIRED: EXPORT_TO_EXCEL'), { status: 403 });
    const b = req.method === 'GET' ? { parameters: { ...req.query }, recordId: req.query.recordId || null } : (req.body || {});
    if (req.method === 'GET') { delete b.parameters.format; delete b.parameters.recordId; }
    const out = await withTenantRead(req.tenant.schema_name, (c) => RT.run(c, req.params.id, {
      parameters: b.parameters || {}, recordId: b.recordId || null,
    }, req.auth, req.tenant));
    if (fmt === 'json') return res.json(out);
    const data = render.render(out, fmt);
    res.set('content-type', render.TYPES[fmt]);
    res.set('x-content-type-options', 'nosniff');
    res.set('cache-control', 'no-store');
    if (fmt !== 'html') res.set('content-disposition', `attachment; filename="${req.tenant.slug}-${safe(out.report.name)}.${fmt}"`);
    // A report page is the platform's own HTML; it runs no scripts.
    if (fmt === 'html') res.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return res.send(data);
  } catch (e) { return next(e); }
}
router.post('/:id/run', requirePermission('VIEW_REPORTS'), run);
router.get('/:id/run', requirePermission('VIEW_REPORTS'), run);

module.exports = router;
