'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const DD = require('../domain/dataDictionary');
const EX = require('../domain/extract');
const IMP = require('../domain/dataImport');
const ORG = require('../domain/organization');
const backup = require('../ops/tenantBackup');
const runner = require('../ops/importRunner');
const { once } = require('../lib/idempotency');
const { filePart } = require('../lib/multipart');

/**
 * Data management (the reference platform's Data and Reporting > Data Management): the data
 * dictionary, the tenant's database backup, the incremental extract and the
 * Excel data import. Mounted by the server under /api.
 */

const OWNER = ['TENANT_ADMIN'];
const DATA = ['TENANT_ADMIN', 'ACCOUNTANT', 'AUDITOR'];
const IMPORTERS = ['TENANT_ADMIN', 'MANAGER'];
const IMPORT_READERS = ['TENANT_ADMIN', 'MANAGER', 'AUDITOR'];
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const run = (fn, roles = [], { write = false, status = 200 } = {}) => [requireAuth(...roles), async (req, res, next) => {
  try {
    const out = await (write ? withTenant : withTenantRead)(req.tenant.schema_name, (c) => fn(c, req, res));
    if (out !== undefined) res.status(status).json(out);
  } catch (e) { next(e); }
}];
const safeName = (s) => String(s || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
function sendFile(res, { data, fileName, type }) {
  res.set('content-type', type);
  res.set('content-disposition', `attachment; filename="${safeName(fileName)}"`);
  res.set('x-content-type-options', 'nosniff');
  res.set('cache-control', 'no-store');
  res.send(data);
}

// --- data dictionary --------------------------------------------------------

const dictionary = express.Router();
dictionary.get('/', requireAuth(), async (req, res, next) => {
  try {
    const dict = await withTenantRead(req.tenant.schema_name, (c) => DD.build(c));
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      return sendFile(res, { data: DD.toCsv(dict), fileName: `${req.tenant.slug}-data-dictionary.csv`, type: 'text/csv; charset=utf-8' });
    }
    res.json(dict);
  } catch (e) { next(e); }
});
dictionary.get('/:table', ...run((c, req) => DD.table(c, req.params.table)));
// Write the words into the schema's catalog as comments (also done by every migration).
dictionary.post('/apply-comments', ...run((c) => DD.applyComments(c), OWNER, { write: true }));

// --- incremental extract -------------------------------------------------------

const extract = express.Router();
extract.get('/', ...run((c) => EX.streams(c), DATA));
extract.get('/:stream', ...run((c, req) => EX.read(c, req.params.stream, {
  cursor: req.query.cursor || null, since: req.query.since || null, limit: req.query.limit,
}), DATA));

// --- database backup (the reference platform: POST /database/backup, GET /database/backup/LATEST) ---

const database = express.Router();
database.post('/backup', requireAuth(...OWNER), async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await backup.request(req.tenant, {
      tables: b.tables ?? null, fromDate: b.createBackupFromDate ?? b.fromDate ?? null, callback: b.callback ?? null,
    }, { createdBy: req.auth.email });
    res.status(202).json({ ...row, state: row.status });
  } catch (e) { next(e); }
});
database.get('/backup', ...run((c, req) => backup.list(c, { limit: req.query.limit }), OWNER, { write: true }));
async function download(req, res, next) {
  try {
    const f = await withTenant(req.tenant.schema_name, (c) => backup.file(c, req.params.id || 'latest'));
    res.set('x-backup-id', f.id);
    res.set('x-backup-sha256', f.sha256);
    sendFile(res, { data: f.data, fileName: f.file_name, type: 'application/zip' });
  } catch (e) { next(e); }
}
// LATEST is the file itself, as in the reference platform; the others are the record and its file.
database.get('/backup/latest', requireAuth(...OWNER), download);
database.get('/backup/LATEST', requireAuth(...OWNER), download);
database.get('/backup/:id', ...run((c, req) => backup.get(c, req.params.id), OWNER, { write: true }));
database.get('/backup/:id/file', requireAuth(...OWNER), download);

// --- Excel data import ---------------------------------------------------------

const imports = express.Router();
imports.get('/template', requireAuth(...IMPORTERS), async (req, res, next) => {
  try {
    const today = ORG.localClock(req.tenant.timezone || 'Africa/Nairobi').date;
    const data = await withTenantRead(req.tenant.schema_name, (c) => IMP.template(c, { today }));
    sendFile(res, { data, fileName: `${req.tenant.slug}-data-import-template.xlsx`, type: XLSX_TYPE });
  } catch (e) { next(e); }
});
// What should be set up before an import (the reference platform's prerequisites).
imports.get('/prerequisites', ...run((c) => IMP.prerequisites(c), IMPORT_READERS));
imports.get('/', ...run(async (c, req) => { await IMP.markStale(c); return IMP.list(c, { limit: req.query.limit }); }, IMPORT_READERS, { write: true }));

/**
 * Store the workbook and start its validation in the background. Returns
 * 202 with the import QUEUED; poll GET /:id for its progress. ?wait=true
 * waits for the outcome and returns it (201), for scripts.
 */
async function acceptUpload(req, { buffer, fileName }) {
  const imp = await withTenant(req.tenant.schema_name, (c) => IMP.submit(c, { buffer, fileName }, { createdBy: req.auth.email }));
  const job = runner.start(req.tenant, imp.id, { user: req.auth });
  if (String(req.query.wait || '') === 'true') {
    await job;
    return { status: 201, body: await withTenantRead(req.tenant.schema_name, (c) => IMP.get(c, imp.id)) };
  }
  return { status: 202, body: imp };
}
const rawBody = express.raw({ type: () => true, limit: IMP.MAX_FILE });
const tooLarge = (e, next) => (e.type === 'entity.too.large'
  ? next(Object.assign(new Error(`FILE_TOO_LARGE: the limit is ${IMP.MAX_FILE} bytes`), { status: 413 })) : next(e));

// The workbook is the request body (the .xlsx type, or application/octet-
// stream), its name in X-File-Name or ?fileName=; or a multipart form with
// the file in the field "file".
function workbookFrom(req) {
  if (/multipart\/form-data/i.test(req.get('content-type') || '')) {
    const part = filePart(req.body, req.get('content-type'), 'file');
    if (!part) throw Object.assign(new Error('SEND_THE_WORKBOOK_IN_THE_FORM_FIELD_file'), { status: 400 });
    return { buffer: part.data, fileName: part.fileName };
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('SEND_THE_WORKBOOK_AS_THE_REQUEST_BODY'), { status: 400 });
  return { buffer: req.body, fileName: req.get('x-file-name') || req.query.fileName };
}
imports.post('/', requireAuth(...IMPORTERS), (req, res, next) => rawBody(req, res, (e) => (e ? tooLarge(e, next) : next())),
  async (req, res, next) => {
    try {
      const out = await acceptUpload(req, workbookFrom(req));
      res.status(out.status).json(out.body);
    } catch (e) { next(e); }
  });
imports.get('/:id', ...run(async (c, req) => { await IMP.markStale(c); return IMP.get(c, req.params.id); }, IMPORT_READERS, { write: true }));
// The records approval would create, by kind: ?kind=loans&offset=&limit=.
imports.get('/:id/preview', ...run((c, req) => IMP.previewOf(c, req.params.id, {
  kind: req.query.kind || null, offset: req.query.offset, limit: req.query.limit,
}), IMPORT_READERS));
imports.get('/:id/file', requireAuth(...IMPORT_READERS), async (req, res, next) => {
  try {
    const f = await withTenantRead(req.tenant.schema_name, (c) => IMP.fileOf(c, req.params.id, 'file'));
    sendFile(res, { ...f, type: XLSX_TYPE });
  } catch (e) { next(e); }
});
imports.get('/:id/errors', requireAuth(...IMPORT_READERS), async (req, res, next) => {
  try {
    const f = await withTenantRead(req.tenant.schema_name, (c) => IMP.fileOf(c, req.params.id, 'errors'));
    sendFile(res, { ...f, type: XLSX_TYPE });
  } catch (e) { next(e); }
});
/** Approve or reject, as { status, body }: a failed approval is 409 with its reasons. */
async function decide(c, req, id, action) {
  const note = req.body?.note || null;
  if (action === 'REJECT') return { status: 200, body: await IMP.reject(c, id, { createdBy: req.auth.email, note }) };
  const out = await IMP.approve(c, id, { createdBy: req.auth.email, user: req.auth, note });
  // Nothing was created, and the import is FAILED with the reasons.
  if (out.failed) return { status: 409, body: { errors: [{ errorCode: 409, errorReason: 'IMPORT_FAILED' }], importErrors: out.errors, import: out.import } };
  return { status: 200, body: out };
}
imports.post('/:id/approve', requireAuth(...OWNER), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, (c) => once(c, req, `approve:${req.params.id}`, () => decide(c, req, req.params.id, 'APPROVE')));
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
});
imports.post('/:id/reject', requireAuth(...OWNER), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, (c) => once(c, req, `reject:${req.params.id}`, () => decide(c, req, req.params.id, 'REJECT')));
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
});

// --- The reference platform's data import API ------------------------------------------------------
//
// POST /data/import                                 the workbook -> { importKey, state }
// GET  /data/import/{importKey}                     { importKey, state, eventKey, errors }
// POST /data/import/events/{eventKey}:action        { action: APPROVE | REJECT }, Idempotency-Key
//
// The same imports as /data-imports, in the reference platform's shapes and names.

const reference = express.Router();
reference.post('/import', requireAuth(...IMPORTERS), (req, res, next) => rawBody(req, res, (e) => (e ? tooLarge(e, next) : next())),
  async (req, res, next) => {
    try {
      const out = await acceptUpload(req, workbookFrom(req));
      const imp = out.body;
      res.status(200).json(IMP.apiStatus(imp));
    } catch (e) { next(e); }
  });
reference.get('/import/:importKey', ...run(async (c, req) => {
  await IMP.markStale(c);
  return IMP.apiStatus(await IMP.get(c, req.params.importKey));
}, IMPORT_READERS, { write: true }));
// Express 5 does not match a colon suffix in a path string, so the route is a RegExp.
reference.post(/^\/import\/events\/([^/:]+):action$/, requireAuth(...OWNER), async (req, res, next) => {
  try {
    const eventKey = req.params[0];
    const action = String(req.body?.action || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(action)) return next(Object.assign(new Error('ACTION_MUST_BE_APPROVE_OR_REJECT'), { status: 400 }));
    const out = await withTenant(req.tenant.schema_name, (c) => once(c, req, `import-event:${eventKey}`, () => decide(c, req, eventKey, action)));
    if (out.status !== 200) return res.status(out.status).json(out.body);
    res.status(200).json(IMP.apiStatus(out.body));
  } catch (e) { next(e); }
});

module.exports = { dictionary, extract, database, imports, reference };
