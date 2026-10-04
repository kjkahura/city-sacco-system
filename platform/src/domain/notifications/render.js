'use strict';

const { err } = require('../../lib/errors');

/**
 * Filling a body's {{PLACEHOLDER}}s, and checking that a JSON or XML body is
 * still well formed once filled.
 *
 * In a JSON body a value is written as JSON string content (quotation marks,
 * backslashes and newlines escaped), so `"name": "{{CLIENT_NAME}}"` stays
 * valid whatever the member is called. In an XML body the five XML
 * characters are escaped. A placeholder with no value is an empty string,
 * as on the reference platform.
 */

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const jsonText = (v) => JSON.stringify(String(v)).slice(1, -1);
const xmlText = (v) => String(v).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));

/** Names used in a body, in order of first use. */
function namesIn(body) {
  return [...new Set([...String(body || '').matchAll(TOKEN)].map((m) => m[1]))];
}

function fill(body, values, contentType) {
  const esc = contentType === 'JSON' ? jsonText : contentType === 'XML' ? xmlText : String;
  return String(body || '').replace(TOKEN, (_, name) => {
    const v = values[name] ?? values[name.toUpperCase()];
    return v === null || v === undefined ? '' : esc(v);
  });
}

/** A light well-formedness check: tags balance and nest, and there is one root. */
function xmlWellFormed(text) {
  const s = String(text).replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').trim();
  if (!s.startsWith('<')) return false;
  const stack = [];
  let roots = 0;
  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  let m;
  let last = 0;
  while ((m = re.exec(s))) {
    if (/[<>]/.test(s.slice(last, m.index))) return false;
    last = re.lastIndex;
    const [, close, name, , self] = m;
    if (close) { if (stack.pop() !== name) return false; continue; }
    if (!stack.length) roots += 1;
    if (!self) stack.push(name);
  }
  return stack.length === 0 && roots === 1 && !/[<>]/.test(s.slice(last));
}

/** Throw when a filled body is not what its content type says. */
function assertBody(text, contentType) {
  if (contentType === 'JSON') {
    try { JSON.parse(text); } catch (e) { throw err(`INVALID_JSON_BODY_SYNTAX: ${e.message}`); }
  } else if (contentType === 'XML' && !xmlWellFormed(text)) {
    throw err('INVALID_XML_BODY_SYNTAX: the tags do not balance or there is not one root element');
  }
}

module.exports = { fill, namesIn, assertBody, xmlWellFormed };
