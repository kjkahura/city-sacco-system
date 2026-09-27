'use strict';

const { withTenant } = require('../db/tenantContext');
const IMP = require('../domain/dataImport');
const ORG = require('../domain/organization');

/**
 * Runs import validation in the background (the reference platform: the upload returns at
 * once and a progress bar shows how far the import has got). The upload is
 * committed as QUEUED; the run marks it IN_PROGRESS and writes its
 * percentage on a connection of its own, so a client polling the import sees
 * it move while the validation transaction is still open. The outcome is
 * written by that transaction. A run whose process goes away is marked
 * ERROR once it has stopped moving for 30 minutes (IMP.markStale).
 */

const running = new Map();

async function setProgress(tenant, id, percent) {
  await withTenant(tenant.schema_name, (c) => c.query(
    `UPDATE data_imports SET status = 'IN_PROGRESS', progress = GREATEST(progress, $2), progress_at = now(),
       started_at = COALESCE(started_at, now())
     WHERE id = $1 AND status IN ('QUEUED', 'IN_PROGRESS')`, [id, Math.max(0, Math.min(99, percent))]));
}

/** Start the run for an import; returns at once. */
function start(tenant, id, { user }) {
  const today = ORG.localClock(tenant.timezone || 'Africa/Nairobi').date;
  const job = (async () => {
    await setProgress(tenant, id, 1);
    let last = 1;
    let writing = Promise.resolve();
    const progress = (p) => {
      // At most one write in flight, and only when it has moved 5 points.
      if (p - last < 5) return;
      last = p;
      writing = writing.then(() => setProgress(tenant, id, p)).catch(() => {});
    };
    try {
      await withTenant(tenant.schema_name, (c) => IMP.validate(c, id, { user, today, progress }));
    } catch (e) {
      console.error('[import]', tenant.slug, id, e);
      await withTenant(tenant.schema_name, (c) => c.query(
        `UPDATE data_imports SET status = 'ERROR', finished_at = now(), errors = $2 WHERE id = $1`,
        [id, JSON.stringify([{ sheet: null, row: null, column: null, message: `The file could not be processed: ${e.message}` }])])).catch(() => {});
    }
    await writing;
  })();
  running.set(id, job);
  job.finally(() => running.delete(id));
  return job;
}

/** Wait for a run started in this process (tests, ?wait=true). */
async function waitFor(id) {
  if (running.has(id)) await running.get(id);
}

module.exports = { start, waitFor };
