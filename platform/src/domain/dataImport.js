'use strict';

const crypto = require('crypto');
const XLSX = require('../lib/xlsx');
const acct = require('./accounting');
const L = require('./loans');
const LM = require('./loanMigration');
const SV = require('./savings');
const SH = require('./shares');
const B = require('./branches');
const CF = require('./customFields');
const IDT = require('./idTemplates');

/**
 * The Excel data import (the reference platform's Data Importing and its Excel Migration
 * Template): a SACCO moving onto the platform fills in one workbook with its
 * chart of accounts, branches, centres, members, deposit, share and loan
 * accounts, loan schedules and transactions, and its opening balances;
 * uploads it; reviews what it will create; and approves or rejects it.
 *
 * The template reads the reference platform's own layout as well as this one: the reference platform's sheet
 * names (Clients, Savings Accounts, Loan Schedules, Chart of Accounts) and
 * column headings (Client ID, Date Joined (dd.MM.yyyy), Loan Length
 * (# Installments), Principal Expected, Current Balance), dd.MM.yyyy dates,
 * M/F, day initials, and A/L/I/E/Q and D/H in the chart of accounts. IDs are
 * limited to 32 characters and other text to 255, as in the reference platform.
 *
 * Upload. The file is stored and the work runs in the background (./ops
 * importRunner): the workbook is read and every cell checked, then the
 * whole import is run for real inside a savepoint and rolled back, so what
 * only the database would refuse is found now, row by row. The run reports
 * its progress. An import with errors is INVALID, with the workbook back:
 * each offending cell red, an Errors column on its sheet, and an Errors
 * sheet last. One without is PENDING_APPROVAL (the reference platform's Draft) with what it
 * will create, a preview of every record as it will be, and any warnings.
 *
 * Nothing reaches the live tables before approval, so nothing waits to be
 * left out of the end of day, and a rejected import (the reference platform's Reverted)
 * leaves no trace but its record. Approval runs the import again and
 * commits it all or none of it.
 *
 * Balances are as at the end of the migration date (Settings sheet). Loans
 * are built by ./loanMigration, which the reference platform's external migration API uses
 * too. Accounts post nothing to the general ledger; the opening balances
 * (GL Balances sheet, or the reference platform's Chart of Accounts sheet with its signed
 * balances) are posted as one entry on the migration date, and the reviewer
 * is warned where a subledger does not match its GL account there.
 */

const MAX_FILE = 5 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_ID = 32;
const MAX_TEXT = 255;
const MAX_NOTES = 2000;
const PREVIEW_SCHEDULES = 300;
const err = (m, status = 400) => Object.assign(new Error(m), { status });

const GL_TYPES = { A: 'ASSET', L: 'LIABILITY', I: 'INCOME', E: 'EXPENSE', Q: 'EQUITY', ASSET: 'ASSET', LIABILITY: 'LIABILITY', INCOME: 'INCOME', EXPENSE: 'EXPENSE', EQUITY: 'EQUITY' };
const USAGE = { D: 'DETAIL', H: 'HEADER', DETAIL: 'DETAIL', HEADER: 'HEADER' };
const GENDER = { M: 'MALE', F: 'FEMALE', O: 'OTHER', MALE: 'MALE', FEMALE: 'FEMALE', OTHER: 'OTHER' };
const DAY = {
  SU: 0, SUN: 0, SUNDAY: 0, M: 1, MO: 1, MON: 1, MONDAY: 1, T: 2, TU: 2, TUE: 2, TUESDAY: 2, W: 3, WE: 3, WED: 3, WEDNESDAY: 3,
  TH: 4, THU: 4, THURSDAY: 4, F: 5, FR: 5, FRI: 5, FRIDAY: 5, SA: 6, SAT: 6, SATURDAY: 6,
};
const STATE = {
  ACTIVE: 'ACTIVE', 'IN ARREARS': 'ACTIVE', 'PENDING APPROVAL': 'PENDING_APPROVAL', PENDING: 'PENDING_APPROVAL', APPROVED: 'APPROVED',
  CLOSED: 'CLOSED', REPAID: 'CLOSED', WITHDRAWN: 'WITHDRAWN', REJECTED: 'REJECTED', 'WRITTEN OFF': 'WRITTEN_OFF',
};
const TX = { DISBURSEMENT: 'DISBURSEMENT', REPAYMENT: 'REPAYMENT', FEE: 'FEE', PENALTY: 'PENALTY', FEE_APPLIED: 'FEE', PENALTY_APPLIED: 'PENALTY' };
const PERIOD = { D: 'D', W: 'W', M: 'M', Y: 'Y', DAYS: 'D', WEEKS: 'W', MONTHS: 'M', YEARS: 'Y' };
const lookup = (table, label) => ({ table, label });

// The workbook: each sheet, its columns, and what each column holds. `a`
// are other headings the column is read under (the reference platform's). `id` columns are
// limited to 32 characters, text to 255, notes to 2,000. Sheets marked
// `custom` take custom field columns headed "Custom: _setId.fieldId".
const SHEETS = [
  { key: 'glAccounts', name: 'GL Accounts', note: 'Accounts to add to the chart of accounts, with parents. Parents first, or in the chart already.', columns: [
    { h: 'Code', k: 'code', req: true, id: true, a: ['GL Code'], hint: 'Unique, e.g. 100-150' },
    { h: 'Name', k: 'name', req: true, a: ['Account Name'] },
    { h: 'Type', k: 'type', req: true, map: lookup(GL_TYPES, 'A, L, I, E, Q or the word') },
    { h: 'Parent code', k: 'parentCode', id: true },
    { h: 'Usage', k: 'usage', map: lookup(USAGE, 'D (detail, default) or H (header)') },
    { h: 'Notes', k: 'notes', notes: true },
  ] },
  { key: 'chart', name: 'Chart of Accounts', aliases: ['Chart of Account'], note: 'the reference platform\'s layout: accounts (created when new) with their balance at the migration date, signed by type. Use this or GL Balances for the opening balances, not both.', columns: [
    { h: 'GL Code', k: 'code', req: true, id: true },
    { h: 'Account Name', k: 'name', req: true },
    { h: 'Date', k: 'date', type: 'date', hint: 'The balance date; if given, the migration date' },
    { h: 'Type', k: 'type', req: true, map: lookup(GL_TYPES, 'A, L, I, E or Q') },
    { h: 'Usage', k: 'usage', map: lookup(USAGE, 'D or H') },
    { h: 'Balance', k: 'balance', type: 'signed', hint: 'Asset and expense: debit +, credit -. Liability, equity and income: credit +, debit -' },
    { h: 'Notes', k: 'notes', notes: true },
  ] },
  { key: 'branches', name: 'Branches', columns: [
    { h: 'Branch ID', k: 'code', req: true, id: true, hint: '2 to 16 uppercase letters, digits, - or _' },
    { h: 'Name', k: 'name', req: true },
    { h: 'Town', k: 'town', a: ['City'] }, { h: 'Phone', k: 'phone' }, { h: 'Email', k: 'email' },
    { h: 'Address', k: 'address', a: ['Address 1'] }, { h: 'Notes', k: 'notes', notes: true },
  ], custom: 'BRANCH' },
  { key: 'centres', name: 'Centres', columns: [
    { h: 'Centre ID', k: 'code', req: true, id: true },
    { h: 'Name', k: 'name', req: true },
    { h: 'Branch ID', k: 'branch', req: true, id: true },
    { h: 'Meeting day', k: 'meetingDay', map: lookup(DAY, 'M, T, W, TH, F, SA, SU or the day'), hint: 'Blank: none' },
    { h: 'Address', k: 'address', a: ['Address 1'] }, { h: 'Address 2', k: 'address2' }, { h: 'City', k: 'city' },
    { h: 'Postcode', k: 'postcode', a: ['Zip'] }, { h: 'Region', k: 'region', a: ['State/Province/Region'] }, { h: 'Country', k: 'country' },
    { h: 'Notes', k: 'notes', notes: true },
  ], custom: 'CENTRE' },
  { key: 'members', name: 'Members', aliases: ['Clients'], columns: [
    { h: 'Member number', k: 'memberNo', req: true, id: true, a: ['Client ID'] },
    { h: 'First name', k: 'firstName', req: true },
    { h: 'Middle name', k: 'middleName' },
    { h: 'Last name', k: 'lastName', req: true },
    { h: 'National ID', k: 'nationalId', id: true }, { h: 'KRA PIN', k: 'kraPin', id: true },
    { h: 'Phone', k: 'phone', a: ['Mobile/Cellphone', 'Mobile', 'Cellphone'] }, { h: 'Phone 2', k: 'phone2', a: ['Other phone'] }, { h: 'Email', k: 'email', a: ['Email Address'] },
    { h: 'Date of birth', k: 'dateOfBirth', type: 'date' },
    { h: 'Gender', k: 'gender', map: lookup(GENDER, 'M, F or O') },
    { h: 'Employer', k: 'employer' },
    { h: 'Branch ID', k: 'branch', id: true }, { h: 'Centre ID', k: 'centre', id: true },
    { h: 'Group ID', k: 'groupId', id: true, hint: 'Not supported: groups are not part of this system' },
    { h: 'Joined on', k: 'joinedOn', type: 'date', a: ['Date Joined'], hint: 'Default: the migration date' },
    { h: 'Status', k: 'status', map: lookup({ ACTIVE: 'ACTIVE', DORMANT: 'DORMANT', EXITED: 'EXITED' }, 'Active, Dormant or Exited'), hint: 'Default Active' },
    { h: 'Address line 1', k: 'addressLine1', a: ['Address 1'] }, { h: 'Address line 2', k: 'addressLine2', a: ['Address 2'] },
    { h: 'City', k: 'city' }, { h: 'Postcode', k: 'postcode', a: ['Zip'] }, { h: 'Region', k: 'region', a: ['State/Province/Region'] }, { h: 'Country', k: 'country' },
    { h: 'Credit officer', k: 'creditOfficer', a: ['Credit Officer username', 'Credit Officer'], hint: 'The staff user\'s email (Credit Officers sheet)' },
    { h: 'Prior loan cycles', k: 'priorLoanCycles', type: 'int', a: ['Individual Loan Cycle'], hint: 'Loans repaid in full in the old system' },
    { h: 'ID type', k: 'idType', hint: 'An ID template (ID Templates sheet), or another type where allowed' },
    { h: 'ID number', k: 'idNumber', id: true },
    { h: 'ID authority', k: 'idAuthority' },
    { h: 'ID valid until', k: 'idValidUntil', type: 'date' },
    { h: 'Notes', k: 'notes', notes: true },
  ], custom: 'MEMBER' },
  { key: 'deposits', name: 'Deposit Accounts', aliases: ['Savings Accounts'], columns: [
    { h: 'Account number', k: 'accountNo', req: true, id: true, a: ['Account ID'] },
    { h: 'Member number', k: 'memberNo', req: true, id: true, a: ['Client ID'] },
    { h: 'Product ID', k: 'productId', req: true, id: true },
    { h: 'Balance', k: 'balance', type: 'amount', req: true, a: ['Current Balance'], hint: 'At the end of the migration date, including interest accrued and not yet applied' },
    { h: 'Date applied', k: 'appliedOn', type: 'date' },
    { h: 'Opened on', k: 'openedOn', type: 'date', a: ['Date Approved'], hint: 'The balance is recorded on this date' },
    { h: 'Branch ID', k: 'branch', id: true, hint: "Default: the member's" },
    { h: 'Overdraft limit', k: 'overdraftLimit', type: 'amount' },
    { h: 'Overdraft interest rate', k: 'overdraftRate', type: 'number', hint: "A year; blank: the product's" },
    { h: 'Overdraft amount due', k: 'overdraftDue', type: 'amount', hint: 'Overdrawn principal at the migration date' },
    { h: 'Overdraft interest due', k: 'overdraftInterestDue', type: 'amount' },
    { h: 'Overdraft fees due', k: 'overdraftFeesDue', type: 'amount' },
    { h: 'Notes', k: 'notes', notes: true },
  ], custom: 'SAVINGS_ACCOUNT' },
  { key: 'shares', name: 'Share Accounts', columns: [
    { h: 'Account number', k: 'accountNo', req: true, id: true, a: ['Account ID'] },
    { h: 'Member number', k: 'memberNo', req: true, id: true, a: ['Client ID'] },
    { h: 'Product ID', k: 'productId', req: true, id: true },
    { h: 'Units', k: 'units', type: 'number', req: true },
  ] },
  { key: 'loans', name: 'Loan Accounts', columns: [
    { h: 'Account number', k: 'accountNo', req: true, id: true, a: ['Account ID'] },
    { h: 'Member number', k: 'memberNo', req: true, id: true, a: ['Client ID'] },
    { h: 'Client type', k: 'clientType', map: lookup({ C: 'C', G: 'G' }, 'C (member) or G (group)'), hint: 'C; groups are not supported' },
    { h: 'Product ID', k: 'productId', req: true, id: true },
    { h: 'Account state', k: 'state', map: lookup(STATE, 'Active, Pending Approval, Approved, Closed, Withdrawn, Rejected or Written Off'), hint: 'Default Active' },
    { h: 'Principal', k: 'principal', type: 'amount', req: true, a: ['Loan Amount'], hint: 'As disbursed' },
    { h: 'Installments', k: 'installments', type: 'int', req: true, a: ['Loan Length'] },
    { h: 'Repayment every', k: 'repaymentEvery', type: 'int', a: ['Repayment Frequency'], hint: "Must match the product's" },
    { h: 'Repayment period', k: 'repaymentUnit', map: lookup(PERIOD, 'D, W, M or Y'), hint: "Must match the product's" },
    { h: 'Principal interval', k: 'principalInterval', type: 'int', hint: '1 (principal in every installment)' },
    { h: 'Grace installments', k: 'gracePeriods', type: 'int', a: ['# Grace Installments'] },
    { h: 'Interest rate', k: 'rate', type: 'number', hint: "In the product's rate frequency; default: the product's" },
    { h: 'Date applied', k: 'appliedOn', type: 'date' },
    { h: 'Date approved', k: 'approvedOn', type: 'date' },
    { h: 'Disbursed on', k: 'disbursedOn', type: 'date', a: ['Date Disbursed'] },
    { h: 'Repayment start date', k: 'firstRepaymentDate', type: 'date', hint: 'The first due date' },
    { h: 'Closed on', k: 'closedOn', type: 'date', hint: 'For a closed, withdrawn, rejected or written-off loan' },
    { h: 'Principal paid', k: 'principalPaid', type: 'amount', hint: 'Or give the principal outstanding' },
    { h: 'Interest paid', k: 'interestPaid', type: 'amount' },
    { h: 'Principal outstanding', k: 'principalOutstanding', type: 'amount' },
    { h: 'Principal in arrears', k: 'principalInArrears', type: 'amount', hint: 'Due and unpaid at the migration date; default: what the schedule leaves due' },
    { h: 'Interest outstanding', k: 'interestOutstanding', type: 'amount', hint: 'Accrued and unpaid' },
    { h: 'Fees outstanding', k: 'feesOutstanding', type: 'amount' },
    { h: 'Penalty outstanding', k: 'penaltyOutstanding', type: 'amount' },
    { h: 'Branch ID', k: 'branch', id: true, hint: "Default: the member's" },
    { h: 'Purpose', k: 'purpose' }, { h: 'Notes', k: 'notes', notes: true },
  ], custom: 'LOAN_ACCOUNT' },
  { key: 'schedule', name: 'Loan Schedule', aliases: ['Loan Schedules', 'Schedules'], note: 'Optional, fixed-term loans only. A loan with rows here takes this schedule; one without is given the product\'s. Without paid columns, what the account sheet says was paid is applied oldest first.', columns: [
    { h: 'Account number', k: 'accountNo', req: true, id: true, a: ['Account ID'] },
    { h: 'Installment', k: 'number', type: 'int', hint: 'Default: the order of the due dates' },
    { h: 'Due date', k: 'dueDate', type: 'date', req: true },
    { h: 'Principal due', k: 'principalDue', type: 'amount', req: true, a: ['Principal Expected'] },
    { h: 'Interest due', k: 'interestDue', type: 'amount', req: true, a: ['Interest Expected'] },
    { h: 'Fees due', k: 'feesDue', type: 'amount', a: ['Fees Expected'] },
    { h: 'Penalty due', k: 'penaltyDue', type: 'amount', a: ['Penalty Expected'] },
    { h: 'Principal paid', k: 'principalPaid', type: 'amount' },
    { h: 'Interest paid', k: 'interestPaid', type: 'amount' },
    { h: 'Fees paid', k: 'feesPaid', type: 'amount' },
    { h: 'Penalty paid', k: 'penaltyPaid', type: 'amount' },
  ] },
  { key: 'transactions', name: 'Loan Transactions', aliases: ['Transactions'], note: 'Optional, fixed-term loans only. Replayed in order, each loan\'s rows together, oldest first, starting with its DISBURSEMENT. They replace the paid and outstanding amounts on the account sheet. No journal entries.', columns: [
    { h: 'Account number', k: 'accountNo', req: true, id: true, a: ['Account ID'] },
    { h: 'Transaction type', k: 'type', req: true, map: lookup(TX, 'DISBURSEMENT, REPAYMENT, FEE or PENALTY') },
    { h: 'Date', k: 'date', type: 'date', req: true },
    { h: 'Amount', k: 'amount', type: 'amount', req: true },
    { h: 'Notes', k: 'notes', notes: true },
  ] },
  { key: 'glBalances', name: 'GL Balances', note: 'The opening trial balance, posted as one entry on the migration date. Debits must equal credits.', columns: [
    { h: 'GL code', k: 'glCode', req: true, id: true },
    { h: 'Debit', k: 'debit', type: 'amount' },
    { h: 'Credit', k: 'credit', type: 'amount' },
    { h: 'Branch ID', k: 'branch', id: true },
  ] },
];
const SETTINGS = 'Settings';
const REFERENCE_SHEETS = ['Branches Data', 'Centres Data', 'Credit Officers', 'Loan Products', 'Deposit Products', 'Share Products', 'GL Accounts Data', 'ID Templates'];

// A heading, compared without case, spacing, the * of a required column,
// a trailing colon, or a note in brackets such as "(dd.MM.yyyy)".
const norm = (s) => String(s ?? '').replace(/\*/g, '').replace(/\([^)]*\)/g, '').replace(/:\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** A date as yyyy-MM-dd from yyyy-MM-dd, dd.MM.yyyy (the reference platform) or an Excel date cell. */
function isoDate(v) {
  const s = String(v).trim().slice(0, 10);
  let y; let m; let d;
  let r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(v).trim()))) [, d, m, y] = r;
  else return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

function convert(v, col) {
  if (blank(v)) return { value: null };
  const type = col.type || 'text';
  if (col.map) {
    const key = String(v).trim().toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    const hit = col.map.table[key] ?? col.map.table[key.replace(/ /g, '_')];
    if (hit === undefined) return { error: `must be ${col.map.label}` };
    return { value: hit };
  }
  if (type === 'text') {
    const s = typeof v === 'number' ? String(v) : String(v).trim();
    const max = col.id ? MAX_ID : col.notes ? MAX_NOTES : MAX_TEXT;
    if (s.length > max) return { error: `is longer than ${max} characters` };
    return { value: s };
  }
  if (type === 'date') {
    const iso = isoDate(v);
    return iso ? { value: iso } : { error: 'must be a date, dd.MM.yyyy or yyyy-MM-dd' };
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return { error: 'must be a number' };
  if (type === 'amount' || type === 'signed') {
    if (type === 'amount' && n < 0) return { error: 'cannot be negative' };
    if (Math.abs(round2(n) - n) > 1e-9) return { error: 'has more than two decimals' };
    return { value: round2(n) };
  }
  if (type === 'int') {
    if (!Number.isInteger(n) || n < 0) return { error: 'must be a whole number, zero or more' };
    return { value: n };
  }
  return { value: n };
}

function groupBy(list, f) {
  const m = new Map();
  for (const x of list) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
const sum = (list, k) => round2(list.reduce((t, x) => t + Number(x[k] || 0), 0));
/** The fields a row gave, without the blanks. */
const given = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/** Map each column of a sheet's heading row to a column of its definition. */
function readHeader(def, headerRow, report) {
  const header = (headerRow || []).map(norm);
  const idx = {};
  const custom = [];
  const names = {};
  // The reference platform's clients sheet has Mobile/Cellphone and Phone: then Phone is the second number.
  const hasMobile = def.key === 'members' && header.some((h) => ['mobile/cellphone', 'mobile', 'cellphone'].includes(h));
  header.forEach((h, i) => {
    if (!h) return;
    if (hasMobile && h === 'phone') { idx.phone2 = i; names[i] = 'Phone 2'; return; }
    let col = def.columns.find((c) => norm(c.h) === h && idx[c.k] === undefined);
    if (!col) col = def.columns.find((c) => (c.a || []).some((a) => norm(a) === h) && idx[c.k] === undefined);
    if (col) { idx[col.k] = i; names[i] = col.h; return; }
    if (def.custom && h.startsWith('custom:')) {
      const [setId, fieldId] = String(headerRow[i]).replace(/^\s*custom:\s*/i, '').replace(/\([^)]*\)/g, '').replace(/\*/g, '').trim().split('.');
      if (setId && fieldId) { custom.push({ i, setId: setId.trim(), fieldId: fieldId.trim() }); names[i] = String(headerRow[i]); return; }
      report.error(def.name, 1, headerRow[i], 'A custom field column is headed "Custom: _setId.fieldId"', i);
      return;
    }
    report.warn(def.name, 1, headerRow[i], 'Column not recognised; ignored.', i);
  });
  return { idx, custom, names };
}

/**
 * Read and check the workbook on its own, before the database is asked
 * anything. Returns the rows by sheet, the migration date, the errors and
 * warnings, and where each sheet's columns are (for the error workbook and
 * The reference platform's error format).
 */
function parse(buffer, { today }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw err('EMPTY_FILE');
  if (buffer.length > MAX_FILE) throw err(`FILE_TOO_LARGE: the limit is ${MAX_FILE} bytes`, 413);
  const book = XLSX.read(buffer);
  const errors = [];
  const warnings = [];
  const layout = {};
  const report = {
    error: (sheet, row, column, message, index = null) => errors.push({ sheet, row, column, message, ...(index !== null ? { index } : {}) }),
    warn: (sheet, row, column, message, index = null) => warnings.push({ sheet, row, column, message, ...(index !== null ? { index } : {}) }),
  };
  const byName = new Map(book.map((s) => [norm(s.name), s]));
  const find = (def) => byName.get(norm(def.name)) || (def.aliases || []).map((a) => byName.get(norm(a))).find(Boolean);

  // Settings: key/value rows.
  let asOf = null;
  const settings = byName.get(norm(SETTINGS));
  if (!settings) report.error(SETTINGS, null, null, 'The Settings sheet is missing; it gives the migration date.');
  else {
    for (let i = 0; i < settings.rows.length; i += 1) {
      const [k, v] = settings.rows[i] || [];
      if (norm(k) === 'migration date') {
        const r = convert(v, { type: 'date' });
        if (r.error || !r.value) report.error(SETTINGS, i + 1, 'Migration date', r.error ? `Migration date ${r.error}` : 'Migration date is required', 1);
        else asOf = r.value;
      }
    }
    if (!asOf && !errors.some((x) => x.sheet === SETTINGS)) report.error(SETTINGS, null, 'Migration date', 'Migration date is required');
    if (asOf && asOf > today) report.error(SETTINGS, null, 'Migration date', `Migration date ${asOf} is after today (${today})`);
  }
  const groups = byName.get(norm('Groups'));
  if (groups && groups.rows.slice(1).some((r) => r && !r.every(blank))) {
    report.error('Groups', null, null, 'Groups are not part of this system; import their members as members');
  }

  const data = {};
  const counts = {};
  for (const def of SHEETS) {
    data[def.key] = [];
    const sh = find(def);
    if (!sh || !sh.rows.length) continue;
    const sheetName = sh.name;
    const { idx, custom, names } = readHeader(def, sh.rows[0], {
      error: (s, r, c, m, i) => report.error(sheetName, r, c, m, i),
      warn: (s, r, c, m, i) => report.warn(sheetName, r, c, m, i),
    });
    layout[def.key] = { sheet: sheetName, columns: Object.fromEntries(Object.entries(idx).map(([k, i]) => [def.columns.find((c) => c.k === k)?.h || k, i])) };
    const missing = def.columns.filter((c) => c.req && idx[c.k] === undefined);
    for (const col of missing) report.error(sheetName, 1, col.h, `Column "${col.h}" is missing`);
    if (missing.length) continue;
    const body = sh.rows.slice(1);
    if (body.length > MAX_ROWS) { report.error(sheetName, null, null, `More than ${MAX_ROWS} rows`); continue; }
    body.forEach((cells, n) => {
      const rowNo = n + 2;
      if (!cells || cells.every(blank)) return;
      const row = { _row: rowNo, _sheet: sheetName };
      for (const col of def.columns) {
        const raw = idx[col.k] === undefined ? null : cells[idx[col.k]];
        const r = convert(raw, col);
        if (r.error) report.error(sheetName, rowNo, col.h, `${col.h} ${r.error}`, idx[col.k]);
        else if (col.req && r.value === null) report.error(sheetName, rowNo, col.h, `${col.h} is required`, idx[col.k] ?? null);
        row[col.k] = r.value ?? null;
      }
      if (custom.length) {
        row.customFields = {};
        for (const cf of custom) {
          const v = cells[cf.i];
          if (blank(v)) continue;
          row.customFields[cf.setId] = { ...(row.customFields[cf.setId] || {}), [cf.fieldId]: typeof v === 'string' ? v.trim() : v };
        }
      }
      data[def.key].push(row);
    });
    counts[def.key] = data[def.key].length;
    void names;
  }
  const at = (key, name) => layout[key]?.columns?.[name] ?? null;
  const e = (key, r, column, message) => report.error(layout[key]?.sheet || SHEETS.find((s) => s.key === key).name, r ? r._row : null, column, message, r ? at(key, column) : null);

  // Within the file: numbers used twice, references to rows not there,
  // amounts that cannot be right.
  const dupes = (key, field, label) => {
    const seen = new Map();
    for (const r of data[key]) {
      const v = typeof r[field] === 'string' ? r[field].toUpperCase() : r[field];
      if (v === null) continue;
      if (seen.has(v)) e(key, r, label, `${label} ${r[field]} is also on row ${seen.get(v)}`);
      else seen.set(v, r._row);
    }
  };
  dupes('glAccounts', 'code', 'Code');
  dupes('chart', 'code', 'GL Code');
  dupes('branches', 'code', 'Branch ID');
  dupes('centres', 'code', 'Centre ID');
  dupes('members', 'memberNo', 'Member number');
  dupes('deposits', 'accountNo', 'Account number');
  dupes('shares', 'accountNo', 'Account number');
  dupes('loans', 'accountNo', 'Account number');
  for (const r of data.branches) if (r.code) r.code = r.code.toUpperCase();
  for (const r of data.centres) {
    if (r.code) r.code = r.code.toUpperCase();
    if (r.branch) r.branch = r.branch.toUpperCase();
    // One address line here: the rest of the reference platform's address is joined to it.
    const rest = [r.address2, r.city, r.postcode, r.region, r.country].filter(Boolean);
    if (rest.length) r.address = [r.address, ...rest].filter(Boolean).join(', ').slice(0, MAX_TEXT);
  }
  for (const r of data.members) {
    if (r.groupId) e('members', r, 'Group ID', 'Groups are not part of this system; leave Group ID empty');
    if ((r.idNumber && !r.idType) || (r.idType && !r.idNumber)) e('members', r, r.idNumber ? 'ID type' : 'ID number', 'An ID document needs both its type and its number');
  }
  const later = (key, r, field, label) => {
    if (asOf && r[field] && r[field] > asOf) e(key, r, label, `${label} ${r[field]} is after the migration date ${asOf}`);
  };
  for (const r of data.members) { later('members', r, 'joinedOn', 'Joined on'); later('members', r, 'dateOfBirth', 'Date of birth'); }
  for (const r of data.deposits) {
    later('deposits', r, 'openedOn', 'Opened on');
    later('deposits', r, 'appliedOn', 'Date applied');
    if (r.appliedOn && r.openedOn && r.appliedOn > r.openedOn) e('deposits', r, 'Date applied', 'Date applied is after the date the account opened');
    const overdrawn = round2((r.overdraftDue || 0) + (r.overdraftInterestDue || 0) + (r.overdraftFeesDue || 0));
    if (overdrawn > 0 && r.balance > 0) e('deposits', r, 'Balance', 'An account is in credit or overdrawn, not both');
    if (overdrawn > 0 && !(r.overdraftLimit > 0)) e('deposits', r, 'Overdraft limit', 'An overdrawn account needs its overdraft limit');
  }

  // Loans: their schedules and transactions, and what each state needs.
  const loanNos = new Set(data.loans.map((r) => r.accountNo));
  const sched = groupBy(data.schedule, (r) => r.accountNo);
  const txs = groupBy(data.transactions, (r) => r.accountNo);
  for (const r of data.schedule) if (r.accountNo && !loanNos.has(r.accountNo)) e('schedule', r, 'Account number', `No loan ${r.accountNo} on the Loan Accounts sheet`);
  for (const r of data.transactions) if (r.accountNo && !loanNos.has(r.accountNo)) e('transactions', r, 'Account number', `No loan ${r.accountNo} on the Loan Accounts sheet`);
  // A loan's transactions sit together, as the reference platform requires.
  {
    let last = null;
    const seen = new Set();
    for (const r of data.transactions) {
      if (r.accountNo !== last && seen.has(r.accountNo)) e('transactions', r, 'Account number', `The transactions of ${r.accountNo} must be together, one loan after another`);
      seen.add(r.accountNo); last = r.accountNo;
    }
  }
  for (const [no, rows] of sched) {
    // Installment numbers default to the order of the due dates.
    const sorted = [...rows].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
    if (rows.every((x) => x.number === null)) sorted.forEach((x, i) => { x.number = i + 1; });
    const numbers = [...rows].map((x) => x.number).sort((a, b) => a - b);
    if (numbers.some((n, i) => n !== i + 1)) e('schedule', rows[0], 'Installment', `The installments of ${no} must be numbered 1, 2, 3 without gaps`);
    const byNo = [...rows].sort((a, b) => a.number - b.number);
    for (let i = 1; i < byNo.length; i += 1) {
      if (byNo[i].dueDate <= byNo[i - 1].dueDate) { e('schedule', byNo[i], 'Due date', `Due dates of ${no} must be in ascending order`); break; }
    }
    for (const x of rows) {
      for (const [paid, due, label] of [['principalPaid', 'principalDue', 'Principal'], ['interestPaid', 'interestDue', 'Interest'], ['feesPaid', 'feesDue', 'Fees'], ['penaltyPaid', 'penaltyDue', 'Penalty']]) {
        if ((x[paid] || 0) > (x[due] || 0)) e('schedule', x, `${label} paid`, `${label} paid is more than ${label.toLowerCase()} due`);
      }
    }
  }
  for (const r of data.loans) {
    if (r.clientType === 'G') e('loans', r, 'Client type', 'Group loans are not part of this system');
    r.state = r.state || 'ACTIVE';
    if (r.principalOutstanding === null && r.principalPaid !== null && r.principal !== null) r.principalOutstanding = round2(r.principal - r.principalPaid);
    if (r.principalOutstanding !== null && r.principalPaid !== null && r.principal !== null && round2(r.principal - r.principalPaid) !== r.principalOutstanding) {
      e('loans', r, 'Principal outstanding', 'Principal paid and principal outstanding do not add up to the principal');
    }
    if (r.principal !== null && r.principalOutstanding !== null && r.principalOutstanding > r.principal) e('loans', r, 'Principal outstanding', 'Principal outstanding is more than the principal');
    if (r.installments === 0) e('loans', r, 'Installments', 'Installments must be at least 1');
    later('loans', r, 'disbursedOn', 'Disbursed on');
    later('loans', r, 'approvedOn', 'Date approved');
    later('loans', r, 'appliedOn', 'Date applied');
    const rows = sched.get(r.accountNo);
    const own = txs.get(r.accountNo) || [];
    r._hasSchedulePaid = !!rows && rows.some((x) => ['principalPaid', 'interestPaid', 'feesPaid', 'penaltyPaid'].some((k) => x[k] !== null));
    const spec = specOf(r, rows, own);
    for (const p of LM.check(spec, { asOf })) e('loans', r, columnFor(p.field), p.message);
    if (rows && r.principal !== null && !own.length) {
      const due = sum(rows, 'principalDue');
      if (due !== r.principal) e('loans', r, 'Principal', `The schedule's principal due adds up to ${due}, not ${r.principal}`);
      if (r._hasSchedulePaid) {
        const paid = sum(rows, 'principalPaid');
        if (r.principalOutstanding !== null && round2(due - paid) !== r.principalOutstanding) {
          e('loans', r, 'Principal outstanding', `The schedule leaves ${round2(due - paid)} principal unpaid, not ${r.principalOutstanding}`);
        }
        // Fees owed are those on installments due by the migration date
        // (or partly paid already); later ones are not due yet.
        const applied = rows.filter((x) => (asOf && x.dueDate <= asOf) || (x.feesPaid || 0) > 0);
        const feesLeft = round2(sum(applied, 'feesDue') - sum(applied, 'feesPaid'));
        if (r.feesOutstanding !== null && feesLeft !== r.feesOutstanding) {
          e('loans', r, 'Fees outstanding', `The schedule leaves ${feesLeft} fees owed by the migration date, not ${r.feesOutstanding}`);
        }
        if (rows.some((x) => x.penaltyDue !== null)) {
          const penLeft = round2(sum(rows, 'penaltyDue') - sum(rows, 'penaltyPaid'));
          if (r.penaltyOutstanding !== null && penLeft !== r.penaltyOutstanding) {
            e('loans', r, 'Penalty outstanding', `The schedule leaves ${penLeft} penalties unpaid, not ${r.penaltyOutstanding}`);
          }
        }
      }
      if (rows.length !== r.installments) e('loans', r, 'Installments', `The schedule has ${rows.length} installments, not ${r.installments}`);
    }
  }

  // Opening balances: GL Balances (debit, credit) or the chart of accounts
  // (a balance signed by the account's type), not both.
  const chartBalances = data.chart.filter((r) => r.balance !== null && r.balance !== 0);
  if (chartBalances.length && data.glBalances.length) {
    report.error(layout.chart.sheet, null, 'Balance', 'Give the opening balances on the Chart of Accounts sheet or on GL Balances, not both');
  }
  for (const r of data.chart) if (asOf && r.date && r.date !== asOf) e('chart', r, 'Date', `The balances are at the migration date, ${asOf}, not ${r.date}`);
  const lines = openingLines(data);
  let dr = 0;
  let cr = 0;
  for (const r of data.glBalances) {
    if ((r.debit || 0) > 0 && (r.credit || 0) > 0) e('glBalances', r, 'Debit', 'A line is a debit or a credit, not both');
    if (!(r.debit > 0) && !(r.credit > 0)) e('glBalances', r, 'Debit', 'A line needs a debit or a credit');
  }
  for (const l of lines) { if (l.side === 'D') dr += l.amount; else cr += l.amount; }
  if (round2(dr) !== round2(cr)) {
    const key = data.glBalances.length ? 'glBalances' : 'chart';
    report.error(layout[key]?.sheet || 'GL Balances', null, null, `Debits (${round2(dr)}) do not equal credits (${round2(cr)})`);
  }

  return { asOf, data, counts, errors, warnings, layout };
}

const COLUMN_OF = {
  disbursedOn: 'Disbursed on', principalOutstanding: 'Principal outstanding', state: 'Account state', closedOn: 'Closed on',
  principalInterval: 'Principal interval', appliedOn: 'Date applied', approvedOn: 'Date approved', firstRepaymentDate: 'Repayment start date',
  transactions: 'Account number', principalInArrears: 'Principal in arrears',
};
const columnFor = (f) => COLUMN_OF[f] || 'Account number';

/** The loan as ./loanMigration takes it, from its sheet rows. */
function specOf(r, schedule, txs) {
  return {
    accountNo: r.accountNo, productId: r.productId, principal: r.principal, installments: r.installments, rate: r.rate,
    gracePeriods: r.gracePeriods, repaymentEvery: r.repaymentEvery, repaymentUnit: r.repaymentUnit, principalInterval: r.principalInterval,
    state: r.state || 'ACTIVE', appliedOn: r.appliedOn, approvedOn: r.approvedOn, disbursedOn: r.disbursedOn, closedOn: r.closedOn,
    firstRepaymentDate: r.firstRepaymentDate, principalOutstanding: r.principalOutstanding, principalInArrears: r.principalInArrears,
    interestOutstanding: r.interestOutstanding, feesOutstanding: r.feesOutstanding, penaltyOutstanding: r.penaltyOutstanding,
    purpose: r.purpose, notes: r.notes, customFields: r.customFields || {},
    // A schedule without paid columns: what the account says was paid is
    // applied to it oldest first, as to a schedule the product draws.
    schedule: schedule ? schedule.map((x) => ({ ...x, ...(r._hasSchedulePaid ? {} : { principalPaid: null, interestPaid: null, feesPaid: null, penaltyPaid: null }) })) : null,
    schedulePaid: !!r._hasSchedulePaid,
    transactions: (txs || []).map((x) => ({ type: x.type, date: x.date, amount: x.amount, notes: x.notes })),
  };
}

/** The opening balances as journal lines, from either sheet. */
function openingLines(data) {
  if (data.glBalances.length) {
    return data.glBalances.filter((r) => (r.debit || 0) > 0 || (r.credit || 0) > 0)
      .map((r) => ({ glCode: r.glCode, amount: r.debit || r.credit, side: r.debit > 0 ? 'D' : 'C', branch: r.branch, row: r }));
  }
  return data.chart.filter((r) => r.balance && r.type).map((r) => {
    const debitNature = ['ASSET', 'EXPENSE'].includes(r.type);
    const debit = debitNature ? r.balance > 0 : r.balance < 0;
    return { glCode: r.code, amount: Math.abs(r.balance), side: debit ? 'D' : 'C', branch: null, row: r };
  });
}

// --- prerequisites ----------------------------------------------------------

/**
 * The reference platform's import prerequisites: users (credit officers), branches, custom
 * fields and products set up before the import. What is missing becomes a
 * warning on the upload, and is listed on the template.
 */
async function prerequisites(c) {
  const n = async (sql) => (await c.query(sql)).rows[0].n;
  const users = await n(`SELECT count(*)::int AS n FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
                          WHERE t.schema_name = current_schema() AND u.status = 'ACTIVE'`);
  const out = [
    { item: 'Users (credit officers)', count: users, ok: users > 1, detail: 'Staff users besides the first administrator, to assign members to' },
    { item: 'Branches', count: await n('SELECT count(*)::int AS n FROM branches'), detail: 'Branches members and accounts belong to (or on the Branches sheet)' },
    { item: 'Loan products', count: await n('SELECT count(*)::int AS n FROM loan_products WHERE is_active'), detail: 'Every product a loan is imported under' },
    { item: 'Deposit products', count: await n('SELECT count(*)::int AS n FROM savings_products WHERE is_active'), detail: 'Every product a deposit account is imported under' },
    { item: 'Custom field definitions', count: await n('SELECT count(*)::int AS n FROM custom_field_definitions WHERE is_active'), detail: 'Only if you import custom field values', optional: true },
  ];
  for (const x of out) if (x.ok === undefined) x.ok = x.optional ? true : x.count > 0;
  return out;
}

// --- running it ---------------------------------------------------------------

/**
 * Run the import against the database. Every row runs in its own savepoint
 * so one bad row is reported and the rest still tried; a row that depends
 * on one that failed (a loan for a member who did not import) says so. The
 * caller decides what happens to the whole: rolled back (validation) or
 * committed (approval, only when there are no errors). `onProgress(done,
 * total)` is called as rows are done; `preview` collects each record as
 * created, for the reviewer.
 */
async function execute(c, { asOf, data, layout = {} }, { importId, createdBy, user, onProgress = null, preview = null }) {
  const errors = [];
  const warnings = [];
  const created = { glAccounts: 0, branches: 0, centres: 0, members: 0, deposits: 0, shares: 0, loans: 0, installments: 0, transactions: 0, openingEntryLines: 0 };
  const failed = { member: new Map(), branch: new Map(), centre: new Map() };
  const members = new Map();
  const total = ['glAccounts', 'chart', 'branches', 'centres', 'members', 'deposits', 'shares', 'loans'].reduce((t, k) => t + data[k].length, 0) + 1;
  let done = 0;
  const tick = () => { done += 1; if (onProgress) onProgress(done, total); };
  const push = (k, x) => { if (preview) (preview[k] = preview[k] || []).push(x); };
  let sp = 0;
  const indexOf = (key, column) => layout[key]?.columns?.[column] ?? null;
  const row = async (key, r, column, fn) => {
    sp += 1;
    const name = `import_row_${sp}`;
    await c.query(`SAVEPOINT ${name}`);
    try {
      const out = await fn();
      await c.query(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
      const sheet = layout[key]?.sheet || SHEETS.find((s) => s.key === key)?.name || key;
      const index = indexOf(key, column);
      errors.push({ sheet, row: r._row ?? null, column, message: explain(e), ...(index !== null ? { index } : {}) });
      return undefined;
    }
  };
  const dependsOn = (map, key, what) => {
    if (map.has(key)) throw err(`${what} ${key} did not import (row ${map.get(key)})`);
  };
  const branchId = async (code) => {
    if (!code) return undefined;
    dependsOn(failed.branch, String(code).toUpperCase(), 'Branch');
    return (await B.resolve(c, String(code).toUpperCase())).id;
  };

  // Custom field values as the sheet wrote them, as the field wants them:
  // True and False for a checkbox, a date in either form.
  const defs = new Map();
  const coerce = async (entity, values) => {
    if (!values || !Object.keys(values).length) return {};
    if (!defs.has(entity)) defs.set(entity, await CF.definitions(c, { entity, includeInactive: false }));
    const list = defs.get(entity);
    const out = {};
    for (const [setId, fields] of Object.entries(values)) {
      out[setId] = {};
      for (const [fieldId, v] of Object.entries(fields)) {
        const d = list.find((x) => x.id === fieldId && x.set_id === setId);
        let x = v;
        if (d && d.field_type === 'CHECKBOX') {
          const s = String(v).trim().toLowerCase();
          x = ['true', 'yes', 'y', '1'].includes(s) || v === true ? true : ['false', 'no', 'n', '0'].includes(s) || v === false ? false : v;
        } else if (d && d.field_type === 'DATE') x = isoDate(v) || v;
        out[setId][fieldId] = x;
      }
    }
    return out;
  };

  // Credit officers are the tenant's own users.
  const officers = new Map();
  const officer = async (who) => {
    if (!who) return null;
    const k = String(who).trim().toLowerCase();
    if (!officers.has(k)) {
      const { rows: [u] } = await c.query(
        `SELECT u.email FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
         WHERE t.schema_name = current_schema() AND u.status = 'ACTIVE' AND lower(u.email) = $1`, [k]);
      officers.set(k, u ? u.email : null);
    }
    const found = officers.get(k);
    if (!found) throw err(`Credit officer ${who} is not an active user of this SACCO (Credit Officers sheet)`);
    return found;
  };

  // The chart of accounts: parents before children, then the reference platform's chart sheet.
  const pending = [...data.glAccounts];
  const inFile = new Set(pending.map((r) => r.code));
  const placed = new Set();
  let guard = pending.length + 1;
  while (pending.length && guard > 0) {
    guard -= 1;
    for (let i = 0; i < pending.length; i += 1) {
      const r = pending[i];
      if (r.parentCode && inFile.has(r.parentCode) && !placed.has(r.parentCode)) continue;
      pending.splice(i, 1); i -= 1;
      placed.add(r.code);
      const ok = await row('glAccounts', r, 'Code', async () => {
        if (r.parentCode) {
          const { rows: [p] } = await c.query('SELECT type FROM gl_accounts WHERE code = $1', [r.parentCode]);
          if (!p) throw err(`Parent code ${r.parentCode} is not in the chart of accounts`);
        }
        const { rowCount } = await c.query(
          `INSERT INTO gl_accounts (code, name, type, parent_code, usage, notes, import_id)
           VALUES ($1,$2,$3,$4,COALESCE($5,'DETAIL'),$6,$7) ON CONFLICT (code) DO NOTHING`,
          [r.code, r.name, r.type, r.parentCode, r.usage, r.notes, importId]);
        if (!rowCount) throw err(`GL account ${r.code} is already in the chart of accounts`);
        push('glAccounts', { code: r.code, name: r.name, type: r.type, usage: r.usage || 'DETAIL', parent: r.parentCode });
        return true;
      });
      tick();
      if (ok) created.glAccounts += 1;
    }
  }
  for (const r of pending) errors.push({ sheet: 'GL Accounts', row: r._row, column: 'Parent code', message: 'The parent codes form a loop' });
  for (const r of data.chart) {
    const ok = await row('chart', r, 'GL Code', async () => {
      const { rows: [g] } = await c.query('SELECT code, type FROM gl_accounts WHERE code = $1', [r.code]);
      if (g) {
        if (g.type !== r.type) throw err(`GL account ${r.code} is ${g.type} in the chart of accounts, not ${r.type}`);
        return false;
      }
      await c.query(
        `INSERT INTO gl_accounts (code, name, type, usage, notes, import_id) VALUES ($1,$2,$3,COALESCE($4,'DETAIL'),$5,$6)`,
        [r.code, r.name, r.type, r.usage, r.notes, importId]);
      push('glAccounts', { code: r.code, name: r.name, type: r.type, usage: r.usage || 'DETAIL', parent: null });
      return true;
    });
    tick();
    if (ok) created.glAccounts += 1;
  }

  for (const r of data.branches) {
    const ok = await row('branches', r, 'Branch ID', async () => {
      const b = await B.create(c, { ...given({ name: r.name, town: r.town, phone: r.phone, email: r.email, address: r.address, notes: r.notes }),
        code: r.code, customFields: await coerce('BRANCH', r.customFields), createdBy, user });
      await c.query('UPDATE branches SET import_id = $2 WHERE id = $1', [b.id, importId]);
      push('branches', { code: b.code, name: b.name, town: b.town });
      return b;
    });
    tick();
    if (ok) created.branches += 1; else failed.branch.set(r.code, r._row);
  }
  for (const r of data.centres) {
    const ok = await row('centres', r, 'Centre ID', async () => {
      await branchId(r.branch);
      const ce = await B.createCentre(c, { ...given({ name: r.name, address: r.address, notes: r.notes }),
        code: r.code, branchId: r.branch, meetingDay: r.meetingDay ?? null, customFields: await coerce('CENTRE', r.customFields), createdBy, user });
      await c.query('UPDATE centres SET import_id = $2 WHERE id = $1', [ce.id, importId]);
      push('centres', { code: ce.code, name: ce.name, branch: r.branch, meetingDay: ce.meeting_day });
      return ce;
    });
    tick();
    if (ok) created.centres += 1; else failed.centre.set(r.code, r._row);
  }

  for (const r of data.members) {
    const m = await row('members', r, 'Member number', async () => {
      const bId = await branchId(r.branch);
      if (r.branch) {
        const { rows: [b] } = await c.query('SELECT status FROM branches WHERE id = $1', [bId]);
        if (b.status !== 'ACTIVE') throw err(`Branch ${r.branch} is deactivated`);
      }
      if (r.centre) dependsOn(failed.centre, String(r.centre).toUpperCase(), 'Centre');
      const centre = r.centre ? await B.centreFor(c, String(r.centre).toUpperCase(), bId || null) : null;
      const credit = await officer(r.creditOfficer);
      const values = await CF.prepare(c, 'MEMBER', { patch: await coerce('MEMBER', r.customFields), user, creating: true });
      // The ID document, against the ID templates (the reference platform: ID type, number,
      // authority, valid until); mandatory templates apply as on the form.
      let docs = [];
      if (r.idNumber) {
        const { rows: [t] } = await c.query('SELECT id FROM id_templates WHERE lower(id_type) = lower($1) OR id::text = $1 LIMIT 1', [r.idType]);
        docs = [{ templateId: t ? t.id : 'OTHER', idType: r.idType, documentId: r.idNumber, issuingAuthority: r.idAuthority, validUntil: r.idValidUntil }];
      }
      const shaped = await IDT.forNewMember(c, docs);
      const { rows: [x] } = await c.query(
        `INSERT INTO members (member_no, first_name, middle_name, last_name, national_id, kra_pin, phone, phone2, email,
            date_of_birth, gender, employer, status, joined_on, branch_id, centre_id, address_line1, address_line2, city,
            postcode, region, country, credit_officer, prior_loan_cycles, notes, custom_fields, import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,'ACTIVE'),COALESCE($14::date,$15::date),$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,COALESCE($25,0),$26,$27,$28)
         RETURNING id, branch_id, member_no`,
        [r.memberNo, r.firstName, r.middleName, r.lastName, r.nationalId, r.kraPin, r.phone, r.phone2, r.email,
          r.dateOfBirth, r.gender, r.employer, r.status, r.joinedOn, asOf, bId || (centre ? centre.branch_id : null), centre ? centre.id : null,
          r.addressLine1, r.addressLine2, r.city, r.postcode, r.region, r.country, credit, r.priorLoanCycles, r.notes,
          JSON.stringify(values), importId]);
      await IDT.storeForMember(c, x.id, shaped, { createdBy });
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'MEMBER_IMPORTED','member',$2,$3)`,
        [createdBy, x.id, JSON.stringify({ memberNo: r.memberNo, importId })]);
      push('members', { memberNo: r.memberNo, name: [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' '), branch: r.branch,
        centre: r.centre, joinedOn: r.joinedOn || asOf, creditOfficer: credit, priorLoanCycles: r.priorLoanCycles || 0,
        idDocuments: shaped.map((d) => `${d.id_type} ${d.document_id}`) });
      return x;
    });
    tick();
    if (m) { created.members += 1; members.set(r.memberNo, m); } else failed.member.set(r.memberNo, r._row);
  }
  const member = async (no) => {
    if (members.has(no)) return members.get(no);
    dependsOn(failed.member, no, 'Member');
    const { rows: [m] } = await c.query('SELECT id, branch_id FROM members WHERE member_no = $1', [no]);
    if (!m) throw err(`No member ${no}, here or on the Members sheet`);
    members.set(no, m);
    return m;
  };

  const subledger = { deposits: new Map(), overdrafts: new Map(), shares: new Map(), loans: new Map() };
  const addTo = (map, gl, amount) => { if (gl && amount) map.set(gl, round2((map.get(gl) || 0) + amount)); };

  for (const r of data.deposits) {
    const ok = await row('deposits', r, 'Account number', async () => {
      const m = await member(r.memberNo);
      const bId = await branchId(r.branch);
      const a = await SV.open(c, { memberId: m.id, productId: r.productId, accountNo: r.accountNo, branchId: bId,
        overdraftLimit: r.overdraftLimit || 0, openedOn: r.openedOn || asOf, customFields: await coerce('SAVINGS_ACCOUNT', r.customFields), user });
      const { rows: [p] } = await c.query('SELECT * FROM savings_products WHERE id = $1', [r.productId]);
      const odPrincipal = round2(r.overdraftDue || 0);
      const odInterest = round2(r.overdraftInterestDue || 0);
      const odFees = round2(r.overdraftFeesDue || 0);
      const overdrawn = round2(odPrincipal + odInterest + odFees);
      if (overdrawn > 0 && !p.allow_overdraft) throw err(`Product ${p.id} does not allow overdrafts`);
      if (overdrawn > round2(r.overdraftLimit || 0) + 0.001 && !p.allow_technical_overdraft) {
        throw err(`The account is overdrawn by ${overdrawn}, more than its limit of ${r.overdraftLimit || 0}`);
      }
      if (r.overdraftRate !== null && !p.allow_overdraft) throw err(`Product ${p.id} does not allow overdrafts, so it takes no overdraft rate`);
      const balance = overdrawn > 0 ? -overdrawn : r.balance;
      // Under cash accounting overdraft interest and fees applied but unpaid
      // are income when paid; under accrual they are in the receivables the
      // opening balances carry.
      const cash = p.accounting_method !== 'ACCRUAL';
      await c.query(
        `UPDATE savings_accounts SET balance = $2, accrued_through = $3::date, last_interest_applied_on = $3::date,
           period_started_on = $3::date + 1, import_id = $4, applied_on = $5::date, notes = $6, overdraft_rate = $7,
           od_interest_due = $8, od_fees_due = $9
         WHERE id = $1`,
        [a.id, balance, asOf, importId, r.appliedOn || r.openedOn || asOf, r.notes, r.overdraftRate, cash ? odInterest : 0, cash ? odFees : 0]);
      if (balance !== 0) {
        await SV.record(c, { reference: SV.ref('MG'), kind: 'MIGRATION_OPENING_BALANCE', memberId: m.id, savingsAccountId: a.id,
          amount: Math.abs(balance), valueDate: r.openedOn || asOf, narration: 'Balance brought forward (data import)', createdBy,
          allocation: { importId, ...(balance < 0 ? { overdrawn: true, odPrincipal, odInterest, odFees } : {}) } });
      }
      addTo(subledger.deposits, p.gl_liability, Math.max(0, balance));
      addTo(subledger.overdrafts, p.gl_od_portfolio, odPrincipal);
      push('deposits', { accountNo: r.accountNo, memberNo: r.memberNo, product: r.productId, balance, overdraftLimit: r.overdraftLimit || 0,
        overdraftRate: r.overdraftRate, openedOn: r.openedOn || asOf });
      return a;
    });
    tick();
    if (ok) created.deposits += 1;
  }

  for (const r of data.shares) {
    const ok = await row('shares', r, 'Account number', async () => {
      const m = await member(r.memberNo);
      const { rows: [p] } = await c.query('SELECT * FROM share_products WHERE id = $1', [r.productId]);
      if (!p) throw err(`No share product ${r.productId}`);
      if (!(r.units > 0)) throw err('Units must be more than zero');
      const a = await SH.open(c, { memberId: m.id, productId: r.productId, accountNo: r.accountNo });
      await c.query('UPDATE share_accounts SET units = $2, import_id = $3 WHERE id = $1', [a.id, r.units, importId]);
      const amount = round2(r.units * Number(p.unit_price));
      await c.query(
        `INSERT INTO share_movements (account_id, member_id, units, unit_price, amount, kind, value_date)
         VALUES ($1,$2,$3,$4,$5,'MIGRATION',$6)`, [a.id, m.id, r.units, p.unit_price, amount, asOf]);
      addTo(subledger.shares, p.gl_equity, amount);
      push('shares', { accountNo: r.accountNo, memberNo: r.memberNo, product: r.productId, units: r.units, value: amount });
      return a;
    });
    tick();
    if (ok) created.shares += 1;
  }

  // Loans: the closed ones first, so a member's old loans are history
  // before the running one is opened (a product may allow one at a time).
  const schedules = groupBy(data.schedule, (x) => x.accountNo);
  const transactions = groupBy(data.transactions, (x) => x.accountNo);
  const rank = { CLOSED: 0, WITHDRAWN: 0, REJECTED: 0, WRITTEN_OFF: 1, ACTIVE: 2, APPROVED: 3, PENDING_APPROVAL: 3 };
  const loans = [...data.loans].sort((a, b) => (rank[a.state || 'ACTIVE'] ?? 2) - (rank[b.state || 'ACTIVE'] ?? 2));
  for (const r of loans) {
    const ok = await row('loans', r, 'Account number', async () => {
      const m = await member(r.memberNo);
      const bId = await branchId(r.branch);
      const spec = specOf(r, schedules.get(r.accountNo), transactions.get(r.accountNo));
      spec.memberId = m.id;
      if (bId !== undefined) spec.branchId = bId;
      spec.customFields = await coerce('LOAN_ACCOUNT', r.customFields);
      const out = await LM.migrate(c, spec, { asOf, importId, createdBy, user });
      for (const w of out.warnings) warnings.push({ sheet: layout.loans?.sheet || 'Loan Accounts', row: r._row, column: 'Account number', message: w });
      addTo(subledger.loans, out.loan.gl_portfolio, out.principalOutstanding);
      created.installments += out.installments;
      created.transactions += spec.transactions.length;
      if (preview) {
        const b = L.balances(out.loan);
        const item = { accountNo: r.accountNo, memberNo: r.memberNo, product: r.productId, status: out.loan.status, principal: Number(out.loan.principal),
          principalOutstanding: b.principal, interestOutstanding: b.interest, feesOutstanding: b.fees, penaltyOutstanding: b.penalty,
          arrearsSince: out.loan.arrears_since, disbursedOn: out.loan.disbursed_on, installments: out.installments };
        if ((preview.loans || []).length < PREVIEW_SCHEDULES) {
          item.schedule = (await c.query(
            `SELECT number, due_date, principal_due, principal_paid, interest_due, interest_paid, fee_due, fee_paid, status, late_fee_exempt
             FROM loan_installments WHERE loan_id = $1 ORDER BY number`, [out.loan.id])).rows;
        }
        push('loans', item);
      }
      return out.loan;
    });
    tick();
    if (ok) created.loans += 1;
  }

  // The opening balances, one entry on the migration date.
  let entryId = null;
  const sheetGl = new Map();
  const lines = openingLines(data);
  if (lines.length) {
    const posted = [];
    let good = true;
    const key = data.glBalances.length ? 'glBalances' : 'chart';
    for (const l of lines) {
      const ok = await row(key, l.row, key === 'glBalances' ? 'GL code' : 'GL Code', async () => {
        const { rows: [g] } = await c.query('SELECT code, type, usage FROM gl_accounts WHERE code = $1', [l.glCode]);
        if (!g) throw err(`No GL account ${l.glCode}, in the chart or on the GL Accounts sheet`);
        if (g.usage === 'HEADER') throw err(`GL account ${l.glCode} is a header account and takes no postings`);
        const bId = await branchId(l.branch);
        posted.push({ glCode: l.glCode, amount: l.amount, side: l.side, branchId: bId || null });
        sheetGl.set(l.glCode, round2((sheetGl.get(l.glCode) || 0) + (l.side === 'D' ? l.amount : -l.amount)));
        return true;
      });
      if (!ok) good = false;
    }
    if (good && posted.length) {
      const ok = await row(key, { _row: null }, null, async () => acct.post(c, {
        debits: posted.filter((x) => x.side === 'D'),
        credits: posted.filter((x) => x.side === 'C'),
        bookingDate: asOf,
        narration: 'Opening balances (data import)',
        sourceType: 'DATA_IMPORT', sourceId: importId, createdBy,
      }));
      if (ok) {
        entryId = ok.entryId; created.openingEntryLines = ok.lineCount;
        if (preview) preview.openingEntry = posted.map((x) => ({ glCode: x.glCode, debit: x.side === 'D' ? x.amount : 0, credit: x.side === 'C' ? x.amount : 0 }));
      }
    }
    // Subledgers against the opening balances: loan and overdraft
    // portfolios are debit balances, deposits and share capital credits.
    const compare = (map, sign, what) => {
      for (const [gl, t] of map) {
        const inSheet = round2((sheetGl.get(gl) || 0) * sign);
        if (round2(t) !== inSheet) {
          warnings.push({ sheet: layout[key]?.sheet || 'GL Balances', row: null, column: 'GL code',
            message: `${what} add up to ${round2(t)} on GL account ${gl}; the opening balances have ${inSheet}` });
        }
      }
    };
    compare(subledger.loans, 1, 'Loan principal outstanding');
    compare(subledger.overdrafts, 1, 'Overdrawn deposit accounts');
    compare(subledger.deposits, -1, 'Deposit balances');
    compare(subledger.shares, -1, 'Share capital');
  } else if (data.loans.length || data.deposits.length || data.shares.length) {
    warnings.push({ sheet: 'GL Balances', row: null, column: null,
      message: 'Accounts are imported with balances but there are no opening balances (GL Balances or Chart of Accounts): the general ledger will not show them until an opening entry is posted.' });
  }
  tick();
  return { errors, warnings, created, entryId };
}

/** Why a row failed, in the words of the sheet rather than the database. */
function explain(e) {
  if (e.code === '23505') {
    const k = String(e.detail || e.constraint || '');
    if (/member_no/.test(k)) return 'The member number is already in use';
    if (/account_no/.test(k)) return 'The account number is already in use';
    return `Already exists (${e.constraint || 'unique'})`;
  }
  if (e.code === '23503') return `Refers to something that does not exist (${e.constraint || 'foreign key'})`;
  if (e.code === '23514') return String(e.message).replace(/^new row .* violates check constraint/, 'A value is out of range:');
  return String(e.message || e).replace(/_/g, ' ').replace(/^([A-Z ]+):/, (m) => m.charAt(0) + m.slice(1).toLowerCase());
}

// --- the workbook people download ---------------------------------------------

/**
 * The template: Instructions and Settings, a sheet to fill in per kind of
 * record (green headings, with a column for every custom field defined for
 * it), and the reference sheets of what is already in the system (grey
 * headings; anything typed there is ignored).
 */
async function template(c, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const pre = await prerequisites(c);
  const defs = await CF.definitions(c, { includeInactive: false });
  const customFor = (entity) => defs
    .filter((d) => d.entity === entity && d.set_id && d.set_type !== 'GROUPED')
    .map((d) => `Custom: ${d.set_id}.${d.id} (${d.name}${d.field_type === 'CHECKBOX' ? ', True or False' : d.field_type === 'SELECTION' ? `, ${(d.options || []).map((o) => o.label || o.id).join('/')}` : ''})`);
  const intro = [
    ['Data import'],
    ['Fill in the sheets you need and leave the others empty. Columns marked * are required. Dates are dd.MM.yyyy or yyyy-MM-dd (or Excel dates). Amounts are plain numbers, no formulas or formatting.'],
    ['IDs are at most 32 characters and other text 255. Balances are as at the end of the migration date on the Settings sheet. Nothing is created until the upload is reviewed and approved.'],
    ['Sheets with green headings are for your data; those with grey headings list what is already in the system, to copy IDs from, and are not imported.'],
    [],
    ['Before you import', 'In place', 'Count', 'What it is for'],
    ...pre.map((p) => [p.item, p.ok ? 'yes' : 'no', p.count, p.detail]),
    [],
    ['Sheet', 'Column', 'Required', 'Notes'],
  ];
  const headRow = intro.length;
  for (const def of SHEETS) {
    if (def.note) intro.push([def.name, '', '', def.note]);
    for (const col of def.columns) {
      intro.push([def.name, col.h, col.req ? 'yes' : '', [col.map ? col.map.label : '', col.hint || '', col.type ? `(${col.type === 'signed' ? 'amount, may be negative' : col.type})` : '',
        col.a ? `Also read as: ${col.a.join(', ')}` : ''].filter(Boolean).join('. ')]);
    }
  }
  const sheets = [{ name: 'Instructions', rows: intro, headerRows: 0, widths: [24, 26, 10, 90],
    styles: { A1: 'bold', A6: 'bold', B6: 'bold', C6: 'bold', D6: 'bold', [`A${headRow}`]: 'bold', [`B${headRow}`]: 'bold', [`C${headRow}`]: 'bold', [`D${headRow}`]: 'bold' } }];
  sheets.push({ name: SETTINGS, rows: [['Setting', 'Value'], ['Migration date', today]], widths: [22, 16], headerStyle: 'input' });
  for (const def of SHEETS) {
    const headers = [...def.columns.map((col) => (col.req ? `${col.h}*` : col.h)), ...(def.custom ? customFor(def.custom) : [])];
    sheets.push({ name: def.name, rows: [headers], widths: headers.map((h) => Math.max(12, Math.min(40, h.length + 4))), headerStyle: 'input' });
  }
  // What the tenant already has, one reference sheet per kind (the reference platform).
  const ref = async (name, header, sql) => sheets.push({ name, rows: [header, ...(await c.query(sql)).rows.map((x) => Object.values(x))],
    widths: header.map(() => 22), headerStyle: 'reference' });
  await ref('Branches Data', ['Branch ID', 'Name', 'Town', 'Status'], 'SELECT code, name, town, status FROM branches ORDER BY code');
  await ref('Centres Data', ['Centre ID', 'Name', 'Branch ID', 'Status'], 'SELECT ce.code, ce.name, b.code AS branch, ce.status FROM centres ce JOIN branches b ON b.id = ce.branch_id ORDER BY ce.code');
  await ref('Credit Officers', ['Username (email)', 'Name', 'Role', 'Branch ID'],
    `SELECT u.email, u.full_name, u.role, b.code FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
     LEFT JOIN branches b ON b.id = u.branch_id WHERE t.schema_name = current_schema() AND u.status = 'ACTIVE' ORDER BY lower(u.email)`);
  await ref('Loan Products', ['Product ID', 'Name', 'Type', 'Repays every', 'Rate', 'Installments'],
    `SELECT id, name, product_type, repayment_interval_count || ' ' || lower(repayment_interval_unit), monthly_rate, COALESCE(min_term::text || '-', '') || max_term
     FROM loan_products WHERE is_active ORDER BY id`);
  await ref('Deposit Products', ['Product ID', 'Name', 'Annual rate', 'Overdraft'],
    "SELECT id, name, annual_rate, CASE WHEN allow_overdraft THEN 'yes' ELSE 'no' END FROM savings_products WHERE is_active ORDER BY id");
  await ref('Share Products', ['Product ID', 'Name', 'Unit price'], 'SELECT id, name, unit_price FROM share_products WHERE is_active ORDER BY id');
  await ref('GL Accounts Data', ['GL Code', 'Name', 'Type', 'Usage'], 'SELECT code, name, type, usage FROM gl_accounts WHERE is_active ORDER BY code');
  await ref('ID Templates', ['ID type', 'Issuing authority', 'Format', 'Mandatory'],
    "SELECT id_type, issuing_authority, mask, CASE WHEN mandatory THEN 'yes' ELSE 'no' END FROM id_templates ORDER BY id_type");
  return XLSX.write(sheets);
}

/**
 * The uploaded workbook back with its errors (the reference platform): each offending cell
 * red, an Errors column on the sheet saying what to fix, and an Errors sheet
 * last listing them all.
 */
function errorWorkbook(buffer, errors) {
  const book = XLSX.read(buffer);
  const bySheet = groupBy(errors, (x) => norm(x.sheet));
  const out = [];
  for (const sh of book) {
    if (norm(sh.name) === 'errors') continue;
    const errs = bySheet.get(norm(sh.name)) || [];
    const width = Math.max(0, ...sh.rows.map((r) => r.length));
    const styles = {};
    const noteCol = XLSX.colName(width);
    const header = (sh.rows[0] || []).map(norm);
    const rows = sh.rows.map((r, i) => {
      const mine = errs.filter((x) => x.row === i + 1 || (i === 0 && x.row === null));
      const cells = [...r, ...Array(Math.max(0, width - r.length)).fill(null)];
      if (i === 0 && errs.length) cells.push('Errors');
      else if (mine.length) {
        cells.push(mine.map((x) => x.message).join('; '));
        styles[`${noteCol}${i + 1}`] = 'error';
        for (const x of mine) {
          const at = x.index ?? (x.column ? header.indexOf(norm(x.column)) : -1);
          if (at !== null && at >= 0) styles[`${XLSX.colName(at)}${i + 1}`] = 'bad';
        }
      }
      return cells;
    });
    out.push({ name: sh.name, rows, styles });
  }
  out.push({
    name: 'Errors',
    rows: [['Sheet', 'Row', 'Column', 'Error'], ...errors.map((x) => [x.sheet, x.row, x.column, x.message])],
    widths: [20, 8, 22, 90],
  });
  return XLSX.write(out);
}

// --- the life of an import ------------------------------------------------------

const PUBLIC = `id, file_name, file_size, sha256, status, as_of, summary, errors, warnings, entry_id, progress, progress_at,
                started_at, finished_at, created_by, created_at, decided_by, decided_at, decision_note,
                (error_file IS NOT NULL) AS has_error_file, (preview IS NOT NULL) AS has_preview,
                CASE status WHEN 'PENDING_APPROVAL' THEN 'DRAFT' WHEN 'REJECTED' THEN 'REVERTED' ELSE status END AS import_state`;
const STALE_MINUTES = 30;

/** Store an upload, QUEUED for the background run (./ops/importRunner). */
async function submit(c, { buffer, fileName }, { createdBy }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw err('SEND_THE_WORKBOOK_AS_THE_REQUEST_BODY');
  if (buffer.length > MAX_FILE) throw err(`FILE_TOO_LARGE: the limit is ${MAX_FILE} bytes`, 413);
  const name = String(fileName || 'import.xlsx').replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 200);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const { rows: [imp] } = await c.query(
    `INSERT INTO data_imports (file_name, file_size, sha256, status, file, created_by)
     VALUES ($1,$2,$3,'QUEUED',$4,$5) RETURNING ${PUBLIC}`, [name, buffer.length, sha256, buffer, createdBy]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DATA_IMPORT_UPLOADED','data_import',$2,$3)`,
    [createdBy, imp.id, JSON.stringify({ fileName: name, size: buffer.length })]);
  return imp;
}

/**
 * The validation run for a QUEUED import: check the workbook, run the
 * import in a savepoint and roll it back, and record the outcome with the
 * preview. `progress(percent)` is called as it goes (the runner writes it
 * on its own connection so it can be seen while this transaction is open).
 */
async function validate(c, id, { user, today, progress = null }) {
  // Not locked: the runner writes progress to this row from another
  // connection while this transaction is open.
  const { rows: [imp] } = await c.query('SELECT * FROM data_imports WHERE id = $1', [id]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  if (!['QUEUED', 'IN_PROGRESS'].includes(imp.status)) return get(c, id);
  let parsed;
  try {
    parsed = parse(imp.file, { today });
  } catch (e) {
    parsed = { asOf: null, data: null, counts: {}, errors: [{ sheet: null, row: null, column: null, message: explain(e) }], warnings: [], layout: {} };
  }
  if (progress) progress(10);
  let run = { errors: [], warnings: [], created: {} };
  const preview = {};
  if (!parsed.errors.length) {
    const pre = await prerequisites(c);
    const need = {
      'Loan products': parsed.data.loans.length, 'Deposit products': parsed.data.deposits.length,
      Branches: parsed.data.members.some((r) => r.branch) && !parsed.data.branches.length,
      'Users (credit officers)': parsed.data.members.some((r) => r.creditOfficer),
    };
    for (const p of pre) {
      if (!p.ok && need[p.item]) parsed.warnings.push({ sheet: null, row: null, column: null, message: `Prerequisite missing: ${p.item} (${p.detail})` });
    }
    await c.query('SAVEPOINT import_dry_run');
    try {
      run = await execute(c, parsed, {
        importId: id, createdBy: imp.created_by, user, preview,
        onProgress: progress ? (done, total) => progress(10 + Math.floor((85 * done) / total)) : null,
      });
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT import_dry_run');
    }
  }
  const errors = [...parsed.errors, ...run.errors];
  const warnings = [...parsed.warnings, ...run.warnings];
  const status = errors.length ? (parsed.data ? 'INVALID' : 'ERROR') : 'PENDING_APPROVAL';
  let errorFile = null;
  if (errors.length && parsed.data) {
    try { errorFile = errorWorkbook(imp.file, errors); } catch { errorFile = null; }
  }
  const summary = { rows: parsed.counts, creates: errors.length ? null : run.created };
  const { rows: [out] } = await c.query(
    `UPDATE data_imports SET status = $2, as_of = $3, summary = $4, errors = $5, warnings = $6, error_file = $7, pending = $8,
       preview = $9, progress = 100, progress_at = now(), finished_at = now()
     WHERE id = $1 RETURNING ${PUBLIC}`,
    [id, status, parsed.asOf, JSON.stringify(summary), JSON.stringify(errors.slice(0, 5000)), JSON.stringify(warnings), errorFile,
      status === 'PENDING_APPROVAL' ? JSON.stringify({ asOf: parsed.asOf, data: parsed.data, layout: parsed.layout }) : null,
      status === 'PENDING_APPROVAL' ? JSON.stringify(preview) : null]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DATA_IMPORT_VALIDATED','data_import',$2,$3)`,
    [imp.created_by, id, JSON.stringify({ status, errors: errors.length })]);
  return out;
}

/** Upload and validate in one transaction (the CLI, and callers that wait). */
async function upload(c, { buffer, fileName }, { createdBy, user, today }) {
  const imp = await submit(c, { buffer, fileName }, { createdBy });
  return validate(c, imp.id, { user, today });
}

async function lockImport(c, id) {
  const { rows: [imp] } = await c.query('SELECT * FROM data_imports WHERE id::text = $1 FOR UPDATE', [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  return imp;
}

/**
 * Approve: run it again and commit, all or nothing. Under the four-eyes rule
 * (lending controls, two_man_rule) the person who uploaded it may not
 * approve it. If anything fails now (someone opened member M000123 since the
 * upload), nothing is created and the import is FAILED with the reasons,
 * returned as { failed: true, errors, import }.
 */
async function approve(c, id, { createdBy, user, note = null }) {
  const imp = await lockImport(c, id);
  if (imp.status !== 'PENDING_APPROVAL') throw err(`IMPORT_IS_${imp.status}`, 409);
  const { rows: [ctl] } = await c.query('SELECT two_man_rule FROM lending_controls LIMIT 1');
  if (ctl && ctl.two_man_rule && imp.created_by === createdBy) throw err('FOUR_EYES: the person who uploaded an import may not approve it', 409);
  await c.query('SAVEPOINT import_approve');
  const run = await execute(c, imp.pending, { importId: imp.id, createdBy, user });
  if (run.errors.length) {
    await c.query('ROLLBACK TO SAVEPOINT import_approve');
    await c.query(
      `UPDATE data_imports SET status = 'FAILED', errors = $2, error_file = $3, decided_by = $4, decided_at = now(), decision_note = $5
       WHERE id = $1`,
      [imp.id, JSON.stringify(run.errors), (() => { try { return errorWorkbook(imp.file, run.errors); } catch { return null; } })(), createdBy, note]);
    await c.query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DATA_IMPORT_FAILED','data_import',$2,$3)`,
      [createdBy, imp.id, JSON.stringify({ errors: run.errors.length })]);
    // Returned, not thrown: the FAILED record must be committed, the data not.
    return { failed: true, errors: run.errors, import: await get(c, imp.id) };
  }
  const { rows: [out] } = await c.query(
    `UPDATE data_imports SET status = 'APPROVED', summary = summary || jsonb_build_object('created', $2::jsonb), warnings = $3,
       entry_id = $4, pending = NULL, decided_by = $5, decided_at = now(), decision_note = $6
     WHERE id = $1 RETURNING ${PUBLIC}`,
    [imp.id, JSON.stringify(run.created), JSON.stringify(run.warnings), run.entryId, createdBy, note]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DATA_IMPORT_APPROVED','data_import',$2,$3)`,
    [createdBy, imp.id, JSON.stringify(run.created)]);
  return out;
}

async function reject(c, id, { createdBy, note = null }) {
  const imp = await lockImport(c, id);
  if (!['PENDING_APPROVAL', 'INVALID'].includes(imp.status)) throw err(`IMPORT_IS_${imp.status}`, 409);
  const { rows: [out] } = await c.query(
    `UPDATE data_imports SET status = 'REJECTED', pending = NULL, preview = NULL, decided_by = $2, decided_at = now(), decision_note = $3
     WHERE id = $1 RETURNING ${PUBLIC}`, [imp.id, createdBy, note]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DATA_IMPORT_REJECTED','data_import',$2,$3)`,
    [createdBy, imp.id, JSON.stringify({ note })]);
  return out;
}

/** A run that stopped moving (the process went away) is not left IN_PROGRESS for ever. */
async function markStale(c) {
  await c.query(
    `UPDATE data_imports SET status = 'ERROR', finished_at = now(),
       errors = '[{"sheet":null,"row":null,"column":null,"message":"The validation run was interrupted; upload the file again"}]'
     WHERE status IN ('QUEUED', 'IN_PROGRESS') AND COALESCE(progress_at, created_at) < now() - make_interval(mins => $1)`, [STALE_MINUTES]);
}

async function list(c, { limit = 50 } = {}) {
  const { rows } = await c.query(`SELECT ${PUBLIC} FROM data_imports ORDER BY created_at DESC LIMIT $1`, [Math.min(200, Number(limit) || 50)]);
  return rows;
}

async function get(c, id) {
  const { rows: [imp] } = await c.query(`SELECT ${PUBLIC} FROM data_imports WHERE id::text = $1`, [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  return imp;
}

/**
 * The preview, one kind of record at a time and paged: what approval would
 * create, as it will be (the reference platform shows the draft data in its screens; here
 * nothing exists before approval, so the validation run keeps a copy).
 */
async function previewOf(c, id, { kind = null, offset = 0, limit = 50 } = {}) {
  const { rows: [imp] } = await c.query('SELECT status, preview FROM data_imports WHERE id::text = $1', [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  if (!imp.preview) throw err(`NO_PREVIEW: the import is ${imp.status}`, 409);
  const kinds = Object.fromEntries(Object.entries(imp.preview).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
  if (!kind) return { kinds };
  if (!(kind in imp.preview)) throw err(`UNKNOWN_KIND: ${Object.keys(imp.preview).join(', ')}`, 404);
  const all = imp.preview[kind] || [];
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(500, Math.max(1, Number(limit) || 50));
  return { kind, total: all.length, offset: off, limit: lim, items: all.slice(off, off + lim) };
}

async function fileOf(c, id, which) {
  const col = which === 'errors' ? 'error_file' : 'file';
  const { rows: [imp] } = await c.query(`SELECT file_name, ${col} AS data FROM data_imports WHERE id::text = $1`, [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  if (!imp.data) throw err('NO_ERROR_FILE', 404);
  return { fileName: which === 'errors' ? imp.file_name.replace(/(\.xlsx)?$/i, '-errors.xlsx') : imp.file_name, data: imp.data };
}

/**
 * The import in the reference platform's terms (GET /data/import/{importKey}): the job's
 * state, the event to approve or reject once validation has passed, and the
 * errors with the sheet, row and column (name and position).
 */
function apiStatus(imp) {
  const running = ['QUEUED', 'IN_PROGRESS'].includes(imp.status);
  const state = running ? imp.status : imp.status === 'ERROR' ? 'ERROR' : 'COMPLETE';
  return {
    importKey: imp.id,
    state,
    progress: imp.progress,
    eventKey: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'FAILED'].includes(imp.status) ? imp.id : null,
    importState: imp.import_state,
    errors: (imp.errors || []).map((x) => ({
      sheet: x.sheet, row: x.row, column: x.column || x.index !== undefined ? { name: x.column || null, index: x.index ?? null } : null, errorMessage: x.message,
    })),
  };
}

module.exports = {
  SHEETS, REFERENCE_SHEETS, parse, execute, template, errorWorkbook, prerequisites, submit, validate, upload, approve, reject,
  list, get, previewOf, fileOf, markStale, apiStatus, isoDate, MAX_FILE,
};
