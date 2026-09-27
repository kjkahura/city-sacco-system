'use strict';

/**
 * The organization's calendar day. A tenant transaction runs with the
 * session time zone set to the tenant's (db/tenantContext), so current_date
 * is the organization's local date. Every "today" default in the domain goes
 * through here, so the code and the SQL agree on what today is.
 */
async function orgToday(c) {
  const { rows: [r] } = await c.query('SELECT current_date::text AS d');
  return r.d;
}

/** yyyy-MM-dd plus n days, on the calendar (no time zone involved). */
function addDays(iso, n) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { orgToday, addDays };
