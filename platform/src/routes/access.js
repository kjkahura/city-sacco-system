'use strict';

const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { invalidate } = require('../tenancy/resolve');
const AP = require('../lib/accessPreferences');
const CON = require('../tenancy/consumers');
const U = require('../tenancy/users');
const TRAIL = require('../ops/auditTrail');
const ROLE = require('../domain/roles');
const { pool } = require('../db/pool');
const { plain: wrap } = require('../lib/handlers');

/**
 * Access administration (the reference platform's Administration > Access): the tenant's
 * access preferences, API consumers and their keys, the audit trail, and a
 * user's own profile. What each route needs is in lib/routePermissions;
 * the gate checks it before these run.
 *
 *   GET|PUT|PATCH /api/access-preferences
 *   GET  /api/access-preferences/blocked-ips     POST .../blocked-ips/reset { ips }
 *   GET|POST /api/consumers    GET|PATCH|DELETE /api/consumers/{id}
 *   POST /api/consumers/{id}/keys { expirationTime }   DELETE /api/consumers/{id}/keys/{keyId}
 *   POST /api/consumers/{id}/secret-key
 *   POST /api/consumers/keys/rotation { apiKey, expirationTime }   (secretKey header)
 *   GET  /api/audit-trail/events?FIELD[op]=value&from=&size=&sort_by=&sort_order=
 *   GET|PATCH /api/profile
 */

const who = (req) => ({ actor: req.auth.email, actorId: req.auth.sub, actorUser: req.auth });

// --- access preferences ---------------------------------------------------------

const prefs = express.Router();
async function savePrefs(req) {
  const t = req.tenant;
  const { rows: [row] } = await pool.query('SELECT access_preferences FROM platform.tenants WHERE id = $1', [t.id]);
  const next = AP.validate(row.access_preferences || {}, req.body || {});
  let mfa;
  if (req.body?.mfaRequiredRoles !== undefined) {
    if (!Array.isArray(req.body.mfaRequiredRoles)) throw Object.assign(new Error('MFA_REQUIRED_ROLES_MUST_BE_A_LIST'), { status: 400 });
    await withTenantRead(t.schema_name, (c) => ROLE.assertKnown(c, req.body.mfaRequiredRoles));
    mfa = [...new Set(req.body.mfaRequiredRoles)];
  }
  // Refuse an allowlist that would shut out the person saving it.
  if (!AP.allowlistPasses({ ...AP.merge(next) }, req.ip, { admin: req.auth.role === 'TENANT_ADMIN' })) {
    throw Object.assign(new Error(`IP_ALLOWLIST_WOULD_LOCK_YOU_OUT: your address ${req.ip} is not on it`), { status: 409 });
  }
  const out = await AP.save(t.id, next, mfa);
  invalidate(t.slug);
  await pool.query('INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
    [t.id, req.auth.email, 'ACCESS_PREFERENCES_CHANGED', JSON.stringify({ before: row.access_preferences, after: next, mfaRequiredRoles: mfa })]);
  return out;
}
prefs.get('/', ...wrap((req) => AP.of(req.tenant.id)));
prefs.put('/', ...wrap(savePrefs));
prefs.patch('/', ...wrap(savePrefs));
prefs.get('/blocked-ips', ...wrap((req) => CON.blockedIps(req.tenant)));
prefs.post('/blocked-ips/reset', ...wrap((req) => CON.resetIps(req.tenant, req.body?.ips, who(req))));

// --- API consumers ----------------------------------------------------------------

const consumers = express.Router();
// Rotation authenticates with the consumer's secret key, not a session.
consumers.post('/keys/rotation', async (req, res, next) => {
  try { res.json(await CON.rotate(req.tenant, req.get('secretkey'), req.body || {})); } catch (e) { next(e); }
});
consumers.get('/', ...wrap((req) => CON.list(req.tenant)));
consumers.post('/', ...wrap((req) => CON.create(req.tenant, req.body || {}, who(req)), 201));
consumers.get('/:id', ...wrap((req) => CON.get(req.tenant, req.params.id)));
consumers.patch('/:id', ...wrap((req) => CON.update(req.tenant, req.params.id, req.body || {}, who(req))));
consumers.delete('/:id', ...wrap((req) => CON.remove(req.tenant, req.params.id, who(req))));
consumers.post('/:id/keys', ...wrap((req) => CON.createKey(req.tenant, req.params.id, req.body || {}, who(req)), 201));
consumers.delete('/:id/keys/:keyId', ...wrap((req) => CON.deleteKey(req.tenant, req.params.id, req.params.keyId, who(req))));
consumers.post('/:id/secret-key', ...wrap((req) => CON.createSecret(req.tenant, req.params.id, who(req)), 201));

// --- audit trail ---------------------------------------------------------------------

const trail = express.Router();
trail.get('/events', ...wrap((req) => withTenantRead(req.tenant.schema_name, (c) => TRAIL.events(c, req.query))));

// --- own profile ------------------------------------------------------------------------

const profile = express.Router();
profile.get('/', ...wrap(async (req) => {
  if (req.auth.apiConsumer) throw Object.assign(new Error('API_CONSUMERS_HAVE_NO_PROFILE'), { status: 400 });
  const u = await U.get(req.tenant, req.auth.sub);
  return { ...u, permissions: [...req.auth.permissions].sort() };
}));
profile.patch('/', ...wrap((req) => U.updateProfile(req.tenant, req.auth.sub, req.body || {})));

module.exports = { prefs, consumers, trail, profile };
