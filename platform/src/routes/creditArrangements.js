'use strict';

const express = require('express');
const CF = require('../domain/customFields');
const CLD = require('../domain/clients');
const { pageParams } = require('../lib/page');
const { can } = require('../lib/permissions');
const CA = require('../domain/creditArrangements');
const { run, pagingHeaders } = require('../lib/handlers');

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
    const kind = String(op.op || '').toLowerCase();
    if (kind === 'remove') out[key] = null;
    else if (['add', 'replace'].includes(kind)) out[key] = op.value;
    else throw Object.assign(new Error(`UNSUPPORTED_PATCH_OP: ${op.op}`), { status: 400 });
  }
  return out;
}

async function listOut(c, req, res, filter = {}) {
  const { offset, limit } = pageParams(req.query);
  const r = await CA.list(c, { holderId: filter.holderId ?? req.query.holderKey ?? null, state: req.query.state || null, offset, limit, user: req.auth });
  pagingHeaders(req, res, { offset, limit, total: r.total });
  return CF.detailed(req, r.items);
}

/**
 * PATCH: a JSON Patch, or a plain object. Custom field paths (/_set/field,
 * grouped entries /_set/0/field and /_set/-) are applied to the arrangement
 * as it reads, and the fields they removed are cleared.
 */
async function patchArrangement(c, req) {
  const opts = { user: req.auth, actor: req.auth.email };
  if (!Array.isArray(req.body)) return CA.update(c, req.params.id, req.body || {}, opts);
  const custom = req.body.filter((o) => String(o?.path || '').startsWith('/_'));
  const plain = patchOf(req.body.filter((o) => !custom.includes(o)));
  if (!custom.length) return CA.update(c, req.params.id, plain, opts);
  const current = await CA.find(c, req.params.id, { user: req.auth });
  const next = CLD.applyJsonPatch(current, custom);
  return CA.update(c, req.params.id, { ...plain, customFields: CF.patchFromApi(current, next) }, opts);
}

// POST /creditarrangements:search, mounted by the parent (the colon escaped).
const search = run(async (c, req, res) => {
  const body = req.body || {};
  const { offset, limit } = pageParams({ ...req.query, ...body });
  const r = await CA.search(c, body, { offset, limit, user: req.auth });
  pagingHeaders(req, res, { offset, limit, total: r.total });
  return CF.detailed(req, r.items);
});

const router = express.Router();
router.get('/', ...run((c, req, res) => listOut(c, req, res)));
router.post('/', ...run(async (c, req) => CF.detailed(req, await CA.create(c, req.body || {}, { user: req.auth, actor: req.auth.email })), { write: true, status: 201 }));
router.post('/:id\\:changeState', ...run(async (c, req) => {
  const b = req.body || {};
  return CF.detailed(req, await CA.changeState(c, req.params.id, b.action, { notes: b.notes || null, user: req.auth, actor: req.auth.email }));
}, { write: true }));
router.post('/:id\\:addAccount', ...run(async (c, req) => {
  need(req, 'ADD_ACCOUNTS_TO_LINE_OF_CREDIT');
  const b = req.body || {};
  return CF.detailed(req, await CA.addAccount(c, req.params.id, { accountId: b.accountId, accountType: b.accountType }, { user: req.auth, actor: req.auth.email }));
}, { write: true }));
router.post('/:id\\:removeAccount', ...run(async (c, req) => {
  need(req, 'REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT');
  const b = req.body || {};
  return CF.detailed(req, await CA.removeAccount(c, req.params.id, { accountId: b.accountId, accountType: b.accountType }, { user: req.auth, actor: req.auth.email }));
}, { write: true }));
router.get('/:id', ...run(async (c, req) => CF.detailed(req, await CA.find(c, req.params.id, { user: req.auth }))));
router.get('/:id/accounts', ...run((c, req) => CA.accounts(c, req.params.id)));
router.get('/:id/schedule', ...run((c, req) => CA.schedule(c, req.params.id)));
router.put('/:id', ...run(async (c, req) => CF.detailed(req, await CA.replace(c, req.params.id, req.body || {}, { user: req.auth, actor: req.auth.email })), { write: true }));
router.patch('/:id', ...run(async (c, req) => CF.detailed(req, await patchArrangement(c, req)), { write: true }));
router.delete('/:id', ...run(async (c, req, res) => {
  await CA.remove(c, req.params.id, { actor: req.auth.email });
  res.status(204).end();
}, { write: true }));

module.exports = { router, listOut, search };
