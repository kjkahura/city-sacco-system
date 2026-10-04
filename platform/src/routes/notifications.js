'use strict';

const express = require('express');
const H = require('../lib/handlers');
const TPL = require('../domain/notifications/templates');
const D = require('../domain/notifications/dispatch');
const MSG = require('../domain/notifications/messages');

/**
 * Webhooks, after the reference platform:
 *
 *   /api/templates                          webhook templates (create, list, read, JSON Patch, delete),
 *                                           :test sends a sample now, :rotateSecret makes a new signing secret
 *   /api/communications/messages            the communication log, search and resend (API v2)
 *   /api/notifications/messages             the same, in API v1's shape
 *   /api/notificationsettings/webhook       the tenant-wide switch
 *
 * The permissions are in lib/routePermissions.
 */

const templates = express.Router();

templates.get('/', ...H.run((c) => TPL.list(c)));
// The events (with their targets) and placeholders a template can use, for the console's form.
templates.get('/catalog', ...H.run(async () => {
  const C = require('../domain/notifications/catalog');
  return { events: C.EVENTS, placeholders: Object.keys(C.PLACEHOLDERS), operators: TPL.OPERATORS };
}));
const changed = (req, out) => { D.forget(req.tenant.schema_name); return out; };
templates.post('/', ...H.run(async (c, req, _res, { actor }) => changed(req, await TPL.create(c, req.body, { actor })), { write: true, status: 201 }));
templates.post('/:id\\:test', ...H.plain(async (req) => MSG.shape(await D.testTemplate(req.tenant.schema_name, req.params.id, { actor: req.auth.email }))));
templates.post('/:id\\:rotateSecret', ...H.run((c, req, _res, { actor }) => TPL.rotateSecret(c, req.params.id, { actor }), { write: true }));
templates.get('/:id', ...H.run((c, req) => TPL.get(c, req.params.id)));
templates.patch('/:id', ...H.run(async (c, req, _res, { actor }) => changed(req, await TPL.patch(c, req.params.id, req.body, { actor })), { write: true }));
templates.delete('/:id', ...H.run(async (c, req, res, { actor }) => {
  await TPL.remove(c, req.params.id, { actor });
  changed(req);
  res.status(204).end();
}, { write: true }));

module.exports = { templates };

// --- the communication log (API v2) -------------------------------------------

const { pageParams } = require('../lib/page');
const full = (req) => String(req.query.detailsLevel || '').toUpperCase() === 'FULL';
const searchRoute = (criteriaOf) => H.run(async (c, req, res) => {
  const pg = pageParams(req.query);
  const { filterCriteria, sortingCriteria } = criteriaOf(req.body);
  const out = await MSG.search(c, { filterCriteria, sortingCriteria, ...pg, full: full(req) });
  H.pagingHeaders(req, res, { ...pg, total: out.total });
  return out.rows;
});

const messages = express.Router();
const actions = {};
actions.search = searchRoute((b) => ({ filterCriteria: Array.isArray(b) ? b : b?.filterCriteria || [] }));
actions.searchSorted = searchRoute((b) => ({ filterCriteria: b?.filterCriteria || [], sortingCriteria: b?.sortingCriteria || null }));
actions.resend = H.run(async (c, req, res, { actor }) => {
  await MSG.resend(c, req.body?.messages, { actor });
  res.status(202);
  return { messages: req.body.messages };
}, { write: true, status: 202 });
actions.resendAsyncByKeys = H.run(async (c, req, _res, { actor }) => ({ messages: await MSG.resend(c, req.body?.messages, { actor }) }), { write: true });
actions.resendAsyncByDate = H.run(async (c, req, _res, { actor }) => ({ messages: await MSG.resendByDate(c, req.body || {}, { actor }) }), { write: true });
messages.get('/:key', ...H.run(async (c, req) => MSG.shape(await MSG.get(c, req.params.key))));

// --- API v1: /api/notifications/messages ----------------------------------------

const v1 = express.Router();
v1.post('/search', ...H.run(async (c, req) => (await MSG.search(c, { filterCriteria: MSG.fromV1(req.body?.filterConstraints), limit: 1000, full: true })).rows));
v1.post('/', ...H.run(async (c, req, _res, { actor }) => {
  if (String(req.body?.action || '').toLowerCase() !== 'resend') throw Object.assign(new Error('ACTION_MUST_BE_RESEND'), { status: 400 });
  await MSG.resend(c, req.body?.identifiers, { actor });
  return { returnCode: 200, returnStatus: 'SUCCESS' };
}, { write: true }));

// --- the switch -------------------------------------------------------------------

const settings = express.Router();
settings.get('/webhook', ...H.run((c) => MSG.settings(c)));
settings.put('/webhook', ...H.run((c, req, _res, { actor }) => MSG.setSettings(c, req.body, { actor }), { write: true }));

module.exports.messages = messages;
module.exports.actions = actions;
module.exports.v1 = v1;
module.exports.settings = settings;
