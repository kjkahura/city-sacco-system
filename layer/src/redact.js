'use strict';

/**
 * What may leave the platform for a model is the loan's purpose (and its notes only
 * when ARCAFIM_INCLUDE_NOTES=on), with the member's names, phone numbers, e-mail
 * addresses and ID, passport and KRA PIN numbers removed (Data Protection Act 2019:
 * data minimisation). Amounts and dates stay: they say nothing about who the member
 * is and help classify the loan.
 *
 * Redaction is a safeguard, not a guarantee: a name the member record does not hold
 * (a guarantor's, say) is not known to it. That is why notes, where such names are
 * written, stay out of the model's input by default.
 */
// Kenyan mobile numbers: 07xx or 01xx, or 254 / +254 with an optional (0), with spaces, dots or dashes.
const PHONE = /(?:\+?254\s?(?:\(0\)\s?)?|\b0)[17]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// KRA PIN (A123456789Z) and passports (one or two letters and 7 or 8 digits).
const PIN = /\b[A-Z]\d{9}[A-Z]\b/gi;
const PASSPORT = /\b[A-Z]{1,2}\d{7,8}\b/gi;
// An ID or account number after a cue word, digits possibly spaced: "ID 23 456 789", "No. 1234567".
const CUED = /\b(ID|I\.D\.|id no|national id|no|number|nambari|pin|passport|account|acc|a\/c)\b[\s.:#-]*\d[\d\s-]{5,14}\d/gi;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redact(text, { names = [] } = {}) {
  let s = String(text || '');
  s = s.replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(PIN, '[number]').replace(PASSPORT, '[number]')
    .replace(CUED, (m, cue) => `${cue} [number]`);
  for (const n of names) {
    for (const part of String(n || '').split(/\s+/)) {
      if (part.length < 2) continue;
      // Letter boundaries in Unicode, so names such as Ngũgĩ or Mũthoni are matched whole.
      s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(part)}(?![\\p{L}\\p{N}])`, 'giu'), '[name]');
    }
  }
  return s.slice(0, 2000);
}

module.exports = { redact };
