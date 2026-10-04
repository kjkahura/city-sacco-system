'use strict';

const crypto = require('crypto');
const { err } = require('../../lib/errors');
const { recordAudit } = require('../../lib/auditLog');
const SEARCH = require('../../lib/searchCriteria');

/**
 * The communication log (the reference platform's communications/messages):
 * every message with its state, retries and outcome, search, and resend of
 * failed messages. A resend sends the stored body again with a new
 * idempotency key; the retries start over.
 */

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

function shape(m, { full = true } = {}) {
  const out = {
    encodedKey: m.id, type: m.type, state: m.state, event: m.event, destination: m.destination,
    failureReason: m.failure_reason || null, failureCause: m.failure_cause || null, numRetries: m.num_retries,
    creationDate: iso(m.created_at), sendDate: iso(m.sent_at), templateKey: m.template_id, clientKey: m.member_id,
    groupKey: m.group_id, loanAccountKey: m.loan_id, depositAccountKey: m.savings_account_id,
    waitingReason: m.state === 'WAITING' ? m.waiting_reason : null, responseStatus: m.response_status ?? null,
    nextAttemptDate: ['QUEUED', 'WAITING'].includes(m.state) ? iso(m.next_attempt_at) : null, test: m.test,
  };
  if (full) out.body = m.body ?? null;
  return out;
}

const FIELDS = {
  encodedKey: { sql: 'm.id::text', type: 'text' }, creationDate: { sql: 'm.created_at', type: 'timestamp' },
  sendDate: { sql: 'm.sent_at', type: 'timestamp' }, senderKey: { sql: 'm.created_by', type: 'text' },
  clientKey: { sql: 'm.member_id::text', type: 'text' }, groupKey: { sql: 'm.group_id::text', type: 'text' },
  userKey: { sql: 'm.created_by', type: 'text' }, state: { sql: 'm.state', type: 'text' },
  failureReason: { sql: 'm.failure_reason', type: 'text' }, failureCause: { sql: 'm.failure_cause', type: 'text' },
  destination: { sql: 'm.destination', type: 'text' }, type: { sql: 'm.type', type: 'text' }, event: { sql: 'm.event', type: 'text' },
  templateKey: { sql: 'm.template_id::text', type: 'text' }, loanAccountKey: { sql: 'm.loan_id::text', type: 'text' },
  depositAccountKey: { sql: 'm.savings_account_id::text', type: 'text' },
};
// The v1 search's element names.
const V1 = { SENDER_KEY: 'senderKey', RECIPIENT_CLIENT_KEY: 'clientKey', RECIPIENT_GROUP_KEY: 'groupKey', RECIPIENT_USER_KEY: 'userKey',
  ENCODED_KEY: 'encodedKey', CREATION_DATE: 'creationDate', SENT_DATE: 'sendDate', STATE: 'state', FAILURE_REASON: 'failureReason',
  DESTINATION: 'destination', TYPE: 'type', EVENT: 'event' };

async function search(c, { filterCriteria = [], sortingCriteria = null, offset = 0, limit = 50, full = false }) {
  const q = SEARCH.build({ filterCriteria, sortingCriteria }, FIELDS, {});
  const { rows } = await c.query(
    `SELECT m.*, count(*) OVER () AS total FROM notification_messages m WHERE ${q.where}
      ORDER BY ${q.order ? `${q.order}, ` : ''}m.created_at DESC, m.id LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, q.params);
  return { rows: rows.map((m) => shape(m, { full })), total: rows.length ? Number(rows[0].total) : 0 };
}

/** The v1 filterConstraints ({ filterSelection, filterElement, value, secondValue }) as v2 criteria. */
function fromV1(list = []) {
  return (Array.isArray(list) ? list : []).map((f) => ({
    field: V1[String(f.filterSelection || '').toUpperCase()] || f.filterSelection,
    operator: f.filterElement, value: f.value, secondValue: f.secondValue, values: f.values,
  }));
}

async function get(c, key) {
  if (!/^[0-9a-f-]{36}$/i.test(String(key || ''))) throw err('MESSAGE_NOT_FOUND', 404);
  const { rows: [m] } = await c.query('SELECT * FROM notification_messages WHERE id = $1', [key]);
  if (!m) throw err('MESSAGE_NOT_FOUND', 404);
  return m;
}

/** Put failed messages back in the queue with a new idempotency key. Returns their keys. */
async function resend(c, keys, { actor }) {
  if (!Array.isArray(keys) || !keys.length) throw err('MESSAGES_REQUIRED: a list of message keys');
  if (new Set(keys).size !== keys.length) throw err('DUPLICATE_MESSAGE_KEYS');
  if (keys.length > 1000) throw err('AT_MOST_1000_MESSAGES_AT_ONCE');
  if (keys.some((k) => !/^[0-9a-f-]{36}$/i.test(String(k)))) throw err('NO_MESSAGE_FOUND', 404);
  const { rows } = await c.query('SELECT id, state, body FROM notification_messages WHERE id = ANY($1::uuid[])', [keys]);
  if (rows.length !== keys.length) throw err('NO_MESSAGE_FOUND: no matching messages were found', 404);
  const notFailed = rows.filter((m) => m.state !== 'FAILED');
  if (notFailed.length) throw err(`ONLY_FAILED_MESSAGES_ARE_RESENT: ${notFailed.map((m) => m.id).join(', ')}`);
  const cleared = rows.filter((m) => m.body === null);
  if (cleared.length) throw err(`MESSAGE_BODY_NO_LONGER_KEPT: ${cleared.map((m) => m.id).join(', ')}`);
  await c.query(
    `UPDATE notification_messages SET state = 'QUEUED', waiting_reason = NULL, num_retries = 0, first_attempt_at = NULL,
       next_attempt_at = now(), idempotency_key = $2::uuid, failure_reason = NULL, failure_cause = NULL WHERE id = ANY($1::uuid[])`,
    [keys, crypto.randomUUID()]);
  // Each message its own key: one statement gave them all the same, so set each.
  for (const k of keys) await c.query('UPDATE notification_messages SET idempotency_key = gen_random_uuid() WHERE id = $1', [k]);
  await recordAudit(c, { actor, action: 'MESSAGES_RESENT', entity: 'notification_message', after: JSON.stringify({ messages: keys }) });
  return keys;
}

async function resendByDate(c, { startDate, endDate, templateTypes }, { actor }) {
  if (!startDate || !endDate) throw err('START_AND_END_DATE_REQUIRED');
  const types = Array.isArray(templateTypes) && templateTypes.length ? templateTypes.map(String) : ['WEB_HOOK'];
  const { rows } = await c.query(
    `SELECT id FROM notification_messages WHERE state = 'FAILED' AND body IS NOT NULL AND type = ANY($3::text[])
      AND created_at >= $1::timestamptz AND created_at <= $2::timestamptz`, [startDate, endDate, types]);
  if (!rows.length) return [];
  return resend(c, rows.map((r) => r.id), { actor });
}

async function settings(c) {
  const { rows: [s] } = await c.query('SELECT webhook_state FROM notification_settings WHERE id');
  return { state: s?.webhook_state || 'ENABLED' };
}

async function setSettings(c, body, { actor }) {
  const state = String(body?.state || '').toUpperCase();
  if (!['ENABLED', 'DISABLED'].includes(state)) throw err('STATE_IS_ENABLED_OR_DISABLED');
  await c.query('UPDATE notification_settings SET webhook_state = $1, updated_by = $2, updated_at = now() WHERE id', [state, actor]);
  await recordAudit(c, { actor, action: 'WEBHOOK_NOTIFICATIONS_SET', entity: 'notification_settings', after: JSON.stringify({ state }) });
  return { state };
}

module.exports = { shape, search, fromV1, get, resend, resendByDate, settings, setSettings };
