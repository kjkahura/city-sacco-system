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

templates.get('/', ...H.run((c, req) => TPL.list(c, { type: req.query.type || null })));
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

// --- email settings, the test, manual email, subscriptions ----------------------------

const CH = require('../domain/notifications/channels');
settings.get('/email', ...H.run((c) => CH.get(c, 'EMAIL')));
settings.put('/email', ...H.run((c, req, _res, { actor }) => CH.save(c, 'EMAIL', req.body, { actor }), { write: true }));
// Mounted at /api/notificationsettings/email:test (a colon action on the tenant API, as the message actions).
const emailTest = H.run((c, req) => CH.test(c, 'EMAIL', { to: req.body?.to, settings: req.body?.settings || {} }));
actions.sendEmail = H.plain(async (req) => require('../domain/notifications/manual').sendEmail(req.tenant.schema_name, req.body || {}, H.ctxOf(req)), 201);

const SUBS = require('../domain/notifications/subscriptions');
const subscriptions = express.Router({ mergeParams: true });
// /clients/:id for individuals, /groups/:id for groups.
async function holderOf(c, req) {
  const group = req.baseUrl.includes('/groups/');
  const { rows: [m] } = await c.query('SELECT id, holder_type FROM members WHERE id::text = $1', [req.params.id]);
  if (!m || (m.holder_type === 'GROUP') !== group) throw Object.assign(new Error(group ? 'GROUP_NOT_FOUND' : 'CLIENT_NOT_FOUND'), { status: 404 });
  return m;
}
subscriptions.get('/', ...H.run(async (c, req) => SUBS.list(c, (await holderOf(c, req)).id)));
subscriptions.put('/:templateId', ...H.run(async (c, req, _res, { actor }) => SUBS.set(c, (await holderOf(c, req)).id, req.params.templateId, req.body?.subscribed, { actor }), { write: true }));

// 10. The email templates a user who sends manual email may pick (not the webhooks, with their addresses).
const emailTemplates = H.run(async (c) => (await c.query(
  "SELECT id, name, subject, body FROM notification_templates WHERE type = 'EMAIL' AND activated ORDER BY lower(name)")).rows);

module.exports.messages = messages;
module.exports.actions = actions;
module.exports.v1 = v1;
module.exports.settings = settings;
module.exports.emailTest = emailTest;
module.exports.subscriptions = subscriptions;

// --- SMS: settings, providers, the test, the delivery report address, manual SMS ------------

const SMSCH = require('../domain/notifications/channels/sms');
settings.get('/sms', ...H.run((c) => CH.get(c, 'SMS')));
settings.get('/sms/providers', ...H.run(async () => require('../domain/notifications/channels/sms-providers').list()));
settings.put('/sms', ...H.run((c, req, _res, { actor }) => CH.save(c, 'SMS', req.body, { actor }), { write: true }));
module.exports.smsTest = H.run((c, req) => CH.test(c, 'SMS', { to: req.body?.to, settings: req.body?.settings || {} }));
// The address a gateway posts delivery reports to: PUBLIC_BASE_URL when set, else https and this request's own host
// (never http: the token is the secret).
module.exports.smsCallbackToken = H.run(async (c, req, _res, { actor }) => {
  const token = await CH.newCallbackToken(c, 'SMS', { actor });
  const base = process.env.PUBLIC_BASE_URL || `https://${req.get('host')}`;
  return { callbackUrl: `${base.replace(/\/+$/, '')}/hooks/sms/${req.tenant.slug}/${token}` };
}, { write: true });
actions.sendSms = H.plain(async (req) => require('../domain/notifications/manual').sendSms(req.tenant.schema_name, req.body || {}, H.ctxOf(req)), 201);
module.exports.smsTemplates = H.run(async (c) => (await c.query(
  "SELECT id, name, body FROM notification_templates WHERE type = 'SMS' AND activated ORDER BY lower(name)")).rows
  .map((t) => ({ ...t, segments: SMSCH.segments(t.body).count })));

/**
 * A gateway's delivery report: /hooks/sms/<tenant>/<token>, outside the
 * tenant API (the gateway has no user). The token is the secret; a wrong one
 * is not found. Runs as the system.
 */
module.exports.smsDeliveryReport = async (req, res) => {
  try {
    const { pool } = require('../db/pool');
    const { withTenant } = require('../db/tenantContext');
    const requestContext = require('../lib/requestContext');
    const { rows: [t] } = await pool.query("SELECT schema_name FROM platform.tenants WHERE slug = $1 AND status = 'ACTIVE'", [req.params.tenant]);
    if (!t) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    const n = await requestContext.run(null, () => withTenant(t.schema_name, (c) => CH.deliveryReport(c, 'SMS', req.params.token, { body: req.body, query: req.query })));
    res.status(200).json({ received: n });
  } catch (e) {
    res.status(e.status === 404 ? 404 : 500).json({ error: e.status === 404 ? 'NOT_FOUND' : 'ERROR' });
    if (e.status !== 404) console.warn(`[sms report] ${e.message}`);
  }
};
module.exports.emailTemplates = emailTemplates;
