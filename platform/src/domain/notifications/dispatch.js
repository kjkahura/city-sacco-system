'use strict';

const crypto = require('crypto');
const { withTenant } = require('../../db/tenantContext');
const { orgToday } = require('../../lib/orgDate');
const OUT = require('../../lib/outbound');
const C = require('./catalog');
const R = require('./render');
const S = require('./secrets');
const CTX = require('./context');

/**
 * Turning events into messages and delivering them.
 *
 * runTenant(schema) does one pass:
 *   1. events not yet processed become messages, one per activated template
 *      whose conditions they meet, with the body filled in;
 *   2. messages that are due are claimed (SKIP LOCKED, with a lease, so two
 *      dispatchers never send the same one) and sent outside any database
 *      transaction, then their outcome is recorded;
 *   3. once a day: repayment reminders, and clearing old bodies.
 *
 * Only a 2xx answer is delivered. Anything else, a timeout or a network
 * error is retried 1, 5, 15 and 60 minutes, then 3, 6, 12, 18 and 24 hours
 * after the first try (9 retries), then FAILED; a failed message can be
 * resent. After 20 failures in a row a template's circuit opens: its
 * messages wait, one is tried every 10 minutes, and a success closes it.
 */

const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1080, 1440];
const CIRCUIT_AFTER = 20;
const CIRCUIT_MINUTES = 10;
const BATCH = 50;
const LEASE_SECONDS = 120;
const MAX_BODY = 65536;
const KEEP_BODY_DAYS = 180;
const timeoutMs = () => Number(process.env.NOTIFY_TIMEOUT_MS || 10_000);

// --- conditions --------------------------------------------------------------

function meets(t, values) {
  const list = t.filter_constraints || [];
  if (!list.length) return true;
  const test = (f) => {
    const raw = values[f.field] ?? values[String(f.field).toUpperCase()];
    const v = raw === null || raw === undefined ? '' : String(raw);
    const num = (x) => Number(x);
    switch (f.filterElement) {
      case 'EQUALS': return v.toLowerCase() === String(f.value ?? '').toLowerCase();
      case 'DIFFERENT_THAN': return v.toLowerCase() !== String(f.value ?? '').toLowerCase();
      case 'MORE_THAN': return v !== '' && num(v) > num(f.value);
      case 'LESS_THAN': return v !== '' && num(v) < num(f.value);
      case 'BETWEEN': return v !== '' && num(v) >= num(f.value) && num(v) <= num(f.secondValue);
      case 'IN': return (f.values || String(f.value || '').split(',')).map((x) => String(x).trim().toLowerCase()).includes(v.toLowerCase());
      case 'STARTS_WITH': return v.toLowerCase().startsWith(String(f.value ?? '').toLowerCase());
      case 'EMPTY': return v === '';
      case 'NOT_EMPTY': return v !== '';
      default: return false;
    }
  };
  return t.filters_linking_operator === 'MATCH_ANY' ? list.some(test) : list.every(test);
}

// --- 1. events into messages ----------------------------------------------------

async function queueFor(c, t, e, values, { test = false, actor = null } = {}) {
  let body;
  let failure = null;
  try {
    body = R.fill(t.body, values, t.content_type);
    R.assertBody(body, t.content_type);
  } catch (x) {
    failure = ['INVALID_JSON_BODY_SYNTAX', x.message];
    if (t.content_type === 'XML') failure[0] = 'OTHER';
  }
  if (!failure && Buffer.byteLength(body) > MAX_BODY) failure = ['MAX_MESSAGE_SIZE_LIMIT_EXCEEDED', `${Buffer.byteLength(body)} bytes`];
  const group = values.GROUP_NAME ? e.member_id : null;
  const { rows: [m] } = await c.query(
    `INSERT INTO notification_messages (template_id, event_id, type, event, state, failure_reason, failure_cause, destination, request_type,
       content_type, body, member_id, group_id, loan_id, savings_account_id, test, created_by)
     VALUES ($1,$2,'WEB_HOOK',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [t.id, e.id || null, e.event, failure ? 'FAILED' : 'QUEUED', failure?.[0] || null, failure?.[1] || null, t.url, t.request_type,
      t.content_type, body ?? t.body, group ? null : e.member_id, group, e.loan_id, e.savings_account_id, test, actor]);
  return m;
}

function wants(t, e) {
  // Only an event with more than one target (ACCOUNT_IN_ARREARS: loans or deposits) is matched on the target too.
  const targets = C.targetsOf(e.event) || [];
  return t.event === e.event && (targets.length < 2 || e.event !== 'ACCOUNT_IN_ARREARS' || t.target === e.target);
}

async function processEvents(c, limit = 500) {
  const { rows: events } = await c.query(
    'SELECT * FROM notification_events WHERE processed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED', [limit]);
  if (!events.length) return 0;
  const { rows: templates } = await c.query("SELECT * FROM notification_templates WHERE activated AND trigger = 'AUTOMATIC'");
  let queued = 0;
  for (const e of events) {
    const matching = templates.filter((t) => wants(t, e));
    if (matching.length) {
      const values = await CTX.build(c, e);
      for (const t of matching) {
        if (!meets(t, values)) continue;
        await queueFor(c, t, e, values);
        queued += 1;
      }
    }
    await c.query('UPDATE notification_events SET processed_at = now() WHERE id = $1', [e.id]);
  }
  return queued;
}

// --- 2. sending -------------------------------------------------------------------

function requestOf(m, t) {
  const headers = {
    'content-type': { JSON: 'application/json', XML: 'application/xml' }[m.content_type] || 'text/plain; charset=utf-8',
    'x-notifications-idempotency-key': m.idempotency_key,
  };
  for (const h of t?.headers || []) headers[h.key.toLowerCase()] = h.value;
  const body = m.body ?? '';
  if (t?.signing_enabled && t.signing_secret) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', S.open(t.signing_secret)).update(`${ts}.${body}`).digest('hex');
    headers['x-sacco-signature'] = `t=${ts},v1=${sig}`;
  }
  if (t?.auth_type === 'BASIC') {
    headers.authorization = `Basic ${Buffer.from(`${t.auth_username}:${S.open(t.auth_secret) || ''}`).toString('base64')}`;
  }
  return { url: m.destination, method: m.request_type || 'POST', headers, body, timeoutMs: timeoutMs(), agent: 'sacco-platform-webhooks' };
}

/** Claim what is due: messages of closed circuits, and one probe for a circuit whose wait is over. */
async function claim(c, onlyIds = null) {
  // Messages of a template whose circuit is open wait, with the reason shown.
  await c.query(
    `UPDATE notification_messages m SET state = 'WAITING', waiting_reason = 'WAIT_FOR_CLOSE_CIRCUIT'
       FROM notification_templates t
      WHERE m.template_id = t.id AND m.state = 'QUEUED' AND t.circuit_open_until > now()`);
  const { rows } = await c.query(
    `WITH due AS (
       SELECT m.id, m.template_id, t.circuit_open_until,
              row_number() OVER (PARTITION BY m.template_id ORDER BY m.next_attempt_at, m.created_at) AS n
         FROM notification_messages m LEFT JOIN notification_templates t ON t.id = m.template_id
        WHERE ($1::uuid[] IS NOT NULL AND m.id = ANY($1::uuid[]))
           OR ($1::uuid[] IS NULL AND m.next_attempt_at <= now()
               AND (m.state = 'QUEUED' OR (m.state = 'WAITING' AND m.waiting_reason IN ('READY_TO_BE_SENT', 'WAIT_FOR_CLOSE_CIRCUIT', 'SENDING'))))
     ), pick AS (
       SELECT id FROM due
        WHERE circuit_open_until IS NULL OR (circuit_open_until <= now() AND n = 1)
        ORDER BY id LIMIT $2
     )
     UPDATE notification_messages m SET state = 'WAITING', waiting_reason = 'SENDING', next_attempt_at = now() + make_interval(secs => $3)
       FROM (SELECT id FROM notification_messages WHERE id IN (SELECT id FROM pick) FOR UPDATE SKIP LOCKED) p
      WHERE m.id = p.id
      RETURNING m.*`, [onlyIds, BATCH, LEASE_SECONDS]);
  return rows;
}

function failureOf(out) {
  if (out.error) {
    if (/PRIVATE_ADDRESS|EPRIVATE/.test(out.error)) return ['BLACKLISTED_URL', out.error];
    return ['HTTP_ERROR_WHILE_SENDING', out.error];
  }
  return ['INVALID_HTTP_RESPONSE', `HTTP ${out.status}: ${String(out.body || '').slice(0, 500)}`];
}

async function record(c, m, out) {
  const ok = !out.error && out.status >= 200 && out.status < 300;
  if (ok) {
    await c.query(
      `UPDATE notification_messages SET state = 'SENT', waiting_reason = NULL, sent_at = now(), response_status = $2,
         first_attempt_at = COALESCE(first_attempt_at, now()), failure_reason = NULL, failure_cause = NULL WHERE id = $1`, [m.id, out.status]);
    if (m.template_id) {
      await c.query(`UPDATE notification_templates SET last_sent_at = now(), consecutive_failures = 0, circuit_open_until = NULL WHERE id = $1`, [m.template_id]);
      // The circuit closed: what waited for it is sent from the next pass.
      await c.query(`UPDATE notification_messages SET state = 'QUEUED', waiting_reason = NULL
                      WHERE template_id = $1 AND state = 'WAITING' AND waiting_reason = 'WAIT_FOR_CLOSE_CIRCUIT'`, [m.template_id]);
    }
    return 'SENT';
  }
  const [reason, cause] = failureOf(out);
  const retries = m.num_retries + 1;
  const first = m.first_attempt_at ? new Date(m.first_attempt_at) : new Date();
  const final = retries > RETRY_MINUTES.length || m.test;
  const next = final ? null : new Date(first.getTime() + RETRY_MINUTES[retries - 1] * 60_000);
  await c.query(
    `UPDATE notification_messages SET state = $2, waiting_reason = NULL, num_retries = $3, failure_reason = $4, failure_cause = $5,
       response_status = $6, first_attempt_at = $7, next_attempt_at = COALESCE($8, next_attempt_at) WHERE id = $1`,
    [m.id, final ? 'FAILED' : 'QUEUED', retries, reason, cause, out.status || null, first, next]);
  if (m.template_id && !m.test) {
    await c.query(
      `UPDATE notification_templates SET consecutive_failures = consecutive_failures + 1,
         circuit_open_until = CASE WHEN consecutive_failures + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE circuit_open_until END
       WHERE id = $1`, [m.template_id, CIRCUIT_AFTER, CIRCUIT_MINUTES]);
  }
  return final ? 'FAILED' : 'QUEUED';
}

async function sendClaimed(schema, claimed) {
  const outcomes = [];
  for (const m of claimed) {
    const ctx = await withTenant(schema, async (c) => {
      const { rows: [t] } = m.template_id ? await c.query('SELECT * FROM notification_templates WHERE id = $1', [m.template_id]) : { rows: [] };
      const { rows: [s] } = await c.query('SELECT webhook_state FROM notification_settings WHERE id');
      return { t, disabled: s?.webhook_state === 'DISABLED' };
    });
    if (ctx.disabled) {
      await withTenant(schema, (c) => c.query(
        `UPDATE notification_messages SET state = 'FAILED', waiting_reason = NULL, failure_reason = 'WEBHOOK_NOTIFICATIONS_DISABLED',
           failure_cause = 'Webhooks are switched off for this SACCO' WHERE id = $1`, [m.id]));
      outcomes.push({ id: m.id, state: 'FAILED' });
      continue;
    }
    let out;
    try {
      OUT.checkUrl(m.destination, { prefix: 'WEBHOOK' });
      out = await OUT.send(requestOf(m, ctx.t));
    } catch (e) {
      out = { error: /MUST_BE_PUBLIC|PRIVATE/.test(e.message) ? `EPRIVATE ${e.message}` : e.message };
    }
    const state = await withTenant(schema, (c) => record(c, m, out));
    outcomes.push({ id: m.id, state, status: out.status || null, error: out.error || null });
  }
  return outcomes;
}

// --- 3. daily work -----------------------------------------------------------------

async function reminders(c) {
  const today = await orgToday(c);
  const { rows: [s] } = await c.query('SELECT last_reminder_day FROM notification_settings WHERE id FOR UPDATE');
  const last = s?.last_reminder_day ? new Date(s.last_reminder_day).toISOString().slice(0, 10) : null;
  if (last === today) return 0;
  await c.query('UPDATE notification_settings SET last_reminder_day = $1 WHERE id', [today]);
  const { rows: tpls } = await c.query("SELECT * FROM notification_templates WHERE activated AND event = 'REPAYMENT_REMINDER'");
  let n = 0;
  for (const t of tpls) {
    const { rows } = await c.query(
      `SELECT i.number, l.id AS loan_id, l.member_id, l.branch_id FROM loan_installments i JOIN loan_accounts l ON l.id = i.loan_id
        WHERE i.due_date = $1::date + $2::int AND i.status <> 'PAID' AND l.status IN ('ACTIVE', 'IN_ARREARS')`, [today, t.trigger_days]);
    for (const r of rows) {
      const e = { event: 'REPAYMENT_REMINDER', target: 'LOANS', member_id: r.member_id, loan_id: r.loan_id, branch_id: r.branch_id,
        data: { installmentNumber: r.number } };
      const values = await CTX.build(c, e);
      if (!meets(t, values)) continue;
      await queueFor(c, t, e, values);
      n += 1;
    }
  }
  return n;
}

async function purge(c) {
  const today = await orgToday(c);
  const { rows: [s] } = await c.query('SELECT last_purge_day FROM notification_settings WHERE id FOR UPDATE');
  if (s?.last_purge_day && new Date(s.last_purge_day).toISOString().slice(0, 10) === today) return 0;
  await c.query('UPDATE notification_settings SET last_purge_day = $1 WHERE id', [today]);
  const { rowCount } = await c.query(
    `UPDATE notification_messages SET body = NULL, body_cleared_at = now()
      WHERE body IS NOT NULL AND created_at < now() - make_interval(days => $1) AND state IN ('SENT', 'FAILED')`, [KEEP_BODY_DAYS]);
  await c.query(`DELETE FROM notification_events WHERE processed_at < now() - interval '30 days'`);
  return rowCount;
}

// --- one pass --------------------------------------------------------------------

async function runTenant(schema, { onlyIds = null } = {}) {
  const queued = await withTenant(schema, async (c) => {
    const n = await processEvents(c);
    const r = await reminders(c);
    await purge(c);
    return n + r;
  });
  const claimed = await withTenant(schema, (c) => claim(c, onlyIds));
  const sent = await sendClaimed(schema, claimed);
  return { queued, sent };
}

/** Every active tenant with a webhook (for the job and the scheduler). */
async function runAll({ log = () => {} } = {}) {
  const { pool } = require('../../db/pool');
  const { rows } = await pool.query("SELECT slug, schema_name FROM platform.tenants WHERE status = 'ACTIVE' ORDER BY slug");
  const out = [];
  for (const t of rows) {
    try {
      const has = await withTenant(t.schema_name, async (c) => (await c.query(
        "SELECT EXISTS (SELECT 1 FROM notification_templates) OR EXISTS (SELECT 1 FROM notification_messages WHERE state IN ('QUEUED', 'WAITING')) AS any")).rows[0].any)
        .catch(() => false);
      if (!has) continue;
      const r = await runTenant(t.schema_name);
      out.push({ tenant: t.slug, queued: r.queued, sent: r.sent.length });
      log(`  ok   ${t.slug} queued ${r.queued}, attempted ${r.sent.length}`);
    } catch (e) {
      out.push({ tenant: t.slug, error: e.message });
      log(`  FAIL ${t.slug}: ${e.message}`);
    }
  }
  return out;
}

// After a request that changed something, a pass for that tenant, a moment
// later and one at a time per tenant. The job and the scheduler catch up with
// anything this misses (a container stopped, a slow receiver).
const pending = new Map();
function afterRequest(schema) {
  if (process.env.NOTIFY_AFTER_REQUEST === 'off' || pending.has(schema)) return;
  pending.set(schema, setTimeout(async () => {
    try {
      const any = await withTenant(schema, async (c) => (await c.query(
        'SELECT EXISTS (SELECT 1 FROM notification_events WHERE processed_at IS NULL) AS any')).rows[0].any);
      if (any) await runTenant(schema);
    } catch { /* the job retries */ } finally {
      pending.delete(schema);
    }
  }, 150));
}

/** A template's sample message, sent now: what a receiver would get, with the platform's sample values. */
async function testTemplate(schema, id, { actor }) {
  const m = await withTenant(schema, async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM notification_templates WHERE id = $1', [id]);
    if (!t) throw Object.assign(new Error('TEMPLATE_NOT_FOUND'), { status: 404 });
    const custom = Object.fromEntries((await c.query('SELECT id FROM custom_field_definitions')).rows.map((r) => [r.id, 'sample']));
    return queueFor(c, t, { event: t.event }, { ...custom, ...C.PLACEHOLDERS, EVENT: t.event }, { test: true, actor });
  });
  if (m.state === 'QUEUED') {
    const claimed = await withTenant(schema, (c) => claim(c, [m.id]));
    await sendClaimed(schema, claimed);
  }
  return withTenant(schema, async (c) => (await c.query('SELECT * FROM notification_messages WHERE id = $1', [m.id])).rows[0]);
}

module.exports = { runTenant, runAll, afterRequest, testTemplate, meets, RETRY_MINUTES };
