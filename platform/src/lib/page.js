'use strict';

/**
 * Paging, done in SQL.
 *
 * The older helper in lib/http.js takes a fully materialised array and slices
 * it. That is fine for a list of transaction channels and wrong for anything
 * that grows with the book: a SACCO with 40,000 members and six years of
 * postings would have the server read the whole journal into memory to hand
 * back fifty rows, and the first tenant to try it would take the process down
 * with it. Everything that can grow uses the helpers here instead, so the
 * database does the limiting and the process holds one page at a time.
 *
 * `count(*) OVER ()` rides along on the same scan, so the total costs one
 * query rather than two. The one case it cannot answer is a page past the end
 * of the result, where there are no rows to carry the count; that falls back
 * to a separate COUNT, which is rare enough not to matter.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Read offset and limit from a query string or a body.
 * An absent, zero, negative or non-numeric limit means the default; anything
 * above maxLimit is clamped rather than rejected, because a client asking for
 * too much should get an answer, not an error.
 */
function pageParams(source = {}, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const offset = Math.max(0, parseInt(source.offset, 10) || 0);
  const raw = parseInt(source.limit, 10);
  const limit = Math.min(maxLimit, raw > 0 ? raw : defaultLimit);
  return { offset, limit };
}

/**
 * Run a SELECT as one page.
 *
 * `sql` is wrapped, so it must be a bare SELECT with its own ORDER BY and
 * without LIMIT. Ordering matters more than it looks: without a total order
 * the same row can appear on two pages, so every caller here orders by
 * something unique or near enough.
 *
 * @returns {{items: object[], offset: number, limit: number, total: number, hasMore: boolean}}
 */
async function pageQuery(c, sql, params = [], source = {}, opts = {}) {
  const { offset, limit } = pageParams(source, opts);
  const { rows } = await c.query(
    `WITH page_source AS (
       ${sql}
     )
     SELECT *, count(*) OVER () AS page_total FROM page_source
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  let total;
  if (rows.length) {
    total = Number(rows[0].page_total);
  } else {
    // Empty page. Either the result is empty or the offset is past the end,
    // and the client still needs the total to know which.
    const { rows: [t] } = await c.query(
      `SELECT count(*)::bigint AS n FROM (${sql}) page_source`, params);
    total = Number(t.n);
  }

  const items = rows.map(({ page_total, ...r }) => r);
  return { items, offset, limit, total, hasMore: offset + items.length < total };
}

/** items-* response headers, matching the convention the list endpoints use. */
function pageHeaders(res, { offset, limit, total }) {
  res.set('items-offset', String(offset));
  res.set('items-limit', String(limit));
  res.set('items-total', String(total));
  return res;
}

/**
 * List endpoint convention: the body is a bare array and the paging metadata
 * rides in headers. Reports embed the same numbers in the body instead,
 * because a report is an object and a client reading it should not have to
 * look at two places to know it is holding page one of nine.
 */
function sendPage(res, page) {
  return pageHeaders(res, page).json(page.items);
}

module.exports = { pageParams, pageQuery, pageHeaders, sendPage, DEFAULT_LIMIT, MAX_LIMIT };
