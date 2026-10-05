'use strict';

const crypto = require('crypto');
const { err } = require('../../../lib/errors');
const { recordAudit } = require('../../../lib/auditLog');
const S = require('../secrets');

/**
 * The channels that reach people (Email now, SMS next), each with its
 * settings in notification_channels: a switch, the fields, a sealed secret
 * (the SMTP password, a gateway's key) and a pace (messages a minute).
 *
 * A channel module has validate(body) -> { settings, secret }, describe
 * (settings) -> the fields to show, send(settings, secret, message) and
 * test(settings, secret, to). The secret is never returned.
 */

const EMAIL = require('./email');
const SMS = require('./sms');

const CHANNELS = { EMAIL, SMS };
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

function moduleOf(channel) {
  const m = CHANNELS[String(channel || '').toUpperCase()];
  if (!m) throw err(`UNKNOWN_CHANNEL: ${channel}`, 404);
  return m;
}

async function load(c, channel) {
  const { rows: [r] } = await c.query('SELECT * FROM notification_channels WHERE channel = $1', [channel]);
  return r || { channel, enabled: false, settings: {}, secret: null, pace_per_minute: 60, callback_token_hash: null, updated_at: null, updated_by: null };
}

const shape = (channel, r) => {
  const m = moduleOf(channel);
  return {
    enabled: r.enabled, ...m.describe(r.settings || {}), [`${m.secretName || 'password'}Set`]: Boolean(r.secret), pacePerMinute: r.pace_per_minute,
    ...(m.parseDeliveryReport ? { deliveryReportsEnabled: Boolean(r.callback_token_hash) } : {}),
    lastModifiedDate: iso(r.updated_at), lastModifiedBy: r.updated_by || null,
  };
};

async function get(c, channel) {
  return shape(channel, await load(c, channel));
}

function paceOf(v, current) {
  if (v === undefined || v === null) return current;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 6000) throw err('PACE_PER_MINUTE_IS_1_TO_6000');
  return n;
}

/**
 * A stored password goes only to the server it was given for: a change of
 * server (host, port or username) needs the password typed again, or an
 * administrator could point the settings at a server of their own and
 * receive it.
 */
function assertSameServer(m, stored, next, secret) {
  if (secret !== undefined || !stored.secret) return;
  const was = m.server ? m.server(stored.settings || {}) : null;
  if (was !== null && was !== m.server(next)) {
    throw err(m.secretName === 'apiKey' ? 'API_KEY_REQUIRED: type the API key again when the gateway changes'
      : 'PASSWORD_REQUIRED: type the password again when the server, port or username changes');
  }
}

/** Replace a channel's settings. A body without a password keeps the stored one, for the same server. */
async function save(c, channel, body = {}, { actor }) {
  const m = moduleOf(channel);
  const before = await load(c, channel);
  const { settings, secret } = m.validate(body || {});
  assertSameServer(m, before, settings, secret);
  const sealed = secret === undefined ? before.secret : secret === '' ? null : S.seal(secret);
  const enabled = body.enabled === undefined ? before.enabled : Boolean(body.enabled);
  const pace = paceOf(body.pacePerMinute, before.pace_per_minute);
  const { rows: [r] } = await c.query(
    `INSERT INTO notification_channels (channel, enabled, settings, secret, pace_per_minute, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (channel) DO UPDATE SET enabled = EXCLUDED.enabled, settings = EXCLUDED.settings, secret = EXCLUDED.secret,
       pace_per_minute = EXCLUDED.pace_per_minute, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`, [channel, enabled, JSON.stringify(settings), sealed, pace, actor]);
  // The audit trail gets the fields and whether a password is set, never the password.
  await recordAudit(c, { actor, action: `${channel}_SETTINGS_CHANGED`, entity: 'notification_channel', entityId: channel,
    before: JSON.stringify(shape(channel, before)), after: JSON.stringify(shape(channel, r)) });
  return shape(channel, r);
}

/** A test with the stored settings, or with some fields changed (not saved); the stored password unless one is given. */
async function test(c, channel, { to, settings = {} } = {}) {
  const m = moduleOf(channel);
  const stored = await load(c, channel);
  const merged = { ...m.describe(stored.settings || {}), ...(settings || {}) };
  const { settings: s, secret } = m.validate({ ...merged, ...(settings || {}) });
  assertSameServer(m, stored, s, secret);
  const { rows: [t] } = await c.query('SELECT country_code FROM platform.tenants WHERE schema_name = current_schema()');
  return m.test(s, secret !== undefined ? secret : S.open(stored.secret), to, { country: t?.country_code || 'KE' });
}

/** What the dispatcher needs to send on a channel: null when it is off or has no settings. */
async function ready(c, channel) {
  const r = await load(c, channel);
  if (!r.enabled || !r.settings || !Object.keys(r.settings).length) return null;
  return { settings: r.settings, secret: S.open(r.secret), module: moduleOf(channel) };
}

// --- delivery reports --------------------------------------------------------------

const digest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * A new address for the gateway's delivery reports: /hooks/sms/<tenant>/<token>.
 * Only the token's hash is kept, so it is shown this once; a new one retires the old.
 */
async function newCallbackToken(c, channel, { actor }) {
  const m = moduleOf(channel);
  if (!m.parseDeliveryReport) throw err(`NO_DELIVERY_REPORTS_FOR: ${channel}`, 404);
  const token = crypto.randomBytes(32).toString('base64url');
  await c.query(
    `INSERT INTO notification_channels (channel, callback_token_hash, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (channel) DO UPDATE SET callback_token_hash = EXCLUDED.callback_token_hash, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [channel, digest(token), actor]);
  await recordAudit(c, { actor, action: `${channel}_DELIVERY_REPORT_ADDRESS_CHANGED`, entity: 'notification_channel', entityId: channel });
  return token;
}

/** Apply a delivery report sent to the address with this token. A wrong token is not found. Returns the messages changed. */
async function deliveryReport(c, channel, token, report) {
  const m = moduleOf(channel);
  const r = await load(c, channel);
  const given = Buffer.from(digest(token));
  const kept = Buffer.from(String(r.callback_token_hash || ''));
  if (kept.length !== given.length || !crypto.timingSafeEqual(given, kept)) throw err('NOT_FOUND', 404);
  let changed = 0;
  for (const x of m.parseDeliveryReport(r.settings || {}, report)) {
    if (!x.status) continue;
    const { rowCount } = await c.query(
      `UPDATE notification_messages SET delivery_status = $3, delivery_detail = $4,
         delivered_at = CASE WHEN $3 = 'DELIVERED' THEN now() ELSE delivered_at END
       WHERE type = $1 AND provider_message_id = $2`, [channel, x.providerMessageId, x.status, x.detail || null]);
    changed += rowCount;
  }
  return changed;
}

module.exports = {
  newCallbackToken, deliveryReport, CHANNELS, get, save, test, load, ready, moduleOf };
