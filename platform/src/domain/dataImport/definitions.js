'use strict';

/**
 * The Excel data import: the workbook's sheets, their columns, and converting a cell.
 */

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
 * Upload. The file is stored and the work runs in the background (../../ops
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
 * are built by ../loanMigration, which the reference platform's external migration API uses
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
    { h: 'Group ID', k: 'groupId', a: ['Group IDs'], hint: 'The groups the member belongs to (Groups sheet or already in the system), comma separated' },
    { h: 'Group role', k: 'groupRole', a: ['Group Role Name', 'Group roles'], hint: 'Role name IDs or names in those groups, comma separated' },
    { h: 'Joined on', k: 'joinedOn', type: 'date', a: ['Date Joined'], hint: 'Default: the migration date' },
    { h: 'Status', k: 'status', map: lookup({ ACTIVE: 'INACTIVE', INACTIVE: 'INACTIVE', DORMANT: 'INACTIVE', EXITED: 'EXITED' },
      'Active, Inactive, Dormant or Exited'), hint: 'Default Active. Active and Inactive follow the member\'s accounts' },
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
  { key: 'groups', name: 'Groups', columns: [
    { h: 'Group ID', k: 'groupNo', req: true, id: true },
    { h: 'Group name', k: 'name', req: true, a: ['Name'] },
    { h: 'Group type', k: 'type', id: true, a: ['Group Role', 'Type'], hint: 'A group type ID (Group Types sheet); blank: the default' },
    { h: 'Branch ID', k: 'branch', id: true }, { h: 'Centre ID', k: 'centre', id: true },
    { h: 'Credit officer', k: 'creditOfficer', a: ['Credit Officer username', 'Credit Officer'], hint: 'The staff user\'s email (Credit Officers sheet)' },
    { h: 'Phone', k: 'phone', a: ['Mobile Phone', 'Mobile'] }, { h: 'Other phone', k: 'phone2', a: ['Home Phone'] },
    { h: 'Email', k: 'email', a: ['Email Address'] },
    { h: 'Address line 1', k: 'addressLine1', a: ['Address 1'] }, { h: 'Address line 2', k: 'addressLine2', a: ['Address 2'] },
    { h: 'City', k: 'city' }, { h: 'Postcode', k: 'postcode', a: ['Zip'] }, { h: 'Region', k: 'region', a: ['State/Province/Region'] }, { h: 'Country', k: 'country' },
    { h: 'Notes', k: 'notes', notes: true },
  ], custom: 'GROUP' },
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
    { h: 'Client type', k: 'clientType', map: lookup({ C: 'C', G: 'G' }, 'C (member) or G (group)'), hint: 'C (default) or G: the Member number is then a Group ID' },
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

Object.assign(module.exports, {
  MAX_FILE, MAX_ROWS, MAX_ID, MAX_TEXT, MAX_NOTES, PREVIEW_SCHEDULES, GL_TYPES, USAGE, GENDER, DAY, STATE, TX, PERIOD, lookup, SHEETS, SETTINGS, REFERENCE_SHEETS, norm, blank, round2, isoDate, convert, groupBy, sum, given, readHeader,
});
