'use strict';

/**
 * CSV in the form the tenant backup writes it (RFC 4180): comma separated,
 * fields with a comma, quote or line break quoted, quotes doubled, CRLF
 * line ends. As PostgreSQL's COPY reads CSV, an unquoted empty field is
 * NULL and a quoted empty field ("") is an empty string.
 */

/** Parse CSV text into rows of cells (null for an unquoted empty field). */
function parse(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const s = String(text);
  const endCell = () => { row.push(cur === '' && !wasQuoted ? null : cur); cur = ''; wasQuoted = false; };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      cur += ch; i += 1; continue;
    }
    if (ch === '"') { quoted = true; wasQuoted = true; i += 1; continue; }
    if (ch === ',') { endCell(); i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      endCell();
      rows.push(row);
      row = [];
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cur += ch; i += 1;
  }
  if (cur !== '' || wasQuoted || row.length) { endCell(); rows.push(row); }
  return rows;
}

/** One cell: NULL as nothing, an empty string as "", quoted where needed. */
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s === '') return '""';
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { parse, cell };
