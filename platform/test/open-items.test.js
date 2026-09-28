#!/usr/bin/env node
'use strict';

/**
 * The items left open by the earlier sections: deposit and share account
 * numbers from a counter, group indicators and the GROUPS custom view,
 * importing groups and group loans, member pictures and signatures, files
 * on identification documents with the reference platform's limits, expired document flags,
 * and the general ledger for a branch-limited user.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const SH = require('../src/domain/shares');
const L = require('../src/domain/loans');
const XLSX = require('../src/lib/xlsx');
const { orgDay } = require('./_org');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'opentest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4113;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);
const q1 = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000050001', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const tokens = {};
async function call(method, p, body, { who = 'admin', headers: extra = {}, binary = null, raw = false } = {}) {
  const headers = { 'x-tenant': SLUG, ...extra };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (binary) { headers['content-type'] = headers['content-type'] || 'application/octet-stream'; payload = binary; }
  else if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  if (raw) return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 400), reason: d?.errors?.[0]?.errorReason || '' };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Open Items SACCO', mfaRequiredRoles: [], adminEmail: 'admin@open.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@open.local', PASSWORD);
    const hq = (await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' })).body;
    const nth = (await call('POST', '/api/branches', { code: 'NTH', name: 'North' })).body;
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@open.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@open.local`);
    };
    await mk('north', { role: 'MANAGER', branchId: 'NTH', accessRights: { allBranches: false } });
    await mk('both', { role: 'MANAGER', branchId: 'NTH', accessRights: { allBranches: false, branches: ['HQ'] } });
    await mk('officer', { role: 'MANAGER', userType: 'CREDIT_OFFICER', branchId: 'HQ' });
    check('staff signed in', tokens.admin && tokens.north && tokens.both);

    // ------------------------------------------------------------------------
    section('deposit and share account numbers (the Clients and Groups audit)');
    const members = [];
    for (let i = 0; i < 12; i += 1) members.push((await call('POST', '/api/members', { firstName: 'Saver', lastName: `Number${String.fromCharCode(65 + i)}`, branchId: 'HQ' })).body);
    const opened = await Promise.all(members.slice(0, 10).map((m) => call('POST', '/api/savings', { memberId: m.id, productId: 'SAV01' })));
    const nos = new Set(opened.map((x) => x.body?.account_no));
    check('ten deposit accounts opened at once all succeed, with ten numbers', opened.every((x) => x.status === 201) && nos.size === 10, opened.map((x) => `${x.status} ${x.reason}`).join(' '));
    check('in the same format as before (SA000001 to SA000010)', [...nos].sort()[0] === 'SA000001' && [...nos].sort()[9] === 'SA000010', [...nos].join(','));
    await T((c) => c.query("INSERT INTO savings_accounts (account_no, member_id, product_id, status) VALUES ('SA000011', $1, 'SAV01', 'ACTIVE')", [members[10].id]));
    const skip = await T((c) => S.open(c, { memberId: members[11].id }));
    check('a number already taken is stepped over', skip.account_no === 'SA000012', skip.account_no);
    await T((c) => c.query("UPDATE account_counters SET next_number = 999999 WHERE kind = 'SAVINGS'"));
    const wide = await T(async (c) => [await S.open(c, { memberId: members[0].id }), await S.open(c, { memberId: members[1].id })]);
    check('and the number widens instead of being cut (SA999999, SA1000000)', wide[0].account_no === 'SA999999' && wide[1].account_no === 'SA1000000',
      wide.map((a) => a.account_no).join(','));
    const sh = await T(async (c) => [await SH.open(c, { memberId: members[0].id }), await SH.open(c, { memberId: members[1].id })]);
    check('share accounts are numbered the same way (SH000001, SH000002)', sh[0].account_no === 'SH000001' && sh[1].account_no === 'SH000002', sh.map((a) => a.account_no).join(','));

    // ------------------------------------------------------------------------
    section('group indicators and the GROUPS custom view');
    const g1 = await call('POST', '/api/groups', { groupName: 'Umoja', assignedBranchKey: hq.id,
      groupMembers: [{ clientKey: members[0].id }, { clientKey: members[1].id }, { clientKey: members[2].id }] });
    const g2 = await call('POST', '/api/groups', { groupName: 'Tumaini', assignedBranchKey: hq.id, groupMembers: [{ clientKey: members[2].id }] });
    await call('PATCH', '/api/loan-products/NL01', { availableFor: ['INDIVIDUALS', 'GROUPS'] });
    await call('PATCH', '/api/deposit-products/SAV01', { availableFor: ['INDIVIDUALS', 'GROUPS'] });
    await T(async (c) => {
      const a = await S.open(c, { memberId: g1.body.encodedKey });
      await S.deposit(c, a.id, { amount: 50000, channelId: 'cash', createdBy: 'test' });
      const l = await L.apply(c, { memberId: g1.body.encodedKey, productId: 'NL01', principal: 12000, termMonths: 6, createdBy: 'test' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'admin' });
      await L.disburse(c, l.id, { amount: 12000, channelId: 'bank', valueDate: orgDay(0), createdBy: 'test' });
    });
    const ind = await call('GET', '/api/reports/indicators?codes=GROUPS,ACTIVE_GROUPS,GROUP_MEMBERS,GROUP_BORROWERS,GROUP_LOAN_PORTFOLIO,CLIENTS');
    const iv = Object.fromEntries((ind.body?.indicators || []).map((x) => [x.code, x.value]));
    check('groups have indicators of their own', ind.status === 200 && iv.GROUPS === 2 && iv.ACTIVE_GROUPS === 1 && iv.GROUP_MEMBERS === 3
      && iv.GROUP_BORROWERS === 1 && iv.GROUP_LOAN_PORTFOLIO === 12000, JSON.stringify(iv));
    check('and the client figures still count individuals only', iv.CLIENTS === 12, String(iv.CLIENTS));
    const byBranch = await call('GET', `/api/reports/indicators?entityType=BRANCH&entityId=${nth.id}&codes=GROUPS`);
    check('scoped to a branch', byBranch.body?.indicators?.[0]?.value === 0, byBranch.text);
    const run = await call('POST', '/api/views/run', { entity: 'GROUPS', columns: ['groupId', 'groupName', 'members', 'loanBalance'] });
    check('a GROUPS custom view runs', run.status === 200 && run.body.items.length === 2 && run.body.items.some((x) => x.groupName === 'Umoja' && Number(x.members) === 3), run.text);
    const saved = await call('POST', '/api/views', { name: 'Big groups', entity: 'GROUPS', columns: ['groupId', 'members'],
      filters: [{ field: 'members', operator: 'MORE_THAN', value: 1 }], usage: { allUsers: true } });
    check('and is saved', saved.status === 201, saved.text);
    const vf = await call('GET', `/api/groups?viewfilter=${saved.body?.id}`);
    check('GET /groups?viewfilter= lists what it matches (the reference platform\'s custom views with the API)', vf.status === 200 && Array.isArray(vf.body) && vf.body.length === 1, vf.text);

    // ------------------------------------------------------------------------
    section('importing groups and group loans');
    await call('POST', '/api/group-role-names', { id: 'chair', name: 'Chairperson' });
    await call('POST', '/api/client-types', { holderType: 'GROUP', id: 'chama', name: 'Chama' });
    const book = XLSX.write([
      { name: 'Settings', rows: [['Setting', 'Value'], ['Migration date', orgDay(-1)]] },
      { name: 'Members', rows: [['Member number', 'First name', 'Last name', 'Branch ID', 'Group ID', 'Group role'],
        ['IM1', 'Imani', 'One', 'HQ', 'GRP1', 'chair'], ['IM2', 'Imani', 'Two', 'HQ', 'GRP1, GRP2', ''], ['IM3', 'Imani', 'Three', 'HQ', 'GRP2', 'Chairperson']] },
      { name: 'Groups', rows: [['Group ID', 'Group name', 'Group type', 'Branch ID', 'Credit officer', 'Phone', 'Notes'],
        ['GRP1', 'Imported chama', 'chama', 'HQ', 'officer@open.local', '0711222333', 'From the old system'], ['GRP2', 'Second chama', '', 'HQ', '', '', '']] },
      { name: 'Deposit Accounts', rows: [['Account number', 'Member number', 'Product ID', 'Balance', 'Opened on'], ['GSA1', 'GRP1', 'SAV01', 0, orgDay(-30)]] },
    ]);
    const up = await call('POST', '/api/data-imports?wait=true', null, { binary: book, headers: { 'content-type': XLSX_TYPE, 'x-file-name': 'groups.xlsx' } });
    check('a workbook with a Groups sheet validates', up.status === 201 && up.body.status === 'PENDING_APPROVAL', `${up.text}`);
    check('and says what it will create', up.body?.summary?.creates?.groups === 2 && up.body.summary.creates.groupMembers === 4 && up.body.summary.creates.members === 3,
      JSON.stringify(up.body?.summary?.creates));
    const ap = await call('POST', `/api/data-imports/${up.body?.id}/approve`, { note: 'ok' });
    check('approved', ap.status === 200 && ap.body.status === 'APPROVED', ap.text);
    const ig = await call('GET', '/api/groups/GRP1');
    check('the group is created with its type, officer, details and members in their roles', ig.status === 200 && ig.body.groupRoleKey === 'chama'
      && ig.body.mobilePhone === '0711222333' && ig.body.notes === 'From the old system' && ig.body.groupMembers.length === 2
      && ig.body.groupMembers.some((x) => x.roles.some((r) => r.groupRoleNameKey === 'chair')), ig.text);
    const ig2 = await call('GET', '/api/groups/GRP2');
    check('a member in two groups, and a role given by its name', ig2.body?.groupMembers?.length === 2 && ig2.body.groupRoleKey === 'group'
      && ig2.body.groupMembers.some((x) => x.roles.some((r) => r.roleName === 'Chairperson')), ig2.text);
    const gsa = await q1(`SELECT a.account_no, m.holder_type FROM ${SCHEMA}.savings_accounts a JOIN ${SCHEMA}.members m ON m.id = a.member_id WHERE a.account_no = 'GSA1'`);
    check('and the group\'s deposit account', gsa && gsa.holder_type === 'GROUP', JSON.stringify(gsa));
    const bad = XLSX.write([
      { name: 'Settings', rows: [['Setting', 'Value'], ['Migration date', orgDay(-1)]] },
      { name: 'Members', rows: [['Member number', 'First name', 'Last name', 'Group ID', 'Group role'], ['BM1', 'Bad', 'One', 'NOPE', ''], ['BM2', 'Bad', 'Two', '', 'chair']] },
      { name: 'Groups', rows: [['Group ID', 'Group name'], ['BM1', 'Clashing ID']] },
    ]);
    const upBad = await call('POST', '/api/data-imports?wait=true', null, { binary: bad, headers: { 'content-type': XLSX_TYPE, 'x-file-name': 'bad.xlsx' } });
    const msgs = (upBad.body?.errors || []).map((x) => `${x.sheet}:${x.message}`).join(' | ');
    check('a group ID that is also a member number, and a role without a group, are refused in the file',
      /also a member number/.test(msgs) && /group role needs the Group ID/.test(msgs), msgs);
    const bad2 = XLSX.write([
      { name: 'Settings', rows: [['Setting', 'Value'], ['Migration date', orgDay(-1)]] },
      { name: 'Members', rows: [['Member number', 'First name', 'Last name', 'Group ID'], ['BM3', 'Bad', 'Three', 'NOPE']] },
      { name: 'Loan Accounts', rows: [['Account number', 'Member number', 'Client type', 'Product ID', 'Principal', 'Installments', 'Disbursed on', 'Principal paid'],
        ['BL1', 'IM1', 'G', 'NL01', 1000, 2, orgDay(-5), 0]] },
    ]);
    const upBad2 = await call('POST', '/api/data-imports?wait=true', null, { binary: bad2, headers: { 'content-type': XLSX_TYPE, 'x-file-name': 'bad2.xlsx' } });
    const msgs2 = (upBad2.body?.errors || []).map((x) => `${x.sheet}:${x.message}`).join(' | ');
    check('an unknown group, and a group loan (client type G) of a member, are refused when it runs',
      /No group NOPE/.test(msgs2) && /Client type G, but IM1 is a member/.test(msgs2), msgs2);

    // ------------------------------------------------------------------------
    section('pictures, signatures and files on ID documents');
    const who = members[3];
    const pic = await call('PUT', `/api/members/${who.id}/picture?fileName=me.png`, null, { binary: PNG, headers: { 'content-type': 'image/png' } });
    check('a picture is uploaded as the raw body', pic.status === 200 && pic.body.contentType === 'image/png', pic.text);
    const got = await call('GET', `/api/members/${who.id}/picture`, null, { raw: true });
    check('and read back as it was', got.status === 200 && got.headers.get('content-type') === 'image/png' && got.buffer.equals(PNG));
    const fake = await call('PUT', `/api/members/${who.id}/signature`, null, { binary: Buffer.from('<script>alert(1)</script>'), headers: { 'content-type': 'image/png' } });
    check('a file that is not an image is refused, whatever it claims to be', fake.status === 415, fake.text);
    await call('PUT', `/api/members/${who.id}/signature`, null, { binary: PNG, headers: { 'content-type': 'image/png' } });
    const det = await call('GET', `/api/members/${who.id}`);
    check('the member says which it has', det.body?.media?.picture && det.body.media.signature, JSON.stringify(det.body?.media));
    check('a group has none', (await call('PUT', `/api/members/${g1.body.encodedKey}/picture`, null, { binary: PNG, headers: { 'content-type': 'image/png' } })).status === 400);
    await call('POST', '/api/id-templates', { id: 'PASS', idType: 'Passport', issuingAuthority: 'Immigration', mask: '@#######', allowAttachments: true });
    const doc = await call('POST', `/api/members/${who.id}/identifications`, { templateId: 'PASS', documentId: 'A1234567', validUntil: orgDay(-1) });
    const soon = await call('POST', `/api/members/${members[4].id}/identifications`, { templateId: 'PASS', documentId: 'B1234567', validUntil: orgDay(10) });
    check('documents with valid-until dates', doc.status === 201 && soon.status === 201, `${doc.text} ${soon.text}`);
    const docs = await call('GET', `/api/members/${who.id}/identifications`);
    const soonDocs = await call('GET', `/api/members/${members[4].id}/identifications`);
    check('one past its date is flagged expired, never refused', docs.body[0].expired === true && soonDocs.body[0].expired === false && soonDocs.body[0].expiresInDays === 10,
      `${docs.text} ${soonDocs.text}`);
    check('and the member counts it', (await call('GET', `/api/members/${who.id}`)).body.expiredIdDocuments === 1);
    const ev = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo', 'expiredIdDocuments'], filters: [{ field: 'expiredIdDocuments', operator: 'MORE_THAN', value: 0 }] });
    check('a custom view finds members with expired documents', ev.status === 200 && ev.body.items.length === 1, ev.text);
    const big = Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024, 32)]);
    const f1 = await call('POST', `/api/members/${who.id}/identifications/${doc.body.id}/files?fileName=scan.pdf`, null, { binary: big, headers: { 'content-type': 'application/pdf' } });
    check('a 3 MB scan, past the old 700 KB limit, goes on the document', f1.status === 201 && f1.body.sizeBytes === big.length, f1.text);
    for (let i = 0; i < 4; i += 1) await call('POST', `/api/members/${who.id}/identifications/${doc.body.id}/files?fileName=p${i}.png`, null, { binary: PNG, headers: { 'content-type': 'image/png' } });
    const sixth = await call('POST', `/api/members/${who.id}/identifications/${doc.body.id}/files?fileName=p6.png`, null, { binary: PNG, headers: { 'content-type': 'image/png' } });
    check('five files at most on a document (the reference platform)', sixth.status === 409 && /AT_MOST_5_FILES/.test(sixth.reason), sixth.text);
    const fl = await call('GET', `/api/members/${who.id}/identifications/${doc.body.id}/files`);
    const dl = await call('GET', `/api/members/${who.id}/identifications/${doc.body.id}/files/${f1.body.id}`, null, { raw: true });
    check('listed and downloaded', fl.body.length === 5 && dl.status === 200 && dl.buffer.length === big.length);
    const rm = await call('DELETE', `/api/members/${who.id}/identifications/${doc.body.id}/files/${f1.body.id}`);
    check('and removed', rm.status === 200 && (await call('GET', `/api/members/${who.id}/identifications/${doc.body.id}/files`)).body.length === 4);
    const acc = await q1(`SELECT id FROM ${SCHEMA}.savings_accounts WHERE member_id = $1`, [who.id]);
    await call('POST', `/api/savings/${acc.id}/close`, {});
    const ex = await call('POST', `/api/members/${who.id}/state`, { action: 'EXIT' });
    check('(the member exits first)', ex.status === 200, ex.text);
    await call('PATCH', '/api/client-controls', { anonymizeAfterDays: 0 });
    await call('POST', `/api/members/${who.id}/anonymize`);
    check('anonymizing removes the picture and signature', (await call('GET', `/api/members/${who.id}/picture`)).status === 404);

    // ------------------------------------------------------------------------
    section('the general ledger for a branch-limited user');
    const nm = (await call('POST', '/api/members', { firstName: 'North', lastName: 'Saver', branchId: 'NTH' })).body;
    await T(async (c) => { const a = await S.open(c, { memberId: nm.id }); await S.deposit(c, a.id, { amount: 700, channelId: 'cash', createdBy: 'test' }); });
    const whole = await call('GET', '/api/reports/balance-sheet');
    const own = await call('GET', '/api/reports/balance-sheet', null, { who: 'north' });
    check('with one branch, the balance sheet is that branch\'s without asking', own.status === 200 && own.body.branch?.code === 'NTH'
      && own.body.totalAssets < whole.body.totalAssets, `${own.text}`);
    check('another branch is refused', (await call('GET', '/api/reports/balance-sheet?branchId=HQ', null, { who: 'north' })).status === 403);
    check('and entries with no branch (NONE) too', (await call('GET', '/api/accounting/trial-balance?branchId=NONE', null, { who: 'north' })).status === 403);
    const two = await call('GET', '/api/reports/income-statement', null, { who: 'both' });
    check('with two branches, a report without a branch asks for one', two.status === 403 && /BRANCH_REQUIRED/.test(two.reason), two.text);
    check('and one of them is given', (await call('GET', '/api/reports/income-statement?branchId=HQ', null, { who: 'both' })).status === 200);
    const jr = await call('GET', '/api/accounting/journal?limit=1000', null, { who: 'north' });
    const nthLines = await q1(`SELECT count(*)::int AS n FROM ${SCHEMA}.journal_lines WHERE branch_id = $1`, [nth.id]);
    check('the journal shows the lines of their branch only', jr.status === 200 && jr.body.length === nthLines.n && nthLines.n > 0, `${jr.body?.length} ${nthLines.n}`);
    for (const p of ['/api/accounting/gl', '/api/reports/prudential', '/api/returns', '/api/provisioning/bands', '/api/periods']) {
      const r = await call('GET', p, null, { who: 'north' });
      check(`${p} is for users with every branch`, r.status === 403 && /ALL_BRANCH_ACCESS_REQUIRED/.test(r.reason), r.text);
    }
    const job = await call('POST', '/api/accounting/reports?wait=true', { startDate: orgDay(-30), endDate: orgDay(0) }, { who: 'north' });
    check('an accounting report through the API is for their branch', job.status === 200 && job.body.request?.branchId === nth.id, job.text);
    const hqJob = await call('POST', '/api/accounting/reports?wait=true', { startDate: orgDay(-30), endDate: orgDay(0), branchId: 'HQ' });
    const peek = await call('GET', `/api/accounting/reports/${hqJob.body?.reportKey}`, null, { who: 'north' });
    check('and another branch\'s report is not read', peek.status === 403, peek.text);
    check('a user with every branch sees no change', (await call('GET', '/api/accounting/gl')).status === 200
      && (await call('GET', '/api/reports/balance-sheet')).body.branch === null);
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
