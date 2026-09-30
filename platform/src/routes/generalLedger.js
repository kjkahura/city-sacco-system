'use strict';

/**
 * The reference platform's accounting API: GL accounts (/api/glaccounts), GL journal entries
 * (/api/gljournalentries, with manual entries, their reversal and files),
 * and the interest accrual breakdown search. The permissions are in
 * lib/routePermissions; a user limited to some branches is handled here and
 * in lib/ledgerScope.
 */

const express = require('express');
const { withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { pageParams } = require('../lib/page');
const { orgToday } = require('../lib/orgDate');
const COA = require('../domain/chartOfAccounts');
const JE = require('../domain/journalEntries');
const ACR = require('../domain/accruals');
const { err } = require('../domain/accounting');
const { run, pagingHeaders } = require('../lib/handlers');

const by = (req) => ({ createdBy: req.auth.email, user: req.auth });
const limited = (req) => Array.isArray(req.auth?.branches);
const orgWide = (req) => { if (limited(req)) throw err('ALL_BRANCH_ACCESS_REQUIRED: the chart of accounts is kept for the whole organization', 403); };

/** The reference platform's paging headers, with ?paginationDetails=ON. */
function paged(req, res, { total, items }, { offset, limit }) {
  pagingHeaders(req, res, { offset, limit, total });
  return items;
}

// --------------------------------------------------------------------------
// GL accounts
// --------------------------------------------------------------------------

const glaccounts = express.Router();

glaccounts.get('/', ...run(async (c, req, res) => {
  const pg = pageParams(req.query, { defaultLimit: 200, maxLimit: 1000 });
  const q = req.query;
  const out = await COA.list(c, { type: q.type || null, usage: q.usage || null, activated: q.activated ?? null,
    from: q.from || null, to: q.to || null, branchId: q.branchId || null, ...pg });
  return paged(req, res, out, pg);
}));

glaccounts.get('/:code', ...run((c, req) => COA.get(c, req.params.code,
  { from: req.query.from || null, to: req.query.to || null, branchId: req.query.branchId || null })));

glaccounts.post('/', ...run((c, req) => { orgWide(req); return COA.create(c, req.body, by(req)); }, { write: true, status: 201 }));
glaccounts.put('/:code', ...run((c, req) => { orgWide(req); return COA.update(c, req.params.code, req.body || {}, by(req)); }, { write: true }));
glaccounts.patch('/:code', ...run((c, req) => { orgWide(req); return COA.patch(c, req.params.code, req.body, by(req)); }, { write: true }));
glaccounts.delete('/:code', ...run(async (c, req, res) => {
  orgWide(req);
  await COA.remove(c, req.params.code, by(req));
  res.status(204).end();
}, { write: true }));

// --------------------------------------------------------------------------
// GL journal entries
// --------------------------------------------------------------------------

const journal = express.Router();

const listJournal = (c, req, res, body = {}) => {
  const pg = pageParams(req.method === 'POST' ? { ...req.query, ...body } : req.query);
  return JE.search(c, { body, query: req.method === 'GET' ? req.query : {}, ...pg, branches: limited(req) ? req.auth.branches : null })
    .then((out) => paged(req, res, out, pg));
};

journal.get('/', ...run((c, req, res) => listJournal(c, req, res)));
const searchJournal = run((c, req, res) => listJournal(c, req, res, req.body || {}));

journal.post('/', ...run((c, req) => JE.logManual(c, req.body, { user: req.auth, createdBy: req.auth.email }), { write: true, status: 201 }));
journal.post('/:ref\\:reverse', ...run((c, req) => JE.reverseManual(c, req.params.ref,
  { notes: req.body?.notes, date: req.body?.date ?? req.body?.bookingDate, user: req.auth, createdBy: req.auth.email }), { write: true, status: 201 }));

journal.get('/:ref', ...run(async (c, req) => {
  const e = await JE.get(c, req.params.ref);
  if (limited(req) && e.lines.some((l) => !l.assignedBranchKey || !req.auth.branches.includes(l.assignedBranchKey))) {
    throw err('OUTSIDE_YOUR_BRANCH_ACCESS', 403);
  }
  return e;
}));

// Files: JSON with the file base64 in `content`, or the raw body with ?fileName=&title=&description=.
journal.get('/:ref/attachments', ...run((c, req) => JE.files(c, req.params.ref)));
journal.post('/:ref/attachments', express.raw({ type: (r) => !/json/.test(r.headers['content-type'] || ''), limit: '11mb' }),
  ...run((c, req) => {
    const raw = Buffer.isBuffer(req.body);
    const meta = raw ? req.query : (req.body || {});
    return JE.attach(c, req.params.ref, { title: meta.title, description: meta.description, fileName: meta.fileName,
      data: raw ? req.body : meta.content, createdBy: req.auth.email });
  }, { write: true, status: 201 }));
for (const [path, disposition] of [['download', 'attachment'], ['preview', 'inline']]) {
  journal.get(`/:ref/attachments/:attachmentId/${path}`, requireAuth(), async (req, res, next) => {
    try {
      const f = await withTenantRead(req.tenant.schema_name, (c) => JE.file(c, req.params.ref, req.params.attachmentId));
      const how = disposition === 'inline' && !f.previewable ? 'attachment' : disposition;
      res.set('content-type', f.contentType);
      res.set('content-disposition', `${how}; filename="${f.fileName.replace(/"/g, '')}"`);
      res.set('x-content-type-options', 'nosniff');
      res.set('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
      res.send(f.data);
    } catch (e) { next(e); }
  });
}

// --------------------------------------------------------------------------
// The interest accrual breakdown search (POST /accounting/interestaccrual:search)
// --------------------------------------------------------------------------

const searchAccruals = run(async (c, req, res) => {
  const body = req.body || {};
  const pg = pageParams({ ...req.query, ...body });
  const out = await ACR.searchBreakdown(c, { body, ...pg, branches: limited(req) ? req.auth.branches : null, today: await orgToday(c) });
  return paged(req, res, out, pg);
});

module.exports = { glaccounts, journal, searchJournal, searchAccruals };
