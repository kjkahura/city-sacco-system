#!/usr/bin/env node
'use strict';

/**
 * Roles and permissions, menus, report templates and grouped custom fields
 * in views: the built-in roles and their defaults, a tenant's own role,
 * permissions given to one user, changes that take effect at once; the
 * navigation and menu items with views; report templates in place of
 * Jasper (checked on upload, shown by type and role, run to HTML, PDF,
 * Excel and CSV with the reader's permissions); a grouped set in a view.
 */

const { orgDay } = require('./_org');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const L = require('../src/domain/loans');
const XLSX = require('../src/lib/xlsx');
const PERMS = require('../src/lib/permissions');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'acctest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4109;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);

const tokens = {};
async function call(method, p, body, { who = 'admin', raw = false } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text, headers: r.headers, reason: d?.errors?.[0]?.errorReason || '' };
}

/** The text a PDF shows, from its content streams (uncompressed here). */
function pdfText(buf) {
  const s = buf.toString('latin1');
  return [...s.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join(' ');
}

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Access SACCO', mfaRequiredRoles: [], adminEmail: 'admin@acc.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    tokens.admin = (await call('POST', '/api/auth/login', { email: 'admin@acc.local', password: PASSWORD })).body.accessToken;
    const br = await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const users = {};
    for (const [who, role] of [['teller', 'TELLER'], ['officer', 'TELLER'], ['manager', 'MANAGER'], ['auditor', 'AUDITOR']]) {
      const u = await call('POST', '/api/users', { email: `${who}@acc.local`, fullName: `The ${who}`, role, password: `First password 2026 ${who.length}`, branchId: br.body.id,
        userType: who === 'officer' ? 'CREDIT_OFFICER' : undefined });
      users[who] = u.body;
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE lower(email) = $1', [`${who}@acc.local`]);
      tokens[who] = (await call('POST', '/api/auth/login', { email: `${who}@acc.local`, password: `First password 2026 ${who.length}` })).body?.accessToken;
    }
    check('staff signed in', tokens.teller && tokens.officer && tokens.manager && tokens.auditor);
    const m1 = await T(async (c) => (await c.query(
      `INSERT INTO members (member_no, first_name, last_name, gender, branch_id, credit_officer) VALUES ('A0001','Achieng','Odhiambo','FEMALE',$1,'officer@acc.local') RETURNING *`,
      [br.body.id])).rows[0]);
    const m2 = await T(async (c) => (await c.query(
      `INSERT INTO members (member_no, first_name, last_name, gender, branch_id) VALUES ('A0002','Brian','Otieno','MALE',$1) RETURNING *`, [br.body.id])).rows[0]);
    await T(async (c) => {
      const a = await S.open(c, { memberId: m1.id });
      await S.deposit(c, a.id, { amount: 8000, channelId: 'cash', createdBy: 'test' });
      const b = await S.open(c, { memberId: m2.id });
      await S.deposit(c, b.id, { amount: 3000, channelId: 'cash', createdBy: 'test' });
    });
    await call('POST', '/api/loan-products', { id: 'AC1', name: 'Access loan', glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200', method: 'FLAT', monthlyRate: 1, maxTerm: 24, enforceDepositMultiplier: false });
    await T(async (c) => {
      const l = await L.apply(c, { memberId: m1.id, productId: 'AC1', principal: 5000, termMonths: 5, createdBy: 'officer' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
      await L.disburse(c, l.id, { amount: 5000, channelId: 'bank', valueDate: orgDay(-5), createdBy: 'teller' });
    });

    // ------------------------------------------------------------------------
    section('roles and permissions');
    const cat = await call('GET', '/api/roles/permissions');
    check('the permission catalog, in groups, with the reference platform\'s codes', cat.status === 200 && cat.body.some((g) => g.group === 'Tellering' && g.permissions.some((p) => p.code === 'OPEN_TILL' && p.enforced)));
    const roles = await call('GET', '/api/roles');
    const byCode = Object.fromEntries(roles.body.map((r) => [r.code, r]));
    check('the five built-in roles, with their defaults and how many hold them', ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'].every((k) => byCode[k] && byCode[k].builtin)
      && byCode.TELLER.users === 2 && byCode.TENANT_ADMIN.permissions.length === PERMS.CATALOG.length && !byCode.TELLER.permissions.includes('VIEW_REPORTS'), JSON.stringify(byCode.TELLER));
    const tellerMe = await call('GET', '/api/auth/me', null, { who: 'teller' });
    check('a user\'s permissions are in /auth/me', Array.isArray(tellerMe.body.permissions) && tellerMe.body.permissions.includes('VIEW_TASK') && !tellerMe.body.permissions.includes('VIEW_REPORTS'));
    const tellerPar = await call('GET', '/api/reports/portfolio-at-risk', null, { who: 'teller' });
    check('a teller may not see reports', tellerPar.status === 403 && /PERMISSION_REQUIRED: VIEW_REPORTS/.test(tellerPar.reason), tellerPar.text);
    const tellerRoles = await call('GET', '/api/roles', null, { who: 'teller' });
    check('nor roles (VIEW_ROLE)', tellerRoles.status === 403);
    const noAdminEdit = await call('PATCH', '/api/roles/TENANT_ADMIN', { permissions: [] });
    check('the administrator role holds every permission and is not edited', noAdminEdit.status === 409);
    const unknown = await call('POST', '/api/roles', { name: 'Odd', baseRole: 'TELLER', permissions: ['FLY'] });
    check('an unknown permission is refused', unknown.status === 400 && /UNKNOWN_PERMISSIONS: FLY/.test(unknown.reason));
    const lo = await call('POST', '/api/roles', {
      name: 'Loan officer', code: 'LOAN_OFFICER', baseRole: 'TELLER', userType: 'CREDIT_OFFICER',
      permissions: [...PERMS.DEFAULTS.TELLER, 'VIEW_REPORTS', 'VIEW_INTELLIGENCE'], notes: 'Field staff',
    });
    check('a tenant role of its own, based on the teller role', lo.status === 201 && lo.body.baseRole === 'TELLER' && lo.body.userType === 'CREDIT_OFFICER', lo.text);
    const dup = await call('POST', '/api/roles', { name: 'loan officer', baseRole: 'TELLER' });
    check('role names are unique', dup.status === 409);
    const assign = await call('PATCH', `/api/users/${users.officer.id}`, { role: 'LOAN_OFFICER' });
    check('given to a user, who keeps the teller base role', assign.status === 200 && assign.body.role === 'TELLER' && assign.body.role_code === 'LOAN_OFFICER', assign.text);
    const loPar = await call('GET', '/api/reports/portfolio-at-risk', null, { who: 'officer' });
    const loBs = await call('GET', '/api/reports/balance-sheet', null, { who: 'officer' });
    check('the officer now sees reports at once, not accounting reports', loPar.status === 200 && loBs.status === 403, `${loPar.status} ${loBs.status}`);
    const extra = await call('PATCH', `/api/users/${users.officer.id}`, { permissions: ['VIEW_ACCOUNTING_REPORTS'] });
    const loBs2 = await call('GET', '/api/reports/balance-sheet', null, { who: 'officer' });
    check('a permission given to the user alone adds to the role\'s', extra.status === 200 && loBs2.status === 200, loBs2.text);
    const selfEdit = await call('PATCH', `/api/users/${users.manager.id}`, { permissions: ['VIEW_ROLE'] }, { who: 'manager' });
    check('only an administrator changes a user\'s access', selfEdit.status === 403);
    const editTeller = await call('PATCH', '/api/roles/TELLER', { permissions: [...byCode.TELLER.permissions, 'VIEW_REPORTS'] });
    const tellerPar2 = await call('GET', '/api/reports/portfolio-at-risk', null, { who: 'teller' });
    check('editing a built-in role changes its holders\' access at once', editTeller.status === 200 && editTeller.body.edited && tellerPar2.status === 200, tellerPar2.text);
    const inUse = await call('DELETE', '/api/roles/LOAN_OFFICER');
    const builtin = await call('DELETE', '/api/roles/TELLER');
    check('a role in use, or a built-in role, is not deleted', inUse.status === 409 && /ROLE_IN_USE/.test(inUse.reason) && builtin.status === 409);
    const move = await call('PATCH', '/api/roles/LOAN_OFFICER', { baseRole: 'MANAGER' });
    const moved = await pool.query('SELECT role FROM platform.users WHERE id = $1', [users.officer.id]);
    const approve = await call('GET', '/api/users', null, { who: 'officer' });
    check('moving the role to another base role moves its users', move.status === 200 && moved.rows[0].role === 'MANAGER', move.text);
    check('and its permissions, not the base role, decide what they may do', approve.status === 403 && /VIEW_USER_DETAILS/.test(approve.reason), approve.text.slice(0, 200));
    await call('PATCH', '/api/roles/LOAN_OFFICER', { baseRole: 'TELLER' });
    const back = await call('PATCH', `/api/users/${users.manager.id}`, { role: 'NOT_A_ROLE' });
    check('a user\'s role is a built-in role or one of the tenant\'s', back.status === 400 && /ROLE_MUST_BE_ONE_OF/.test(back.reason));

    section('views shared with a tenant role');
    const v = await call('POST', '/api/views', { entity: 'MEMBERS', name: 'Officer\'s members', columns: ['memberNo', 'fullName'], filters: [{ field: 'creditOfficer', operator: 'EQUALS', value: 'officer@acc.local' }], usageRights: { roles: ['LOAN_OFFICER'] } });
    check('an administrator shares a view with the tenant role', v.status === 201 && v.body.usageRights.roles[0] === 'LOAN_OFFICER', v.text);
    const seesIt = await call('GET', `/api/views/${v.body.id}/run`, null, { who: 'officer' });
    const tellerNo = await call('GET', `/api/views/${v.body.id}`, null, { who: 'teller' });
    check('its holders see it; the rest of the base role does not', seesIt.status === 200 && seesIt.body.total === 1 && tellerNo.status === 404, seesIt.text);
    const badRole = await call('POST', '/api/views', { entity: 'MEMBERS', name: 'x', usageRights: { roles: ['NOBODY'] } });
    check('a view is shared only with roles that exist', badRole.status === 400 && /INVALID_ROLES/.test(badRole.reason));
    const noExport = await call('PATCH', `/api/users/${users.auditor.id}`, { role: 'AUDITOR' });
    await call('PATCH', '/api/roles/AUDITOR', { permissions: PERMS.DEFAULTS.AUDITOR.filter((p) => p !== 'EXPORT_TO_EXCEL') });
    const exp = await call('GET', '/api/reports/portfolio-at-risk?format=csv', null, { who: 'auditor' });
    const expJson = await call('GET', '/api/reports/portfolio-at-risk', null, { who: 'auditor' });
    check('without EXPORT_TO_EXCEL a report shows but does not download', noExport.status === 200 && exp.status === 403 && /EXPORT_TO_EXCEL/.test(exp.reason) && expJson.status === 200);

    // ------------------------------------------------------------------------
    section('menus');
    const nav = await call('GET', '/api/menu', null, { who: 'teller' });
    const navNames = nav.body.items.map((i) => i.name);
    check('the teller\'s navigation: the predefined items with views they may open', navNames.includes('Clients') && navNames.includes('Loans') && !navNames.includes('Activities'), navNames.join(','));
    check('and the items without views', nav.body.fixed.some((f) => f.key === 'dashboard') && nav.body.fixed.some((f) => f.key === 'reports'));
    const navAud = await call('GET', '/api/menu', null, { who: 'auditor' });
    check('an auditor has Activities (AUDIT_TRANSACTIONS)', navAud.body.items.some((i) => i.name === 'Activities'));
    const item = await call('POST', '/api/menu-items', { name: 'Collections desk', type: 'LOANS' }, { who: 'manager' });
    check('a manager makes a menu item of their own', item.status === 201 && item.body.type === 'LOANS', item.text);
    const long = await call('POST', '/api/menu-items', { name: 'x'.repeat(33), type: 'LOANS' }, { who: 'manager' });
    check('a menu item name is at most 32 characters (the reference platform)', long.status === 400);
    const share = await call('PATCH', `/api/menu-items/${item.body.id}`, { usageRights: { allUsers: true } }, { who: 'manager' });
    check('only an administrator shares it', share.status === 403);
    const lv = await call('POST', '/api/views', { entity: 'LOANS', name: 'Big loans', columns: ['accountNo', 'principal'], filters: [{ field: 'principal', operator: 'MORE_THAN', value: 1000 }], menuItemId: item.body.id }, { who: 'manager' });
    check('a view filed under it', lv.status === 201 && lv.body.menuItemId === item.body.id, lv.text);
    const wrongKind = await call('POST', '/api/views', { entity: 'MEMBERS', name: 'Wrong', menuItemId: item.body.id }, { who: 'manager' });
    check('a view goes under an item of its own kind', wrongKind.status === 400 && /MENU_ITEM_IS_FOR_LOANS/.test(wrongKind.reason));
    const navM = await call('GET', '/api/menu', null, { who: 'manager' });
    const desk = navM.body.items.find((i) => i.id === item.body.id);
    check('the navigation shows the item with its view', desk && desk.views.length === 1 && desk.views[0].name === 'Big loans');
    const navT = await call('GET', '/api/menu', null, { who: 'teller' });
    check('another user does not see it until it is shared', !navT.body.items.some((i) => i.id === item.body.id));
    await call('PATCH', `/api/menu-items/${item.body.id}`, { usageRights: { roles: ['TELLER'] } });
    await call('PATCH', `/api/views/${lv.body.id}`, { usageRights: { roles: ['TELLER'] } });
    const navT2 = await call('GET', '/api/menu', null, { who: 'teller' });
    check('shared by the administrator with tellers, it is there with its view', navT2.body.items.find((i) => i.id === item.body.id)?.views.length === 1);
    const predefined = navM.body.items.find((i) => i.predefined && i.type === 'LOANS');
    const delPre = await call('DELETE', `/api/menu-items/${predefined.id}`);
    check('a predefined item is not deleted', delPre.status === 409);
    const order = await call('PUT', '/api/menu-items/order', { ids: [item.body.id, predefined.id] });
    check('the administrator rearranges the menu', order.status === 200 && order.body[0].id === item.body.id, order.text.slice(0, 200));
    const delItem = await call('DELETE', `/api/menu-items/${item.body.id}`, null, { who: 'manager' });
    const orphan = await call('GET', `/api/views/${lv.body.id}`, null, { who: 'manager' });
    check('deleting an item leaves its views', delItem.status === 200 && orphan.status === 200 && orphan.body.menuItemId === null);

    // ------------------------------------------------------------------------
    section('report templates (in place of Jasper)');
    const bad = await call('POST', '/api/report-templates', { name: 'Broken', reportType: 'MEMBER', definition: { sections: [{ type: 'TABLE', view: { entity: 'LOANS', columns: ['nope'] } }, { type: 'TABLE', report: 'everything' }], parameters: [{ name: '1x' }] } }, { who: 'manager' });
    check('a template is checked on upload, with every problem listed', bad.status === 400 && /UNKNOWN_FIELD: nope/.test(bad.reason) && /report is one of/.test(bad.reason) && /parameter 1/.test(bad.reason), bad.reason);
    const sqlTry = await call('POST', '/api/report-templates', { name: 'Sneaky', reportType: 'OTHER', definition: { sections: [{ type: 'TABLE', sql: 'SELECT * FROM platform.users' }] } }, { who: 'manager' });
    check('a template has no place for SQL', sqlTry.status === 400);
    const def = {
      title: 'Statement for {{record.name}}',
      parameters: [{ name: 'from', label: 'From', type: 'DATE', default: 'MONTH_START' }, { name: 'minimum', type: 'NUMBER' }],
      sections: [
        { title: 'Deposit accounts', type: 'TABLE', view: { entity: 'DEPOSITS', columns: ['accountNo', 'productName', 'balance'], includeTotals: true, filters: [{ field: 'memberNo', operator: 'EQUALS', value: '{{record.memberNo}}' }] } },
        { title: 'Loans over {{param.minimum}}', type: 'TABLE', view: { entity: 'LOANS', columns: ['accountNo', 'status', 'principalOutstanding'], filters: [{ field: 'memberNo', operator: 'EQUALS', value: '{{record.memberNo}}' }, { field: 'principal', operator: 'MORE_THAN', value: '{{param.minimum}}' }] } },
        { title: 'Deposit transactions since {{param.from}}', type: 'TABLE', view: { entity: 'DEPOSIT_TRANSACTIONS', columns: ['valueDate', 'kind', 'amount'], filters: [{ field: 'memberNo', operator: 'EQUALS', value: '{{record.memberNo}}' }, { field: 'valueDate', operator: 'AFTER_INCLUSIVE', value: '{{param.from}}' }] } },
        { title: 'Note', type: 'TEXT', text: 'Printed on {{today}} by {{user.email}} for {{organization.name}}.' },
      ],
      footer: '{{organization.name}}',
    };
    const up = await call('POST', '/api/report-templates', { name: 'Member statement', reportType: 'MEMBER', definition: def, fileName: 'statement.json', usageRights: { allUsers: false, roles: ['MANAGER', 'LOAN_OFFICER'] } }, { who: 'manager' });
    check('a manager uploads a member report for managers and loan officers', up.status === 201 && up.body.reportType === 'MEMBER' && up.body.parameters.length === 2, up.text);
    const tellerUp = await call('POST', '/api/report-templates', { name: 'Mine', reportType: 'OTHER', definition: { sections: [{ type: 'TEXT', text: 'x' }] } }, { who: 'teller' });
    check('a teller cannot upload one (CREATE_REPORTS)', tellerUp.status === 403);
    const listM = await call('GET', '/api/report-templates?type=MEMBER', null, { who: 'officer' });
    const listT = await call('GET', '/api/report-templates?type=MEMBER', null, { who: 'teller' });
    check('it shows on members for the roles chosen, not for others', listM.body.length === 1 && listT.body.length === 0, `${listM.text} ${listT.text}`);
    const noRecord = await call('POST', `/api/report-templates/${up.body.id}/run`, {}, { who: 'officer' });
    check('a member report runs on a member', noRecord.status === 400 && /RECORD_REQUIRED/.test(noRecord.reason));
    const run = await call('POST', `/api/report-templates/${up.body.id}/run`, { recordId: 'A0001', parameters: { minimum: 1000 } }, { who: 'officer' });
    check('it runs for Achieng: title and sections filled in', run.status === 200 && run.body.title === 'Statement for Achieng Odhiambo' && run.body.sections.length === 4
      && run.body.sections[0].rows.length === 1 && run.body.sections[0].totals.balance === 8000 && run.body.sections[1].title === 'Loans over 1000' && run.body.sections[1].rows.length === 1, run.text.slice(0, 500));
    check('a date parameter takes its default', run.body.parameters.from === `${orgDay(0).slice(0, 7)}-01` && /since \d{4}-\d{2}-01/.test(run.body.sections[2].title));
    check('and the text its placeholders', /officer@acc\.local for Access SACCO/.test(run.body.sections[3].text));
    const empty = await call('POST', `/api/report-templates/${up.body.id}/run`, { recordId: 'A0001' }, { who: 'officer' });
    check('an empty optional parameter leaves its filter out', empty.body.sections[1].rows.length === 1, JSON.stringify(empty.body.sections[1]));
    const other = await call('POST', `/api/report-templates/${up.body.id}/run`, { recordId: 'A0002', parameters: { minimum: 1000 } }, { who: 'officer' });
    check('for Brian, his own accounts only', other.body.sections[0].rows.length === 1 && other.body.sections[0].totals.balance === 3000 && other.body.sections[1].rows.length === 0);
    const html = await call('GET', `/api/report-templates/${up.body.id}/run?format=html&recordId=A0001&minimum=1000`, null, { who: 'officer', raw: true });
    const h = html.buffer.toString();
    check('as HTML, a page that runs no scripts', html.status === 200 && /<h1>Statement for Achieng Odhiambo<\/h1>/.test(h) && /8,000\.00/.test(h) && /default-src 'none'/.test(html.headers.get('content-security-policy')), h.slice(0, 200));
    const pdfR = await call('POST', `/api/report-templates/${up.body.id}/run?format=pdf`, { recordId: 'A0001', parameters: { minimum: 1000 } }, { who: 'officer', raw: true });
    const pdfBuf = pdfR.buffer;
    check('as a PDF', pdfR.status === 200 && pdfBuf.slice(0, 5).toString() === '%PDF-' && /%%EOF\s*$/.test(pdfBuf.toString('latin1')) && pdfR.headers.get('content-type') === 'application/pdf');
    const text = pdfText(pdfBuf);
    check('which reads as the report', /Statement for Achieng Odhiambo/.test(text) && /Deposit accounts/.test(text) && /8,000/.test(text) && /Page 1 of 1/.test(text), text.slice(0, 300));
    const xref = pdfBuf.toString('latin1');
    const startxref = Number(xref.match(/startxref\n(\d+)/)[1]);
    check('with a cross-reference table where it says it is', xref.slice(startxref, startxref + 4) === 'xref');
    const xl = await call('POST', `/api/report-templates/${up.body.id}/run?format=xlsx`, { recordId: 'A0001', parameters: { minimum: 1000 } }, { who: 'officer', raw: true });
    const book = XLSX.read(xl.buffer);
    check('as a workbook: a sheet per section', xl.status === 200 && book.length === 5 && book[1].rows[1][2] === 8000, JSON.stringify(book.map((s) => s.name)));
    const csvR = await call('POST', `/api/report-templates/${up.body.id}/run?format=csv`, { recordId: 'A0001' }, { who: 'officer', raw: true });
    check('as CSV', csvR.status === 200 && /Deposit accounts/.test(csvR.buffer.toString()));
    const byTeller = await call('POST', `/api/report-templates/${up.body.id}/run`, { recordId: 'A0001' }, { who: 'teller' });
    check('a teller does not see it to run it', byTeller.status === 404);
    const other2 = await call('POST', '/api/report-templates', {
      name: 'Board pack', reportType: 'OTHER',
      definition: { parameters: [{ name: 'branch', type: 'BRANCH', required: true }], sections: [
        { title: 'Balance sheet', type: 'TABLE', report: 'balance-sheet', params: { branchId: '{{param.branch}}' } },
        { title: 'Indicators', type: 'TABLE', report: 'indicators', params: { indicators: ['CLIENTS', 'GROSS_LOAN_PORTFOLIO'] } },
      ] },
    }, { who: 'manager' });
    check('an Other report of built-in reports', other2.status === 201, other2.text);
    const needBranch = await call('POST', `/api/report-templates/${other2.body.id}/run`, {}, { who: 'manager' });
    check('a required parameter is required', needBranch.status === 400 && /PARAMETER_REQUIRED: branch/.test(needBranch.reason));
    const pack = await call('POST', `/api/report-templates/${other2.body.id}/run`, { parameters: { branch: 'HQ' } }, { who: 'manager' });
    check('it runs with the built-in reports\' figures', pack.status === 200 && pack.body.sections[0].rows.some((r) => r.name === 'Total assets') && pack.body.sections[1].rows.find((r) => r.code === 'CLIENTS').value === 2, pack.text.slice(0, 300));
    const pack2 = await call('POST', `/api/report-templates/${other2.body.id}/run`, { parameters: { branch: 'HQ' } }, { who: 'officer' });
    check('a loan officer given VIEW_ACCOUNTING_REPORTS as an extra runs the balance sheet section', pack2.status === 200, pack2.text.slice(0, 200));
    await call('PATCH', `/api/users/${users.officer.id}`, { permissions: [] });
    const pack3 = await call('POST', `/api/report-templates/${other2.body.id}/run`, { parameters: { branch: 'HQ' } }, { who: 'officer' });
    check('with the extra permission taken back, the balance sheet section is refused', pack3.status === 403 && /VIEW_ACCOUNTING_REPORTS/.test(pack3.reason), pack3.text);
    const dl = await call('GET', `/api/report-templates/${up.body.id}/template`, null, { who: 'manager', raw: true });
    check('the template downloads as its file', dl.status === 200 && /statement\.json/.test(dl.headers.get('content-disposition')) && JSON.parse(dl.buffer.toString()).sections.length === 4);
    const edit = await call('PATCH', `/api/report-templates/${up.body.id}`, { name: 'Member statement (short)', definition: { ...def, sections: def.sections.slice(0, 1) } }, { who: 'manager' });
    check('edited with a new file', edit.status === 200 && edit.body.definition.sections.length === 1);
    const del = await call('DELETE', `/api/report-templates/${up.body.id}`, null, { who: 'manager' });
    check('and deleted', del.status === 200);

    // ------------------------------------------------------------------------
    section('grouped custom fields in views');
    const set = await call('POST', '/api/custom-fields/sets', { id: '_refs', entity: 'MEMBER', name: 'Referees', type: 'GROUPED' });
    const f1 = await call('POST', '/api/custom-fields/definitions', { id: 'refName', setId: '_refs', entity: 'MEMBER', name: 'Name', type: 'FREE_TEXT' });
    const f2 = await call('POST', '/api/custom-fields/definitions', { id: 'refYears', setId: '_refs', entity: 'MEMBER', name: 'Years known', type: 'NUMBER' });
    check('a grouped set on members with two fields', set.status === 201 && f1.status === 201 && f2.status === 201, `${set.text} ${f1.text} ${f2.text}`);
    await T((c) => c.query(`UPDATE members SET custom_fields = '{"_refs": [{"refName": "Kamau", "refYears": 5}, {"refName": "Njeri", "refYears": 12}]}' WHERE id = $1`, [m1.id]));
    const fields = await call('GET', '/api/views/fields/MEMBERS');
    check('its fields are offered, marked grouped', fields.body.fields.some((x) => x.key === 'cf:_refs.refName' && x.grouped) && fields.body.fields.find((x) => x.key === 'cf:_refs.refYears').operators.includes('MORE_THAN'));
    const g = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo', 'cf:_refs.refName', 'cf:_refs.refYears'], sortBy: 'memberNo' });
    check('a column shows every entry\'s value', g.status === 200 && g.body.items[0]['cf:_refs.refName'] === 'Kamau, Njeri' && g.body.items[0]['cf:_refs.refYears'] === '5, 12' && g.body.items[1]['cf:_refs.refName'] === null, g.text.slice(0, 300));
    const gf = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo'], filters: [{ field: 'cf:_refs.refYears', operator: 'MORE_THAN', value: 10 }] });
    const gn = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo'], filters: [{ field: 'cf:_refs.refName', operator: 'EQUALS', value: 'njeri' }] });
    const ge = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo'], filters: [{ field: 'cf:_refs.refName', operator: 'EMPTY' }] });
    const gd = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo'], filters: [{ field: 'cf:_refs.refName', operator: 'DIFFERENT_THAN', value: 'Kamau' }] });
    check('a filter matches when any entry does', gf.body.total === 1 && gf.body.items[0].memberNo === 'A0001' && gn.body.total === 1, `${gf.text} ${gn.text}`);
    check('empty means no entry has a value; different means none has it', ge.body.total === 1 && ge.body.items[0].memberNo === 'A0002' && gd.body.total === 1 && gd.body.items[0].memberNo === 'A0002');

    section('structure');
    const DD = require('../src/domain/dataDictionary');
    const dict = await withTenantRead(SCHEMA, (c) => DD.build(c));
    check('the dictionary describes the new tables and columns', dict.missing.length === 0, dict.missing.join(', '));
  } catch (e) {
    fail++; failures.push(e.stack); console.error(e);
  } finally {
    server.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.join('\n'));
    process.exit(fail ? 1 : 0);
  }
})();
