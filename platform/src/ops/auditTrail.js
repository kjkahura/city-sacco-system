'use strict';

const { pool } = require('../db/pool');

/**
 * The audit trail (the reference platform's Audit Trail): every request to a tenant's API
 * by its staff or its API consumers, with who, from where, what and the
 * answer's status. The request body is kept with passwords, secrets and
 * personal details taken out, as the reference platform does; files are not kept.
 *
 * GET /api/audit-trail/events takes the reference platform's filters: FIELD[operator]=value
 * (eq, ne, gt, gte, lt, lte, startsWith, in, contains), from, size (from +
 * size at most 10,000), sort_by and sort_order.
 */

const SCHEMA_RE = /^tenant_[a-z][a-z0-9_]{2,40}$/;
const SECRET = /pass|secret|token|apikey|api_key|pin|code|otp/i;
const PERSONAL = /phone|mobile|email|address|birth|firstname|lastname|middlename|first_name|last_name|middle_name|fullname|full_name|^name$|notes|description|title|text|iban|national|gender|postcode|post_code|country|region|city|latitude|longitude/i;

function scrub(v, depth = 0) {
  if (depth > 6) return '...';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET.test(k) || PERSONAL.test(k) ? '***' : scrub(x, depth + 1);
    return out;
  }
  return v;
}

function payloadOf(req) {
  const type = String(req.get('content-type') || '');
  if (!type.includes('json') || !req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) return null;
  if (!Object.keys(req.body).length) return null;
  const s = JSON.stringify(scrub(req.body));
  return s.length > 4000 ? `${s.slice(0, 4000)}...` : s;
}

/** Record each tenant request after it is answered. The portal is not staff and is left out. */
function recorder() {
  return (req, res, next) => {
    if (!req.tenant || req.path.startsWith('/portal/') || req.method === 'OPTIONS') return next();
    const started = Date.now();
    // Taken now: the routers below rewrite req.url while they route.
    const path = req.path;
    const fragment = req.originalUrl.split('?')[0];
    res.on('finish', () => {
      const schema = req.tenant.schema_name;
      if (!SCHEMA_RE.test(schema)) return;
      const api = Boolean(req.auth?.apiConsumer || req.get('apikey'));
      const seg = path.split('/').filter(Boolean);
      const username = req.auth?.email || (path.startsWith('/auth/') ? String(req.body?.email || '').toLowerCase() || null : null);
      pool.query(
        `INSERT INTO "${schema}".audit_events (event_source, request_method, request_uri, resource, resource_fragment, username, client_ip,
           user_agent, response_code, request_payload, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [api ? 'API' : 'UI', req.method, `/api${path}`, seg[0] || null, fragment, username, req.ip,
          req.get('user-agent') || null, res.statusCode, payloadOf(req), Date.now() - started]).catch(() => {});
    });
    return next();
  };
}

const FIELDS = {
  event_source: { col: 'event_source', ops: ['eq', 'ne', 'in'] },
  request_uri: { col: 'request_uri', ops: ['eq', 'ne', 'startsWith', 'in', 'contains'] },
  request_method: { col: 'request_method', ops: ['eq', 'ne', 'in'] },
  request_payload: { col: 'request_payload', ops: ['eq', 'ne', 'startsWith', 'in', 'contains'] },
  user_agent: { col: 'user_agent', ops: ['eq', 'ne', 'startsWith', 'in', 'contains'] },
  resource: { col: 'resource', ops: ['eq', 'ne', 'startsWith', 'in', 'contains'] },
  resource_fragment: { col: 'resource_fragment', ops: ['eq', 'ne', 'startsWith', 'in', 'contains'] },
  username: { col: 'username', ops: ['eq', 'ne', 'startsWith', 'in', 'contains'] },
  client_ip: { col: 'client_ip', ops: ['eq', 'ne', 'startsWith', 'in'] },
  response_code: { col: 'response_code', ops: ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte'], num: true },
  occurred_at: { col: 'occurred_at', ops: ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte'], time: true },
};
const SQL_OP = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const err = (m, status = 400) => Object.assign(new Error(m), { status });

/** The reference platform's audit trail query, over this tenant's events. */
async function events(c, query = {}) {
  const where = [];
  const vals = [];
  const p = (v) => { vals.push(v); return `$${vals.length}`; };
  for (const [key, raw] of Object.entries(query)) {
    const m = key.match(/^([a-z_]+)\[([A-Za-z]+)\]$/);
    if (!m) continue;
    const f = FIELDS[m[1]];
    if (!f) throw err(`UNKNOWN_FIELD: ${m[1]} (one of ${Object.keys(FIELDS).join(', ')})`);
    const op = m[2];
    if (!f.ops.includes(op)) throw err(`OPERATOR_${op}_NOT_SUPPORTED_ON_${m[1]}`);
    const cast = f.num ? '::int' : f.time ? '::timestamptz' : '';
    const val = Array.isArray(raw) ? raw[raw.length - 1] : String(raw);
    if (op === 'in') where.push(`${f.col} = ANY(${p(val.split(',').map((x) => x.trim()))}${f.num ? '::int[]' : f.time ? '::timestamptz[]' : '::text[]'})`);
    else if (op === 'startsWith') where.push(`${f.col} LIKE ${p(`${val.replace(/[\\%_]/g, '\\$&')}%`)}`);
    else if (op === 'contains') {
      // The reference platform: "key":"value" elements, comma delimited, in any order; plain text otherwise.
      const parts = val.match(/"[^"]*"\s*:\s*("[^"]*"|[^,]+)/g) || [val];
      for (const part of parts) where.push(`${f.col} LIKE ${p(`%${part.replace(/\s*:\s*/, ':').replace(/[\\%_]/g, '\\$&')}%`)}`);
    } else where.push(`${f.col} ${SQL_OP[op]} ${p(val)}${cast}`);
  }
  const from = Math.max(0, Number(query.from) || 0);
  const size = query.size === undefined ? 100 : Math.max(1, Number(query.size) || 100);
  if (from > 10000 || size > 10000 || from + size > 10000) {
    throw err(`From (${from}) and size (${size}) combination exceed 10000, the maximum allowed window. Default size is 100`);
  }
  const sortBy = query.sort_by ? String(query.sort_by) : 'occurred_at';
  if (!FIELDS[sortBy]) throw err(`UNKNOWN_SORT_FIELD: ${sortBy}`);
  const order = String(query.sort_order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM audit_events ${cond}`, vals);
  const { rows } = await c.query(
    `SELECT occurred_at, response_code, resource, event_source, client_ip, request_method, request_payload, resource_fragment, request_uri,
            user_agent, username FROM audit_events ${cond} ORDER BY ${FIELDS[sortBy].col} ${order}, id ${order} OFFSET ${from} LIMIT ${size}`, vals);
  return { events: rows, from, size, totalItemsCount: n };
}

/** Drop events past the tenant's retention (an end of day job). */
async function prune(c, days) {
  const { rowCount } = await c.query("DELETE FROM audit_events WHERE occurred_at < now() - make_interval(days => $1::int)", [days]);
  return { pruned: rowCount };
}

module.exports = { recorder, events, prune, scrub };
