'use strict';

const crypto = require('crypto');
const { pool } = require('../db/pool');
const { withTenant } = require('../db/tenantContext');
const D = require('../lib/appDefinition');
const OUT = require('../lib/outbound');
const PERMS = require('../lib/permissions');
const ROLES = require('./roles');
const CONSUMERS = require('../tenancy/consumers');
const KEYS = require('../auth/apiKeys');
const { seal, open } = require('./notifications/secrets');
const { recordAudit } = require('../lib/auditLog');
const { err } = require('../lib/errors');

/**
 * Apps (docs/audits/audit-apps.md): another provider's web application
 * shown in the back office, as on the reference platform.
 *
 *   install    from a source URL or a pasted definition, with the App Key
 *              (sealed, never returned); optionally an API consumer made for
 *              the app (its key shown once) or one already made; the
 *              definition's installURL is called, signed, and a failure
 *              cancels the install
 *   update     the App Key, who sees it (all users or roles), the state
 *   reload     the definition read again from its source URL
 *   uninstall  the uninstallURL called (its failure does not stop it), the
 *              consumer made for the app deactivated, the app removed
 *   extensions what a user sees at a location
 *   launch     after checking the user may see the record, the context is
 *              signed with the App Key and kept behind a one-time launch
 *              page (/apps/frame/<tenant>/<token>, a minute), which posts it
 *              to the extension point; the console frames that page
 *
 * Every change and every opening is in the audit trail.
 */

const LAUNCH_SECONDS = 60;
const CONTEXT_SECONDS = 300;
const ADMIN = 'TENANT_ADMIN';

// Where a location's record is, and the permission needed to see it. Branch
// limits apply through the tables' row security (migration 032).
const RECORDS = {
  CLIENT_VIEW: ['VIEW_CLIENT_DETAILS', "SELECT 1 FROM members WHERE id::text = $1 AND holder_type = 'CLIENT'"],
  GROUP_VIEW: ['VIEW_GROUP_DETAILS', "SELECT 1 FROM members WHERE id::text = $1 AND holder_type = 'GROUP'"],
  LOAN_ACCOUNT_VIEW: ['VIEW_LOAN_ACCOUNT_DETAILS', 'SELECT 1 FROM loan_accounts WHERE id::text = $1'],
  DEPOSIT_ACCOUNT_VIEW: ['VIEW_SAVINGS_ACCOUNT_DETAILS', 'SELECT 1 FROM savings_accounts WHERE id::text = $1'],
  LINE_OF_CREDIT_VIEW: ['VIEW_LINE_OF_CREDIT_DETAILS', 'SELECT 1 FROM credit_arrangements WHERE id::text = $1'],
  BRANCH_VIEW: ['VIEW_BRANCH_DETAILS', 'SELECT 1 FROM branches WHERE id::text = $1'],
  CENTRE_VIEW: ['VIEW_CENTRE_DETAILS', 'SELECT 1 FROM centres WHERE id::text = $1'],
  LOAN_PRODUCT_VIEW: ['VIEW_LOAN_PRODUCT_DETAILS', 'SELECT 1 FROM loan_products WHERE id = $1'],
  DEPOSIT_PRODUCT_VIEW: ['VIEW_SAVINGS_PRODUCT_DETAILS', 'SELECT 1 FROM savings_products WHERE id = $1'],
  USER_VIEW: ['VIEW_USER_DETAILS', `SELECT 1 FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
    WHERE t.schema_name = current_schema() AND u.id::text = $1`],
  REPORTING_VIEW: ['VIEW_REPORTS', null],
  EXTENSION_MENU: [null, null],
};

const audit = (c, actor, action, id, before = null, after = null) => recordAudit(c, { actor, action, entity: 'app', entityId: id, before, after });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function shape(a, points = [], consumer = null) {
  return {
    id: a.id, name: a.name, provider: a.provider, description: a.description, sourceUrl: a.source_url, state: a.state,
    hasAppKey: Boolean(a.app_key), installUrl: a.install_url, uninstallUrl: a.uninstall_url,
    usage: { allUsers: a.all_users, roles: a.roles },
    extensionPoints: points.filter((p) => p.app_id === a.id).map((p) => ({ location: p.location, label: p.label, url: p.url })),
    apiConsumer: consumer || (a.consumer_id ? { id: a.consumer_id } : null),
    installedBy: a.installed_by, installedAt: a.installed_at, updatedBy: a.updated_by, updatedAt: a.updated_at,
  };
}

async function find(c, id) {
  const { rows: [a] } = await c.query('SELECT * FROM apps WHERE id = $1', [String(id)]);
  if (!a) throw err('APP_NOT_FOUND', 404);
  return a;
}

async function list(c) {
  const { rows } = await c.query('SELECT * FROM apps ORDER BY lower(name)');
  const { rows: points } = await c.query('SELECT * FROM app_extension_points ORDER BY app_id, position');
  return rows.map((a) => shape(a, points));
}

async function get(c, id) {
  const a = await find(c, id);
  const { rows: points } = await c.query('SELECT * FROM app_extension_points WHERE app_id = $1 ORDER BY position', [a.id]);
  return shape(a, points);
}

function appKeyOf(v) {
  const k = String(v ?? '');
  if (!k || k.length > 32) throw err('APP_KEY_IS_1_TO_32_CHARACTERS');
  if (!/^[\x21-\x7e]+$/.test(k)) throw err('APP_KEY_IS_PRINTABLE_CHARACTERS_WITHOUT_SPACES');
  return k;
}

async function usageOf(c, body, before = null) {
  const u = body.usage || body;
  const roles = u.roles !== undefined ? u.roles : before ? before.roles : [];
  if (!Array.isArray(roles)) throw err('ROLES_MUST_BE_A_LIST');
  const codes = [...new Set(roles.map(String))];
  for (const r of codes) await ROLES.get(c, r);
  const allUsers = u.allUsers !== undefined ? Boolean(u.allUsers) : before && u.roles === undefined ? before.all_users : !codes.length;
  return { allUsers, roles: codes };
}

/** The definition from its source URL, through the outbound guard. */
async function fetchDefinition(url) {
  const src = OUT.checkUrl(url, { prefix: 'APP_SOURCE' });
  if (!src) throw err('APP_SOURCE_URL_OR_DEFINITION_REQUIRED');
  const r = await OUT.send({ url: src, method: 'GET', headers: { accept: 'application/xml, text/xml' }, maxBytes: D.MAX_BYTES, timeoutMs: 10_000 });
  if (r.error === 'ANSWER_TOO_LARGE') throw err(`APP_DEFINITION_TOO_LARGE: at most ${D.MAX_BYTES / 1024} KB`);
  if (r.error || r.status < 200 || r.status >= 300) throw err(`APP_DEFINITION_NOT_LOADED: ${r.error || `HTTP ${r.status}`}`, 502);
  return { src, xml: r.body };
}

/** The install and uninstall calls: a signed form post. */
async function notify(url, appKey, context) {
  const body = new URLSearchParams({ signed_request: D.sign(context, appKey) }).toString();
  return OUT.send({ url, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 10_000 });
}
const notice = (tenant, appId, event) => ({
  appId, tenantId: tenant.slug, event, issuedAt: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('hex'),
});

async function writePoints(c, id, points) {
  await c.query('DELETE FROM app_extension_points WHERE app_id = $1', [id]);
  for (const p of points) {
    await c.query('INSERT INTO app_extension_points (app_id, position, location, label, url) VALUES ($1, $2, $3, $4, $5)', [id, p.position, p.location, p.label, p.url]);
  }
}

/** Apps open in the console for staff users; an API key has no console. */
function staffOnly(user) {
  if (user.apiConsumer) throw err('APPS_ARE_FOR_STAFF_USERS: apps open in the console, not with an API key', 403);
}

async function install(tenant, body = {}, { actor, user }) {
  const appKey = appKeyOf(body.appKey);
  const api = body.api || null;
  // The app's API access is an API consumer: making or linking one needs the consumer permissions too.
  if (api?.consumerId && !PERMS.can(user, 'VIEW_API_CONSUMERS_AND_KEYS')) throw err('PERMISSION_REQUIRED: VIEW_API_CONSUMERS_AND_KEYS', 403);
  if (api && !api.consumerId && !PERMS.can(user, 'CREATE_API_CONSUMERS_AND_KEYS')) throw err('PERMISSION_REQUIRED: CREATE_API_CONSUMERS_AND_KEYS', 403);
  const { src, xml } = body.definition ? { src: null, xml: String(body.definition) } : await fetchDefinition(body.sourceUrl);
  const def = D.parse(xml);
  // The consumer is a platform record, made before the tenant's transaction and removed if the install fails.
  let made = null;
  let consumer = null;
  try {
    return await withTenant(tenant.schema_name, async (c) => {
      const usage = await usageOf(c, body);
      const { rows: [dup] } = await c.query('SELECT 1 FROM apps WHERE id = $1', [def.id]);
      if (dup) throw err(`APP_EXISTS: ${def.id}`, 409);
      let apiKey = null;
      if (api?.consumerId) {
        consumer = await CONSUMERS.get(tenant, api.consumerId);
      } else if (api) {
        made = await CONSUMERS.create(tenant, { name: `App: ${def.name}`.slice(0, 255), access: { role: api.role, permissions: api.permissions || [] },
          notes: `Made when the app ${def.id} was installed` }, { actor, actorUser: user });
        apiKey = (await CONSUMERS.createKey(tenant, made.id, {}, { actor })).apiKey;
        consumer = made;
      }
      const { rows: [a] } = await c.query(
        `INSERT INTO apps (id, name, provider, description, source_url, definition, app_key, install_url, uninstall_url, all_users, roles,
           consumer_id, consumer_created, installed_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) RETURNING *`,
        [def.id, def.name, def.provider, def.description, src, xml, seal(appKey), def.installUrl, def.uninstallUrl, usage.allUsers, usage.roles,
          consumer?.id || null, Boolean(made), actor]);
      await writePoints(c, a.id, def.extensionPoints);
      await audit(c, actor, 'APP_INSTALLED', a.id, null, { name: a.name, sourceUrl: src, extensionPoints: def.extensionPoints, usage, consumerId: consumer?.id || null });
      // Last, so the provider is told only once everything else is written; a failure cancels the install.
      if (def.installUrl) {
        const r = await notify(def.installUrl, appKey, notice(tenant, a.id, 'INSTALLED'));
        if (r.error || r.status < 200 || r.status >= 300) throw err(`APP_INSTALL_CALL_FAILED: ${r.error || `HTTP ${r.status}`}`, 502);
      }
      const { rows: points } = await c.query('SELECT * FROM app_extension_points WHERE app_id = $1 ORDER BY position', [a.id]);
      const out = shape(a, points, consumer && { id: consumer.id, name: consumer.name, ...consumer.access });
      return apiKey ? { ...out, apiKey } : out;
    });
  } catch (e) {
    if (made) { await pool.query('DELETE FROM platform.api_consumers WHERE id = $1', [made.id]).catch(() => {}); KEYS.forget(); }
    if (e.code === '23505') throw err(`APP_EXISTS: ${def.id}`, 409);
    throw e;
  }
}

async function update(c, id, body = {}, { actor }) {
  const a = await find(c, id);
  const sets = {};
  if (body.appKey !== undefined) sets.app_key = seal(appKeyOf(body.appKey));
  if (body.state !== undefined) {
    const s = String(body.state).toUpperCase();
    if (!['ENABLED', 'DISABLED'].includes(s)) throw err('STATE_IS_ENABLED_OR_DISABLED');
    if (s === 'ENABLED' && !a.app_key && !sets.app_key) throw err('APP_KEY_REQUIRED: give the app its App Key to enable it', 409);
    sets.state = s;
  }
  if (body.usage !== undefined || body.roles !== undefined || body.allUsers !== undefined) {
    const u = await usageOf(c, body, a);
    sets.all_users = u.allUsers;
    sets.roles = u.roles;
  }
  const keys = Object.keys(sets);
  if (!keys.length) return get(c, a.id);
  await c.query(`UPDATE apps SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now() WHERE id = $1`,
    [a.id, ...keys.map((k) => sets[k]), actor]);
  await audit(c, actor, 'APP_UPDATED', a.id, { state: a.state, allUsers: a.all_users, roles: a.roles },
    { state: sets.state ?? a.state, allUsers: sets.all_users ?? a.all_users, roles: sets.roles ?? a.roles, appKeyChanged: Boolean(sets.app_key) });
  return get(c, a.id);
}

async function reload(tenant, id, { actor }) {
  // The definition is fetched outside the tenant's transaction, which is not held open for it.
  const { rows: [first] } = await withTenant(tenant.schema_name, (c) => c.query('SELECT source_url FROM apps WHERE id = $1', [String(id)]));
  if (!first) throw err('APP_NOT_FOUND', 404);
  if (!first.source_url) throw err('APP_HAS_NO_SOURCE_URL: install it again from its definition', 409);
  const { xml } = await fetchDefinition(first.source_url);
  const def = D.parse(xml);
  return withTenant(tenant.schema_name, (c) => applyReload(c, id, def, xml, actor));
}

async function applyReload(c, id, def, xml, actor) {
  const a = await find(c, id);
  if (def.id !== a.id) throw err(`APP_ID_CHANGED: the definition is for ${def.id}`, 409);
  await c.query(`UPDATE apps SET name = $2, provider = $3, description = $4, definition = $5, install_url = $6, uninstall_url = $7,
     updated_by = $8, updated_at = now() WHERE id = $1`, [a.id, def.name, def.provider, def.description, xml, def.installUrl, def.uninstallUrl, actor]);
  await writePoints(c, a.id, def.extensionPoints);
  await audit(c, actor, 'APP_RELOADED', a.id, { name: a.name }, { name: def.name, extensionPoints: def.extensionPoints });
  return get(c, a.id);
}

async function uninstall(tenant, id, { actor, user }) {
  const out = await withTenant(tenant.schema_name, async (c) => {
    const a = await find(c, id);
    let call = null;
    if (a.uninstall_url && a.app_key) {
      let key = null;
      try { key = open(a.app_key); } catch { call = 'APP_KEY_UNREADABLE: the provider was not told'; }
      if (key) {
        const r = await notify(a.uninstall_url, key, notice(tenant, a.id, 'UNINSTALLED'));
        call = r.error || r.status;
      }
    }
    await c.query('DELETE FROM apps WHERE id = $1', [a.id]);
    await audit(c, actor, 'APP_UNINSTALLED', a.id, { name: a.name, consumerId: a.consumer_id }, { uninstallCall: call });
    return { app: a, call };
  });
  // The consumer the install made stops working: set directly, since the uninstaller may not hold its permissions.
  let deactivated = null;
  if (out.app.consumer_id && out.app.consumer_created) {
    const { rowCount } = await pool.query("UPDATE platform.api_consumers SET status = 'INACTIVE', updated_at = now() WHERE tenant_id = $1 AND id = $2",
      [tenant.id, out.app.consumer_id]);
    KEYS.forget();
    deactivated = rowCount === 1;
    await pool.query('INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4)',
      [tenant.id, actor, 'API_CONSUMER_UPDATED', JSON.stringify({ consumerId: out.app.consumer_id, after: { status: 'INACTIVE' }, reason: `app ${out.app.id} uninstalled` })]);
  }
  return { uninstalled: out.app.id, uninstallCall: out.call, apiConsumerDeactivated: deactivated };
}

const sees = (user, a) => user.role === ADMIN || a.all_users || (a.roles || []).includes(user.roleCode || user.role);

function locationOf(v) {
  const l = String(v || '').toUpperCase();
  if (!(l in D.LOCATIONS)) throw err(`UNKNOWN_APP_LOCATION: ${v} (use ${Object.keys(D.LOCATIONS).join(', ')})`);
  return l;
}

/** The extension points a user sees at a location (their URLs stay on the server). */
async function extensions(c, user, location) {
  staffOnly(user);
  const l = locationOf(location);
  const { rows } = await c.query(
    `SELECT p.*, a.name AS app_name, a.all_users, a.roles FROM app_extension_points p JOIN apps a ON a.id = p.app_id
      WHERE p.location = $1 AND a.state = 'ENABLED' ORDER BY lower(a.name), p.position`, [l]);
  return rows.filter((p) => sees(user, p)).map((p) => ({ appId: p.app_id, appName: p.app_name, location: p.location, label: p.label, position: p.position }));
}

/** Open an app on a record: checks, signs, and answers a one-time launch address. */
async function launch(c, tenant, user, id, body = {}, { baseUrl }) {
  staffOnly(user);
  const a = await find(c, id);
  if (!sees(user, a)) throw err('APP_NOT_FOUND', 404);
  if (a.state !== 'ENABLED') throw err('APP_IS_DISABLED', 409);
  const location = locationOf(body.location);
  const { rows: [point] } = await c.query('SELECT * FROM app_extension_points WHERE app_id = $1 AND location = $2 ORDER BY position LIMIT 1', [a.id, location]);
  if (!point) throw err(`APP_EXTENSION_POINT_NOT_FOUND: ${a.id} has none at ${location}`, 404);
  const [perm, sql] = RECORDS[location];
  if (perm && !PERMS.can(user, perm)) throw err(`PERMISSION_REQUIRED: ${perm}`, 403);
  const objectId = body.objectId === undefined || body.objectId === null || body.objectId === '' ? null : String(body.objectId);
  if (sql) {
    if (!objectId) throw err('OBJECT_ID_REQUIRED: the record the app opens on');
    const { rows } = await c.query(sql, [objectId]);
    if (!rows.length) throw err(`${D.LOCATIONS[location]}_NOT_FOUND`, 404);
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const context = {
    appId: a.id, tenantId: tenant.slug, location, objectType: D.LOCATIONS[location], objectId: sql ? objectId : null,
    userId: user.sub || null, userEmail: user.email || null, issuedAt, expiresAt: issuedAt + CONTEXT_SECONDS, nonce, apiBaseUrl: baseUrl ? `${baseUrl}/api` : null,
  };
  let key;
  try { key = open(a.app_key); } catch { throw err('APP_KEY_UNREADABLE: give the app its App Key again', 409); }
  const signed = D.sign(context, key);
  const token = crypto.randomBytes(24).toString('base64url');
  await c.query(
    `INSERT INTO app_launches (token_hash, app_id, location, object_id, url, signed_request, nonce, actor, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))`,
    [sha(token), a.id, location, context.objectId, point.url, signed, nonce, user.email || null, LAUNCH_SECONDS]);
  await c.query("DELETE FROM app_launches WHERE expires_at < now() - interval '1 day'");
  await audit(c, user.email || null, 'APP_OPENED', a.id, null, { location, objectId: context.objectId, nonce });
  return { frameUrl: `/apps/frame/${tenant.slug}/${token}`, expiresInSeconds: LAUNCH_SECONDS };
}

/** The launch page's content, once: { url, signedRequest } or null. */
async function takeLaunch(schemaName, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token))) return null;
  return withTenant(schemaName, async (c) => {
    const { rows: [l] } = await c.query(
      `UPDATE app_launches l SET used_at = now(), signed_request = NULL FROM apps a, app_launches o
        WHERE l.token_hash = $1 AND o.token_hash = l.token_hash AND l.used_at IS NULL AND l.expires_at > now() AND a.id = l.app_id AND a.state = 'ENABLED'
        RETURNING l.url, o.signed_request`, [sha(token)]);
    return l ? { url: l.url, signedRequest: l.signed_request } : null;
  });
}

module.exports = { list, get, install, update, reload, uninstall, extensions, launch, takeLaunch, RECORDS };
