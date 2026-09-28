'use strict';

const xlsx = require('./xlsx');
const csv = require('./csv');
const pdf = require('./pdf');
const { excelNumber } = require('./export');

/**
 * A report run (domain/reportTemplates.run) as a file: HTML, PDF, Excel
 * (a sheet per table section) or CSV (sections one after another).
 */

const TYPES = {
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const show = (v, col) => (v === null || v === undefined ? '' : col.num && typeof v === 'number' ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : typeof v === 'object' ? JSON.stringify(v) : String(v));

function rowsOf(s) {
  const rows = s.rows.map((r) => s.columns.map((col) => r[col.key]));
  if (s.totals) rows.push(s.columns.map((col, i) => (s.totals[col.key] !== undefined ? s.totals[col.key] : i === 0 ? 'Total' : null)));
  return rows;
}

function meta(run) {
  const lines = [];
  if (run.record) lines.push(['Record', Object.values(run.record).filter((v) => v && !/^[0-9a-f-]{36}$/.test(v)).slice(0, 3).join(' ')]);
  for (const [k, v] of Object.entries(run.parameters || {})) lines.push([k, v === null ? '' : String(v)]);
  lines.push(['Generated', `${run.generatedAt} by ${run.generatedBy}`]);
  return lines;
}

function html(run) {
  const sec = run.sections.map((s) => {
    if (s.type === 'TEXT') return `<section>${s.title ? `<h2>${esc(s.title)}</h2>` : ''}<p>${esc(s.text)}</p></section>`;
    if (s.type === 'FIELDS') {
      const r = s.rows[0] || {};
      return `<section>${s.title ? `<h2>${esc(s.title)}</h2>` : ''}<dl>${s.columns.map((col) => `<dt>${esc(col.label)}</dt><dd>${esc(show(r[col.key], col))}</dd>`).join('')}</dl></section>`;
    }
    const head = s.columns.map((col) => `<th${col.num ? ' class="n"' : ''}>${esc(col.label)}</th>`).join('');
    const body = rowsOf(s).map((r, ri) => `<tr${s.totals && ri === s.rows.length ? ' class="t"' : ''}>${r.map((v, i) => `<td${s.columns[i].num ? ' class="n"' : ''}>${esc(show(v, s.columns[i]))}</td>`).join('')}</tr>`).join('');
    return `<section>${s.title ? `<h2>${esc(s.title)}</h2>` : ''}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      ${s.truncated ? `<p class="h">First ${s.rows.length} of ${s.total} rows.</p>` : ''}</section>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(run.title)}</title>
<style>body{font:13px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:15px;margin-top:20px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left}.n{text-align:right}
tr.t td{font-weight:600;border-top:2px solid #999}dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}dt{color:#555}
.h,.m{color:#666;font-size:12px}@media print{body{margin:0}}</style></head><body>
<h1>${esc(run.title)}</h1><p class="m">${meta(run).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' &middot; ')}</p>
${sec}${run.footer ? `<p class="m">${esc(run.footer)}</p>` : ''}</body></html>`;
}

function toPdf(run) {
  const blocks = [{ kind: 'title', text: run.title }, { kind: 'text', text: meta(run).map(([k, v]) => `${k}: ${v}`).join('   '), size: 8 }];
  for (const s of run.sections) {
    if (s.title) blocks.push({ kind: 'heading', text: s.title });
    if (s.type === 'TEXT') { blocks.push({ kind: 'text', text: s.text }); continue; }
    if (s.type === 'FIELDS') {
      const r = s.rows[0] || {};
      blocks.push({ kind: 'table', columns: [{ label: 'Field' }, { label: 'Value' }], rows: s.columns.map((col) => [col.label, show(r[col.key], col)]) });
      continue;
    }
    const rows = rowsOf(s);
    blocks.push({ kind: 'table', columns: s.columns, rows, boldRows: s.totals ? [rows.length - 1] : [] });
    if (s.truncated) blocks.push({ kind: 'text', text: `First ${s.rows.length} of ${s.total} rows.`, size: 8 });
  }
  return pdf.write(blocks, { landscape: run.landscape, footer: run.footer || run.title });
}

function toXlsx(run) {
  const sheets = [{ name: 'Report', rows: [[run.title], ...meta(run)], headerRows: 1 }];
  run.sections.forEach((s, i) => {
    const name = `${i + 1} ${s.title || s.type}`.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
    if (s.type === 'TEXT') { sheets.push({ name, rows: [[s.text]], headerRows: 0 }); return; }
    const rows = rowsOf(s).map((r) => r.map((v, ci) => (s.columns[ci].num ? excelNumber(v) : v ?? null)));
    sheets.push({ name, rows: [s.columns.map((col) => col.label), ...rows], headerRows: 1 });
  });
  return xlsx.write(sheets);
}

function toCsv(run) {
  const lines = [csv.cell(run.title), ...meta(run).map((m) => m.map(csv.cell).join(','))];
  for (const s of run.sections) {
    lines.push('', csv.cell(s.title || s.type));
    if (s.type === 'TEXT') { lines.push(csv.cell(s.text)); continue; }
    lines.push(s.columns.map((col) => csv.cell(col.label)).join(','));
    for (const r of rowsOf(s)) lines.push(r.map(csv.cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function render(run, fmt) {
  if (fmt === 'html') return html(run);
  if (fmt === 'pdf') return toPdf(run);
  if (fmt === 'xlsx') return toXlsx(run);
  if (fmt === 'csv') return toCsv(run);
  throw Object.assign(new Error('FORMAT_IS_ONE_OF: json, html, pdf, xlsx, csv'), { status: 400 });
}

module.exports = { TYPES, render };
