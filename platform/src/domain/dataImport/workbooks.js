'use strict';

/**
 * The Excel data import: the template workbook and the workbook of errors.
 */

const XLSX = require('../../lib/xlsx');
const CF = require('../customFields');
const definitions = require('./definitions');
const execute = require('./execute');

// --- the workbook people download ---------------------------------------------

/**
 * The template: Instructions and Settings, a sheet to fill in per kind of
 * record (green headings, with a column for every custom field defined for
 * it), and the reference sheets of what is already in the system (grey
 * headings; anything typed there is ignored).
 */
async function template(c, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const pre = await execute.prerequisites(c);
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
  for (const def of definitions.SHEETS) {
    if (def.note) intro.push([def.name, '', '', def.note]);
    for (const col of def.columns) {
      intro.push([def.name, col.h, col.req ? 'yes' : '', [col.map ? col.map.label : '', col.hint || '', col.type ? `(${col.type === 'signed' ? 'amount, may be negative' : col.type})` : '',
        col.a ? `Also read as: ${col.a.join(', ')}` : ''].filter(Boolean).join('. ')]);
    }
  }
  const sheets = [{ name: 'Instructions', rows: intro, headerRows: 0, widths: [24, 26, 10, 90],
    styles: { A1: 'bold', A6: 'bold', B6: 'bold', C6: 'bold', D6: 'bold', [`A${headRow}`]: 'bold', [`B${headRow}`]: 'bold', [`C${headRow}`]: 'bold', [`D${headRow}`]: 'bold' } }];
  sheets.push({ name: definitions.SETTINGS, rows: [['Setting', 'Value'], ['Migration date', today]], widths: [22, 16], headerStyle: 'input' });
  for (const def of definitions.SHEETS) {
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
  await ref('Group Types', ['Group type', 'Name'], "SELECT id, name FROM client_types WHERE holder_type = 'GROUP' ORDER BY id");
  await ref('Group Role Names', ['Role name ID', 'Name'], 'SELECT id, name FROM group_role_names ORDER BY name');
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
  const bySheet = definitions.groupBy(errors, (x) => definitions.norm(x.sheet));
  const out = [];
  for (const sh of book) {
    if (definitions.norm(sh.name) === 'errors') continue;
    const errs = bySheet.get(definitions.norm(sh.name)) || [];
    const width = Math.max(0, ...sh.rows.map((r) => r.length));
    const styles = {};
    const noteCol = XLSX.colName(width);
    const header = (sh.rows[0] || []).map(definitions.norm);
    const rows = sh.rows.map((r, i) => {
      const mine = errs.filter((x) => x.row === i + 1 || (i === 0 && x.row === null));
      const cells = [...r, ...Array(Math.max(0, width - r.length)).fill(null)];
      if (i === 0 && errs.length) cells.push('Errors');
      else if (mine.length) {
        cells.push(mine.map((x) => x.message).join('; '));
        styles[`${noteCol}${i + 1}`] = 'error';
        for (const x of mine) {
          const at = x.index ?? (x.column ? header.indexOf(definitions.norm(x.column)) : -1);
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

Object.assign(module.exports, {
  template, errorWorkbook,
});
