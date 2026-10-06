'use strict';

const { err } = require('./errors');

/**
 * The YAML the configuration-as-code endpoints read and write: block
 * mappings and sequences, plain and quoted scalars, true/false, null (~),
 * numbers, comments, and flow collections of scalars ([a, b], {}). No
 * anchors, tags or multi-document streams: configuration files do not need
 * them, and leaving them out keeps the parser small enough to read.
 */

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const PLAIN = /^[A-Za-z_][A-Za-z0-9_ .\/@-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  const s = String(v);
  if (s !== '' && PLAIN.test(s) && !RESERVED.test(s) && !/\s$/.test(s) && !/: /.test(s)) return s;
  return JSON.stringify(s);
}

function emit(v, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return ' []';
    return `\n${v.map((x) => {
      if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length) {
        const [first, ...rest] = Object.entries(x);
        const head = `${pad}- ${first[0]}:${emit(first[1], indent + 4)}`;
        return [head, ...rest.map(([k, y]) => `${pad}  ${k}:${emit(y, indent + 4)}`)].join('\n');
      }
      return `${pad}-${emit(x, indent + 2)}`;
    }).join('\n')}`;
  }
  if (v && typeof v === 'object') {
    const e = Object.entries(v);
    if (!e.length) return ' {}';
    return `\n${e.map(([k, y]) => `${pad}${k}:${emit(y, indent + 2)}`).join('\n')}`;
  }
  return ` ${scalar(v)}`;
}

/** An object as YAML text (keys in their insertion order). */
function stringify(obj) {
  return `${emit(obj, 0).replace(/^\n/, '')}\n`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) { if (ch === '\\' && q === '"') i += 1; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function splitFlow(inner, lineNo) {
  const out = []; let cur = ''; let q = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (q) { cur += ch; if (ch === '\\' && q === '"') { cur += inner[i + 1]; i += 1; } else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; } else if (ch === ',') { out.push(cur); cur = ''; } else if ('[]{}'.includes(ch)) {
      throw err(`YAML_NESTED_FLOW_COLLECTIONS_ARE_NOT_SUPPORTED: line ${lineNo}`, 400);
    } else cur += ch;
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out.map((x) => x.trim());
}

function parseScalar(raw, lineNo) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw err(`YAML_UNTERMINATED_STRING: line ${lineNo}`, 400);
    try { return JSON.parse(s); } catch { throw err(`YAML_BAD_STRING: line ${lineNo}`, 400); }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw err(`YAML_UNTERMINATED_STRING: line ${lineNo}`, 400);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw err(`YAML_UNTERMINATED_LIST: line ${lineNo}`, 400);
    return splitFlow(s.slice(1, -1), lineNo).map((x) => parseScalar(x, lineNo));
  }
  if (s.startsWith('{')) {
    if (s !== '{}' && s.replace(/\s/g, '') !== '{}') throw err(`YAML_FLOW_MAPPINGS_ARE_NOT_SUPPORTED: line ${lineNo}`, 400);
    return {};
  }
  if (/^[&*!|>]/.test(s)) throw err(`YAML_FEATURE_NOT_SUPPORTED: line ${lineNo}: ${s[0]}`, 400);
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  return s;
}

// A "key: value" split on the first ": " (or a trailing ":") outside quotes.
function splitKey(text) {
  let q = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) { if (ch === '\\' && q === '"') i += 1; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ')) {
      let key = text.slice(0, i).trim();
      if (/^["']/.test(key)) key = parseScalar(key, 0);
      return [String(key), text.slice(i + 1)];
    }
  }
  return null;
}

/** YAML text (the subset above) as plain objects. Errors name the line. */
function parse(text) {
  const lines = [];
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    if (/\t/.test(raw.match(/^\s*/)[0])) throw err(`YAML_TABS_ARE_NOT_ALLOWED_FOR_INDENTATION: line ${i + 1}`, 400);
    const t = stripComment(raw);
    if (t.trim() === '' || t.trim() === '---') return;
    lines.push({ indent: t.match(/^ */)[0].length, text: t.trim(), no: i + 1 });
  });
  let pos = 0;

  function block(indent) {
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.indent < indent) return null;
    if (first.text.startsWith('- ') || first.text === '-') return seq(first.indent);
    return map(first.indent);
  }

  function valueAfter(rest, parentIndent, lineNo) {
    if (rest.trim() !== '') return parseScalar(rest, lineNo);
    const next = lines[pos];
    if (next && (next.indent > parentIndent || (next.indent === parentIndent && next.text.startsWith('-')))) return block(next.indent);
    return null;
  }

  function map(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ') && lines[pos].text !== '-') {
      const ln = lines[pos];
      const kv = splitKey(ln.text);
      if (!kv) throw err(`YAML_EXPECTED_KEY_VALUE: line ${ln.no}`, 400);
      if (Object.prototype.hasOwnProperty.call(out, kv[0])) throw err(`YAML_DUPLICATE_KEY: line ${ln.no}: ${kv[0]}`, 400);
      // A key that would reach an object's prototype is refused, not written.
      if (['__proto__', 'constructor', 'prototype'].includes(kv[0])) throw err(`YAML_KEY_NOT_ALLOWED: line ${ln.no}: ${kv[0]}`, 400);
      pos += 1;
      out[kv[0]] = valueAfter(kv[1], indent, ln.no);
    }
    if (pos < lines.length && lines[pos].indent > indent) throw err(`YAML_BAD_INDENTATION: line ${lines[pos].no}`, 400);
    return out;
  }

  function seq(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const ln = lines[pos];
      const rest = ln.text === '-' ? '' : ln.text.slice(2);
      if (rest.trim() === '') { pos += 1; out.push(valueAfter('', indent, ln.no)); continue; }
      const kv = /^["'[{]/.test(rest.trim()) ? null : splitKey(rest);
      if (!kv) { pos += 1; out.push(parseScalar(rest, ln.no)); continue; }
      // "- key: value" starts a mapping whose other keys sit under the key.
      const itemIndent = indent + 2 + (rest.length - rest.trimStart().length);
      lines[pos] = { indent: itemIndent, text: rest.trim(), no: ln.no };
      out.push(map(itemIndent));
    }
    if (pos < lines.length && lines[pos].indent > indent) throw err(`YAML_BAD_INDENTATION: line ${lines[pos].no}`, 400);
    return out;
  }

  const out = block(0);
  if (pos < lines.length) throw err(`YAML_BAD_INDENTATION: line ${lines[pos].no}`, 400);
  return out;
}

module.exports = { parse, stringify };
