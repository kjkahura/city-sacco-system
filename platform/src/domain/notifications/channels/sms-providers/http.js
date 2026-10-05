'use strict';

const { err } = require('../../../../lib/errors');
const OUT = require('../../../../lib/outbound');
const R = require('../../render');

/**
 * The generic HTTPS gateway: most SMS aggregators take a request with the
 * number, the text, a sender ID and an API key in a header, and answer with
 * a message ID. This provider is that request, described by fields:
 *
 *   url              https, a public address (the outbound guard)
 *   method           POST or GET
 *   contentType      JSON or FORM (GET sends the template as the query)
 *   apiKeyHeader     the header the key goes in (Authorization by default)
 *   apiKeyPrefix     text before the key, such as "Bearer "
 *   bodyTemplate     the body with {{to}}, {{text}}, {{from}} and {{id}};
 *                    values are escaped for JSON or form encoding
 *   messageIdPath    where the gateway's message ID is in its JSON answer
 *   successPath, successValue
 *                    a field of the answer that must have this value
 *   dlrIdPath, dlrStatusPath, deliveredValues, undeliveredValues
 *                    how to read the gateway's delivery reports
 *
 * Outcomes: a 2xx answer (with the success value, when set) is sent; 401
 * and 403 are INVALID_SMS_GATEWAY_CREDENTIALS; other 4xx answers are
 * SMS_GATEWAY_ERROR and fail at once; 5xx answers, timeouts and network
 * errors are SMS_GATEWAY_ERROR and are retried.
 */

const name = 'HTTPS gateway';
const description = 'Any SMS gateway with an HTTPS API, described by its address, the body it takes and where it answers with a message ID.';
const fields = [
  { name: 'url', label: 'Gateway URL (https)', required: true },
  { name: 'method', label: 'Method', options: ['POST', 'GET'], default: 'POST' },
  { name: 'contentType', label: 'Body format', options: ['JSON', 'FORM'], default: 'JSON' },
  { name: 'apiKeyHeader', label: 'Header for the API key', default: 'Authorization' },
  { name: 'apiKeyPrefix', label: 'Text before the key, such as "Bearer "' },
  { name: 'apiKey', label: 'API key', secret: true },
  { name: 'bodyTemplate', label: 'Body, with {{to}}, {{text}}, {{from}} and {{id}}', type: 'textarea', required: true,
    default: '{"to": "{{to}}", "message": "{{text}}", "from": "{{from}}", "reference": "{{id}}"}' },
  { name: 'messageIdPath', label: 'Message ID in the answer (a path such as data.id)' },
  { name: 'successPath', label: 'Field that marks success (optional)' },
  { name: 'successValue', label: 'Its value on success' },
  { name: 'dlrIdPath', label: 'Delivery reports: message ID field', default: 'id' },
  { name: 'dlrStatusPath', label: 'Delivery reports: status field', default: 'status' },
  { name: 'deliveredValues', label: 'Delivery reports: statuses meaning delivered, comma separated' },
  { name: 'undeliveredValues', label: 'Delivery reports: statuses meaning not delivered, comma separated' },
];
const KEYS = fields.filter((f) => !f.secret).map((f) => f.name);
const NAMES = new Set(['to', 'text', 'from', 'id']);
const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SAMPLE = { to: '+254700000000', text: 'Sample "text"\nwith a second line & more', from: 'SACCO', id: '00000000-0000-0000-0000-000000000000' };
const timeoutMs = () => Number(process.env.NOTIFY_TIMEOUT_MS || 10_000);

const line = (v, max, code) => {
  const s = String(v ?? '').trim();
  if (/[\r\n]/.test(s) || s.length > max) throw err(code);
  return s;
};
const pathOf = (v, code) => {
  const s = String(v ?? '').trim();
  if (s && !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+|\[\d+\])*$/.test(s)) throw err(code);
  return s || null;
};
const listOf = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50).join(', ');

/** A value at a path such as data.messages[0].id, or undefined. */
function at(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

const formFill = (template, values) => String(template).replace(TOKEN, (_, n) => encodeURIComponent(values[n] ?? ''));

function render(s, values) {
  if (s.method === 'GET' || s.contentType === 'FORM') return formFill(s.bodyTemplate, values);
  return R.fill(s.bodyTemplate, values, 'JSON');
}

function validate(b) {
  const url = OUT.checkUrl(b.url, { prefix: 'SMS_GATEWAY' });
  if (!url) throw err('SMS_GATEWAY_URL_REQUIRED');
  // A fragment is never sent; with GET the query would land after it.
  if (url.includes('#')) throw err('SMS_GATEWAY_URL_MUST_NOT_HAVE_A_FRAGMENT');
  const method = String(b.method || 'POST').toUpperCase();
  if (!['POST', 'GET'].includes(method)) throw err('SMS_GATEWAY_METHOD_IS_POST_OR_GET');
  const contentType = method === 'GET' ? 'FORM' : String(b.contentType || 'JSON').toUpperCase();
  if (!['JSON', 'FORM'].includes(contentType)) throw err('SMS_GATEWAY_BODY_FORMAT_IS_JSON_OR_FORM');
  const apiKeyHeader = String(b.apiKeyHeader || 'Authorization').trim();
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(apiKeyHeader) || /^(host|content-length|content-type)$/i.test(apiKeyHeader)) {
    throw err(`INVALID_API_KEY_HEADER: ${apiKeyHeader}`);
  }
  const apiKeyPrefix = String(b.apiKeyPrefix ?? '');
  if (/[\r\n]/.test(apiKeyPrefix) || apiKeyPrefix.length > 50) throw err('API_KEY_PREFIX_IS_ONE_LINE_OF_AT_MOST_50_CHARACTERS');
  const bodyTemplate = String(b.bodyTemplate ?? '');
  if (!bodyTemplate.trim() || bodyTemplate.length > 4000) throw err('SMS_BODY_TEMPLATE_REQUIRED: at most 4000 characters');
  const used = R.namesIn(bodyTemplate);
  const unknown = used.filter((n) => !NAMES.has(n));
  if (unknown.length) throw err(`SMS_BODY_TEMPLATE_UNKNOWN_PLACEHOLDER: ${unknown.join(', ')}; use {{to}}, {{text}}, {{from}} and {{id}}`);
  if (!used.includes('to') || !used.includes('text')) throw err('SMS_BODY_TEMPLATE_NEEDS_{{to}}_AND_{{text}}');
  const s = {
    url, method, contentType, apiKeyHeader, apiKeyPrefix, bodyTemplate,
    messageIdPath: pathOf(b.messageIdPath, 'INVALID_MESSAGE_ID_PATH'),
    successPath: pathOf(b.successPath, 'INVALID_SUCCESS_PATH'),
    successValue: b.successPath ? line(b.successValue, 200, 'SUCCESS_VALUE_IS_ONE_LINE') : null,
    dlrIdPath: pathOf(b.dlrIdPath, 'INVALID_DELIVERY_REPORT_ID_PATH'),
    dlrStatusPath: pathOf(b.dlrStatusPath, 'INVALID_DELIVERY_REPORT_STATUS_PATH'),
    deliveredValues: listOf(b.deliveredValues), undeliveredValues: listOf(b.undeliveredValues),
  };
  if (contentType === 'JSON') {
    try { JSON.parse(render(s, SAMPLE)); } catch (e) { throw err(`SMS_BODY_TEMPLATE_IS_NOT_JSON_ONCE_FILLED: ${e.message}`); }
  }
  return s;
}

const describe = (s) => Object.fromEntries(KEYS.map((k) => [k, s[k] ?? null]));

/** The gateway a stored key belongs to: its origin and the header it goes in. */
const server = (s) => {
  try { return `${new URL(s.url).origin}|${String(s.apiKeyHeader || '').toLowerCase()}`; } catch { return ''; }
};

async function send(s, secret, { to, text, from, id }) {
  const values = { to, text, from: from || '', id: id || '' };
  let url = s.url;
  let body = render(s, values);
  const headers = { accept: 'application/json' };
  if (s.method === 'GET') {
    url += (url.includes('?') ? '&' : '?') + body;
    body = '';
  } else {
    headers['content-type'] = s.contentType === 'FORM' ? 'application/x-www-form-urlencoded' : 'application/json';
  }
  if (secret) headers[s.apiKeyHeader.toLowerCase()] = `${s.apiKeyPrefix || ''}${secret}`;
  // The gateway's own address is checked; the query a GET adds can be long and is not an address.
  try { OUT.checkUrl(s.url, { prefix: 'SMS_GATEWAY' }); } catch (e) {
    return { ok: false, reason: 'SMS_GATEWAY_ERROR', cause: e.message, permanent: true };
  }
  const out = await OUT.send({ url, method: s.method, headers, body, timeoutMs: timeoutMs(), agent: 'sacco-platform-sms' });
  const answer = String(out.body || '').slice(0, 300);
  if (out.error) {
    const permanent = /PRIVATE/.test(out.error);
    return { ok: false, reason: 'SMS_GATEWAY_ERROR', cause: out.error, permanent };
  }
  if (out.status === 401 || out.status === 403) return { ok: false, reason: 'INVALID_SMS_GATEWAY_CREDENTIALS', cause: `HTTP ${out.status}: ${answer}`, permanent: true };
  if (out.status >= 500) return { ok: false, reason: 'SMS_GATEWAY_ERROR', cause: `HTTP ${out.status}: ${answer}`, permanent: false };
  if (out.status < 200 || out.status >= 300) return { ok: false, reason: 'SMS_GATEWAY_ERROR', cause: `HTTP ${out.status}: ${answer}`, permanent: true };
  let json = null;
  try { json = JSON.parse(out.body || 'null'); } catch { json = null; }
  if (s.successPath) {
    const v = at(json, s.successPath);
    if (String(v ?? '').toLowerCase() !== String(s.successValue ?? '').toLowerCase()) {
      return { ok: false, reason: 'SMS_GATEWAY_ERROR', cause: `HTTP ${out.status}, ${s.successPath} is ${JSON.stringify(v ?? null)}: ${answer}`, permanent: true };
    }
  }
  const mid = s.messageIdPath ? at(json, s.messageIdPath) : null;
  return { ok: true, status: out.status, providerMessageId: mid === null || mid === undefined ? null : String(mid).slice(0, 200) };
}

/** A delivery report (JSON, a form or a query; one report or a list) as [{ providerMessageId, status, detail }]. */
function parseDeliveryReport(s, { body, query }) {
  const items = Array.isArray(body) ? body : [{ ...(query || {}), ...(body && typeof body === 'object' ? body : {}) }];
  const delivered = new Set(String(s.deliveredValues || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const undelivered = new Set(String(s.undeliveredValues || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  return items.slice(0, 1000).map((r) => {
    const id = at(r, s.dlrIdPath || 'id');
    const raw = String(at(r, s.dlrStatusPath || 'status') ?? '');
    const k = raw.toLowerCase();
    return { providerMessageId: id === null || id === undefined ? null : String(id), status: delivered.has(k) ? 'DELIVERED' : undelivered.has(k) ? 'UNDELIVERED' : null, detail: raw.slice(0, 200) };
  }).filter((x) => x.providerMessageId);
}

module.exports = { name, description, fields, validate, describe, server, send, parseDeliveryReport };
