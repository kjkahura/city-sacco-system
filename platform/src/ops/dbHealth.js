'use strict';

/**
 * Database health readings for the operator (bin/cli.js db:*, docs/deploy.md
 * "Watching the database"). Read-only; nothing here changes a setting.
 *
 * - connections: the server's limit, what is open now by application, and
 *   how many the platform may open (instances times PGPOOL_MAX must stay
 *   under the limit).
 * - topQueries: the statements that took the most time in total, from
 *   pg_stat_statements (Cloud SQL Query Insights turns it on); null when the
 *   extension is not there.
 * - bloat: dead rows on the tables updated many times a day, in every tenant
 *   schema, so autovacuum falling behind is seen before it slows postings.
 */

// Updated many times a day: balances, the daily rollups, sessions and the outbox.
const WATCHED = ['savings_accounts', 'loan_accounts', 'gl_daily_balances', 'gl_branch_daily_balances', 'loan_installments',
  'notification_events', 'notification_messages', 'api_idempotency', 'refresh_tokens', 'member_sessions'];

async function connections(db, { instances = 1, poolMax = Number(process.env.PGPOOL_MAX || 20), directMax = process.env.PG_DIRECT_HOST ? Number(process.env.PGPOOL_DIRECT_MAX || 3) : 0, jobs = 3 } = {}) {
  const { rows: [m] } = await db.query("SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS reserved");
  const { rows } = await db.query(
    `SELECT COALESCE(NULLIF(application_name, ''), '(none)') AS application, state, count(*)::int AS n
       FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1, 2 ORDER BY 1, 2`);
  const open = rows.reduce((t, r) => t + r.n, 0);
  const usable = m.max - m.reserved;
  // Each service instance opens its pool and, when set, its direct pool; each job running at once opens one pool more.
  const platformMax = instances * (poolMax + directMax) + jobs * poolMax;
  return {
    maxConnections: m.max, reservedForSuperuser: m.reserved, usable, open, byApplication: rows,
    platform: { instances, poolMax, directMax, jobs, mayOpen: platformMax, fits: platformMax <= Math.floor(usable * 0.8) },
    advice: platformMax <= Math.floor(usable * 0.8)
      ? 'The platform\'s pools fit under the limit with room for jobs and operators.'
      : `The platform may open ${platformMax} connections, above 80% of the usable ${usable}: lower PGPOOL_MAX, raise the tier, or put a connection pooler in front (docs/deploy.md, "Scaling the database").`,
  };
}

async function topQueries(db, { limit = 15 } = {}) {
  const { rows: [ext] } = await db.query("SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_stat_statements'");
  if (!ext) return null;
  const { rows } = await db.query(
    `SELECT calls::bigint AS calls, round(total_exec_time::numeric, 0) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
            round(max_exec_time::numeric, 0) AS max_ms, rows::bigint AS rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query
       FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT $1`, [Math.min(100, Math.max(1, Number(limit) || 15))]);
  return rows;
}

async function bloat(db, { minDead = 10_000, ratio = 0.2 } = {}) {
  const { rows } = await db.query(
    `SELECT schemaname AS schema, relname AS table, n_live_tup::bigint AS live, n_dead_tup::bigint AS dead,
            CASE WHEN n_live_tup + n_dead_tup = 0 THEN 0 ELSE round(n_dead_tup::numeric / (n_live_tup + n_dead_tup), 3) END AS dead_share,
            last_autovacuum, last_autoanalyze, autovacuum_count::bigint AS autovacuums
       FROM pg_stat_user_tables
      WHERE (schemaname LIKE 'tenant\\_%' OR schemaname = 'platform') AND relname = ANY($1)
      ORDER BY n_dead_tup DESC`, [WATCHED]);
  return rows.map((r) => ({ ...r, attention: Number(r.dead) >= minDead && Number(r.dead_share) >= ratio }));
}

module.exports = { connections, topQueries, bloat, WATCHED };
