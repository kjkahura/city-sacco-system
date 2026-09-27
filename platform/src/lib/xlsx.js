'use strict';

const { zip, unzip } = require('./zip');

/**
 * Excel workbooks (.xlsx, Office Open XML), written and read without a
 * dependency. Only what the data import needs: sheets of plain cells, a bold
 * header row, a red style for error notes, and reading back what Excel,
 * LibreOffice or Google Sheets save (shared strings, inline strings,
 * numbers, booleans, and dates stored as serial numbers under a date
 * format). Formulas are read by their cached value.
 */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 has no place for most control characters.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function unesc(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Styles: 0 plain, 1 bold (headers), 2 red (error notes), 3 grey italic (hints),
// 4 bold on green, 5 bold on grey, 6 red fill.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// input: a green header (a sheet to fill in); reference: a grey header (a
// sheet of what is already in the system); bad: a red cell (an error).
const STYLE = { bold: 1, error: 2, hint: 3, input: 4, reference: 5, bad: 6 };

function cellXml(v, ref, style) {
  const s = style ? ` s="${style}"` : '';
  if (v === null || v === undefined || v === '') return style ? `<c r="${ref}"${s}/>` : '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  const text = String(v);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${esc(text)}</t></is></c>`;
}

/**
 * Write a workbook.
 * @param {{name: string, rows: any[][], widths?: number[], styles?: Record<string, 'bold'|'error'|'hint'>, headerRows?: number}[]} sheets
 *   `styles` maps a cell reference (A1) to a style; the first `headerRows`
 *   rows (default 1) are bold.
 */
function write(sheets) {
  const files = [];
  const ws = sheets.map((sh, i) => {
    const header = sh.headerRows ?? 1;
    const rows = sh.rows.map((r, ri) => {
      const cells = r.map((v, ci) => {
        const ref = `${colName(ci)}${ri + 1}`;
        const st = sh.styles?.[ref] ? STYLE[sh.styles[ref]] : ri < header ? STYLE[sh.headerStyle || 'bold'] : 0;
        return cellXml(v, ref, st);
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const widths = (sh.widths || []).map((w, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${w}" customWidth="1"/>`).join('');
    const pane = header ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${header}" topLeftCell="A${header + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${widths ? `<cols>${widths}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`,
    });
    return { name: String(sh.name).slice(0, 31), id: i + 1 };
  });
  files.unshift(
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${ws.map((w) => `<Override PartName="/xl/worksheets/sheet${w.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${ws.map((w) => `<sheet name="${esc(w.name)}" sheetId="${w.id}" r:id="rId${w.id}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ws.map((w) => `<Relationship Id="rId${w.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${w.id}.xml"/>`).join('')}<Relationship Id="rId${ws.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
  );
  return zip(files);
}

// Built-in number formats that are dates (ECMA-376 18.8.30).
const DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Excel's 1900 date system: serial 25569 is 1970-01-01. */
function serialToDate(n) {
  const ms = Math.round((Number(n) - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const hasTime = Math.abs(Number(n) % 1) > 1e-9;
  return hasTime ? d.toISOString().replace('.000Z', 'Z') : d.toISOString().slice(0, 10);
}

const invalid = (m) => Object.assign(new Error(`INVALID_WORKBOOK: ${m}`), { status: 400 });

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unesc(m[1]) : null;
}

/** Text of an <si> or <is>: its <t>, or the <t> of every rich-text run. */
function textOf(xml) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  // Phonetic runs (<rPh>) are furigana, not the cell's text.
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  while ((m = re.exec(clean))) out += m[1] ? unesc(m[1]) : '';
  return out;
}

/**
 * Read a workbook into [{ name, rows }], rows as arrays of cell values
 * (string, number, boolean, or a yyyy-MM-dd string for a date cell).
 */
function read(buf) {
  let files;
  try { files = unzip(buf); } catch (e) { throw invalid('not an .xlsx file (it is not a ZIP)'); }
  const get = (n) => files.get(n)?.toString('utf8');
  const wb = get('xl/workbook.xml');
  if (!wb) throw invalid('not an .xlsx file (no xl/workbook.xml)');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const target = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) target.set(attr(m[0], 'Id'), attr(m[0], 'Target'));

  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');

  // Which cell styles are dates.
  const dateStyles = new Set();
  const styles = get('xl/styles.xml');
  if (styles) {
    const custom = new Map();
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') || '');
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
    if (xfs) {
      let i = 0;
      for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) {
        const id = Number(attr(m[0], 'numFmtId') || 0);
        const code = (custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
        if (DATE_FMTS.has(id) || (custom.has(id) && /[dy]/i.test(code) && !/^[#0.,% ]*$/.test(code))) dateStyles.add(i);
        i += 1;
      }
    }
  }

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'r:id');
    let path = target.get(rid) || '';
    path = path.startsWith('/') ? path.slice(1) : `xl/${path.replace(/^\.\//, '')}`;
    const xml = get(path);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const rowAttrs = r[1] || r[3] || '';
      const rn = Number(attr(`<row ${rowAttrs}>`, 'r')) || rows.length + 1;
      const row = [];
      for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c ${c[1]}>`;
        const ref = attr(tag, 'r');
        const t = attr(tag, 't') || 'n';
        const s = Number(attr(tag, 's') || 0);
        const inner = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let val = null;
        if (t === 's') val = v ? shared[Number(v[1])] ?? '' : '';
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str') val = v ? unesc(v[1]) : '';
        else if (t === 'b') val = v ? v[1] === '1' : null;
        else if (t === 'e') val = v ? unesc(v[1]) : null;
        else if (v && v[1] !== '') {
          const num = Number(v[1]);
          val = dateStyles.has(s) ? serialToDate(num) : num;
        }
        const ci = ref ? colIndex(ref) : row.length;
        row[ci] = val;
      }
      for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = null;
      rows[rn - 1] = row;
    }
    for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
    sheets.push({ name, rows });
  }
  return sheets;
}

module.exports = { write, read, colName, colIndex, serialToDate };
