'use strict';

/**
 * Route handlers: the tenant transaction, the answer, and the error, in one
 * place. Every route file used to write its own copy of these.
 *
 * A handler function gets (c, req, res, ctx): the tenant client, the
 * request, the response, and ctx = { actor, user } (the signed-in user's
 * email and auth). It returns what to send.
 *
 *   run(fn, { write, status, keepStatus })
 *       returns undefined: the handler answered itself (a file, a 204);
 *       otherwise the value is sent with `status` (200), or with the status
 *       the handler set when keepStatus is on.
 *   json(fn, { write, status, guard, what })
 *       the value is always sent with `status` (200); guard replaces
 *       requireAuth() (a permission check, the member portal's sign-in);
 *       with `what`, null answers 404.
 *   tx(fn, what) / read(fn, what)
 *       a write or a read that answers 404 "<what> not found" when the
 *       handler returns null. tx keeps the status the handler set and sends
 *       nothing for undefined; read always sends.
 *   plain(fn, status)
 *       no tenant transaction: fn(req) for routes on the platform tables.
 */

const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { notFound } = require('./http');

const ctxOf = (req) => ({ actor: req.auth?.email, user: req.auth });

function handle(fn, { write = false, status = null, keepStatus = false, what = null, always = false } = {}) {
  return async (req, res, next) => {
    try {
      const out = await (write ? withTenant : withTenantRead)(req.tenant.schema_name, (c) => fn(c, req, res, ctxOf(req)));
      if (out === undefined && !always) return;
      if (out === null && what) { notFound(res, what); return; }
      if (status !== null) res.status(keepStatus && res.statusCode !== 200 ? res.statusCode : status);
      res.json(out);
    } catch (e) { next(e); }
  };
}

const run = (fn, { write = false, status = 200, keepStatus = false } = {}) => [requireAuth(), handle(fn, { write, status, keepStatus })];

const json = (fn, { write = false, status = 200, guard = null, what = null } = {}) => [guard || requireAuth(), handle(fn, { write, status, what, always: true })];

const tx = (fn, what) => [requireAuth(), handle(fn, { write: true, what })];

const read = (fn, what) => [requireAuth(), handle(fn, { what, always: true })];

const plain = (fn, status = 200) => [requireAuth(), async (req, res, next) => {
  try { res.status(status).json(await fn(req)); } catch (e) { next(e); }
}];

/** The paging headers, with ?paginationDetails=ON unless `always`. */
function pagingHeaders(req, res, { offset, limit, total }, { always = false } = {}) {
  if (always || String(req.query.paginationDetails || '').toUpperCase() === 'ON') {
    res.set('items-offset', String(offset)); res.set('items-limit', String(limit)); res.set('items-total', String(total));
  }
  return res;
}

module.exports = { handle, run, json, tx, read, plain, pagingHeaders, ctxOf };
