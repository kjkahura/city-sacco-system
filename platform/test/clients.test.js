#!/usr/bin/env node
'use strict';

/**
 * Clients and Groups, after the reference platform: member IDs from client types (and the
 * audit's two numbering defects), the creator's branch, validation and
 * duplicate checks, editing core details under their own permissions,
 * the life cycle and what the database refuses in each state, groups with
 * role names and the group controls, groups holding accounts, the reference platform's
 * /clients and /groups (JSON Patch, PUT, :search), reassigning with the
 * accounts, deleting and anonymizing, and custom fields per client type.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const SH = require('../src/domain/shares');
const L = require('../src/domain/loans');
const PERMS = require('../src/lib/permissions');
const RP = require('../src/lib/routePermissions');
const { orgDay } = require('./_org');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'cgtest';
const PORT = 4112;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(`tenant_${SLUG}`, fn);
const q1 = async (sql, p = []) => (await pool.query(sql, p)).rows[0];

const tokens = {};
async function call(method, p, body, { who = 'admin', headers: extra = {} } = {}) {
  const headers = { 'x-tenant': SLUG, ...extra };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body !== undefined && body !== null ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 400), reason: d?.errors?.[0]?.errorReason || '', headers: r.headers };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return call('POST', '/api/auth/login', { email, password }, { who: 'nobody' });
}
const state = async (id) => (await q1(`SELECT status FROM tenant_${SLUG}.members WHERE id = $1`, [id])).status;

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Clients SACCO', mfaRequiredRoles: [], adminEmail: 'admin@cg.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = (await login('admin@cg.local', PASSWORD)).body?.accessToken;
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    await call('POST', '/api/branches', { code: 'NTH', name: 'North' });
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@cg.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = (await login(`${who}@cg.local`)).body?.accessToken;
      return u.body;
    };
    await mk('manager', { role: 'MANAGER', branchId: 'HQ' });
    await mk('teller', { role: 'TELLER', branchId: 'NTH', accessRights: { allBranches: false } });
    await mk('officer', { role: 'MANAGER', userType: 'CREDIT_OFFICER', branchId: 'HQ' });
    const clerkRole = await call('POST', '/api/roles', { code: 'CLERK', name: 'Clerk', baseRole: 'TELLER',
      permissions: ['VIEW_CLIENT_DETAILS', 'CREATE_CLIENT', 'EDIT_CLIENT'] });
    check('a clerk role that edits members but not their association', clerkRole.status === 201, clerkRole.text);
    await mk('clerk', { role: 'CLERK', branchId: 'HQ' });
    check('staff signed in', tokens.admin && tokens.manager && tokens.teller && tokens.officer && tokens.clerk);

    // ------------------------------------------------------------------------
    section('permissions: the reference platform\'s Clients and Groups codes');
    const codes = PERMS.CATALOG.filter((p) => ['Clients', 'Groups'].includes(p.group)).map((p) => p.code);
    check('14 client and 7 group codes', codes.length === 21 && codes.includes('BLACKLIST_CLIENT') && codes.includes('MANAGE_GROUP_ASSOCIATION'), codes.join(','));
    check('the route table names only catalogued codes', RP.codes().every((c) => PERMS.CODES.has(c)));
    check('a manager keeps what EDIT_CLIENT did: state, association', ['APPROVE_CLIENT', 'EXIT_CLIENT', 'MANAGE_CLIENT_ASSOCIATION', 'EDIT_GROUP']
      .every((c) => PERMS.DEFAULTS.MANAGER.includes(c)));
    check('deleting and anonymizing are the administrator\'s', !PERMS.DEFAULTS.MANAGER.includes('DELETE_CLIENTS') && !PERMS.DEFAULTS.MANAGER.includes('ANONYMIZE_CLIENT'));
    check('a teller creates members and groups, and does not approve them',
      PERMS.DEFAULTS.TELLER.includes('CREATE_GROUP') && !PERMS.DEFAULTS.TELLER.includes('APPROVE_CLIENT'));

    // ------------------------------------------------------------------------
    section('member IDs (audit defects 1 and 2)');
    const first = await call('POST', '/api/members', { firstName: 'Amina', lastName: 'Hassan', branchId: 'HQ' });
    check('the default client type gives M000001', first.status === 201 && first.body.member_no === 'M000001' && first.body.client_type_id === 'client', first.text);
    const par = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/api/members', { firstName: 'Parallel', lastName: `Member${String.fromCharCode(65 + i)}`, branchId: 'HQ' })));
    const nos = new Set(par.map((x) => x.body?.member_no));
    check('ten created at once all succeed, with ten numbers', par.every((x) => x.status === 201) && nos.size === 10, par.map((x) => x.status).join(' '));
    const long = await call('POST', '/api/members', { firstName: 'Wanjiru', lastName: 'Migrant', memberNo: '483920117', branchId: 'HQ' });
    check('an administrator gives a nine-digit ID by hand', long.status === 201 && long.body.member_no === '483920117', long.text);
    const after = await call('POST', '/api/members', { firstName: 'After', lastName: 'Migrant', branchId: 'HQ' });
    const after2 = await call('POST', '/api/members', { firstName: 'Again', lastName: 'Migrant', branchId: 'HQ' });
    check('the next numbers carry on and are not cut (M000012, M000013)', after.body?.member_no === 'M000012' && after2.body?.member_no === 'M000013', `${after.text} ${after2.text}`);
    const taken = await call('POST', '/api/members', { firstName: 'Taken', lastName: 'Number', memberNo: 'M000014', branchId: 'HQ' });
    const skip = await call('POST', '/api/members', { firstName: 'Skips', lastName: 'Taken', branchId: 'HQ' });
    check('a number taken by hand is stepped over', taken.status === 201 && skip.body?.member_no === 'M000015', `${taken.text} ${skip.text}`);
    const tellerId = await call('POST', '/api/members', { firstName: 'By', lastName: 'Hand', memberNo: 'X1' }, { who: 'teller' });
    check('an ID by hand needs EDIT_CLIENT_ID', tellerId.status === 403 && /EDIT_CLIENT_ID/.test(tellerId.reason), tellerId.text);
    const badId = await call('POST', '/api/members', { firstName: 'Bad', lastName: 'Id', memberNo: '2024/0001 ../x' });
    check('an ID with a slash or spaces is refused', badId.status === 400, badId.text);
    const kt = await call('POST', '/api/client-types', { holderType: 'CLIENT', id: 'student', name: 'Student', idPattern: 'ST-####', canGuarantee: false });
    check('a client type with its own ID pattern', kt.status === 201 && kt.body.idPattern === 'ST-####' && kt.body.canGuarantee === false, kt.text);
    const st1 = await call('POST', '/api/members', { firstName: 'Student', lastName: 'One', clientTypeId: 'student', branchId: 'HQ' });
    check('its members are numbered by it', st1.body?.member_no === 'ST-0001', st1.text);
    await T((c) => c.query("UPDATE client_types SET next_number = 9999 WHERE id = 'student'"));
    const st2 = await call('POST', '/api/members', { firstName: 'Student', lastName: 'Two', clientTypeId: 'student', branchId: 'HQ' });
    const st3 = await call('POST', '/api/members', { firstName: 'Student', lastName: 'Three', clientTypeId: 'student', branchId: 'HQ' });
    check('and the run of # widens instead of being cut (ST-9999, ST-10000)', st2.body?.member_no === 'ST-9999' && st3.body?.member_no === 'ST-10000', `${st2.text} ${st3.text}`);
    check('a pattern with two runs of # is refused', (await call('POST', '/api/client-types', { holderType: 'CLIENT', name: 'Bad', idPattern: '##-##' })).status === 400);

    // ------------------------------------------------------------------------
    section('the creator\'s branch (audit defect 3), and required assignments');
    const byTeller = await call('POST', '/api/members', { firstName: 'Northern', lastName: 'Member' }, { who: 'teller' });
    check('a branch-limited teller creates a member without naming a branch', byTeller.status === 201, byTeller.text);
    const nth = await q1(`SELECT id FROM tenant_${SLUG}.branches WHERE code = 'NTH'`);
    check('it lands in the teller\'s branch, and the teller sees it', byTeller.body?.branch_id === nth.id
      && (await call('GET', `/api/members/${byTeller.body.id}`, null, { who: 'teller' })).status === 200);
    await call('PATCH', '/api/client-controls', { requiredAssignments: ['BRANCH'] });
    const nob = await call('POST', '/api/members', { firstName: 'No', lastName: 'Branch' });
    check('with the branch required, a member without one is refused', nob.status === 400 && /BRANCH_REQUIRED/.test(nob.reason), nob.text);
    await call('PATCH', '/api/client-controls', { requiredAssignments: [] });
    check('the client controls are read by any staff user and changed by an administrator only',
      (await call('GET', '/api/client-controls', null, { who: 'teller' })).status === 200
      && (await call('PATCH', '/api/client-controls', { multipleGroups: true }, { who: 'manager' })).status === 403);

    // ------------------------------------------------------------------------
    section('what comes in is checked (audit defects 6 and 7)');
    const badDob = await call('POST', '/api/members', { firstName: 'Bad', lastName: 'Date', dateOfBirth: '2020-13-45', branchId: 'HQ' });
    check('an impossible birth date is a 400, not a 500', badDob.status === 400 && /DATE_OF_BIRTH_IS_A_DATE/.test(badDob.reason), badDob.text);
    const future = await call('POST', '/api/members', { firstName: 'Future', lastName: 'Born', dateOfBirth: orgDay(3), branchId: 'HQ' });
    check('a birth date in the future is refused', future.status === 400 && /FUTURE/.test(future.reason), future.text);
    const gm = await call('POST', '/api/members', { firstName: 'Gender', lastName: 'Letter', gender: 'f', branchId: 'HQ' });
    check('gender M or F is read as MALE or FEMALE', gm.status === 201 && gm.body.gender === 'FEMALE', gm.text);
    check('an email that is not one is refused', (await call('POST', '/api/members', { firstName: 'E', lastName: 'Mail', email: 'nope', branchId: 'HQ' })).status === 400);
    const nid = await call('POST', '/api/members', { firstName: 'Id', lastName: 'Holder', nationalId: '12 345 678', dateOfBirth: '1990-05-01',
      phone: '0712345678', branchId: 'HQ' });
    check('a national ID is kept without spaces', nid.status === 201 && nid.body.national_id === '12345678', nid.text);
    const dupNid = await call('POST', '/api/members', { firstName: 'Other', lastName: 'Person', nationalId: ' 12345678', branchId: 'HQ' });
    check('the same national ID with a space is refused as a duplicate (Error)', dupNid.status === 409 && /DUPLICATE_CLIENT: DOCUMENT_ID matches M/.test(dupNid.reason), dupNid.text);
    const dupNorth = await call('POST', '/api/members', { firstName: 'North', lastName: 'Copy', nationalId: '12345678' }, { who: 'teller' });
    check('also for a teller who cannot see the other branch', dupNorth.status === 409 && /DUPLICATE_CLIENT/.test(dupNorth.reason), dupNorth.text);
    const warn = await call('POST', '/api/members', { firstName: 'id', lastName: 'HOLDER', dateOfBirth: '1990-05-01', phone: '+254 712 345 678', branchId: 'HQ' });
    check('name with birth date, and the phone in another format, are warnings: created, with what they matched', warn.status === 201
      && warn.body.duplicateWarnings.some((d) => d.check === 'NAME_AND_BIRTH_DATE') && warn.body.duplicateWarnings.some((d) => d.check === 'PHONE'),
    JSON.stringify(warn.body?.duplicateWarnings));
    const dryRun = await call('POST', '/api/members:duplicates', { firstName: 'Id', lastName: 'Holder', nationalId: '12-345-678' });
    check('the checks can be asked before saving (members:duplicates)', dryRun.status === 200 && dryRun.body.some((d) => d.check === 'DOCUMENT_ID' && d.level === 'ERROR'), dryRun.text);
    const search = await call('GET', '/api/members?q=12345678');
    check('the member search finds a national ID', search.body?.length === 1 && search.body[0].id === nid.body.id, search.text);

    // ------------------------------------------------------------------------
    section('core details are editable, each change under its permission (audit defect 8)');
    const ed = await call('PATCH', `/api/members/${gm.body.id}`, { nationalId: '99887766', dateOfBirth: '1985-02-03', gender: 'MALE' }, { who: 'manager' });
    check('national ID, birth date and gender change', ed.status === 200 && ed.body.national_id === '99887766' && ed.body.date_of_birth === '1985-02-03' && ed.body.gender === 'MALE', ed.text);
    const st = await call('PATCH', `/api/members/${gm.body.id}`, { status: 'EXITED' });
    check('the state does not change by PATCH', st.status === 400 && /STATE_ACTIONS/.test(st.reason), st.text);
    const cro = await call('PATCH', `/api/members/${gm.body.id}`, { creditOfficer: 'officer@cg.local' }, { who: 'clerk' });
    check('a clerk with EDIT_CLIENT only does not change the credit officer (MANAGE_CLIENT_ASSOCIATION)', cro.status === 403 && /MANAGE_CLIENT_ASSOCIATION/.test(cro.reason), cro.text);
    const cro2 = await call('PATCH', `/api/members/${gm.body.id}`, { creditOfficer: 'officer@cg.local' }, { who: 'manager' });
    check('a manager does', cro2.status === 200 && cro2.body.credit_officer === 'officer@cg.local', cro2.text);
    const typ = await call('PATCH', `/api/members/${gm.body.id}`, { clientTypeId: 'student' }, { who: 'clerk' });
    check('changing the type needs CHANGE_CLIENT_TYPE', typ.status === 403 && /CHANGE_CLIENT_TYPE/.test(typ.reason), typ.text);
    const idc = await call('PATCH', `/api/members/${gm.body.id}`, { memberNo: 'GM-1' }, { who: 'manager' });
    check('changing the ID needs EDIT_CLIENT_ID, which a manager holds', idc.status === 200 && idc.body.member_no === 'GM-1', idc.text);

    // ------------------------------------------------------------------------
    section('the life cycle (audit defects 4 and 5)');
    await call('PATCH', '/api/client-controls', { initialState: 'PENDING_APPROVAL' });
    const p1 = await call('POST', '/api/members', { firstName: 'Pending', lastName: 'Person', branchId: 'HQ' });
    check('with the control set, a new member is PENDING_APPROVAL', p1.body?.status === 'PENDING_APPROVAL', p1.text);
    check('the state is not taken from the request', (await call('POST', '/api/members', { firstName: 'Says', lastName: 'Exited', status: 'EXITED', branchId: 'HQ' })).status === 400);
    const noAcc = await T((c) => S.open(c, { memberId: p1.body.id }).then(() => 'opened', (e) => e.message));
    check('the database refuses an account for a member pending approval', /HOLDER_MAY_NOT_OPEN_ACCOUNTS: .* is PENDING_APPROVAL/.test(noAcc), noAcc);
    const tApprove = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'APPROVE' }, { who: 'teller' });
    check('a teller does not approve (APPROVE_CLIENT)', tApprove.status === 403, tApprove.text);
    const ap = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'APPROVE' }, { who: 'manager' });
    check('a manager approves: INACTIVE', ap.status === 200 && ap.body.status === 'INACTIVE' && ap.body.approved_at, ap.text);
    const ua = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'UNDO_APPROVE' }, { who: 'manager' });
    check('approval is undone while there are no accounts', ua.body?.status === 'PENDING_APPROVAL', ua.text);
    const rj = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'REJECT', reason: 'Incomplete KYC' }, { who: 'manager' });
    check('rejected, with the reason', rj.body?.status === 'REJECTED' && rj.body.state_reason === 'Incomplete KYC', rj.text);
    check('a rejected member is not approved', (await call('POST', `/api/members/${p1.body.id}/state`, { action: 'APPROVE' })).status === 409);
    await call('POST', `/api/members/${p1.body.id}/state`, { action: 'UNDO_REJECT' }, { who: 'manager' });
    await call('POST', `/api/members/${p1.body.id}/state`, { action: 'APPROVE' }, { who: 'manager' });
    await call('PATCH', '/api/client-controls', { initialState: 'INACTIVE' });
    const acc = await T(async (c) => { const a = await S.open(c, { memberId: p1.body.id }); await S.deposit(c, a.id, { amount: 500, channelId: 'cash', createdBy: 'test' }); return a; });
    check('an account opened: ACTIVE on its own', await state(p1.body.id) === 'ACTIVE');
    const uaAcc = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'UNDO_APPROVE' });
    check('approval is not undone once there are accounts', uaAcc.status === 409, uaAcc.text);
    const exAct = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'EXIT' }, { who: 'manager' });
    check('an ACTIVE member does not exit', exAct.status === 409 && /CANNOT_EXIT_A_CLIENT_IN_STATE: ACTIVE/.test(exAct.reason), exAct.text);
    const other = await call('POST', '/api/members', { firstName: 'Share', lastName: 'Taker', branchId: 'HQ' });
    const shares = await T(async (c) => {
      const mine = await SH.open(c, { memberId: p1.body.id });
      await SH.purchase(c, mine.id, { units: 10, channelId: 'cash', createdBy: 'test' });
      const theirs = await SH.open(c, { memberId: other.body.id });
      return { mine, theirs };
    });
    await T(async (c) => { await S.withdraw(c, acc.id, { amount: 500, channelId: 'cash', createdBy: 'test' }); });
    const closeAcc = await call('POST', `/api/savings/${acc.id}/close`, {}, { who: 'manager' });
    check('an empty deposit account closes, and the member is INACTIVE again', closeAcc.status === 200 && closeAcc.body.status === 'CLOSED'
      && await state(p1.body.id) === 'INACTIVE', closeAcc.text);
    const exShares = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'EXIT' }, { who: 'manager' });
    check('a member who holds shares does not exit (transfer them first)', exShares.status === 409 && /1 shares/.test(exShares.reason), exShares.text);
    await T((c) => SH.transfer(c, shares.mine.id, { toAccountId: shares.theirs.id, units: 10, createdBy: 'test' }));
    const exit = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'EXIT', reason: 'Withdrew membership' }, { who: 'manager' });
    check('once transferred, the member exits: EXITED, dated, the share account closed', exit.status === 200 && exit.body.status === 'EXITED'
      && exit.body.exited_on === orgDay(0) && exit.body.exit_reason === 'Withdrew membership'
      && (await q1(`SELECT status FROM tenant_${SLUG}.share_accounts WHERE id = $1`, [shares.mine.id])).status === 'CLOSED', exit.text);
    const exOpen = await T((c) => S.open(c, { memberId: p1.body.id }).then(() => 'opened', (e) => e.message));
    check('an exited member opens no account', /HOLDER_MAY_NOT_OPEN_ACCOUNTS: .* is EXITED/.test(exOpen), exOpen);
    const borrower = await call('POST', '/api/members', { firstName: 'Loan', lastName: 'Taker', branchId: 'HQ' });
    await T(async (c) => { const a = await S.open(c, { memberId: borrower.body.id }); await S.deposit(c, a.id, { amount: 20000, channelId: 'cash', createdBy: 'test' }); });
    const loan = await T((c) => L.apply(c, { memberId: borrower.body.id, productId: 'NL01', principal: 10000, termMonths: 6, createdBy: 'test' }));
    const pledge = await call('POST', `/api/loans/${loan.id}/guarantors`, { memberId: p1.body.id, amount: 100 });
    check('nor guarantees a loan', pledge.status === 409 && /GUARANTOR_MAY_NOT_PLEDGE: .* is EXITED/.test(pledge.reason), pledge.text);
    const ux = await call('POST', `/api/members/${p1.body.id}/state`, { action: 'UNDO_EXIT' }, { who: 'manager' });
    check('the exit is undone: INACTIVE', ux.body?.status === 'INACTIVE' && ux.body.exited_on === null, ux.text);
    const bl = await call('POST', `/api/members/${borrower.body.id}/state`, { action: 'BLACKLIST', reason: 'Fraud alert' }, { who: 'manager' });
    check('an ACTIVE member is blacklisted', bl.body?.status === 'BLACKLISTED' && bl.body.blacklisted_from === 'ACTIVE', bl.text);
    const blDep = await T(async (c) => {
      const { rows: [a] } = await c.query("SELECT id FROM savings_accounts WHERE member_id = $1", [borrower.body.id]);
      return S.deposit(c, a.id, { amount: 10, channelId: 'cash', createdBy: 'test' }).then(() => 'ok', (e) => e.message);
    });
    check('a blacklisted member\'s accounts still transact', blDep === 'ok', blDep);
    const blOpen = await T((c) => S.open(c, { memberId: borrower.body.id }).then(() => 'opened', (e) => e.message));
    check('but open no new account', /BLACKLISTED/.test(blOpen), blOpen);
    const blEdit = await call('PATCH', `/api/members/${borrower.body.id}`, { phone: '0700000000' }, { who: 'manager' });
    check('and its details do not change', blEdit.status === 409 && /BLACKLISTED/.test(blEdit.reason), blEdit.text);
    const ub = await call('POST', `/api/members/${borrower.body.id}/state`, { action: 'UNDO_BLACKLIST' }, { who: 'manager' });
    check('undoing the blacklisting returns it to ACTIVE', ub.body?.status === 'ACTIVE' && ub.body.blacklisted_from === null, ub.text);
    const hist = await call('GET', `/api/members/${p1.body.id}/state-history`);
    const acts = hist.body.map((h) => h.action);
    check('every change is in the state history, the automatic ones too', ['CREATED', 'APPROVE', 'UNDO_APPROVE', 'REJECT', 'UNDO_REJECT', 'AUTOMATIC', 'EXIT', 'UNDO_EXIT']
      .every((a) => acts.includes(a)), acts.join(','));
    const studentPledge = await call('POST', `/api/loans/${loan.id}/guarantors`, { memberId: st1.body.id, amount: 100 });
    check('a type that may not guarantee does not (Allow as guarantor)', studentPledge.status === 409 && /TYPE_MAY_NOT_GUARANTEE/.test(studentPledge.reason), studentPledge.text);
    await call('POST', '/api/client-types', { holderType: 'CLIENT', id: 'prospect', name: 'Prospect', canOpenAccounts: false });
    const prospect = await call('POST', '/api/members', { firstName: 'Pro', lastName: 'Spect', clientTypeId: 'prospect', branchId: 'HQ' });
    const prOpen = await T((c) => S.open(c, { memberId: prospect.body.id }).then(() => 'opened', (e) => e.message));
    check('a type that may not open accounts does not (Allow opening accounts)', /TYPE_MAY_NOT_OPEN_ACCOUNTS/.test(prOpen), prOpen);
    const moveType = await call('PATCH', `/api/members/${prospect.body.id}`, { clientTypeId: 'client' }, { who: 'manager' });
    check('moved to the Client type, it may', moveType.status === 200 && await T((c) => S.open(c, { memberId: prospect.body.id }).then(() => true, () => false)), moveType.text);

    // ------------------------------------------------------------------------
    section('groups: types, role names, members, controls');
    const chair = await call('POST', '/api/group-role-names', { id: 'chair', name: 'Chairperson' });
    const treas = await call('POST', '/api/group-role-names', { name: 'Treasurer' });
    check('group role names', chair.status === 201 && treas.status === 201 && /^role_/.test(treas.body.id), `${chair.text} ${treas.text}`);
    const chamaType = await call('POST', '/api/client-types', { holderType: 'GROUP', id: 'chama', name: 'Chama', idPattern: 'CH###' });
    check('a group type', chamaType.status === 201 && chamaType.body.requireIdentificationDocuments === false, chamaType.text);
    const g1 = await call('POST', '/api/groups', { groupName: 'Umoja Women', groupRoleKey: 'chama', assignedBranchKey: nth.id,
      groupMembers: [{ clientKey: first.body.id, roles: [{ groupRoleNameKey: 'chair' }] }, { clientKey: nid.body.id, roles: [{ groupRoleNameKey: treas.body.id }] }] });
    check('a group through the reference platform\'s API: numbered by its type, its members with their roles', g1.status === 201 && g1.body.id === 'CH001'
      && g1.body.groupMembers.length === 2 && g1.body.groupMembers.some((x) => x.clientKey === first.body.id && x.roles[0].roleName === 'Chairperson'), g1.text);
    const gRow = await q1(`SELECT holder_type, status, last_name FROM tenant_${SLUG}.members WHERE id = $1`, [g1.body.encodedKey]);
    check('it is an account holder of its own, INACTIVE', gRow.holder_type === 'GROUP' && gRow.status === 'INACTIVE');
    check('the members list shows individuals, ?holderType=GROUP the groups',
      !(await call('GET', '/api/members?limit=500')).body.some((m) => m.holder_type === 'GROUP')
      && (await call('GET', '/api/members?holderType=GROUP')).body.length === 1);
    const mine = await call('GET', `/api/members/${first.body.id}`);
    check('a member shows its groups', mine.body.groups?.[0]?.member_no === 'CH001', mine.text);
    const nested = await call('POST', `/api/groups/${g1.body.id}/members`, { clientKey: g1.body.encodedKey });
    check('a group does not join a group', nested.status === 400 || nested.status === 409, nested.text);
    const exited = await call('POST', '/api/members', { firstName: 'Gone', lastName: 'Away', branchId: 'HQ' });
    await call('POST', `/api/members/${exited.body.id}/state`, { action: 'EXIT' });
    const exJoin = await call('POST', `/api/groups/${g1.body.id}/members`, { clientKey: exited.body.id });
    check('an exited client joins no group', exJoin.status === 409 && /CLIENT_MAY_NOT_JOIN_A_GROUP/.test(exJoin.reason), exJoin.text);
    await call('PATCH', '/api/client-controls', { multipleGroups: false });
    const g2 = await call('POST', '/api/groups', { groupName: 'Second group', groupMembers: [{ clientKey: first.body.id }] });
    check('with "clients may be in more than one group" off, a second group is refused', g2.status === 409 && /CLIENT_ALREADY_IN_A_GROUP/.test(g2.reason), g2.text);
    await call('PATCH', '/api/client-controls', { multipleGroups: true, groupSizeLimitType: 'HARD', groupSizeLimit: 2 });
    const third = await call('POST', `/api/groups/${g1.body.id}/members`, { clientKey: warn.body.id });
    check('a hard group size limit refuses a third member', third.status === 409 && /GROUP_SIZE_LIMIT/.test(third.reason), third.text);
    await call('PATCH', '/api/client-controls', { groupSizeLimitType: 'WARNING' });
    const third2 = await call('POST', `/api/groups/${g1.body.id}/members`, { clientKey: warn.body.id });
    check('a warning limit lets it through and says so', third2.status === 201 && third2.body.groupWarnings.length === 1 && third2.body.groupMembers.length === 3, third2.text);
    await call('PATCH', '/api/client-controls', { groupSizeLimitType: 'NONE', groupSizeLimit: null });
    const rm = await call('DELETE', `/api/groups/${g1.body.id}/members/${warn.body.id}`);
    check('a member leaves the group', rm.status === 200 && rm.body.groupMembers.length === 2, rm.text);
    const inUse = await call('DELETE', '/api/group-role-names/chair');
    check('a role name in use is not deleted', inUse.status === 409, inUse.text);
    const gState = await call('POST', `/api/members/${g1.body.encodedKey}/state`, { action: 'BLACKLIST' });
    check('groups have no state actions (the reference platform blacklists individuals only)', gState.status === 409 && /GROUPS_HAVE_NO_STATE_ACTIONS/.test(gState.reason), gState.text);

    // ------------------------------------------------------------------------
    section('groups hold accounts');
    const gOpen = await T((c) => S.open(c, { memberId: g1.body.encodedKey }).then(() => 'opened', (e) => e.message));
    check('a deposit product for individuals only is refused to a group', /PRODUCT_NOT_AVAILABLE_FOR_GROUPS: SAV01/.test(gOpen), gOpen);
    const avail = await call('PATCH', '/api/deposit-products/SAV01', { availableFor: ['INDIVIDUALS', 'GROUPS'] });
    check('the product is made available to groups', avail.status === 200 && avail.body.availableFor.includes('GROUPS'), avail.text);
    const gAcc = await T(async (c) => { const a = await S.open(c, { memberId: g1.body.encodedKey }); await S.deposit(c, a.id, { amount: 30000, channelId: 'cash', createdBy: 'test' }); return a; });
    check('the group opens a deposit account and is ACTIVE', gAcc.id && await state(g1.body.encodedKey) === 'ACTIVE');
    await call('PATCH', '/api/loan-products/NL01', { availabilitySettings: { availableFor: ['INDIVIDUALS', 'PURE_GROUPS'] } });
    const gLoan = await T((c) => L.apply(c, { memberId: g1.body.encodedKey, productId: 'NL01', principal: 20000, termMonths: 6, createdBy: 'test' }).then((l) => l, (e) => e));
    check('and applies for a group loan (the reference platform\'s PURE_GROUPS read as GROUPS)', gLoan.id && gLoan.member_id === g1.body.encodedKey, gLoan.message || '');
    const gDel = await call('DELETE', `/api/groups/${g1.body.id}`);
    check('a group that has had accounts is not deleted', gDel.status === 409, gDel.text);
    const empty = await call('POST', '/api/groups', { groupName: 'Short lived' });
    const eDel = await call('DELETE', `/api/groups/${empty.body.id}`);
    check('an empty one is (204)', empty.status === 201 && eDel.status === 204, `${empty.text} ${eDel.text}`);
    const portal = await call('POST', '/api/portal/activate', { memberNo: 'CH001', nationalId: 'x', phone: '0700000000', pin: '1234' }, { who: 'nobody' });
    check('a group has no portal', portal.status === 404, portal.text);

    // ------------------------------------------------------------------------
    section('the reference platform\'s /clients and /groups');
    const list = await call('GET', '/api/clients?limit=5&paginationDetails=ON');
    check('GET /clients lists the reference platform Client objects with the items-total header', list.status === 200 && list.body.length === 5
      && list.body[0].encodedKey && list.body[0].state && Number(list.headers.get('items-total')) > 20, list.text);
    const mc = await call('POST', '/api/clients', { firstName: 'Wanjiru', lastName: 'Shaped', mobilePhone: '0733111222', emailAddress: 'ms@example.com',
      gender: 'MALE', birthDate: '1992-07-07', assignedBranchKey: nth.id, addresses: [{ line1: 'Moi Avenue', city: 'Nairobi' }],
      idDocuments: [{ documentType: 'Passport', documentId: 'A1234567' }] });
    check('POST /clients takes the reference platform\'s fields', mc.status === 201 || mc.status === 400, mc.text);
    const mc2 = mc.status === 201 ? mc : await call('POST', '/api/clients', { firstName: 'Wanjiru', lastName: 'Shaped', mobilePhone: '0733111222',
      emailAddress: 'ms@example.com', gender: 'MALE', birthDate: '1992-07-07', assignedBranchKey: nth.id, addresses: [{ line1: 'Moi Avenue', city: 'Nairobi' }] });
    check('and returns a reference platform Client', mc2.status === 201 && mc2.body.mobilePhone === '0733111222' && mc2.body.addresses[0].city === 'Nairobi'
      && mc2.body.clientRoleKey === 'client' && mc2.body.state === 'INACTIVE', mc2.text);
    const jp = await call('PATCH', `/api/clients/${mc2.body.id}`, [{ op: 'REPLACE', path: '/mobilePhone', value: '0733999888' }, { op: 'REMOVE', path: '/emailAddress' }]);
    check('a JSON Patch replaces and removes fields', jp.status === 200 && jp.body.mobilePhone === '0733999888' && jp.body.emailAddress === null, jp.text);
    const js = await call('PATCH', `/api/clients/${mc2.body.id}`, [{ op: 'REPLACE', path: '/state', value: 'BLACKLISTED' }], { who: 'manager' });
    check('a patch of /state is the state action (INACTIVE to BLACKLISTED)', js.status === 200 && js.body.state === 'BLACKLISTED', js.text);
    await call('PATCH', `/api/clients/${mc2.body.id}`, [{ op: 'REPLACE', path: '/state', value: 'INACTIVE' }], { who: 'manager' });
    const put = await call('PUT', `/api/clients/${mc2.body.id}`, { firstName: 'Wanjiru', lastName: 'Replaced' });
    check('PUT replaces the client, clearing what it leaves out', put.status === 200 && put.body.lastName === 'Replaced' && put.body.mobilePhone === null
      && put.body.birthDate === null, put.text);
    const srch = await call('POST', '/api/clients:search', { filterCriteria: [{ field: 'lastName', operator: 'STARTS_WITH', value: 'migr' },
      { field: 'clientState', operator: 'IN', values: ['INACTIVE', 'ACTIVE'] }], sortingCriteria: { field: 'id', order: 'DESC' } });
    check('POST /clients:search with the reference platform\'s fields and operators, in SQL', srch.status === 200 && srch.body.length === 3 && srch.body[0].id === 'M000013', srch.text);
    const role = await call('GET', `/api/clients/${st1.body.member_no}/role`);
    check('GET /clients/{id}/role is its client type', role.body?.id === 'student' && role.body.canGuarantee === false, role.text);
    const gl = await call('POST', '/api/groups:search', { filterCriteria: [{ field: 'numberOfMembers', operator: 'MORE_THAN', value: 1 }] });
    check('POST /groups:search, on the number of members', gl.status === 200 && gl.body.length === 1 && gl.body[0].groupName === 'Umoja Women', gl.text);
    const gp = await call('PATCH', `/api/groups/${g1.body.id}`, [{ op: 'REPLACE', path: '/groupName', value: 'Umoja Women Group' }]);
    check('a group is patched', gp.status === 200 && gp.body.groupName === 'Umoja Women Group', gp.text);
    const clientAsGroup = await call('GET', `/api/groups/${first.body.member_no}`);
    check('a member is not found as a group', clientAsGroup.status === 404, clientAsGroup.text);

    // ------------------------------------------------------------------------
    section('reassigning, one member or many, with their accounts');
    await call('PUT', '/api/accounting/inter-branch-rules', { rules: [{ id: 'DEFAULT', glCode: '290-100' }] });
    const bulkT = await call('POST', '/api/members:reassign', { members: [borrower.body.id], branchId: 'NTH' }, { who: 'teller' });
    check('a teller does not reassign (MANAGE_CLIENT_ASSOCIATION)', bulkT.status === 403, bulkT.text);
    const extra = await call('POST', '/api/members', { firstName: 'Second', lastName: 'Mover', branchId: 'HQ' });
    await T(async (c) => { const a = await S.open(c, { memberId: extra.body.id }); await S.deposit(c, a.id, { amount: 700, channelId: 'cash', createdBy: 'test' }); });
    const bulk = await call('POST', '/api/members:reassign', { members: [borrower.body.id, extra.body.id], branchId: 'NTH', moveAccounts: true }, { who: 'manager' });
    const moved = await q1(`SELECT count(*)::int AS n FROM tenant_${SLUG}.savings_accounts WHERE member_id = ANY($1) AND branch_id = $2`, [[borrower.body.id, extra.body.id], nth.id]);
    check('two members move to North with their deposit accounts', bulk.status === 200 && bulk.body.reassigned === 2 && moved.n === 2, bulk.text);
    const loanBr = await q1(`SELECT branch_id FROM tenant_${SLUG}.loan_accounts WHERE id = $1`, [loan.id]);
    check('and the loan application too', loanBr.branch_id === nth.id);
    const keepOfficer = await call('POST', `/api/members/${gm.body.id}/association`, { branchId: 'NTH' }, { who: 'manager' });
    check('one member\'s association, keeping the credit officer', keepOfficer.status === 200 && keepOfficer.body.branchId === nth.id
      && keepOfficer.body.creditOfficer === 'officer@cg.local', keepOfficer.text);

    // ------------------------------------------------------------------------
    section('deleting and anonymizing');
    const del = await call('POST', '/api/members', { firstName: 'Delete', lastName: 'Me', phone: '0799000111', branchId: 'HQ' });
    const mgrDel = await call('DELETE', `/api/members/${del.body.id}`, null, { who: 'manager' });
    check('a manager does not delete (DELETE_CLIENTS)', mgrDel.status === 403, mgrDel.text);
    const aDel = await call('DELETE', `/api/members/${del.body.id}`);
    const trail = await q1(`SELECT after FROM tenant_${SLUG}.audit_log WHERE entity = 'member' AND entity_id = $1 AND action = 'MEMBER_CREATED'`, [del.body.id]);
    check('an administrator deletes a member who never had an account, and its audit copies lose the personal details', aDel.status === 200
      && (await call('GET', `/api/members/${del.body.id}`)).status === 404 && trail.after.redacted === true && !JSON.stringify(trail.after).includes('0799000111'), aDel.text);
    check('one who had accounts is not deleted', (await call('DELETE', `/api/members/${p1.body.id}`)).status === 409);
    await call('POST', `/api/members/${p1.body.id}/state`, { action: 'EXIT' }, { who: 'manager' });
    const noRet = await call('POST', `/api/members/${p1.body.id}/anonymize`);
    check('anonymizing waits for the SACCO to set the retention period', noRet.status === 409 && /RETENTION_NOT_SET/.test(noRet.reason), noRet.text);
    await call('PATCH', '/api/client-controls', { anonymizeAfterDays: 30 });
    const early = await call('POST', `/api/members/${p1.body.id}/anonymize`);
    check('and for the period to pass since the exit', early.status === 409 && /RETENTION_PERIOD_NOT_OVER/.test(early.reason), early.text);
    await call('PATCH', '/api/client-controls', { anonymizeAfterDays: 0 });
    const anon = await call('POST', `/api/members/${p1.body.id}/anonymize`);
    check('an exited member is anonymized: the number and accounts stay, the person does not', anon.status === 200 && anon.body.first_name === 'Anonymized'
      && anon.body.member_no === p1.body.member_no && anon.body.national_id === null && anon.body.anonymized_at, anon.text);
    check('the exit is not undone after that', (await call('POST', `/api/members/${p1.body.id}/state`, { action: 'UNDO_EXIT' })).status === 409);
    check('an active member is not anonymized', (await call('POST', `/api/members/${borrower.body.id}/anonymize`)).status === 409);

    // ------------------------------------------------------------------------
    section('setup: types, custom fields per type, the national ID template');
    check('the default type is not deleted', (await call('DELETE', '/api/client-types/client')).status === 409);
    check('nor a type in use', (await call('DELETE', '/api/client-types/student')).status === 409);
    const set = await call('POST', '/api/custom-fields/sets', { id: '_school', name: 'School', entity: 'MEMBER' });
    const fd = await call('POST', '/api/custom-fields/definitions', { id: 'schoolName', setId: '_school', name: 'School', type: 'FREE_TEXT',
      entity: 'MEMBER', availableForAll: false, usage: { items: { student: { required: true } } } });
    check('a member custom field required for students only', set.status === 201 && fd.status === 201, `${set.text} ${fd.text}`);
    const noSchool = await call('POST', '/api/members', { firstName: 'No', lastName: 'School', clientTypeId: 'student', branchId: 'HQ' });
    const withSchool = await call('POST', '/api/members', { firstName: 'With', lastName: 'School', clientTypeId: 'student', branchId: 'HQ',
      customFields: { _school: { schoolName: 'Alliance' } } });
    const plain = await call('POST', '/api/members', { firstName: 'Plain', lastName: 'Client', branchId: 'HQ' });
    check('a student needs it, a client does not', noSchool.status === 400 && withSchool.status === 201 && plain.status === 201, `${noSchool.text} ${withSchool.text}`);
    const nidT = await call('POST', '/api/id-templates', { id: 'NID', idType: 'National ID', issuingAuthority: 'Registrar', mask: '########', nationalId: true });
    check('an ID template marked as the national ID', nidT.status === 201 && nidT.body.national_id === true, nidT.text);
    const byDoc = await call('POST', '/api/members', { firstName: 'Doc', lastName: 'Filled', branchId: 'HQ', identificationDocuments: [{ templateId: 'NID', documentId: '55667788' }] });
    check('its document fills the national ID', byDoc.status === 201 && byDoc.body.national_id === '55667788', byDoc.text);
    const differ = await call('POST', '/api/members', { firstName: 'Doc', lastName: 'Differs', nationalId: '11112222', branchId: 'HQ',
      identificationDocuments: [{ templateId: 'NID', documentId: '33334444' }] });
    check('a national ID that differs from the document is refused', differ.status === 400 && /DIFFERS/.test(differ.reason), differ.text);
    const dupDoc = await call('POST', `/api/members/${plain.body.id}/identifications`, { templateId: 'NID', documentId: '55667788' });
    check('a document number another member holds is refused', dupDoc.status === 409 && /DUPLICATE_CLIENT/.test(dupDoc.reason), dupDoc.text);
    const viaPatch = await call('PATCH', `/api/members/${byDoc.body.id}`, { nationalId: '55667799' }, { who: 'manager' });
    const doc = await q1(`SELECT document_id FROM tenant_${SLUG}.member_identifications WHERE member_id = $1`, [byDoc.body.id]);
    check('a changed national ID changes the document', viaPatch.status === 200 && doc.document_id === '55667799', viaPatch.text);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`); console.log(e);
  } finally {
    server.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
    process.exit(fail ? 1 : 0);
  }
})();
