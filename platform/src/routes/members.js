'use strict';

const { orgToday } = require('../lib/orgDate');
const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { notFound, paginate, withPaginationHeaders, applyFilterCriteria } = require('../lib/http');
const { pageQuery, sendPage } = require('../lib/page');
const HIST = require('../domain/loanHistory');
const CF = require('../domain/customFields');
const IDT = require('../domain/idTemplates');
const CL = require('../domain/clients');
const PERMS = require('../lib/permissions');
const MF = require('../domain/memberFiles');

const router = express.Router();

/**
 * Members (the platform's own shape; the reference platform's is /api/clients and
 * /api/groups, ./clients). The rules are in ../domain/clients.
 *
 * Note what is absent: no tenant_id in any WHERE clause. The transaction's
 * search_path already points at exactly one SACCO's schema, so there is no
 * such thing as forgetting the tenant filter here.
 *
 * The list holds individuals; ?holderType=GROUP lists groups and ALL both.
 */

const { COLUMNS } = CL;

const holderFilter = (v) => {
  const s = String(v || 'CLIENT').toUpperCase();
  return s === 'ALL' ? null : s === 'GROUP' ? 'GROUP' : 'CLIENT';
};

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const q = req.query.q ? `%${String(req.query.q).toLowerCase().replace(/[\\%_]/g, '\\$&')}%` : null;
    const qid = req.query.q ? CL.docKey(req.query.q) : null;
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT ${COLUMNS} FROM members
       WHERE ($1::text IS NULL OR status = $1::text)
         AND ($3::text IS NULL OR holder_type = $3::text)
         AND ($2::text IS NULL OR
              lower(first_name) LIKE $2::text OR lower(last_name) LIKE $2::text OR lower(middle_name) LIKE $2::text OR
              lower(member_no) LIKE $2::text OR phone LIKE $2::text OR lower(email) LIKE $2::text OR
              upper(regexp_replace(national_id, '[\\s-]', '', 'g')) = $4::text)
       ORDER BY last_name, first_name, id`,
      [req.query.status || null, q, holderFilter(req.query.holderType), qid],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

// Exported and mounted by the parent as POST /members:search — Express 5
// cannot match a colon suffix inside a sub-router path.
// The filter operators run in JavaScript, so this one has to materialise
// rows before it can filter them. It is bounded rather than unbounded: a
// scan cap keeps one client from pulling a 40,000-member register into
// memory, and the response says plainly when the scan was cut short instead
// of quietly returning a subset as if it were the whole answer. The reference platform's
// field names and custom fields are searched in SQL by POST /clients:search.
const SEARCH_SCAN_CAP = 5000;

const searchMembers = [requireAuth(), async (req, res, next) => {
  try {
    let today = null;
    const rows = await withTenantRead(req.tenant.schema_name, async (c) => {
      today = await orgToday(c);
      return (await c.query(
        `SELECT ${COLUMNS} FROM members WHERE holder_type = 'CLIENT' ORDER BY last_name, first_name, id LIMIT $1`,
        [SEARCH_SCAN_CAP + 1]
      )).rows;
    });
    const truncated = rows.length > SEARCH_SCAN_CAP;
    const filtered = applyFilterCriteria(rows.slice(0, SEARCH_SCAN_CAP), req.body?.filterCriteria, { today });
    const p = paginate(req, filtered);
    res.set('items-scan-cap', String(SEARCH_SCAN_CAP));
    res.set('items-truncated', String(truncated));
    withPaginationHeaders(res, p).json(p.page);
  } catch (e) { next(e); }
}];

// POST /members:duplicates: the duplicate checks for a member about to be
// created or changed, without saving anything (the console asks before it
// saves a member that has warnings).
const checkDuplicates = [requireAuth(), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await withTenantRead(req.tenant.schema_name, async (c) => CL.duplicates(c, {
      holder_type: 'CLIENT', first_name: b.firstName || null, last_name: b.lastName || null,
      national_id: b.nationalId ? CL.normId(b.nationalId) : null, date_of_birth: b.dateOfBirth || null,
      phone: b.phone || null, phone2: b.phone2 || null, email: b.email || null,
    }, {
      docs: (b.identificationDocuments || []).filter((d) => d && d.documentId).map((d) => ({ document_id: String(d.documentId) })),
      exclude: b.memberId && /^[0-9a-f-]{36}$/i.test(b.memberId) ? b.memberId : null,
    }));
    res.json(out);
  } catch (e) { next(e); }
}];

// POST /members:reassign: branch, centre and credit officer for many members at once.
const reassignMembers = [requireAuth(), async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await withTenant(req.tenant.schema_name, (c) => CL.reassign(c, b.members || b.memberIds, b, { user: req.auth })));
  } catch (e) { next(e); }
}];

async function detail(c, m, user) {
  const cf = await CF.getValues(c, m.holder_type === 'GROUP' ? 'GROUP' : 'MEMBER', m.id, { user });
  const out = { ...m, customFields: cf.values, customFieldScores: cf.scores, media: await MF.mediaOf(c, m.id) };
  out.expiredIdDocuments = (await c.query('SELECT count(*)::int AS n FROM member_identifications WHERE member_id = $1 AND valid_until < current_date', [m.id])).rows[0].n;
  if (m.holder_type === 'GROUP') out.groupMembers = await CL.groupMembers(c, m.id);
  else out.groups = await CL.groupsOf(c, m.id);
  return out;
}

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const row = await withTenantRead(req.tenant.schema_name, async (c) => {
      const { rows: [m] } = await c.query(
        `SELECT ${COLUMNS} FROM members WHERE ${/^[0-9a-f-]{36}$/i.test(req.params.id) ? 'id = $1::uuid' : 'member_no = $1'}`, [req.params.id]);
      return m ? detail(c, m, req.auth) : null;
    });
    return row ? res.json(row) : notFound(res, 'member');
  } catch (e) { next(e); }
});

// The member's loan history: closed loans, the largest approved, on-time
// repayment rates and completed loan cycles (./loanHistory).
router.get('/:id/loan-history', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => HIST.forMember(c, req.params.id)));
  } catch (e) { next(e); }
});

router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const b = req.body || {};
    const holderType = String(b.holderType || 'CLIENT').toUpperCase() === 'GROUP' ? 'GROUP' : 'CLIENT';
    if (holderType === 'GROUP' && !PERMS.can(req.auth, 'CREATE_GROUP')) {
      const e = new Error('PERMISSION_REQUIRED: CREATE_GROUP'); e.status = 403; throw e;
    }
    const out = await withTenant(req.tenant.schema_name, (c) => CL.create(c, b, { user: req.auth, holderType }));
    res.status(201).json({ ...out.member, duplicateWarnings: out.duplicateWarnings, groupWarnings: out.groupWarnings });
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth(), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, (c) => CL.update(c, req.params.id, req.body || {}, { user: req.auth }));
    res.json({ ...out.member, duplicateWarnings: out.duplicateWarnings, groupWarnings: out.groupWarnings });
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenant(req.tenant.schema_name, (c) => CL.remove(c, req.params.id, { user: req.auth })));
  } catch (e) { next(e); }
});

// State actions: { action: APPROVE | UNDO_APPROVE | REJECT | UNDO_REJECT | EXIT | UNDO_EXIT | BLACKLIST | UNDO_BLACKLIST, reason }.
router.post('/:id/state', requireAuth(), async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await withTenant(req.tenant.schema_name, (c) => CL.changeState(c, req.params.id, b.action, { reason: b.reason, user: req.auth })));
  } catch (e) { next(e); }
});

router.get('/:id/state-history', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => CL.stateHistory(c, req.params.id)));
  } catch (e) { next(e); }
});

router.post('/:id/association', requireAuth(), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, (c) => CL.reassign(c, [req.params.id], req.body || {}, { user: req.auth }));
    res.json(out.members[0]);
  } catch (e) { next(e); }
});

router.post('/:id/anonymize', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenant(req.tenant.schema_name, (c) => CL.anonymize(c, req.params.id, { user: req.auth })));
  } catch (e) { next(e); }
});

router.get('/:id/groups', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, async (c) => CL.groupsOf(c, (await CL.find(c, req.params.id)).id)));
  } catch (e) { next(e); }
});

// Identification documents (./idTemplates).
const txn = (fn, { write = true, status = 200 } = {}) => [requireAuth(), async (req, res, next) => {
  try {
    const out = await (write ? withTenant : withTenantRead)(req.tenant.schema_name, (c) => fn(c, req, res));
    if (out !== undefined) res.status(status).json(out);
  } catch (e) { next(e); }
}];
router.get('/:id/identifications', ...txn(async (c, req) => MF.withExpiry(await IDT.documents(c, req.params.id), await orgToday(c)), { write: false }));
router.post('/:id/identifications', ...txn((c, req) => IDT.addDocument(c, req.params.id, req.body || {}, { createdBy: req.auth.email }), { status: 201 }));
router.delete('/:id/identifications/:docId', ...txn((c, req) => IDT.removeDocument(c, req.params.id, req.params.docId, { createdBy: req.auth.email })));
router.get('/:id/identifications/:docId/attachment', requireAuth(), async (req, res, next) => {
  try {
    const a = await withTenantRead(req.tenant.schema_name, (c) => IDT.attachment(c, req.params.id, req.params.docId));
    res.set('content-type', a.attachment_type);
    res.set('content-disposition', `attachment; filename="${String(a.attachment_name).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.set('x-content-type-options', 'nosniff');
    res.send(a.attachment);
  } catch (e) { next(e); }
});

// Files as the raw request body (a picture, a signature, a document file), up to 50 MB.
const rawFile = express.raw({ type: (r) => !/json/.test(r.headers['content-type'] || ''), limit: MF.MAX_BYTES + 1024 });
const sendFile = (res, f, { inline = true } = {}) => {
  res.set('content-type', f.content_type);
  res.set('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(f.file_name || 'file').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.set('x-content-type-options', 'nosniff');
  res.send(f.content);
};

// The member's picture and signature (the reference platform's profile picture and client signature).
for (const kind of ['picture', 'signature']) {
  router.put(`/:id/${kind}`, rawFile, ...txn((c, req) => MF.putMedia(c, req.params.id, kind, req.body, { fileName: req.query.fileName, actor: req.auth.email })));
  router.get(`/:id/${kind}`, requireAuth(), async (req, res, next) => {
    try { sendFile(res, await withTenantRead(req.tenant.schema_name, (c) => MF.getMedia(c, req.params.id, kind))); } catch (e) { next(e); }
  });
  router.delete(`/:id/${kind}`, ...txn((c, req) => MF.removeMedia(c, req.params.id, kind, { actor: req.auth.email })));
}

// Files on an identification document: up to five, each up to 50 MB (the reference platform's limits).
router.get('/:id/identifications/:docId/files', ...txn((c, req) => MF.listFiles(c, req.params.id, req.params.docId), { write: false }));
router.post('/:id/identifications/:docId/files', rawFile, ...txn((c, req) => MF.addFile(c, req.params.id, req.params.docId, req.body,
  { fileName: req.query.fileName, actor: req.auth.email }), { status: 201 }));
router.get('/:id/identifications/:docId/files/:fileId', requireAuth(), async (req, res, next) => {
  try {
    sendFile(res, await withTenantRead(req.tenant.schema_name, (c) => MF.getFile(c, req.params.id, req.params.docId, req.params.fileId)), { inline: false });
  } catch (e) { next(e); }
});
router.delete('/:id/identifications/:docId/files/:fileId', ...txn((c, req) => MF.removeFile(c, req.params.id, req.params.docId, req.params.fileId, { actor: req.auth.email })));

module.exports = router;
module.exports.searchMembers = searchMembers;
module.exports.checkDuplicates = checkDuplicates;
module.exports.reassignMembers = reassignMembers;
