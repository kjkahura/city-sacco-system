#!/usr/bin/env node
'use strict';

/**
 * Custom fields after the reference platform (docs/audits/audit-custom-fields.md):
 * migration 044 (link types, dependent usage, transactions by type), the
 * defects the audit found, typed search and grouped sets, the reference
 * platform's value shape and JSON Patch paths, who may read and write
 * values, transactions by type and their quota, deposit product fields per
 * product type, the API v2 metadata and configuration as code.
 */

const fs = require('fs');
const path = require('path');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const YAML = require('../src/lib/yaml');
const PERMS = require('../src/lib/permissions');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'cftest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4121;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);

const tokens = {};
async function call(method, p, body, { who = 'admin', type = null } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (type) { headers['content-type'] = type; payload = body; }
  else if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, raw: text, text: text.slice(0, 400), reason: `${d?.errors?.[0]?.errorReason || ''}`, type: r.headers.get('content-type') };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}
const def = (body) => call('POST', '/api/custom-fields/definitions', body);
const set = (body) => call('POST', '/api/custom-fields/sets', body);

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Fields SACCO', mfaRequiredRoles: [], adminEmail: 'admin@cf.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@cf.local', PASSWORD);
    const hq = (await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' })).body;
    await call('POST', '/api/branches', { code: 'NKR', name: 'Nakuru' });
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@cf.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@cf.local`);
    };
    const br = await call('POST', '/api/roles', { name: 'Branch editor', code: 'BRANCH_EDITOR', baseRole: 'TELLER',
      permissions: ['VIEW_BRANCH_DETAILS', 'EDIT_BRANCH', 'VIEW_CLIENT_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS', 'VIEW_CUSTOM_FIELD', 'EDIT_CUSTOM_FIELD'] });
    check('a role that edits branches only', br.status === 201, br.text);
    await mk('brancher', { role: 'BRANCH_EDITOR', branchId: 'HQ' });
    await mk('north', { role: 'MANAGER', branchId: 'NKR', accessRights: { allBranches: false } });
    await mk('manager', { role: 'MANAGER', branchId: 'HQ' });
    check('staff signed in', tokens.admin && tokens.brancher && tokens.north && tokens.manager);

    const cl = async (first, last, extra = {}) => (await call('POST', '/api/members', { firstName: first, lastName: last, branchId: 'HQ', ...extra })).body;
    const m1 = await cl('Amani', 'Fields');
    const m2 = await cl('Baraka', 'Fields');
    const grp = (await call('POST', '/api/groups', { groupName: 'Umoja', assignedBranchKey: hq.id })).body;
    check('members and a group', m1?.id && m2?.id && grp?.encodedKey, JSON.stringify(grp).slice(0, 200));

    // ------------------------------------------------------------------------
    section('migration 044');
    {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL search_path TO ${SCHEMA}, public`);
        await c.query('ALTER TABLE custom_field_definitions DROP CONSTRAINT custom_field_definitions_field_type_check');
        await c.query("INSERT INTO custom_field_sets (id, entity, name) VALUES ('_mig', 'MEMBER', 'Migration')");
        await c.query(`INSERT INTO custom_field_definitions (id, set_id, entity, name, field_type) VALUES
          ('toGroup', '_mig', 'MEMBER', 'Linked group', 'MEMBER_LINK'), ('toClient', '_mig', 'MEMBER', 'Linked client', 'MEMBER_LINK'),
          ('toNobody', '_mig', 'MEMBER', 'Unused link', 'MEMBER_LINK')`);
        await c.query("UPDATE members SET custom_fields = jsonb_build_object('_mig', jsonb_build_object('toGroup', $2::text, 'toClient', $3::text)) WHERE id = $1",
          [m1.id, grp.encodedKey, m2.id]);
        // A dependent field left available for all while its parent is limited (the audit's defect).
        await c.query("INSERT INTO custom_field_sets (id, entity, name) VALUES ('_migl', 'LOAN_ACCOUNT', 'Loan')");
        await c.query(`INSERT INTO custom_field_definitions (id, set_id, entity, name, field_type, options, available_for_all, usage) VALUES
          ('migParent', '_migl', 'LOAN_ACCOUNT', 'Parent', 'SELECTION', '[{"id":"a","label":"A"}]', false, '{"items":{"NL01":{"available":true,"default":false,"required":false}}}')`);
        await c.query(`INSERT INTO custom_field_definitions (id, set_id, entity, name, field_type, options, dependent_on, available_for_all, usage) VALUES
          ('migChild', '_migl', 'LOAN_ACCOUNT', 'Child', 'SELECTION', '[{"id":"x","label":"X","parent":"a"}]', 'migParent', true, '{"items":{"NL01":{"available":true,"default":false,"required":false}}}')`);
        // A transaction-channel set used by the internal channel only (transfers).
        await c.query("INSERT INTO custom_field_sets (id, entity, name) VALUES ('_migt', 'TRANSACTION_CHANNEL', 'Transfer reason')");
        await c.query(`INSERT INTO custom_field_definitions (id, set_id, entity, name, field_type, available_for_all, usage) VALUES
          ('migReason', '_migt', 'TRANSACTION_CHANNEL', 'Reason', 'FREE_TEXT', false, '{"items":{"internal":{"available":true,"default":true,"required":true}}}')`);
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', 'tenant', '044_custom_fields.sql'), 'utf8'));
        const { rows } = await c.query("SELECT id, field_type, entity, available_for_all, usage FROM custom_field_definitions WHERE id LIKE 'to%' OR id LIKE 'mig%'");
        const by = Object.fromEntries(rows.map((r) => [r.id, r]));
        check('a member link holding only groups becomes GROUP_LINK', by.toGroup.field_type === 'GROUP_LINK', JSON.stringify(by.toGroup));
        check('one holding clients, or nothing, becomes CLIENT_LINK', by.toClient.field_type === 'CLIENT_LINK' && by.toNobody.field_type === 'CLIENT_LINK');
        check('a dependent field takes its parent\'s availability', by.migChild.available_for_all === false);
        check('a set used by the internal channel alone moves to transactions by type',
          by.migReason.entity === 'TRANSACTION_TYPE' && by.migReason.usage.items.TRANSFER?.required === true, JSON.stringify(by.migReason));
        const bad = await c.query("SAVEPOINT s; INSERT INTO custom_field_definitions (id, entity, name, field_type) VALUES ('old', 'GUARANTOR', 'Old', 'MEMBER_LINK')").then(() => 'no error', (e) => e.message);
        check('and MEMBER_LINK is no longer stored', /check constraint/.test(bad), bad);
      } finally { await c.query('ROLLBACK'); c.release(); }
    }

    // ------------------------------------------------------------------------
    section('defects the audit found');
    await set({ entity: 'MEMBER', name: 'Profile', id: 'profile' });
    await set({ entity: 'MEMBER', name: 'Bank accounts', id: 'banks', type: 'GROUPED' });
    let r = await def({ entity: 'MEMBER', setId: '_profile', id: 'occupation', name: 'Occupation', type: 'FREE_TEXT' });
    check('a free text field', r.status === 201, r.text);
    await def({ entity: 'MEMBER', setId: '_profile', id: 'children', name: 'Children', type: 'NUMBER' });
    await def({ entity: 'MEMBER', setId: '_profile', id: 'insured', name: 'Insured', type: 'CHECKBOX' });
    await def({ entity: 'MEMBER', setId: '_banks', id: 'bankName', name: 'Bank', type: 'FREE_TEXT' });
    await def({ entity: 'MEMBER', setId: '_banks', id: 'accountNo', name: 'Account number', type: 'FREE_TEXT', uniqueValue: true });
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${m1.id}`, { _profile: { insured: 'TRUE', children: 10 } });
    check('a checkbox takes TRUE, as the reference platform writes it', r.status === 200 && r.body.values._profile.insured === true, r.text);
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${m1.id}`, { _banks: [{ bankName: 'KCB', accountNo: '001' }, { bankName: 'Equity', accountNo: '001' }] });
    check('a unique value appearing twice in one record\'s grouped set is refused', r.status === 409 && /DUPLICATE_UNIQUE_VALUE/.test(r.reason), r.text);
    const [p1, p2] = await Promise.all([
      call('PUT', `/api/custom-fields/values/MEMBER/${m1.id}`, { _banks: [{ bankName: 'KCB', accountNo: '777' }] }),
      call('PUT', `/api/custom-fields/values/MEMBER/${m2.id}`, { _banks: [{ bankName: 'NCBA', accountNo: '777' }] }),
    ]);
    check('two records saved at once cannot both take a unique value', [p1.status, p2.status].sort().join() === '200,409', `${p1.status} ${p2.status}`);
    r = await def({ entity: 'MEMBER', setId: '_profile', id: 'tier', name: 'Tier', type: 'SELECTION', options: [{ id: 'has space!', label: 'Odd' }] });
    check('an option ID of other characters is refused', r.status === 400 && /OPTION_ID_IS_LETTERS/.test(r.reason), r.text);
    await call('PATCH', '/api/custom-fields/sets/_profile', { notes: 'Basic details' });
    r = await call('PATCH', '/api/custom-fields/sets/_profile', { notes: null });
    check('set notes can be cleared', r.status === 200 && r.body.notes === null, r.text);
    await set({ entity: 'LOAN_ACCOUNT', name: 'Purpose', id: 'purpose' });
    await def({ entity: 'LOAN_ACCOUNT', setId: '_purpose', id: 'sector', name: 'Sector', type: 'SELECTION', options: [{ id: 'agri', label: 'Agriculture' }],
      availableForAll: false, usage: { items: { NL01: { available: true } } } });
    r = await def({ entity: 'LOAN_ACCOUNT', setId: '_purpose', id: 'crop', name: 'Crop', type: 'SELECTION', dependentOn: 'sector', options: [{ id: 'maize', label: 'Maize', parent: 'agri' }] });
    check('a dependent field is limited like its parent', r.status === 201 && r.body.available_for_all === false && r.body.usage.items?.NL01, r.text);
    await call('PATCH', '/api/custom-fields/definitions/sector', { availableForAll: true, usage: { default: true } });
    const crop = (await call('GET', '/api/custom-fields/definitions/crop')).body;
    check('and follows it when the parent changes', crop.available_for_all === true && crop.usage.default === true, JSON.stringify(crop));
    const order = (await call('GET', '/api/custom-fields/definitions?entity=MEMBER')).body.map((d) => `${d.set_id}.${d.id}:${d.sort_order}`);
    check('definitions are numbered one way across the entity', order.join() === '_profile.occupation:1,_profile.children:2,_profile.insured:3,_banks.bankName:4,_banks.accountNo:5', order.join());

    // ------------------------------------------------------------------------
    section('link types');
    await def({ entity: 'MEMBER', setId: '_profile', id: 'referrer', name: 'Referred by', type: 'MEMBER_LINK' });
    await def({ entity: 'MEMBER', setId: '_profile', id: 'chama', name: 'Chama', type: 'GROUP_LINK' });
    const ref = (await call('GET', '/api/custom-fields/definitions/referrer')).body;
    check('MEMBER_LINK is taken as CLIENT_LINK', ref.field_type === 'CLIENT_LINK', JSON.stringify(ref));
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${m1.id}`, { _profile: { referrer: grp.encodedKey } });
    check('a client link refuses a group', r.status === 400 && /no such client/.test(r.reason), r.text);
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${m1.id}`, { _profile: { chama: m2.id } });
    check('a group link refuses a client', r.status === 400 && /no such group/.test(r.reason), r.text);
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${m1.id}`, { _profile: { referrer: m2.id, chama: grp.encodedKey } });
    check('each takes its own kind', r.status === 200, r.text);

    // ------------------------------------------------------------------------
    section('search by custom fields');
    await call('PUT', `/api/custom-fields/values/MEMBER/${m2.id}`, { _profile: { children: 9, insured: false } });
    const search = (filterCriteria, extra = {}) => call('POST', '/api/clients:search', { filterCriteria, ...extra });
    const ids = (x) => (x.body || []).map((c) => c.encodedKey).sort().join();
    r = await search([{ field: '_profile.children', operator: 'MORE_THAN', value: 9 }]);
    check('a number compares as a number (10 is more than 9)', ids(r) === m1.id, r.text);
    r = await search([{ field: '_profile.children', operator: 'BETWEEN', value: 8, secondValue: 9 }]);
    check('BETWEEN on a number', ids(r) === m2.id, r.text);
    r = await search([{ field: '_profile.insured', operator: 'EQUALS', value: 'TRUE' }]);
    check('a checkbox compares as TRUE or FALSE', ids(r) === m1.id, r.text);
    r = await search([{ field: '_banks.bankName', operator: 'EQUALS', value: 'kcb' }]);
    check('a field of a grouped set matches any entry', ids(r) === m1.id, r.text);
    r = await search([{ field: '_banks.bankName', operator: 'EMPTY' }]);
    check('EMPTY on a grouped field: no entry has a value', !ids(r).includes(m1.id) && ids(r).includes(m2.id), r.text);
    r = await search([{ field: '_profile.nothing', operator: 'EQUALS', value: 'x' }]);
    check('an unknown custom field is refused', r.status === 400 && /UNKNOWN_CUSTOM_FIELD/.test(r.reason), r.text);
    r = await search([], { sortingCriteria: { field: '_banks.bankName', order: 'ASC' } });
    check('sorting by a grouped field is refused', r.status === 400 && /GROUPED_SET/.test(r.reason), r.text);

    // ------------------------------------------------------------------------
    section('values in the reference platform\'s shape');
    r = await call('GET', `/api/clients/${m1.id}`);
    check('without detailsLevel=FULL a client has no custom fields', r.status === 200 && !Object.keys(r.body).some((k) => k.startsWith('_')), Object.keys(r.body || {}).join());
    r = await call('GET', `/api/clients/${m1.id}?detailsLevel=FULL`);
    check('with FULL, values are strings and a checkbox TRUE', r.body._profile?.children === '10' && r.body._profile.insured === 'TRUE', JSON.stringify(r.body._profile));
    check('and each grouped entry has its _index', r.body._banks?.[0]?._index === '0' && r.body._banks[0].bankName === 'KCB', JSON.stringify(r.body._banks));
    r = await call('POST', '/api/clients', { firstName: 'Chege', lastName: 'Empty', _profile: { occupation: '' } });
    check('an empty value in a body is refused', r.status === 400 && /CUSTOM_FIELD_VALUE_CANNOT_BE_EMPTY/.test(r.reason), r.text);
    r = await call('PATCH', `/api/clients/${m1.id}?detailsLevel=FULL`, [
      { op: 'ADD', path: '/_banks/-', value: { bankName: 'Equity', accountNo: '888' } },
      { op: 'REPLACE', path: '/_banks/0/bankName', value: 'KCB Bank' },
      { op: 'ADD', path: '/_profile/occupation', value: 'Farmer' },
    ]);
    check('JSON Patch adds a grouped entry and replaces an entry\'s field', r.status === 200 && r.body._banks?.length === 2 && r.body._banks[0].bankName === 'KCB Bank'
      && r.body._banks[1].accountNo === '888' && r.body._profile.occupation === 'Farmer', r.text);
    r = await call('PATCH', `/api/clients/${m1.id}?detailsLevel=FULL`, [{ op: 'REMOVE', path: '/_profile/occupation' }, { op: 'REMOVE', path: '/_banks/0' }]);
    check('REMOVE clears a field and removes an entry', r.status === 200 && r.body._profile.occupation === undefined && r.body._banks.length === 1
      && r.body._banks[0].bankName === 'Equity', r.text);
    r = await call('PATCH', `/api/clients/${m1.id}`, [{ op: 'REPLACE', path: '/_profile/children', value: null }]);
    check('a patch value may not be null', r.status === 400 && /CANNOT_BE_EMPTY/.test(r.reason), r.text);
    await set({ entity: 'SAVINGS_ACCOUNT', name: 'Account', id: 'acct' });
    await def({ entity: 'SAVINGS_ACCOUNT', setId: '_acct', id: 'purpose', name: 'Purpose', type: 'FREE_TEXT' });
    const sav = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 5000, channelId: 'cash' });
    r = await call('PATCH', `/api/deposits/${sav.id}?detailsLevel=FULL`, [{ op: 'ADD', path: '/_acct/purpose', value: 'School fees' }]);
    check('a deposit account takes the same paths', r.status === 200 && r.body._acct?.purpose === 'School fees', r.text);
    r = await call('GET', `/api/deposits/${sav.id}`);
    check('and shows its fields only with FULL', r.status === 200 && r.body._acct === undefined, r.text);
    await set({ entity: 'CREDIT_ARRANGEMENT', name: 'Line', id: 'line' });
    await def({ entity: 'CREDIT_ARRANGEMENT', setId: '_line', id: 'collateralRef', name: 'Collateral ref', type: 'FREE_TEXT' });
    const today = new Date().toISOString().slice(0, 10);
    const ca = (await call('POST', '/api/creditarrangements', { holderKey: m1.id, holderType: 'CLIENT', amount: 50000, startDate: today,
      expireDate: `${Number(today.slice(0, 4)) + 1}${today.slice(4)}` })).body;
    r = await call('PATCH', `/api/creditarrangements/${ca?.encodedKey}?detailsLevel=FULL`, [{ op: 'ADD', path: '/_line/collateralRef', value: 'LR-7' }, { op: 'REPLACE', path: '/notes', value: 'Farm' }]);
    check('a credit arrangement takes the same paths', r.status === 200 && r.body._line?.collateralRef === 'LR-7' && r.body.notes === 'Farm', r.text);

    // ------------------------------------------------------------------------
    section('who may read and write values');
    const { rows: [loanRow] } = await T((c) => c.query("SELECT id FROM loan_accounts LIMIT 1"));
    const loan = loanRow ? loanRow : (await call('POST', '/api/loans', { memberId: m1.id, productId: 'NL01', principal: 10000, termMonths: 6 })).body;
    r = await call('PUT', `/api/custom-fields/values/LOAN_ACCOUNT/${loan.id}`, { _purpose: { sector: 'agri' } }, { who: 'brancher' });
    check('a branch editor cannot write a loan account\'s fields', r.status === 403 && /EDIT_LOAN_ACCOUNT/.test(r.reason), r.text);
    r = await call('PUT', `/api/custom-fields/values/BRANCH/HQ`, {}, { who: 'brancher' });
    check('but can write a branch\'s', r.status === 200, r.text);
    r = await call('GET', `/api/custom-fields/values/MEMBER/${m1.id}`, null, { who: 'north' });
    // Members outside the user's branches are already hidden by the branch rules (404); other records get 403.
    check('a user limited to another branch cannot read a member\'s values', r.status === 404 || (r.status === 403 && /OUTSIDE_YOUR_BRANCH/.test(r.reason)), r.text);
    r = await call('GET', `/api/custom-fields/values/CREDIT_ARRANGEMENT/${ca.encodedKey}`, null, { who: 'north' });
    check('nor a credit arrangement\'s held by a member there', r.status === 403 || r.status === 404, r.text);
    r = await call('GET', `/api/custom-fields/values/GROUP/${m1.id}`);
    check('a member is not read as a group', r.status === 400 && /THIS_IS_NOT_A_GROUP/.test(r.reason), r.text);
    await call('POST', `/api/members/${m2.id}/state`, { action: 'BLACKLIST', reason: 'Test' });
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${m2.id}`, { _profile: { children: 3 } }, { who: 'manager' });
    const mgrHas = PERMS.DEFAULTS.MANAGER.includes('EDIT_BLACKLISTED_CLIENT_CFV');
    check('a blacklisted client\'s values need EDIT_BLACKLISTED_CLIENT_CFV', mgrHas ? r.status === 200 : (r.status === 403 && /EDIT_BLACKLISTED_CLIENT_CFV/.test(r.reason)), r.text);
    await call('POST', `/api/members/${m2.id}/state`, { action: 'UNDO_BLACKLIST' });
    await T((c) => c.query('UPDATE members SET anonymized_at = now() WHERE id = $1', [m2.id]));
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${m2.id}`, { _profile: { children: 3 } });
    check('an anonymized member takes no values', r.status === 409 && /ANONYMIZED/.test(r.reason), r.text);
    await T((c) => c.query('UPDATE members SET anonymized_at = NULL WHERE id = $1', [m2.id]));

    // ------------------------------------------------------------------------
    section('transactions by type (transfers) and quotas');
    await set({ entity: 'TRANSACTION_TYPE', name: 'Transfer', id: 'xfer' });
    r = await def({ entity: 'TRANSACTION_TYPE', setId: '_xfer', id: 'reason', name: 'Reason', type: 'FREE_TEXT', availableForAll: false,
      usage: { items: { TRANSFER: { required: true } } } });
    check('a transfer field', r.status === 201, r.text);
    r = await def({ entity: 'TRANSACTION_TYPE', setId: '_xfer', id: 'odd', name: 'Odd', type: 'FREE_TEXT', availableForAll: false, usage: { items: { DEPOSIT: { required: true } } } });
    check('transactions by type are transfers only', r.status === 400 && /TRANSACTION_TYPE_USAGE_IS_FOR: TRANSFER/.test(r.reason), r.text);
    const sav2 = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    r = await call('POST', `/api/savings/${sav.id}/transfers`, { toAccountId: sav2.id, amount: 100 });
    check('a transfer without its required field is refused', r.status === 400 && /CUSTOM_FIELD_REQUIRED: _xfer.reason/.test(r.reason), r.text);
    r = await call('POST', `/api/savings/${sav.id}/transfers`, { toAccountId: sav2.id, amount: 100, customFields: { _xfer: { reason: 'Fees' } } });
    check('with it the transfer is posted and keeps the value', r.status === 201 && r.body.custom_fields?._xfer?.reason === 'Fees', r.text);
    r = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 100, channelId: 'cash' });
    check('a deposit does not take transfer fields', r.status === 201, r.text);
    await set({ entity: 'TRANSACTION_CHANNEL', name: 'Receipt', id: 'rcpt' });
    for (let k = 0; k < 26; k += 1) await def({ entity: 'TRANSACTION_CHANNEL', setId: '_rcpt', id: `r${k}`, name: `Line ${k}`, type: 'FREE_TEXT' });
    r = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 100, channelId: 'cash',
      customFields: { _rcpt: Object.fromEntries(Array.from({ length: 26 }, (_, k) => [`r${k}`, `v${k}`])) } });
    check('a transaction holds at most 25 values', r.status === 409 && /QUOTA_EXCEEDED: at most 25/.test(r.reason), r.text);

    // ------------------------------------------------------------------------
    section('deposit product fields per product type');
    await set({ entity: 'SAVINGS_PRODUCT', name: 'Product', id: 'prod' });
    r = await def({ entity: 'SAVINGS_PRODUCT', setId: '_prod', id: 'regulatorCode', name: 'Regulator code', type: 'FREE_TEXT', availableForAll: false,
      usage: { items: { FIXED_DEPOSIT: { required: true } } } });
    check('a field for fixed deposit products', r.status === 201, r.text);
    r = await call('POST', '/api/deposit-products', { id: 'SAVX', name: 'Plain savings', accountingMethod: 'NONE' });
    check('a savings product does not need it', r.status === 201, r.text);
    r = await call('POST', '/api/deposit-products', { id: 'FDX', name: 'Fixed', productType: 'FIXED_DEPOSIT', accountingMethod: 'NONE', termMin: 1, termMax: 12, termUnit: 'MONTHS' });
    check('a fixed deposit product does', r.status === 400 && /CUSTOM_FIELD_REQUIRED: _prod.regulatorCode/.test(r.reason), r.text);

    // ------------------------------------------------------------------------
    section('API v2 metadata');
    r = await call('GET', '/api/customfields/sector');
    check('a custom field in the reference platform\'s shape', r.status === 200 && r.body.type === 'SELECTION' && r.body.state === 'ACTIVE'
      && r.body.availableFor === 'LOAN_ACCOUNT' && r.body.customFieldSetId === '_purpose' && r.body.selectionOptions?.[0]?.availableOptions?.[0]?.selectionId === 'agri'
      && r.body.viewRights?.allUsers === true, r.text);
    r = await call('GET', '/api/customfields/crop');
    check('a dependent field names its parent and the options per parent option', r.body?.dependentFieldId === 'sector' && r.body.selectionOptions?.[0]?.forSelectionId === 'agri', r.text);
    r = await call('GET', '/api/customfieldsets?availableFor=CLIENT');
    check('the sets for clients', r.status === 200 && r.body.map((s) => `${s.id}:${s.type}`).join() === '_profile:SINGLE,_banks:GROUPED', r.text);
    r = await call('GET', '/api/customfieldsets/_banks/customfields');
    check('the fields of a set, in order', r.status === 200 && r.body.map((f) => f.id).join() === 'bankName,accountNo' && r.body[1].validationRules?.unique === true, r.text);

    // ------------------------------------------------------------------------
    section('configuration as code');
    r = await call('GET', '/api/configuration/customfields.yaml');
    const doc = YAML.parse(r.raw);
    check('GET returns YAML with every set', r.status === 200 && /yaml/.test(r.type) && doc.customFieldSets.some((s) => s.id === '_banks' && s.type === 'GROUPED'), r.text);
    r = await call('PUT', '/api/configuration/customfields.yaml', YAML.stringify(doc), { type: 'application/yaml' });
    check('putting it back changes nothing', r.status === 200 && r.body.fieldsCreated === 0 && r.body.fieldsDeactivated === 0 && r.body.setsCreated === 0, r.text);
    const clientSets = doc.customFieldSets.filter((s) => s.availableFor === 'CLIENT');
    clientSets[0].customFields = clientSets[0].customFields.filter((f) => f.id !== 'chama');
    clientSets[0].customFields.push({ id: 'nextOfKin', type: 'FREE_TEXT', state: 'ACTIVE', displaySettings: { displayName: 'Next of kin', fieldSize: 'LONG' },
      availableForAll: true, required: true, default: false, viewRights: { allUsers: true }, editRights: { allUsers: false, roles: ['MANAGER'] } });
    clientSets[0].customFields.push({ id: 'noRights', type: 'NUMBER', displaySettings: { displayName: 'No rights' }, availableForAll: true });
    const clientOnly = { customFieldSets: clientSets };
    r = await call('PUT', '/api/configuration/customfields.yaml', YAML.stringify(clientOnly), { type: 'application/yaml' });
    check('a file for clients only', r.status === 200 && r.body.entities.join() === 'CLIENT' && r.body.fieldsCreated === 2 && r.body.fieldsDeactivated === 1, r.text);
    const defs = (await call('GET', '/api/custom-fields/definitions')).body;
    const d = Object.fromEntries(defs.map((x) => [x.id, x]));
    check('a field left out is deactivated, not deleted', d.chama && d.chama.is_active === false);
    check('a new field is created with its usage and rights (required is default too)', d.nextOfKin?.usage.required === true && d.nextOfKin.usage.default === true
      && d.nextOfKin.edit_roles.join() === 'MANAGER' && d.nextOfKin.long_field === true, JSON.stringify(d.nextOfKin));
    check('a field without rights is deactivated', d.noRights && d.noRights.is_active === false);
    check('other entities are left alone', d.sector?.is_active === true && d.reason?.is_active === true);
    const before = (await call('GET', '/api/custom-fields/definitions')).body.length;
    const broken = { customFieldSets: [...clientSets, { id: '_new', name: 'New', type: 'SINGLE', availableFor: 'CLIENT', customFields: [
      { id: 'occupation', type: 'NUMBER', displaySettings: { displayName: 'Dup' }, viewRights: { allUsers: true }, editRights: { allUsers: true } }] }] };
    r = await call('PUT', '/api/configuration/customfields.yaml', YAML.stringify(broken), { type: 'application/yaml' });
    const after = (await call('GET', '/api/custom-fields/definitions')).body.length;
    const setsNow = (await call('GET', '/api/custom-fields/sets?entity=MEMBER')).body.map((s) => s.id);
    check('a file with an error changes nothing', r.status === 400 && /appears twice/.test(r.reason) && after === before && !setsNow.includes('_new'), r.text);
    r = await call('PUT', '/api/configuration/customfields.yaml', 'customFieldSets:\n  - id: _x\n\tname: tab', { type: 'application/yaml' });
    check('YAML errors name the line', r.status === 400 && /line 3/.test(r.reason), r.text);
    r = await call('GET', '/api/configuration/customfields/template.yaml');
    check('the template is a file the PUT takes', r.status === 200 && YAML.parse(r.raw).customFieldSets.length === 2);
    r = await call('PUT', '/api/configuration/customfields.yaml', YAML.stringify(clientOnly), { type: 'application/yaml', who: 'brancher' });
    check('a PUT needs create, edit and delete rights together', r.status === 403, r.text);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`); console.log('FAILED:', e.stack);
  } finally {
    server.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  }
})();
