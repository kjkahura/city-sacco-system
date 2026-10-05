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
 * as on the reference platform, except in JSON outside quotation marks,
 * where it is null.
 */

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const jsonText = (v) => JSON.stringify(String(v)).slice(1, -1);
const xmlText = (v) => String(v).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));

// Whether the text so far ends inside a JSON string: an odd number of unescaped quotation marks.
const insideString = (before) => ((before.match(/(?<!\\)"/g) || []).length % 2) === 1;

/** Names used in a body, in order of first use. */
function namesIn(body) {
  return [...new Set([...String(body || '').matchAll(TOKEN)].map((m) => m[1]))];
}

// HTML (an email's body): the characters that could open a tag, an attribute or an entity.
const htmlText = (v) => String(v).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[ch]));

function fill(body, values, contentType) {
  const esc = contentType === 'JSON' ? jsonText : contentType === 'XML' ? xmlText : contentType === 'HTML' ? htmlText : String;
  return String(body || '').replace(TOKEN, (_, name, at, whole) => {
    const v = values[name] ?? values[name.toUpperCase()];
    const empty = v === null || v === undefined || v === '';
    // In JSON, a placeholder outside quotation marks with no value is null, so the body stays valid.
    if (empty && contentType === 'JSON' && !insideString(whole.slice(0, at))) return 'null';
    return empty ? '' : esc(v);
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

/**
 * Where a placeholder may stand in an email's HTML: in text, or inside a
 * quoted attribute value. Escaping keeps a value from closing a quoted
 * attribute, but an unquoted one ends at a space, and a link that starts
 * with a value could be made to run script in a mail app that allows it.
 */
function assertHtmlPlaceholders(body) {
  const text = String(body || '');
  if (/=\s*\{\{/.test(text)) throw err('PLACEHOLDERS_IN_ATTRIBUTES_MUST_BE_QUOTED: write name="{{PLACEHOLDER}}"');
  if (/\b(href|src|action|formaction|background|poster)\s*=\s*["']\s*\{\{/i.test(text)) {
    throw err('A_LINK_CANNOT_START_WITH_A_PLACEHOLDER: start it with https:// or mailto:');
  }
}

/** An email's subject, filled: one line, so a value cannot add a header. */
function subject(text, values) {
  return fill(text, values, 'PLAIN_TEXT').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 255);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** The plain-text part of an HTML email: paragraphs and breaks kept, tags dropped, entities read. */
function textOf(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
      // A reference to a code point that does not exist reads as the replacement character, not an error.
      const point = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd');
      if (/^#x/i.test(e)) return point(parseInt(e.slice(2), 16));
      if (/^#\d/.test(e)) return point(Number(e.slice(1)));
      return m;
    })
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { fill, namesIn, assertBody, xmlWellFormed, subject, textOf, htmlText, assertHtmlPlaceholders };
