'use strict';

const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { requirePermission } = require('../tenancy/resolve');
const T = require('../domain/tasks');
const { json } = require('../lib/handlers');
const { pageHeaders } = require('../lib/page');
const read = (perm, fn) => json((c, req) => fn(c, req), { guard: requirePermission(perm) });
const write = (perms, fn, status = 200) => json((c, req) => fn(c, req), { write: true, status, guard: requirePermission(...[].concat(perms)) });

/**
 * Tasks (the reference platform's Tasks), /api/tasks, and task templates,
 * /api/tasks/templates. VIEW_TASK, CREATE_TASK, EDIT_TASK, DELETE_TASK;
 * templates need CREATE_ or EDIT_COMMUNICATION_TEMPLATES.
 */

const router = express.Router();
router.get('/templates', ...read('VIEW_TASK', (c) => T.templates(c)));
router.get('/templates/placeholders', ...read('VIEW_TASK', () => T.PLACEHOLDERS));
router.post('/templates', ...write('CREATE_COMMUNICATION_TEMPLATES', (c, req) => T.saveTemplate(c, null, req.body, req.auth), 201));
router.patch('/templates/:id', ...write('EDIT_COMMUNICATION_TEMPLATES', (c, req) => T.saveTemplate(c, req.params.id, req.body, req.auth)));
router.delete('/templates/:id', ...write('EDIT_COMMUNICATION_TEMPLATES', (c, req) => T.removeTemplate(c, req.params.id)));

// The Your Tasks widget.
router.get('/mine', ...read('VIEW_TASK', (c, req) => T.mine(c, req.auth)));
router.get('/', requirePermission('VIEW_TASK'), async (req, res, next) => {
  try {
    const p = await withTenantRead(req.tenant.schema_name, (c) => T.list(c, req.auth, {
      assignedTo: req.query.assignedTo || null, status: req.query.status || null, due: req.query.due || null,
      memberId: req.query.memberId || null, offset: req.query.offset, limit: req.query.limit,
    }));
    pageHeaders(res, p);
    res.json(p.items);
  } catch (e) { next(e); }
});
router.post('/', ...write('CREATE_TASK', (c, req) => T.create(c, req.body, req.auth), 201));
router.get('/:id', ...read('VIEW_TASK', (c, req) => T.get(c, req.params.id, req.auth)));
router.patch('/:id', ...write('EDIT_TASK', (c, req) => T.update(c, req.params.id, req.body, req.auth)));
router.put('/:id', ...write('EDIT_TASK', (c, req) => T.update(c, req.params.id, req.body, req.auth)));
router.post('/:id/complete', ...write('EDIT_TASK', (c, req) => T.complete(c, req.params.id, req.auth)));
router.post('/:id/reopen', ...write('EDIT_TASK', (c, req) => T.reopen(c, req.params.id, req.auth)));
router.delete('/:id', ...write('DELETE_TASK', (c, req) => T.remove(c, req.params.id, req.auth)));

module.exports = router;
