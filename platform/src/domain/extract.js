'use strict';

const DD = require('./dataDictionary');

/**
 * The incremental extract: rows changed since a cursor, table by table, for
 * a data warehouse or an ETL service (Stitch, through bin/tap-sacco.js)
 * to keep a copy current without downloading everything each time. This is
 * the platform's counterpart of what the reference platform offers through its Streaming API
 * and scheduled backups from a date.
 *
 * Each stream is read in order of a timestamp and the row's key, and the
 * cursor is the pair from the last row returned: the next call asks for
 * rows after it, and nothing is skipped or returned twice even when many
 * rows share a timestamp. Mutable tables are read on updated_at, which a
 * trigger sets on every change (migration 028), so no code path can change
 * a row without the extract seeing it. Append-only tables are read on
 * created_at, and journal lines on the time of their entry.
 *
 * The one hazard of a timestamp cursor is a transaction that stamps a row
 * and commits later: a reader in between could move its cursor past the
 * row before it is visible. So the extract never returns rows at or after
 * its horizon: the start of the oldest transaction still writing in the
 * database (any row such a transaction stamped is at or after its start),
 * less EXTRACT_LAG_SECONDS for margin. Rows before the horizon are
 * committed and can no longer appear behind the cursor.
 */

const STREAMS = {
  branches: { ts: 'updated_at' },
  centres: { ts: 'updated_at' },
  members: { ts: 'updated_at' },
  gl_accounts: { ts: 'updated_at', key: 'code', keyType: 'text' },
  loan_products: { ts: 'updated_at', key: 'id', keyType: 'text' },
  savings_products: { ts: 'updated_at', key: 'id', keyType: 'text' },
  loan_accounts: { ts: 'updated_at' },
  loan_installments: { ts: 'updated_at' },
  loan_fees: { ts: 'updated_at' },
  savings_accounts: { ts: 'updated_at' },
  share_accounts: { ts: 'updated_at' },
  transactions: { ts: 'updated_at' },
  journal_entries: { ts: 'created_at' },
  journal_lines: { ts: 'created_at', via: { table: 'journal_entries', on: 'id', from: 'entry_id' }, keyType: 'bigint' },
  audit_log: { ts: 'created_at', keyType: 'bigint' },
};

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const LAG_SECONDS = () => Math.max(0, Number(process.env.EXTRACT_LAG_SECONDS ?? 5));

const err = (m, status = 400) => Object.assign(new Error(m), { status });

function streamDef(name) {
  const s = STREAMS[name];
  if (!s) throw err(`UNKNOWN_STREAM: ${name}. Streams: ${Object.keys(STREAMS).join(', ')}`, 404);
  return { key: 'id', keyType: 'uuid', ...s };
}

const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function decode(cursor) {
  if (!cursor) return null;
  try {
    const o = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof o.ts !== 'string' || o.k === undefined || Number.isNaN(Date.parse(o.ts))) throw new Error('shape');
    return o;
  } catch {
    throw err('INVALID_CURSOR');
  }
}

/** The streams and what each is read on, with its JSON Schema. */
async function streams(c) {
  const dict = await DD.build(c);
  return Object.entries(STREAMS).map(([name]) => {
    const s = streamDef(name);
    const t = dict.tables.find((x) => x.name === name);
    const omit = t.columns.filter((col) => col.type === 'bytea').map((col) => col.name);
    return {
      stream: name,
      description: t.description,
      keyProperties: [s.key],
      replicationKey: s.via ? `${s.via.table}.${s.ts}` : s.ts,
      schema: DD.jsonSchema(t, { omit }),
    };
  });
}

/**
 * One page of a stream after a cursor (none: from the beginning). `since`
 * is also accepted as a plain timestamp, for a first call that wants only
 * rows changed after a moment.
 */
async function read(c, name, { cursor = null, since = null, limit = DEFAULT_LIMIT } = {}) {
  const s = streamDef(name);
  const lim = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const after = decode(cursor);
  let sinceTs = null;
  if (!after && since) {
    const d = new Date(String(since));
    if (Number.isNaN(d.getTime())) throw err('INVALID_SINCE');
    sinceTs = d.toISOString();
  }
  // The horizon: see the comment at the top.
  const { rows: [h] } = await c.query(
    `SELECT to_char((LEAST(clock_timestamp(), COALESCE(
              (SELECT min(xact_start) FROM pg_stat_activity
                WHERE backend_xid IS NOT NULL AND pid <> pg_backend_pid()), clock_timestamp()))
              - make_interval(secs => $1::double precision))
            AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS horizon`, [LAG_SECONDS()]);

  const { rows: cols } = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND data_type <> 'bytea'
     ORDER BY ordinal_position`, [name]);
  const q = (x) => `"${x.replace(/"/g, '""')}"`;
  const select = cols.map((col) => `t.${q(col.column_name)}`).join(', ');
  const tsExpr = s.via ? `v.${q(s.ts)}` : `t.${q(s.ts)}`;
  const from = s.via
    ? `${q(name)} t JOIN ${q(s.via.table)} v ON v.${q(s.via.on)} = t.${q(s.via.from)}`
    : `${q(name)} t`;
  const params = [h.horizon, lim + 1];
  const conds = [`${tsExpr} < $1::timestamptz`];
  if (after) {
    params.push(after.ts, String(after.k));
    conds.push(`(${tsExpr}, t.${q(s.key)}) > ($3::timestamptz, $4::${s.keyType})`);
  } else if (sinceTs) {
    params.push(sinceTs);
    conds.push(`${tsExpr} > $3::timestamptz`);
  }
  const { rows } = await c.query(
    `SELECT ${select},
            to_char(${tsExpr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _cursor_ts
     FROM ${from}
     WHERE ${conds.join(' AND ')}
     ORDER BY ${tsExpr}, t.${q(s.key)}
     LIMIT $2`, params);
  const hasMore = rows.length > lim;
  const page = rows.slice(0, lim);
  const last = page[page.length - 1];
  const next = last ? encode({ ts: last._cursor_ts, k: last[s.key] }) : (cursor || null);
  return {
    stream: name,
    replicationKey: s.via ? `${s.via.table}.${s.ts}` : s.ts,
    keyProperties: [s.key],
    horizon: h.horizon,
    items: page.map(({ _cursor_ts, ...r }) => r),
    // Where to carry on. With nothing new it is the cursor given, so a
    // client can store it and ask again later; with a `since` and no rows,
    // there is no cursor yet and the client asks with the same `since`.
    nextCursor: next,
    hasMore,
  };
}

module.exports = { STREAMS, streams, read, encode, decode };
