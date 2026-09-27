#!/usr/bin/env node
'use strict';

/**
 * Reporting, after the reference platform's Data and Reporting > Reporting pages: the
 * organization's day, the accounting reports (trial balance with opening
 * and closing balances, the balance sheet by month and branch, exports, the
 * background accounting reports API), portfolio at risk and value at risk
 * with past days read from the end of day's positions, the risk report,
 * indicators and saved indicator reports, the management reports, and
 * custom views with their API v1 filter.
 */

const { orgDay, orgToday, addDays } = require('./_org');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { orgToday: sqlToday } = require('../src/lib/orgDate');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/savings');
const PV = require('../src/domain/provisioning');
const PF = require('../src/domain/portfolio');
const R = require('../src/domain/reports');
const acct = require('../src/domain/accounting');
const DD = require('../src/domain/dataDictionary');
const XLSX = require('../src/lib/xlsx');
const eod = require('../src/ops/eod');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'rpttest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4107;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const q1 = (sql, params = []) => Rd(async (c) => (await c.query(sql, params)).rows[0]);
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokens = {};
async function call(method, p, body, { who = 'admin', headers: extra = {}, raw = false } = {}) {
  const headers = { 'x-tenant': SLUG, ...extra };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text, headers: r.headers, reason: d?.errors?.[0]?.errorReason || '' };
}

let seq = 0;
async function member(c, { branchId, gender = 'FEMALE', officer = null, centreId = null, deposit = 0 }) {
  seq += 1;
  const no = `R${String(seq).padStart(4, '0')}`;
  const m = (await c.query(
    `INSERT INTO members (member_no, first_name, last_name, gender, branch_id, centre_id, credit_officer, joined_on)
     VALUES ($1, 'Rep', $1, $2, $3, $4, $5, current_date) RETURNING *`, [no, gender, branchId, centreId, officer])).rows[0];
  const sav = await S.open(c, { memberId: m.id });
  if (deposit) await S.deposit(c, sav.id, { amount: deposit, channelId: 'cash', createdBy: 'test' });
  return m;
}
async function loan(c, m, { principal = 12000, term = 12, disbursedDaysAgo = null, approve = true, productId = 'RP1' } = {}) {
  const l = await L.apply(c, { memberId: m.id, productId, principal, termMonths: term, createdBy: 'officer' });
  if (approve) await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
  if (approve && disbursedDaysAgo !== null) {
    await L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: orgDay(-disbursedDaysAgo), createdBy: 'teller' });
    await L.accrueInterest(c, l.id, { valueDate: orgDay(0), createdBy: 'test' });
  }
  return (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [l.id])).rows[0];
}

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Report SACCO', mfaRequiredRoles: [], adminEmail: 'admin@rpt.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    tokens.admin = (await call('POST', '/api/auth/login', { email: 'admin@rpt.local', password: PASSWORD })).body.accessToken;
    check('admin signed in', !!tokens.admin);
    for (const [who, role] of [['manager', 'MANAGER'], ['teller', 'TELLER'], ['officer', 'TELLER'], ['auditor', 'AUDITOR']]) {
      const u = await call('POST', '/api/users', { email: `${who}@rpt.local`, fullName: `The ${who}`, role, password: `${who} first password` });
      if (u.status !== 201) check(`user ${who}`, false, u.text);
      await pool.query('UPDATE platform.users SET must_change_password = false WHERE lower(email) = $1', [`${who}@rpt.local`]);
      tokens[who] = (await call('POST', '/api/auth/login', { email: `${who}@rpt.local`, password: `${who} first password` })).body?.accessToken;
    }
    check('staff signed in', tokens.manager && tokens.teller && tokens.officer && tokens.auditor);
    const east = await call('POST', '/api/branches', { code: 'EAST', name: 'East' });
    const west = await call('POST', '/api/branches', { code: 'WEST', name: 'West' });
    check('two branches', east.status === 201 && west.status === 201, east.text);
    const ce = await call('POST', '/api/centres', { code: 'C1', name: 'Market centre', branchId: east.body.id });
    check('a centre in the east', ce.status === 201, ce.text);
    const prod = await call('POST', '/api/loan-products', {
      id: 'RP1', name: 'Report loan', glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200',
      method: 'FLAT', monthlyRate: 1, maxTerm: 24, enforceDepositMultiplier: false, accountingMethod: 'CASH',
    });
    const prod2 = await call('POST', '/api/loan-products', {
      id: 'RP2', name: 'Second loan', glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200',
      method: 'FLAT', monthlyRate: 1, maxTerm: 24, enforceDepositMultiplier: false, accountingMethod: 'CASH',
    });
    check('loan products', prod.status === 201 && prod2.status === 201, prod.text);

    // ------------------------------------------------------------------------
    section("the organization's day");
    const utcHour = new Date().getUTCHours();
    const zone = utcHour >= 12 ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
    const utcDay = new Date().toISOString().slice(0, 10);
    await pool.query('UPDATE platform.tenants SET timezone = $1 WHERE slug = $2', [zone, SLUG]);
    const local = orgToday(zone);
    check(`the zone chosen has a different day from UTC (${zone}: ${local}, UTC ${utcDay})`, local !== utcDay);
    check('a tenant transaction runs on the tenant\'s day', (await Rd((c) => sqlToday(c))) === local);
    const bsz = await call('GET', '/api/reports/balance-sheet');
    check('a report with no date is as at the organization\'s day, not the UTC day', bsz.body.asAt === local, bsz.body.asAt);
    const parz = await call('GET', '/api/reports/portfolio-at-risk');
    check('and so is portfolio at risk', parz.body.asAt === local, parz.body.asAt);
    const dflt = await T(async (c) => (await c.query("INSERT INTO journal_entries (narration) VALUES ('day test') RETURNING booking_date::text AS d")).rows[0].d);
    check('a column that defaults to current_date takes the organization\'s day', dflt === local, dflt);
    await T((c) => c.query("DELETE FROM journal_entries WHERE narration = 'day test'"));
    await pool.query("UPDATE platform.tenants SET timezone = 'Africa/Nairobi' WHERE slug = $1", [SLUG]);
    check('back in Nairobi', (await Rd((c) => sqlToday(c))) === orgToday());
    check('the portfolio positions are the end of day\'s last job', eod.DEFAULT_JOBS.indexOf('snapshotPortfolio') > eod.DEFAULT_JOBS.indexOf('autoClosure'), eod.DEFAULT_JOBS.join(','));

    // ------------------------------------------------------------------------
    section('the book');
    const E = east.body.id, W = west.body.id;
    const m1 = await T((c) => member(c, { branchId: E, gender: 'FEMALE', officer: 'officer@rpt.local', centreId: ce.body.id, deposit: 20000 }));
    const m2 = await T((c) => member(c, { branchId: W, gender: 'MALE', officer: 'manager@rpt.local', deposit: 15000 }));
    const m3 = await T((c) => member(c, { branchId: E, gender: 'FEMALE', officer: 'officer@rpt.local', deposit: 5000 }));
    const m4 = await T((c) => member(c, { branchId: W, gender: 'MALE', deposit: 1000 }));
    // A: east, 100 days old and nothing paid: late. B: west, fresh: current.
    // C: pending approval. D: approved, not disbursed. G: east, second product, 40 days, one installment late.
    const A = await T((c) => loan(c, m1, { principal: 12000, term: 12, disbursedDaysAgo: 100 }));
    const B = await T((c) => loan(c, m2, { principal: 6000, term: 6, disbursedDaysAgo: 5 }));
    const Cn = await T((c) => loan(c, m3, { principal: 3000, term: 3, approve: false }));
    const D = await T((c) => loan(c, m4, { principal: 2000, term: 4 }));
    const G = await T((c) => loan(c, m3, { principal: 4000, term: 4, disbursedDaysAgo: 40, productId: 'RP2' }));
    await T((c) => L.markArrears(c, { asOf: orgDay(0) }));
    check('the loan takes its member\'s credit officer', A.credit_officer === 'officer@rpt.local' && B.credit_officer === 'manager@rpt.local' && D.credit_officer === null,
      `${A.credit_officer} ${B.credit_officer} ${D.credit_officer}`);
    const patched = await call('PATCH', `/api/loans/${D.id}`, { creditOfficer: 'officer@rpt.local' });
    check('and the officer can be changed on the loan', patched.status === 200 && patched.body.credit_officer === 'officer@rpt.local', patched.text);
    await T((c) => L.repay(c, B.id, { amount: 500, channelId: 'cash', valueDate: orgDay(0), createdBy: 'teller' }));

    // ------------------------------------------------------------------------
    section('trial balance');
    const tb = await call('GET', '/api/accounting/trial-balance');
    const byCode = Object.fromEntries(tb.body.rows.map((r) => [r.code, r]));
    check('it balances', tb.body.balanced && tb.body.totals.debit > 0, JSON.stringify(tb.body.totals));
    const port = byCode['100-100'];
    check('an asset reads debit minus credit', port && port.netChange === round2(port.debit - port.credit) && port.netChange > 0, JSON.stringify(port));
    const dep = byCode['200-100'];
    check('a liability reads credit minus debit', dep && dep.netChange === round2(dep.credit - dep.debit) && dep.netChange > 0, JSON.stringify(dep));
    check('with no start date the opening balance is nil', tb.body.rows.every((r) => r.openingBalance === 0));
    const mid = orgDay(-20);
    const tb2 = await call('GET', `/api/accounting/trial-balance?from=${mid}&to=${orgDay(0)}`);
    const p2 = tb2.body.rows.find((r) => r.code === '100-100');
    const before = await Rd((c) => acct.balance(c, '100-100', { to: addDays(mid, -1) }));
    check('a later start opens on the balance the day before', p2.openingBalance === round2(before) && p2.openingBalance > 0, `${p2.openingBalance} vs ${before}`);
    check('and opening plus net change is the closing balance', tb2.body.rows.every((r) => r.closingBalance === round2(r.openingBalance + r.netChange)));
    check('the closing balance is the balance at the end', p2.closingBalance === round2(await Rd((c) => acct.balance(c, '100-100', { to: orgDay(0) }))));
    const zero = await call('GET', '/api/accounting/trial-balance?zeroBalances=true&limit=500');
    check('zero balance accounts are left out unless asked for', zero.body.page.total > tb.body.page.total && zero.body.rows.some((r) => r.code === '500-200' && r.debit === 0 && r.credit === 0),
      `${zero.body.page.total} vs ${tb.body.page.total}`);
    const onlyA = await call('GET', '/api/accounting/trial-balance?glTypes=ASSET');
    check('glTypes keeps one kind of account', onlyA.body.rows.length > 0 && onlyA.body.rows.every((r) => r.type === 'ASSET'));
    const tbE = await call('GET', '/api/accounting/trial-balance?branchId=EAST&limit=500');
    const tbW = await call('GET', `/api/accounting/trial-balance?branchId=${W}&limit=500`);
    const tbN = await call('GET', '/api/accounting/trial-balance?branchId=NONE&limit=500');
    const portOf = (t) => (t.body.rows.find((r) => r.code === '100-100') || { debit: 0 }).debit;
    check('by branch, by code or id, and the branches add up to the whole', tbE.body.branch.code === 'EAST' && round2(portOf(tbE) + portOf(tbW) + portOf(tbN)) === port.debit,
      `${portOf(tbE)} + ${portOf(tbW)} + ${portOf(tbN)} vs ${port.debit}`);
    check('each branch balances on its own', tbE.body.balanced && tbW.body.balanced, `${JSON.stringify(tbE.body.totals)} ${JSON.stringify(tbW.body.totals)}`);
    const nob = await call('GET', '/api/accounting/trial-balance?branchId=NOPE');
    check('an unknown branch is a 404', nob.status === 404 && /BRANCH_NOT_FOUND/.test(nob.reason), nob.text);

    section('balance sheet and income statement');
    const month = orgDay(0).slice(0, 7);
    const bsm = await call('GET', `/api/reports/balance-sheet?month=${month}`);
    check('the balance sheet for a month is that month\'s postings, to today', bsm.body.mode === 'MONTH' && bsm.body.period.from === `${month}-01` && bsm.body.asAt === orgDay(0) && bsm.body.balances,
      JSON.stringify({ mode: bsm.body.mode, period: bsm.body.period, balances: bsm.body.balances }));
    const bsd = await call('GET', '/api/reports/balance-sheet');
    check('and by date it is the whole book', bsd.body.mode === 'DATE' && bsd.body.totalAssets >= bsm.body.totalAssets && bsd.body.balances);
    const bad = await call('GET', '/api/reports/balance-sheet?month=2026-13');
    check('a month that is not one is refused', bad.status === 400 && /INVALID_MONTH/.test(bad.reason));
    const bsE = await call('GET', '/api/reports/balance-sheet?branchId=EAST');
    check('a branch balance sheet names its branch', bsE.body.branch && bsE.body.branch.code === 'EAST' && bsE.body.totalAssets > 0, JSON.stringify(bsE.body.branch));
    const isAll = await call('GET', `/api/reports/income-statement?from=${orgDay(-120)}`);
    const isE = await call('GET', `/api/reports/income-statement?from=${orgDay(-120)}&branchId=EAST`);
    const isW = await call('GET', `/api/reports/income-statement?from=${orgDay(-120)}&branchId=WEST`);
    const isN = await call('GET', `/api/reports/income-statement?from=${orgDay(-120)}&branchId=NONE`);
    check('branch income statements add up to the whole', round2(isE.body.surplus + isW.body.surplus + isN.body.surplus) === isAll.body.surplus,
      `${isE.body.surplus} + ${isW.body.surplus} + ${isN.body.surplus} vs ${isAll.body.surplus}`);

    section('exports');
    const csv = await call('GET', '/api/accounting/trial-balance?format=csv', null, { raw: true });
    const text = csv.buffer.toString('utf8');
    check('the trial balance downloads as CSV with the organization in the header',
      csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && /^Organization,Report SACCO/.test(text) && /Opening balance,Debits,Credits,Net change,Closing balance/.test(text),
      text.slice(0, 200));
    check('named for the tenant and the report', /rpttest-trial-balance/.test(csv.headers.get('content-disposition') || ''), csv.headers.get('content-disposition'));
    const xl = await call('GET', '/api/reports/balance-sheet?format=xlsx&branchId=EAST', null, { raw: true });
    const book = XLSX.read(xl.buffer);
    const rows = book[0].rows;
    check('the balance sheet downloads as a workbook with the branch in its header', xl.status === 200 && rows.some((r) => r[0] === 'Branch' && /EAST/.test(r[1])), JSON.stringify(rows.slice(0, 5)));
    const totalRow = rows.find((r) => r[2] === 'Total assets');
    check('its amounts are numbers', totalRow && typeof totalRow[3] === 'number' && totalRow[3] === bsE.body.totalAssets, JSON.stringify(totalRow));
    const badFmt = await call('GET', '/api/reports/balance-sheet?format=pdf');
    check('a format other than csv or xlsx is refused', badFmt.status === 400);

    section('accounting reports in the background (the reference platform: /accounting/reports)');
    const body = { startDate: orgDay(-120), endDate: orgDay(0), balanceTypes: ['OPENING_BALANCE', 'NET_CHANGE', 'CLOSING_BALANCE'] };
    const started = await call('POST', '/api/accounting/reports', body, { headers: { 'idempotency-key': 'acc-report-1' } });
    check('it starts QUEUED with a report key', started.status === 202 && started.body.status === 'QUEUED' && /^[0-9a-f-]{36}$/.test(started.body.reportKey), started.text);
    let got;
    for (let i = 0; i < 100; i += 1) {
      got = await call('GET', `/api/accounting/reports/${started.body.reportKey}`);
      if (got.body.status === 'COMPLETE' || got.body.status === 'ERROR') break;
      await sleep(30);
    }
    check('and completes', got.body.status === 'COMPLETE', got.text.slice(0, 300));
    const item = got.body.items.find((x) => x.glAccount.id === '100-100');
    const tbSame = (await call('GET', `/api/accounting/trial-balance?from=${body.startDate}&to=${body.endDate}&limit=500`)).body.rows.find((r) => r.code === '100-100');
    check('with the reference platform\'s shape: glAccount and amounts', item && item.glAccount.name && item.glAccount.type === 'ASSET'
      && ['openingBalance', 'debits', 'credits', 'netChange', 'closingBalance'].every((k) => typeof item.amounts[k] === 'number'), JSON.stringify(item));
    check('and the trial balance\'s figures', item.amounts.closingBalance === tbSame.closingBalance && item.amounts.debits === tbSame.debit, `${JSON.stringify(item.amounts)} ${JSON.stringify(tbSame)}`);
    const again = await call('POST', '/api/accounting/reports', body, { headers: { 'idempotency-key': 'acc-report-1' } });
    check('the same Idempotency-Key returns the same report', again.body.reportKey === started.body.reportKey, again.text);
    const closing = await call('POST', '/api/accounting/reports?wait=true', { ...body, balanceTypes: ['CLOSING_BALANCE'], glTypes: ['LIABILITY'], branchId: 'WEST' });
    check('balance types, GL types and a branch narrow it', closing.status === 200 && closing.body.items.length > 0
      && closing.body.items.every((x) => x.glAccount.type === 'LIABILITY' && x.amounts.closingBalance !== undefined && x.amounts.openingBalance === undefined), closing.text.slice(0, 300));
    const missing = await call('POST', '/api/accounting/reports', { endDate: orgDay(0) });
    const backwards = await call('POST', '/api/accounting/reports', { startDate: orgDay(0), endDate: orgDay(-1) });
    const badType = await call('POST', '/api/accounting/reports', { ...body, balanceTypes: ['EVERYTHING'] });
    const curr = await call('POST', '/api/accounting/reports', { ...body, currencyCode: 'XYZ' });
    check('a start date is required, before the end, with known balance types', missing.status === 400 && backwards.status === 400 && badType.status === 400,
      `${missing.status} ${backwards.status} ${badType.status}`);
    check('an unknown currency is a 404', curr.status === 404 && /CURRENCY_NOT_FOUND/.test(curr.reason), curr.text);
    const teller = await call('POST', '/api/accounting/reports', body, { who: 'teller' });
    check('a teller may not run one', teller.status === 403);
    await T((c) => c.query("UPDATE accounting_report_jobs SET expires_at = now() - interval '1 minute' WHERE report_key = $1", [started.body.reportKey]));
    const gone = await call('GET', `/api/accounting/reports/${started.body.reportKey}`);
    check('after 24 hours it is gone', gone.status === 404);

    // ------------------------------------------------------------------------
    section('portfolio at risk and value at risk');
    const par = await call('GET', '/api/reports/portfolio-at-risk');
    const pos = await Rd((c) => PF.positions(c, {}));
    const posA = pos.rows.find((r) => r.loan_id === A.id);
    const posB = pos.rows.find((r) => r.loan_id === B.id);
    const posG = pos.rows.find((r) => r.loan_id === G.id);
    const firstDueA = (await q1("SELECT min(due_date)::text AS d FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID'", [A.id])).d;
    const expectLate = Math.round((Date.parse(orgDay(0)) - Date.parse(firstDueA)) / 86400000);
    check('days late: since the oldest unpaid installment fell due', posA.days_late === expectLate && posA.days_late > 30, `${posA.days_late} vs ${expectLate}`);
    check('a loan with nothing due is current', posB.days_late === 0);
    check('pending and undisbursed loans are not in the portfolio', !pos.rows.some((r) => [Cn.id, D.id].includes(r.loan_id)));
    const glp = round2(pos.rows.reduce((s, r) => s + r.principal_outstanding, 0));
    const repaidPrincipal = Number((await q1("SELECT COALESCE(SUM((allocation->>'principal')::numeric), 0) AS p FROM transactions WHERE kind = 'LOAN_REPAYMENT'")).p);
    check('the gross loan portfolio is the principal disbursed less repaid', par.body.totalOutstanding === glp && glp === round2(22000 - repaidPrincipal), `${par.body.totalOutstanding} ${glp} ${repaidPrincipal}`);
    const lateOut = round2(pos.rows.filter((r) => r.days_late > 0).reduce((s, r) => s + r.principal_outstanding, 0));
    check('PAR is the outstanding of late loans over the portfolio', par.body.par.PAR.outstanding === lateOut && par.body.parPercent === round2(lateOut / glp * 100), JSON.stringify(par.body.par.PAR));
    const over30 = pos.rows.filter((r) => r.days_late > 30);
    check('PAR over 30 counts only loans more than 30 days late', par.body.par.PAR_OVER_30.loans === over30.length && over30.some((r) => r.loan_id === A.id));
    check('a range is more than its start and at most its end', par.body.par.PAR_30_90.loans === pos.rows.filter((r) => r.days_late > 30 && r.days_late <= 90).length);
    const overdue = round2(pos.rows.filter((r) => r.days_late > 0).reduce((s, r) => s + r.principal_overdue, 0));
    check('VAR is the overdue principal of late loans over the portfolio', par.body.var.VAR.overdue === overdue && overdue < lateOut && par.body.var.VAR.percent === round2(overdue / glp * 100),
      JSON.stringify(par.body.var.VAR));
    check('interest in suspense is the unpaid interest on late loans', par.body.interestInSuspense === round2(pos.rows.filter((r) => r.days_late > 0).reduce((s, r) => s + r.interest_outstanding, 0)));
    check('the buckets still add up to the portfolio', round2(par.body.buckets.reduce((s, b) => s + b.outstanding, 0)) === glp);
    check('and the definitions are stated', par.body.definitions && /PAR over X/.test(par.body.definitions.par));
    const parE = await call('GET', '/api/reports/portfolio-at-risk?branchId=EAST');
    check('by branch', parE.body.totalOutstanding === round2(posA.principal_outstanding + posG.principal_outstanding) && parE.body.scope.branch.code === 'EAST', JSON.stringify(parE.body.scope));
    const parO = await call('GET', '/api/reports/portfolio-at-risk?creditOfficer=OFFICER@rpt.local');
    const parP = await call('GET', '/api/reports/portfolio-at-risk?productId=RP2');
    const parC = await call('GET', '/api/reports/portfolio-at-risk?centreId=C1');
    check('by credit officer (any case), product and centre', parO.body.totalOutstanding === round2(posA.principal_outstanding + posG.principal_outstanding)
      && parP.body.totalOutstanding === posG.principal_outstanding && parC.body.totalOutstanding === posA.principal_outstanding,
      `${parO.body.totalOutstanding} ${parP.body.totalOutstanding} ${parC.body.totalOutstanding}`);
    const loans = await call('GET', '/api/reports/portfolio-at-risk/loans?minDaysLate=31');
    check('the loans behind it filter by days late', loans.body.items.length === over30.length && loans.body.items.every((x) => x.days_late >= 31), JSON.stringify(loans.body.items.map((x) => x.days_late)));
    const lx = await call('GET', '/api/reports/portfolio-at-risk/loans?format=csv', null, { raw: true });
    const lxRows = lx.buffer.toString().split('\r\n');
    const head = lxRows.findIndex((r) => r.startsWith('Loan,Member'));
    check('and download whole', lx.status === 200 && head > 0 && lxRows.slice(head + 1).filter(Boolean).length === pos.rows.length, lxRows.slice(0, 12).join(' | '));

    section('past days read the end of day\'s positions');
    const yesterday = orgDay(-1);
    const none = await call('GET', `/api/reports/portfolio-at-risk?asAt=${yesterday}`);
    check('a past day without positions is refused, not guessed', none.status === 409 && /NO_PORTFOLIO_POSITIONS_FOR_DATE/.test(none.reason), none.text);
    const future = await call('GET', `/api/reports/portfolio-at-risk?asAt=${orgDay(1)}`);
    check('so is a future day', future.status === 400 && /AS_AT_IN_THE_FUTURE/.test(future.reason));
    const snap = await T((c) => PF.snapshot(c, { date: yesterday, takenBy: 'test' }));
    check('positions are taken for a business day', snap.loans === pos.rows.length, JSON.stringify(snap));
    const tooOld = await T((c) => PF.snapshot(c, { date: orgDay(-5) }).catch((e) => e));
    check('but not for a day before yesterday: the loan tables hold the present', tooOld instanceof Error && /TODAY_OR_YESTERDAY/.test(tooOld.message));
    const parY = await call('GET', `/api/reports/portfolio-at-risk?asAt=${yesterday}`);
    check('the day reads back from its positions', parY.status === 200 && parY.body.source === 'SNAPSHOT' && parY.body.totalOutstanding === glp, parY.text.slice(0, 200));
    await T((c) => L.repay(c, A.id, { amount: 5000, channelId: 'cash', valueDate: orgDay(0), createdBy: 'teller' }));
    const parY2 = await call('GET', `/api/reports/portfolio-at-risk?asAt=${yesterday}`);
    const parT = await call('GET', '/api/reports/portfolio-at-risk');
    check('a payment today moves today\'s figures and leaves that day\'s alone', parY2.body.totalOutstanding === glp && parT.body.totalOutstanding < glp && parT.body.source === 'LIVE',
      `${parY2.body.totalOutstanding} ${parT.body.totalOutstanding}`);
    const range = await call('GET', '/api/reports/positions');
    check('the days held are listed', range.body.earliest === yesterday && range.body.days === 1, range.text);
    const took = await call('POST', '/api/reports/positions');
    check('an administrator can take today\'s now', took.status === 201 && took.body.businessDate === orgDay(0), took.text);

    section('a locked loan is still in the portfolio');
    await T((c) => L.changeState(c, G.id, 'LOCK', { createdBy: 'manager', reason: 'MANUAL' }));
    const parL = await call('GET', '/api/reports/portfolio-at-risk?productId=RP2');
    check('it counts in PAR', parL.body.totalOutstanding === posG.principal_outstanding && parL.body.totalOutstanding > 0, parL.text.slice(0, 200));
    await T(async (c) => {
      for (const [code, rate] of Object.entries({ PERFORMING: 1, WATCH: 5, SUBSTANDARD: 25, DOUBTFUL: 50, LOSS: 100 })) {
        await PV.setBand(c, code, { ratePercent: rate, sourceNote: 'test fixture', createdBy: 'test' });
      }
    });
    const pv = await Rd((c) => PV.compute(c, {}));
    check('and in the provisioning run', pv.portfolioOutstanding === parT.body.totalOutstanding, `${pv.portfolioOutstanding} vs ${parT.body.totalOutstanding}`);

    section('the risk report');
    const risk = await call('GET', '/api/reports/risk?groupBy=BRANCH');
    const lateNow = (await Rd((c) => PF.positions(c, {}))).rows.filter((r) => r.days_late >= 1);
    check('loans at least a day late, grouped by branch', risk.body.loans === lateNow.length && risk.body.groups.every((g) => g.label) && risk.body.groups.some((g) => /EAST/.test(g.label)),
      JSON.stringify(risk.body.groups));
    check('each band with its rate and the provision it calls for', risk.body.bands.every((b) => b.ratePercent !== null) && risk.body.provisionRequired !== null
      && risk.body.provisionRequired === round2(risk.body.bands.reduce((s, b) => s + (b.provisionRequired || 0), 0)), JSON.stringify(risk.body.bands));
    const riskO = await call('GET', '/api/reports/risk?groupBy=CREDIT_OFFICER');
    check('by credit officer, named from the user', riskO.body.groups.some((g) => g.label === 'The officer'), JSON.stringify(riskO.body.groups));
    const riskBand = await call('GET', '/api/reports/risk?band=SUBSTANDARD&groupBy=PRODUCT');
    check('filtered to one risk level', riskBand.body.bands.every((b) => b.band === 'SUBSTANDARD') && riskBand.body.filter.band === 'SUBSTANDARD');
    const riskAge = await call('GET', '/api/reports/risk?minDaysLate=0&maxDaysLate=0');
    check('and by age: nought days is the current loans', riskAge.body.loans === (await Rd((c) => PF.positions(c, {}))).rows.filter((r) => r.days_late === 0).length);
    await T((c) => c.query('UPDATE provision_bands SET rate_percent = NULL WHERE code = $1', ['LOSS']));
    const unset = await call('GET', '/api/reports/risk?minDaysLate=0');
    check('a rate not set shows as not set, not as nothing', unset.body.ratesUnset.includes('LOSS') && unset.body.bands.find((b) => b.band === 'LOSS').ratePercent === null);
    await T((c) => c.query('UPDATE provision_bands SET rate_percent = 100 WHERE code = $1', ['LOSS']));
    const rx = await call('GET', '/api/reports/risk?format=xlsx', null, { raw: true });
    check('the risk report downloads', rx.status === 200 && XLSX.read(rx.buffer)[0].rows.some((r) => r[0] === 'Report' && r[1] === 'Risk'));

    // ------------------------------------------------------------------------
    section('indicators');
    const cat = await call('GET', '/api/reports/indicators/catalog');
    check('a catalog in five groups', cat.body.indicators.length >= 45 && cat.body.groups.length === 5, String(cat.body.indicators.length));
    const ind = await call('GET', '/api/reports/indicators');
    const v = Object.fromEntries(ind.body.indicators.map((x) => [x.code, x.value]));
    check('clients, borrowers and savers', v.CLIENTS === 4 && v.ACTIVE_BORROWERS === 3 && v.ACTIVE_SAVERS === 4, JSON.stringify({ c: v.CLIENTS, b: v.ACTIVE_BORROWERS, s: v.ACTIVE_SAVERS }));
    check('female borrowers as a share of borrowers', v.FEMALE_BORROWERS_PERCENT === round2(2 / 3 * 100), String(v.FEMALE_BORROWERS_PERCENT));
    check('the portfolio and its risk agree with PAR', v.GROSS_LOAN_PORTFOLIO === parT.body.totalOutstanding && v.PAR === parT.body.par.PAR.percent && v.VAR_OVER_30 === parT.body.var.VAR_OVER_30.percent);
    check('pending approval and pending disbursement', v.LOANS_PENDING_APPROVAL === 1 && v.AMOUNT_PENDING_APPROVAL === 3000 && v.LOANS_PENDING_DISBURSEMENT === 1 && v.AMOUNT_PENDING_DISBURSEMENT === 2000,
      JSON.stringify([v.LOANS_PENDING_APPROVAL, v.AMOUNT_PENDING_APPROVAL, v.LOANS_PENDING_DISBURSEMENT, v.AMOUNT_PENDING_DISBURSEMENT]));
    check('deposits and the loan to deposit ratio', v.DEPOSIT_BALANCE === 41000 && v.LOAN_TO_DEPOSIT_RATIO === round2(v.GROSS_LOAN_PORTFOLIO / 41000 * 100), String(v.DEPOSIT_BALANCE));
    check('branches and users', v.BRANCHES === 2 && v.USERS >= 5, `${v.BRANCHES} ${v.USERS}`);
    const indE = await call('GET', '/api/reports/indicators?entityType=BRANCH&entityId=EAST');
    const ve = Object.fromEntries(indE.body.indicators.map((x) => [x.code, x.value]));
    check('for a branch', ve.CLIENTS === 2 && ve.BRANCHES === 1 && ve.DEPOSIT_BALANCE === 25000 && indE.body.entity.label === 'EAST East', JSON.stringify(indE.body.entity));
    const indP = await call('GET', '/api/reports/indicators?entityType=LOAN_PRODUCT&entityId=RP2');
    const dp = indP.body.indicators.find((x) => x.code === 'DEPOSIT_BALANCE');
    const gp = indP.body.indicators.find((x) => x.code === 'GROSS_LOAN_PORTFOLIO');
    check('for a loan product, deposit figures do not apply', dp.value === null && dp.reason === 'NOT_APPLICABLE_TO_SCOPE' && gp.value === posG.principal_outstanding);
    const indO = await call('GET', '/api/reports/indicators?entityType=CREDIT_OFFICER&entityId=officer@rpt.local&indicators=ACTIVE_BORROWERS,CLIENTS');
    check('for a credit officer, just the indicators asked for', indO.body.indicators.length === 2 && indO.body.indicators[1].value === 2, JSON.stringify(indO.body.indicators));
    const indBad = await call('GET', '/api/reports/indicators?indicators=NOT_ONE');
    check('an unknown indicator is refused', indBad.status === 400 && /UNKNOWN_INDICATORS/.test(indBad.reason));

    section('saved indicator reports');
    const ir = await call('POST', '/api/reports/indicator-reports', { name: 'East weekly', description: 'For the branch meeting', entityType: 'BRANCH', entityId: 'EAST', indicators: ['PAR_OVER_30', 'GROSS_LOAN_PORTFOLIO', 'ACTIVE_BORROWERS'] }, { who: 'manager' });
    check('a manager saves one for a branch', ir.status === 201 && ir.body.entityId === E, ir.text);
    const dupe = await call('POST', '/api/reports/indicator-reports', { name: 'East weekly', indicators: ['PAR'] }, { who: 'manager' });
    check('names are unique', dupe.status === 409);
    const byTeller = await call('POST', '/api/reports/indicator-reports', { name: 'Mine', indicators: ['PAR'] }, { who: 'teller' });
    check('a teller may not', byTeller.status === 403);
    const irRun = await call('GET', `/api/reports/indicator-reports/${ir.body.id}`);
    check('it runs with its values', irRun.body.report.name === 'East weekly' && irRun.body.indicators.map((x) => x.code).join() === 'PAR_OVER_30,GROSS_LOAN_PORTFOLIO,ACTIVE_BORROWERS' && irRun.body.indicators[1].value === ve.GROSS_LOAN_PORTFOLIO);
    const irEd = await call('PATCH', `/api/reports/indicator-reports/${ir.body.id}`, { indicators: ['PAR'], entityType: 'ORGANIZATION', entityId: null }, { who: 'manager' });
    check('edited to the organization', irEd.status === 200 && irEd.body.entityType === 'ORGANIZATION' && irEd.body.entityId === null, irEd.text);
    const irX = await call('GET', `/api/reports/indicator-reports/${ir.body.id}?format=xlsx`, null, { raw: true });
    check('exported to Excel', irX.status === 200 && XLSX.read(irX.buffer)[0].rows.some((r) => r[2] === 'PAR'));
    const irDel = await call('DELETE', `/api/reports/indicator-reports/${ir.body.id}`, null, { who: 'manager' });
    check('and deleted', irDel.status === 200 && (await call('GET', '/api/reports/indicator-reports')).body.length === 0);

    // ------------------------------------------------------------------------
    section('management reports');
    const pr = await call('GET', `/api/reports/portfolio?from=${orgDay(-120)}&to=${orgDay(0)}&interval=MONTHLY`);
    check('the portfolio report: intervals across the range', pr.status === 200 && pr.body.accounts.length >= 4 && pr.body.accounts[0].from === orgDay(-120), pr.text.slice(0, 300));
    const disb = pr.body.accounts.reduce((s, a) => s + a.disbursed.amount, 0);
    check('with what was disbursed in each', round2(disb) === 22000 && pr.body.overview.loansDisbursedInPeriod === 3, `${disb}`);
    const lastH = pr.body.historical[pr.body.historical.length - 1];
    check('the last point is today, live', lastH.source === 'LIVE' && lastH.grossLoanPortfolio === parT.body.totalOutstanding && lastH.loansByStatus.LOCKED === 1, JSON.stringify(lastH));
    check('an earlier point with no positions says so', pr.body.historical[0].source === 'NONE' && pr.body.historical[0].grossLoanPortfolio === null);
    check('the capital structure balances at each point', pr.body.historical.every((h) => round2(h.capitalStructure.assets - h.capitalStructure.liabilities - h.capitalStructure.equity) === 0),
      JSON.stringify(pr.body.historical.map((h) => h.capitalStructure)));
    const long = await call('GET', `/api/reports/portfolio?from=${orgDay(-400)}&to=${orgDay(0)}`);
    check('at most a year', long.status === 400 && /PERIOD_TOO_LONG/.test(long.reason));
    const daily = await call('GET', `/api/reports/portfolio?from=${orgDay(-3)}&interval=DAILY`);
    check('by day', daily.body.accounts.length === 4 && daily.body.historical[2].source === 'SNAPSHOT', JSON.stringify(daily.body.historical.map((h) => h.source)));

    const org = await call('GET', '/api/reports/organization');
    const eastRow = org.body.branches.find((b) => b.code === 'EAST');
    check('the organization report by branch', eastRow.members === 2 && eastRow.borrowers === 2 && eastRow.centres === 1 && eastRow.deposits === 25000, JSON.stringify(eastRow));
    const off = org.body.creditOfficers.find((o) => o.email === 'officer@rpt.local');
    check('and by credit officer', off && off.name === 'The officer' && off.members === 2 && off.loans === 2, JSON.stringify(org.body.creditOfficers));

    const earn = await call('GET', `/api/reports/earnings?from=${orgDay(-120)}&groupBy=PRODUCT`);
    const is = await call('GET', `/api/reports/income-statement?from=${orgDay(-120)}&to=${orgDay(0)}`);
    check('earnings add up to the income statement', earn.body.net === is.body.surplus && earn.body.totalRevenue === is.body.totalIncome, `${earn.body.net} vs ${is.body.surplus}`);
    check('by product', earn.body.groups.some((g) => g.key === 'LOAN:RP1' && g.label === 'Report loan' && g.totalRevenue > 0), JSON.stringify(earn.body.groups.map((g) => [g.key, g.totalRevenue])));
    const earnB = await call('GET', `/api/reports/earnings?from=${orgDay(-120)}&groupBy=BRANCH`);
    check('and by branch, to the same total', earnB.body.net === earn.body.net && earnB.body.groups.some((g) => g.key === 'EAST'));

    const cf = await call('GET', `/api/reports/cashflow?from=${orgDay(-120)}`);
    check('cashflow: principal disbursed and collected', cf.body.balanceChanges.principalDisbursed === 22000 && cf.body.balanceChanges.principalCollected > 0, JSON.stringify(cf.body.balanceChanges));
    check('the change in the portfolio is disbursed less collected and written off', cf.body.balanceChanges.changeInPortfolio === round2(22000 - cf.body.balanceChanges.principalCollected - cf.body.balanceChanges.principalWrittenOff));
    check('deposits received', cf.body.balanceChanges.deposits === 41000 && cf.body.balanceChanges.changeInDeposits === 41000, JSON.stringify(cf.body.balanceChanges));
    const repaidInterest = round2((await q1("SELECT COALESCE(SUM((allocation->>'interest')::numeric), 0) AS i FROM transactions WHERE kind = 'LOAN_REPAYMENT'")).i);
    check('interest collected is the repayments\' interest', cf.body.income.find((x) => x.code === 'LOAN_INTEREST').amount === repaidInterest && cf.body.currency === 'KES');

    const out = await call('GET', `/api/reports/outreach?from=${orgDay(-30)}`);
    check('outreach: clients, borrowers and savers by gender and branch', out.body.clients === 4 && out.body.femaleBorrowersPercent === round2(2 / 3 * 100) && out.body.joinedInPeriod === 4
      && out.body.byBranch.length === 2, JSON.stringify(out.body).slice(0, 300));
    const ox = await call('GET', '/api/reports/outreach?format=csv', null, { raw: true });
    check('every management report downloads', ox.status === 200 && /Female borrowers %/.test(ox.buffer.toString()));
    const tellerReport = await call('GET', '/api/reports/organization', null, { who: 'teller' });
    check('reports are for managers, accountants and auditors', tellerReport.status === 403);

    // ------------------------------------------------------------------------
    section('custom views');
    await call('POST', '/api/custom-fields/sets', { id: '_kyc', entity: 'MEMBER', name: 'KYC' });
    const cfd = await call('POST', '/api/custom-fields/definitions', { id: 'pep', setId: '_kyc', entity: 'MEMBER', name: 'PEP', type: 'CHECKBOX' });
    check('a custom field on members', cfd.status === 201, cfd.text);
    await T((c) => c.query(`UPDATE members SET custom_fields = '{"_kyc": {"pep": true}}' WHERE id = $1`, [m1.id]));
    const ents = await call('GET', '/api/views/entities', null, { who: 'teller' });
    check('a teller may view members, loans and deposits but not journal entries or activities', ents.body.some((e) => e.entity === 'LOANS') && !ents.body.some((e) => ['JOURNAL_ENTRIES', 'ACTIVITIES'].includes(e.entity)));
    const fields = await call('GET', '/api/views/fields/MEMBERS');
    check('the fields include custom fields, with their operators', fields.body.fields.some((x) => x.key === 'cf:_kyc.pep' && x.type === 'BOOLEAN') && fields.body.fields.find((x) => x.key === 'joinedOn').operators.includes('LAST_DAYS'));

    const arrears = await call('POST', '/api/views', {
      entity: 'LOANS', name: 'Loans in arrears', match: 'ALL',
      filters: [{ field: 'daysLate', operator: 'MORE_THAN', value: 0 }],
      columns: ['accountNo', 'memberName', 'branch', 'principalOutstanding', 'daysLate'], sortBy: 'daysLate', sortDir: 'DESC', includeTotals: true,
    }, { who: 'officer' });
    check('a user saves a view', arrears.status === 201 && arrears.body.owner === 'officer@rpt.local' && arrears.body.canEdit, arrears.text);
    const run = await call('GET', `/api/views/${arrears.body.id}/run`, null, { who: 'officer' });
    const lateIds = (await Rd((c) => PF.positions(c, {}))).rows.filter((r) => r.days_late > 0).map((r) => r.account_no).sort();
    check('it lists what its filter matches', run.body.items.map((x) => x.accountNo).sort().join() === lateIds.join() && run.body.total === lateIds.length, JSON.stringify(run.body.items));
    check('sorted as saved', run.body.items.every((x, i, a) => i === 0 || a[i - 1].daysLate >= x.daysLate));
    check('with totals over every row', run.body.totals.principalOutstanding === round2(run.body.items.reduce((s, x) => s + x.principalOutstanding, 0)) && run.body.totals.memberName === undefined);
    const shareTry = await call('PATCH', `/api/views/${arrears.body.id}`, { usageRights: { allUsers: true } }, { who: 'officer' });
    check('only an administrator gives usage rights', shareTry.status === 403 && /ONLY_AN_ADMINISTRATOR/.test(shareTry.reason));
    const hidden = await call('GET', `/api/views/${arrears.body.id}`, null, { who: 'manager' });
    check('another user cannot see it', hidden.status === 404);
    const adminSees = await call('GET', `/api/views/${arrears.body.id}`);
    check('an administrator can', adminSees.status === 200 && adminSees.body.canEdit);
    const shared = await call('PATCH', `/api/views/${arrears.body.id}`, { usageRights: { roles: ['MANAGER'] } });
    check('the administrator shares it with managers', shared.status === 200 && shared.body.usageRights.roles.includes('MANAGER'), shared.text);
    const mgr = await call('GET', `/api/views/${arrears.body.id}`, null, { who: 'manager' });
    check('a manager now sees it, and may not change it', mgr.status === 200 && mgr.body.canEdit === false
      && (await call('PATCH', `/api/views/${arrears.body.id}`, { name: 'Mine now' }, { who: 'manager' })).status === 403);
    check('a teller who is not the owner still does not', (await call('GET', `/api/views/${arrears.body.id}`, null, { who: 'teller' })).status === 404);
    const cp = await call('POST', `/api/views/${arrears.body.id}/copy`, { name: 'My arrears' }, { who: 'manager' });
    check('the manager copies it into a view of their own', cp.status === 201 && cp.body.owner === 'manager@rpt.local' && cp.body.usageRights.roles.length === 0, cp.text);
    const fav = await call('PUT', `/api/views/${cp.body.id}/favourite`, null, { who: 'manager' });
    const favs = await call('GET', '/api/views?favourites=true', null, { who: 'manager' });
    check('and marks it a favourite', fav.status === 200 && favs.body.length === 1 && favs.body[0].id === cp.body.id);
    const ren = await call('PATCH', `/api/views/${cp.body.id}`, { name: 'Loans in arrears' }, { who: 'manager' });
    check('names are per owner', ren.status === 200);

    const pep = await call('POST', '/api/views/run', {
      entity: 'MEMBERS', match: 'ANY', columns: ['memberNo', 'gender', 'cf:_kyc.pep', 'depositBalance', 'joinedOn'],
      filters: [{ field: 'cf:_kyc.pep', operator: 'EQUALS', value: true }, { field: 'memberNo', operator: 'STARTS_WITH', value: 'R0004' }], includeTotals: true,
    });
    check('a temporary view matching any of its filters, on a custom field too', pep.status === 200 && pep.body.items.map((x) => x.memberNo).sort().join() === [m1.member_no, m4.member_no].sort().join()
      && pep.body.items.find((x) => x.memberNo === m1.member_no)['cf:_kyc.pep'] === true && pep.body.totals.depositBalance === 21000, pep.text.slice(0, 400));
    const dates = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo'], filters: [{ field: 'joinedOn', operator: 'LAST_DAYS', value: 7 }, { field: 'gender', operator: 'IN', values: ['MALE'] }] });
    check('date and selection operators', dates.body.total === 2, dates.text.slice(0, 200));
    const srch = await call('POST', '/api/members:search', { filterCriteria: [{ field: 'joined_on', operator: 'TODAY' }] });
    check('the members search TODAY is the organization\'s today too', srch.status === 200 && srch.body.length === 4, srch.text.slice(0, 200));
    const between = await call('POST', '/api/views/run', { entity: 'DEPOSITS', columns: ['accountNo', 'balance'], filters: [{ field: 'balance', operator: 'BETWEEN', value: 5000, secondValue: 15000 }] });
    check('a range', between.body.total === 2);
    const inj = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo'], filters: [{ field: 'm.id); DROP TABLE members; --', operator: 'EQUALS', value: 'x' }] });
    const inj2 = await call('POST', '/api/views/run', { entity: 'MEMBERS', columns: ['memberNo'], filters: [{ field: 'memberNo', operator: 'EQUALS', value: "x' OR '1'='1" }] });
    check('a view names fields, never SQL, and values are parameters', inj.status === 400 && /UNKNOWN_FIELD/.test(inj.reason) && inj2.status === 200 && inj2.body.total === 0, `${inj.text} ${inj2.text}`);
    const badOp = await call('POST', '/api/views/run', { entity: 'MEMBERS', filters: [{ field: 'joinedOn', operator: 'STARTS_WITH', value: '2026' }] });
    check('an operator must suit the field', badOp.status === 400 && /OPERATOR_NOT_ALLOWED/.test(badOp.reason));
    const je = await call('POST', '/api/views/run', { entity: 'JOURNAL_ENTRIES', columns: ['glCode', 'debit', 'credit'], includeTotals: true });
    check('journal entries: the debits and credits total the same', je.status === 200 && je.body.totals.debit === je.body.totals.credit && je.body.totals.debit > 0, JSON.stringify(je.body.totals));
    const jeT = await call('POST', '/api/views/run', { entity: 'JOURNAL_ENTRIES', columns: ['glCode'] }, { who: 'teller' });
    check('but not for a teller', jeT.status === 403);
    const act = await call('POST', '/api/views/run', { entity: 'ACTIVITIES', columns: ['createdAt', 'action'], includeTimestamp: true, filters: [{ field: 'createdAt', operator: 'TODAY' }] });
    check('activities today, with the time when asked', act.status === 200 && act.body.total > 0 && /T\d\d:\d\d:\d\dZ$/.test(act.body.items[0].createdAt), act.text.slice(0, 200));

    const vx = await call('GET', `/api/views/${arrears.body.id}/export?format=xlsx`, null, { who: 'officer', raw: true });
    const vrows = XLSX.read(vx.buffer)[0].rows;
    check('a view exports to Excel with its totals', vx.status === 200 && vrows.some((r) => r[0] === 'View' && r[1] === 'Loans in arrears') && vrows[vrows.length - 1][0] === 'Total', JSON.stringify(vrows.slice(-2)));

    section('custom views with the API (the reference platform API v1)');
    const vf = await call('GET', `/api/loans?viewfilter=${arrears.body.id}`, null, { who: 'officer' });
    check('?viewfilter= on the loans list returns what the view matches', vf.status === 200 && vf.body.length === lateIds.length && vf.headers.get('items-total') === String(lateIds.length) && vf.body[0].accountNo, vf.text.slice(0, 200));
    const vs = await call('GET', `/api/loans?viewfilter=${arrears.body.id}&resultType=SUMMARY`, null, { who: 'officer' });
    check('resultType=SUMMARY: the count and the column totals', vs.body.count === lateIds.length && vs.body.totals.principalOutstanding === run.body.totals.principalOutstanding, vs.text);
    const vd = await call('GET', `/api/loans?viewfilter=${arrears.body.id}&resultType=FULL_DETAILS`, null, { who: 'officer' });
    check('resultType=FULL_DETAILS: the whole records', vd.body.length === lateIds.length && vd.body[0].account_no && vd.body[0].principal_disbursed !== undefined, vd.text.slice(0, 200));
    const wrong = await call('GET', `/api/members?viewfilter=${arrears.body.id}`, null, { who: 'officer' });
    check('a loans view on the members list is refused', wrong.status === 400 && /VIEW_IS_FOR_LOANS/.test(wrong.reason), wrong.text);
    const plain = await call('GET', '/api/loans?limit=2', null, { who: 'officer' });
    check('without the parameter the list is as it was', plain.status === 200 && Array.isArray(plain.body));
    const lt = await call('GET', '/api/loans/transactions');
    check('/loans/transactions exists for views only', lt.status === 400 && /VIEWFILTER_REQUIRED/.test(lt.reason));
    const repView = await call('POST', '/api/views', { entity: 'LOAN_TRANSACTIONS', name: 'Repayments', filters: [{ field: 'kind', operator: 'EQUALS', value: 'LOAN_REPAYMENT' }], columns: ['reference', 'amount', 'principal', 'interest'] });
    const ltv = await call('GET', `/api/loans/transactions?viewfilter=${repView.body.id}`);
    check('and lists the transactions a view matches', ltv.status === 200 && ltv.body.length === 2 && ltv.body.every((x) => x.amount > 0), ltv.text.slice(0, 200));
    const uv = await call('GET', '/api/users/me/views?for=LOANS', null, { who: 'manager' });
    check('GET /users/{user}/views?for= lists the views a user can see, of one kind', uv.status === 200 && uv.body.length === 2 && uv.body.every((x) => x.type === 'LOANS' && x.encodedKey), uv.text.slice(0, 300));
    const uvOther = await call('GET', '/api/users/officer@rpt.local/views', null, { who: 'manager' });
    const uvAdmin = await call('GET', '/api/users/officer@rpt.local/views?for=LOANS');
    check('another user\'s views only for an administrator', uvOther.status === 403 && uvAdmin.status === 200 && uvAdmin.body.some((x) => x.name === 'Loans in arrears'));
    const del = await call('DELETE', `/api/views/${arrears.body.id}`, null, { who: 'manager' });
    const del2 = await call('DELETE', `/api/views/${arrears.body.id}`, null, { who: 'officer' });
    check('only the owner or an administrator deletes a view', del.status === 403 && del2.status === 200);

    // ------------------------------------------------------------------------
    section('structure');
    const dict = await Rd((c) => DD.build(c));
    check('the dictionary describes the new columns and tables', dict.missing.length === 0, dict.missing.join(', '));
    const same = await Rd((c) => R.portfolioAtRisk(c, {}));
    check('the PAR report and the portfolio module are the same figures', same.totalOutstanding === parT.body.totalOutstanding);
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
