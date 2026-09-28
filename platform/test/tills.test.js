#!/usr/bin/env node
'use strict';

/**
 * Teller tills and tasks, after the reference platform's Tellers and Tellering widgets and
 * Tasks pages: opening a till with limits, teller cash transactions going
 * through it by themselves, a teller made to use one, cash added and
 * removed, close with cash counted and the difference booked, undo close,
 * reopen, a till with its own GL account; then tasks with templates, the
 * Your Tasks counts, visibility and the tasks custom view.
 */

const { orgDay } = require('./_org');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/savings');
const acct = require('../src/domain/accounting');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'tilltest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4108;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const q1 = (sql, params = []) => Rd(async (c) => (await c.query(sql, params)).rows[0]);
const qa = (sql, params = []) => Rd(async (c) => (await c.query(sql, params)).rows);

const tokens = {};
async function call(method, p, body, { who = 'admin' } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text, headers: r.headers, reason: d?.errors?.[0]?.errorReason || '' };
}

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Till SACCO', mfaRequiredRoles: [], adminEmail: 'admin@till.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    tokens.admin = (await call('POST', '/api/auth/login', { email: 'admin@till.local', password: PASSWORD })).body.accessToken;
    const br = await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    for (const [who, role] of [['teller', 'TELLER'], ['teller2', 'TELLER'], ['super', 'MANAGER'], ['clerk', 'ACCOUNTANT']]) {
      const u = await call('POST', '/api/users', { email: `${who}@till.local`, fullName: `The ${who}`, role, password: `First password 2026 ${who.length}`, branchId: br.body.id });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE lower(email) = $1', [`${who}@till.local`]);
      tokens[who] = (await call('POST', '/api/auth/login', { email: `${who}@till.local`, password: `First password 2026 ${who.length}` })).body?.accessToken;
    }
    check('an administrator, two tellers, a supervisor and a clerk', tokens.admin && tokens.teller && tokens.teller2 && tokens.super && tokens.clerk);
    const north = await call('POST', '/api/branches', { code: 'NTH', name: 'North' });
    await call('POST', '/api/users', { email: 'far@till.local', fullName: 'Far teller', role: 'TELLER', password: 'First password 2026 nth', branchId: north.body.id });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE lower(email) = $1', ['far@till.local']);
    tokens.far = (await call('POST', '/api/auth/login', { email: 'far@till.local', password: 'First password 2026 nth' })).body?.accessToken;
    const prod = await call('POST', '/api/loan-products', {
      id: 'TL1', name: 'Till loan', glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200',
      method: 'FLAT', monthlyRate: 1, maxTerm: 24, enforceDepositMultiplier: false,
    });
    check('a loan product', prod.status === 201, prod.text);
    const m = await T(async (c) => (await c.query(
      `INSERT INTO members (member_no, first_name, last_name, gender, branch_id, phone) VALUES ('T0001','Wanjiru','Kamau','FEMALE',$1,'0711000001') RETURNING *`,
      [br.body.id])).rows[0]);
    const sav = await T((c) => S.open(c, { memberId: m.id }));
    const loan = await T(async (c) => {
      const l = await L.apply(c, { memberId: m.id, productId: 'TL1', principal: 6000, termMonths: 6, createdBy: 'officer' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
      await L.disburse(c, l.id, { amount: 6000, channelId: 'bank', valueDate: orgDay(-10), createdBy: 'teller' });
      return l;
    });

    section('a teller made to use a till');
    const withoutTill = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 500, channelId: 'cash' }, { who: 'teller' });
    check('the built-in teller role may still post cash without a till, so nobody is stopped the day tills arrive', withoutTill.status === 201, withoutTill.text);
    const roles = await call('GET', '/api/roles');
    const tellerRole = roles.body.find((r) => r.code === 'TELLER');
    const edited = await call('PATCH', '/api/roles/TELLER', { permissions: tellerRole.permissions.filter((p) => p !== 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL') });
    check('the administrator takes that permission off the teller role', edited.status === 200 && !edited.body.permissions.includes('POST_TRANSACTIONS_WITHOUT_OPENED_TILL'), edited.text);
    const refused = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 500, channelId: 'cash' }, { who: 'teller' });
    check('now a cash deposit without an open till is refused', refused.status === 409 && /NO_OPEN_TILL/.test(refused.reason), refused.text);
    const mpesa = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 300, channelId: 'mpesa' }, { who: 'teller' });
    check('a deposit through another channel does not need one', mpesa.status === 201, mpesa.text);
    const clerk = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 200, channelId: 'cash' }, { who: 'super' });
    check('nor does a user whose role may post without a till', clerk.status === 201, clerk.text);

    section('opening a till');
    const byTeller = await call('POST', '/api/tills', { tellerEmail: 'teller@till.local', openingAmount: 10000 }, { who: 'teller' });
    check('a teller does not open tills (OPEN_TILL)', byTeller.status === 403);
    const adminTill = await call('POST', '/api/tills', { tellerEmail: 'admin@till.local', openingAmount: 1000 }, { who: 'super' });
    check('an administrator cannot hold a till', adminTill.status === 409 && /ONLY_A_TELLER/.test(adminTill.reason), adminTill.text);
    const badId = await call('POST', '/api/tills', { tellerEmail: 'teller@till.local', tillId: 'T1', openingAmount: 1000 }, { who: 'super' });
    check('a till id is three letters and three digits', badId.status === 400 && /TILL_ID_FORMAT/.test(badId.reason));
    const badLimit = await call('POST', '/api/tills', { tellerEmail: 'teller@till.local', openingAmount: 1000, balanceConstraint: 'HARD' }, { who: 'super' });
    check('a balance constraint needs a limit', badLimit.status === 400);
    const open = await call('POST', '/api/tills', { tellerEmail: 'teller@till.local', openingAmount: 10000, balanceConstraint: 'HARD', minBalance: 1000, maxBalance: 50000 }, { who: 'super' });
    check('a supervisor opens a till for the teller, numbered TIL001', open.status === 201 && open.body.tillId === 'TIL001' && open.body.expectedCash === 10000 && open.body.glAccount === '100-200', open.text);
    const twice = await call('POST', '/api/tills', { tellerEmail: 'teller@till.local', openingAmount: 100 }, { who: 'super' });
    check('a teller has one open till', twice.status === 409 && /ALREADY_HAS_AN_OPEN_TILL/.test(twice.reason), twice.text);
    const noEntry = await q1("SELECT count(*)::int AS n FROM journal_entries WHERE source_type = 'TILL_CASH'");
    check('a till on the channel\'s own account posts nothing to open (the reference platform)', noEntry.n === 0);

    section('transactions through the till');
    const dep = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 5000, channelId: 'cash' }, { who: 'teller' });
    check('the teller\'s cash deposit goes through', dep.status === 201, dep.text);
    const depRow = await q1('SELECT till_id FROM transactions WHERE reference = $1', [dep.body.reference]);
    check('and is linked to the till', depRow.till_id === open.body.id);
    const wd = await call('POST', `/api/savings/${sav.id}/withdrawals`, { amount: 2000, channelId: 'cash' }, { who: 'teller' });
    const rp = await call('POST', `/api/loans/${loan.id}/repayments`, { amount: 1000, channelId: 'cash' }, { who: 'teller' });
    check('a withdrawal and a loan repayment too', wd.status === 201 && rp.status === 201, `${wd.text} ${rp.text}`);
    let till = (await call('GET', `/api/tills/${open.body.id}`, null, { who: 'super' })).body;
    check('the expected cash follows: 10,000 + 5,000 - 2,000 + 1,000', till.expectedCash === 14000 && till.log.length === 3, JSON.stringify(till.log.map((x) => x.amount)));
    check('the log carries each transaction with the balance after it', till.log[2].balance === 14000 && till.log[0].reference === dep.body.reference && till.log[1].accountNo === sav.account_no);
    const byOther = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 700, channelId: 'cash' }, { who: 'super' });
    const other = await q1('SELECT till_id FROM transactions WHERE reference = $1', [byOther.body.reference]);
    check('another user\'s cash is not in the teller\'s till', byOther.status === 201 && other.till_id === null);
    const hard = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 40000, channelId: 'cash' }, { who: 'teller' });
    check('a hard limit refuses what would take the till past its maximum', hard.status === 409 && /TILL_BALANCE_CONSTRAINT/.test(hard.reason), hard.text);
    const mine = await call('GET', '/api/tills/mine', null, { who: 'teller' });
    check('the teller sees their till in the Tellering widget, and that they must use it', mine.body.till.tillId === 'TIL001' && mine.body.mustUseTill === true && mine.body.till.expectedCash === 14000);

    section('cash in and out, and a reversal');
    const add = await call('POST', `/api/tills/${open.body.id}/add-cash`, { amount: 1000, note: 'from the vault' }, { who: 'super' });
    const rem = await call('POST', `/api/tills/${open.body.id}/remove-cash`, { amount: 500 }, { who: 'super' });
    check('a supervisor adds and removes cash', add.status === 200 && rem.status === 200 && rem.body.expectedCash === 14500, rem.text);
    const tooMuch = await call('POST', `/api/tills/${open.body.id}/remove-cash`, { amount: 20000 }, { who: 'super' });
    check('not more than the till holds', tooMuch.status === 409);
    const tellerAdd = await call('POST', `/api/tills/${open.body.id}/add-cash`, { amount: 10 }, { who: 'teller' });
    check('a teller does not move cash in and out of a till (a supervisor\'s OPEN_TILL)', tellerAdd.status === 403, tellerAdd.text);
    const rev = await call('POST', `/api/savings/transactions/${wd.body.reference}/reversal`, { reason: 'keyed twice' }, { who: 'super' });
    till = (await call('GET', `/api/tills/${open.body.id}`, null, { who: 'super' })).body;
    check('reversing the withdrawal puts its cash back in the till', rev.status === 201 && till.expectedCash === 16500 && till.log.some((x) => x.kind === 'REVERSAL' && x.amount === 2000), `${rev.text} ${till.expectedCash}`);

    section('closing');
    const closeOther = await call('POST', `/api/tills/${open.body.id}/close`, { countedCash: 1 }, { who: 'teller2' });
    check('another teller cannot close it', closeOther.status === 403, closeOther.text);
    const closeOwn = await call('POST', `/api/tills/${open.body.id}/close`, { countedCash: 1 }, { who: 'teller' });
    check('nor the teller: closing is a supervisor\'s CLOSE_TILL (the reference platform)', closeOwn.status === 403 && /CLOSE_TILL/.test(closeOwn.reason), closeOwn.text);
    const closed = await call('POST', `/api/tills/${open.body.id}/close`, { countedCash: 16400 }, { who: 'super' });
    check('the supervisor closes it with the cash counted: 100 short', closed.status === 200 && closed.body.status === 'CLOSED' && closed.body.difference === -100 && closed.body.expectedCash === 16500, closed.text);
    const os = await qa('SELECT gl_code, direction, amount FROM journal_lines WHERE entry_id = $1 ORDER BY direction', [closed.body.overShortEntryId]);
    check('the shortage is booked to cash over and short, out of the till\'s cash', os.length === 2 && os.find((l) => l.direction === 'DEBIT').gl_code === '500-330' && os.find((l) => l.direction === 'CREDIT').gl_code === '100-200' && Number(os[0].amount) === 100, JSON.stringify(os));
    const tb = await Rd((c) => acct.trialBalance(c));
    check('the book balances', tb.balanced);
    const afterClose = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 100, channelId: 'cash' }, { who: 'teller' });
    check('with the till closed the teller cannot post cash again', afterClose.status === 409 && /NO_OPEN_TILL/.test(afterClose.reason));
    const revClosed = await call('POST', `/api/savings/transactions/${dep.body.reference}/reversal`, { reason: 'late find' }, { who: 'super' });
    check('a closed till\'s transactions cannot be reversed', revClosed.status === 409 && /TILL_CLOSED/.test(revClosed.reason), revClosed.text);
    const list = await call('GET', '/api/tills', null, { who: 'super' });
    const listAll = await call('GET', '/api/tills?includeClosed=true', null, { who: 'super' });
    check('the Tellers widget lists open tills, and closed ones when asked', list.body.length === 0 && listAll.body.length === 1);

    section('undo close, and reopen');
    const undo = await call('POST', `/api/tills/${open.body.id}/undo-close`, null, { who: 'super' });
    const reversedOs = await q1('SELECT count(*)::int AS n FROM journal_entries WHERE reversal_of = $1', [closed.body.overShortEntryId]);
    check('undoing the close opens it again and reverses the shortage entry', undo.status === 200 && undo.body.status === 'OPEN' && reversedOs.n === 1, undo.text);
    const revNow = await call('POST', `/api/savings/transactions/${dep.body.reference}/reversal`, { reason: 'late find' }, { who: 'super' });
    check('now the correction can be made', revNow.status === 201, revNow.text);
    const closed2 = await call('POST', `/api/tills/${open.body.id}/close`, {}, { who: 'super' });
    check('closed again with no count: the expected cash is taken as counted, nothing booked', closed2.body.difference === 0 && closed2.body.overShortEntryId === null && closed2.body.countedCash === 11500, closed2.text);
    const reopened = await call('POST', `/api/tills/${open.body.id}/reopen`, null, { who: 'super' });
    check('reopened: a new session under the same id, opening with the cash counted', reopened.status === 201 && reopened.body.tillId === 'TIL001' && reopened.body.id !== open.body.id
      && reopened.body.openingAmount === 11500 && reopened.body.reopenedFrom === open.body.id && reopened.body.maxBalance === 50000, reopened.text);
    const undoOld = await call('POST', `/api/tills/${open.body.id}/undo-close`, null, { who: 'super' });
    check('the earlier session cannot be undone while the teller has a till open', undoOld.status === 409);
    const undoOpen = await call('DELETE', `/api/tills/${reopened.body.id}`, null, { who: 'super' });
    check('an opening with nothing through it can be undone', undoOpen.status === 200 && undoOpen.body.deleted === reopened.body.id);

    section('a till with its own GL account');
    await T((c) => c.query("INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES ('100-205', 'Teller 2 drawer', 'ASSET', 'LIQUID_ASSET')"));
    const own = await call('POST', '/api/tills', { tellerEmail: 'teller2@till.local', openingAmount: 3000, glAccount: '100-205', balanceConstraint: 'SOFT', maxBalance: 3500 }, { who: 'super' });
    check('opened on its own account: the opening cash moves to it from Cash on Hand', own.status === 201 && own.body.glAccount === '100-205' && own.body.tillId === 'TIL002', own.text);
    check('as an entry', round2(await Rd((c) => acct.balance(c, '100-205'))) === 3000);
    const d2 = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 1000, channelId: 'cash' }, { who: 'teller2' });
    const lines = await qa(`SELECT jl.gl_code, jl.direction FROM journal_lines jl JOIN transactions t ON t.entry_id = jl.entry_id WHERE t.reference = $1`, [d2.body.reference]);
    check('the teller\'s cash deposit is debited to the till\'s account, not Cash on Hand', lines.some((l) => l.gl_code === '100-205' && l.direction === 'DEBIT') && !lines.some((l) => l.gl_code === '100-200'), JSON.stringify(lines));
    const soft = (await call('GET', `/api/tills/${own.body.id}`, null, { who: 'super' })).body;
    check('a soft limit lets it through and shows it is outside', soft.expectedCash === 4000 && soft.outsideLimits === true);
    const rem2 = await call('POST', `/api/tills/${own.body.id}/remove-cash`, { amount: 1000, glAccount: '100-210' }, { who: 'super' });
    check('cash removed to the bank moves between the accounts', rem2.status === 200 && round2(await Rd((c) => acct.balance(c, '100-205'))) === 3000, rem2.text);
    const c2 = await call('POST', `/api/tills/${own.body.id}/close`, { countedCash: 3050 }, { who: 'super' });
    const over = await qa('SELECT gl_code, direction FROM journal_lines WHERE entry_id = $1', [c2.body.overShortEntryId]);
    check('an overage is credited to cash over and short', c2.body.difference === 50 && over.find((l) => l.direction === 'CREDIT').gl_code === '500-330' && over.find((l) => l.direction === 'DEBIT').gl_code === '100-205');
    check('and the book still balances', (await Rd((c) => acct.trialBalance(c))).balanced);

    // ------------------------------------------------------------------------
    section('tasks');
    const tpl = await call('POST', '/api/tasks/templates', { name: 'Follow up late repayment', title: 'Call {MEMBER_NAME} ({MEMBER_NO})', content: 'Phone {MEMBER_PHONE} about the late repayment.' }, { who: 'super' });
    check('a manager saves a task template', tpl.status === 201, tpl.text);
    const tplTeller = await call('POST', '/api/tasks/templates', { name: 'Mine' }, { who: 'teller' });
    check('a teller does not (templates need CREATE_COMMUNICATION_TEMPLATES)', tplTeller.status === 403);
    const t1 = await call('POST', '/api/tasks', { templateId: tpl.body.id, taskLinkType: 'CLIENT', taskLinkKey: 'T0001', assignedTo: 'teller@till.local', dueDate: orgDay(-1) }, { who: 'super' });
    check('a task from the template, linked to the member and assigned to the teller', t1.status === 201 && t1.body.title === 'Call Wanjiru Kamau (T0001)' && /0711000001/.test(t1.body.description)
      && t1.body.member.memberNo === 'T0001' && t1.body.assignedTo === 'teller@till.local' && t1.body.state === 'OVERDUE', t1.text);
    await call('POST', '/api/tasks', { title: 'Count the vault', assignedTo: 'teller@till.local', dueDate: orgDay(0) }, { who: 'super' });
    await call('POST', '/api/tasks', { title: 'Plan the week', dueDate: orgDay(3) }, { who: 'teller' });
    const groupTask = await call('POST', '/api/tasks', { title: 'Group', taskLinkType: 'GROUP', taskLinkKey: 'G1' }, { who: 'teller' });
    check('groups are not built, so a task links to a member', groupTask.status === 400);
    const w = await call('GET', '/api/tasks/mine', null, { who: 'teller' });
    check('Your Tasks: one overdue, one due today, one upcoming', w.body.overdue === 1 && w.body.today === 1 && w.body.upcoming === 1, JSON.stringify(w.body));
    const other2 = await call('GET', '/api/tasks', null, { who: 'far' });
    check('a user in another branch does not see them', other2.status === 200 && other2.body.length === 0, other2.text);
    const same = await call('GET', '/api/tasks?assignedTo=teller@till.local', null, { who: 'teller2' });
    check('a colleague in the same branch who may edit tasks does (the reference platform: tasks by branch)', same.body.length === 3, same.text);
    const supSees = await call('GET', '/api/tasks?assignedTo=teller@till.local&due=OVERDUE', null, { who: 'super' });
    check('the manager who made them does, filtered to what is overdue', supSees.body.length === 1 && supSees.body[0].id === t1.body.id, supSees.text);
    const done = await call('POST', `/api/tasks/${t1.body.id}/complete`, null, { who: 'teller' });
    check('the teller completes one', done.body.status === 'COMPLETED' && done.body.completedBy === 'teller@till.local');
    const again = await call('POST', `/api/tasks/${t1.body.id}/reopen`, null, { who: 'teller' });
    check('and can reopen it', again.body.status === 'OPEN' && again.body.completedAt === null);
    const del = await call('DELETE', `/api/tasks/${t1.body.id}`, null, { who: 'teller' });
    check('deleting needs DELETE_TASK', del.status === 403);
    const view = await call('POST', '/api/views/run', { entity: 'TASKS', columns: ['title', 'assignedTo', 'state', 'memberNo'], filters: [{ field: 'state', operator: 'EQUALS', value: 'OVERDUE' }] }, { who: 'teller' });
    check('tasks are a custom view too, showing only what the user may see', view.status === 200 && view.body.total === 1 && view.body.items[0].memberNo === 'T0001', view.text);
    const view2 = await call('POST', '/api/views/run', { entity: 'TASKS', columns: ['title'] }, { who: 'far' });
    check('the other branch\'s view of tasks is empty', view2.body.total === 0, view2.text);
    const del2 = await call('DELETE', `/api/tasks/${t1.body.id}`, null, { who: 'super' });
    check('the manager deletes it', del2.status === 200);
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

function round2(n) { return Math.round(Number(n) * 100) / 100; }
