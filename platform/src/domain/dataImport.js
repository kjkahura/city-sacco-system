'use strict';

const crypto = require('crypto');
const XLSX = require('../lib/xlsx');
const acct = require('./accounting');
const L = require('./loans');
const SV = require('./savings');
const SH = require('./shares');
const B = require('./branches');
const CF = require('./customFields');
const workflow = require('./workflow');

/**
 * The Excel data import (the reference platform's Data Importing): a SACCO moving onto the
 * platform fills in one workbook with its chart of accounts, branches,
 * centres, members, deposit accounts, share accounts, loans with their
 * schedules, and its opening trial balance; uploads it; and someone reviews
 * and approves it.
 *
 * Upload. The workbook is read and every cell checked: required values,
 * dates as yyyy-MM-dd, amounts, codes that exist, numbers used twice. Then
 * the whole import is run for real inside a savepoint and rolled back, so
 * whatever the database itself would refuse (a product band, a duplicate
 * account number, a closed accounting period) is found now, row by row,
 * rather than at approval. An import with errors is INVALID and comes with
 * the workbook back, an Errors column on every sheet saying what to fix.
 * One without is PENDING_APPROVAL, with what it will create and any
 * warnings for the reviewer.
 *
 * Nothing reaches the live tables before approval, so nothing waits to be
 * left out of the end of day, and a rejected import leaves no trace but its
 * record. Approval runs the import again and commits it all or none of it.
 *
 * Balances are as at the end of the migration date (Settings sheet). A
 * deposit account opens with its balance, a share account with its units,
 * and a loan active with what is still owed, its schedule either given
 * (Loan Schedule sheet) or drawn by the product from the disbursement date
 * with the principal repaid applied to the oldest installments first.
 * Interest accrues from the migration date. An installment already late at
 * the migration date is exempt from the late repayment fee and its penalty
 * counts from the migration date (a forfeited marker covers the days
 * before), because the old system charged, or did not charge, for those
 * days. The account balances post nothing to the general ledger; the GL
 * Balances sheet is the opening trial balance and is posted as one entry
 * on the migration date. The reviewer is warned where a subledger total
 * does not match its GL account in that sheet.
 */

const MAX_FILE = 5 * 1024 * 1024;
const MAX_ROWS = 20000;
const err = (m, status = 400) => Object.assign(new Error(m), { status });

const GL_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

// The workbook: each sheet, its columns, and what each column holds.
// `custom` sheets also take custom field columns headed "Custom: _setId.fieldId".
const SHEETS = [
  { key: 'glAccounts', name: 'GL Accounts', note: 'Accounts to add to the chart of accounts. Parents first, or in the chart already.', columns: [
    { h: 'Code', k: 'code', req: true, hint: 'Unique, e.g. 100-150' },
    { h: 'Name', k: 'name', req: true },
    { h: 'Type', k: 'type', req: true, oneOf: GL_TYPES },
    { h: 'Parent code', k: 'parentCode' },
    { h: 'Usage', k: 'usage', oneOf: ['DETAIL', 'HEADER'], hint: 'DETAIL (default) takes postings; HEADER groups' },
  ] },
  { key: 'branches', name: 'Branches', columns: [
    { h: 'Branch ID', k: 'code', req: true, hint: '2 to 16 uppercase letters, digits, - or _' },
    { h: 'Name', k: 'name', req: true },
    { h: 'Town', k: 'town' }, { h: 'Phone', k: 'phone' }, { h: 'Email', k: 'email' },
    { h: 'Address', k: 'address' }, { h: 'Notes', k: 'notes' },
  ], custom: true },
  { key: 'centres', name: 'Centres', columns: [
    { h: 'Centre ID', k: 'code', req: true },
    { h: 'Name', k: 'name', req: true },
    { h: 'Branch ID', k: 'branch', req: true },
    { h: 'Meeting day', k: 'meetingDay', hint: 'Monday to Sunday, or blank' },
    { h: 'Address', k: 'address' }, { h: 'Notes', k: 'notes' },
  ], custom: true },
  { key: 'members', name: 'Members', columns: [
    { h: 'Member number', k: 'memberNo', req: true },
    { h: 'First name', k: 'firstName', req: true },
    { h: 'Middle name', k: 'middleName' },
    { h: 'Last name', k: 'lastName', req: true },
    { h: 'National ID', k: 'nationalId' }, { h: 'KRA PIN', k: 'kraPin' },
    { h: 'Phone', k: 'phone' }, { h: 'Phone 2', k: 'phone2' }, { h: 'Email', k: 'email' },
    { h: 'Date of birth', k: 'dateOfBirth', type: 'date' },
    { h: 'Gender', k: 'gender', oneOf: ['MALE', 'FEMALE', 'OTHER'] },
    { h: 'Employer', k: 'employer' },
    { h: 'Branch ID', k: 'branch' }, { h: 'Centre ID', k: 'centre' },
    { h: 'Joined on', k: 'joinedOn', type: 'date', hint: 'Default: the migration date' },
    { h: 'Status', k: 'status', oneOf: ['ACTIVE', 'DORMANT', 'EXITED'], hint: 'Default ACTIVE' },
    { h: 'Address line 1', k: 'addressLine1' }, { h: 'Address line 2', k: 'addressLine2' },
    { h: 'City', k: 'city' }, { h: 'Postcode', k: 'postcode' }, { h: 'Region', k: 'region' }, { h: 'Country', k: 'country' },
    { h: 'Credit officer', k: 'creditOfficer', hint: 'Email of the staff user' },
    { h: 'Prior loan cycles', k: 'priorLoanCycles', type: 'int', hint: 'Loans repaid in full in the old system' },
    { h: 'Notes', k: 'notes' },
  ], custom: true },
  { key: 'deposits', name: 'Deposit Accounts', columns: [
    { h: 'Account number', k: 'accountNo', req: true },
    { h: 'Member number', k: 'memberNo', req: true },
    { h: 'Product ID', k: 'productId', req: true },
    { h: 'Balance', k: 'balance', type: 'amount', req: true, hint: 'At the end of the migration date' },
    { h: 'Opened on', k: 'openedOn', type: 'date' },
    { h: 'Branch ID', k: 'branch', hint: "Default: the member's" },
    { h: 'Overdraft limit', k: 'overdraftLimit', type: 'amount' },
  ], custom: true },
  { key: 'shares', name: 'Share Accounts', columns: [
    { h: 'Account number', k: 'accountNo', req: true },
    { h: 'Member number', k: 'memberNo', req: true },
    { h: 'Product ID', k: 'productId', req: true },
    { h: 'Units', k: 'units', type: 'number', req: true },
  ] },
  { key: 'loans', name: 'Loan Accounts', columns: [
    { h: 'Account number', k: 'accountNo', req: true },
    { h: 'Member number', k: 'memberNo', req: true },
    { h: 'Product ID', k: 'productId', req: true },
    { h: 'Principal', k: 'principal', type: 'amount', req: true, hint: 'As disbursed' },
    { h: 'Installments', k: 'installments', type: 'int', req: true },
    { h: 'Interest rate', k: 'rate', type: 'number', hint: "In the product's rate frequency; default: the product's" },
    { h: 'Disbursed on', k: 'disbursedOn', type: 'date', req: true },
    { h: 'Principal outstanding', k: 'principalOutstanding', type: 'amount', req: true },
    { h: 'Interest outstanding', k: 'interestOutstanding', type: 'amount', hint: 'Accrued and unpaid' },
    { h: 'Fees outstanding', k: 'feesOutstanding', type: 'amount' },
    { h: 'Penalty outstanding', k: 'penaltyOutstanding', type: 'amount' },
    { h: 'Branch ID', k: 'branch', hint: "Default: the member's" },
    { h: 'Purpose', k: 'purpose' }, { h: 'Notes', k: 'notes' },
  ], custom: true },
  { key: 'schedule', name: 'Loan Schedule', note: 'Optional. A loan with rows here takes this schedule; one without is given the product\'s.', columns: [
    { h: 'Account number', k: 'accountNo', req: true },
    { h: 'Installment', k: 'number', type: 'int', req: true },
    { h: 'Due date', k: 'dueDate', type: 'date', req: true },
    { h: 'Principal due', k: 'principalDue', type: 'amount', req: true },
    { h: 'Interest due', k: 'interestDue', type: 'amount', req: true },
    { h: 'Fees due', k: 'feesDue', type: 'amount' },
    { h: 'Principal paid', k: 'principalPaid', type: 'amount' },
    { h: 'Interest paid', k: 'interestPaid', type: 'amount' },
    { h: 'Fees paid', k: 'feesPaid', type: 'amount' },
  ] },
  { key: 'glBalances', name: 'GL Balances', note: 'The opening trial balance, posted as one entry on the migration date. Debits must equal credits.', columns: [
    { h: 'GL code', k: 'glCode', req: true },
    { h: 'Debit', k: 'debit', type: 'amount' },
    { h: 'Credit', k: 'credit', type: 'amount' },
    { h: 'Branch ID', k: 'branch' },
  ] },
];
const SETTINGS = 'Settings';

const norm = (s) => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function convert(v, col) {
  if (blank(v)) return { value: null };
  const type = col.type || 'text';
  if (type === 'text') {
    let s = typeof v === 'number' ? String(v) : String(v).trim();
    if (col.oneOf) {
      s = s.toUpperCase();
      if (!col.oneOf.includes(s)) return { error: `must be one of ${col.oneOf.join(', ')}` };
    }
    return { value: s };
  }
  if (type === 'date') {
    const s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: 'must be a date, yyyy-MM-dd' };
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { error: 'is not a real date' };
    return { value: s };
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return { error: 'must be a number' };
  if (type === 'amount') {
    if (n < 0) return { error: 'cannot be negative' };
    if (Math.abs(round2(n) - n) > 1e-9) return { error: 'has more than two decimals' };
    return { value: round2(n) };
  }
  if (type === 'int') {
    if (!Number.isInteger(n) || n < 0) return { error: 'must be a whole number, zero or more' };
    return { value: n };
  }
  return { value: n };
}

/**
 * Read and check the workbook on its own, before the database is asked
 * anything. Returns the rows by sheet, the migration date and the errors.
 */
function parse(buffer, { today }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw err('EMPTY_FILE');
  if (buffer.length > MAX_FILE) throw err(`FILE_TOO_LARGE: the limit is ${MAX_FILE} bytes`, 413);
  const book = XLSX.read(buffer);
  const errors = [];
  const warnings = [];
  const e = (sheet, row, column, message) => errors.push({ sheet, row, column, message });
  const byName = new Map(book.map((s) => [norm(s.name), s]));

  // Settings: key/value rows.
  let asOf = null;
  const settings = byName.get(norm(SETTINGS));
  if (!settings) e(SETTINGS, null, null, 'The Settings sheet is missing; it gives the migration date.');
  else {
    for (let i = 0; i < settings.rows.length; i += 1) {
      const [k, v] = settings.rows[i] || [];
      if (norm(k) === 'migration date') {
        const r = convert(v, { type: 'date' });
        if (r.error || !r.value) e(SETTINGS, i + 1, 'Migration date', r.error ? `Migration date ${r.error}` : 'Migration date is required');
        else asOf = r.value;
      }
    }
    if (!asOf && !errors.some((x) => x.sheet === SETTINGS)) e(SETTINGS, null, 'Migration date', 'Migration date is required');
    if (asOf && asOf > today) e(SETTINGS, null, 'Migration date', `Migration date ${asOf} is after today (${today})`);
  }

  const data = {};
  const counts = {};
  for (const def of SHEETS) {
    data[def.key] = [];
    const sh = byName.get(norm(def.name));
    if (!sh || !sh.rows.length) continue;
    const header = (sh.rows[0] || []).map(norm);
    const idx = {};
    const custom = [];
    header.forEach((h, i) => {
      if (!h) return;
      const col = def.columns.find((c) => norm(c.h) === h);
      if (col) idx[col.k] = i;
      else if (def.custom && h.startsWith('custom:')) {
        const [setId, fieldId] = String(sh.rows[0][i]).replace(/^\s*custom:\s*/i, '').replace(/\*/g, '').trim().split('.');
        if (setId && fieldId) custom.push({ i, setId, fieldId });
        else e(def.name, 1, sh.rows[0][i], 'A custom field column is headed "Custom: _setId.fieldId"');
      } else warnings.push({ sheet: def.name, row: 1, column: sh.rows[0][i], message: 'Column not recognised; ignored.' });
    });
    for (const col of def.columns.filter((c) => c.req && idx[c.k] === undefined)) e(def.name, 1, col.h, `Column "${col.h}" is missing`);
    if (def.columns.some((c) => c.req && idx[c.k] === undefined)) continue;
    const body = sh.rows.slice(1);
    if (body.length > MAX_ROWS) { e(def.name, null, null, `More than ${MAX_ROWS} rows`); continue; }
    body.forEach((cells, n) => {
      const rowNo = n + 2;
      if (!cells || cells.every(blank)) return;
      const row = { _row: rowNo };
      for (const col of def.columns) {
        const raw = idx[col.k] === undefined ? null : cells[idx[col.k]];
        const r = convert(raw, col);
        if (r.error) e(def.name, rowNo, col.h, `${col.h} ${r.error}`);
        else if (col.req && r.value === null) e(def.name, rowNo, col.h, `${col.h} is required`);
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
  }

  // Within the file: numbers used twice, references to rows not there,
  // amounts that cannot be right.
  const dupes = (key, field, label) => {
    const seen = new Map();
    const def = SHEETS.find((s) => s.key === key);
    for (const r of data[key]) {
      const v = typeof r[field] === 'string' ? r[field].toUpperCase() : r[field];
      if (v === null) continue;
      if (seen.has(v)) e(def.name, r._row, label, `${label} ${r[field]} is also on row ${seen.get(v)}`);
      else seen.set(v, r._row);
    }
  };
  dupes('glAccounts', 'code', 'Code');
  dupes('branches', 'code', 'Branch ID');
  dupes('centres', 'code', 'Centre ID');
  dupes('members', 'memberNo', 'Member number');
  dupes('deposits', 'accountNo', 'Account number');
  dupes('shares', 'accountNo', 'Account number');
  dupes('loans', 'accountNo', 'Account number');
  {
    const seen = new Map();
    for (const r of data.schedule) {
      const k = `${r.accountNo}#${r.number}`;
      if (seen.has(k)) e('Loan Schedule', r._row, 'Installment', `Installment ${r.number} of ${r.accountNo} is also on row ${seen.get(k)}`);
      else seen.set(k, r._row);
    }
  }
  for (const r of data.branches) if (r.code) r.code = r.code.toUpperCase();
  for (const r of data.centres) {
    if (r.code) r.code = r.code.toUpperCase();
    if (r.branch) r.branch = r.branch.toUpperCase();
    if (r.meetingDay) {
      const d = DAYS.indexOf(r.meetingDay.toUpperCase());
      if (d < 0) e('Centres', r._row, 'Meeting day', 'Meeting day must be a day of the week');
      else r.meetingDay = d;
    }
  }
  const later = (sheet, r, field, label) => {
    if (asOf && r[field] && r[field] > asOf) e(sheet, r._row, label, `${label} ${r[field]} is after the migration date ${asOf}`);
  };
  for (const r of data.members) { later('Members', r, 'joinedOn', 'Joined on'); later('Members', r, 'dateOfBirth', 'Date of birth'); }
  for (const r of data.deposits) later('Deposit Accounts', r, 'openedOn', 'Opened on');
  const loanNos = new Set(data.loans.map((r) => r.accountNo));
  for (const r of data.loans) {
    later('Loan Accounts', r, 'disbursedOn', 'Disbursed on');
    if (r.principal !== null && r.principalOutstanding !== null && r.principalOutstanding > r.principal) {
      e('Loan Accounts', r._row, 'Principal outstanding', 'Principal outstanding is more than the principal');
    }
    if (r.installments === 0) e('Loan Accounts', r._row, 'Installments', 'Installments must be at least 1');
  }
  for (const r of data.schedule) {
    if (r.accountNo && !loanNos.has(r.accountNo)) e('Loan Schedule', r._row, 'Account number', `No loan ${r.accountNo} on the Loan Accounts sheet`);
    for (const [paid, due, label] of [['principalPaid', 'principalDue', 'Principal'], ['interestPaid', 'interestDue', 'Interest'], ['feesPaid', 'feesDue', 'Fees']]) {
      if ((r[paid] || 0) > (r[due] || 0)) e('Loan Schedule', r._row, `${label} paid`, `${label} paid is more than ${label.toLowerCase()} due`);
    }
  }
  // Each loan's schedule must add up to the loan.
  const sched = groupBy(data.schedule, (r) => r.accountNo);
  for (const r of data.loans) {
    const rows = sched.get(r.accountNo);
    if (!rows || r.principal === null) continue;
    const due = round2(sum(rows, 'principalDue'));
    const paid = round2(sum(rows, 'principalPaid'));
    if (due !== r.principal) e('Loan Accounts', r._row, 'Principal', `The schedule's principal due adds up to ${due}, not ${r.principal}`);
    if (r.principalOutstanding !== null && round2(due - paid) !== r.principalOutstanding) {
      e('Loan Accounts', r._row, 'Principal outstanding', `The schedule leaves ${round2(due - paid)} principal unpaid, not ${r.principalOutstanding}`);
    }
    const feesLeft = round2(sum(rows, 'feesDue') - sum(rows, 'feesPaid'));
    if (r.feesOutstanding !== null && feesLeft !== r.feesOutstanding) {
      e('Loan Accounts', r._row, 'Fees outstanding', `The schedule leaves ${feesLeft} fees unpaid, not ${r.feesOutstanding}`);
    }
    const numbers = rows.map((x) => x.number).sort((a, b) => a - b);
    if (numbers.some((n, i) => n !== i + 1)) e('Loan Accounts', r._row, 'Account number', 'The schedule\'s installments must be numbered 1, 2, 3 without gaps');
    if (rows.length !== r.installments) e('Loan Accounts', r._row, 'Installments', `The schedule has ${rows.length} installments, not ${r.installments}`);
  }
  // The opening trial balance.
  let dr = 0;
  let cr = 0;
  for (const r of data.glBalances) {
    if ((r.debit || 0) > 0 && (r.credit || 0) > 0) e('GL Balances', r._row, 'Debit', 'A line is a debit or a credit, not both');
    if (!(r.debit > 0) && !(r.credit > 0)) e('GL Balances', r._row, 'Debit', 'A line needs a debit or a credit');
    dr += r.debit || 0;
    cr += r.credit || 0;
  }
  if (round2(dr) !== round2(cr)) e('GL Balances', null, null, `Debits (${round2(dr)}) do not equal credits (${round2(cr)})`);

  return { asOf, data, counts, errors, warnings };
}

/** The fields a row gave, without the blanks. */
const given = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

function groupBy(list, f) {
  const m = new Map();
  for (const x of list) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
const sum = (list, k) => list.reduce((t, x) => t + Number(x[k] || 0), 0);

/**
 * Run the import against the database. Every row runs in its own savepoint
 * so one bad row is reported and the rest still tried; a row that depends
 * on one that failed (a loan for a member who did not import) says so. The
 * caller decides what happens to the whole: rolled back (validation) or
 * committed (approval, only when there are no errors).
 */
async function execute(c, { asOf, data }, { importId, createdBy, user }) {
  const errors = [];
  const warnings = [];
  const created = { glAccounts: 0, branches: 0, centres: 0, members: 0, deposits: 0, shares: 0, loans: 0, installments: 0, openingEntryLines: 0 };
  const failed = { member: new Map(), branch: new Map(), loan: new Map() };
  const members = new Map();
  let sp = 0;
  const row = async (sheet, r, column, fn) => {
    sp += 1;
    const name = `import_row_${sp}`;
    await c.query(`SAVEPOINT ${name}`);
    try {
      const out = await fn();
      await c.query(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
      errors.push({ sheet, row: r._row, column, message: explain(e) });
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

  // The chart of accounts: parents before children.
  const pending = [...data.glAccounts];
  const inFile = new Set(pending.map((r) => r.code));
  const done = new Set();
  let guard = pending.length + 1;
  while (pending.length && guard > 0) {
    guard -= 1;
    for (let i = 0; i < pending.length; i += 1) {
      const r = pending[i];
      if (r.parentCode && inFile.has(r.parentCode) && !done.has(r.parentCode)) continue;
      pending.splice(i, 1); i -= 1;
      done.add(r.code);
      const ok = await row('GL Accounts', r, 'Code', async () => {
        if (r.parentCode) {
          const { rows: [p] } = await c.query('SELECT type FROM gl_accounts WHERE code = $1', [r.parentCode]);
          if (!p) throw err(`Parent code ${r.parentCode} is not in the chart of accounts`);
        }
        const { rowCount } = await c.query(
          `INSERT INTO gl_accounts (code, name, type, parent_code, usage, import_id)
           VALUES ($1,$2,$3,$4,COALESCE($5,'DETAIL'),$6) ON CONFLICT (code) DO NOTHING`,
          [r.code, r.name, r.type, r.parentCode, r.usage, importId]);
        if (!rowCount) throw err(`GL account ${r.code} is already in the chart of accounts`);
        return true;
      });
      if (ok) created.glAccounts += 1;
    }
  }
  for (const r of pending) errors.push({ sheet: 'GL Accounts', row: r._row, column: 'Parent code', message: 'The parent codes form a loop' });

  for (const r of data.branches) {
    const ok = await row('Branches', r, 'Branch ID', async () => {
      const b = await B.create(c, { ...given({ name: r.name, town: r.town, phone: r.phone, email: r.email, address: r.address, notes: r.notes }),
        code: r.code, customFields: r.customFields || {}, createdBy, user });
      await c.query('UPDATE branches SET import_id = $2 WHERE id = $1', [b.id, importId]);
      return b;
    });
    if (ok) created.branches += 1; else failed.branch.set(r.code, r._row);
  }
  const failedCentres = new Map();
  for (const r of data.centres) {
    const ok = await row('Centres', r, 'Centre ID', async () => {
      await branchId(r.branch);
      const ce = await B.createCentre(c, { ...given({ name: r.name, address: r.address, notes: r.notes }),
        code: r.code, branchId: r.branch, meetingDay: r.meetingDay ?? null, customFields: r.customFields || {}, createdBy, user });
      await c.query('UPDATE centres SET import_id = $2 WHERE id = $1', [ce.id, importId]);
      return ce;
    });
    if (ok) created.centres += 1; else failedCentres.set(r.code, r._row);
  }

  for (const r of data.members) {
    const m = await row('Members', r, 'Member number', async () => {
      const bId = await branchId(r.branch);
      if (r.branch) {
        const { rows: [b] } = await c.query('SELECT status FROM branches WHERE id = $1', [bId]);
        if (b.status !== 'ACTIVE') throw err(`Branch ${r.branch} is deactivated`);
      }
      if (r.centre) dependsOn(failedCentres, String(r.centre).toUpperCase(), 'Centre');
      const centre = r.centre ? await B.centreFor(c, String(r.centre).toUpperCase(), bId || null) : null;
      const values = await CF.prepare(c, 'MEMBER', { patch: r.customFields || {}, user, creating: true });
      const { rows: [x] } = await c.query(
        `INSERT INTO members (member_no, first_name, middle_name, last_name, national_id, kra_pin, phone, phone2, email,
            date_of_birth, gender, employer, status, joined_on, branch_id, centre_id, address_line1, address_line2, city,
            postcode, region, country, credit_officer, prior_loan_cycles, notes, custom_fields, import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,'ACTIVE'),COALESCE($14::date,$15::date),$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,COALESCE($25,0),$26,$27,$28)
         RETURNING id, branch_id`,
        [r.memberNo, r.firstName, r.middleName, r.lastName, r.nationalId, r.kraPin, r.phone, r.phone2, r.email,
          r.dateOfBirth, r.gender, r.employer, r.status, r.joinedOn, asOf, bId || (centre ? centre.branch_id : null), centre ? centre.id : null,
          r.addressLine1, r.addressLine2, r.city, r.postcode, r.region, r.country, r.creditOfficer, r.priorLoanCycles, r.notes,
          JSON.stringify(values), importId]);
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'MEMBER_IMPORTED','member',$2,$3)`,
        [createdBy, x.id, JSON.stringify({ memberNo: r.memberNo, importId })]);
      return x;
    });
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

  const subledger = { deposits: new Map(), shares: new Map(), loans: new Map() };
  const addTo = (map, gl, amount) => map.set(gl, round2((map.get(gl) || 0) + amount));

  for (const r of data.deposits) {
    const ok = await row('Deposit Accounts', r, 'Account number', async () => {
      const m = await member(r.memberNo);
      const bId = await branchId(r.branch);
      const a = await SV.open(c, { memberId: m.id, productId: r.productId, accountNo: r.accountNo, branchId: bId,
        overdraftLimit: r.overdraftLimit || 0, openedOn: r.openedOn || asOf, customFields: r.customFields || {}, user });
      await c.query(
        'UPDATE savings_accounts SET balance = $2, accrued_through = $3::date, import_id = $4 WHERE id = $1',
        [a.id, r.balance, asOf, importId]);
      if (r.balance > 0) {
        await SV.record(c, { reference: SV.ref('MG'), kind: 'MIGRATION_OPENING_BALANCE', memberId: m.id, savingsAccountId: a.id,
          amount: r.balance, valueDate: asOf, narration: 'Balance brought forward (data import)', createdBy,
          allocation: { importId } });
      }
      const { rows: [p] } = await c.query('SELECT gl_liability FROM savings_products WHERE id = $1', [r.productId]);
      addTo(subledger.deposits, p.gl_liability, r.balance);
      return a;
    });
    if (ok) created.deposits += 1;
  }

  for (const r of data.shares) {
    const ok = await row('Share Accounts', r, 'Account number', async () => {
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
      return a;
    });
    if (ok) created.shares += 1;
  }

  const schedules = groupBy(data.schedule, (x) => x.accountNo);
  for (const r of data.loans) {
    const ok = await row('Loan Accounts', r, 'Account number', async () => {
      const m = await member(r.memberNo);
      const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [r.productId]);
      if (!p) throw err(`No loan product ${r.productId}`);
      if (!['FIXED_TERM', 'DYNAMIC_TERM'].includes(p.product_type || 'FIXED_TERM')) {
        throw err(`Loans under ${p.product_type} products are not imported; open them in the system`);
      }
      if (p.interest_rate_source === 'INDEX') throw err('Loans with an index interest rate are not imported; open them in the system');
      const bId = await branchId(r.branch);
      const l0 = await L.apply(c, {
        memberId: m.id, productId: r.productId, principal: r.principal, termMonths: r.installments,
        ...(r.rate !== null ? { monthlyRate: r.rate } : {}),
        accountNo: r.accountNo, ...(bId !== undefined ? { branchId: bId } : {}),
        purpose: r.purpose, notes: r.notes, customFields: r.customFields || {}, createdBy, user,
      });
      if (l0.rate_plan) throw err('Loans with adjustable interest periods are not imported; open them in the system');
      await c.query(
        `UPDATE loan_accounts SET status = 'ACTIVE', approved_on = $2::date, approved_by = $3, disbursed_on = $2::date,
           disbursed_by = $3, principal_disbursed = principal, accrued_through = $4::date, import_id = $5
         WHERE id = $1`, [l0.id, r.disbursedOn, createdBy, asOf, importId]);
      // The product's penalty and arrears settings, frozen as at an approval.
      await workflow.freezeSettings(c, l0.id);
      await workflow.history(c, l0.id, { from: l0.status, to: 'ACTIVE', action: 'IMPORT', actor: createdBy, note: `data import, balances at ${asOf}` });

      let l = await L.lock(c, l0.id);
      const given = schedules.get(r.accountNo);
      if (given) {
        await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [l.id]);
        for (const s of [...given].sort((a, b) => a.number - b.number)) {
          await c.query(
            `INSERT INTO loan_installments (loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due,
               principal_paid, interest_paid, fee_paid, status)
             VALUES ($1,$2,$3::date,$3::date,$4,$5,$6,$7,$8,$9,'PENDING')`,
            [l.id, s.number, s.dueDate, s.principalDue, s.interestDue, s.feesDue || 0, s.principalPaid || 0, s.interestPaid || 0, s.feesPaid || 0]);
        }
      } else {
        await L.buildSchedule(c, l);
        // The principal repaid, oldest installments first, with their
        // interest and fees treated as paid.
        let left = round2(r.principal - r.principalOutstanding);
        const { rows: insts } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [l.id]);
        for (const i of insts) {
          if (!(left > 0)) break;
          const take = round2(Math.min(left, Number(i.principal_due)));
          await c.query(
            'UPDATE loan_installments SET principal_paid = $2, interest_paid = interest_due, fee_paid = fee_due WHERE id = $1',
            [i.id, take]);
          left = round2(left - take);
        }
      }
      await c.query(
        `UPDATE loan_installments SET status = CASE
            WHEN principal_paid >= principal_due AND interest_paid >= interest_due AND fee_paid >= fee_due THEN 'PAID'
            WHEN principal_paid + interest_paid + fee_paid > 0 THEN 'PARTIALLY_PAID'
            WHEN status = 'GRACE' THEN 'GRACE'
            ELSE 'PENDING' END
         WHERE loan_id = $1`, [l.id]);
      const { rows: [t] } = await c.query(
        `SELECT COALESCE(sum(principal_paid),0) AS pp, COALESCE(sum(interest_paid),0) AS ip, COALESCE(sum(fee_paid),0) AS fp, count(*)::int AS n
         FROM loan_installments WHERE loan_id = $1`, [l.id]);
      const feesLeft = round2(r.feesOutstanding || 0);
      await c.query(
        `UPDATE loan_accounts SET principal_paid = $2::numeric, interest_paid = $3::numeric, interest_accrued = $3::numeric + $4::numeric,
           fees_paid = $5::numeric, fees_due = $5::numeric + $6::numeric, penalty_accrued = $7::numeric
         WHERE id = $1`,
        [l.id, round2(r.principal - r.principalOutstanding), t.ip, r.interestOutstanding || 0, t.fp, feesLeft, r.penaltyOutstanding || 0]);
      // Fees still owed become one fee, on the oldest unpaid installment
      // when the product drew the schedule (a given schedule already has them).
      if (feesLeft > 0) {
        const { rows: [first] } = await c.query(
          "SELECT id FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID' ORDER BY number LIMIT 1", [l.id]);
        const placeOn = !given && first ? first.id : null;
        if (placeOn) await c.query('UPDATE loan_installments SET fee_due = fee_due + $2, status = CASE WHEN status = \'PAID\' THEN \'PARTIALLY_PAID\' ELSE status END WHERE id = $1', [placeOn, feesLeft]);
        await c.query(
          `INSERT INTO loan_fees (loan_id, installment_id, name, fee_type, amount, paid, applied_on, status, note, created_by)
           VALUES ($1,$2,'Fees brought forward','MANUAL',$3,0,$4::date,'DUE','data import',$5)`,
          [l.id, placeOn, feesLeft, asOf, createdBy]);
      }
      // Arrears as at the migration date, on the product's own rules.
      await workflow.markArrears(c, { asOf, loanId: l.id });
      // Late before the migration date: no late fee, and penalties count
      // from the migration date.
      const { rows: late } = await c.query(
        `UPDATE loan_installments SET late_fee_exempt = true
         WHERE loan_id = $1 AND due_date < $2::date AND status NOT IN ('PAID', 'GRACE') RETURNING id, due_date`, [l.id, asOf]);
      for (const i of late) {
        await c.query(
          `INSERT INTO penalty_charges (loan_id, installment_id, charged_on, days_late, basis_amount, rate, amount, forfeited, period_from, days_charged)
           VALUES ($1,$2,$3::date,($3::date - $4::date),0,0,0,true,$4::date,0)`,
          [l.id, i.id, asOf, i.due_date]);
      }
      l = await L.lock(c, l.id);
      addTo(subledger.loans, l.gl_portfolio, r.principalOutstanding);
      created.installments += t.n;
      return l;
    });
    if (ok) created.loans += 1; else failed.loan.set(r.accountNo, r._row);
  }

  // The opening trial balance, one entry on the migration date.
  let entryId = null;
  const sheetGl = new Map();
  if (data.glBalances.length) {
    const lines = [];
    let good = true;
    for (const r of data.glBalances) {
      const ok = await row('GL Balances', r, 'GL code', async () => {
        const { rows: [g] } = await c.query('SELECT code, type, usage FROM gl_accounts WHERE code = $1', [r.glCode]);
        if (!g) throw err(`No GL account ${r.glCode}, in the chart or on the GL Accounts sheet`);
        if (g.usage === 'HEADER') throw err(`GL account ${r.glCode} is a header account and takes no postings`);
        const bId = await branchId(r.branch);
        lines.push({ glCode: r.glCode, amount: r.debit || r.credit, side: r.debit > 0 ? 'D' : 'C', branchId: bId || null });
        sheetGl.set(r.glCode, round2((sheetGl.get(r.glCode) || 0) + (r.debit || 0) - (r.credit || 0)));
        return true;
      });
      if (!ok) good = false;
    }
    if (good && lines.length) {
      const ok = await row('GL Balances', { _row: null }, null, async () => {
        const e = await acct.post(c, {
          debits: lines.filter((x) => x.side === 'D'),
          credits: lines.filter((x) => x.side === 'C'),
          bookingDate: asOf,
          narration: 'Opening balances (data import)',
          sourceType: 'DATA_IMPORT', sourceId: importId, createdBy,
        });
        return e;
      });
      if (ok) { entryId = ok.entryId; created.openingEntryLines = ok.lineCount; }
    }

    // Subledgers against the trial balance: a loan portfolio is a debit
    // balance, deposits and share capital credit balances.
    const compare = (map, sign, what) => {
      for (const [gl, total] of map) {
        const inSheet = round2((sheetGl.get(gl) || 0) * sign);
        if (round2(total) !== inSheet) {
          warnings.push({ sheet: 'GL Balances', row: null, column: 'GL code',
            message: `${what} add up to ${round2(total)} on GL account ${gl}; the GL Balances sheet has ${inSheet}` });
        }
      }
    };
    compare(subledger.loans, 1, 'Loan principal outstanding');
    compare(subledger.deposits, -1, 'Deposit balances');
    compare(subledger.shares, -1, 'Share capital');
  } else if (data.loans.length || data.deposits.length || data.shares.length) {
    warnings.push({ sheet: 'GL Balances', row: null, column: null,
      message: 'Accounts are imported with balances but there is no GL Balances sheet: the general ledger will not show them until an opening entry is posted.' });
  }

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

// --- the workbook people download -----------------------------------------

async function template(c, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const sheets = [];
  const intro = [
    ['Data import'],
    ['Fill in the sheets you need and leave the others empty. Columns marked * are required. Dates are yyyy-MM-dd (or Excel dates). Amounts are plain numbers.'],
    ['Balances are as at the end of the migration date on the Settings sheet. Nothing is created until the upload is reviewed and approved.'],
    ['Custom fields: add a column headed "Custom: _setId.fieldId" to Members, Branches, Centres, Deposit Accounts or Loan Accounts.'],
    [],
    ['Sheet', 'Column', 'Required', 'Notes'],
  ];
  for (const def of SHEETS) {
    if (def.note) intro.push([def.name, '', '', def.note]);
    for (const col of def.columns) intro.push([def.name, col.h, col.req ? 'yes' : '', [col.oneOf ? `One of ${col.oneOf.join(', ')}` : '', col.hint || '', col.type ? `(${col.type})` : ''].filter(Boolean).join(' ')]);
  }
  sheets.push({ name: 'Instructions', rows: intro, headerRows: 0, widths: [22, 26, 10, 80],
    styles: { A1: 'bold', A6: 'bold', B6: 'bold', C6: 'bold', D6: 'bold' } });
  sheets.push({ name: SETTINGS, rows: [['Setting', 'Value'], ['Migration date', today]], widths: [22, 16] });
  for (const def of SHEETS) {
    sheets.push({ name: def.name, rows: [def.columns.map((col) => (col.req ? `${col.h}*` : col.h))], widths: def.columns.map((col) => Math.max(12, col.h.length + 4)) });
  }
  // What the tenant already has, to copy IDs from.
  const ref = [['Kind', 'ID', 'Name', 'Detail']];
  const add = (kind, rows) => rows.forEach((x) => ref.push([kind, x.id, x.name, x.detail || '']));
  add('Loan product', (await c.query("SELECT id, name, product_type AS detail FROM loan_products WHERE is_active ORDER BY id")).rows);
  add('Deposit product', (await c.query('SELECT id, name, gl_liability AS detail FROM savings_products WHERE is_active ORDER BY id')).rows);
  add('Share product', (await c.query("SELECT id, name, 'unit price ' || unit_price AS detail FROM share_products WHERE is_active ORDER BY id")).rows);
  add('Branch', (await c.query('SELECT code AS id, name, status AS detail FROM branches ORDER BY code')).rows);
  add('Centre', (await c.query('SELECT c.code AS id, c.name, b.code AS detail FROM centres c JOIN branches b ON b.id = c.branch_id ORDER BY c.code')).rows);
  add('GL account', (await c.query("SELECT code AS id, name, type || ' ' || usage AS detail FROM gl_accounts WHERE is_active ORDER BY code")).rows);
  sheets.push({ name: 'Reference', rows: ref, widths: [16, 16, 36, 24] });
  return XLSX.write(sheets);
}

/** The uploaded workbook back, with an Errors column on each sheet that has errors. */
function errorWorkbook(buffer, errors) {
  const book = XLSX.read(buffer);
  const bySheet = groupBy(errors, (x) => norm(x.sheet));
  const out = [{
    name: 'Errors',
    rows: [['Sheet', 'Row', 'Column', 'Error'], ...errors.map((x) => [x.sheet, x.row, x.column, x.message])],
    widths: [20, 8, 22, 90],
  }];
  for (const sh of book) {
    if (norm(sh.name) === 'errors') continue;
    const errs = bySheet.get(norm(sh.name)) || [];
    const width = Math.max(0, ...sh.rows.map((r) => r.length));
    const styles = {};
    const col = XLSX.colName(width);
    const rows = sh.rows.map((r, i) => {
      const mine = errs.filter((x) => x.row === i + 1 || (i === 0 && x.row === null));
      const cells = [...r, ...Array(Math.max(0, width - r.length)).fill(null)];
      if (i === 0 && errs.length) cells.push('Errors');
      else if (mine.length) { cells.push(mine.map((x) => x.message).join('; ')); styles[`${col}${i + 1}`] = 'error'; }
      return cells;
    });
    out.push({ name: sh.name, rows, styles });
  }
  return XLSX.write(out);
}

// --- the life of an import ------------------------------------------------

const PUBLIC = `id, file_name, file_size, sha256, status, as_of, summary, errors, warnings, entry_id,
                created_by, created_at, decided_by, decided_at, decision_note, (error_file IS NOT NULL) AS has_error_file`;

/** Upload: check, dry-run, and record as INVALID or PENDING_APPROVAL. */
async function upload(c, { buffer, fileName }, { createdBy, user, today }) {
  const name = String(fileName || 'import.xlsx').replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 200);
  const sha256 = crypto.createHash('sha256').update(buffer || Buffer.alloc(0)).digest('hex');
  let parsed;
  try {
    parsed = parse(buffer, { today });
  } catch (e) {
    if (e.status === 413) throw e;
    parsed = { asOf: null, data: null, counts: {}, errors: [{ sheet: null, row: null, column: null, message: explain(e) }], warnings: [] };
  }
  const { rows: [imp] } = await c.query(
    `INSERT INTO data_imports (file_name, file_size, sha256, status, as_of, file, created_by)
     VALUES ($1,$2,$3,'INVALID',$4,$5,$6) RETURNING id`, [name, buffer.length, sha256, parsed.asOf, buffer, createdBy]);

  let run = { errors: [], warnings: [], created: {} };
  if (!parsed.errors.length) {
    await c.query('SAVEPOINT import_dry_run');
    try {
      run = await execute(c, parsed, { importId: imp.id, createdBy, user });
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT import_dry_run');
    }
  }
  const errors = [...parsed.errors, ...run.errors];
  const warnings = [...parsed.warnings, ...run.warnings];
  const status = errors.length ? 'INVALID' : 'PENDING_APPROVAL';
  let errorFile = null;
  if (errors.length && parsed.data) {
    try { errorFile = errorWorkbook(buffer, errors); } catch { errorFile = null; }
  }
  const summary = { rows: parsed.counts, creates: errors.length ? null : run.created };
  const { rows: [out] } = await c.query(
    `UPDATE data_imports SET status = $2, summary = $3, errors = $4, warnings = $5, error_file = $6, pending = $7
     WHERE id = $1 RETURNING ${PUBLIC}`,
    [imp.id, status, JSON.stringify(summary), JSON.stringify(errors.slice(0, 5000)), JSON.stringify(warnings), errorFile,
      status === 'PENDING_APPROVAL' ? JSON.stringify({ asOf: parsed.asOf, data: parsed.data }) : null]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DATA_IMPORT_UPLOADED','data_import',$2,$3)`,
    [createdBy, imp.id, JSON.stringify({ fileName: name, status, errors: errors.length })]);
  return out;
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
    `UPDATE data_imports SET status = 'REJECTED', pending = NULL, decided_by = $2, decided_at = now(), decision_note = $3
     WHERE id = $1 RETURNING ${PUBLIC}`, [imp.id, createdBy, note]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'DATA_IMPORT_REJECTED','data_import',$2,$3)`,
    [createdBy, imp.id, JSON.stringify({ note })]);
  return out;
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

async function fileOf(c, id, which) {
  const col = which === 'errors' ? 'error_file' : 'file';
  const { rows: [imp] } = await c.query(`SELECT file_name, ${col} AS data FROM data_imports WHERE id::text = $1`, [String(id)]);
  if (!imp) throw err('IMPORT_NOT_FOUND', 404);
  if (!imp.data) throw err('NO_ERROR_FILE', 404);
  return { fileName: which === 'errors' ? imp.file_name.replace(/(\.xlsx)?$/i, '-errors.xlsx') : imp.file_name, data: imp.data };
}

module.exports = { SHEETS, parse, execute, template, errorWorkbook, upload, approve, reject, list, get, fileOf, MAX_FILE };
