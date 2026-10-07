'use strict';

/**
 * Optimistic locking for configuration (tenant migration 053).
 *
 * A GET of a product, channel, custom field set or definition answers with
 * an ETag, "v<row_version>". A PUT or PATCH that sends it back in If-Match is
 * refused with 412 PRECONDITION_FAILED when the row has changed since, so a
 * second administrator's save no longer overwrites the first's without
 * either knowing. Without If-Match a change goes through as before.
 *
 * The configuration files (GET /configuration/*.yaml) have an ETag of their
 * own, a hash of the file; a PUT of a file can send it back the same way.
 *
 * The check runs inside the change's own transaction and locks the row (or
 * the tables, for a file) first, so nothing can change between the check and
 * the write.
 */

const crypto = require('crypto');
const { err } = require('./errors');

const TABLES = new Set(['loan_products', 'savings_products', 'transaction_channels', 'custom_field_sets', 'custom_field_definitions']);

const etagOf = (version) => `"v${version}"`;
const textEtag = (text) => `"${crypto.createHash('sha256').update(String(text)).digest('base64url').slice(0, 27)}"`;

/** The ETags an If-Match header names; null when there is none. Weak tags match as their strong form. */
function ifMatch(req) {
  const h = req.get('if-match');
  if (h === undefined || h === null || String(h).trim() === '') return null;
  if (String(h).trim() === '*') return ['*'];
  return String(h).split(',').map((t) => t.trim().replace(/^W\//, '')).filter(Boolean);
}

function refuse(what, current) {
  const e = err(`PRECONDITION_FAILED: the ${what} changed since you read it; read it again and repeat your change`, 412);
  e.etag = current;
  return e;
}

/**
 * Check If-Match for one row, in the transaction that is about to change it.
 * Locks the row. A missing row is left for the route to answer (404).
 */
async function checkRow(c, req, table, id, what = 'record') {
  if (!TABLES.has(table)) throw new Error(`versioning: ${table} has no row_version`);
  const tags = ifMatch(req);
  if (!tags) return;
  const { rows: [r] } = await c.query(`SELECT row_version FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!r) return;
  if (tags.includes('*')) return;
  if (!tags.includes(etagOf(r.row_version))) throw refuse(what, etagOf(r.row_version));
}

/**
 * Check If-Match for a configuration file. `lock` is the tables to lock
 * first; `current` builds the file as GET would return it.
 */
async function checkFile(c, req, lock, current, what) {
  const tags = ifMatch(req);
  if (!tags) return;
  for (const t of lock) await c.query(`LOCK TABLE ${t} IN SHARE ROW EXCLUSIVE MODE`);
  if (tags.includes('*')) return;
  const now = textEtag(await current(c));
  if (!tags.includes(now)) throw refuse(what, now);
}

/** Set the ETag of a row on the response, from the row or by reading it. */
async function sendRowEtag(res, c, table, id, row = null) {
  if (row && row.row_version !== undefined) { res.set('ETag', etagOf(row.row_version)); return; }
  if (!TABLES.has(table)) return;
  const { rows: [r] } = await c.query(`SELECT row_version FROM ${table} WHERE id = $1`, [id]);
  if (r) res.set('ETag', etagOf(r.row_version));
}

module.exports = { etagOf, textEtag, ifMatch, checkRow, checkFile, sendRowEtag };
