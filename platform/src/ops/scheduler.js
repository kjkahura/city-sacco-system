'use strict';

const { pool } = require('../db/pool');
const eod = require('./eod');
const backup = require('./backup');
const tokens = require('../auth/tokens');
const mfa = require('../auth/mfa');

/**
 * Scheduler.
 *
 * Deliberately not a cron library. The jobs are already idempotent through
 * platform.job_runs, and a Postgres advisory lock stops two app instances
 * running the same sweep, so a plain timer is enough and there is one less
 * dependency to keep current.
 *
 * In Kubernetes you would use a CronJob calling `npm run cli eod:run`
 * instead and leave this off. Set SCHEDULER=on to use the in-process one.
 */

const LOCK_NAMESPACE = 41_000;
const lockId = (name) => LOCK_NAMESPACE + (name.split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 1000, 7));

/** Only one instance runs a given sweep, even across processes. */
async function withGlobalLock(name, fn) {
  const client = await pool.connect();
  try {
    const { rows: [r] } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [lockId(name)]);
    if (!r.got) return { skipped: 'LOCK_HELD_ELSEWHERE' };
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId(name)]);
    }
  } finally {
    client.release();
  }
}

/** Nairobi-local hour, since the SACCOs this serves all run on EAT. */
function localHour(tz = process.env.SCHEDULER_TZ || 'Africa/Nairobi') {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).format(new Date()));
}

const TASKS = [
  {
    name: 'end-of-day',
    hour: Number(process.env.EOD_HOUR ?? 22),
    run: () => eod.runAll({}),   // eod.DEFAULT_JOBS
  },
  {
    name: 'backup',
    hour: Number(process.env.BACKUP_HOUR ?? 1),
    run: async () => {
      const out = await backup.backupAll({});
      const pruned = await backup.prune({ keep: Number(process.env.BACKUP_KEEP || 14) });
      return { backups: out, pruned: pruned.length };
    },
  },
  {
    name: 'token-prune',
    hour: Number(process.env.TOKEN_PRUNE_HOUR ?? 3),
    run: async () => ({
      refreshTokens: await tokens.prune(),
      mfaChallenges: await mfa.pruneChallenges(),
    }),
  },
];

const lastRunOn = new Map();

async function tick({ log = console.log } = {}) {
  const hour = localHour();
  const today = new Date().toISOString().slice(0, 10);
  const fired = [];

  for (const task of TASKS) {
    if (hour !== task.hour) continue;
    if (lastRunOn.get(task.name) === today) continue;
    lastRunOn.set(task.name, today);

    const out = await withGlobalLock(task.name, async () => {
      const started = Date.now();
      try {
        const detail = await task.run();
        return { ok: true, ms: Date.now() - started, detail };
      } catch (e) {
        return { ok: false, ms: Date.now() - started, error: e.message };
      }
    });
    log(`[scheduler] ${task.name}`, JSON.stringify(out).slice(0, 400));
    fired.push({ task: task.name, ...out });
  }
  return fired;
}

let timer = null;

function start({ intervalMs = 15 * 60_000, log = console.log } = {}) {
  if (timer) return timer;
  log(`[scheduler] on, checking every ${Math.round(intervalMs / 60000)}m ` +
      `(${TASKS.map((t) => `${t.name}@${t.hour}h`).join(', ')})`);
  timer = setInterval(() => { tick({ log }).catch((e) => log('[scheduler] error', e.message)); }, intervalMs);
  timer.unref();
  return timer;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, withGlobalLock, TASKS, localHour };
