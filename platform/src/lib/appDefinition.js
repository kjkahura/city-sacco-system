'use strict';

const crypto = require('crypto');
const { err } = require('./errors');
const { checkUrl } = require('./outbound');

/**
 * An app's definition (the reference platform's app XML) and its signed
 * requests (docs/audits/audit-apps.md).
 *
 * The definition:
 *
 *   <application>
 *     <id>…</id> <name>…</name> <provider>…</provider> <description>…</description>
 *     <installURL>…</installURL> <uninstallURL>…</uninstallURL>
 *     <extensionpoint> <location>CLIENT_VIEW</location> <label>…</label> <url>…</url> </extensionpoint>
 *   </application>
 *
 * The root element's name is not checked, and element names are read
 * without regard to case. The reader is our own and small: elements, text,
 * comments, CDATA, the XML declaration, the five standard entities and
 * character references. A DOCTYPE, any other entity and processing
 * instructions are refused, so a definition cannot read files or expand
 * without limit.
 *
 * A signed request is PART1.PART2: PART2 is the base64url of the JSON
 * context, PART1 the base64url of its HMAC-SHA256 with the App Key.
 */

const MAX_BYTES = 64 * 1024;
const MAX_ELEMENTS = 500;
const MAX_DEPTH = 8;
const MAX_POINTS = 50;

// Where an extension point shows, and the record it is opened on.
const LOCATIONS = {
  CLIENT_VIEW: 'CLIENT', GROUP_VIEW: 'GROUP', LOAN_ACCOUNT_VIEW: 'LOAN_ACCOUNT', DEPOSIT_ACCOUNT_VIEW: 'DEPOSIT_ACCOUNT',
  LINE_OF_CREDIT_VIEW: 'LINE_OF_CREDIT', BRANCH_VIEW: 'BRANCH', CENTRE_VIEW: 'CENTRE', LOAN_PRODUCT_VIEW: 'LOAN_PRODUCT',
  DEPOSIT_PRODUCT_VIEW: 'DEPOSIT_PRODUCT', USER_VIEW: 'USER', REPORTING_VIEW: null, EXTENSION_MENU: null,
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const bad = (why) => err(`INVALID_APP_DEFINITION: ${why}`);

function decode(text) {
  if (/&(?!#x[0-9a-f]+;|#[0-9]+;|[a-z]+;)/i.test(text)) throw bad('a bare & in text (write &amp;)');
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n < 1 || n > 0x10ffff) throw bad(`character reference ${m}`);
      return String.fromCodePoint(n);
    }
    if (!Object.hasOwn(ENTITIES, e)) throw bad(`unknown entity ${m}`);
    return ENTITIES[e];
  });
}

/** XML to a tree of { name, children, text }. */
function readXml(xml) {
  if (Buffer.byteLength(xml, 'utf8') > MAX_BYTES) throw err(`APP_DEFINITION_TOO_LARGE: at most ${MAX_BYTES / 1024} KB`, 400);
  let s = xml.replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw bad('a DOCTYPE or entity declaration is not allowed');
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  let i = 0;
  let count = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const text = lt === -1 ? s.slice(i) : s.slice(i, lt);
    if (text) {
      if (stack.length === 1 && text.trim()) throw bad('text outside the root element');
      stack[stack.length - 1].text += decode(text);
    }
    if (lt === -1) break;
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end === -1) throw bad('an unclosed comment');
      i = end + 3;
    } else if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9);
      if (end === -1) throw bad('an unclosed CDATA section');
      if (stack.length === 1) throw bad('CDATA outside the root element');
      stack[stack.length - 1].text += s.slice(lt + 9, end);
      i = end + 3;
    } else if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2);
      if (end === -1) throw bad('an unclosed declaration');
      if (lt !== 0 || !/^<\?xml\s/i.test(s.slice(lt, end + 2))) throw bad('processing instructions are not allowed');
      i = end + 2;
    } else if (s[lt + 1] === '!') {
      throw bad('declarations are not allowed');
    } else {
      // The tag ends at the first > outside a quoted attribute value.
      let end = -1;
      for (let k = lt + 1, q = null; k < s.length; k += 1) {
        const ch = s[k];
        if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') { end = k; break; }
      }
      if (end === -1) throw bad('an unclosed tag');
      const tag = s.slice(lt + 1, end);
      const close = tag.startsWith('/');
      const selfClose = !close && tag.endsWith('/');
      const name = (close ? tag.slice(1) : selfClose ? tag.slice(0, -1) : tag).trim().split(/\s+/)[0];
      if (!/^[A-Za-z_][\w.:-]*$/.test(name)) throw bad(`a tag <${tag.slice(0, 40)}>`);
      if (close) {
        const open = stack.pop();
        if (!open || open.name !== name || stack.length === 0) throw bad(`</${name}> does not close <${open?.name}>`);
      } else {
        if (++count > MAX_ELEMENTS) throw err('APP_DEFINITION_TOO_LARGE: too many elements', 400);
        if (stack.length === 1 && root.children.length) throw bad('more than one root element');
        const el = { name, children: [], text: '' };
        stack[stack.length - 1].children.push(el);
        if (!selfClose) {
          stack.push(el);
          if (stack.length > MAX_DEPTH + 1) throw bad('nested too deeply');
        }
      }
      i = end + 1;
    }
  }
  if (stack.length !== 1) throw bad(`<${stack[stack.length - 1].name}> is not closed`);
  if (!root.children.length) throw bad('no root element');
  return root.children[0];
}

const kids = (el, name) => el.children.filter((c) => c.name.toLowerCase() === name.toLowerCase());
const textOf = (el, name) => {
  const k = kids(el, name);
  if (k.length > 1) throw bad(`more than one <${name}>`);
  const v = k[0]?.text.trim();
  return v === undefined || v === '' ? null : v;
};

function appUrl(raw, what) {
  if (!raw) return null;
  try { return checkUrl(raw, { prefix: 'APP' }); } catch (e) { throw err(`${e.message.split(':')[0]}: ${what}`, 400); }
}

/** A definition, read and checked. */
function parse(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw bad('empty');
  const app = readXml(xml);
  const id = textOf(app, 'id');
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw err('APP_ID_IS_1_TO_64_LETTERS_DIGITS_DOTS_DASHES_OR_UNDERSCORES', 400);
  const name = textOf(app, 'name');
  if (!name || name.length > 256) throw err('APP_NAME_IS_1_TO_256_CHARACTERS', 400);
  const provider = textOf(app, 'provider');
  const description = textOf(app, 'description');
  if (provider && provider.length > 256) throw err('APP_PROVIDER_IS_AT_MOST_256_CHARACTERS', 400);
  if (description && description.length > 4000) throw err('APP_DESCRIPTION_IS_AT_MOST_4000_CHARACTERS', 400);
  const points = [...kids(app, 'extensionpoint'), ...kids(app, 'extensionPoints').flatMap((x) => kids(x, 'extensionpoint'))];
  if (!points.length) throw err('APP_HAS_NO_EXTENSION_POINT', 400);
  if (points.length > MAX_POINTS) throw err(`APP_HAS_TOO_MANY_EXTENSION_POINTS: at most ${MAX_POINTS}`, 400);
  const extensionPoints = points.map((p, position) => {
    const location = String(textOf(p, 'location') || '').toUpperCase();
    if (!(location in LOCATIONS)) throw err(`UNKNOWN_APP_LOCATION: ${location || '(none)'} (use ${Object.keys(LOCATIONS).join(', ')})`, 400);
    const label = textOf(p, 'label') || name;
    if (label.length > 256) throw err('APP_LABEL_IS_AT_MOST_256_CHARACTERS', 400);
    const url = appUrl(textOf(p, 'url'), `extension point ${position + 1}`);
    if (!url) throw err(`APP_EXTENSION_POINT_URL_REQUIRED: extension point ${position + 1}`, 400);
    return { position, location, label, url };
  });
  return {
    id, name, provider, description, extensionPoints,
    installUrl: appUrl(textOf(app, 'installURL'), 'installURL'),
    uninstallUrl: appUrl(textOf(app, 'uninstallURL'), 'uninstallURL'),
  };
}

/** PART1.PART2 for a context, with the App Key. */
function sign(context, appKey) {
  const data = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', ...context }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', String(appKey)).update(data).digest('base64url');
  return `${sig}.${data}`;
}

module.exports = { parse, sign, LOCATIONS, MAX_BYTES };
