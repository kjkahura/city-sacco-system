'use strict';

const xlsx = require('./xlsx');
const csv = require('./csv');

/**
 * Report and view exports as CSV or Excel. A report is a title, a few header
 * lines (the period, the branch, when it was generated), columns and rows.
 *
 * Columns: { key, label, num?, value?(row) }. A numeric column is written to
 * Excel as a number while it fits Excel's 15 significant digits; longer
 * figures go in as text so nothing is rounded, as the reference platform does.
 */

const FORMATS = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function format(q) {
  const f = String(q || '').toLowerCase();
  return FORMATS[f] ? f : null;
}

const valueOf = (col, row) => (col.value ? col.value(row) : row[col.key]);

function excelNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const digits = String(v).replace(/^-/, '').replace('.', '').replace(/^0+/, '').length;
  return digits > 15 ? String(v) : n;
}

function toCsv({ header = [], columns, rows, totals = null }) {
  const lines = header.map(([k, v]) => [k, v].map(csv.cell).join(','));
  if (lines.length) lines.push('');
  lines.push(columns.map((c) => csv.cell(c.label)).join(','));
  for (const r of rows) lines.push(columns.map((c) => csv.cell(valueOf(c, r))).join(','));
  if (totals) lines.push(columns.map((c, i) => csv.cell(i === 0 && totals[c.key] === undefined ? 'Total' : totals[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function toXlsx({ title = 'Report', header = [], columns, rows, totals = null }) {
  const out = header.map(([k, v]) => [k, v]);
  const styles = {};
  header.forEach((_, i) => { styles[`A${i + 1}`] = 'bold'; });
  if (out.length) out.push([]);
  const headRow = out.length;
  out.push(columns.map((c) => c.label));
  columns.forEach((_, i) => { styles[`${xlsx.colName(i)}${headRow + 1}`] = 'bold'; });
  for (const r of rows) out.push(columns.map((c) => (c.num ? excelNumber(valueOf(c, r)) : valueOf(c, r) ?? null)));
  if (totals) {
    const n = out.length + 1;
    out.push(columns.map((c, i) => (i === 0 && totals[c.key] === undefined ? 'Total' : (c.num ? excelNumber(totals[c.key]) : totals[c.key] ?? null))));
    columns.forEach((_, i) => { styles[`${xlsx.colName(i)}${n}`] = 'bold'; });
  }
  return xlsx.write([{
    name: String(title).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report',
    rows: out,
    styles,
    headerRows: 0,
    widths: columns.map((c) => (c.num ? 16 : Math.min(40, Math.max(12, String(c.label).length + 2)))),
  }]);
}

const safeName = (s) => String(s || 'report').replace(/[^A-Za-z0-9._-]/g, '_');

/** Send an export: fmt is 'csv' or 'xlsx'. */
function send(res, fmt, report, fileName) {
  const data = fmt === 'xlsx' ? toXlsx(report) : toCsv(report);
  res.set('content-type', FORMATS[fmt]);
  res.set('content-disposition', `attachment; filename="${safeName(fileName)}.${fmt}"`);
  res.set('x-content-type-options', 'nosniff');
  res.set('cache-control', 'no-store');
  res.send(data);
}

module.exports = { FORMATS, format, toCsv, toXlsx, send, excelNumber };
