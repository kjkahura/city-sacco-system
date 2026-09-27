#!/usr/bin/env node
'use strict';

/**
 * tap-sacco: a Singer tap for the platform's incremental extract.
 *
 * Stitch (and any Singer target: target-postgres, target-bigquery,
 * target-snowflake, target-csv) loads data from a tap that writes Singer
 * messages to stdout. This one reads /api/extract, so a SACCO can keep a
 * warehouse copy of its data current without anyone writing code:
 *
 *   node bin/tap-sacco.js --config config.json --discover > catalog.json
 *   node bin/tap-sacco.js --config config.json --catalog catalog.json --state state.json \
 *     | target-stitch --config stitch.json > state-out.json
 *
 * config.json:
 *   {
 *     "api_url":  "https://citysacco.core.example.com",
 *     "tenant":   "citysacco",
 *     "email":    "warehouse@citysacco.example",
 *     "password": "...",
 *     "page_size": 500
 *   }
 *
 * Use a dedicated user with the AUDITOR role: it can read the extract and
 * nothing else, and it is not one of the roles that must use a second factor
 * by default (a tap cannot type a code). The tap signs in at the start of
 * every run.
 *
 * Messages: SCHEMA for each selected stream (JSON Schema from the data
 * dictionary, key properties from the primary key), RECORD for each row,
 * and STATE after each page with the extract cursor per stream under
 * bookmarks, so a run that stops is resumed where it stopped. With no
 * catalog every stream is synced; with a catalog, the streams whose
 * top-level metadata has "selected": true.
 */

const fs = require('fs');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--discover') out.discover = true;
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

const readJson = (p) => (p ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

async function tap(argv, { stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch } = {}) {
  const a = args(argv);
  const config = readJson(a.config);
  if (!config) throw new Error('--config is required');
  for (const k of ['api_url', 'tenant', 'email', 'password']) if (!config[k]) throw new Error(`config.${k} is required`);
  const base = String(config.api_url).replace(/\/+$/, '');
  const log = (m) => stderr.write(`INFO ${m}\n`);
  const emit = (msg) => stdout.write(`${JSON.stringify(msg)}\n`);

  async function call(path, { method = 'GET', body, token } = {}) {
    const headers = { 'x-tenant': config.tenant, accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    const r = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch { d = null; }
    if (!r.ok) {
      const reason = d?.errors?.[0]?.errorReason || text.slice(0, 200);
      throw new Error(`${method} ${path}: ${r.status} ${reason}`);
    }
    return d;
  }

  const login = await call('/api/auth/login', { method: 'POST', body: { email: config.email, password: config.password } })
    .catch((e) => {
      if (/MFA_ENROLMENT_REQUIRED|PASSWORD_CHANGE_REQUIRED/.test(e.message)) {
        throw new Error(`${e.message}. Use a user that has changed its temporary password and is not required to use a second factor (the AUDITOR role).`);
      }
      throw e;
    });
  if (login.mfaRequired) throw new Error('The tap user has a second factor switched on; use a user without one (the AUDITOR role).');
  const token = login.accessToken;

  const streams = await call('/api/extract', { token });

  if (a.discover) {
    emit({
      streams: streams.map((s) => ({
        tap_stream_id: s.stream,
        stream: s.stream,
        key_properties: s.keyProperties,
        schema: s.schema,
        replication_method: 'INCREMENTAL',
        replication_key: s.replicationKey.includes('.') ? undefined : s.replicationKey,
        metadata: [
          {
            breadcrumb: [],
            metadata: {
              selected: true,
              'table-key-properties': s.keyProperties,
              'forced-replication-method': 'INCREMENTAL',
              'valid-replication-keys': [s.replicationKey],
              inclusion: 'available',
            },
          },
          ...Object.keys(s.schema.properties).map((p) => ({
            breadcrumb: ['properties', p],
            metadata: { inclusion: s.keyProperties.includes(p) ? 'automatic' : 'available' },
          })),
        ],
      })),
    });
    return { discovered: streams.length };
  }

  const catalog = readJson(a.catalog || a.properties);
  let selected = streams.map((s) => s.stream);
  if (catalog) {
    selected = catalog.streams
      .filter((s) => (s.metadata || []).some((m) => (m.breadcrumb || []).length === 0 && m.metadata?.selected))
      .map((s) => s.tap_stream_id || s.stream);
  }
  const state = readJson(a.state) || {};
  state.bookmarks = state.bookmarks || {};
  const pageSize = Math.min(1000, Number(config.page_size) || 500);
  const counts = {};

  for (const s of streams.filter((x) => selected.includes(x.stream))) {
    const bookmarkProps = s.replicationKey.includes('.') ? [] : [s.replicationKey];
    emit({ type: 'SCHEMA', stream: s.stream, schema: s.schema, key_properties: s.keyProperties, bookmark_properties: bookmarkProps });
    let cursor = state.bookmarks[s.stream]?.cursor || null;
    counts[s.stream] = 0;
    for (;;) {
      const q = new URLSearchParams({ limit: String(pageSize) });
      if (cursor) q.set('cursor', cursor);
      else if (config.start_date) q.set('since', config.start_date);
      const page = await call(`/api/extract/${encodeURIComponent(s.stream)}?${q}`, { token });
      const at = new Date().toISOString();
      for (const record of page.items) emit({ type: 'RECORD', stream: s.stream, record, time_extracted: at });
      counts[s.stream] += page.items.length;
      if (page.nextCursor) {
        cursor = page.nextCursor;
        state.bookmarks[s.stream] = { cursor };
        emit({ type: 'STATE', value: state });
      }
      if (!page.hasMore) break;
    }
    log(`${s.stream}: ${counts[s.stream]} records`);
  }
  emit({ type: 'STATE', value: state });
  return { counts, state };
}

if (require.main === module) {
  tap(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`CRITICAL ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { tap };
