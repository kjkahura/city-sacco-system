'use strict';

const { withTenant } = require('../db/tenantContext');
const AR = require('../domain/accountingReports');

/**
 * Generates accounting reports in the background: the request is committed
 * QUEUED and answered at once, then this claims it, builds the lines in a
 * transaction of its own and marks it COMPLETE or ERROR.
 */

const running = new Map();

function start(tenant, key) {
  const job = (async () => {
    try {
      const claimed = await withTenant(tenant.schema_name, (c) => AR.claim(c, key));
      if (!claimed) return;
      await withTenant(tenant.schema_name, async (c) => AR.complete(c, key, await AR.items(c, claimed.params)));
    } catch (e) {
      console.error('[accounting-report]', tenant.slug, key, e.message);
      await withTenant(tenant.schema_name, (c) => AR.fail(c, key, e.message)).catch(() => {});
    }
  })();
  running.set(key, job);
  job.finally(() => running.delete(key));
  return job;
}

/** Wait for a report started in this process (tests, ?wait=true). */
async function waitFor(key) {
  if (running.has(key)) await running.get(key);
}

module.exports = { start, waitFor };
