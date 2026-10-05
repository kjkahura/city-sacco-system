'use strict';

const express = require('express');
const { requireAuth } = require('../tenancy/resolve');
const SB = require('../tenancy/sandbox');

/**
 * A SACCO's sandbox (tenancy/sandbox), for its administrators:
 *
 *   GET    /api/sandbox          whether there is one, its state, the last operation
 *   POST   /api/sandbox          create an empty one
 *   POST   /api/sandbox:reset    empty it
 *   POST   /api/sandbox:clone    copy production into it, { anonymize } (true by default)
 *   DELETE /api/sandbox          delete it
 *
 * Operations are queued and answer 202, with the sandbox administrator's
 * temporary password, shown this once. The permission is in lib/routePermissions.
 */

const wrap = (fn, status = 200) => [requireAuth(), async (req, res, next) => {
  try { res.status(status).json(await fn(req)); } catch (e) { next(e); }
}];
const ask = (kind) => wrap((req) => SB.request(req.tenant.slug, kind, {
  actor: req.auth.email, adminEmail: req.auth.email, anonymize: req.body?.anonymize === undefined ? true : req.body.anonymize,
}), 202);

const router = express.Router();
router.get('/', ...wrap(async (req) => (req.tenant.environment === 'SANDBOX'
  ? { environment: 'SANDBOX', exists: false, note: 'This is a sandbox; manage it from its production tenant' }
  : { environment: 'PRODUCTION', ...(await SB.status(req.tenant.slug)) })));
router.post('/', ...ask('CREATE'));
router.delete('/', ...ask('DELETE'));

module.exports = { router, reset: ask('RESET'), clone: ask('CLONE') };
