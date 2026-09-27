'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const DD = require('../domain/dataDictionary');
const EX = require('../domain/extract');
const IMP = require('../domain/dataImport');
const ORG = require('../domain/organization');
const backup = require('../ops/tenantBackup');

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
imports.get('/', ...run((c, req) => IMP.list(c, { limit: req.query.limit }), IMPORT_READERS));
// The workbook is the request body (Content-Type: the .xlsx type, or
// application/octet-stream), its name in X-File-Name or ?fileName=.
imports.post('/', requireAuth(...IMPORTERS),
  express.raw({ type: () => true, limit: IMP.MAX_FILE }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return next(Object.assign(new Error('SEND_THE_WORKBOOK_AS_THE_REQUEST_BODY'), { status: 400 }));
      }
      const today = ORG.localClock(req.tenant.timezone || 'Africa/Nairobi').date;
      const out = await withTenant(req.tenant.schema_name, (c) => IMP.upload(c,
        { buffer: req.body, fileName: req.get('x-file-name') || req.query.fileName },
        { createdBy: req.auth.email, user: req.auth, today }));
      res.status(201).json(out);
    } catch (e) {
      if (e.type === 'entity.too.large') return next(Object.assign(new Error(`FILE_TOO_LARGE: the limit is ${IMP.MAX_FILE} bytes`), { status: 413 }));
      next(e);
    }
  });
imports.get('/:id', ...run((c, req) => IMP.get(c, req.params.id), IMPORT_READERS));
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
imports.post('/:id/approve', requireAuth(...OWNER), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, (c) => IMP.approve(c, req.params.id,
      { createdBy: req.auth.email, user: req.auth, note: req.body?.note || null }));
    // Nothing was created, and the import is FAILED with the reasons.
    if (out.failed) {
      return res.status(409).json({ errors: [{ errorCode: 409, errorReason: 'IMPORT_FAILED' }], importErrors: out.errors, import: out.import });
    }
    res.json(out);
  } catch (e) { next(e); }
});
imports.post('/:id/reject', ...run((c, req) => IMP.reject(c, req.params.id, { createdBy: req.auth.email, note: req.body?.note || null }),
  OWNER, { write: true }));

module.exports = { dictionary, extract, database, imports };
