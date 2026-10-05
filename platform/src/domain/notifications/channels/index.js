'use strict';

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

const CHANNELS = { EMAIL: require('./email') };
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

function moduleOf(channel) {
  const m = CHANNELS[String(channel || '').toUpperCase()];
  if (!m) throw err(`UNKNOWN_CHANNEL: ${channel}`, 404);
  return m;
}

async function load(c, channel) {
  const { rows: [r] } = await c.query('SELECT * FROM notification_channels WHERE channel = $1', [channel]);
  return r || { channel, enabled: false, settings: {}, secret: null, pace_per_minute: 60, updated_at: null, updated_by: null };
}

const shape = (channel, r) => ({
  enabled: r.enabled, ...moduleOf(channel).describe(r.settings || {}), passwordSet: Boolean(r.secret), pacePerMinute: r.pace_per_minute,
  lastModifiedDate: iso(r.updated_at), lastModifiedBy: r.updated_by || null,
});

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
  if (was !== null && was !== m.server(next)) throw err('PASSWORD_REQUIRED: type the password again when the server, port or username changes');
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
  const { settings: s, secret } = m.validate({ ...merged, password: settings?.password });
  assertSameServer(m, stored, s, secret);
  return m.test(s, secret !== undefined ? secret : S.open(stored.secret), to);
}

/** What the dispatcher needs to send on a channel: null when it is off or has no settings. */
async function ready(c, channel) {
  const r = await load(c, channel);
  if (!r.enabled || !r.settings || !Object.keys(r.settings).length) return null;
  return { settings: r.settings, secret: S.open(r.secret), module: moduleOf(channel) };
}

module.exports = { CHANNELS, get, save, test, load, ready, moduleOf };
