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

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
      || (a === 169 && b === 254) // link-local, cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
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
 * { status, body } (the first 2 KB of the answer) or { error } (a timeout,
 * a refused address, a network or TLS failure). Redirects are answers, not
 * followed.
 */
function send({ url, method = 'POST', headers = {}, body = '', timeoutMs = 10_000, agent = 'sacco-platform' }) {
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
      res.on('data', (d) => { if (size < KEEP) { chunks.push(d); size += d.length; } });
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, KEEP) }));
      res.on('error', (e) => finish({ status: res.statusCode, error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('TIMED_OUT')));
    req.on('error', (e) => finish({ error: e.message }));
    req.end(payload);
  });
}

module.exports = { isPrivateAddress, checkUrl, guardedLookup, send, allowPrivate };
