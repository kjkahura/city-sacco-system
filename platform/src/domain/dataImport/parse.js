'use strict';

/**
 * The Excel data import: reading a workbook and checking every row.
 */

const XLSX = require('../../lib/xlsx');
const LM = require('../loanMigration');
const { err } = require('../../lib/errors');
const definitions = require('./definitions');
const execute = require('./execute');

/**
 * Read and check the workbook on its own, before the database is asked
 * anything. Returns the rows by sheet, the migration date, the errors and
 * warnings, and where each sheet's columns are (for the error workbook and
 * The reference platform's error format).
 */
function parse(buffer, { today }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw err('EMPTY_FILE');
  if (buffer.length > definitions.MAX_FILE) throw err(`FILE_TOO_LARGE: the limit is ${definitions.MAX_FILE} bytes`, 413);
  const book = XLSX.read(buffer);
  const errors = [];
  const warnings = [];
  const layout = {};
  const report = {
    error: (sheet, row, column, message, index = null) => errors.push({ sheet, row, column, message, ...(index !== null ? { index } : {}) }),
    warn: (sheet, row, column, message, index = null) => warnings.push({ sheet, row, column, message, ...(index !== null ? { index } : {}) }),
  };
  const byName = new Map(book.map((s) => [definitions.norm(s.name), s]));
  const find = (def) => byName.get(definitions.norm(def.name)) || (def.aliases || []).map((a) => byName.get(definitions.norm(a))).find(Boolean);

  // Settings: key/value rows.
  let asOf = null;
  const settings = byName.get(definitions.norm(definitions.SETTINGS));
  if (!settings) report.error(definitions.SETTINGS, null, null, 'The Settings sheet is missing; it gives the migration date.');
  else {
    for (let i = 0; i < settings.rows.length; i += 1) {
      const [k, v] = settings.rows[i] || [];
      if (definitions.norm(k) === 'migration date') {
        const r = definitions.convert(v, { type: 'date' });
        if (r.error || !r.value) report.error(definitions.SETTINGS, i + 1, 'Migration date', r.error ? `Migration date ${r.error}` : 'Migration date is required', 1);
        else asOf = r.value;
      }
    }
    if (!asOf && !errors.some((x) => x.sheet === definitions.SETTINGS)) report.error(definitions.SETTINGS, null, 'Migration date', 'Migration date is required');
    if (asOf && asOf > today) report.error(definitions.SETTINGS, null, 'Migration date', `Migration date ${asOf} is after today (${today})`);
  }

  const data = {};
  const counts = {};
  for (const def of definitions.SHEETS) {
    data[def.key] = [];
    const sh = find(def);
    if (!sh || !sh.rows.length) continue;
    const sheetName = sh.name;
    const { idx, custom, names } = definitions.readHeader(def, sh.rows[0], {
      error: (s, r, c, m, i) => report.error(sheetName, r, c, m, i),
      warn: (s, r, c, m, i) => report.warn(sheetName, r, c, m, i),
    });
    layout[def.key] = { sheet: sheetName, columns: Object.fromEntries(Object.entries(idx).map(([k, i]) => [def.columns.find((c) => c.k === k)?.h || k, i])) };
    const missing = def.columns.filter((c) => c.req && idx[c.k] === undefined);
    for (const col of missing) report.error(sheetName, 1, col.h, `Column "${col.h}" is missing`);
    if (missing.length) continue;
    const body = sh.rows.slice(1);
    if (body.length > definitions.MAX_ROWS) { report.error(sheetName, null, null, `More than ${definitions.MAX_ROWS} rows`); continue; }
    body.forEach((cells, n) => {
      const rowNo = n + 2;
      if (!cells || cells.every(definitions.blank)) return;
      const row = { _row: rowNo, _sheet: sheetName };
      for (const col of def.columns) {
        const raw = idx[col.k] === undefined ? null : cells[idx[col.k]];
        const r = definitions.convert(raw, col);
        if (r.error) report.error(sheetName, rowNo, col.h, `${col.h} ${r.error}`, idx[col.k]);
        else if (col.req && r.value === null) report.error(sheetName, rowNo, col.h, `${col.h} is required`, idx[col.k] ?? null);
        row[col.k] = r.value ?? null;
      }
      if (custom.length) {
        row.customFields = {};
        for (const cf of custom) {
          const v = cells[cf.i];
          if (definitions.blank(v)) continue;
          row.customFields[cf.setId] = { ...(row.customFields[cf.setId] || {}), [cf.fieldId]: typeof v === 'string' ? v.trim() : v };
        }
      }
      data[def.key].push(row);
    });
    counts[def.key] = data[def.key].length;
    void names;
  }
  const at = (key, name) => layout[key]?.columns?.[name] ?? null;
  const e = (key, r, column, message) => report.error(layout[key]?.sheet || definitions.SHEETS.find((s) => s.key === key).name, r ? r._row : null, column, message, r ? at(key, column) : null);

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
  dupes('groups', 'groupNo', 'Group ID');
  // A group's ID and a member's number share one series.
  {
    const nos = new Set(data.members.map((r) => String(r.memberNo || '').toUpperCase()));
    for (const r of data.groups) if (r.groupNo && nos.has(String(r.groupNo).toUpperCase())) e('groups', r, 'Group ID', `Group ID ${r.groupNo} is also a member number on the Members sheet`);
  }
  const listOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const r of data.members) { r.groupIds = listOf(r.groupId); r.groupRoles = listOf(r.groupRole); }
  for (const r of data.groups) {
    if (r.branch) r.branch = String(r.branch).toUpperCase();
    if (r.centre) r.centre = String(r.centre).toUpperCase();
  }
  dupes('deposits', 'accountNo', 'Account number');
  dupes('shares', 'accountNo', 'Account number');
  dupes('loans', 'accountNo', 'Account number');
  for (const r of data.branches) if (r.code) r.code = r.code.toUpperCase();
  for (const r of data.centres) {
    if (r.code) r.code = r.code.toUpperCase();
    if (r.branch) r.branch = r.branch.toUpperCase();
    // One address line here: the rest of the reference platform's address is joined to it.
    const rest = [r.address2, r.city, r.postcode, r.region, r.country].filter(Boolean);
    if (rest.length) r.address = [r.address, ...rest].filter(Boolean).join(', ').slice(0, definitions.MAX_TEXT);
  }
  for (const r of data.members) {
    if (r.groupRoles.length && !r.groupIds.length) e('members', r, 'Group role', 'A group role needs the Group ID it is held in');
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
    const overdrawn = definitions.round2((r.overdraftDue || 0) + (r.overdraftInterestDue || 0) + (r.overdraftFeesDue || 0));
    if (overdrawn > 0 && r.balance > 0) e('deposits', r, 'Balance', 'An account is in credit or overdrawn, not both');
    if (overdrawn > 0 && !(r.overdraftLimit > 0)) e('deposits', r, 'Overdraft limit', 'An overdrawn account needs its overdraft limit');
  }

  // Loans: their schedules and transactions, and what each state needs.
  const loanNos = new Set(data.loans.map((r) => r.accountNo));
  const sched = definitions.groupBy(data.schedule, (r) => r.accountNo);
  const txs = definitions.groupBy(data.transactions, (r) => r.accountNo);
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
    r.state = r.state || 'ACTIVE';
    if (r.principalOutstanding === null && r.principalPaid !== null && r.principal !== null) r.principalOutstanding = definitions.round2(r.principal - r.principalPaid);
    if (r.principalOutstanding !== null && r.principalPaid !== null && r.principal !== null && definitions.round2(r.principal - r.principalPaid) !== r.principalOutstanding) {
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
    const spec = execute.specOf(r, rows, own);
    for (const p of LM.check(spec, { asOf })) e('loans', r, execute.columnFor(p.field), p.message);
    if (rows && r.principal !== null && !own.length) {
      const due = definitions.sum(rows, 'principalDue');
      if (due !== r.principal) e('loans', r, 'Principal', `The schedule's principal due adds up to ${due}, not ${r.principal}`);
      if (r._hasSchedulePaid) {
        const paid = definitions.sum(rows, 'principalPaid');
        if (r.principalOutstanding !== null && definitions.round2(due - paid) !== r.principalOutstanding) {
          e('loans', r, 'Principal outstanding', `The schedule leaves ${definitions.round2(due - paid)} principal unpaid, not ${r.principalOutstanding}`);
        }
        // Fees owed are those on installments due by the migration date
        // (or partly paid already); later ones are not due yet.
        const applied = rows.filter((x) => (asOf && x.dueDate <= asOf) || (x.feesPaid || 0) > 0);
        const feesLeft = definitions.round2(definitions.sum(applied, 'feesDue') - definitions.sum(applied, 'feesPaid'));
        if (r.feesOutstanding !== null && feesLeft !== r.feesOutstanding) {
          e('loans', r, 'Fees outstanding', `The schedule leaves ${feesLeft} fees owed by the migration date, not ${r.feesOutstanding}`);
        }
        if (rows.some((x) => x.penaltyDue !== null)) {
          const penLeft = definitions.round2(definitions.sum(rows, 'penaltyDue') - definitions.sum(rows, 'penaltyPaid'));
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
  const lines = execute.openingLines(data);
  let dr = 0;
  let cr = 0;
  for (const r of data.glBalances) {
    if ((r.debit || 0) > 0 && (r.credit || 0) > 0) e('glBalances', r, 'Debit', 'A line is a debit or a credit, not both');
    if (!(r.debit > 0) && !(r.credit > 0)) e('glBalances', r, 'Debit', 'A line needs a debit or a credit');
  }
  for (const l of lines) { if (l.side === 'D') dr += l.amount; else cr += l.amount; }
  if (definitions.round2(dr) !== definitions.round2(cr)) {
    const key = data.glBalances.length ? 'glBalances' : 'chart';
    report.error(layout[key]?.sheet || 'GL Balances', null, null, `Debits (${definitions.round2(dr)}) do not equal credits (${definitions.round2(cr)})`);
  }

  return { asOf, data, counts, errors, warnings, layout };
}

Object.assign(module.exports, {
  parse,
});
