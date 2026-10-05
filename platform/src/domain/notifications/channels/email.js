'use strict';

const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const nodemailer = require('nodemailer');
const { err } = require('../../../lib/errors');
const OUT = require('../../../lib/outbound');

/**
 * The email channel: a SACCO's own SMTP server or provider, with the
 * reference platform's settings (From Name, From Email, Reply-to, SMTP Host,
 * SMTP Port, Transport Encryption, Username and Password).
 *
 * The host is a tenant's choice, so it gets the outbound guard: the name is
 * resolved here, every address must be public, and the connection goes to
 * the address checked (so a name cannot resolve differently at connection
 * time). TLS is required, implicit on 465 or by STARTTLS on 587, with the
 * certificate checked against the host name, so the password never travels
 * in clear. SMTP_ALLOWED_PORTS and SMTP_EXTRA_CA_FILE are for tests and
 * development.
 *
 * A send never throws. It returns { ok: true } or { ok: false, reason,
 * cause, permanent }: a refused sign-in or a 5xx answer is permanent; a 4xx
 * answer, a timeout or a network error is temporary and retried.
 */

const ENCRYPTIONS = ['SSL_TLS', 'STARTTLS'];
const EMAIL = /^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const allowedPorts = () => String(process.env.SMTP_ALLOWED_PORTS || '465,587').split(',').map((p) => Number(p.trim())).filter(Boolean);
const timeoutMs = () => Number(process.env.SMTP_TIMEOUT_MS || 15_000);

const isEmail = (v) => EMAIL.test(String(v || '')) && String(v).length <= 254;
const oneLine = (v, max, code) => {
  const s = String(v ?? '').trim();
  if (/[\r\n]/.test(s) || s.length > max) throw err(code);
  return s;
};

/** The settings as stored (no secret), checked; `secret` is the new password, or undefined to keep the stored one. */
function validate(b) {
  const fromName = oneLine(b.fromName, 100, 'FROM_NAME_IS_ONE_LINE_OF_AT_MOST_100_CHARACTERS');
  const fromEmail = String(b.fromEmail || '').trim();
  if (!isEmail(fromEmail)) throw err('FROM_EMAIL_MUST_BE_AN_EMAIL_ADDRESS');
  const replyTo = String(b.replyTo || '').trim() || null;
  if (replyTo && !isEmail(replyTo)) throw err('REPLY_TO_MUST_BE_AN_EMAIL_ADDRESS');
  const host = String(b.host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || !(HOST.test(host) || net.isIP(host))) throw err('SMTP_HOST_MUST_BE_A_HOST_NAME_OR_ADDRESS');
  const port = Number(b.port);
  if (!allowedPorts().includes(port)) throw err(`SMTP_PORT_MUST_BE_ONE_OF: ${allowedPorts().join(', ')}`);
  const encryption = String(b.encryption || '').toUpperCase();
  if (!ENCRYPTIONS.includes(encryption)) throw err('TRANSPORT_ENCRYPTION_MUST_BE_SSL_TLS_OR_STARTTLS');
  const username = b.username === undefined || b.username === null ? null : oneLine(b.username, 255, 'USERNAME_IS_ONE_LINE_OF_AT_MOST_255_CHARACTERS') || null;
  if (b.password !== undefined && b.password !== null && String(b.password).length > 512) throw err('PASSWORD_IS_AT_MOST_512_CHARACTERS');
  return { settings: { fromName, fromEmail, replyTo, host, port, encryption, username }, secret: b.password === undefined || b.password === null ? undefined : String(b.password) };
}

/** What a stored password is for: it is not sent to any other server. */
const server = (s) => (s && s.host ? `${String(s.host).toLowerCase()}|${s.port}|${s.username || ''}` : '');

const describe = (s) => ({
  fromName: s.fromName || '', fromEmail: s.fromEmail || null, replyTo: s.replyTo || null, host: s.host || null,
  port: s.port || null, encryption: s.encryption || null, username: s.username || null,
});

/** The address to connect to: the host's, refused when any address it has is private. */
async function addressOf(host) {
  if (net.isIP(host)) {
    if (!OUT.allowPrivate() && OUT.isPrivateAddress(host)) throw Object.assign(new Error(`SMTP_HOST_MUST_BE_PUBLIC: ${host} is a private address`), { code: 'EPRIVATE' });
    return host;
  }
  if (!OUT.allowPrivate() && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw Object.assign(new Error(`SMTP_HOST_MUST_BE_PUBLIC: ${host} is a private address`), { code: 'EPRIVATE' });
  }
  const list = await dns.lookup(host, { all: true });
  if (!list.length) throw Object.assign(new Error(`SMTP_HOST_NOT_FOUND: ${host}`), { code: 'EDNS' });
  if (!OUT.allowPrivate() && list.some((a) => OUT.isPrivateAddress(a.address))) {
    throw Object.assign(new Error(`SMTP_HOST_MUST_BE_PUBLIC: ${host} resolves to a private address`), { code: 'EPRIVATE' });
  }
  return list[0].address;
}

let extraCa;
function ca() {
  // An extra authority is added to the ones Node trusts, not put in their place.
  if (extraCa === undefined) extraCa = process.env.SMTP_EXTRA_CA_FILE ? [...tls.rootCertificates, fs.readFileSync(process.env.SMTP_EXTRA_CA_FILE, 'utf8')] : null;
  return extraCa || undefined;
}

function transport(s, password, address) {
  const t = timeoutMs();
  return nodemailer.createTransport({
    host: address, port: s.port, secure: s.encryption === 'SSL_TLS', requireTLS: s.encryption === 'STARTTLS',
    auth: s.username ? { user: s.username, pass: password || '' } : undefined,
    tls: { ...(net.isIP(s.host) ? {} : { servername: s.host }), rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: ca() },
    name: 'sacco-platform', connectionTimeout: t, greetingTimeout: t, socketTimeout: t, dnsTimeout: t,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

/** The outcome of a failed send, named as the reference platform names it. */
function failureOf(e) {
  const code = Number(e.responseCode) || null;
  const cause = String(`${code ? `${code} ` : ''}${e.response || e.message || e.code || 'error'}`).replace(/\s+/g, ' ').slice(0, 500);
  if (e.code === 'EAUTH' || code === 535 || code === 534) return { ok: false, reason: 'INVALID_SMTP_CREDENTIALS', cause, permanent: true };
  if (e.code === 'EPRIVATE') return { ok: false, reason: 'MESSAGING_EXCEPTION', cause, permanent: true };
  if (code && code >= 500) return { ok: false, reason: 'MESSAGING_EXCEPTION', cause, permanent: true };
  return { ok: false, reason: 'MESSAGING_EXCEPTION', cause, permanent: false };
}

/**
 * Send one email: { to, subject, html, text, id }. The whole send has a
 * deadline as well as the per-stage timeouts.
 */
async function send(s, password, { to, subject, html, text, id = null }) {
  let tr;
  let timer;
  try {
    if (!isEmail(to)) return { ok: false, reason: 'UNDEFINED_DESTINATION', cause: `Not an email address: ${String(to).slice(0, 100)}`, permanent: true };
    // One deadline for the whole send, the lookup included.
    const deadline = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('TIMED_OUT'), { code: 'ETIMEDOUT' })), timeoutMs() * 2); });
    const address = await Promise.race([deadline, addressOf(s.host)]);
    tr = transport(s, password, address);
    const info = await Promise.race([deadline, tr.sendMail({
      from: { name: s.fromName || '', address: s.fromEmail }, ...(s.replyTo ? { replyTo: s.replyTo } : {}),
      to, subject, html, text, ...(id ? { headers: { 'X-Notification-Id': String(id) } } : {}),
    })]);
    return { ok: true, response: String(info?.response || '').slice(0, 200) };
  } catch (e) {
    return failureOf(e);
  } finally {
    clearTimeout(timer);
    tr?.close();
  }
}

/** A test email to `to` with these settings (saved or not). */
async function test(s, password, to) {
  if (!isEmail(to)) throw err('TEST_ADDRESS_MUST_BE_AN_EMAIL_ADDRESS');
  const out = await send(s, password, {
    to, subject: `Test email from ${s.fromName || s.fromEmail}`,
    text: 'This is a test email. The settings connected, signed in and handed the message over.',
    html: '<p>This is a test email. The settings connected, signed in and handed the message over.</p>',
  });
  return out.ok ? { ok: true } : { ok: false, failureReason: out.reason, failureCause: out.cause };
}

module.exports = { validate, describe, server, send, test, isEmail, failureOf };
