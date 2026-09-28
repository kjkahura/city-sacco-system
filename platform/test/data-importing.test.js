#!/usr/bin/env node
'use strict';

/**
 * Data importing, after the reference platform's Data Importing pages: the Excel Migration
 * Template in the reference platform's own layout, loan states, schedules and transactions,
 * deposit overdrafts, the chart of accounts with signed balances, the
 * background run with progress and a preview, the reference platform's data import API with
 * idempotent actions, the external loan migration API, and loading a backup
 * into a database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const { signToken } = require('../src/tenancy/resolve');
const SV = require('../src/domain/savings');
const DD = require('../src/domain/dataDictionary');
const XLSX = require('../src/lib/xlsx');
const { unzip } = require('../src/lib/zip');
const L = require('../src/domain/loans');
const F = require('../src/domain/fees');
const LM = require('../src/domain/loanMigration');
const backup = require('../src/ops/tenantBackup');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'dataimp';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4106;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const q1 = (sql, params = []) => Rd(async (c) => (await c.query(sql, params)).rows[0]);
const qa = (sql, params = []) => Rd(async (c) => (await c.query(sql, params)).rows);
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sheet = (name, rows) => ({ name, rows });
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const upload = (book, name = 'import.xlsx') => call('POST', '/api/data-imports?wait=true', null, { binary: book, headers: { 'x-file-name': name } });
async function poll(p, done, tries = 200) {
  let r;
  for (let i = 0; i < tries; i += 1) {
    r = await call('GET', p);
    if (done(r)) return r;
    await sleep(50);
  }
  return r;
}

// The reference platform's own template layout and formats.
const CLIENTS = ['Client ID', 'First Name', 'Last Name', 'Gender (M/F)', 'Date Joined (dd.MM.yyyy)', 'Mobile/Cellphone', 'Phone', 'Branch ID',
  'Centre ID', 'Credit Officer username', 'Individual Loan Cycle', 'ID Type', 'ID Number', 'ID Authority', 'ID Valid Until (dd.MM.yyyy)', 'Custom: _kyc.pep (PEP)'];
const LOANS = ['Account ID', 'Client ID', 'Client Type', 'Product ID', 'Date Applied (dd.MM.yyyy)', 'Date Approved (dd.MM.yyyy)', 'Date Disbursed (dd.MM.yyyy)',
  'Repayment Start Date (dd.MM.yyyy)', '# Grace Installments', 'Loan Length (# Installments)', 'Repayment Frequency:', 'Repayment Period (D/W/M/Y):',
  'Principal Interval:', 'Interest Rate', 'Loan Amount', 'Principal paid', 'Interest outstanding', 'Account State', 'Closed on'];
function templateWorkbook() {
  return XLSX.write([
    sheet('Settings', [['Setting', 'Value'], ['Migration date', '30.06.2026']]),
    sheet('Branches', [['Branch ID*', 'Name*'], ['EAST', 'East branch']]),
    sheet('Centres', [['Centre ID', 'Branch ID', 'Name', 'Meeting Day', 'Address 1', 'City'], ['C1', 'EAST', 'East centre', 'TH', 'Plot 4', 'Embu']]),
    sheet('Clients', [CLIENTS,
      ['MA1', 'Akinyi', 'Otieno', 'F', '01.02.2019', '0711000001', '0202000001', 'EAST', 'C1', 'officer@dataimp.local', 2, 'National ID', '12345678', 'Registrar', '31.12.2030', 'True'],
      ['MB1', 'Baraka', 'Mwangi', 'M', '15.03.2020', '0711000002', null, 'EAST', null, null, 0, null, null, null, null, 'False'],
      ['MC1', 'Chebet', 'Kirui', 'F', '10.10.2021', '0711000003', null, 'EAST', null, null, null, null, null, null, null, null]]),
    sheet('Savings Accounts', [['Account ID', 'Client ID', 'Product ID', 'Date Applied (dd.MM.yyyy)', 'Date Approved (dd.MM.yyyy)', 'Overdraft Interest Rate',
      'Overdraft Limit', 'Overdraft Amount Due', 'Overdraft Interest Due', 'Overdraft Fees Due', 'Current Balance', 'Notes'],
    ['SA1', 'MA1', 'SAV01', '20.01.2019', '01.02.2019', null, null, null, null, null, 5000, 'Main savings'],
    ['SA2', 'MB1', 'SAV01', '10.03.2020', '15.03.2020', 24, 1000, 300, 15, 5, 0, null]]),
    sheet('Loan Accounts', [LOANS,
      ['LN1', 'MA1', 'C', 'IMP', '01.03.2026', '10.03.2026', '15.03.2026', '15.04.2026', 0, 3, 1, 'M', 1, 1, 3000, 1000, 20, 'Active', null],
      ['LN2', 'MA1', 'C', 'IMP', '01.01.2025', '05.01.2025', '10.01.2025', null, null, 2, 1, 'M', 1, 1, 1000, 1000, null, 'Closed', '15.03.2025'],
      ['LN3', 'MB1', 'C', 'IMP', '20.05.2025', '25.05.2025', '01.06.2025', null, null, 4, 1, 'M', 1, 1, 2000, 500, 100, 'Written Off', '31.01.2026'],
      ['LN4', 'MB1', 'C', 'IMP', '20.06.2026', null, null, null, null, 6, 1, 'M', 1, 1, 5000, null, null, 'Pending Approval', null],
      ['LN5', 'MC1', 'C', 'IMP', '05.01.2026', '08.01.2026', '10.01.2026', null, null, 12, 1, 'M', 1, 1, 12000, null, null, 'Active', null],
      ['LN6', 'MC1', 'C', 'IMP', '01.02.2026', null, null, null, null, 2, 1, 'M', 1, 1, 800, null, null, 'Withdrawn', '05.02.2026']]),
    sheet('Loan Schedules', [['Account ID', 'Due Date', 'Principal Expected', 'Interest Expected', 'Fees Expected', 'Penalty Expected'],
      ['LN1', '15.04.2026', 1000, 30, 50, 0], ['LN1', '15.05.2026', 1000, 20, 50, 0], ['LN1', '15.07.2026', 1000, 10, 50, 0]]),
    sheet('Loan Transactions', [['Account ID', 'Transaction Type', 'Date', 'Amount', 'Notes'],
      ['LN5', 'DISBURSEMENT', '10.01.2026', 12000, 'Opening'], ['LN5', 'REPAYMENT', '10.02.2026', 1120, null],
      ['LN5', 'REPAYMENT', '12.03.2026', 1120, null], ['LN5', 'FEE', '01.04.2026', 100, 'Statement fee'],
      ['LN5', 'PENALTY', '15.04.2026', 20, null], ['LN5', 'REPAYMENT', '20.04.2026', 1240, null]]),
    sheet('Chart of Accounts', [['GL Code', 'Account Name', 'Date (dd.MM.yyyy)', 'Type (A/L/I/E/Q)', 'Usage (D/H)', 'Balance', 'Notes'],
      ['100-100', 'Loan Portfolio', '30.06.2026', 'A', 'D', 11000, null],
      ['100-300', 'Interest Receivable', '30.06.2026', 'A', 'D', 340, null],
      ['100-310', 'Fees Receivable', '30.06.2026', 'A', 'D', 50, null],
      ['100-400', 'Overdraft Portfolio', '30.06.2026', 'A', 'D', 300, null],
      ['100-250', 'Old bank account', '30.06.2026', 'A', 'D', 2000, 'Closed after migration'],
      ['200-100', 'Member Deposits', '30.06.2026', 'L', 'D', 5000, null],
      ['300-200', 'Retained Earnings', '30.06.2026', 'Q', 'D', 8690, null]]),
  ]);
}

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Import SACCO', mfaRequiredRoles: [], adminEmail: 'admin@dataimp.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@dataimp.local', password: PASSWORD }, { auth: null })).body.accessToken;
    check('admin signed in', !!token);
    const obr = await call('POST', '/api/branches', { code: 'OFC', name: 'Officers' });
    const officer = await call('POST', '/api/users', { email: 'officer@dataimp.local', fullName: 'Loan Officer', role: 'TELLER', password: 'Imports pass 2026', userType: 'CREDIT_OFFICER', branchId: obr.body.id });
    check('a credit officer to assign members to', officer.status === 201, officer.text);
    const base = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200', glInterestRec: '100-300', glFeeRec: '100-310',
      glPenaltyInc: '400-200', glPenaltyRec: '100-320', accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', enforceDepositMultiplier: false, maxTerm: 36, monthlyRate: 1 };
    const imp = await call('POST', '/api/loan-products', { ...base, id: 'IMP', name: 'Imported', productType: 'FIXED_TERM', method: 'FLAT', penaltyBasis: 'OVERDUE_PRINCIPAL', penaltyRate: 0.1 });
    const late = await call('POST', '/api/loan-products/IMP/fees', { code: 'LATE', name: 'Late fee', feeType: 'LATE_REPAYMENT', calculation: 'FLAT', amount: 25 });
    const dyn = await call('POST', '/api/loan-products', { ...base, id: 'DYN', name: 'Dynamic', productType: 'DYNAMIC_TERM', method: 'REDUCING' });
    check('loan products', imp.status === 201 && late.status === 201 && dyn.status === 201, `${imp.text} ${dyn.text}`);
    await T((c) => c.query(`UPDATE savings_products SET allow_overdraft = true, max_overdraft_limit = 5000, overdraft_annual_rate = 18,
      gl_od_portfolio = '100-400', gl_od_interest_inc = '400-300' WHERE id = 'SAV01'`));
    const idt = await call('POST', '/api/id-templates', { id: 'NID', idType: 'National ID', issuingAuthority: 'Registrar of Persons', mask: '########' });
    await call('POST', '/api/custom-fields/sets', { entity: 'MEMBER', name: 'KYC', id: '_kyc' });
    const cf = await call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_kyc', id: 'pep', name: 'PEP', type: 'CHECKBOX' });
    check('an ID template and a checkbox custom field', idt.status === 201 && cf.status === 201, `${idt.text} ${cf.text}`);

    // ---------------------------------------------------------------------
    section('the upload runs in the background, with progress');
    const book = templateWorkbook();
    const queued = await call('POST', '/api/data-imports', null, { binary: book, headers: { 'x-file-name': 'reference-layout.xlsx' } });
    check('an upload returns at once, QUEUED', queued.status === 202 && queued.body.status === 'QUEUED' && queued.body.progress === 0, queued.text);
    const seen = new Set();
    const done = await poll(`/api/data-imports/${queued.body.id}`, (r) => { seen.add(r.body.status); return !['QUEUED', 'IN_PROGRESS'].includes(r.body.status); });
    const d = done.body;
    check('and moves through IN_PROGRESS to its outcome, at 100%', d.progress === 100 && !!d.started_at && !!d.finished_at && (seen.has('IN_PROGRESS') || seen.has('QUEUED') || d.status),
      `${[...seen].join(',')} ${d.progress}`);
    check('the reference platform\'s layout imports cleanly: Clients, Savings Accounts, Loan Schedules, Chart of Accounts, dd.MM.yyyy, M/F, TH',
      d.status === 'PENDING_APPROVAL' && d.import_state === 'DRAFT' && d.as_of === '2026-06-30', JSON.stringify(d.errors).slice(0, 800));
    const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o || {}).sort()));
    check('the review says what it will create',
      sorted(d.summary.creates) === sorted({ glAccounts: 1, branches: 1, centres: 1, members: 3, groups: 0, groupMembers: 0, deposits: 2, shares: 0, loans: 6, installments: 21, transactions: 6, openingEntryLines: 7 }),
      JSON.stringify(d.summary.creates));
    check('the subledgers match the chart of accounts, so no warnings', d.warnings.length === 0, JSON.stringify(d.warnings));

    section('the preview: the records as they will be, before any exist');
    const kinds = await call('GET', `/api/data-imports/${d.id}/preview`);
    check('by kind, with counts', kinds.body.kinds.members === 3 && kinds.body.kinds.loans === 6 && kinds.body.kinds.deposits === 2, JSON.stringify(kinds.body));
    const pl = await call('GET', `/api/data-imports/${d.id}/preview?kind=loans&limit=10`);
    const p5 = pl.body.items.find((x) => x.accountNo === 'LN5');
    check('a loan with its state, balances, arrears and schedule',
      p5 && p5.status === 'IN_ARREARS' && p5.principalOutstanding === 9000 && p5.interestOutstanding === 320 && p5.schedule.length === 12,
      JSON.stringify(p5).slice(0, 300));
    const pm = await call('GET', `/api/data-imports/${d.id}/preview?kind=members&offset=0&limit=1`);
    check('paged', pm.body.total === 3 && pm.body.items.length === 1 && pm.body.items[0].memberNo === 'MA1' && pm.body.items[0].idDocuments[0] === 'National ID 12345678');
    check('and still nothing in the live tables', (await q1("SELECT count(*)::int AS n FROM members WHERE member_no IN ('MA1','MB1','MC1')")).n === 0);

    section('approval creates it, as the preview showed');
    const ap = await call('POST', `/api/data-imports/${d.id}/approve`, { note: 'checked' });
    check('approved', ap.status === 200 && ap.body.status === 'APPROVED', ap.text.slice(0, 400));
    const ma = await q1("SELECT * FROM members WHERE member_no = 'MA1'");
    check('the reference platform\'s client headings land in the right fields', ma.phone === '0711000001' && ma.phone2 === '0202000001' && ma.gender === 'FEMALE'
      && ma.joined_on === '2019-02-01' && ma.prior_loan_cycles === 2 && ma.credit_officer === 'officer@dataimp.local', JSON.stringify(ma));
    check('a checkbox custom field from True', ma.custom_fields?._kyc?.pep === true, JSON.stringify(ma.custom_fields));
    const doc = await q1('SELECT * FROM member_identifications WHERE member_id = $1', [ma.id]);
    check('the ID document, against its template', doc && doc.template_id === 'NID' && doc.document_id === '12345678' && doc.valid_until === '2030-12-31', JSON.stringify(doc));
    const c1 = await q1("SELECT * FROM centres WHERE code = 'C1'");
    check('a centre meeting on TH is Thursday, with its address joined', c1.meeting_day === 4 && c1.address === 'Plot 4, Embu');

    const loan = (no) => q1('SELECT * FROM loan_accounts WHERE account_no = $1', [no]);
    const inst = (id) => qa('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id]);
    const l1 = await loan('LN1');
    const i1 = await inst(l1.id);
    check('a schedule without paid columns takes what the account says was paid, oldest first',
      i1[0].status === 'PAID' && i1[1].principal_paid === 0 && i1[2].principal_paid === 0 && L.principalOutstanding(l1) === 2000 && l1.status === 'IN_ARREARS',
      i1.map((x) => `${x.status}:${x.principal_paid}`).join(' '));
    check('installment numbers follow the due dates', i1.map((x) => x.due_date).join(',') === '2026-04-15,2026-05-15,2026-07-15');
    const f1 = await qa("SELECT * FROM loan_fees WHERE loan_id = $1 ORDER BY applied_on", [l1.id]);
    check('fees on installments due by the migration date are recorded as applied, the paid one paid',
      f1.length === 2 && f1.every((x) => x.fee_type === 'PAYMENT_DUE') && f1[0].status === 'PAID' && f1[1].status === 'DUE' && l1.fees_due === 100 && l1.fees_paid === 50,
      JSON.stringify(f1.map((x) => [x.status, x.amount, x.paid])));
    const again = await T(async (c) => F.applyPaymentDueFees(c, await L.lock(c, l1.id), '2026-07-01'));
    check('so the end of day does not charge them again (the defect fixed)', again === 0 && (await loan('LN1')).fees_due === 100, String(again));
    const later = await T(async (c) => F.applyPaymentDueFees(c, await L.lock(c, l1.id), '2026-07-20'));
    check('and the fee on a later installment comes due on its date in the ordinary way', later === 1 && (await loan('LN1')).fees_due === 150, String(later));
    check('the repayment start date is kept', l1.first_repayment_date === '2026-04-15' && l1.applied_on === '2026-03-01' && l1.approved_on === '2026-03-10');

    const l5 = await loan('LN5');
    const i5 = await inst(l5.id);
    check('transactions are replayed: three installments paid, the fee and penalty on the third',
      i5.slice(0, 3).every((x) => x.status === 'PAID') && i5[2].fee_due === 100 && i5[3].principal_paid === 0 && L.principalOutstanding(l5) === 9000,
      i5.slice(0, 4).map((x) => `${x.status}:${x.principal_paid}/${x.fee_due}`).join(' '));
    check('interest is what the schedule earned by the migration date, less what was paid',
      l5.interest_accrued === 680 && l5.interest_paid === 360 && l5.penalty_accrued === 20 && l5.penalty_paid === 20 && l5.fees_paid === 100,
      JSON.stringify({ a: l5.interest_accrued, p: l5.interest_paid, pen: l5.penalty_accrued, pp: l5.penalty_paid, fp: l5.fees_paid }));
    check('in arrears from its oldest late installment, though three installments were repaid (the arrears defect fixed)', l5.status === 'IN_ARREARS' && l5.arrears_since === i5[3].due_date, `${l5.status} ${l5.arrears_since}`);
    const tx5 = await qa('SELECT kind, amount, entry_id, value_date, allocation FROM transactions WHERE loan_account_id = $1 ORDER BY value_date, created_at', [l5.id]);
    check('each transaction is in the loan\'s history, with no journal entry',
      tx5.map((x) => x.kind).join(',') === 'LOAN_DISBURSEMENT,LOAN_REPAYMENT,LOAN_REPAYMENT,LOAN_FEE,LOAN_REPAYMENT' && tx5.every((x) => x.entry_id === null && x.allocation.imported),
      tx5.map((x) => x.kind).join(','));
    check('the last repayment split penalty, fee, interest, principal in the product\'s order',
      JSON.stringify(tx5[4].allocation) .includes('"penalty":20') && tx5[4].allocation.fee === 100 && tx5[4].allocation.interest === 120 && tx5[4].allocation.principal === 1000);
    const pen5 = await qa('SELECT * FROM penalty_charges WHERE loan_id = $1 ORDER BY charged_on', [l5.id]);
    check('the penalty is brought across as imported; the late installments get their markers',
      pen5.some((x) => x.imported && x.amount === 20 && x.charged_on === '2026-04-15') && pen5.filter((x) => x.forfeited && x.charged_on === '2026-06-30').length === 2,
      JSON.stringify(pen5.map((x) => [x.charged_on, x.amount, x.imported, x.forfeited])));
    const l2 = await loan('LN2');
    check('a closed loan is history: repaid, and a completed cycle', l2.status === 'CLOSED_REPAID' && l2.closed_on === '2025-03-15' && L.principalOutstanding(l2) === 0);
    const hist = await call('GET', `/api/members/${ma.id}/loan-history`);
    check('completed cycles count the old system\'s and the imported closed loan', hist.body.completedLoanCycles === 3, JSON.stringify(hist.body.completedLoanCycles));
    const l3 = await loan('LN3');
    check('a written-off loan', l3.status === 'CLOSED_WRITTEN_OFF' && l3.written_off_amount === 1600 && l3.written_off_on === '2026-01-31', JSON.stringify([l3.status, l3.written_off_amount]));
    const l4 = await loan('LN4');
    const l6 = await loan('LN6');
    check('a pending application and a withdrawn one', l4.status === 'PENDING_APPROVAL' && l4.applied_on === '2026-06-20' && l6.status === 'CLOSED_WITHDRAWN' && l6.closed_on === '2026-02-05');
    check('neither has a schedule', (await inst(l4.id)).length === 0 && (await inst(l6.id)).length === 0);

    const sa1 = await q1("SELECT * FROM savings_accounts WHERE account_no = 'SA1'");
    const sa2 = await q1("SELECT * FROM savings_accounts WHERE account_no = 'SA2'");
    check('a deposit account with the dates it was applied for and opened, and notes', sa1.balance === 5000 && sa1.applied_on === '2019-01-20' && sa1.opened_on === '2019-02-01' && sa1.notes === 'Main savings');
    check('an overdrawn one: the balance is what is owed, interest and fees due kept for cash accounting',
      sa2.balance === -320 && sa2.overdraft_limit === 1000 && sa2.od_interest_due === 15 && sa2.od_fees_due === 5 && sa2.overdraft_rate === 24, JSON.stringify(sa2));
    check('interest runs from the migration date', sa1.accrued_through === '2026-06-30' && sa1.period_started_on === '2026-07-01');
    const rate = await T(async (c) => (await SV.lock(c, sa2.id)).overdraft_annual_rate);
    check('the account\'s own overdraft rate is the one used', Number(rate) === 24, String(rate));
    const entry = await qa("SELECT l.gl_code, l.direction, l.amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_type = 'DATA_IMPORT' ORDER BY l.line_no");
    check('the chart of accounts balances, signed by type, are the opening entry',
      entry.length === 7 && entry.some((x) => x.gl_code === '200-100' && x.direction === 'CREDIT' && x.amount === 5000)
      && entry.some((x) => x.gl_code === '100-250' && x.direction === 'DEBIT' && x.amount === 2000), JSON.stringify(entry));
    check('and its new account is created, with its notes', (await q1("SELECT * FROM gl_accounts WHERE code = '100-250'")).notes === 'Closed after migration');

    // ---------------------------------------------------------------------
    section('what the template refuses, sheet by sheet');
    const bad = XLSX.write([
      sheet('Settings', [['Setting', 'Value'], ['Migration date', '30.06.2026']]),
      sheet('Groups', [['Group ID', 'Group Name'], ['G1', 'Wanawake']]),
      sheet('Clients', [['Client ID', 'First Name', 'Last Name'], ['X'.repeat(40), 'Long', 'Id'], ['XD1', 'N'.repeat(300), 'Name']]),
      sheet('Loan Accounts', [['Account ID', 'Client ID', 'Client Type', 'Product ID', 'Loan Amount', 'Loan Length', 'Date Disbursed', 'Principal outstanding', 'Account State', 'Principal Interval'],
        ['XL1', 'MA1', 'G', 'IMP', 1000, 2, '01.01.2026', 500, 'Active', null],
        ['XL3', 'MA1', 'C', 'IMP', 1000, 2, '01.01.2026', 500, 'Active', 2],
        ['XL4', 'MA1', 'C', 'IMP', 1000, 2, '01.01.2026', 100, 'Closed', null],
        ['XL5', 'MA1', 'C', 'IMP', 1000, 2, null, null, 'Active', null],
        ['XL6', 'MA1', 'C', 'IMP', 1000, 2, null, null, 'Active', null],
        ['XL7', 'MA1', 'C', 'IMP', 1000, 2, null, null, 'Active', null]]),
      sheet('Loan Transactions', [['Account ID', 'Transaction Type', 'Date', 'Amount'],
        ['XL5', 'REPAYMENT', '01.02.2026', 100], ['XL5', 'DISBURSEMENT', '05.02.2026', 1000],
        ['XL6', 'DISBURSEMENT', '10.01.2026', 1000], ['XL7', 'DISBURSEMENT', '10.01.2026', 1000],
        ['XL6', 'REPAYMENT', '10.03.2026', 100], ['XL6', 'REPAYMENT', '10.02.2026', 100]]),
      sheet('Chart of Accounts', [['GL Code', 'Account Name', 'Date', 'Type', 'Usage', 'Balance'], ['100-260', 'Other bank', '31.05.2026', 'A', 'D', 10]]),
      sheet('GL Balances', [['GL code', 'Debit', 'Credit'], ['100-200', 10, null], ['300-200', null, 10]]),
    ]);
    const b1 = await upload(bad, 'bad.xlsx');
    const m1 = b1.body.errors.map((e) => `${e.sheet}:${e.row}:${e.message}`);
    const has = (re) => m1.some((m) => re.test(m));
    check('INVALID', b1.body.status === 'INVALID', b1.text.slice(0, 200));
    check('groups are imported now: the Groups sheet is not refused as a whole', !has(/Groups are not imported/), m1.join(' | '));
    check('an ID over 32 characters', has(/^Clients:2:Member number is longer than 32 characters/));
    check('text over 255 characters', has(/^Clients:3:First name is longer than 255 characters/));
    check('a group loan is no longer refused for being a group loan', !has(/Group loans are not imported/), m1.join(' | '));
    check('a principal interval other than 1', has(/^Loan Accounts:3:Principal paid less often/));
    check('a closed loan that still owes', has(/^Loan Accounts:4:A closed loan owes nothing/));
    check('transactions that do not start with the disbursement', has(/^Loan Accounts:5:.*start with its DISBURSEMENT/));
    check('transactions out of date order', has(/^Loan Accounts:6:Transactions must be in date order/));
    check('a loan\'s transactions not kept together', has(/^Loan Transactions:6:The transactions of XL6 must be together/));
    check('balances on both opening-balance sheets', has(/Give the opening balances on the Chart of Accounts sheet or on GL Balances, not both/));
    check('a balance date that is not the migration date', has(/^Chart of Accounts:2:The balances are at the migration date/));
    const ef = await call('GET', `/api/data-imports/${b1.body.id}/errors`, null, { raw: true });
    const efBook = XLSX.read(ef.buffer);
    const efFiles = unzip(ef.buffer);
    const clientsXml = efFiles.get(`xl/worksheets/sheet${efBook.findIndex((x) => x.name === 'Clients') + 1}.xml`).toString();
    check('the error workbook marks the offending cell red, and lists the errors last',
      /<c r="A2" s="6"/.test(clientsXml) && /<c r="B3" s="6"/.test(clientsXml) && efBook[efBook.length - 1].name === 'Errors', clientsXml.slice(0, 300));

    const dbBad = XLSX.write([
      sheet('Settings', [['Setting', 'Value'], ['Migration date', '2026-06-30']]),
      sheet('Members', [['Member number', 'First name', 'Last name', 'Credit officer', 'ID type', 'ID number'],
        ['XB1', 'Bad', 'Officer', 'nobody@dataimp.local', null, null], ['XC1', 'Bad', 'Idnum', null, 'National ID', '12AB']]),
      sheet('Loan Accounts', [['Account number', 'Member number', 'Product ID', 'Principal', 'Installments', 'Disbursed on', 'Principal outstanding', 'Repayment period'],
        ['XW1', 'MA1', 'IMP', 1000, 2, '2026-01-01', 500, 'W'],
        ['XDY', 'MA1', 'DYN', 1000, 2, '2026-01-01', 500, null],
        ['XTX', 'MB1', 'IMP', 1000, 2, null, null, null]]),
      sheet('Loan Schedule', [['Account number', 'Installment', 'Due date', 'Principal due', 'Interest due', 'Principal paid'],
        ['XDY', 1, '2026-02-01', 500, 10, 500], ['XDY', 2, '2026-03-01', 500, 5, 0]]),
      sheet('Loan Transactions', [['Account number', 'Transaction type', 'Date', 'Amount'], ['XTX', 'DISBURSEMENT', '2026-01-10', 1000], ['XTX', 'REPAYMENT', '2026-02-10', 5000]]),
      sheet('Chart of Accounts', [['GL Code', 'Account Name', 'Type'], ['400-100', 'Interest Income on Loans', 'A']]),
    ]);
    const b2 = await upload(dbBad, 'db-bad.xlsx');
    const m2 = b2.body.errors.map((e) => `${e.sheet}:${e.row}:${e.message}`);
    const has2 = (re) => m2.some((m) => re.test(m));
    check('what only the database can refuse is found at upload', b2.body.status === 'INVALID', m2.join(' | '));
    check('a credit officer who is not a user', has2(/^Members:2:Credit officer nobody@dataimp.local is not an active user/), m2.join(' | '));
    check('an ID number that does not fit its template', has2(/^Members:3:.*DOES NOT MATCH THE TEMPLATE/i), m2.join(' | '));
    check('a repayment period other than the product\'s', has2(/^Loan Accounts:2:Product IMP repays every 1 months; the loan says every 1 weeks/), m2.join(' | '));
    check('a schedule for a dynamic-term loan', has2(/^Loan Accounts:3:A dynamic-term loan's schedule is worked out by the product/), m2.join(' | '));
    check('a repayment of more than was owed', has2(/^Loan Accounts:4:The repayment of 5000 on 2026-02-10 is .* more than the loan owed/), m2.join(' | '));
    check('an account whose type differs from the chart', has2(/^Chart of Accounts:2:GL account 400-100 is INCOME in the chart of accounts, not ASSET/), m2.join(' | '));

    // ---------------------------------------------------------------------
    section('the reference platform\'s data import API');
    const boundary = 'XXsaccoXX';
    const form = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="api.xlsx"\r\nContent-Type: ${XLSX_TYPE}\r\n\r\n`),
      XLSX.write([sheet('Settings', [['Setting', 'Value'], ['Migration date', '30.06.2026']]),
        sheet('Clients', [['Client ID', 'First Name', 'Last Name'], ['API1', 'Api', 'Member']])]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const post = await call('POST', '/api/data/import', null, { binary: form, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    check('POST /data/import takes the workbook as the form field "file" and answers { importKey, state }',
      post.status === 200 && !!post.body.importKey && ['QUEUED', 'IN_PROGRESS'].includes(post.body.state), post.text);
    const st = await poll(`/api/data/import/${post.body.importKey}`, (r) => r.body.state === 'COMPLETE' || r.body.state === 'ERROR');
    check('GET /data/import/{importKey} reports COMPLETE with the event to act on', st.body.state === 'COMPLETE' && st.body.eventKey === post.body.importKey && st.body.importState === 'DRAFT', st.text);
    const idem = { 'idempotency-key': 'reject-api-1' };
    const rej = await call('POST', `/api/data/import/events/${st.body.eventKey}:action`, { action: 'REJECT' }, { headers: idem });
    check('POST /data/import/events/{eventKey}:action rejects it: Reverted', rej.status === 200 && rej.body.importState === 'REVERTED', rej.text);
    const rej2 = await call('POST', `/api/data/import/events/${st.body.eventKey}:action`, { action: 'REJECT' }, { headers: idem });
    check('sent again with the same Idempotency-Key, the same answer rather than an error', rej2.status === 200 && rej2.body.importState === 'REVERTED', rej2.text);
    const rej3 = await call('POST', `/api/data/import/events/${st.body.eventKey}:action`, { action: 'APPROVE' }, { headers: idem });
    check('the same key on a different request is refused', rej3.status === 409 && /IDEMPOTENCY_KEY_REUSED/.test(rej3.reason), rej3.text);
    check('without a key, acting on a reverted import is refused', (await call('POST', `/api/data/import/events/${st.body.eventKey}:action`, { action: 'REJECT' })).status === 409);
    const badPost = await call('POST', '/api/data/import', null, { binary: bad });
    const badSt = await poll(`/api/data/import/${badPost.body.importKey}`, (r) => r.body.state === 'COMPLETE' || r.body.state === 'ERROR');
    const e0 = badSt.body.errors.find((x) => x.sheet === 'Clients' && x.row === 2);
    check('errors in the reference platform\'s shape: sheet, row, column { name, index }, errorMessage',
      badSt.body.state === 'COMPLETE' && badSt.body.eventKey === null && e0 && e0.column.name === 'Member number' && e0.column.index === 0 && /32 characters/.test(e0.errorMessage),
      JSON.stringify(e0));
    const up = await call('POST', '/api/data/import', null, { binary: XLSX.write([sheet('Settings', [['Setting', 'Value'], ['Migration date', '30.06.2026']]),
      sheet('Clients', [['Client ID', 'First Name', 'Last Name'], ['API2', 'Api', 'Two']])]) });
    const st2 = await poll(`/api/data/import/${up.body.importKey}`, (r) => r.body.state === 'COMPLETE');
    const apv = await call('POST', `/api/data/import/events/${st2.body.eventKey}:action`, { action: 'APPROVE' }, { headers: { 'idempotency-key': 'approve-api-2' } });
    check('and approves one', apv.status === 200 && apv.body.importState === 'APPROVED' && (await q1("SELECT count(*)::int AS n FROM members WHERE member_no = 'API2'")).n === 1, apv.text);
    const { rows: [adm] } = await pool.query("SELECT id FROM platform.users WHERE email = 'admin@dataimp.local'");
    // A real staff user of the role: the role a request carries is read from the database, not the token.
    const staff = async (email, role) => (await pool.query(
      `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role)
       SELECT id, $2, 'x', $3, $4 FROM platform.tenants WHERE slug = $1 RETURNING id`, [SLUG, email, role.toLowerCase(), role])).rows[0].id;
    const teller = signToken({ sub: await staff('teller@dataimp.local', 'TELLER'), email: 'teller@dataimp.local', role: 'TELLER', tid: SLUG });
    void adm;
    check('a teller cannot act on imports', (await call('POST', `/api/data/import/events/${st2.body.eventKey}:action`, { action: 'REJECT' }, { auth: teller })).status === 403);

    // ---------------------------------------------------------------------
    section('the reference platform\'s external loan migration: POST /loans/migrate');
    const mig = await call('POST', '/api/loans/migrate', {
      migrationDate: '2026-06-30',
      loanAccount: {
        id: 'MIG1', accountHolderKey: 'MB1', productTypeKey: 'IMP', loanAmount: 6000,
        scheduleSettings: { repaymentInstallments: 6 }, interestSettings: { interestRate: 1 },
        disbursementDetails: { disbursementDate: '2026-01-15' }, balances: { principalBalance: 2000 }, notes: 'from the old system',
      },
      migrationFields: { principalInArrears: 1000, interest: 60, interestAccrued: 40, lastSetToArrearsDate: '2026-05-15', contractualMonthlyPayment: 1060 },
    });
    check('a loan is migrated with its balances', mig.status === 201 && mig.body.account_no === 'MIG1', mig.text.slice(0, 400));
    const mi = await inst(mig.body.id);
    const dueBy = mi.filter((x) => x.due_date < '2026-06-30');
    check('exactly the principal in arrears is left unpaid on installments already due',
      round2(dueBy.reduce((t, x) => t + (x.principal_due - x.principal_paid), 0)) === 1000
      && round2(mi.reduce((t, x) => t + (x.principal_due - x.principal_paid), 0)) === 2000, mi.map((x) => `${x.due_date}:${x.principal_paid}`).join(' '));
    const ml = await loan('MIG1');
    check('interest due and accrued are both owed, arrears date as given, fields kept',
      round2(ml.interest_accrued - ml.interest_paid) === 100 && ml.status === 'IN_ARREARS' && ml.arrears_since === '2026-05-15'
      && ml.migration_fields.contractualMonthlyPayment === 1060, JSON.stringify([ml.interest_accrued, ml.interest_paid, ml.status, ml.arrears_since]));
    check('the same account ID twice is refused', (await call('POST', '/api/loans/migrate', {
      migrationDate: '2026-06-30', loanAccount: { id: 'MIG1', accountHolderKey: 'MB1', productTypeKey: 'IMP', loanAmount: 1000, scheduleSettings: { repaymentInstallments: 2 },
        disbursementDetails: { disbursementDate: '2026-01-15' }, balances: { principalBalance: 500 } } })).reason.startsWith('LOAN_ACCOUNT_ID_ALREADY_IN_USE'));
    const mig2 = await call('POST', '/api/loans/migrate', {
      migrationDate: '2026-06-30',
      loanAccount: { id: 'MIG2', accountHolderKey: 'MA1', productTypeKey: 'IMP', loanAmount: 1200, scheduleSettings: { repaymentInstallments: 3 } },
      transactions: [{ type: 'DISBURSEMENT', date: '2026-03-01', amount: 1200 }, { type: 'REPAYMENT', date: '2026-04-01', amount: 412 }],
    });
    check('with transactions, replayed as the sheet replays them', mig2.status === 201 && L.principalOutstanding(await loan('MIG2')) === 800, mig2.text.slice(0, 300));
    check('a future migration date is refused', (await call('POST', '/api/loans/migrate', { migrationDate: '2099-01-01', loanAccount: { id: 'X' } })).status === 400);
    check('the placement rule on its own', (() => {
      const out = LM.allocatePrincipal([{ due_date: '2026-01-01', principal_due: 100 }, { due_date: '2026-02-01', principal_due: 100 }, { due_date: '2026-08-01', principal_due: 100 }],
        { principal: 300, outstanding: 150, inArrears: 50, asOf: '2026-06-30' });
      return out.map((x) => x.principal_paid).join(',') === '100,50,0';
    })());

    // ---------------------------------------------------------------------
    section('loading a backup back (the reference platform: Import Database clone)');
    const bk = await call('POST', '/api/database/backup', {});
    await backup.waitFor(bk.body.id);
    const zipFile = await call('GET', '/api/database/backup/LATEST', null, { raw: true });
    const files = unzip(zipFile.buffer, { maxTotal: 500 * 1024 * 1024 });
    const manifest = JSON.parse(files.get('manifest.json'));
    check('the backup carries restore.sql', files.has('restore.sql') && /\\copy "members"/.test(files.get('restore.sql').toString()));
    const client = await pool.connect();
    try {
      await client.query('DROP SCHEMA IF EXISTS restore_node CASCADE');
      const out = await backup.load(zipFile.buffer, { schema: 'restore_node', client });
      const { rows: [n] } = await client.query('SELECT (SELECT count(*)::int FROM restore_node.members) AS m, (SELECT count(*)::int FROM restore_node.loan_installments) AS i');
      check('cli backup:load loads every table into a schema', n.m === manifest.tables.members && n.i === manifest.tables.loan_installments
        && Object.keys(out.tables).length === Object.keys(manifest.tables).length, JSON.stringify(n));
      const { rows: [e] } = await client.query("SELECT count(*)::int AS n FROM restore_node.members WHERE middle_name = ''");
      check('NULL and empty text survive the round trip apart', e.n === 0);
    } finally {
      await client.query('DROP SCHEMA IF EXISTS restore_node CASCADE').catch(() => {});
      client.release();
    }
    let psqlOk = null;
    try { execFileSync('psql', ['--version']); psqlOk = true; } catch { psqlOk = false; }
    if (psqlOk) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
      for (const [name, data] of files) fs.writeFileSync(path.join(dir, name), data);
      execFileSync('psql', [...(process.env.DATABASE_URL ? [process.env.DATABASE_URL] : []), '-q', '-v', 'schema=restore_psql', '-f', 'restore.sql'], { cwd: dir, stdio: 'pipe' });
      const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM restore_psql.members');
      check('restore.sql loads it with psql', n.n === manifest.tables.members, String(n.n));
      await pool.query('DROP SCHEMA IF EXISTS restore_psql CASCADE');
    } else check('restore.sql loads it with psql (psql not installed; skipped)', true);

    section('structure');
    const dict = await Rd((c) => DD.build(c));
    check('the dictionary describes the new columns and tables', dict.missing.length === 0, dict.missing.join(', '));
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

