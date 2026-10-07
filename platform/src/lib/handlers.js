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

const { withTenant, withTenantRead, retryConflicts } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { notFound } = require('./http');
const { once } = require('./idempotency');

const ctxOf = (req) => ({ actor: req.auth?.email, user: req.auth });

// Before a retry the status a failed try set is forgotten (a retry may take another path).
const fresh = (res, attempt) => { if (attempt > 0) res.statusCode = 200; return true; };

const statusOf = (res, status, keepStatus) => (status !== null ? (keepStatus && res.statusCode !== 200 ? res.statusCode : status) : res.statusCode);

function handle(fn, { write = false, status = null, keepStatus = false, what = null, always = false } = {}) {
  return async (req, res, next) => {
    try {
      // A write sent with an Idempotency-Key (a retry after a timeout or a dropped
      // connection) gets the first answer back instead of acting twice (lib/idempotency).
      if (write && req.method === 'POST' && req.get('idempotency-key')) {
        const r = await retryConflicts((attempt) => fresh(res, attempt) && withTenant(req.tenant.schema_name, (c) => once(c, req, `${req.method} ${req.baseUrl}${req.path}`, async () => {
          const v = await fn(c, req, res, ctxOf(req));
          if (res.headersSent || (v === undefined && !always)) return { skip: true };
          if (v === null && what) return { status: 404, body: { errors: [{ errorCode: 404, errorReason: `${String(what).toUpperCase()}_NOT_FOUND` }] } };
          return { status: statusOf(res, status, keepStatus), body: v };
        })), { canRetry: () => !res.headersSent && !req.socket?.destroyed, label: `${req.method} ${req.baseUrl}${req.path}` });
        if (r.skip) return;
        if (r.replayed) res.set('idempotent-replayed', 'true');
        res.status(r.status).json(r.body);
        return;
      }
      // A deadlock or serialization conflict rolls the transaction back; it is run again (db/tenantContext retryConflicts).
      const out = await retryConflicts((attempt) => fresh(res, attempt) && (write ? withTenant : withTenantRead)(req.tenant.schema_name, (c) => fn(c, req, res, ctxOf(req))),
        { canRetry: () => !res.headersSent && !req.socket?.destroyed, label: `${req.method} ${req.baseUrl}${req.path}` });
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
