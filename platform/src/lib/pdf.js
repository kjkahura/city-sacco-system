'use strict';

/**
 * A small PDF writer for reports, with no dependency: a title, lines of text
 * and tables, paged on A4 with the table header repeated on each page.
 * Helvetica (WinAnsi); characters outside Latin-1 print as '?'. Column widths
 * follow the longest value in each column, and a value too wide for its
 * column is cut with an ellipsis. Numbers are right-aligned.
 *
 * write([{ kind: 'title'|'heading'|'text', text }, { kind: 'table', columns: [{label, num}], rows: [[...]] }], { landscape })
 */

const A4 = [595.28, 841.89];
const MARGIN = 36;

// Helvetica widths (per 1000 units) for printable ASCII 32..126.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
  722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const charW = (ch) => { const i = ch.charCodeAt(0) - 32; return i >= 0 && i < W.length ? W[i] : 556; };
const textWidth = (s, size) => [...String(s)].reduce((a, ch) => a + charW(ch), 0) * size / 1000;

function latin1(s) {
  return String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\xFF]/g, '?');
}
const esc = (s) => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function fit(s, width, size) {
  let t = latin1(s);
  if (textWidth(t, size) <= width) return t;
  while (t.length > 1 && textWidth(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t}...`;
}

function write(blocks, { landscape = false, footer = null } = {}) {
  const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
  const usable = pw - 2 * MARGIN;
  const pages = [];
  let ops = [];
  let y = ph - MARGIN;
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = ph - MARGIN; };
  const need = (h) => { if (y - h < MARGIN + 14) newPage(); };
  const text = (s, x, yy, size, bold = false) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);

  for (const b of blocks) {
    if (b.kind === 'title') { need(24); y -= 16; text(b.text, MARGIN, y, 14, true); y -= 8; continue; }
    if (b.kind === 'heading') { need(22); y -= 16; text(b.text, MARGIN, y, 11, true); y -= 4; continue; }
    if (b.kind === 'text') {
      const size = b.size || 9;
      // Wrap on words.
      const words = latin1(b.text).split(/\s+/);
      let line = '';
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (textWidth(next, size) > usable && line) { need(size + 4); y -= size + 3; text(line, MARGIN, y, size, b.bold); line = w; } else line = next;
      }
      if (line) { need(size + 4); y -= size + 3; text(line, MARGIN, y, size, b.bold); }
      continue;
    }
    if (b.kind === 'table') {
      const size = b.size || 8;
      const cols = b.columns;
      const cells = b.rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v))));
      const want = cols.map((col, i) => Math.max(textWidth(col.label, size) + 6, ...cells.map((r) => textWidth(r[i] || '', size) + 6), 24));
      const total = want.reduce((a, n) => a + n, 0);
      const widths = total > usable ? want.map((n) => (n / total) * usable) : want;
      const header = () => {
        need(size + 8);
        y -= size + 4;
        let x = MARGIN;
        cols.forEach((col, i) => {
          const t = fit(col.label, widths[i] - 4, size);
          text(t, col.num ? x + widths[i] - 3 - textWidth(t, size) : x + 2, y, size, true);
          x += widths[i];
        });
        ops.push(`${MARGIN} ${(y - 3).toFixed(2)} m ${(MARGIN + widths.reduce((a, n) => a + n, 0)).toFixed(2)} ${(y - 3).toFixed(2)} l 0.5 w S`);
        y -= 3;
      };
      header();
      cells.forEach((r, ri) => {
        if (y - (size + 4) < MARGIN + 14) { newPage(); header(); }
        y -= size + 3;
        let x = MARGIN;
        const bold = b.boldRows && b.boldRows.includes(ri);
        cols.forEach((col, i) => {
          const t = fit(r[i] || '', widths[i] - 4, size);
          text(t, col.num ? x + widths[i] - 3 - textWidth(t, size) : x + 2, y, size, bold);
          x += widths[i];
        });
      });
      y -= 6;
      continue;
    }
  }
  newPage();

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then a page and a content stream per page.
  const objs = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const foot = `BT /F1 7 Tf ${MARGIN} ${(MARGIN - 12).toFixed(2)} Td (${esc(`${footer ? `${footer}  ` : ''}Page ${i + 1} of ${pages.length}`)}) Tj ET`;
    const stream = Buffer.from([...p, foot].join('\n'), 'latin1');
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = { stream };
  });
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  for (let n = 1; n < objs.length; n += 1) {
    offsets[n] = pos;
    const o = objs[n];
    const body = typeof o === 'string'
      ? Buffer.from(`${n} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(body);
    pos += body.length;
  }
  const xref = [`xref\n0 ${objs.length}\n0000000000 65535 f \n`, ...offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = { write, textWidth };
