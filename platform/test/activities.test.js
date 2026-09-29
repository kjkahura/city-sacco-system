#!/usr/bin/env node
'use strict';

/**
 * Auditing after the reference platform (docs/audits/audit-auditing.md): change log
 * rows linked to their member, account, credit arrangement and branch;
 * activities through GET /api/activities, per record, and the dashboard
 * feed with each user's activity types; the activities custom view per
 * branch; the audit trail at the reference platform's path, with failed responses, the
 * extra redactions and the User-Agent rule; and the audit tables protected
 * against change.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const TRAIL = require('../src/ops/auditTrail');
const { orgDay, addDays } = require('./_org');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'acttest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4120;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tokens = {};
async function call(method, p, body, { who = 'admin', headers: extra = {} } = {}) {
  const headers = { 'x-tenant': SLUG, ...extra };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 400), reason: `${d?.errors?.[0]?.errorReason || ''} ${d?.errors?.[0]?.errorSource || ''}`, total: r.headers.get('items-total') };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}
const dbError = (fn) => T(fn).then(() => 'no error', (e) => e.message);

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Activities SACCO', mfaRequiredRoles: [], adminEmail: 'admin@act.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@act.local', PASSWORD);
    const hq = (await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' })).body;
    const nkr = (await call('POST', '/api/branches', { code: 'NKR', name: 'Nakuru' })).body;
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@act.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@act.local`);
    };
    await mk('teller', { role: 'TELLER', branchId: 'HQ' });
    await mk('north', { role: 'AUDITOR', branchId: 'NKR', accessRights: { allBranches: false } });
    check('staff signed in', tokens.admin && tokens.teller && tokens.north);
    const today = orgDay(0);

    const m1 = (await call('POST', '/api/members', { firstName: 'Akinyi', lastName: 'Activity', branchId: 'HQ' })).body;
    const m2 = (await call('POST', '/api/members', { firstName: 'Baraka', lastName: 'North', branchId: 'NKR' })).body;
    const sav = (await call('POST', '/api/savings', { memberId: m1.id, productId: 'SAV01' })).body;
    await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 30000, channelId: 'cash' });
    await call('PATCH', `/api/savings/${sav.id}`, { name: 'School fees' });
    const loan = (await call('POST', '/api/loans', { memberId: m1.id, productId: 'NL01', principal: 12000, termMonths: 6 })).body;
    const loanId = loan?.account_no || loan?.id;
    const ap = await call('POST', `/api/loans/${loanId}/approve`, {});
    const disb = await call('POST', `/api/loans/${loanId}/disbursements`, { channelId: 'cash' });
    check('a loan is approved and disbursed', ap.status < 300 && disb.status < 300, `${ap.text} ${disb.text}`);
    const sav2 = (await call('POST', '/api/savings', { memberId: m2.id, productId: 'SAV01' })).body;
    await call('PATCH', `/api/savings/${sav2.id}`, { name: 'North savings' });
    await call('POST', '/api/currencies', { code: 'USD' });

    // ------------------------------------------------------------------------
    section('the change log is linked (migration 042)');
    const { rows: logRows } = await T((c) => c.query(
      "SELECT action, member_id, loan_id, savings_account_id, branch_id, host(ip) AS ip, channel FROM audit_log WHERE action IN ('LOAN_APPROVE', 'SAVINGS_ACCOUNT_EDITED')"));
    const approveRow = logRows.find((r) => r.action === 'LOAN_APPROVE');
    const editRow = logRows.find((r) => r.action === 'SAVINGS_ACCOUNT_EDITED' && r.savings_account_id === sav.id);
    check('a loan\'s change carries its loan, member and branch', approveRow && approveRow.member_id === m1.id && approveRow.branch_id === hq.id && approveRow.loan_id, JSON.stringify(approveRow));
    check('a deposit account\'s change carries its account, member and branch', editRow && editRow.member_id === m1.id && editRow.branch_id === hq.id, JSON.stringify(editRow));
    check('and the request\'s IP address and channel', approveRow?.ip && approveRow.channel === 'UI', JSON.stringify(approveRow));
    const { rows: [cur] } = await T((c) => c.query("SELECT branch_id, member_id FROM audit_log WHERE entity = 'currency' ORDER BY id DESC LIMIT 1"));
    check('an organization-wide change has no branch', cur && cur.branch_id === null && cur.member_id === null, JSON.stringify(cur));

    // ------------------------------------------------------------------------
    section('one record\'s activities');
    const mine = await call('GET', `/api/members/${m1.id}/activities?limit=100`);
    const types = (mine.body || []).map((a) => a.type);
    check('a member\'s feed holds the activity on the member and their accounts', mine.status === 200 && types.includes('LOAN_APPROVE') && types.includes('SAVINGS_ACCOUNT_EDITED')
      && types.includes('LOAN_DISBURSE') && Number(mine.total) === mine.body.length, JSON.stringify(types));
    check('a state change written to both logs is read once', types.filter((t) => t === 'LOAN_APPROVE').length === 1, JSON.stringify(types));
    const appr = mine.body?.find((a) => a.type === 'LOAN_APPROVE');
    check('an activity in the reference platform\'s shape, with its field changes', appr && appr.clientKey === m1.id && appr.groupKey === null && appr.branchKey === hq.id && appr.branchId === 'HQ'
      && appr.loanAccountId === loan.account_no && appr.loanProductKey === 'NL01' && appr.userKey === 'admin@act.local'
      && appr.fieldChanges.some((f) => f.fieldChangeName === 'status' && f.newValue === 'APPROVED'), JSON.stringify(appr));
    const disbAct = mine.body?.find((a) => a.type === 'LOAN_DISBURSE');
    check('disbursement comes from the loan\'s state history', disbAct && disbAct.fieldChanges.some((f) => f.newValue === 'ACTIVE'), JSON.stringify(disbAct));
    const loanFeed = await call('GET', `/api/loans/${loanId}/activities`);
    check('a loan\'s feed holds the loan\'s activity only', loanFeed.status === 200 && loanFeed.body.length >= 2 && loanFeed.body.every((a) => a.loanAccountKey === appr?.loanAccountKey), loanFeed.text);
    const savFeed = await call('GET', `/api/savings/${sav.id}/activities`);
    const depFeed = await call('GET', `/api/deposits/${sav.account_no}/activities`);
    check('a deposit account\'s feed, by /savings or /deposits', savFeed.status === 200 && savFeed.body.some((a) => a.type === 'SAVINGS_ACCOUNT_EDITED'
      && a.fieldChanges.some((f) => f.newValue === 'School fees')) && depFeed.body.length === savFeed.body.length, savFeed.text);
    const paged = await call('GET', `/api/members/${m1.id}/activities?limit=2`);
    const page2 = await call('GET', `/api/members/${m1.id}/activities?limit=2&offset=2`);
    check('paged, newest first, with the total', paged.body.length === 2 && Number(paged.total) === mine.body.length && page2.body[0].encodedKey === mine.body[2].encodedKey
      && new Date(mine.body[0].timestamp) >= new Date(mine.body[1].timestamp), paged.text);
    const ca = await call('POST', '/api/creditarrangements', { holderKey: m1.id, holderType: 'CLIENT', amount: 50000, startDate: today, expireDate: addDays(today, 365) });
    const caFeed = await call('GET', `/api/creditarrangements/${ca.body?.encodedKey || ca.body?.id}/activities`);
    check('a credit arrangement\'s feed', ca.status === 201 && caFeed.status === 200 && caFeed.body.length >= 1 && caFeed.body.every((a) => a.creditArrangementKey), caFeed.text);
    const g = await call('POST', '/api/groups', { groupName: 'Umoja', assignedBranchKey: hq.id });
    const gid = g.body?.encodedKey || g.body?.id;
    await call('PATCH', `/api/members/${gid}`, { notes: 'meets on Fridays' });
    const gFeed = await call('GET', `/api/groups/${gid}/activities`);
    check('a group\'s feed, its activities marked as the group\'s', g.status === 201 && gFeed.status === 200 && gFeed.body.length >= 1 && gFeed.body.every((a) => a.groupKey === gid && a.clientKey === null), gFeed.text);
    check('the teller reads a member\'s feed with VIEW_CLIENT_DETAILS', (await call('GET', `/api/members/${m1.id}/activities`, null, { who: 'teller' })).status === 200);
    check('a user limited to Nakuru does not reach an HQ member\'s feed', (await call('GET', `/api/members/${m1.id}/activities`, null, { who: 'north' })).status === 404);

    // Member state changes.
    await call('PATCH', '/api/client-controls', { initialState: 'PENDING_APPROVAL' });
    const p1 = (await call('POST', '/api/members', { firstName: 'Pending', lastName: 'Approval', branchId: 'HQ' })).body;
    await call('PATCH', '/api/client-controls', { initialState: 'INACTIVE' });
    const approved = await call('POST', `/api/members/${p1.id}/state`, { action: 'APPROVE' });
    const pFeed = await call('GET', `/api/members/${p1.id}/activities`);
    const stateActs = (pFeed.body || []).filter((a) => a.fieldChanges.some((f) => f.newValue === 'INACTIVE'));
    check('a member\'s approval is one activity', approved.status === 200 && stateActs.length === 1, pFeed.text);

    // ------------------------------------------------------------------------
    section('GET /api/activities (the reference platform\'s API v1)');
    const all = await call('GET', '/api/activities?limit=500');
    check('every activity, with AUDIT_TRANSACTIONS', all.status === 200 && all.body.length > 10 && Number(all.total) === all.body.length, all.text);
    const byBranch = await call('GET', `/api/activities?branchID=NKR&limit=500`);
    check('by branch', byBranch.status === 200 && byBranch.body.length > 0 && byBranch.body.every((a) => a.branchKey === nkr.id), byBranch.text);
    const byClient = await call('GET', `/api/activities?clientID=${m1.member_no}&limit=500`);
    const mineNow = await call('GET', `/api/members/${m1.id}/activities?limit=500`);
    check('by client (id or number)', byClient.body?.length === mineNow.body.length && byClient.body.length > mine.body.length, byClient.text);
    check('a group given as a client is refused', (await call('GET', `/api/activities?clientID=${gid}`)).status === 400);
    const byGroup = await call('GET', `/api/activities?groupID=${gid}`);
    check('by group', byGroup.status === 200 && byGroup.body.length === gFeed.body.length, byGroup.text);
    const byType = await call('GET', '/api/activities?type=LOAN_APPROVE,LOAN_DISBURSE&limit=500');
    check('by type', byType.body?.length === 2 && byType.body.every((a) => ['LOAN_APPROVE', 'LOAN_DISBURSE'].includes(a.type)), byType.text);
    const byUser = await call('GET', '/api/activities?userID=ADMIN@act.local&limit=5');
    check('by user', byUser.status === 200 && byUser.body.every((a) => a.userKey === 'admin@act.local'), byUser.text);
    const byProduct = await call('GET', '/api/activities?loanProductID=NL01&limit=500');
    const bySavingsProduct = await call('GET', '/api/activities?savingsProductID=SAV01&limit=500');
    check('by loan and deposit product', byProduct.body?.length >= 2 && byProduct.body.every((a) => a.loanProductKey === 'NL01')
      && bySavingsProduct.body.length >= 2 && bySavingsProduct.body.every((a) => a.savingsProductKey === 'SAV01'), byProduct.text);
    const byDates = await call('GET', `/api/activities?from=${addDays(today, 1)}&to=${addDays(today, 2)}`);
    const byToday = await call('GET', `/api/activities?from=${today}&to=${today}&limit=500`);
    check('by dates (organization days)', byDates.body?.length === 0 && byToday.body.length === all.body.length, `${byDates.text} ${byToday.body?.length}/${all.body.length}`);
    check('refused to a teller without AUDIT_TRANSACTIONS', (await call('GET', '/api/activities', null, { who: 'teller' })).status === 403);
    const northAll = await call('GET', '/api/activities?limit=500', null, { who: 'north' });
    check('a user limited to Nakuru reads Nakuru\'s activities only', northAll.status === 200 && northAll.body.length > 0 && northAll.body.every((a) => a.branchKey === nkr.id), northAll.text);
    const vf = await call('GET', '/api/activities?viewfilter=nope');
    check('?viewfilter= still goes to the custom view', vf.status === 404 || vf.status === 400, vf.text);

    // ------------------------------------------------------------------------
    section('the dashboard\'s Latest Activity');
    const feedAdmin = await call('GET', '/api/activities/feed?limit=500');
    check('an administrator sees organization-wide changes too', feedAdmin.status === 200 && feedAdmin.body.some((a) => a.type === 'CURRENCY_ADDED' && a.branchKey === null), feedAdmin.text);
    const feedTeller = await call('GET', '/api/activities/feed?limit=500', null, { who: 'teller' });
    check('every staff user has a feed; a teller sees activities with a branch only', feedTeller.status === 200 && feedTeller.body.length > 0
      && feedTeller.body.every((a) => a.branchKey), feedTeller.text);
    const feedNorth = await call('GET', '/api/activities/feed', null, { who: 'north' });
    check('a user limited to Nakuru sees Nakuru', feedNorth.status === 200 && feedNorth.body.every((a) => a.branchKey === nkr.id) && feedNorth.body.length > 0, feedNorth.text);
    const feed10 = await call('GET', '/api/activities/feed');
    check('ten by default', feed10.body?.length === 10, String(feed10.body?.length));
    const typeList = await call('GET', '/api/activities/types', null, { who: 'teller' });
    check('the activity types there are', typeList.status === 200 && typeList.body.includes('LOAN_APPROVE') && typeList.body.includes('LOAN_DISBURSE'), typeList.text);
    const setTypes = await call('PATCH', '/api/profile', { activityTypes: ['LOAN_APPROVE', 'LOAN_DISBURSE'] }, { who: 'teller' });
    check('a user chooses the types their feed shows', setTypes.status === 200 && setTypes.body.activityTypes.length === 2, setTypes.text);
    const chosen = await call('GET', '/api/activities/feed?limit=50', null, { who: 'teller' });
    check('and the feed shows those', chosen.body?.length === 2 && chosen.body.every((a) => ['LOAN_APPROVE', 'LOAN_DISBURSE'].includes(a.type)), chosen.text);
    check('a bad list is refused', (await call('PATCH', '/api/profile', { activityTypes: 'LOANS' }, { who: 'teller' })).status === 400);
    const reset = await call('PATCH', '/api/profile', { activityTypes: [] }, { who: 'teller' });
    check('an empty list shows every type again', reset.body?.activityTypes === null
      && (await call('GET', '/api/activities/feed?limit=500', null, { who: 'teller' })).body.length === feedTeller.body.length, reset.text);

    // ------------------------------------------------------------------------
    section('the activities custom view');
    const viewAll = await call('POST', '/api/views/run?limit=500', { entity: 'ACTIVITIES', columns: ['action', 'branch', 'channel'] });
    const viewNorth = await call('POST', '/api/views/run?limit=500', { entity: 'ACTIVITIES', columns: ['action', 'branch'] }, { who: 'north' });
    check('shows the branch and channel', viewAll.status === 200 && viewAll.body.items.some((x) => x.branch === 'HQ') && viewAll.body.items.some((x) => x.channel === 'UI'), viewAll.text);
    check('and a user limited to Nakuru sees Nakuru only', viewNorth.status === 200 && viewNorth.body.items.length > 0 && viewNorth.body.items.every((x) => x.branch === 'NKR'), viewNorth.text);

    // ------------------------------------------------------------------------
    section('the audit trail');
    const bad = await call('POST', '/api/members', { firstName: 'No', lastName: 'Branch', branchId: 'NOPE' });
    await wait(300);
    const upTo = encodeURIComponent(new Date().toISOString());
    const v1 = await call('GET', `/api/v1/events?username[eq]=admin@act.local&occurred_at[lte]=${upTo}&size=500`);
    const old = await call('GET', `/api/audit-trail/events?username[eq]=admin@act.local&occurred_at[lte]=${upTo}&size=500`);
    check('GET /api/v1/events is the reference platform\'s path for the same query', v1.status === 200 && v1.body.totalItemsCount === old.body.totalItemsCount && v1.body.totalItemsCount > 10, v1.text);
    check('it needs MANAGE_AUDIT_TRAIL', (await call('GET', '/api/v1/events', null, { who: 'north' })).status === 403);
    const failed = await call('GET', '/api/v1/events?response_code[gte]=400&request_uri[eq]=/api/members&size=5');
    const fEvent = failed.body?.events?.[0];
    check('a failed request keeps its response body', bad.status >= 400 && fEvent && /errorReason/.test(fEvent.response_payload || '') && /"errorCode":\d+/.test(fEvent.response_payload), JSON.stringify(fEvent));
    const okEvent = (await call('GET', '/api/v1/events?response_code[lt]=300&request_method[eq]=POST&size=1')).body?.events?.[0];
    check('a successful one does not', okEvent && okEvent.response_payload === null, JSON.stringify(okEvent));
    const byResp = await call('GET', `/api/v1/events?response_payload[contains]=${encodeURIComponent(bad.body?.errors?.[0]?.errorReason?.split(':')[0] || 'x')}`);
    check('and response_payload can be filtered', byResp.status === 200 && byResp.body.totalItemsCount >= 1, byResp.text);
    const scrubbed = TRAIL.scrub({ groupName: 'Umoja', loanName: 'Boda', assetName: 'Car', amount: 5, errorCode: 400, code: '123456' });
    check('group, loan and asset names are removed from bodies', scrubbed.groupName === '***' && scrubbed.loanName === '***' && scrubbed.assetName === '***'
      && scrubbed.amount === 5 && scrubbed.errorCode === 400 && scrubbed.code === '***', JSON.stringify(scrubbed));

    const badPref = await call('PATCH', '/api/access-preferences', { requireUserAgent: 'yes' });
    check('the User-Agent rule is true or false', badPref.status === 400, badPref.text);
    const noUa = { 'user-agent': '' };
    check('off by default: a request without a User-Agent is served', (await call('GET', '/api/branches', null, { headers: noUa })).status === 200);
    const on = await call('PATCH', '/api/access-preferences', { requireUserAgent: true });
    check('turned on in the access preferences', on.status === 200 && on.body.requireUserAgent === true, on.text);
    const refused = await call('GET', '/api/branches', null, { headers: noUa });
    check('then a request without a User-Agent is refused', refused.status === 400 && /user agent cannot be null/.test(refused.reason), refused.text);
    check('and one with it is served', (await call('GET', '/api/branches')).status === 200);
    await call('PATCH', '/api/access-preferences', { requireUserAgent: false });

    // ------------------------------------------------------------------------
    section('the audit tables are kept intact');
    check('a change log row is not edited', /AUDIT_RECORDS_ARE_IMMUTABLE/.test(await dbError((c) => c.query("UPDATE audit_log SET actor = 'someone else'"))));
    check('nor deleted', /AUDIT_RECORDS_ARE_IMMUTABLE/.test(await dbError((c) => c.query('DELETE FROM audit_log'))));
    check('nor emptied', /AUDIT_RECORDS_ARE_IMMUTABLE/.test(await dbError((c) => c.query('TRUNCATE audit_log'))));
    check('a request is not edited', /AUDIT_RECORDS_ARE_IMMUTABLE/.test(await dbError((c) => c.query("UPDATE audit_events SET username = 'x'"))));
    check('nor deleted outside the retention prune', /AUDIT_RECORDS_ARE_IMMUTABLE/.test(await dbError((c) => c.query('DELETE FROM audit_events'))));
    check('nor emptied', /AUDIT_RECORDS_ARE_IMMUTABLE/.test(await dbError((c) => c.query('TRUNCATE audit_events'))));
    check('the prune flag does not open the change log', /AUDIT_RECORDS_ARE_IMMUTABLE/.test(await dbError(async (c) => {
      await c.query("SELECT set_config('app.audit_maintenance', 'prune', true)");
      await c.query('DELETE FROM audit_log');
    })));
    await T((c) => c.query("INSERT INTO audit_events (occurred_at, event_source, request_method, request_uri) VALUES (now() - interval '400 days', 'UI', 'GET', '/api/old')"));
    const pruned = await T((c) => TRAIL.prune(c, 365));
    check('the retention prune still removes old requests', pruned.pruned === 1, JSON.stringify(pruned));
    const ghost = (await call('POST', '/api/members', { firstName: 'Ghost', lastName: 'Person', mobilePhone: '0700000001', branchId: 'HQ' })).body;
    await call('POST', `/api/members/${ghost.id}/state`, { action: 'EXIT', reason: 'left the area' });
    await call('PATCH', '/api/client-controls', { anonymizeAfterDays: 0 });
    const anon = await call('POST', `/api/members/${ghost.id}/anonymize`);
    const { rows: redacted } = await T((c) => c.query("SELECT before, after FROM audit_log WHERE entity = 'member' AND entity_id = $1 AND action <> 'MEMBER_ANONYMIZED'", [ghost.id]));
    check('and anonymization still clears a member\'s details from the change log', anon.status === 200 && redacted.length > 0
      && redacted.every((r) => (r.after === null || r.after.redacted) && (r.before === null || r.before.redacted)), anon.text);
    const after = await call('POST', '/api/members', { firstName: 'After', lastName: 'Anon', branchId: 'HQ' });
    check('the flag lasts only for that change', after.status === 201
      && /AUDIT_RECORDS_ARE_IMMUTABLE/.test(await dbError((c) => c.query("UPDATE audit_log SET actor = 'x' WHERE entity_id = $1", [after.body.id]))));
  } catch (e) {
    fail++; failures.push(`exception ${e.stack}`); console.log(e);
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
