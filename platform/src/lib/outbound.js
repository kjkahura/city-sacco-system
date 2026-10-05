'use strict';

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { err } = require('./errors');

/**
 * Requests the server makes to an address a tenant chose: the backup
 * callback and webhooks.
 *
 * Left open, such a request would let a tenant user make the platform call
 * its own internal services (the metadata endpoint of a cloud host, a
 * database admin page on the private network). So: https only, no
 * credentials in the URL, and every address the name resolves to must be
 * public. The check runs inside the connection's own DNS lookup, so a name
 * that resolves to a public address when checked and a private one when
 * connected (DNS rebinding) is caught at the connection. Redirects are not
 * followed. CALLBACK_ALLOW_PRIVATE=true lifts the address check (and allows
 * http) for development and tests only.
 */

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/** An IPv6 address as its eight 16-bit groups, or null. */
function groupsOf(v6) {
  let s = v6.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail].map((x) => parseInt(x || '0', 16));
  return all.length === 8 && all.every((x) => x >= 0 && x <= 0xffff) ? all : null;
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return v4Private(ip);
  const g = groupsOf(ip);
  if (!g) return true; // not an address we can read: refuse
  const zeros = (n) => g.slice(0, n).every((x) => x === 0);
  if (g.every((x) => x === 0) || (zeros(7) && g[7] === 1)) return true; // :: and ::1
  // IPv4 carried inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16).
  if (zeros(5) && g[5] === 0xffff) return v4Private(v4From(g[6], g[7]));
  if (zeros(6)) return v4Private(v4From(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Private(v4From(g[6], g[7]));
  if (g[0] === 0x2002) return v4Private(v4From(g[1], g[2]));
  const first = g[0];
  return (first & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (first & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (first & 0xffc0) === 0xfec0 // site-local fec0::/10
    || (first & 0xff00) === 0xff00 // multicast
    || (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) // discard 100::/64
    || (first === 0x2001 && g[1] === 0x0db8); // documentation
}

const allowPrivate = () => process.env.CALLBACK_ALLOW_PRIVATE === 'true';

/**
 * The URL, normalised, or an error named with the prefix (CALLBACK_URL_...,
 * WEBHOOK_URL_...). An empty value is null.
 */
function checkUrl(raw, { prefix = 'CALLBACK' } = {}) {
  if (raw === undefined || raw === null || raw === '') return null;
  let u;
  try { u = new URL(String(raw)); } catch { throw err(`INVALID_${prefix}_URL`); }
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) throw err(`${prefix}_URL_MUST_BE_HTTPS`);
  if (u.username || u.password) throw err(`${prefix}_URL_MUST_NOT_CARRY_CREDENTIALS`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate() && (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isPrivateAddress(host)))) {
    throw err(`${prefix}_URL_MUST_BE_PUBLIC`);
  }
  if (String(raw).length > 2000) throw err(`${prefix}_URL_TOO_LONG`);
  return u.toString();
}

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (e, addresses) => {
    if (e) return cb(e);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!allowPrivate() && list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error(`HOST_RESOLVES_TO_A_PRIVATE_ADDRESS: ${hostname}`), { code: 'EPRIVATE' }));
    }
    if (options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

const KEEP = 2048;

/**
 * Send one request through the guard. Never throws: the outcome is
 * { status, body } (the first 2 KB of the answer, or maxBytes; a longer answer
 * than a maxBytes above 2 KB is { error: 'ANSWER_TOO_LARGE' }) or { error } (a timeout,
 * a refused address, a network or TLS failure). Redirects are answers, not
 * followed.
 */
function send({ url, method = 'POST', headers = {}, body = '', timeoutMs = 10_000, agent = 'sacco-platform', maxBytes = KEEP }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ error: 'INVALID_URL' }); return; }
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
    const lib = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (out) => { if (!done) { done = true; resolve(out); } };
    const req = lib.request(u, {
      method,
      lookup: guardedLookup,
      timeout: timeoutMs,
      headers: { 'user-agent': agent, ...headers, 'content-length': payload.length },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        if (size <= maxBytes) { chunks.push(d); size += d.length; }
        // A longer answer than the caller reads is cut off, not waited for.
        if (size > maxBytes && maxBytes > KEEP) { finish({ status: res.statusCode, error: 'ANSWER_TOO_LARGE' }); req.destroy(); }
      });
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes) }));
      res.on('error', (e) => finish({ status: res.statusCode, error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('TIMED_OUT')));
    req.on('error', (e) => finish({ error: e.message }));
    // The socket timeout is per idle period; a receiver answering a byte at a time
    // would never trip it. The whole request has the same deadline.
    const deadline = setTimeout(() => { finish({ error: 'TIMED_OUT' }); req.destroy(new Error('TIMED_OUT')); }, timeoutMs);
    deadline.unref?.();
    req.on('close', () => clearTimeout(deadline));
    req.end(payload);
  });
}

module.exports = { isPrivateAddress, checkUrl, guardedLookup, send, allowPrivate };
