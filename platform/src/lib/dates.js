'use strict';

/**
 * Calendar days as YYYY-MM-DD. DATE columns arrive as strings already
 * (db/pool); these are for the Date objects that still turn up.
 *
 *   localDay  a Date read in the server's time zone (the session's day)
 *   utcDay    a Date read in UTC
 *
 * A string is cut to its first ten characters either way.
 */
const pad2 = (n) => String(n).padStart(2, '0');

const localDay = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  : String(d).slice(0, 10));

const utcDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

module.exports = { localDay, utcDay, pad2 };
