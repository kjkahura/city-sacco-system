'use strict';

const { err } = require('../../../lib/errors');
const PROVIDERS = require('./sms-providers');

/**
 * The SMS channel. The gateway is a provider (./sms-providers): this module
 * keeps what every provider shares, the provider choice and the sender ID,
 * phone numbers in E.164, and the length of a message in segments, and
 * hands each send to the provider.
 *
 * Settings are stored as { provider, senderId, ...the provider's fields };
 * the provider's secret (an API key) is the channel's sealed secret.
 */

// The countries a tenant may be in: calling code and the length of a national (mobile) number.
const COUNTRIES = {
  KE: ['254', 9], UG: ['256', 9], TZ: ['255', 9], RW: ['250', 9], BI: ['257', 8], SS: ['211', 9], ET: ['251', 9],
  NG: ['234', 10], GH: ['233', 9], ZA: ['27', 9], ZM: ['260', 9], MW: ['265', 9], CD: ['243', 9],
};

/**
 * A phone number as E.164 (+254712345678); null when it cannot be read.
 * Read as written: +... or 00... is international; digits that start with a
 * known calling code and have that country's length are international too
 * (256772123456 is Ugandan, not Kenyan); otherwise a national number of the
 * tenant's country, with or without its trunk 0. A tenant in a country not
 * listed reads international numbers only.
 */
function toE164(raw, country = 'KE') {
  const s = String(raw ?? '').trim();
  if (!s || /[A-Za-z]/.test(s)) return null;
  let d = s.replace(/[\s().-]/g, '');
  if (d.startsWith('00')) d = `+${d.slice(2)}`;
  if (d.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
  if (!/^\d+$/.test(d)) return null;
  for (const [cc, len] of Object.values(COUNTRIES)) if (d.startsWith(cc) && d.length === cc.length + len) return `+${d}`;
  const home = COUNTRIES[String(country || '').toUpperCase()];
  if (!home) return null;
  const [cc, len] = home;
  if (d.startsWith('0') && d.length === len + 1) return `+${cc}${d.slice(1)}`;
  if (d.length === len && !d.startsWith('0')) return `+${cc}${d}`;
  return null;
}

// The GSM 03.38 alphabet; the extension characters take two places.
const GSM = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_EXT = new Set('^{}\\[~]|€\f');
const MAX_SEGMENTS = 6;

/**
 * How many segments a text takes: GSM-7 is 160 in one, then 153 a segment;
 * UCS-2 is 70, then 67. In a long message a GSM extension character (two
 * places) or a character outside the basic plane (two UTF-16 units) is never
 * split across segments, so segments are packed character by character.
 */
function segments(text) {
  const chars = [...String(text ?? '')];
  const gsm = chars.every((ch) => GSM.has(ch) || GSM_EXT.has(ch));
  const size = (ch) => (gsm ? (GSM_EXT.has(ch) ? 2 : 1) : ch.length);
  const units = chars.reduce((n, ch) => n + size(ch), 0);
  const [single, part] = gsm ? [160, 153] : [70, 67];
  if (units <= single) return { encoding: gsm ? 'GSM-7' : 'UCS-2', units, count: 1 };
  let count = 1;
  let used = 0;
  for (const ch of chars) {
    const n = size(ch);
    if (used + n > part) { count += 1; used = 0; }
    used += n;
  }
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', units, count };
}

function assertLength(text) {
  const seg = segments(text);
  if (seg.count > MAX_SEGMENTS) {
    throw err(`SMS_TEXT_TOO_LONG: ${seg.count} segments (${seg.units} ${seg.encoding} characters); at most ${MAX_SEGMENTS}`);
  }
  return seg;
}

function providerOf(id) {
  const p = PROVIDERS.get(id);
  if (!p) throw err(`UNKNOWN_SMS_PROVIDER: ${id}; one of ${PROVIDERS.ids().join(', ')}`);
  return p;
}

/** The settings as stored, checked; `secret` is a new API key, or undefined to keep the stored one. */
function validate(b) {
  const provider = String(b.provider || '').toUpperCase();
  const p = providerOf(provider);
  const senderId = String(b.senderId ?? '').trim();
  // An alphanumeric sender ID is at most 11 characters; a numeric one is a phone number of up to 15 digits.
  if (!(/^[A-Za-z0-9 ._-]{1,11}$/.test(senderId) && /[A-Za-z]/.test(senderId)) && !/^\+?\d{3,15}$/.test(senderId)) {
    throw err('SENDER_ID_IS_UP_TO_11_LETTERS_AND_DIGITS_OR_A_NUMBER_OF_UP_TO_15_DIGITS');
  }
  const own = p.validate(b);
  const key = b.apiKey === undefined || b.apiKey === null ? undefined : String(b.apiKey);
  if (key !== undefined && key !== '' && !/^[\x20-\x7e]{1,1024}$/.test(key)) throw err('API_KEY_IS_AT_MOST_1024_PRINTABLE_ASCII_CHARACTERS');
  return { settings: { provider, senderId, ...own }, secret: key };
}

const describe = (s) => {
  if (!s || !s.provider) return { provider: null, senderId: null };
  const p = PROVIDERS.get(s.provider);
  return { provider: s.provider, senderId: s.senderId || null, ...(p ? p.describe(s) : {}) };
};

/** What a stored key is for: it is not sent to any other gateway. */
const server = (s) => (s && s.provider ? `${s.provider}|${PROVIDERS.get(s.provider)?.server(s) || ''}` : '');

/** Send one SMS: { to (E.164), text, id }. Never throws. */
async function send(s, secret, { to, text, id = null }) {
  try {
    return await providerOf(s.provider).send(s, secret, { to, text, from: s.senderId, id });
  } catch (e) {
    return { ok: false, reason: 'SMS_GATEWAY_ERROR', cause: String(e.message || e).slice(0, 500), permanent: true };
  }
}

async function test(s, secret, to, { country = 'KE' } = {}) {
  const number = toE164(to, country);
  if (!number) throw err('TEST_NUMBER_IS_NOT_A_PHONE_NUMBER');
  const out = await send(s, secret, { to: number, text: `Test SMS from ${s.senderId}: the gateway accepted this message.` });
  return out.ok ? { ok: true, providerMessageId: out.providerMessageId || null } : { ok: false, failureReason: out.reason, failureCause: out.cause };
}

/** A gateway's delivery report, read with the provider's rules: [{ providerMessageId, status, detail }]. */
function parseDeliveryReport(s, report) {
  const p = PROVIDERS.get(s?.provider);
  return p?.parseDeliveryReport ? p.parseDeliveryReport(s, report) : [];
}

module.exports = {
  validate, describe, server, send, test, parseDeliveryReport, toE164, segments, assertLength, MAX_SEGMENTS, secretName: 'apiKey',
};
