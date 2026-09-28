#!/usr/bin/env node
'use strict';

/**
 * The loan-engine items, after the reference platform: solidarity group loans (one loan per
 * member, made together for a group) and credit arrangements (lines of
 * credit) with the overdraft expiry date they need. Nothing existing
 * changes: products start NOT_REQUIRED and no product is for solidarity
 * groups until a tenant says so.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const PERMS = require('../src/lib/permissions');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'loctest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4114;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);

const tokens = {};
async function call(method, p, body, { who = 'admin' } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 400), reason: d?.errors?.[0]?.errorReason || '', headers: { total: r.headers.get('items-total') } };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}

const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };
const loanProduct = (id, body = {}) => call('POST', '/api/loan-products', {
  id, name: id, ...GL, method: 'FLAT', monthlyRate: 1, maxTerm: 24, enforceDepositMultiplier: false, ...body });
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Lines of Credit SACCO', mfaRequiredRoles: [], adminEmail: 'admin@loc.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@loc.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const nth = (await call('POST', '/api/branches', { code: 'NTH', name: 'North' })).body;
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@loc.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@loc.local`);
    };
    await mk('teller', { role: 'TELLER', branchId: 'HQ' });
    await mk('north', { role: 'MANAGER', branchId: 'NTH', accessRights: { allBranches: false } });
    const today = (await T((c) => c.query('SELECT current_date::text AS d'))).rows[0].d;
    const member = async (first, branchId = 'HQ') => (await call('POST', '/api/members', { firstName: first, lastName: 'Tester', branchId })).body;
    check('staff signed in', tokens.admin && tokens.teller && tokens.north);

    // ------------------------------------------------------------------------
    section('solidarity group loans: the product');
    const mixed = await loanProduct('SOLX', { availableFor: ['SOLIDARITY_GROUPS', 'INDIVIDUALS'] });
    check('a product for solidarity groups is for them only (the reference platform)', mixed.status === 400 && /SOLIDARITY_GROUPS_STANDS_ALONE/.test(mixed.reason), mixed.text);
    const sol = await loanProduct('SOL1', { availableFor: ['HYBRID_GROUPS'] });
    check('the reference platform\'s HYBRID_GROUPS is read as SOLIDARITY_GROUPS', sol.status === 201 && sol.body.availableFor.join() === 'SOLIDARITY_GROUPS', sol.text);
    check('and products start without credit arrangements', sol.body?.creditArrangementRequirement === 'NOT_REQUIRED');
    const ind = await loanProduct('IND1');
    check('an ordinary product is for individuals', ind.status === 201 && ind.body.availableFor.join() === 'INDIVIDUALS');

    section('solidarity group loans: opening them');
    const [amina, baraka, chege] = [await member('Amina'), await member('Baraka'), await member('Chege')];
    const g = (await call('POST', '/api/groups', { groupName: 'Umoja Women', assignedBranchKey: nth.id })).body;
    for (const x of [amina, baraka]) await call('POST', `/api/groups/${g.encodedKey}/members`, { memberId: x.id });
    const open = await call('POST', `/api/groups/${g.encodedKey}/solidarity-loans`, {
      productId: 'SOL1', termMonths: 6, members: [{ memberId: amina.id, principal: 10000 }, { memberId: baraka.member_no, principal: 20000 }] });
    check('one call opens a loan for each member', open.status === 201 && open.body.loans.length === 2, open.text);
    const aLoan = open.body.loans.find((l) => l.memberKey === amina.id);
    const bLoan = open.body.loans.find((l) => l.memberKey === baraka.id);
    check('each with its own ID and amount', aLoan && bLoan && aLoan.id !== bLoan.id && aLoan.loanAmount === 10000 && bLoan.loanAmount === 20000, JSON.stringify(open.body.loans));
    const aRow = (await T((c) => c.query('SELECT l.*, b.code AS branch FROM loan_accounts l LEFT JOIN branches b ON b.id = l.branch_id WHERE l.id = $1', [aLoan.encodedKey]))).rows[0];
    check('held by the member, made under the group, in the group\'s branch', aRow.member_id === amina.id && aRow.solidarity_group_id === g.encodedKey && aRow.branch === 'NTH', JSON.stringify({ m: aRow.member_id, g: aRow.solidarity_group_id, b: aRow.branch }));
    check('the totals', open.body.totals.loans === 2 && open.body.totals.loanAmount === 30000, JSON.stringify(open.body.totals));
    const outsider = await call('POST', `/api/groups/${g.encodedKey}/solidarity-loans`, { productId: 'SOL1', members: [{ memberId: chege.id, principal: 5000 }] });
    check('a member outside the group is refused', outsider.status === 409 && /NOT_A_MEMBER_OF_THE_GROUP/.test(outsider.reason), outsider.text);
    const twice = await call('POST', `/api/groups/${g.encodedKey}/solidarity-loans`, { productId: 'SOL1', members: [{ memberId: amina.id, principal: 5 }, { memberId: amina.id, principal: 5 }] });
    check('a member given twice is refused', twice.status === 400 && /MEMBER_GIVEN_TWICE/.test(twice.reason), twice.text);
    const wrongP = await call('POST', `/api/groups/${g.encodedKey}/solidarity-loans`, { productId: 'IND1', members: [{ memberId: amina.id, principal: 5000 }] });
    check('a product not for solidarity groups is refused', wrongP.status === 409 && /PRODUCT_NOT_AVAILABLE_FOR_SOLIDARITY_GROUPS/.test(wrongP.reason), wrongP.text);
    const alone = await call('POST', '/api/loans', { memberId: chege.id, productId: 'SOL1', principal: 5000, termMonths: 6 });
    check('an individual cannot take the product on their own', alone.status === 409 && /PRODUCT_NOT_AVAILABLE_FOR_INDIVIDUALS/.test(alone.reason), alone.text);
    const byGroup = await call('POST', '/api/loans', { memberId: g.encodedKey, productId: 'SOL1', principal: 5000, termMonths: 6 });
    check('nor can the group hold it', byGroup.status === 409 && /PRODUCT_NOT_AVAILABLE_FOR_GROUPS/.test(byGroup.reason), byGroup.text);

    section('solidarity group loans: each lives on its own');
    for (const l of [aLoan, bLoan]) {
      await call('POST', `/api/loans/${l.encodedKey}/approve`, {});
      await call('POST', `/api/loans/${l.encodedKey}/disbursements`, { channelId: 'cash' });
    }
    const running = await call('GET', `/api/groups/${g.encodedKey}/solidarity-loans`);
    check('approved and disbursed one by one', running.body.totals.running === 2 && running.body.totals.principalBalance === 30000, JSON.stringify(running.body.totals));
    const payoff = await call('POST', `/api/loans/${aLoan.encodedKey}/pay-off`, { channelId: 'cash' });
    const aAfter = (await call('GET', `/api/loans/${aLoan.encodedKey}`)).body;
    check('one member repays and closes', payoff.status === 201 && aAfter.status === 'CLOSED_REPAID', `${payoff.text} ${aAfter?.status}`);
    const bAfter = (await call('GET', `/api/loans/${bLoan.encodedKey}`)).body;
    check('the other member\'s loan runs on', bAfter.status === 'ACTIVE');
    const aClient = (await call('GET', `/api/clients/${amina.id}`)).body;
    const bClient = (await call('GET', `/api/clients/${baraka.id}`)).body;
    check('loan cycles advance per member (the reference platform)', aClient.loanCycle === 1 && aClient.groupLoanCycle === 1 && bClient.groupLoanCycle === 0,
      JSON.stringify({ a: [aClient.loanCycle, aClient.groupLoanCycle], b: bClient.groupLoanCycle }));
    const ind1 = await call('GET', '/api/reports/indicators?codes=GROUP_BORROWERS,SOLIDARITY_LOAN_PORTFOLIO');
    const iv = Object.fromEntries((ind1.body?.indicators || []).map((x) => [x.code, x.value]));
    check('group indicators count solidarity loans', ind1.status === 200 && iv.GROUP_BORROWERS === 1 && iv.SOLIDARITY_LOAN_PORTFOLIO === 20000, JSON.stringify(iv));
    const delG = await call('DELETE', `/api/groups/${g.encodedKey}`);
    check('a group with solidarity loans is not deleted', delG.status === 409, delG.text);

    // ------------------------------------------------------------------------
    section('credit arrangements: creating one');
    const perms = PERMS.CATALOG.filter((p) => p.group === 'Lines of credit').map((p) => p.code);
    check('the reference platform\'s 13 permissions are in the catalogue', perms.length === 13 && perms.includes('REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT'), perms.join(','));
    const dora = await member('Dora');
    const expire = addDays(today, 3 * 365);
    const bad = await call('POST', '/api/creditarrangements', { holderKey: dora.id, amount: 100000, startDate: today, expireDate: today });
    check('the expire date is after the start date', bad.status === 400 && /EXPIRE_DATE_IS_AFTER/.test(bad.reason), bad.text);
    const ca = await call('POST', '/api/creditarrangements', { holderKey: dora.id, holderType: 'CLIENT', amount: 100000, startDate: today, expireDate: expire, notes: 'Business line' });
    check('an arrangement is created, CA000001, pending approval', ca.status === 201 && ca.body.id === 'CA000001' && ca.body.state === 'PENDING_APPROVAL', ca.text);
    check('with nothing consumed yet', ca.body.availableCreditAmount === 100000 && ca.body.consumedCreditAmount === 0);
    const k = ca.body.encodedKey;
    const early = await call('POST', `/api/creditarrangements/${k}:addAccount`, { accountId: 'x', accountType: 'LOAN' });
    check('accounts are added once it is approved', early.status === 409 && /accounts are added once it is approved/.test(early.reason), early.text);
    const byTeller = await call('POST', `/api/creditarrangements/${k}:changeState`, { action: 'APPROVE' }, { who: 'teller' });
    check('a teller may not approve it', byTeller.status === 403 && /APPROVE_LINE_OF_CREDIT/.test(byTeller.reason), byTeller.text);
    const appr = await call('POST', `/api/creditarrangements/${k}:changeState`, { action: 'APPROVE' });
    check('approved', appr.status === 200 && appr.body.state === 'APPROVED' && appr.body.approvedDate, appr.text);
    const dup = await call('POST', '/api/creditarrangements', { holderKey: dora.id, id: 'CA000001', amount: 5, expireDate: expire });
    check('an ID already in use is refused', dup.status === 409 && /ID_ALREADY_IN_USE/.test(dup.reason), dup.text);

    section('credit arrangements: loans');
    const loc = await loanProduct('LOC1', { creditArrangementRequirement: 'OPTIONAL' });
    check('a product that takes credit arrangements', loc.status === 201 && loc.body.creditArrangementRequirement === 'OPTIONAL', loc.text);
    const plain = (await call('POST', '/api/loans', { memberId: dora.id, productId: 'IND1', principal: 5000, termMonths: 6 })).body;
    const refused = await call('POST', `/api/creditarrangements/${k}:addAccount`, { accountId: plain.id, accountType: 'LOAN' });
    check('a loan whose product does not take them is refused', refused.status === 409 && /PRODUCT_DOES_NOT_TAKE_CREDIT_ARRANGEMENTS/.test(refused.reason), refused.text);
    const l1 = await call('POST', '/api/loans', { memberId: dora.id, productId: 'LOC1', principal: 60000, termMonths: 12, creditArrangementId: 'CA000001' });
    check('a loan applied for inside the arrangement', l1.status === 201 && l1.body.credit_arrangement_id === k, l1.text);
    const after1 = (await call('GET', `/api/creditarrangements/${k}`)).body;
    check('the first account makes it active, and its amount is consumed', after1.state === 'ACTIVE' && after1.consumedCreditAmount === 60000 && after1.availableCreditAmount === 40000, JSON.stringify(after1));
    const l2 = (await call('POST', '/api/loans', { memberId: dora.id, productId: 'LOC1', principal: 50000, termMonths: 12 })).body;
    const over = await call('POST', `/api/creditarrangements/${k}:addAccount`, { accountId: l2.account_no, accountType: 'LOAN' });
    check('a loan past the limit is refused', over.status === 409 && /CREDIT_ARRANGEMENT_LIMIT_EXCEEDED/.test(over.reason), over.text);
    const bigger = await call('PATCH', `/api/loans/${l1.body.id}`, { principal: 110000 });
    check('so is raising a linked loan\'s amount past it', bigger.status === 409 && /CREDIT_ARRANGEMENT_LIMIT_EXCEEDED/.test(bigger.reason), bigger.text);
    const other = await member('Eli');
    const eliLoan = (await call('POST', '/api/loans', { memberId: other.id, productId: 'LOC1', principal: 1000, termMonths: 6 })).body;
    const foreign = await call('POST', `/api/creditarrangements/${k}:addAccount`, { accountId: eliLoan.id, accountType: 'LOAN' });
    check('another holder\'s loan is refused', foreign.status === 409 && /BELONGS_TO_ANOTHER_HOLDER/.test(foreign.reason), foreign.text);
    await call('POST', `/api/loans/${l1.body.id}/approve`, {});
    const d1 = await call('POST', `/api/loans/${l1.body.id}/disbursements`, { channelId: 'cash' });
    check('the linked loan is disbursed inside the dates', d1.status === 201, d1.text);
    const longLoan = (await call('POST', '/api/loans', { memberId: dora.id, productId: 'LOC1', principal: 1000, termMonths: 24 })).body;
    const shortCa = (await call('POST', '/api/creditarrangements', { holderKey: dora.id, amount: 5000, startDate: today, expireDate: addDays(today, 200) })).body;
    await call('POST', `/api/creditarrangements/${shortCa.encodedKey}:changeState`, { action: 'APPROVE' });
    await call('POST', `/api/creditarrangements/${shortCa.encodedKey}:addAccount`, { accountId: longLoan.id, accountType: 'LOAN' });
    await call('POST', `/api/loans/${longLoan.id}/approve`, {});
    const late = await call('POST', `/api/loans/${longLoan.id}/disbursements`, { channelId: 'cash' });
    check('a loan maturing after the expire date is not disbursed', late.status === 409 && /MATURITY_AFTER_THE_EXPIRE_DATE/.test(late.reason), late.text);

    section('credit arrangements: overdrafts');
    const dp = await call('POST', '/api/deposit-products', { id: 'ODA', name: 'Overdraft account',
      accountingMethod: 'NONE', allowOverdraft: true, maxOverdraftLimit: 100000, creditArrangementRequirement: 'OPTIONAL' });
    check('a deposit product that takes credit arrangements', dp.status === 201 && dp.body.creditArrangementRequirement === 'OPTIONAL', dp.text);
    const acc = await T((c) => S.open(c, { memberId: dora.id, productId: 'ODA', overdraftLimit: 30000 }));
    const noExp = await call('POST', `/api/creditarrangements/${k}:addAccount`, { accountId: acc.account_no, accountType: 'DEPOSIT' });
    check('an overdraft without an expiry date is refused (the reference platform)', noExp.status === 409 && /OVERDRAFT_EXPIRY_DATE_REQUIRED/.test(noExp.reason), noExp.text);
    const tooLate = await call('PUT', `/api/savings/${acc.id}/overdraft`, { limit: 30000, expiryDate: addDays(expire, 10) });
    check('an expiry date is set on the overdraft', tooLate.status === 200, tooLate.text);
    const pastEnd = await call('POST', `/api/creditarrangements/${k}:addAccount`, { accountId: acc.account_no, accountType: 'DEPOSIT' });
    check('one after the arrangement\'s expire date is refused', pastEnd.status === 409 && /OVERDRAFT_EXPIRES_AFTER_THE_EXPIRE_DATE/.test(pastEnd.reason), pastEnd.text);
    await call('PUT', `/api/savings/${acc.id}/overdraft`, { expiryDate: addDays(today, 365) });
    const linkDep = await call('POST', `/api/creditarrangements/${k}:addAccount`, { accountId: acc.account_no, accountType: 'DEPOSIT' });
    check('the overdraft is linked and its limit consumed', linkDep.status === 200 && linkDep.body.consumedCreditAmount === 90000, linkDep.text);
    const raise = await call('PUT', `/api/savings/${acc.id}/overdraft`, { limit: 50000 });
    check('raising the overdraft limit past the arrangement is refused', raise.status === 409 && /CREDIT_ARRANGEMENT_LIMIT_EXCEEDED/.test(raise.reason), raise.text);
    const clear = await call('PUT', `/api/savings/${acc.id}/overdraft`, { expiryDate: null });
    check('a linked overdraft keeps its expiry date', clear.status === 409 && /OVERDRAFT_EXPIRY_DATE_REQUIRED/.test(clear.reason), clear.text);
    const accs = await call('GET', `/api/creditarrangements/${k}/accounts`);
    check('the linked accounts are listed', accs.status === 200 && accs.body.loanAccounts.length === 1 && accs.body.depositAccounts.length === 1
      && accs.body.depositAccounts[0].overdraftExpiryDate === addDays(today, 365), accs.text);

    section('credit arrangements: an amount below the exposure');
    const l3 = (await call('POST', '/api/loans', { memberId: dora.id, productId: 'LOC1', principal: 5000, termMonths: 6, creditArrangementId: k })).body;
    const lower = await call('PATCH', `/api/creditarrangements/${k}`, [{ op: 'replace', path: '/amount', value: 80000 }]);
    check('the amount may be set below the exposure (the reference platform), making available negative', lower.status === 200 && lower.body.availableCreditAmount === -15000, lower.text);
    await call('POST', `/api/loans/${l3.id}/approve`, {});
    const blocked = await call('POST', `/api/loans/${l3.id}/disbursements`, { channelId: 'cash' });
    check('and then no more is paid out', blocked.status === 409 && /CREDIT_ARRANGEMENT_LIMIT_EXCEEDED/.test(blocked.reason), blocked.text);
    const rm = await call('POST', `/api/creditarrangements/${k}:removeAccount`, { accountId: l3.id, accountType: 'LOAN' });
    check('an account is removed and the exposure falls', rm.status === 200 && rm.body.consumedCreditAmount === 90000, rm.text);
    const shrink = await call('PATCH', `/api/creditarrangements/${k}`, { expireDate: addDays(today, 100) });
    check('the dates must still cover the linked accounts', shrink.status === 409 && /MATURES_AFTER_THE_EXPIRE_DATE|EXPIRES_AFTER_THE_EXPIRE_DATE/.test(shrink.reason), shrink.text);

    section('credit arrangements: a reschedule stays linked');
    const resTight = await call('POST', `/api/loans/${l1.body.id}/reschedule`, { termMonths: 18 });
    check('a reschedule must fit the limit with the old loan left out', resTight.status === 409 && /CREDIT_ARRANGEMENT_LIMIT_EXCEEDED/.test(resTight.reason), resTight.text);
    await call('PATCH', `/api/creditarrangements/${k}`, { amount: 100000 });
    const res = await call('POST', `/api/loans/${l1.body.id}/reschedule`, { termMonths: 18 });
    const linkedAfter = (await T((c) => c.query(
      "SELECT account_no, status FROM loan_accounts WHERE credit_arrangement_id = $1 AND product_id = 'LOC1' ORDER BY created_at", [k]))).rows;
    check('the new loan takes the old one\'s arrangement (the reference platform)', [200, 201].includes(res.status) && linkedAfter.length === 2
      && linkedAfter[0].status === 'CLOSED_RESCHEDULED' && linkedAfter[1].status === 'ACTIVE', `${res.text.slice(0, 200)} ${JSON.stringify(linkedAfter)}`);
    const kNow = (await call('GET', `/api/creditarrangements/${k}`)).body;
    check('and the exposure counts the new loan, not the old', kNow.consumedCreditAmount === 90000, JSON.stringify({ c: kNow.consumedCreditAmount }));

    section('credit arrangements: the outstanding basis');
    const ctl = await call('PATCH', '/api/client-controls', { creditArrangementInitialState: 'APPROVED' });
    check('the initial state is a client control', ctl.status === 200 && ctl.body.creditArrangementInitialState === 'APPROVED', ctl.text);
    const fay = await member('Fay');
    const ob = await call('POST', '/api/creditarrangements', { holderKey: fay.member_no, amount: 50000, expireDate: expire, exposureLimitType: 'OUTSTANDING_AMOUNT' });
    check('a new arrangement starts approved', ob.status === 201 && ob.body.state === 'APPROVED', ob.text);
    const ok1 = (await call('POST', '/api/loans', { memberId: fay.id, productId: 'LOC1', principal: 40000, termMonths: 6, creditArrangementId: ob.body.id })).body;
    const ok2 = (await call('POST', '/api/loans', { memberId: fay.id, productId: 'LOC1', principal: 30000, termMonths: 6, creditArrangementId: ob.body.id })).body;
    const obNow = (await call('GET', `/api/creditarrangements/${ob.body.id}`)).body;
    check('loans not yet disbursed consume nothing on this basis', ok1.credit_arrangement_id && ok2.credit_arrangement_id && obNow.consumedCreditAmount === 0
      && obNow.exposure.approvedAmount === 70000, JSON.stringify(obNow));
    for (const l of [ok1, ok2]) await call('POST', `/api/loans/${l.id}/approve`, {});
    const p1 = await call('POST', `/api/loans/${ok1.id}/disbursements`, { channelId: 'cash' });
    const p2 = await call('POST', `/api/loans/${ok2.id}/disbursements`, { channelId: 'cash' });
    check('the first payout fits, the second does not', p1.status === 201 && p2.status === 409 && /CREDIT_ARRANGEMENT_LIMIT_EXCEEDED/.test(p2.reason), `${p1.text} ${p2.text}`);
    const fAcc = await T((c) => S.open(c, { memberId: fay.id, productId: 'ODA', overdraftLimit: 20000 }));
    await call('PUT', `/api/savings/${fAcc.id}/overdraft`, { expiryDate: addDays(today, 90) });
    await call('POST', `/api/creditarrangements/${ob.body.id}:addAccount`, { accountId: fAcc.id, accountType: 'DEPOSIT' });
    const wBig = await T((c) => S.withdraw(c, fAcc.id, { amount: 15000, channelId: 'cash', createdBy: 'test' }).then(() => 'ok', (e) => e.message));
    const wSmall = await T((c) => S.withdraw(c, fAcc.id, { amount: 5000, channelId: 'cash', createdBy: 'test' }).then(() => 'ok', (e) => e.message));
    check('a withdrawal into the overdraft counts against the limit', /CREDIT_ARRANGEMENT_LIMIT_EXCEEDED/.test(wBig) && wSmall === 'ok', `${wBig} / ${wSmall}`);
    await call('PATCH', '/api/client-controls', { creditArrangementInitialState: 'PENDING_APPROVAL' });

    section('overdraft expiry on an account in no arrangement');
    const gus = await member('Gus');
    const gAcc = await T((c) => S.open(c, { memberId: gus.id, productId: 'ODA', overdraftLimit: 1000 }));
    const lapsed = await T((c) => c.query('UPDATE savings_accounts SET overdraft_expires_on = $2 WHERE id = $1', [gAcc.id, addDays(today, -1)]));
    const wOld = await T((c) => S.withdraw(c, gAcc.id, { amount: 500, channelId: 'cash', createdBy: 'test' }).then(() => 'ok', (e) => e.message));
    const sum = await T((c) => S.summary(c, gAcc.id));
    check('past its expiry date the overdraft no longer lends', lapsed.rowCount === 1 && /INSUFFICIENT_AVAILABLE_BALANCE/.test(wOld) && sum.overdraftExpired && sum.available === 0, `${wOld} ${JSON.stringify(sum)}`);
    const noDate = await T((c) => S.open(c, { memberId: gus.id, productId: 'ODA', overdraftLimit: 1000 }));
    const wNo = await T((c) => S.withdraw(c, noDate.id, { amount: 500, channelId: 'cash', createdBy: 'test' }).then(() => 'ok', (e) => e.message));
    check('an overdraft with no expiry date lends as before', wNo === 'ok', wNo);

    section('credit arrangements: required by the product');
    await loanProduct('LOC2', { creditArrangementRequirement: 'REQUIRED' });
    const req2 = (await call('POST', '/api/loans', { memberId: dora.id, productId: 'LOC2', principal: 1000, termMonths: 6 })).body;
    const apprReq = await call('POST', `/api/loans/${req2.id}/approve`, {});
    check('a loan under a product that requires one is not approved without it', apprReq.status === 409 && /LOAN_NEEDS_A_CREDIT_ARRANGEMENT/.test(apprReq.reason), apprReq.text);
    await call('POST', `/api/creditarrangements/${shortCa.encodedKey}:addAccount`, { accountId: req2.id, accountType: 'LOAN' });
    const apprOk = await call('POST', `/api/loans/${req2.id}/approve`, {});
    const rmReq = await call('POST', `/api/creditarrangements/${shortCa.encodedKey}:removeAccount`, { accountId: req2.id, accountType: 'LOAN' });
    check('once linked it is approved, and cannot be taken out', apprOk.status === 200 && rmReq.status === 409 && /PRODUCT_REQUIRES_A_CREDIT_ARRANGEMENT/.test(rmReq.reason), `${apprOk.text} ${rmReq.text}`);
    const noLonger = await call('PATCH', '/api/loan-products/LOC1', { creditArrangementRequirement: 'NOT_REQUIRED' });
    check('a product with linked accounts cannot stop taking them', noLonger.status === 409 && /ACCOUNTS_ARE_IN_CREDIT_ARRANGEMENTS/.test(noLonger.reason), noLonger.text);
    const reqDp = await call('POST', '/api/deposit-products', { id: 'ODR', name: 'Overdraft required',
      accountingMethod: 'NONE', allowOverdraft: true, creditArrangementRequirement: 'REQUIRED' });
    const odAtOpen = await T((c) => S.open(c, { memberId: dora.id, productId: 'ODR', overdraftLimit: 100 }).then(() => 'ok', (e) => e.message));
    const rAcc = await T((c) => S.open(c, { memberId: dora.id, productId: 'ODR' }));
    const odLater = await call('PUT', `/api/savings/${rAcc.id}/overdraft`, { limit: 100, expiryDate: addDays(today, 30) });
    check('nor is an overdraft set under a deposit product that requires one', reqDp.status === 201 && /OVERDRAFT_NEEDS_A_CREDIT_ARRANGEMENT/.test(odAtOpen)
      && odLater.status === 409 && /OVERDRAFT_NEEDS_A_CREDIT_ARRANGEMENT/.test(odLater.reason), `${odAtOpen} ${odLater.text}`);

    section('credit arrangements: states');
    const h = await member('Hawa');
    const p = (await call('POST', '/api/creditarrangements', { holderKey: h.id, amount: 1000, expireDate: expire })).body;
    const steps = [];
    for (const a of ['REJECT', 'UNDO_REJECT', 'WITHDRAW', 'UNDO_WITHDRAW', 'APPROVE', 'UNDO_APPROVE', 'APPROVE', 'CLOSE', 'UNDO_CLOSE']) {
      const r = await call('POST', `/api/creditarrangements/${p.encodedKey}:changeState`, { action: a });
      steps.push(r.status === 200 ? r.body.state : `${a}:${r.status}`);
    }
    check('reject, withdraw and approve each undo; closing reopens (the reference platform)', steps.join() === 'REJECTED,PENDING_APPROVAL,WITHDRAWN,PENDING_APPROVAL,APPROVED,PENDING_APPROVAL,APPROVED,CLOSED,APPROVED', steps.join());
    const bad2 = await call('POST', `/api/creditarrangements/${p.encodedKey}:changeState`, { action: 'REJECT' });
    check('an action from the wrong state is refused', bad2.status === 409 && /INVALID_STATE_TRANSITION/.test(bad2.reason), bad2.text);
    const stillOpen = await call('POST', `/api/creditarrangements/${k}:changeState`, { action: 'CLOSE' });
    check('it closes only once every account is closed', stillOpen.status === 409 && /ACCOUNTS_STILL_OPEN/.test(stillOpen.reason), stillOpen.text);
    const q = (await call('POST', '/api/creditarrangements', { holderKey: h.id, amount: 1000, expireDate: expire })).body;
    await call('POST', `/api/creditarrangements/${q.encodedKey}:changeState`, { action: 'APPROVE' });
    const qLoan = (await call('POST', '/api/loans', { memberId: h.id, productId: 'LOC1', principal: 500, termMonths: 6, creditArrangementId: q.id })).body;
    await call('POST', `/api/loans/${qLoan.id}/withdraw`, {});
    const closed = await call('POST', `/api/creditarrangements/${q.encodedKey}:changeState`, { action: 'CLOSE' });
    const reopen = await call('POST', `/api/loans/${qLoan.id}/undo-withdraw`, {});
    check('a closed arrangement\'s accounts cannot reopen', closed.status === 200 && reopen.status === 409 && /CREDIT_ARRANGEMENT_IS_CLOSED/.test(reopen.reason), `${closed.text} ${reopen.text}`);
    const delFull = await call('DELETE', `/api/creditarrangements/${q.encodedKey}`);
    const delEmpty = await call('DELETE', `/api/creditarrangements/${p.encodedKey}`);
    check('only an arrangement with no accounts is deleted', delFull.status === 409 && /HAS_ACCOUNTS/.test(delFull.reason) && delEmpty.status === 204, `${delFull.text} ${delEmpty.status}`);

    section('credit arrangements: reading them');
    const forClient = await call('GET', `/api/clients/${dora.id}/creditarrangements`);
    check('a client\'s arrangements (the reference platform\'s /clients/:id/creditarrangements)', forClient.status === 200 && forClient.body.length === 2 && forClient.body.every((x) => x.holderKey === dora.id), forClient.text);
    const list = await call('GET', '/api/creditarrangements?state=ACTIVE&paginationDetails=ON');
    check('the list filters by state', list.status === 200 && list.body.length === 3 && list.headers?.total !== null && list.body.every((x) => x.state === 'ACTIVE'), list.text);
    const view = await call('POST', '/api/views/run', { entity: 'CREDIT_ARRANGEMENTS', columns: ['arrangementId', 'state', 'consumed', 'available'],
      filters: [{ field: 'state', operator: 'EQUALS', value: 'ACTIVE' }] });
    check('a custom view of credit arrangements runs', view.status === 200 && view.body.items.length === 3 && view.body.items.some((x) => Number(x.consumed) === 90000), view.text);
    const northList = await call('GET', '/api/creditarrangements', null, { who: 'north' });
    check('a branch-limited user sees only their branch\'s holders\' arrangements', northList.status === 200 && northList.body.length === 0, northList.text);
    const nCa = await call('POST', '/api/creditarrangements', { holderKey: g.encodedKey, holderType: 'GROUP', amount: 7000, expireDate: expire }, { who: 'north' });
    const nApprove = await call('POST', `/api/creditarrangements/${nCa.body?.encodedKey}:changeState`, { action: 'APPROVE' }, { who: 'north' });
    check('and a manager creates and approves one for a group in their branch', nCa.status === 201 && nCa.body.holderType === 'GROUP' && nApprove.status === 200, `${nCa.text} ${nApprove.text}`);
    const peek = await call('GET', `/api/creditarrangements/${k}`, null, { who: 'north' });
    check('another branch\'s arrangement is not found', peek.status === 404, peek.text);
    // A role saved before this build, holding the loan permissions, is given the matching ones (migration 035, run again).
    await T((c) => c.query(`INSERT INTO roles (code, name, base_role, permissions) VALUES ('OLDLOANS', 'Old loans role', 'MANAGER',
      ARRAY['VIEW_LOAN_ACCOUNT_DETAILS', 'APPROVE_LOANS', 'DELETE_LOAN_ACCOUNT'])`));
    await pool.query("DELETE FROM platform.schema_migrations WHERE schema_name = $1 AND version LIKE '035%'", [SCHEMA]);
    await migrateAllTenants({});
    const old = (await T((c) => c.query("SELECT permissions FROM roles WHERE code = 'OLDLOANS'"))).rows[0].permissions;
    check('roles holding the loan permissions are given the matching ones, and the migration runs twice',
      ['VIEW_LINE_OF_CREDIT_DETAILS', 'APPROVE_LINE_OF_CREDIT', 'UNDO_APPROVE_LINE_OF_CREDIT', 'DELETE_LINES_OF_CREDIT'].every((x) => old.includes(x))
      && !old.includes('CREATE_LINES_OF_CREDIT'), old.join(','));
    const ind2 = await call('GET', '/api/reports/indicators?codes=CREDIT_ARRANGEMENTS,CREDIT_ARRANGEMENT_AMOUNT');
    const iv2 = Object.fromEntries((ind2.body?.indicators || []).map((x) => [x.code, x.value]));
    check('credit arrangement indicators', ind2.status === 200 && iv2.CREDIT_ARRANGEMENTS === 4 && iv2.CREDIT_ARRANGEMENT_AMOUNT === 100000 + 5000 + 50000 + 7000, JSON.stringify(iv2));
  } catch (e) {
    fail++; failures.push(e.stack); console.error(e);
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
