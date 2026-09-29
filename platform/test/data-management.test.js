#!/usr/bin/env node
'use strict';

/**
 * Data management, after the reference platform's Data and Reporting > Data Management
 * pages: dates as yyyy-MM-dd, the API standards (paging, null handling,
 * identifiers), the data dictionary, the tenant database backup, the
 * incremental extract and its Singer tap for Stitch, the Excel data import
 * with its review, and tenant user management.
 */

// The extract's safety margin is for production; here the rows are seconds old.
process.env.EXTRACT_LAG_SECONDS = '0';
const http = require('http');
const { execFileSync } = require('child_process');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const { signToken } = require('../src/tenancy/resolve');
const XLSX = require('../src/lib/xlsx');
const { unzip, zip } = require('../src/lib/zip');
const { omitNulls } = require('../src/lib/apiStandards');
const DD = require('../src/domain/dataDictionary');
const EX = require('../src/domain/extract');
const L = require('../src/domain/loans');
const P = require('../src/domain/penalties');
const F = require('../src/domain/fees');
const U = require('../src/tenancy/users');
const backup = require('../src/ops/tenantBackup');
const { tap } = require('../bin/tap-sacco');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'datamgmt';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4105;
const HOOK_PORT = 4199;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let token;
async function call(method, p, body, { auth = token, headers: extra = {}, raw = false, binary = null } = {}) {
  const headers = { 'x-tenant': SLUG, ...extra };
  if (auth) headers.authorization = `Bearer ${auth}`;
  let payload;
  if (binary) { headers['content-type'] = headers['content-type'] || XLSX_TYPE; payload = binary; }
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  if (raw) return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text, headers: r.headers, reason: d?.errors?.[0]?.errorReason || '' };
}
const q1 = (sql, params = []) => Rd(async (c) => (await c.query(sql, params)).rows[0]);
const qa = (sql, params = []) => Rd(async (c) => (await c.query(sql, params)).rows);
const sheet = (name, rows) => ({ name, rows });

// The import workbook this suite builds on.
function goodWorkbook({ asOf = '2026-06-30', suffix = '', portfolio = 10500, extraMember = null } = {}) {
  const s = suffix;
  return XLSX.write([
    sheet('Settings', [['Setting', 'Value'], ['Migration date', asOf]]),
    sheet('GL Accounts', [['Code*', 'Name*', 'Type*', 'Parent code', 'Usage'],
      [`H-1${s}`, 'Old bank accounts', 'ASSET', null, 'HEADER'],
      [`100-23${s || '0'}`, 'Old bank account', 'ASSET', `H-1${s}`, 'DETAIL']]),
    sheet('Branches', [['Branch ID*', 'Name*', 'Town'], [`WEST${s}`, 'West branch', 'Nakuru']]),
    sheet('Centres', [['Centre ID*', 'Name*', 'Branch ID*', 'Meeting day'], [`W01${s}`, 'West centre', `WEST${s}`, 'Tuesday']]),
    sheet('Members', [
      ['Member number*', 'First name*', 'Middle name', 'Last name*', 'Phone', 'Branch ID', 'Centre ID', 'Joined on', 'Prior loan cycles', 'City', 'Custom: _extra.nickname'],
      [`IM001${s}`, 'Wanjiru', 'Njeri', 'Kamau', '0700000001', `WEST${s}`, `W01${s}`, '2019-02-01', 2, 'Nakuru', 'Wawa'],
      [`IM002${s}`, 'Otieno', null, 'Ochieng', '0700000002', `WEST${s}`, null, '2020-03-01', 0, 'Kisumu', null],
      ...(extraMember ? [extraMember] : []),
    ]),
    sheet('Deposit Accounts', [['Account number*', 'Member number*', 'Product ID*', 'Balance*', 'Opened on'],
      [`SAIMP1${s}`, `IM001${s}`, 'SAV01', 5000, '2019-02-01'],
      [`SAIMP2${s}`, `IM002${s}`, 'SAV01', 1500, '2020-03-01']]),
    sheet('Share Accounts', [['Account number*', 'Member number*', 'Product ID*', 'Units*'], [`SHIMP1${s}`, `IM001${s}`, 'SHR01', 10]]),
    sheet('Loan Accounts', [
      ['Account number*', 'Member number*', 'Product ID*', 'Principal*', 'Installments*', 'Disbursed on*', 'Principal outstanding*', 'Interest outstanding', 'Fees outstanding', 'Penalty outstanding'],
      [`LNIMPA${s}`, `IM001${s}`, 'IMP', 3000, 3, '2026-03-15', 2000, 30, 0, 12.5],
      [`LNIMPB${s}`, `IM002${s}`, 'IMP', 10000, 10, '2026-05-01', 8500, 0, 0, 0]]),
    sheet('Loan Schedule', [
      ['Account number*', 'Installment*', 'Due date*', 'Principal due*', 'Interest due*', 'Fees due', 'Principal paid', 'Interest paid', 'Fees paid'],
      [`LNIMPA${s}`, 1, '2026-04-15', 1000, 30, 0, 1000, 30, 0],
      [`LNIMPA${s}`, 2, '2026-05-15', 1000, 20, 0, 0, 0, 0],
      [`LNIMPA${s}`, 3, '2026-06-15', 1000, 10, 0, 0, 0, 0]]),
    sheet('GL Balances', [['GL code*', 'Debit', 'Credit'],
      ['100-100', portfolio, null], ['100-300', 30, null], ['100-320', 12.5, null], [`100-23${s || '0'}`, 5000, null],
      ['200-100', null, 6500], ['300-100', null, 1000], ['300-200', null, round2(portfolio + 30 + 12.5 + 5000 - 7500)]]),
  ]);
}
const round2 = (n) => Math.round(n * 100) / 100;

let hookServer;
const hooks = [];

(async () => {
  const server = app.listen(PORT);
  hookServer = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { try { hooks.push(JSON.parse(b)); } catch { hooks.push(b); } res.writeHead(204); res.end(); });
  }).listen(HOOK_PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Data SACCO', mfaRequiredRoles: [], adminEmail: 'admin@datamgmt.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    const login = await call('POST', '/api/auth/login', { email: 'admin@datamgmt.local', password: PASSWORD }, { auth: null });
    token = login.body.accessToken;
    check('admin signed in', !!token, login.text);
    const { rows: [admin] } = await pool.query("SELECT id FROM platform.users WHERE email = 'admin@datamgmt.local'");
    // A real staff user of the role: the role a request carries is read from the database, not the token.
    const staff = async (email, role) => (await pool.query(
      `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role)
       SELECT id, $2, 'x', $3, $4 FROM platform.tenants WHERE slug = $1 RETURNING id`, [SLUG, email, role.toLowerCase(), role])).rows[0].id;
    const teller = signToken({ sub: await staff('teller@datamgmt.local', 'TELLER'), email: 'teller@datamgmt.local', role: 'TELLER', tid: SLUG, name: 'Teller' });
    const auditorId = await staff('auditor@datamgmt.local', 'AUDITOR');
    const tenant = await provision.getTenantBySlug(SLUG);

    // ---------------------------------------------------------------------
    section('dates are calendar days, yyyy-MM-dd, whatever the server time zone');
    const script = `const {pool}=require('./src/db/pool');pool.query("SELECT '2026-01-01'::date AS d").then(r=>{console.log(JSON.stringify({d:r.rows[0].d,tz:process.env.TZ}));return pool.end();})`;
    for (const tz of ['UTC', 'Africa/Nairobi', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: `${__dirname}/..`, env: { ...process.env, TZ: tz } }).toString());
      check(`a DATE reads back as '2026-01-01' under TZ=${tz}`, out.d === '2026-01-01', JSON.stringify(out));
    }
    const m0 = await call('POST', '/api/members', { firstName: 'Date', lastName: 'Check', dateOfBirth: '1990-12-31' });
    check('a member created with date of birth 1990-12-31 returns 1990-12-31', m0.body.date_of_birth === '1990-12-31', JSON.stringify(m0.body?.date_of_birth));
    check('timestamps are ISO 8601 in UTC', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m0.body.created_at), m0.body.created_at);

    // ---------------------------------------------------------------------
    section('API standards');
    const capped = await call('GET', '/api/members?limit=5000');
    check('a page is at most 1,000 items (the reference platform\'s maximum)', capped.headers.get('items-limit') === '1000', capped.headers.get('items-limit'));
    const withNulls = await call('GET', `/api/members/${m0.body.id}`);
    check('by default a null field is returned as null', 'middle_name' in withNulls.body && withNulls.body.middle_name === null);
    const vendor = await call('GET', `/api/members/${m0.body.id}`, null, { headers: { accept: 'application/vnd.sacco.v2+json' } });
    check('with Accept: application/vnd.sacco.v2+json null fields are left out',
      vendor.status === 200 && !('middle_name' in vendor.body) && vendor.body.first_name === 'Date' && vendor.headers.get('x-nulls') === 'omitted',
      JSON.stringify(Object.keys(vendor.body || {})));
    const omit = await call('GET', `/api/members?nulls=omit&limit=5`);
    check('?nulls=omit does the same for a list', Array.isArray(omit.body) && omit.body.every((m) => !Object.values(m).includes(null)));
    check('nulls inside an array keep their place', JSON.stringify(omitNulls({ a: [1, null, { b: null, c: 2 }], d: null })) === '{"a":[1,null,{"c":2}]}');
    const err = await call('GET', '/api/members/00000000-0000-0000-0000-000000000000', null, { headers: { accept: 'application/vnd.sacco.v2+json' } });
    check('errors keep their envelope under the reference platform media type', err.status === 404 && err.body.errors[0].errorCode === 404);
    const byNo = await call('GET', `/api/members/${m0.body.member_no}`);
    check('a member is found by id or by number', byNo.status === 200 && byNo.body.id === m0.body.id);

    // ---------------------------------------------------------------------
    section('data dictionary');
    const dict = await call('GET', '/api/data-dictionary');
    check('every table and column is described', dict.status === 200 && dict.body.missing.length === 0, JSON.stringify(dict.body?.missing?.slice(0, 20)));
    check('it lists the whole schema', dict.body.tables.length >= 80, String(dict.body.tables.length));
    const mt = dict.body.tables.find((t) => t.name === 'members');
    const col = (t, n) => t.columns.find((x) => x.name === n);
    check('a column has its type, nullability and description',
      col(mt, 'member_no').type === 'text' && col(mt, 'member_no').nullable === false && !!col(mt, 'member_no').description);
    check('foreign keys name the table and column they refer to',
      JSON.stringify(col(mt, 'branch_id').references) === '{"table":"branches","column":"id"}', JSON.stringify(col(mt, 'branch_id').references));
    check('primary keys are listed', JSON.stringify(mt.primaryKey) === '["id"]');
    check('a DATE column is an organization date, a timestamptz a UTC timestamp',
      col(mt, 'joined_on').dateKind === 'ORGANIZATION_DATE' && col(mt, 'created_at').dateKind === 'UTC_TIMESTAMP');
    check('the conventions say how dates are written', /yyyy-MM-dd/.test(dict.body.conventions.dates));
    const one = await call('GET', '/api/data-dictionary/loan_installments');
    check('one table by name', one.status === 200 && col(one.body, 'late_fee_exempt').description.length > 10);
    check('an unknown table is a 404', (await call('GET', '/api/data-dictionary/nope')).status === 404);
    const csv = await call('GET', '/api/data-dictionary?format=csv', null, { raw: true });
    check('the dictionary downloads as CSV', csv.status === 200 && csv.buffer.toString().startsWith('table,column,type,nullable'));
    const comment = await q1("SELECT col_description('members'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'members'::regclass AND attname = 'member_no')) AS d");
    check('the migrations wrote the descriptions into the catalog as comments', !!comment.d && comment.d === col(mt, 'member_no').description, String(comment.d));
    check('any signed-in staff may read it', (await call('GET', '/api/data-dictionary', null, { auth: teller })).status === 200);

    // ---------------------------------------------------------------------
    section('users (Users and Access Control)');
    // A teller belongs to a branch (the reference platform).
    const br = await call('POST', '/api/branches', { code: 'MAIN', name: 'Main branch' });
    const tellerNew = await call('POST', '/api/users', { email: 'Teller.One@datamgmt.local', fullName: 'Teller One', role: 'TELLER', branchId: 'MAIN' });
    check('an administrator creates a user and is shown a temporary password once',
      tellerNew.status === 201 && /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(tellerNew.body.temporaryPassword) && tellerNew.body.must_change_password === true,
      tellerNew.text);
    check('the email is kept in lower case', tellerNew.body.email === 'teller.one@datamgmt.local');
    check('the same email twice is refused', (await call('POST', '/api/users', { email: 'teller.one@datamgmt.local' })).status === 409);
    check('a platform role cannot be given', (await call('POST', '/api/users', { email: 'x@datamgmt.local', role: 'PLATFORM_ADMIN' })).status === 400);
    check('only an administrator creates users', (await call('POST', '/api/users', { email: 'y@datamgmt.local' }, { auth: teller })).status === 403);
    const temp = tellerNew.body.temporaryPassword;
    const first = await call('POST', '/api/auth/login', { email: 'teller.one@datamgmt.local', password: temp }, { auth: null });
    check('the temporary password signs in only to change it', first.status === 403 && first.reason === 'PASSWORD_CHANGE_REQUIRED' && !!first.body.passwordChangeToken);
    check('that token opens nothing else', (await call('GET', '/api/members', null, { auth: first.body.passwordChangeToken })).status === 403);
    const changed = await call('POST', '/api/auth/password', { currentPassword: temp, newPassword: 'Chosen by the new one 2026' }, { auth: first.body.passwordChangeToken });
    check('it changes the password', changed.status === 200 && changed.body.changed === true, changed.text);
    const tl = await call('POST', '/api/auth/login', { email: 'teller.one@datamgmt.local', password: 'Chosen by the new one 2026' }, { auth: null });
    check('and then the user signs in', tl.status === 200 && !!tl.body.accessToken, tl.text);
    const tellerToken = tl.body.accessToken;
    const assigned = await call('PATCH', `/api/users/${tellerNew.body.id}`, { branchId: 'MAIN', approvalLimit: 50000 });
    check('a user is given a branch and a limit', assigned.status === 200 && assigned.body.branch_id === br.body.id && assigned.body.approval_limit === 50000, assigned.text);
    check('an unknown branch is refused', (await call('PATCH', `/api/users/${tellerNew.body.id}`, { branchId: 'NOPE' })).status === 404);
    check('nobody changes their own role', (await call('PATCH', `/api/users/${admin.id}`, { role: 'TELLER' })).reason === 'YOU_CANNOT_CHANGE_YOUR_OWN_ROLE_OR_STATUS');
    check('or suspends themselves', (await call('PATCH', `/api/users/${admin.id}`, { status: 'SUSPENDED' })).status === 409);
    let lastAdmin = null;
    try { await U.update(tenant, admin.id, { status: 'SUSPENDED' }, { actor: 'someone', actorId: '00000000-0000-0000-0000-000000000000' }); } catch (e) { lastAdmin = e.message; }
    check('the last active administrator can be neither suspended nor demoted', lastAdmin === 'LAST_ACTIVE_TENANT_ADMIN', String(lastAdmin));
    check('the teller works before suspension', (await call('GET', '/api/members', null, { auth: tellerToken })).status === 200);
    const susp = await call('PATCH', `/api/users/${tellerNew.body.id}`, { status: 'SUSPENDED' });
    check('an administrator suspends a user', susp.status === 200 && susp.body.status === 'SUSPENDED');
    const after = await call('GET', '/api/members', null, { auth: tellerToken });
    check('and their access token stops working at once', after.status === 401 && after.reason === 'USER_SUSPENDED', `${after.status} ${after.reason}`);
    check('their refresh token is revoked', (await call('POST', '/api/auth/refresh', { refreshToken: tl.body.refreshToken }, { auth: null })).status === 401);
    await call('PATCH', `/api/users/${tellerNew.body.id}`, { status: 'ACTIVE' });
    const reset = await call('POST', `/api/users/${tellerNew.body.id}/reset-password`);
    check('a password reset gives a new temporary password', reset.status === 200 && !!reset.body.temporaryPassword);
    check('the old password no longer works', (await call('POST', '/api/auth/login', { email: 'teller.one@datamgmt.local', password: 'Chosen by the new one 2026' }, { auth: null })).status === 401);
    const again = await call('POST', '/api/auth/login', { email: 'teller.one@datamgmt.local', password: reset.body.temporaryPassword }, { auth: null });
    check('the new one must be changed', again.reason === 'PASSWORD_CHANGE_REQUIRED');
    await pool.query("UPDATE platform.users SET mfa_enabled = true, mfa_secret = 'x' WHERE id = $1", [tellerNew.body.id]);
    const mfa = await call('POST', `/api/users/${tellerNew.body.id}/reset-mfa`);
    const { rows: [mu] } = await pool.query('SELECT mfa_enabled, mfa_secret FROM platform.users WHERE id = $1', [tellerNew.body.id]);
    check('a second factor is reset', mfa.status === 200 && mu.mfa_enabled === false && mu.mfa_secret === null);
    const list = await call('GET', '/api/users');
    check('users are listed for the tenant only', list.status === 200 && list.body.length === 4 && list.body.every((u) => u.email.endsWith('@datamgmt.local')));
    check('without password hashes or secrets', !list.body.some((u) => 'password_hash' in u || 'mfa_secret' in u));
    const trail = await call('GET', '/api/users/audit');
    check('every change is in the audit log',
      ['USER_CREATED', 'USER_UPDATED', 'USER_PASSWORD_RESET', 'USER_MFA_RESET'].every((a) => trail.body.some((x) => x.action === a)),
      trail.body.map((x) => x.action).join(','));
    const role = await call('PATCH', `/api/users/${tellerNew.body.id}`, { role: 'AUDITOR' });
    check('a role is changed', role.body.role === 'AUDITOR');

    // ---------------------------------------------------------------------
    section('Excel data import: the template');
    const pen = await call('POST', '/api/loan-products', {
      id: 'IMP', name: 'Imported loans', glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200', glInterestRec: '100-300',
      glPenaltyInc: '400-200', glPenaltyRec: '100-320', accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY',
      enforceDepositMultiplier: false, maxTerm: 36, monthlyRate: 1, productType: 'FIXED_TERM', method: 'REDUCING',
      penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 0.1 });
    const lateFee = await call('POST', '/api/loan-products/IMP/fees', { code: 'LATE', name: 'Late fee', feeType: 'LATE_REPAYMENT', calculation: 'FLAT', amount: 25 });
    check('a product for the imported loans', pen.status === 201 && lateFee.status === 201, `${pen.text} ${lateFee.text}`);
    await call('POST', '/api/custom-fields/sets', { entity: 'MEMBER', name: 'Extra', id: '_extra' });
    const cfd = await call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_extra', id: 'nickname', name: 'Nickname', type: 'FREE_TEXT' });
    check('a member custom field for the import to fill', cfd.status === 201, cfd.text);
    const tpl = await call('GET', '/api/data-imports/template', null, { raw: true });
    const tbook = XLSX.read(tpl.buffer);
    check('the template downloads as a workbook', tpl.status === 200 && tpl.headers.get('content-type').includes('spreadsheetml'));
    const names = tbook.map((x) => x.name);
    check('with a sheet to fill in per kind of record, in order',
      ['Instructions', 'Settings', 'GL Accounts', 'Chart of Accounts', 'Branches', 'Centres', 'Members', 'Groups', 'Deposit Accounts', 'Share Accounts',
        'Loan Accounts', 'Loan Schedule', 'Loan Transactions', 'GL Balances'].every((n, i) => names[i] === n), names.join(','));
    check('and a reference sheet per kind of record already in the system (the reference platform)',
      ['Branches Data', 'Centres Data', 'Credit Officers', 'Loan Products', 'Deposit Products', 'Share Products', 'GL Accounts Data', 'Group Types', 'Group Role Names', 'ID Templates'].every((n) => names.includes(n)));
    const sheetXml = (n) => unzip(tpl.buffer).get(`xl/worksheets/sheet${names.indexOf(n) + 1}.xml`).toString();
    check('sheets to fill in have green headings, reference sheets grey', /<c r="A1" s="4"/.test(sheetXml('Members')) && /<c r="A1" s="5"/.test(sheetXml('Loan Products')));
    const mhead = tbook.find((x) => x.name === 'Members').rows[0];
    check('required columns are marked', mhead[0] === 'Member number*');
    check('every custom field defined for members has its column already', mhead.includes('Custom: _extra.nickname (Nickname)'), mhead.slice(-3).join(' | '));
    check('with the reference platform\'s client fields: ID document, credit officer, loan cycle',
      ['ID type', 'ID number', 'ID authority', 'ID valid until', 'Credit officer', 'Prior loan cycles'].every((h) => mhead.includes(h)));
    const lp = tbook.find((x) => x.name === 'Loan Products').rows;
    check('the IDs already in the system are listed to copy from', lp.some((r) => r[0] === 'IMP') && tbook.find((x) => x.name === 'GL Accounts Data').rows.some((r) => r[0] === '100-100'));
    check('credit officers are the SACCO\'s users', tbook.find((x) => x.name === 'Credit Officers').rows.some((r) => r[0] === 'admin@datamgmt.local'));
    const intro = tbook[0].rows;
    check('the instructions say what must be set up first, and what is in place', intro.some((r) => r[0] === 'Loan products' && r[1] === 'yes')
      && intro.some((r) => r[0] === 'Users (credit officers)'));
    const pre = await call('GET', '/api/data-imports/prerequisites');
    check('so does the API', pre.status === 200 && pre.body.some((x) => x.item === 'Branches'));

    section('Excel data import: a workbook with mistakes');
    const membersBefore = (await q1('SELECT count(*)::int AS n FROM members')).n;
    const bad = XLSX.write([
      sheet('Settings', [['Setting', 'Value'], ['Migration date', '2026-06-30']]),
      sheet('Members', [['Member number*', 'First name*', 'Last name*', 'Date of birth', 'Gender'],
        ['BX1', 'Ann', 'One', '31/12/1990', 'X'], ['BX1', 'Ann', null, null, null]]),
      sheet('Loan Accounts', [['Account number*', 'Member number*', 'Product ID*', 'Principal*', 'Installments*', 'Disbursed on*', 'Principal outstanding*'],
        ['LB1', 'BX1', 'IMP', 1000, 12, '2026-07-15', 1500]]),
      sheet('GL Balances', [['GL code*', 'Debit', 'Credit'], ['100-100', 100, null], ['200-100', null, 90]]),
    ]);
    const up1 = await call('POST', '/api/data-imports?wait=true', null, { binary: bad, headers: { 'x-file-name': 'bad.xlsx' } });
    const msgs = (up1.body?.errors || []).map((e) => `${e.sheet}:${e.row}:${e.message}`);
    check('it is INVALID', up1.status === 201 && up1.body.status === 'INVALID', up1.text.slice(0, 300));
    check('a date in the wrong form is found, by sheet, row and column', up1.body.errors.some((e) => e.sheet === 'Members' && e.row === 2 && e.column === 'Date of birth' && /yyyy-MM-dd/.test(e.message)), msgs.join(' | '));
    check('a value not in the list', msgs.some((m) => /Gender must be M, F or O/.test(m)), msgs.join(' | '));
    check('a required value left out', msgs.some((m) => /Members:3:Last name is required/.test(m)));
    check('a number used twice', msgs.some((m) => /Member number BX1 is also on row 2/.test(m)));
    check('a date after the migration date', msgs.some((m) => /Disbursed on 2026-07-15 is after the migration date/.test(m)));
    check('more outstanding than was lent', msgs.some((m) => /Principal outstanding is more than the principal/.test(m)));
    check('a trial balance that does not balance', msgs.some((m) => /Debits \(100\) do not equal credits \(90\)/.test(m)));
    check('nothing was created', (await q1('SELECT count(*)::int AS n FROM members')).n === membersBefore);
    const ef = await call('GET', `/api/data-imports/${up1.body.id}/errors`, null, { raw: true });
    const ebook = XLSX.read(ef.buffer);
    const eList = ebook[ebook.length - 1];
    check('the workbook comes back with the errors: a list last, as in the reference platform', ef.status === 200 && eList.name === 'Errors' && eList.rows.length === up1.body.errors.length + 1);
    const em = ebook.find((s) => s.name === 'Members');
    check('and an Errors column on each sheet, against the row', em.rows[0].includes('Errors') && /yyyy-MM-dd/.test(em.rows[1][em.rows[0].indexOf('Errors')]));
    check('an invalid import cannot be approved', (await call('POST', `/api/data-imports/${up1.body.id}/approve`)).status === 409);

    const dbBad = XLSX.write([
      sheet('Settings', [['Setting', 'Value'], ['Migration date', '2026-06-30']]),
      sheet('GL Accounts', [['Code*', 'Name*', 'Type*', 'Usage'], ['H-9', 'A header', 'ASSET', 'HEADER']]),
      sheet('Members', [['Member number*', 'First name*', 'Last name*', 'Branch ID'], ['DB1', 'Ann', 'One', 'NOWHERE'], ['DB2', 'Bob', 'Two', null]]),
      sheet('Deposit Accounts', [['Account number*', 'Member number*', 'Product ID*', 'Balance*'], ['SADB1', 'DB2', 'NOPE', 10], ['SADB2', 'DB1', 'SAV01', 10]]),
      sheet('Loan Accounts', [['Account number*', 'Member number*', 'Product ID*', 'Principal*', 'Installments*', 'Disbursed on*', 'Principal outstanding*'],
        ['LDB1', 'DB2', 'IMP', 1000, 99, '2026-01-15', 500]]),
      sheet('GL Balances', [['GL code*', 'Debit', 'Credit'], ['H-9', 10, null], ['200-100', null, 10]]),
    ]);
    const up2 = await call('POST', '/api/data-imports?wait=true', null, { binary: dbBad });
    const m2 = (up2.body?.errors || []).map((e) => `${e.sheet}:${e.row}:${e.message}`);
    check('what only the database can refuse is found at upload, row by row', up2.body.status === 'INVALID' && m2.length >= 4, m2.join(' | '));
    check('an unknown branch', m2.some((m) => /^Members:2:.*BRANCH/i.test(m)), m2.join(' | '));
    check('an unknown product', m2.some((m) => /^Deposit Accounts:2:.*(DEPOSIT PRODUCT|Unknown deposit product)/i.test(m)), m2.join(' | '));
    check('a row that depends on one that failed says so', m2.some((m) => /^Deposit Accounts:3:Member DB1 did not import \(row 2\)/.test(m)), m2.join(' | '));
    check('a term outside the product', m2.some((m) => /^Loan Accounts:2:.*TERM/i.test(m)), m2.join(' | '));
    check('a header account in the trial balance', m2.some((m) => /GL account H-9 is a header account/.test(m)), m2.join(' | '));
    check('and still nothing was created', (await q1("SELECT count(*)::int AS n FROM members WHERE member_no LIKE 'DB%'")).n === 0
      && (await q1("SELECT count(*)::int AS n FROM gl_accounts WHERE code = 'H-9'")).n === 0);

    section('Excel data import: review and approve');
    const up3 = await call('POST', '/api/data-imports?wait=true', null, { binary: goodWorkbook(), headers: { 'x-file-name': 'migration.xlsx' } });
    check('a clean workbook is PENDING_APPROVAL', up3.status === 201 && up3.body.status === 'PENDING_APPROVAL', JSON.stringify(up3.body?.errors?.slice(0, 5)));
    const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o || {}).sort()));
    check('the review shows what it will create',
      sorted(up3.body.summary.creates) === sorted({ glAccounts: 2, branches: 1, centres: 1, members: 2, groups: 0, groupMembers: 0, deposits: 2, shares: 1, loans: 2, installments: 13, transactions: 0, openingEntryLines: 7 }),
      JSON.stringify(up3.body.summary.creates));
    check('the subledgers match the trial balance, so there are no warnings', up3.body.warnings.length === 0, JSON.stringify(up3.body.warnings));
    check('before approval nothing is in the live tables', (await q1("SELECT count(*)::int AS n FROM members WHERE member_no LIKE 'IM00%'")).n === 0
      && (await q1("SELECT count(*)::int AS n FROM loan_accounts WHERE account_no LIKE 'LNIMP%'")).n === 0);
    check('an auditor may look at it', (await call('GET', `/api/data-imports/${up3.body.id}`, null, { auth: signToken({ sub: auditorId, email: 'auditor@datamgmt.local', role: 'AUDITOR', tid: SLUG }) })).status === 200);
    check('a teller may not upload', (await call('POST', '/api/data-imports?wait=true', null, { binary: goodWorkbook(), auth: teller })).status === 403);
    await T((c) => c.query('UPDATE lending_controls SET two_man_rule = true'));
    const four = await call('POST', `/api/data-imports/${up3.body.id}/approve`);
    check('under the four-eyes rule the uploader may not approve it', four.status === 409 && /FOUR_EYES/.test(four.reason), four.text);
    await T((c) => c.query('UPDATE lending_controls SET two_man_rule = false'));
    const ap = await call('POST', `/api/data-imports/${up3.body.id}/approve`, { note: 'checked against the old trial balance' });
    check('it is approved', ap.status === 200 && ap.body.status === 'APPROVED' && !!ap.body.entry_id, ap.text.slice(0, 400));
    check('approving twice is refused', (await call('POST', `/api/data-imports/${up3.body.id}/approve`)).status === 409);

    const im1 = await q1("SELECT * FROM members WHERE member_no = 'IM001'");
    const west = await q1("SELECT * FROM branches WHERE code = 'WEST'");
    const w01 = await q1("SELECT * FROM centres WHERE code = 'W01'");
    check('branches, centres and members are created and traced to the import',
      im1 && west && w01 && im1.import_id === up3.body.id && im1.branch_id === west.id && im1.centre_id === w01.id && w01.meeting_day === 2);
    check('with the member\'s other fields', im1.middle_name === 'Njeri' && im1.city === 'Nakuru' && im1.joined_on === '2019-02-01' && im1.prior_loan_cycles === 2);
    check('and custom field columns', im1.custom_fields?._extra?.nickname === 'Wawa', JSON.stringify(im1.custom_fields));
    const hist = await call('GET', `/api/members/${im1.id}/loan-history`);
    check('loan cycles from the old system count', hist.body.completedLoanCycles === 2 && hist.body.priorLoanCycles === 2, JSON.stringify(hist.body));
    const gl = await q1("SELECT * FROM gl_accounts WHERE code = '100-230'");
    check('the chart of accounts gains the new accounts, header and detail', gl && gl.parent_code === 'H-1' && gl.usage === 'DETAIL'
      && (await q1("SELECT usage FROM gl_accounts WHERE code = 'H-1'")).usage === 'HEADER');
    const sa = await q1("SELECT * FROM savings_accounts WHERE account_no = 'SAIMP1'");
    check('a deposit account opens with its balance', sa.balance === 5000 && sa.opened_on === '2019-02-01' && sa.accrued_through === '2026-06-30');
    const satx = await q1("SELECT * FROM transactions WHERE savings_account_id = $1", [sa.id]);
    check('the balance is the first line of its history, dated when the account opened (the reference platform), with no journal entry', satx.kind === 'MIGRATION_OPENING_BALANCE' && satx.amount === 5000 && satx.entry_id === null && satx.value_date === '2019-02-01');
    const sh = await q1("SELECT * FROM share_accounts WHERE account_no = 'SHIMP1'");
    check('a share account opens with its units', sh.units === 10 && (await q1("SELECT kind FROM share_movements WHERE account_id = $1", [sh.id])).kind === 'MIGRATION');

    const la = await q1("SELECT * FROM loan_accounts WHERE account_no = 'LNIMPA'");
    const lb = await q1("SELECT * FROM loan_accounts WHERE account_no = 'LNIMPB'");
    const ia = await qa('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [la.id]);
    const ib = await qa('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [lb.id]);
    check('a loan takes the schedule given', ia.length === 3 && ia[1].due_date === '2026-05-15' && ia[0].status === 'PAID');
    check('what it owes is what the sheet says',
      L.principalOutstanding(la) === 2000 && round2(la.interest_accrued - la.interest_paid) === 30 && la.penalty_accrued === 12.5 && la.interest_paid === 30,
      JSON.stringify({ p: L.principalOutstanding(la), ia: la.interest_accrued, ip: la.interest_paid, pen: la.penalty_accrued }));
    check('late at the migration date, it is in arrears from its oldest late installment',
      la.status === 'IN_ARREARS' && la.arrears_since === '2026-05-15' && ia[1].status === 'OVERDUE' && ia[2].status === 'OVERDUE', `${la.status} ${la.arrears_since}`);
    check('interest accrues from the migration date', la.accrued_through === '2026-06-30' && la.disbursed_on === '2026-03-15');
    check('installments late at the migration date are exempt from the late fee', ia[1].late_fee_exempt && ia[2].late_fee_exempt && !ia[0].late_fee_exempt);
    check('the product\'s settings are frozen on it, as at an approval', !!la.settings_snapshot);
    check('its history says it was imported',
      (await q1("SELECT action FROM loan_state_history WHERE loan_id = $1 ORDER BY id DESC LIMIT 1", [la.id])).action !== null
      && (await q1("SELECT count(*)::int AS n FROM loan_state_history WHERE loan_id = $1 AND action = 'IMPORT'", [la.id])).n === 1);
    check('a loan without a schedule is given the product\'s from its disbursement date',
      ib.length === 10 && ib[0].due_date > '2026-05-01' && lb.status === 'ACTIVE', `${ib.length} ${ib[0]?.due_date} ${lb.status}`);
    check('with the principal repaid applied to the oldest installments first',
      round2(ib.reduce((t, i) => t + i.principal_paid, 0)) === 1500 && ib[0].status === 'PAID' && ib[1].status === 'PARTIALLY_PAID' && ib[2].principal_paid === 0
      && L.principalOutstanding(lb) === 8500, ib.slice(0, 3).map((i) => `${i.status}:${i.principal_due}/${i.principal_paid}`).join(' '));

    // The day after the migration: the penalty counts from the migration
    // date, and no late fee is charged for lateness before it.
    await T(async (c) => P.accrueForLoan(c, la.id, { asOf: '2026-07-01', createdBy: 'EOD' }));
    const real = await qa('SELECT * FROM penalty_charges WHERE loan_id = $1 AND amount > 0 ORDER BY installment_id', [la.id]);
    const marks = await qa('SELECT * FROM penalty_charges WHERE loan_id = $1 AND forfeited', [la.id]);
    check('the days before the migration are covered by forfeited markers', marks.length === 2 && marks.every((x) => x.charged_on === '2026-06-30' && x.amount === 0));
    check('the first penalty after the migration covers one day per late installment, not the days before',
      real.length === 2 && real.every((x) => x.days_charged === 1 && x.period_from === '2026-06-30' && x.charged_on === '2026-07-01'),
      JSON.stringify(real.map((x) => [x.period_from, x.days_charged, x.amount])));
    const lateFees = await T(async (c) => F.applyLateFees(c, await L.lock(c, la.id), '2026-07-01'));
    check('and no late fee for installments late before it', lateFees === 0, String(lateFees));

    const entry = await q1('SELECT * FROM journal_entries WHERE id = $1', [ap.body.entry_id]);
    const lines = await qa('SELECT gl_code, direction, amount FROM journal_lines WHERE entry_id = $1 ORDER BY line_no', [ap.body.entry_id]);
    check('the trial balance is posted as one entry on the migration date',
      entry.booking_date === '2026-06-30' && entry.source_type === 'DATA_IMPORT' && lines.length === 7
      && round2(lines.filter((x) => x.direction === 'DEBIT').reduce((t, x) => t + x.amount, 0)) === round2(lines.filter((x) => x.direction === 'CREDIT').reduce((t, x) => t + x.amount, 0)));
    check('the accounts themselves posted nothing',
      (await q1("SELECT count(*)::int AS n FROM journal_entries WHERE source_type <> 'DATA_IMPORT' AND booking_date = '2026-06-30'")).n === 0);
    const portfolio = await q1("SELECT COALESCE(sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0) AS b FROM journal_lines WHERE gl_code = '100-100'");
    check('the portfolio in the ledger is the imported loans', portfolio.b === 10500, String(portfolio.b));

    section('Excel data import: warnings, rejection, and approval that fails');
    const up4 = await call('POST', '/api/data-imports?wait=true', null, { binary: goodWorkbook({ suffix: '9', portfolio: 10000 }) });
    check('a subledger that does not match its GL account is a warning for the reviewer, not an error',
      up4.body.status === 'PENDING_APPROVAL' && up4.body.warnings.some((w) => /Loan principal outstanding add up to 10500 on GL account 100-100; the opening balances have 10000/.test(w.message)),
      JSON.stringify(up4.body.warnings));
    const rj = await call('POST', `/api/data-imports/${up4.body.id}/reject`, { note: 'portfolio does not reconcile' });
    check('the reviewer rejects it', rj.status === 200 && rj.body.status === 'REJECTED' && rj.body.decision_note === 'portfolio does not reconcile');
    check('a rejected import cannot then be approved', (await call('POST', `/api/data-imports/${up4.body.id}/approve`)).status === 409);
    check('and left nothing behind', (await q1("SELECT count(*)::int AS n FROM members WHERE member_no LIKE 'IM00%9'")).n === 0);

    const up5 = await call('POST', '/api/data-imports?wait=true', null, { binary: goodWorkbook({ suffix: '7' }) });
    check('another clean import waits for approval', up5.body.status === 'PENDING_APPROVAL', JSON.stringify(up5.body.errors?.slice(0, 3)));
    await call('POST', '/api/members', { memberNo: 'IM0027', firstName: 'Taken', lastName: 'Since' });
    const ap5 = await call('POST', `/api/data-imports/${up5.body.id}/approve`);
    check('when something changed since the upload, approval fails with the reasons',
      ap5.status === 409 && ap5.reason === 'IMPORT_FAILED' && ap5.body.importErrors.some((e) => e.sheet === 'Members' && /member number is already in use/i.test(e.message)),
      ap5.text.slice(0, 400));
    check('the import is FAILED', (await call('GET', `/api/data-imports/${up5.body.id}`)).body.status === 'FAILED');
    check('and nothing of it was created', (await q1("SELECT count(*)::int AS n FROM branches WHERE code = 'WEST7'")).n === 0
      && (await q1("SELECT count(*)::int AS n FROM members WHERE member_no = 'IM0017'")).n === 0);
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    check('a file over 5 MB is refused', (await call('POST', '/api/data-imports?wait=true', null, { binary: big })).status === 413);
    const notX = await call('POST', '/api/data-imports?wait=true', null, { binary: Buffer.from('name,phone\nann,1\n'), headers: { 'content-type': 'text/csv' } });
    check('a file that is not a workbook is ERROR with a reason', notX.body.status === 'ERROR' && /not an .xlsx file/i.test(notX.body.errors[0].message), notX.text);
    const bomb = zip([{ name: 'xl/workbook.xml', data: Buffer.alloc(60 * 1024 * 1024, 32) }]);
    const up6 = await call('POST', '/api/data-imports?wait=true', null, { binary: bomb });
    check('a small file that inflates to a huge one is refused', up6.body.status === 'ERROR', `${bomb.length} ${up6.text.slice(0, 200)}`);
    const listed = await call('GET', '/api/data-imports');
    check('imports are listed, newest first', listed.body.length >= 5 && listed.body[0].created_at >= listed.body[1].created_at);
    const orig = await call('GET', `/api/data-imports/${up3.body.id}/file`, null, { raw: true });
    check('the uploaded workbook is kept', orig.status === 200 && orig.buffer.length === up3.body.file_size);

    // ---------------------------------------------------------------------
    section('incremental extract');
    const streams = await call('GET', '/api/extract');
    check('the streams are listed with their key and replication key',
      streams.status === 200 && streams.body.some((s) => s.stream === 'members' && s.replicationKey === 'updated_at' && s.keyProperties[0] === 'id')
      && streams.body.some((s) => s.stream === 'journal_lines' && s.replicationKey === 'journal_entries.created_at'));
    check('with a JSON Schema from the dictionary', streams.body.find((s) => s.stream === 'members').schema.properties.joined_on.format === 'date');
    check('a teller may not extract', (await call('GET', '/api/extract/members', null, { auth: teller })).status === 403);
    const total = (await q1('SELECT count(*)::int AS n FROM members')).n;
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 50; i += 1) {
      const pg = await call('GET', `/api/extract/members?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...pg.body.items.map((m) => m.id));
      cursor = pg.body.nextCursor;
      if (!pg.body.hasMore) break;
    }
    check('paging through a stream returns every row once', seen.length === total && new Set(seen).size === total, `${seen.length}/${total}`);
    const idle = await call('GET', `/api/extract/members?cursor=${cursor}`);
    check('with nothing new, nothing comes back and the cursor stands', idle.body.items.length === 0 && idle.body.nextCursor === cursor);
    await call('PATCH', `/api/members/${im1.id}`, { city: 'Naivasha' });
    const changedRows = await call('GET', `/api/extract/members?cursor=${cursor}`);
    check('a change is picked up after the cursor', changedRows.body.items.length === 1 && changedRows.body.items[0].city === 'Naivasha');
    cursor = changedRows.body.nextCursor;
    // A transaction still open stamps its rows before it commits. Nothing at
    // or after its start is returned until it has.
    const slow = await pool.connect();
    await slow.query('BEGIN');
    await slow.query(`SELECT set_config('search_path', '${SCHEMA}, public', true)`);
    await slow.query("UPDATE members SET notes = 'slow' WHERE member_no = 'IM002'");
    await call('PATCH', `/api/members/${m0.body.id}`, { city: 'Thika' });
    const held = await call('GET', `/api/extract/members?cursor=${cursor}`);
    check('while an earlier transaction is still open, later rows wait too', held.body.items.length === 0, JSON.stringify(held.body.items.map((x) => x.member_no)));
    await slow.query('COMMIT');
    slow.release();
    const released = await call('GET', `/api/extract/members?cursor=${cursor}`);
    check('once it commits, both come through, in order', released.body.items.map((x) => x.member_no).join(',') === `IM002,${m0.body.member_no}`,
      released.body.items.map((x) => x.member_no).join(','));
    const jl = await call('GET', '/api/extract/journal_lines?limit=1000');
    check('journal lines are read on their entry\'s time', jl.status === 200 && jl.body.items.some((x) => x.entry_id === ap.body.entry_id));
    const since = await call('GET', `/api/extract/members?since=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}`);
    check('a first call can start from a moment', since.status === 200 && since.body.items.length === 0);
    check('a forged cursor is refused', (await call('GET', '/api/extract/members?cursor=abc')).status === 400);
    check('an unknown stream is a 404', (await call('GET', '/api/extract/member_credentials')).status === 404);
    const touched = await q1("SELECT updated_at FROM loan_installments WHERE loan_id = $1 AND number = 1", [la.id]);
    await T((c) => c.query("UPDATE loan_installments SET fee_due = fee_due WHERE loan_id = $1 AND number = 1", [la.id]));
    check('a trigger stamps every change, whatever code made it',
      new Date((await q1("SELECT updated_at FROM loan_installments WHERE loan_id = $1 AND number = 1", [la.id])).updated_at) > new Date(touched.updated_at));

    section('Singer tap (Stitch)');
    const aud = await call('POST', '/api/users', { email: 'warehouse@datamgmt.local', role: 'AUDITOR', password: 'First temporary 2026' });
    const al = await call('POST', '/api/auth/login', { email: 'warehouse@datamgmt.local', password: 'First temporary 2026' }, { auth: null });
    await call('POST', '/api/auth/password', { currentPassword: 'First temporary 2026', newPassword: 'Extract user pass 2026' }, { auth: al.body.passwordChangeToken });
    check('a read-only AUDITOR user for the tap', aud.status === 201);
    const fs = require('fs');
    const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'tap-'));
    fs.writeFileSync(`${dir}/config.json`, JSON.stringify({ api_url: `http://localhost:${PORT}`, tenant: SLUG, email: 'warehouse@datamgmt.local', password: 'Extract user pass 2026', page_size: 3 }));
    const cap = () => { const o = { buf: '', write(s) { o.buf += s; return true; } }; return o; };
    const out1 = cap();
    await tap(['--config', `${dir}/config.json`, '--discover'], { stdout: out1, stderr: cap() });
    const catalog = JSON.parse(out1.buf);
    check('discovery writes a Singer catalog', catalog.streams.length === Object.keys(EX.STREAMS).length
      && catalog.streams[0].metadata[0].metadata['table-key-properties'].length === 1);
    for (const s of catalog.streams) s.metadata[0].metadata.selected = ['members', 'savings_accounts'].includes(s.stream);
    fs.writeFileSync(`${dir}/catalog.json`, JSON.stringify(catalog));
    const out2 = cap();
    const r2 = await tap(['--config', `${dir}/config.json`, '--catalog', `${dir}/catalog.json`], { stdout: out2, stderr: cap() });
    const msgs2 = out2.buf.trim().split('\n').map((x) => JSON.parse(x));
    check('a sync writes SCHEMA, then RECORD messages, with STATE after each page',
      msgs2[0].type === 'SCHEMA' && msgs2[0].stream === 'members' && msgs2.filter((x) => x.type === 'RECORD' && x.stream === 'members').length === total
      && msgs2.filter((x) => x.type === 'STATE').length >= 2 && msgs2[msgs2.length - 1].type === 'STATE', JSON.stringify(r2.counts));
    check('only the streams selected', new Set(msgs2.filter((x) => x.type === 'RECORD').map((x) => x.stream)).size === 2);
    fs.writeFileSync(`${dir}/state.json`, JSON.stringify(msgs2[msgs2.length - 1].value));
    const out3 = cap();
    await tap(['--config', `${dir}/config.json`, '--catalog', `${dir}/catalog.json`, '--state', `${dir}/state.json`], { stdout: out3, stderr: cap() });
    check('run again from its state, it sends nothing new', !out3.buf.includes('"type":"RECORD"'));
    await call('PATCH', `/api/members/${im1.id}`, { city: 'Eldoret' });
    const out4 = cap();
    await tap(['--config', `${dir}/config.json`, '--catalog', `${dir}/catalog.json`, '--state', `${dir}/state.json`], { stdout: out4, stderr: cap() });
    const rec4 = out4.buf.trim().split('\n').map((x) => JSON.parse(x)).filter((x) => x.type === 'RECORD');
    check('and only what changed since', rec4.length === 1 && rec4[0].record.city === 'Eldoret');

    // ---------------------------------------------------------------------
    section('database backup');
    check('a teller may not ask for one', (await call('POST', '/api/database/backup', {}, { auth: teller })).status === 403);
    delete process.env.CALLBACK_ALLOW_PRIVATE;
    for (const url of ['http://example.com/x', `https://127.0.0.1:${HOOK_PORT}/x`, 'https://169.254.169.254/latest', 'https://localhost/x', 'https://user:pw@example.com/x', 'https://[::1]/x']) {
      const r = await call('POST', '/api/database/backup', { callback: url });
      check(`a callback to ${url} is refused`, r.status === 400, `${r.status} ${r.reason}`);
    }
    check('private and loopback addresses are recognised', ['10.0.0.1', '172.16.3.4', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.1.2.3']
      .every((ip) => backup.isPrivateAddress(ip)) && !backup.isPrivateAddress('41.90.1.1') && !backup.isPrivateAddress('2001:4860::8888'));
    check('an unknown table is refused', (await call('POST', '/api/database/backup', { tables: ['nope'] })).status === 400);
    check('member PINs are never exported', /TABLE_IS_NOT_EXPORTED/.test((await call('POST', '/api/database/backup', { tables: ['member_credentials'] })).reason));
    await T((c) => c.query("INSERT INTO database_backups (status, created_by) VALUES ('IN_PROGRESS', 'other')"));
    const busy = await call('POST', '/api/database/backup', {});
    check('one backup at a time', busy.status === 409 && /BACKUP_IN_PROGRESS/.test(busy.reason));
    check('LATEST while one is running is a 409, not an older file', (await call('GET', '/api/database/backup/LATEST', null, { raw: true })).status === 409);
    await T((c) => c.query("DELETE FROM database_backups WHERE created_by = 'other'"));
    process.env.CALLBACK_ALLOW_PRIVATE = 'true';
    const req = await call('POST', '/api/database/backup', { callback: `http://localhost:${HOOK_PORT}/done` });
    check('a backup is accepted and runs in the background', req.status === 202 && req.body.state === 'IN_PROGRESS', req.text);
    await backup.waitFor(req.body.id);
    const rec = await call('GET', `/api/database/backup/${req.body.id}`);
    check('it completes, with its size, checksum and row counts', rec.body.status === 'COMPLETE' && rec.body.file_size > 0 && /^[0-9a-f]{64}$/.test(rec.body.sha256)
      && rec.body.row_counts.members === (await q1('SELECT count(*)::int AS n FROM members')).n, JSON.stringify(rec.body).slice(0, 300));
    check('it is kept for 30 days', Math.round((new Date(rec.body.expires_at) - new Date(rec.body.finished_at)) / 86400e3) === 30);
    check('the callback is told', hooks.length === 1 && hooks[0].state === 'COMPLETE' && hooks[0].backupId === req.body.id && rec.body.callback_result.status === 204, JSON.stringify(hooks));
    const file = await call('GET', '/api/database/backup/LATEST', null, { raw: true });
    check('LATEST downloads the ZIP', file.status === 200 && file.headers.get('content-type') === 'application/zip');
    const files = unzip(file.buffer, { maxTotal: 500 * 1024 * 1024 });
    check('with a CSV per table, the schema, the dictionary and a manifest',
      files.has('members.csv') && files.has('loan_installments.csv') && files.has('schema.sql') && files.has('dictionary.json') && files.has('manifest.json'));
    check('never the member portal\'s secrets', !files.has('member_credentials.csv') && !files.has('member_sessions.csv') && !files.has('member_login_attempts.csv'));
    const mcsv = files.get('members.csv').toString().trim().split('\r\n');
    check('a CSV has a header row and a line per row', mcsv[0].startsWith('id,member_no,first_name') && mcsv.length - 1 === rec.body.row_counts.members, mcsv[0]);
    check('dates as yyyy-MM-dd and timestamps in UTC', /,2019-02-01,/.test(files.get('members.csv').toString()) && /\+00/.test(mcsv[1]));
    const manifest = JSON.parse(files.get('manifest.json'));
    check('binary columns are left out and listed', !files.get('loan_attachments.csv').toString().split('\r\n')[0].split(',').includes('data')
      && manifest.omittedColumns.loan_attachments.includes('data') && manifest.omittedColumns.data_imports.includes('file'));
    check('the schema has a CREATE TABLE per file', /CREATE TABLE "members"/.test(files.get('schema.sql').toString()) && /COMMENT ON COLUMN "members"."member_no"/.test(files.get('schema.sql').toString()));
    const zsha = require('crypto').createHash('sha256').update(file.buffer).digest('hex');
    check('the checksum is the file\'s', zsha === rec.body.sha256 && file.headers.get('x-backup-sha256') === zsha);
    // The CSVs load back into Postgres as they are.
    const restore = await pool.connect();
    try {
      await restore.query('DROP SCHEMA IF EXISTS backup_restore_check CASCADE; CREATE SCHEMA backup_restore_check');
      await restore.query('SET search_path = backup_restore_check');
      await restore.query(files.get('schema.sql').toString());
      const cols = mcsv[0].split(',');
      for (const line of mcsv.slice(1)) {
        const vals = parseCsvLine(line);
        await restore.query(`INSERT INTO members (${cols.map((x) => `"${x}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals.map((v) => (v === '' ? null : v)));
      }
      const { rows: [n] } = await restore.query('SELECT count(*)::int AS n, max(joined_on)::text AS j FROM members');
      check('schema.sql and the CSV load into an empty database', n.n === rec.body.row_counts.members, JSON.stringify(n));
    } finally {
      await restore.query('RESET search_path; DROP SCHEMA IF EXISTS backup_restore_check CASCADE').catch(() => {});
      restore.release();
    }
    const part = await call('POST', '/api/database/backup', { tables: ['members', 'branches'], createBackupFromDate: new Date(Date.now() - 60e3).toISOString() });
    await backup.waitFor(part.body.id);
    const pf = unzip((await call('GET', `/api/database/backup/${part.body.id}/file`, null, { raw: true })).buffer);
    const recent = (await q1("SELECT count(*)::int AS n FROM members WHERE created_at >= now() - interval '61 seconds' OR updated_at >= now() - interval '61 seconds'")).n;
    check('a backup of some tables, from a moment', [...pf.keys()].filter((k) => k.endsWith('.csv')).sort().join(',') === 'branches.csv,members.csv'
      && JSON.parse(pf.get('manifest.json')).tables.members <= recent && JSON.parse(pf.get('manifest.json')).tables.members >= 1, JSON.stringify(JSON.parse(pf.get('manifest.json')).tables));
    const history = await call('GET', '/api/database/backup');
    check('backups are listed, without their files', history.body.length === 2 && !('file' in history.body[0]));
    await T((c) => c.query("UPDATE database_backups SET expires_at = now() - interval '1 day'"));
    const gone = await call('GET', '/api/database/backup/LATEST', null, { raw: true });
    check('after 30 days the file is gone', gone.status === 410);
    check('and the record says so', (await call('GET', `/api/database/backup/${req.body.id}`)).body.status === 'EXPIRED'
      && (await q1('SELECT count(*)::int AS n FROM database_backups WHERE file IS NOT NULL')).n === 0);

    // ---------------------------------------------------------------------
    section('structure');
    const all = await Rd((c) => DD.build(c));
    check('the dictionary describes every table and column of the schema (add words to src/db/dictionary.js with a migration)',
      all.missing.length === 0, all.missing.join(', '));
  } catch (e) {
    fail++; failures.push(e.stack); console.error(e);
  } finally {
    server.close();
    hookServer.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.join('\n'));
    process.exit(fail ? 1 : 0);
  }
})();

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
