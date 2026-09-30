'use strict';

/**
 * Activities (the reference platform's Tracking Activities and its API v1 activities):
 *
 *   GET /api/activities                 every activity, with the reference platform's filters (AUDIT_TRANSACTIONS)
 *   GET /api/activities/feed            the dashboard's Latest Activity for the signed-in user
 *   GET /api/activities/types           the activity types there are
 *   GET /api/{members|clients|groups|loans|savings|deposits|creditarrangements}/:id/activities
 *                                       one record's activities, with the permission that views it
 *
 * A user limited to some branches reads the activities of those branches.
 * The feed shows every staff user the activities in their branches;
 * activities with no branch (products, settings, the chart of accounts)
 * only to holders of AUDIT_TRANSACTIONS or VIEW_REPORTS, as before.
 */

const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { pageParams } = require('../lib/page');
const { can } = require('../lib/permissions');
const { pool } = require('../db/pool');
const ACT = require('../domain/activities');
const { pagingHeaders } = require('../lib/handlers');

const limitedTo = (req) => (Array.isArray(req.auth?.branches) ? req.auth.branches : null);

function send(req, res, out, { offset, limit }) {
  pagingHeaders(req, res, { offset, limit, total: out.total }, { always: true }).json(out.items);
}

const read = (fn) => [requireAuth(), async (req, res, next) => {
  try {
    const pg = pageParams(req.query);
    const out = await withTenantRead(req.tenant.schema_name, (c) => fn(c, req, pg));
    send(req, res, out, pg);
  } catch (e) { next(e); }
}];

const list = read((c, req, pg) => ACT.list(c, req.query, { branches: limitedTo(req), ...pg }));

const router = express.Router();

router.get('/types', requireAuth(), async (req, res, next) => {
  try { res.json(await withTenantRead(req.tenant.schema_name, (c) => ACT.types(c))); } catch (e) { next(e); }
});

router.get('/feed', ...read(async (c, req) => {
  const { rows: [u] } = req.auth.apiConsumer ? { rows: [] }
    : await pool.query('SELECT activity_types FROM platform.users WHERE id = $1', [req.auth.sub]);
  const pg = pageParams({ limit: req.query.limit || 10, offset: req.query.offset });
  return ACT.list(c, {}, {
    branches: limitedTo(req), noBranch: can(req.auth, 'AUDIT_TRANSACTIONS') || can(req.auth, 'VIEW_REPORTS'),
    types: u?.activity_types || null, ...pg,
  });
}));

// One record's activities: the record is found as its own routes find it (row security applies).
const RECORD = {
  members: 'memberID', clients: 'clientID', groups: 'groupID', loans: 'loanAccountID', savings: 'savingsAccountID',
  deposits: 'savingsAccountID', creditarrangements: 'creditArrangementID',
};
const forRecord = (kind) => read((c, req, pg) => ACT.list(c, { [RECORD[kind]]: req.params.id }, { ...pg }));

module.exports = { router, list, forRecord, RECORD };
