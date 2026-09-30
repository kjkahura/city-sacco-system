'use strict';

const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { requirePermission } = require('../tenancy/resolve');
const PERMS = require('../lib/permissions');
const TL = require('../domain/tills');
const { json } = require('../lib/handlers');
const read = (perms, fn) => json((c, req) => fn(c, req), { guard: requirePermission(...perms) });
const write = (perm, fn, status = 200) => json((c, req) => fn(c, req), { write: true, status, guard: requirePermission(perm) });

/**
 * Teller tills (the reference platform's Tellers and Tellering widgets), /api/tills.
 * OPEN_TILL opens (and undoes an opening, and reopens); CLOSE_TILL closes
 * and undoes a close; ADD_CASH and REMOVE_CASH move cash in and out. A
 * teller closes their own till; closing another's needs OPEN_TILL too (a
 * supervisor's). Cash transactions go through the teller's open till by
 * themselves (migration 031); a teller without POST_TRANSACTIONS_WITHOUT_OPENED_TILL
 * must have one open to post cash.
 */

const router = express.Router();
const SEE = ['OPEN_TILL', 'CLOSE_TILL'];
const by = (req) => ({ createdBy: req.auth.email });

// The Tellering widget: the teller's own open till, with its log.
router.get('/mine', requirePermission('VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS'), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, async (c) => {
      const t = await TL.openFor(c, req.auth.email);
      return {
        till: t ? await TL.get(c, t.id) : null,
        mustUseTill: !PERMS.can(req.auth, 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL'),
      };
    }));
  } catch (e) { next(e); }
});
// The Tellers widget: the tills, open ones unless asked for closed ones too.
router.get('/', ...read(SEE, (c, req) => TL.list(c, {
  includeClosed: ['true', '1'].includes(String(req.query.includeClosed || '')), branchId: req.query.branchId || null,
})));
router.get('/next-id', ...read(['OPEN_TILL'], async (c) => ({ tillId: await TL.nextCode(c) })));
router.post('/', ...write('OPEN_TILL', (c, req) => TL.open(c, req.body, by(req)), 201));
router.get('/:id', ...read([...SEE, 'VIEW_SAVINGS_ACCOUNT_DETAILS'], async (c, req) => {
  const t = await TL.get(c, req.params.id);
  // A teller sees their own till; the others need a till permission.
  if (t.teller.email.toLowerCase() !== String(req.auth.email).toLowerCase() && !SEE.some((p) => PERMS.can(req.auth, p))) {
    throw Object.assign(new Error('TILL_NOT_FOUND'), { status: 404 });
  }
  return t;
}));
router.delete('/:id', ...write('OPEN_TILL', (c, req) => TL.undoOpen(c, req.params.id, by(req))));
// A supervisor moves cash in and out of a till (OPEN_TILL); ADD_CASH and
// REMOVE_CASH are the teller's permissions to post through it (the reference platform).
router.post('/:id/add-cash', ...write('OPEN_TILL', (c, req) => TL.moveCash(c, req.params.id, req.body || {}, { ...by(req), direction: 'IN' })));
router.post('/:id/remove-cash', ...write('OPEN_TILL', (c, req) => TL.moveCash(c, req.params.id, req.body || {}, { ...by(req), direction: 'OUT' })));
router.post('/:id/close', ...write('CLOSE_TILL', (c, req) => TL.close(c, req.params.id, req.body || {}, {
  ...by(req), user: { email: req.auth.email, canCloseOthers: PERMS.can(req.auth, 'CLOSE_TILL') },
})));
router.post('/:id/undo-close', ...write('CLOSE_TILL', (c, req) => TL.undoClose(c, req.params.id, by(req))));
router.post('/:id/reopen', ...write('OPEN_TILL', (c, req) => TL.reopen(c, req.params.id, by(req)), 201));

module.exports = router;
