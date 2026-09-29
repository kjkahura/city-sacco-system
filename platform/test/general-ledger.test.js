#!/usr/bin/env node
'use strict';

/**
 * Accounting after the reference platform (docs/audits/audit-accounting.md): the chart
 * of accounts through /api/glaccounts, manual journal entries with their
 * reversal and files, the journal through /api/gljournalentries, a
 * closure's notes, the interest accrual breakdown search, and the reference platform's
 * spelling of the accounting rates path. The ledger must still verify.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const PERMS = require('../src/lib/permissions');
const { orgDay, addDays } = require('./_org');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'gltest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4119;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);

const tokens = {};
async function call(method, p, body, { who = 'admin', raw = null, type = null } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (raw) { headers['content-type'] = type || 'application/octet-stream'; payload = raw; }
  else if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, raw: text, text: text.slice(0, 400), reason: `${d?.errors?.[0]?.errorReason || ''} ${d?.errors?.[0]?.errorSource || ''}`,
    total: r.headers.get('items-total'), headers: r.headers };
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
    await provision.provisionTenant({ slug: SLUG, name: 'Ledger SACCO', mfaRequiredRoles: [], adminEmail: 'admin@gl.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@gl.local', PASSWORD);
    const hq = (await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' })).body;
    const nkr = (await call('POST', '/api/branches', { code: 'NKR', name: 'Nakuru' })).body;
    await call('PUT', '/api/accounting/inter-branch-rules', { rules: [{ id: 'DEFAULT', glCode: '290-100' }] });
    const mk = async (who, body) => {
      const u = await call('POST', '/api/users', { email: `${who}@gl.local`, fullName: `The ${who}`, password: PW, ...body });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
      tokens[who] = await login(`${who}@gl.local`);
    };
    await mk('teller', { role: 'TELLER', branchId: 'HQ' });
    await mk('books', { role: 'ACCOUNTANT', branchId: 'HQ', accessRights: { allBranches: false },
      permissions: [...PERMS.DEFAULTS.ACCOUNTANT, 'LOG_JOURNAL_ENTRIES', 'MANAGE_ACCOUNTS'] });
    await mk('reader', { role: 'ACCOUNTANT', branchId: 'HQ' });
    check('staff signed in', tokens.admin && tokens.teller && tokens.books && tokens.reader);
    const today = orgDay(0);
    const yesterday = addDays(today, -1);
    const D = (n) => addDays(today, n);

    // ------------------------------------------------------------------------
    section('migration 041: manual entries off on the control accounts');
    const flags = Object.fromEntries((await T((c) => c.query('SELECT code, allow_manual_entries FROM gl_accounts'))).rows.map((r) => [r.code, r.allow_manual_entries]));
    check('Portfolio Control (100-100) and Savings Control (200-100) take no manual entries', flags['100-100'] === false && flags['200-100'] === false, JSON.stringify([flags['100-100'], flags['200-100']]));
    check('other detail accounts do (cash 100-200, an expense 500-200)', flags['100-200'] === true && flags['500-200'] === true);

    // ------------------------------------------------------------------------
    section('the chart of accounts (GET /glaccounts)');
    const all = await call('GET', '/api/glaccounts?paginationDetails=ON');
    const cash = all.body?.find((g) => g.glCode === '100-200');
    check('lists every account in the reference platform\'s shape, with paging headers', all.status === 200 && cash && cash.type === 'ASSET' && cash.usage === 'DETAIL'
      && cash.activated === true && cash.allowManualJournalEntries === true && cash.balance === 0 && Number(all.total) === all.body.length, all.text);
    check('in the base currency', cash?.currency?.code === 'KES', JSON.stringify(cash?.currency));
    const assets = await call('GET', '/api/glaccounts?type=ASSET');
    check('filters by type', assets.status === 200 && assets.body.length > 0 && assets.body.every((g) => g.type === 'ASSET'), assets.text);
    const badType = await call('GET', '/api/glaccounts?type=CASH');
    check('an unknown type is refused', badType.status === 400 && /INVALID_GL_ACCOUNT_TYPE/.test(badType.reason), badType.text);
    const ctl = await call('GET', '/api/glaccounts/100-100');
    check('GET /glaccounts/:code shows the manual-entries flag', ctl.status === 200 && ctl.body.allowManualJournalEntries === false, ctl.text);
    check('a teller without accounting reports cannot read it', (await call('GET', '/api/glaccounts', null, { who: 'teller' })).status === 403);

    // ------------------------------------------------------------------------
    section('creating, editing and deleting accounts');
    const head = await call('POST', '/api/glaccounts', { glCode: '560-000', name: 'Staff costs', type: 'EXPENSE', usage: 'HEADER', description: 'Payroll and benefits' });
    check('POST creates a header account, which takes no manual entries', head.status === 201 && head.body.usage === 'HEADER' && head.body.allowManualJournalEntries === false
      && head.body.description === 'Payroll and benefits', head.text);
    const pair = await call('POST', '/api/glaccounts', [
      { glCode: '560-100', name: 'Salaries', type: 'EXPENSE', parentGlCode: '560-000' },
      { glCode: '560-200', name: 'Staff medical', type: 'EXPENSE', parentGlCode: '560-000', allowManualJournalEntries: false },
    ]);
    check('POST takes a list, created in order', pair.status === 201 && Array.isArray(pair.body) && pair.body.length === 2
      && pair.body[0].parentGlCode === '560-000' && pair.body[0].allowManualJournalEntries === true && pair.body[1].allowManualJournalEntries === false, pair.text);
    const dup = await call('POST', '/api/glaccounts', { glCode: '560-100', name: 'Again', type: 'EXPENSE' });
    check('a GL code in use is refused', dup.status === 409 && /GL_CODE_ALREADY_IN_USE/.test(dup.reason), dup.text);
    const wrongType = await call('POST', '/api/glaccounts', { glCode: '560-300', name: 'Odd', type: 'INCOME', parentGlCode: '560-000' });
    check('a parent of another type is refused', wrongType.status === 400 && /PARENT_GL_ACCOUNT_TYPE_DIFFERS/.test(wrongType.reason), wrongType.text);
    const underDetail = await call('POST', '/api/glaccounts', { glCode: '560-110', name: 'Bonus', type: 'EXPENSE', parentGlCode: '560-100' });
    check('a parent that is a detail account is refused', underDetail.status === 400 && /PARENT_GL_ACCOUNT_IS_NOT_A_HEADER/.test(underDetail.reason), underDetail.text);
    const headerManual = await call('POST', '/api/glaccounts', { glCode: '570-000', name: 'H', type: 'EXPENSE', usage: 'HEADER', allowManualJournalEntries: true });
    check('a header with manual entries is refused', headerManual.status === 400 && /A_HEADER_ACCOUNT_TAKES_NO_MANUAL_JOURNAL_ENTRIES/.test(headerManual.reason), headerManual.text);
    const noName = await call('POST', '/api/glaccounts', { glCode: '570-100', type: 'EXPENSE' });
    check('a name is required', noName.status === 400 && /GL_ACCOUNT_NAME_REQUIRED/.test(noName.reason), noName.text);
    const foreign = await call('POST', '/api/glaccounts', { glCode: '570-100', name: 'USD cash', type: 'ASSET', currency: { code: 'USD' } });
    check('an account in another currency is refused (the ledger holds one)', foreign.status === 400 && /GL_ACCOUNTS_ARE_IN_THE_BASE_CURRENCY/.test(foreign.reason), foreign.text);
    check('only MANAGE_ACCOUNTS creates accounts', (await call('POST', '/api/glaccounts', { glCode: '570-100', name: 'X', type: 'EXPENSE' }, { who: 'reader' })).status === 403);
    const limitedCreate = await call('POST', '/api/glaccounts', { glCode: '570-100', name: 'X', type: 'EXPENSE' }, { who: 'books' });
    check('and a user limited to some branches cannot change the chart', limitedCreate.status === 403 && /ALL_BRANCH_ACCESS_REQUIRED/.test(limitedCreate.reason), limitedCreate.text);

    const patched = await call('PATCH', '/api/glaccounts/560-100', [{ op: 'replace', path: '/name', value: 'Salaries and wages' },
      { op: 'replace', path: '/description', value: 'Monthly payroll' }]);
    check('PATCH (JSON Patch) edits the name and description', patched.status === 200 && patched.body.name === 'Salaries and wages' && patched.body.description === 'Monthly payroll', patched.text);
    const typeChange = await call('PUT', '/api/glaccounts/560-100', { ...patched.body, type: 'ASSET' });
    check('the type cannot change', typeChange.status === 400 && /FIELDS_NOT_EDITABLE: type/.test(typeChange.reason), typeChange.text);
    const usageChange = await call('PATCH', '/api/glaccounts/560-100', [{ op: 'replace', path: '/usage', value: 'HEADER' }]);
    check('nor the usage', usageChange.status === 400 && /FIELDS_NOT_EDITABLE: usage/.test(usageChange.reason), usageChange.text);
    const recode = await call('PUT', '/api/glaccounts/560-200', { glCode: '560-210', name: 'Staff medical cover' });
    check('the GL code changes while the account is unused', recode.status === 200 && recode.body.glCode === '560-210' && recode.body.name === 'Staff medical cover', recode.text);
    const noCash = await call('PATCH', '/api/glaccounts/100-200', [{ op: 'replace', path: '/activated', value: false }]);
    check('an account a channel posts to is not deactivated', noCash.status === 409 && /GL_ACCOUNT_IS_MAPPED/.test(noCash.reason), noCash.text);
    const off = await call('PATCH', '/api/glaccounts/560-210', [{ op: 'replace', path: '/activated', value: false }]);
    check('an unmapped account is deactivated', off.status === 200 && off.body.activated === false, off.text);
    const loop = await call('PATCH', '/api/glaccounts/560-000', [{ op: 'replace', path: '/parentGlCode', value: '560-000' }]);
    check('an account is not put under itself', loop.status === 400 && /PARENT_GL_ACCOUNT/.test(loop.reason), loop.text);

    const delPlatform = await call('DELETE', '/api/glaccounts/500-330');
    check('an account the platform posts to is not deleted', delPlatform.status === 409 && /GL_ACCOUNT_IN_USE/.test(delPlatform.reason), delPlatform.text);
    const delHead = await call('DELETE', '/api/glaccounts/560-000');
    check('nor a header with accounts under it', delHead.status === 409 && /child accounts/.test(delHead.reason), delHead.text);
    const delMapped = await call('DELETE', '/api/glaccounts/400-100');
    check('nor an account a product maps', delMapped.status === 409 && /loan_products/.test(delMapped.reason), delMapped.text);
    const del = await call('DELETE', '/api/glaccounts/560-210');
    check('an account never used is deleted', del.status === 204 && (await call('GET', '/api/glaccounts/560-210')).status === 404, del.text);

    // ------------------------------------------------------------------------
    section('manual journal entries (POST /gljournalentries)');
    const entry = await call('POST', '/api/gljournalentries', {
      date: yesterday, branchId: 'HQ', notes: 'September payroll',
      debits: [{ glAccount: '560-100', amount: 120000 }], credits: [{ glAccount: '100-200', amount: 120000 }],
    });
    const e1 = entry.body || [];
    check('posts balanced lines, one transaction ID for the entry', entry.status === 201 && e1.length === 2 && e1[0].transactionId && e1[0].transactionId === e1[1].transactionId
      && /^MJ-\d{6}$/.test(e1[0].transactionId), entry.text);
    check('each line in the reference platform\'s GLJournalEntry shape', e1[0]?.type === 'DEBIT' && e1[0].amount === 120000 && e1[0].glAccount.glCode === '560-100'
      && e1[0].bookingDate === yesterday && e1[0].assignedBranchKey === hq.id && e1[0].userKey === 'admin@gl.local' && e1[0].sourceType === 'MANUAL'
      && e1[0].notes === 'September payroll' && typeof e1[0].entryId === 'number', JSON.stringify(e1[0]));
    const tx1 = e1[0]?.transactionId;
    const header = await call('GET', '/api/glaccounts/560-000');
    check('a header\'s balance is the sum of the accounts under it', header.body?.balance === 120000 && (await call('GET', '/api/glaccounts/560-100')).body.balance === 120000, header.text);
    check('in each account\'s own sign (cash went down)', (await call('GET', '/api/glaccounts/100-200')).body.balance === -120000);
    check('balances for a period', (await call('GET', `/api/glaccounts/560-100?from=${today}&to=${today}`)).body.balance === 0);
    const usedRecode = await call('PATCH', '/api/glaccounts/560-100', [{ op: 'replace', path: '/glCode', value: '560-110' }]);
    check('a used account keeps its GL code', usedRecode.status === 409 && /GL_CODE_CANNOT_CHANGE_ONCE_THE_ACCOUNT_IS_USED: .*journal_lines/.test(usedRecode.reason), usedRecode.text);
    const delUsed = await call('DELETE', '/api/glaccounts/560-100');
    check('and is not deleted', delUsed.status === 409 && /journal_lines/.test(delUsed.reason), delUsed.text);

    const own = await call('POST', '/api/gljournalentries', { date: yesterday, notes: 'Bank charges', transactionId: 'BANK-0925',
      debits: [{ glAccount: { glCode: '500-200' }, amount: 350.5 }], credits: [{ glAccount: '100-200', amount: 350.5 }] });
    check('takes the caller\'s transaction ID, and a line with no branch', own.status === 201 && own.body[0].transactionId === 'BANK-0925' && own.body[0].assignedBranchKey === null, own.text);
    const dupTx = await call('POST', '/api/gljournalentries', { date: yesterday, notes: 'Again', transactionId: 'BANK-0925',
      debits: [{ glAccount: '500-200', amount: 1 }], credits: [{ glAccount: '100-200', amount: 1 }] });
    check('a transaction ID in use is refused', dupTx.status === 409 && /TRANSACTION_ID_ALREADY_IN_USE/.test(dupTx.reason), dupTx.text);
    const refusals = [
      ['notes are required', { date: yesterday, debits: [{ glAccount: '500-200', amount: 5 }], credits: [{ glAccount: '100-200', amount: 5 }] }, 400, /NOTES_REQUIRED/],
      ['the date is required', { notes: 'x', debits: [{ glAccount: '500-200', amount: 5 }], credits: [{ glAccount: '100-200', amount: 5 }] }, 400, /BOOKING_DATE_REQUIRED/],
      ['not in the future', { date: D(1), notes: 'x', debits: [{ glAccount: '500-200', amount: 5 }], credits: [{ glAccount: '100-200', amount: 5 }] }, 400, /BOOKING_DATE_IN_THE_FUTURE/],
      ['it balances', { date: yesterday, notes: 'x', debits: [{ glAccount: '500-200', amount: 5 }], credits: [{ glAccount: '100-200', amount: 4 }] }, 400, /JOURNAL_ENTRY_UNBALANCED/],
      ['debits and credits both', { date: yesterday, notes: 'x', debits: [{ glAccount: '500-200', amount: 5 }] }, 400, /DEBITS_AND_CREDITS_REQUIRED/],
      ['a header takes none', { date: yesterday, notes: 'x', debits: [{ glAccount: '560-000', amount: 5 }], credits: [{ glAccount: '100-200', amount: 5 }] }, 400, /HEADER_GL_ACCOUNT_NOT_ALLOWED/],
      ['nor a control account', { date: yesterday, notes: 'x', debits: [{ glAccount: '100-100', amount: 5 }], credits: [{ glAccount: '100-200', amount: 5 }] }, 400, /MANUAL_JOURNAL_ENTRIES_NOT_ALLOWED: 100-100/],
      ['an unknown account', { date: yesterday, notes: 'x', debits: [{ glAccount: '999-999', amount: 5 }], credits: [{ glAccount: '100-200', amount: 5 }] }, 400, /GL_ACCOUNT_NOT_FOUND/],
      ['amounts above zero', { date: yesterday, notes: 'x', debits: [{ glAccount: '500-200', amount: -5 }], credits: [{ glAccount: '100-200', amount: -5 }] }, 400, /AMOUNT_MUST_BE_ABOVE_ZERO/],
      ['two decimals', { date: yesterday, notes: 'x', debits: [{ glAccount: '500-200', amount: 5.001 }], credits: [{ glAccount: '100-200', amount: 5.001 }] }, 400, /MORE_THAN_2_DECIMALS/],
    ];
    for (const [label, body, status, re] of refusals) {
      const r = await call('POST', '/api/gljournalentries', body);
      check(`refused: ${label}`, r.status === status && re.test(r.reason), r.text);
    }
    check('a teller cannot log one (LOG_JOURNAL_ENTRIES)', (await call('POST', '/api/gljournalentries', { date: yesterday, notes: 'x',
      debits: [{ glAccount: '500-200', amount: 5 }], credits: [{ glAccount: '100-200', amount: 5 }] }, { who: 'teller' })).status === 403);

    const across = await call('POST', '/api/gljournalentries', { date: yesterday, branchId: 'HQ', notes: 'Nakuru rent paid from head office',
      debits: [{ glAccount: '500-200', amount: 20000, branchId: 'NKR' }], credits: [{ glAccount: '100-200', amount: 20000 }] });
    const ib = (across.body || []).filter((l) => l.glAccount.glCode === '290-100');
    check('an entry across branches is squared through the inter-branch rule, the lines added shown', across.status === 201 && across.body.length === 4 && ib.length === 2
      && ib.some((l) => l.assignedBranchKey === nkr.id && l.type === 'CREDIT') && ib.some((l) => l.assignedBranchKey === hq.id && l.type === 'DEBIT'), across.text);

    // Closures and closed years.
    const k = await call('POST', '/api/accounting/closures', { closedThrough: D(-5), notes: 'August close' });
    const before = await call('POST', '/api/gljournalentries', { date: D(-6), notes: 'late accrual',
      debits: [{ glAccount: '500-200', amount: 10 }], credits: [{ glAccount: '100-200', amount: 10 }] });
    check('backdating stops at the accounting closure', k.status === 201 && before.status === 409 && /JOURNAL_ENTRY_BEFORE_CLOSURE/.test(before.reason), before.text);
    const after = await call('POST', '/api/gljournalentries', { date: D(-4), notes: 'after the close',
      debits: [{ glAccount: '500-200', amount: 10 }], credits: [{ glAccount: '100-200', amount: 10 }] });
    check('and is allowed after it', after.status === 201, after.text);
    const kn = await call('PATCH', `/api/accounting/closures/${k.body?.id}`, { notes: 'August close, signed off by the board' });
    check('a closure\'s notes are edited (PATCH /accounting/closures/:id)', kn.status === 200 && kn.body.notes === 'August close, signed off by the board' && kn.body.updated_by === 'admin@gl.local', kn.text);
    const kd = await call('PATCH', `/api/accounting/closures/${k.body?.id}`, { closedThrough: D(-3) });
    check('not its date', kd.status === 400 && /FIELDS_NOT_EDITABLE/.test(kd.reason), kd.text);
    check('editing notes takes MAKE_ACCOUNTING_CLOSURE', (await call('PATCH', `/api/accounting/closures/${k.body?.id}`, { notes: 'x' }, { who: 'teller' })).status === 403);
    await call('DELETE', `/api/accounting/closures/${k.body?.id}`, { reason: 'test' });
    await T((c) => c.query("INSERT INTO financial_years (year, starts_on, ends_on, status) VALUES (2020, '2020-01-01', '2020-12-31', 'CLOSED')"));
    const closedYear = await call('POST', '/api/gljournalentries', { date: '2020-06-30', notes: 'old',
      debits: [{ glAccount: '500-200', amount: 10 }], credits: [{ glAccount: '100-200', amount: 10 }] });
    check('nothing is booked in a closed financial year', closedYear.status === 409 && /FINANCIAL_YEAR_CLOSED: 2020/.test(closedYear.reason), closedYear.text);

    // A user limited to their branch.
    const mine = await call('POST', '/api/gljournalentries', { date: yesterday, branchId: 'HQ', notes: 'HQ petty cash',
      debits: [{ glAccount: '500-200', amount: 700 }], credits: [{ glAccount: '100-200', amount: 700 }] }, { who: 'books' });
    check('a user limited to HQ logs an entry in HQ', mine.status === 201 && mine.body[0].userKey === 'books@gl.local', mine.text);
    const theirs = await call('POST', '/api/gljournalentries', { date: yesterday, branchId: 'HQ', notes: 'x',
      debits: [{ glAccount: '500-200', amount: 7, branchId: 'NKR' }], credits: [{ glAccount: '100-200', amount: 7 }] }, { who: 'books' });
    check('not with a line in another branch', theirs.status === 403 && /OUTSIDE_YOUR_BRANCH_ACCESS/.test(theirs.reason), theirs.text);
    const none = await call('POST', '/api/gljournalentries', { date: yesterday, notes: 'x',
      debits: [{ glAccount: '500-200', amount: 7 }], credits: [{ glAccount: '100-200', amount: 7 }] }, { who: 'books' });
    check('nor with no branch', none.status === 403 && /BRANCH_REQUIRED/.test(none.reason), none.text);

    // ------------------------------------------------------------------------
    section('the journal (GET /gljournalentries and :search)');
    const m = (await call('POST', '/api/members', { firstName: 'Achieng', lastName: 'Ledger', branchId: 'HQ' })).body;
    const sav = (await call('POST', '/api/savings', { memberId: m.id, productId: 'SAV01' })).body;
    const dep = await call('POST', `/api/savings/${sav.id}/deposits`, { amount: 5000, channelId: 'cash' });
    const depRef = dep.body?.reference || dep.body?.transaction?.reference;
    check('a deposit posts (an automatic entry)', dep.status === 200 || dep.status === 201, dep.text);
    const ranged = await call('GET', `/api/gljournalentries?from=${yesterday}&to=${yesterday}&glAccountId=560-100&paginationDetails=ON`);
    check('GET filters by dates and GL account, with paging headers', ranged.status === 200 && ranged.body.length === 1 && ranged.body[0].transactionId === tx1
      && ranged.total === '1', ranged.text);
    const auto = await call('GET', `/api/gljournalentries?from=${today}&to=${today}&glAccountId=200-100`);
    const autoLine = auto.body?.[0];
    check('an automatic entry shows the product and account of its transaction', autoLine && autoLine.productType === 'SAVINGS' && autoLine.productKey === 'SAV01'
      && autoLine.accountId === sav.account_no && autoLine.accountKey === sav.id && autoLine.transactionId === depRef && autoLine.type === 'CREDIT', JSON.stringify(autoLine));
    const byBranch = await call('GET', `/api/gljournalentries?branchId=NKR`);
    check('GET filters by branch', byBranch.status === 200 && byBranch.body.length >= 2 && byBranch.body.every((l) => l.assignedBranchKey === nkr.id), byBranch.text);
    const found = await call('POST', '/api/gljournalentries:search', {
      filterCriteria: [{ field: 'type', operator: 'EQUALS', value: 'DEBIT' }, { field: 'amount', operator: 'MORE_THAN', value: 1000 },
        { field: 'sourceType', operator: 'EQUALS', value: 'MANUAL' }],
      sortingCriteria: { field: 'amount', order: 'DESC' } });
    check('POST :search filters and sorts in the reference platform\'s criteria', found.status === 200 && found.body.length >= 2 && found.body[0].amount === 120000
      && found.body.every((l) => l.type === 'DEBIT' && l.amount > 1000), found.text);
    const byTx = await call('POST', '/api/gljournalentries:search', { filterCriteria: [{ field: 'transactionId', operator: 'EQUALS', value: 'bank-0925' }] });
    check('and by transaction ID', byTx.status === 200 && byTx.body.length === 2, byTx.text);
    const badField = await call('POST', '/api/gljournalentries:search', { filterCriteria: [{ field: 'colour', operator: 'EQUALS', value: 'x' }] });
    check('an unknown field is refused', badField.status === 400 && /UNKNOWN_SEARCH_FIELD/.test(badField.reason), badField.text);
    const limitedRead = await call('GET', '/api/gljournalentries', null, { who: 'books' });
    check('a user limited to HQ reads HQ lines only', limitedRead.status === 200 && limitedRead.body.length > 0 && limitedRead.body.every((l) => l.assignedBranchKey === hq.id), limitedRead.text);
    const limitedGl = await call('GET', '/api/glaccounts/500-200', null, { who: 'books' });
    check('and balances for HQ only', limitedGl.status === 200 && limitedGl.body.balance === 700, limitedGl.text);
    const oneEntry = await call('GET', `/api/gljournalentries/${tx1}`);
    check('GET /gljournalentries/:ref returns the entry with its lines', oneEntry.status === 200 && oneEntry.body.manual === true && oneEntry.body.lines.length === 2
      && oneEntry.body.notes === 'September payroll', oneEntry.text);
    check('the older journal list still works', (await call('GET', `/api/accounting/journal?from=${yesterday}`)).status === 200);

    // ------------------------------------------------------------------------
    section('reversing a manual entry');
    const noNotes = await call('POST', `/api/gljournalentries/${tx1}:reverse`, {});
    check('notes are required', noNotes.status === 400 && /NOTES_REQUIRED/.test(noNotes.reason), noNotes.text);
    const rev = await call('POST', `/api/gljournalentries/${tx1}:reverse`, { notes: 'Payroll posted twice' });
    check('POST :reverse posts the mirror, on the entry\'s date, with its own transaction ID', rev.status === 201 && rev.body.length === 2
      && rev.body.find((l) => l.glAccount.glCode === '560-100').type === 'CREDIT' && rev.body[0].bookingDate === yesterday && rev.body[0].transactionId === `${tx1}-REV`
      && rev.body[0].notes === 'Payroll posted twice' && rev.body[0].reversalOf, rev.text);
    check('the reversed lines point at the reversal', (await call('GET', `/api/gljournalentries?transactionId=${tx1}`)).body.every((l) => l.reversalEntryKey === rev.body[0].journalEntryId));
    check('the accounts are back where they were', (await call('GET', '/api/glaccounts/560-000')).body.balance === 0);
    const again = await call('POST', `/api/gljournalentries/${tx1}:reverse`, { notes: 'again' });
    check('an entry is reversed once', again.status === 409 && /JOURNAL_ENTRY_ALREADY_REVERSED/.test(again.reason), again.text);
    const revRev = await call('POST', `/api/gljournalentries/${tx1}-REV:reverse`, { notes: 'undo' });
    check('a reversal is not reversed', revRev.status === 409 && /A_REVERSAL_CANNOT_BE_REVERSED/.test(revRev.reason), revRev.text);
    const autoRev = await call('POST', `/api/gljournalentries/${autoLine?.journalEntryId}:reverse`, { notes: 'x' });
    check('an automatic entry is reversed through its transaction', autoRev.status === 409 && /AUTOMATIC_JOURNAL_ENTRY/.test(autoRev.reason) && autoRev.reason.includes(depRef), autoRev.text);
    const byLine = await call('POST', `/api/gljournalentries/${own.body[0].entryId}:reverse`, { notes: 'wrong bank', date: today });
    check('an entry is found by a line\'s entryId too, and reversed on another date', byLine.status === 201 && byLine.body[0].bookingDate === today, byLine.text);

    // ------------------------------------------------------------------------
    section('files on a manual entry');
    const txt = Buffer.from('Payroll summary, September').toString('base64');
    const up = await call('POST', `/api/gljournalentries/${across.body[0].transactionId}/attachments`, { fileName: 'payroll.txt', title: 'Payroll', content: txt });
    check('a file is attached', up.status === 201 && up.body.fileName === 'payroll.txt' && up.body.size === 26, up.text);
    const rawUp = await call('POST', `/api/gljournalentries/${across.body[0].transactionId}/attachments?fileName=invoice.csv`, null, { raw: Buffer.from('a,b\n1,2\n'), type: 'text/csv' });
    check('or sent as the raw body', rawUp.status === 201 && rawUp.body.contentType === 'text/csv', rawUp.text);
    const listFiles = await call('GET', `/api/gljournalentries/${across.body[0].transactionId}/attachments`);
    check('listed', listFiles.status === 200 && listFiles.body.length === 2, listFiles.text);
    const dl = await call('GET', `/api/gljournalentries/${across.body[0].transactionId}/attachments/${up.body?.id}/download`);
    check('and downloaded', dl.status === 200 && dl.raw === 'Payroll summary, September' && /attachment/.test(dl.headers.get('content-disposition')), dl.text);
    const badFile = await call('POST', `/api/gljournalentries/${across.body[0].transactionId}/attachments`, { fileName: 'run.js', content: txt });
    check('under the attachment rules (no scripts)', badFile.status === 400 && /FILE_TYPE_NOT_ALLOWED/.test(badFile.reason), badFile.text);
    for (let i = 0; i < 3; i += 1) await call('POST', `/api/gljournalentries/${across.body[0].transactionId}/attachments`, { fileName: `f${i}.txt`, content: txt });
    const sixth = await call('POST', `/api/gljournalentries/${across.body[0].transactionId}/attachments`, { fileName: 'f9.txt', content: txt });
    check('at most five', sixth.status === 409 && /AT_MOST_5_FILES/.test(sixth.reason), sixth.text);
    const onAuto = await call('POST', `/api/gljournalentries/${autoLine?.journalEntryId}/attachments`, { fileName: 'x.txt', content: txt });
    check('files go on manual entries only', onAuto.status === 409 && /FILES_ARE_ATTACHED_TO_MANUAL_JOURNAL_ENTRIES/.test(onAuto.reason), onAuto.text);

    // ------------------------------------------------------------------------
    section('the interest accrual breakdown search');
    const acc = await call('POST', '/api/savings', { memberId: m.id, productId: 'SAV01' });
    await T((c) => c.query(
      `INSERT INTO accrual_lines (account_kind, product_id, branch_id, account_id, member_id, component, booking_date, debit_gl, credit_gl, amount, post_mode)
       VALUES ('SAVINGS','SAV01',$1,$2,$3,'INTEREST',$4,'500-100','200-100',12.34,'END_OF_DAY'),
              ('SAVINGS','SAV01',$5,$2,$3,'INTEREST',$4,'500-100','200-100',1.5,'END_OF_DAY')`,
      [hq.id, acc.body.id, m.id, yesterday, nkr.id]));
    const ia = await call('POST', '/api/accounting/interestaccrual:search?paginationDetails=ON', {
      filterCriteria: [{ field: 'accountId', operator: 'EQUALS', value: acc.body.account_no }] });
    check('each accrual line reads as its debit and its credit', ia.status === 200 && ia.body.length === 4 && ia.total === '4'
      && ia.body.some((x) => x.entryType === 'DEBIT' && x.glAccountId === '500-100' && x.amount === 12.34)
      && ia.body.some((x) => x.entryType === 'CREDIT' && x.glAccountId === '200-100' && x.glAccountType === 'LIABILITY'), ia.text);
    check('with the product, account and branch, and no parent entry while unposted',
      ia.body?.every((x) => x.productType === 'SAVINGS' && x.productId === 'SAV01' && x.accountKey === acc.body.id && x.parentEntryId === null)
      && ia.body.some((x) => x.branchId === 'HQ'), JSON.stringify(ia.body?.[0]));
    const iaGl = await call('POST', '/api/accounting/interestaccrual:search', { filterCriteria: [{ field: 'glAccountId', operator: 'EQUALS', value: '500-100' },
      { field: 'bookingDate', operator: 'ON', value: yesterday }], sortingCriteria: { field: 'amount', order: 'ASC' } });
    check('filtered by GL account and date, sorted', iaGl.status === 200 && iaGl.body.length === 2 && iaGl.body[0].amount === 1.5, iaGl.text);
    const iaLimited = await call('POST', '/api/accounting/interestaccrual:search', {}, { who: 'books' });
    check('a user limited to HQ reads HQ accruals', iaLimited.status === 200 && iaLimited.body.length === 2 && iaLimited.body.every((x) => x.branchId === 'HQ'), iaLimited.text);
    check('reading it takes VIEW_ACCOUNTING_REPORTS', (await call('POST', '/api/accounting/interestaccrual:search', {}, { who: 'teller' })).status === 403);
    await T((c) => c.query('DELETE FROM accrual_lines WHERE account_id = $1', [acc.body.id]));

    // ------------------------------------------------------------------------
    section('accounting rates, the reference platform\'s spelling');
    await call('POST', '/api/currencies', { code: 'USD' });
    const ar = await call('POST', '/api/currencies/USD/accountingRates', { rate: 129.5 });
    check('POST /currencies/:code/accountingRates sets a rate', ar.status === 201 && Number(ar.body.rate) === 129.5, ar.text);
    const arList = await call('GET', '/api/currencies/USD/accountingRates');
    check('GET lists them', arList.status === 200 && arList.body.length === 1 && arList.body[0].rate === 129.5 && arList.body[0].toCurrencyCode === 'USD'
      && arList.body[0].fromCurrencyCode === 'KES', arList.text);
    check('setting one takes CREATE_ACCOUNTING_RATES', (await call('POST', '/api/currencies/USD/accountingRates', { rate: 1 }, { who: 'teller' })).status === 403);

    // ------------------------------------------------------------------------
    section('the ledger still verifies');
    const v = await call('GET', '/api/accounting/verify');
    check('the rollup matches the lines', v.status === 200 && v.body.exact === true, v.text);
    const tb = await call('GET', '/api/accounting/trial-balance');
    check('the trial balance balances', tb.status === 200 && tb.body.balanced === true, tb.text);
    const log = (await T((c) => c.query("SELECT action FROM audit_log WHERE action IN ('GL_ACCOUNT_CREATED','GL_ACCOUNT_EDITED','GL_ACCOUNT_DELETED','MANUAL_JOURNAL_ENTRY_LOGGED','MANUAL_JOURNAL_ENTRY_REVERSED','JOURNAL_ENTRY_FILE_ATTACHED','ACCOUNTING_CLOSURE_EDITED')"))).rows;
    const acts = new Set(log.map((r) => r.action));
    check('every change is in the audit log', acts.size === 7, [...acts].join(','));
  } catch (e) {
    fail++; failures.push(`exception ${e.stack}`); console.log(e);
  } finally {
    server.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(fail ? 1 : 0);
  }
})();
