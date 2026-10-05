'use strict';

const { err } = require('../../lib/errors');
const { recordAudit } = require('../../lib/auditLog');
const OUT = require('../../lib/outbound');
const C = require('./catalog');
const R = require('./render');
const S = require('./secrets');

/**
 * Webhook templates (the reference platform's templates API): what event,
 * under which conditions, sent where and how, with what body.
 *
 * The basic authentication password and the signing secret are stored
 * sealed (./secrets) and never returned; the signing secret is shown once,
 * when it is made or rotated, so the receiver can be given it.
 */

const REQUEST_TYPES = ['POST', 'PUT', 'PATCH'];
const CONTENT_TYPES = ['PLAIN_TEXT', 'JSON', 'XML'];
const OPERATORS = ['EQUALS', 'DIFFERENT_THAN', 'MORE_THAN', 'LESS_THAN', 'BETWEEN', 'IN', 'STARTS_WITH', 'EMPTY', 'NOT_EMPTY'];
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

function shape(t) {
  return {
    id: t.id, name: t.name, type: t.type, ...(t.type === 'EVENT_STREAM' ? { topic: t.topic } : {}), target: t.target, event: t.event, body: t.body, activated: t.activated,
    trigger: t.trigger, triggerDays: t.trigger_days, subscriptionOption: t.subscription_option,
    filtersLinkingOperator: t.filters_linking_operator, filterConstraints: t.filter_constraints,
    url: t.url, requestType: t.request_type, contentType: t.content_type,
    authorization: { type: t.auth_type, username: t.auth_username || null, passwordSet: Boolean(t.auth_secret) },
    headers: t.headers, signingEnabled: t.signing_enabled,
    state: t.last_sent_at ? 'IN_USE' : 'NOT_IN_USE',
    circuit: t.circuit_open_until ? { openUntil: iso(t.circuit_open_until), consecutiveFailures: t.consecutive_failures } : null,
    creationDate: iso(t.created_at), lastModifiedDate: iso(t.updated_at), lastSentDate: iso(t.last_sent_at),
  };
}

async function row(c, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw err('TEMPLATE_NOT_FOUND', 404);
  const { rows: [t] } = await c.query('SELECT * FROM notification_templates WHERE id = $1', [id]);
  if (!t) throw err('TEMPLATE_NOT_FOUND', 404);
  return t;
}

async function customFieldIds(c) {
  const { rows } = await c.query('SELECT id FROM custom_field_definitions');
  return new Set(rows.map((r) => r.id));
}

function headersOf(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw err('HEADERS_ARE_A_LIST_OF_KEY_AND_VALUE');
  return list.map((h) => {
    const key = String(h?.key || '').trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(key)) throw err(`INVALID_HEADER_NAME: ${key}`);
    if (/^(content-length|host|x-notifications-idempotency-key|x-sacco-signature|authorization)$/i.test(key)) throw err(`HEADER_SET_BY_THE_PLATFORM: ${key}`);
    const value = String(h?.value ?? '');
    if (/[\r\n]/.test(value) || value.length > 2000) throw err(`INVALID_HEADER_VALUE: ${key}`);
    if (/\{\{/.test(value)) throw err(`PLACEHOLDERS_ARE_NOT_ALLOWED_IN_HEADERS: ${key}`);
    return { key, value };
  });
}

function constraintsOf(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw err('FILTER_CONSTRAINTS_ARE_A_LIST');
  return list.map((f) => {
    const field = String(f?.field || f?.dataFieldValue || f?.customFieldId || '').trim();
    const op = String(f?.filterElement || f?.operator || '').toUpperCase();
    if (!field) throw err('FILTER_CONSTRAINT_NEEDS_A_FIELD');
    if (!OPERATORS.includes(op)) throw err(`UNSUPPORTED_FILTER_ELEMENT: ${op}; one of ${OPERATORS.join(', ')}`);
    return { field, filterElement: op, value: f.value ?? null, secondValue: f.secondValue ?? null, values: Array.isArray(f.values) ? f.values.map(String) : null };
  });
}

/** Validate and normalise a whole template (create, or the result of a patch). */
async function normalise(c, b, { current = null } = {}) {
  const name = String(b.name ?? '').trim();
  if (!name) throw err('NAME_REQUIRED');
  if (name.length > 255) throw err('NAME_IS_AT_MOST_255_CHARACTERS');
  const { rows: dup } = await c.query('SELECT 1 FROM notification_templates WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2::uuid', [name, current?.id || null]);
  if (dup.length) throw err(`NAME_ALREADY_USED: ${name}`);
  const type = String(b.type || current?.type || 'WEB_HOOK').toUpperCase();
  if (!['WEB_HOOK', 'EVENT_STREAM'].includes(type)) throw err('TYPE_IS_WEB_HOOK_OR_EVENT_STREAM');
  if (current && type !== current.type) throw err('A_TEMPLATE_KEEPS_ITS_TYPE');
  const stream = type === 'EVENT_STREAM';
  const event = String(b.event || '').toUpperCase();
  if (C.NOT_SUPPORTED.includes(event)) throw err(`EVENT_NOT_SUPPORTED: ${event} has no source on this platform`);
  const targets = C.targetsOf(event);
  if (!targets) throw err(`UNKNOWN_EVENT: ${event}`);
  const target = String(b.target || targets[0]).toUpperCase();
  if (!C.TARGETS.includes(target)) throw err(`UNKNOWN_TARGET: ${target}`);
  if (!targets.includes(target)) throw err(`EVENT_NOT_FOR_TARGET: ${event} is for ${targets.join(' or ')}`);
  const requestType = String(b.requestType || 'POST').toUpperCase();
  if (!REQUEST_TYPES.includes(requestType)) throw err(`INVALID_REQUEST_TYPE: ${requestType}; POST, PUT or PATCH`);
  const contentType = String(b.contentType || 'JSON').toUpperCase();
  if (!CONTENT_TYPES.includes(contentType)) throw err(`INVALID_CONTENT_TYPE: ${contentType}; ${CONTENT_TYPES.join(', ')}`);
  // A streaming template is read by subscribers: it has no address, authorization or signature.
  let url = null;
  if (!stream) {
    if (/["']/.test(String(b.url || ''))) throw err('WEBHOOK_URL_MUST_NOT_CONTAIN_QUOTATION_MARKS');
    if (/\{\{/.test(String(b.url || ''))) throw err('PLACEHOLDERS_ARE_NOT_ALLOWED_IN_THE_WEBHOOK_URL');
    url = OUT.checkUrl(b.url, { prefix: 'WEBHOOK' });
    if (!url) throw err('WEBHOOK_URL_REQUIRED');
  }
  const body = String(b.body ?? '');
  if (!body.trim()) throw err('BODY_REQUIRED');
  if (Buffer.byteLength(body) > 65536) throw err('MAX_MESSAGE_SIZE_LIMIT_EXCEEDED: a body is at most 64 KB');
  const custom = await customFieldIds(c);
  const unknown = R.namesIn(body).filter((n) => !(n in C.PLACEHOLDERS) && !custom.has(n));
  if (unknown.length) throw err(`UNKNOWN_PLACEHOLDER: ${unknown.join(', ')}`);
  const sample = Object.fromEntries([...custom].map((k) => [k, 'sample']));
  R.assertBody(R.fill(body, { ...sample, ...C.PLACEHOLDERS }, contentType), contentType);
  const auth = stream ? {} : b.authorization || {};
  const authType = String(auth.type || 'NONE').toUpperCase();
  if (!['NONE', 'BASIC'].includes(authType)) throw err('AUTHORIZATION_IS_NONE_OR_BASIC');
  const username = authType === 'BASIC' ? String(auth.username || '').trim() : null;
  if (authType === 'BASIC' && !username) throw err('BASIC_AUTHORIZATION_NEEDS_A_USERNAME');
  const password = auth.password !== undefined ? String(auth.password) : undefined;
  if (authType === 'BASIC' && password === undefined && !current?.auth_secret) throw err('BASIC_AUTHORIZATION_NEEDS_A_PASSWORD');
  const trigger = String(b.trigger || 'AUTOMATIC').toUpperCase();
  if (!['AUTOMATIC', 'MANUAL'].includes(trigger)) throw err('TRIGGER_IS_AUTOMATIC_OR_MANUAL');
  const triggerDays = Number(b.triggerDays ?? 0);
  if (!Number.isInteger(triggerDays) || triggerDays < 0 || triggerDays > 365) throw err('TRIGGER_DAYS_IS_0_TO_365');
  const sub = String(b.subscriptionOption || 'OPT_OUT').toUpperCase();
  if (!['OPT_IN', 'OPT_OUT'].includes(sub)) throw err('SUBSCRIPTION_OPTION_IS_OPT_IN_OR_OPT_OUT');
  const link = String(b.filtersLinkingOperator || 'MATCH_ALL').toUpperCase();
  if (!['MATCH_ALL', 'MATCH_ANY'].includes(link)) throw err('FILTERS_LINKING_OPERATOR_IS_MATCH_ALL_OR_MATCH_ANY');
  return {
    name, type, target, event, body, activated: b.activated === undefined ? true : Boolean(b.activated), trigger, triggerDays,
    subscriptionOption: sub, filtersLinkingOperator: link, filterConstraints: constraintsOf(b.filterConstraints),
    url, requestType, contentType, authType, username, password, headers: stream ? [] : headersOf(b.headers),
    signingEnabled: stream ? false : b.signingEnabled === undefined ? true : Boolean(b.signingEnabled),
  };
}

async function list(c, { type = null } = {}) {
  const { rows } = await c.query('SELECT * FROM notification_templates WHERE ($1::text IS NULL OR type = $1) ORDER BY lower(name)',
    [type ? String(type).toUpperCase() : null]);
  return rows.map(shape);
}

const get = async (c, id) => shape(await row(c, id));

/** A streaming template's topic: sacco.event.<tenant>.streamingapi.<name in snake case>, made unique. */
async function topicFor(c, name) {
  const { rows: [t] } = await c.query('SELECT slug FROM platform.tenants WHERE schema_name = current_schema()');
  const base = `sacco.event.${t?.slug || 'tenant'}.streamingapi.${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'events'}`;
  for (let i = 1; ; i += 1) {
    const topic = i === 1 ? base : `${base}_${i}`;
    // A topic is not given again while a subscription reads it or its events are kept.
    const { rows } = await c.query(
      `SELECT 1 FROM notification_templates WHERE topic = $1
       UNION ALL SELECT 1 FROM stream_subscriptions WHERE $1 = ANY (event_types)
       UNION ALL (SELECT 1 FROM stream_events WHERE topic = $1 LIMIT 1)`, [topic]);
    if (!rows.length) return topic;
  }
}

async function create(c, body, { actor }) {
  const v = await normalise(c, body || {});
  const secret = v.signingEnabled ? S.newSigningSecret() : null;
  const topic = v.type === 'EVENT_STREAM' ? await topicFor(c, v.name) : null;
  const { rows: [t] } = await c.query(
    `INSERT INTO notification_templates (name, type, target, event, body, activated, trigger, trigger_days, subscription_option,
       filters_linking_operator, filter_constraints, url, request_type, content_type, auth_type, auth_username, auth_secret, headers,
       signing_enabled, signing_secret, created_by, topic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [v.name, v.type, v.target, v.event, v.body, v.activated, v.trigger, v.triggerDays, v.subscriptionOption, v.filtersLinkingOperator,
      JSON.stringify(v.filterConstraints), v.url, v.requestType, v.contentType, v.authType, v.username,
      v.authType === 'BASIC' ? S.seal(v.password) : null, JSON.stringify(v.headers), v.signingEnabled, S.seal(secret), actor, topic]);
  await recordAudit(c, { actor, action: v.type === 'EVENT_STREAM' ? 'STREAM_TEMPLATE_CREATED' : 'WEBHOOK_CREATED', entity: 'notification_template', entityId: t.id, after: JSON.stringify(shape(t)) });
  return { ...shape(t), ...(secret ? { signingSecret: secret } : {}) };
}

/** JSON Patch on the template's fields (ADD, REPLACE, REMOVE; /headers/- appends). */
function applyPatch(current, ops) {
  if (!Array.isArray(ops)) throw err('A_JSON_PATCH_IS_A_LIST_OF_OPERATIONS');
  const out = JSON.parse(JSON.stringify(current));
  const editable = ['name', 'target', 'event', 'body', 'activated', 'trigger', 'triggerDays', 'subscriptionOption', 'filtersLinkingOperator',
    'filterConstraints', 'url', 'requestType', 'contentType', 'authorization', 'headers', 'signingEnabled'];
  for (const o of ops) {
    const op = String(o?.op || '').toUpperCase();
    if (!['ADD', 'REPLACE', 'REMOVE'].includes(op)) throw err(`UNSUPPORTED_PATCH_OPERATION: ${o?.op}; ADD, REPLACE or REMOVE`);
    const parts = String(o.path || '').replace(/^\//, '').split('/');
    const key = parts[0];
    if (!editable.includes(key)) throw err(`INVALID_PATCH_PATH: ${o.path}`);
    if (parts.length === 1) { out[key] = op === 'REMOVE' ? null : o.value; continue; }
    if (key === 'authorization' && parts.length === 2) { out.authorization = { ...(out.authorization || {}), [parts[1]]: op === 'REMOVE' ? null : o.value }; continue; }
    if (!['headers', 'filterConstraints'].includes(key) || parts.length !== 2) throw err(`INVALID_PATCH_PATH: ${o.path}`);
    const arr = Array.isArray(out[key]) ? out[key] : [];
    if (parts[1] === '-' && op === 'ADD') arr.push(o.value);
    else {
      const i = Number(parts[1]);
      if (!Number.isInteger(i) || i < 0 || i >= arr.length + (op === 'ADD' ? 1 : 0)) throw err(`INVALID_PATCH_PATH: ${o.path}`);
      if (op === 'REMOVE') arr.splice(i, 1); else if (op === 'ADD') arr.splice(i, 0, o.value); else arr[i] = o.value;
    }
    out[key] = arr;
  }
  return out;
}

async function patch(c, id, ops, { actor }) {
  const t = await row(c, id);
  const before = shape(t);
  const next = applyPatch(before, ops);
  // An authorization patched without a password keeps the stored one.
  if (next.authorization) delete next.authorization.passwordSet;
  const v = await normalise(c, next, { current: t });
  const authSecret = v.authType !== 'BASIC' ? null : v.password !== undefined && v.password !== null ? S.seal(v.password) : t.auth_secret;
  let signingSecret = t.signing_secret;
  let shown = null;
  if (v.signingEnabled && !signingSecret) { shown = S.newSigningSecret(); signingSecret = S.seal(shown); }
  const { rows: [after] } = await c.query(
    `UPDATE notification_templates SET name=$2, target=$3, event=$4, body=$5, activated=$6, trigger=$7, trigger_days=$8, subscription_option=$9,
       filters_linking_operator=$10, filter_constraints=$11, url=$12, request_type=$13, content_type=$14, auth_type=$15, auth_username=$16,
       auth_secret=$17, headers=$18, signing_enabled=$19, signing_secret=$20, updated_at=now(),
       consecutive_failures = CASE WHEN url = $12 THEN consecutive_failures ELSE 0 END,
       circuit_open_until = CASE WHEN url = $12 THEN circuit_open_until END
     WHERE id=$1 RETURNING *`,
    [t.id, v.name, v.target, v.event, v.body, v.activated, v.trigger, v.triggerDays, v.subscriptionOption, v.filtersLinkingOperator,
      JSON.stringify(v.filterConstraints), v.url, v.requestType, v.contentType, v.authType, v.username, authSecret, JSON.stringify(v.headers),
      v.signingEnabled, signingSecret]);
  // Queued and waiting messages follow the webhook to its new address.
  if (after.url !== t.url) {
    await c.query(`UPDATE notification_messages SET destination = $2 WHERE template_id = $1 AND state IN ('QUEUED', 'WAITING')`, [t.id, after.url]);
  }
  await recordAudit(c, { actor, action: t.type === 'EVENT_STREAM' ? 'STREAM_TEMPLATE_EDITED' : 'WEBHOOK_EDITED', entity: 'notification_template', entityId: t.id, before: JSON.stringify(before), after: JSON.stringify(shape(after)) });
  return { ...shape(after), ...(shown ? { signingSecret: shown } : {}) };
}

async function remove(c, id, { actor }) {
  const t = await row(c, id);
  await c.query('DELETE FROM notification_templates WHERE id = $1', [t.id]);
  await recordAudit(c, { actor, action: t.type === 'EVENT_STREAM' ? 'STREAM_TEMPLATE_DELETED' : 'WEBHOOK_DELETED', entity: 'notification_template', entityId: t.id, before: JSON.stringify(shape(t)) });
}

async function rotateSecret(c, id, { actor }) {
  const t = await row(c, id);
  if (t.type !== 'WEB_HOOK') throw err('ONLY_A_WEBHOOK_HAS_A_SIGNING_SECRET');
  const secret = S.newSigningSecret();
  const { rows: [after] } = await c.query(
    'UPDATE notification_templates SET signing_secret = $2, signing_enabled = true, updated_at = now() WHERE id = $1 RETURNING *', [t.id, S.seal(secret)]);
  await recordAudit(c, { actor, action: 'WEBHOOK_SECRET_ROTATED', entity: 'notification_template', entityId: t.id });
  return { ...shape(after), signingSecret: secret };
}

module.exports = { list, get, create, patch, remove, rotateSecret, row, shape, OPERATORS };
