'use strict';

const express = require('express');
const A = require('../domain/apps');
const { json, plain } = require('../lib/handlers');
const { lookupTenant } = require('../tenancy/resolve');

/**
 * Apps (domain/apps, docs/audits/audit-apps.md):
 *
 *   GET    /api/apps                       the installed apps
 *   POST   /api/apps                       install: { sourceUrl | definition, appKey, roles?, api? }
 *   GET    /api/apps/extensions?location=  what the user sees at a location
 *   GET    /api/apps/:id
 *   PATCH  /api/apps/:id                   { appKey?, state?, roles?, allUsers? }
 *   POST   /api/apps/:id:reload            read the definition again
 *   DELETE /api/apps/:id                   uninstall
 *   POST   /api/apps/:id/launch            { location, objectId? } -> a one-time launch address
 *
 * and, outside /api, GET /apps/frame/:tenant/:token, the launch page. The
 * permissions are in lib/routePermissions.
 */

// The API's address in a signed context: PUBLIC_BASE_URL only. The request's Host is the caller's to choose,
// and a provider sends its API key to this address.
const baseUrl = () => (process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : null);
const ctx = (req) => ({ actor: req.auth.email, user: req.auth });

const router = express.Router();
router.get('/', ...json((c) => A.list(c)));
router.post('/', ...plain((req) => A.install(req.tenant, req.body || {}, ctx(req)), 201));
router.get('/extensions', ...json((c, req) => A.extensions(c, req.auth, req.query.location)));
router.post('/:id\\:reload', ...plain((req) => A.reload(req.tenant, req.params.id, ctx(req))));
router.post('/:id/launch', ...json((c, req) => A.launch(c, req.tenant, req.auth, req.params.id, req.body || {}, { baseUrl: baseUrl() }), { write: true }));
router.get('/:id', ...json((c, req) => A.get(c, req.params.id)));
router.patch('/:id', ...json((c, req) => A.update(c, req.params.id, req.body || {}, ctx(req)), { write: true }));
router.delete('/:id', ...plain((req) => A.uninstall(req.tenant, req.params.id, ctx(req))));

const attr = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/**
 * The launch page: opened once, it posts the signed request to the app.
 * Its CSP lets the form go to that app's origin only.
 */
async function frame(req, res, next) {
  try {
    const t = /^[a-z0-9_]{1,63}$/.test(req.params.tenant) ? await lookupTenant(req.params.tenant) : null;
    const l = t && t.status === 'ACTIVE' ? await A.takeLaunch(t.schema_name, req.params.token) : null;
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!l) {
      res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      res.status(404).type('html').send('<!doctype html><title>Expired</title><p>This app link has expired or was used. Open the app again.</p>');
      return;
    }
    const origin = new URL(l.url).origin;
    res.set('Content-Security-Policy',
      `default-src 'none'; script-src 'self'; style-src 'self'; form-action ${origin}; frame-ancestors 'self'; base-uri 'none'`);
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Opening the app</title></head><body>
<form id="app-launch" method="post" action="${attr(l.url)}"><input type="hidden" name="signed_request" value="${attr(l.signedRequest)}">
<noscript><button type="submit">Open the app</button></noscript></form>
<script src="/console/js/appframe.js"></script></body></html>`);
  } catch (e) { next(e); }
}

module.exports = { router, frame };
