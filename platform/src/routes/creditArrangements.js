'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { pageParams } = require('../lib/page');
const { can } = require('../lib/permissions');
const CA = require('../domain/creditArrangements');

/**
 * The reference platform's API v2 for credit arrangements (/creditarrangements): list,
 * create, read, replace, patch and delete, the :changeState, :addAccount
 * and :removeAccount actions, and the linked accounts. The rules are in
 * ../domain/creditArrangements.
 *
 * The three actions share one route in the permission table (the path is
 * the same shape), which lets in any of their permissions; the action
 * checks the one it needs here or in the domain.
 */

const run = (fn, { write = false, status = 200 } = {}) => [requireAuth(), async (req, res, next) => {
  try {
    const out = await (write ? withTenant : withTenantRead)(req.tenant.schema_name, (c) => fn(c, req, res));
    if (out !== undefined) res.status(status).json(out);
  } catch (e) { next(e); }
}];

function need(req, code) {
  if (!can(req.auth, code)) throw Object.assign(new Error(`PERMISSION_REQUIRED: ${code}`), { status: 403 });
}

/** A JSON Patch list, or a plain object of the fields to change. */
function patchOf(body) {
  if (!Array.isArray(body)) return body || {};
  const out = {};
  for (const op of body) {
    const key = String(op.path || '').replace(/^\//, '').split('/')[0];
    if (!key) continue;
    if (op.op === 'remove') out[key] = null;
    else if (['add', 'replace'].includes(op.op)) out[key] = op.value;
    else throw Object.assign(new Error(`UNSUPPORTED_PATCH_OP: ${op.op}`), { status: 400 });
  }
  return out;
}

async function listOut(c, req, res, filter = {}) {
  const { offset, limit } = pageParams(req.query);
  const r = await CA.list(c, { holderId: filter.holderId ?? req.query.holderKey ?? null, state: req.query.state || null, offset, limit, user: req.auth });
  if (String(req.query.paginationDetails || '').toUpperCase() === 'ON') {
    res.set('items-offset', String(offset)); res.set('items-limit', String(limit)); res.set('items-total', String(r.total));
  }
  return r.items;
}

const router = express.Router();
router.get('/', ...run((c, req, res) => listOut(c, req, res)));
router.post('/', ...run((c, req) => CA.create(c, req.body || {}, { user: req.auth, actor: req.auth.email }), { write: true, status: 201 }));
router.post('/:id\\:changeState', ...run((c, req) => {
  const b = req.body || {};
  return CA.changeState(c, req.params.id, b.action, { notes: b.notes || null, user: req.auth, actor: req.auth.email });
}, { write: true }));
router.post('/:id\\:addAccount', ...run((c, req) => {
  need(req, 'ADD_ACCOUNTS_TO_LINE_OF_CREDIT');
  const b = req.body || {};
  return CA.addAccount(c, req.params.id, { accountId: b.accountId, accountType: b.accountType }, { user: req.auth, actor: req.auth.email });
}, { write: true }));
router.post('/:id\\:removeAccount', ...run((c, req) => {
  need(req, 'REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT');
  const b = req.body || {};
  return CA.removeAccount(c, req.params.id, { accountId: b.accountId, accountType: b.accountType }, { user: req.auth, actor: req.auth.email });
}, { write: true }));
router.get('/:id', ...run((c, req) => CA.find(c, req.params.id, { user: req.auth })));
router.get('/:id/accounts', ...run((c, req) => CA.accounts(c, req.params.id)));
router.put('/:id', ...run((c, req) => CA.replace(c, req.params.id, req.body || {}, { user: req.auth, actor: req.auth.email }), { write: true }));
router.patch('/:id', ...run((c, req) => CA.update(c, req.params.id, patchOf(req.body), { user: req.auth, actor: req.auth.email }), { write: true }));
router.delete('/:id', ...run(async (c, req, res) => {
  await CA.remove(c, req.params.id, { actor: req.auth.email });
  res.status(204).end();
}, { write: true }));

module.exports = { router, listOut };
