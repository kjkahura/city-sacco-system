'use strict';

/**
 * Deposit (SA) and share (SH) account numbers: the prefix and the counter,
 * zero-padded to six digits and never cut (SA1000000 follows SA999999).
 * The counter row is locked while a number is given out, so two accounts
 * opened at once get different numbers, and a number already taken (by an
 * import or by hand) is stepped over. Loan numbers come from their
 * product's ID pattern (./loans).
 *
 * Depends on nothing but the database.
 */

async function next(c, kind) {
  const { rows: [k] } = await c.query('SELECT prefix, width, next_number FROM account_counters WHERE kind = $1 FOR UPDATE', [kind]);
  if (!k) throw Object.assign(new Error(`NO_ACCOUNT_COUNTER: ${kind}`), { status: 500 });
  let n = Number(k.next_number);
  for (let tries = 0; tries < 100000; tries += 1, n += 1) {
    const no = `${k.prefix}${String(n).padStart(k.width, '0')}`;
    const { rows: [t] } = await c.query('SELECT account_no_taken($1, $2) AS taken', [kind, no]);
    if (!t.taken) {
      await c.query('UPDATE account_counters SET next_number = $2 WHERE kind = $1', [kind, n + 1]);
      return no;
    }
  }
  throw Object.assign(new Error(`NO_FREE_ACCOUNT_NUMBER: ${kind}`), { status: 409 });
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I or O, which read as 1 and 0
const DIGITS = '0123456789';
const pick = (s) => s[Math.floor(Math.random() * s.length)];

/**
 * Fill an ID pattern. '#' is a digit, '@' a letter, '$' either, anything
 * else literal. With a sequence number the run of '#' carries it,
 * zero-padded; the extra digits of a number that outgrew the run go on its
 * front. Without one every placeholder is drawn.
 */
function fillPattern(pattern, sequence = null) {
  const hashes = (pattern.match(/#/g) || []).length;
  const digits = sequence === null ? null : String(sequence).padStart(hashes, '0');
  if (digits && digits.length > hashes) pattern = pattern.replace('#', '#'.repeat(digits.length - hashes + 1));
  let di = 0;
  let out = '';
  for (const ch of pattern) {
    if (ch === '#') out += digits ? digits[di++] : pick(DIGITS);
    else if (ch === '@') out += pick(LETTERS);
    else if (ch === '$') out += pick(LETTERS + DIGITS);
    else out += ch;
  }
  return out;
}

/**
 * A deposit account number under its product's new account settings
 * (The reference platform): INCREMENTAL_NUMBER counts from the product's starting number,
 * digits only; RANDOM_PATTERN fills the pattern. A product with neither
 * uses the shared SA series. Numbers already taken are stepped over.
 */
async function forProduct(c, p) {
  if (!p.id_generator_type) return next(c, 'SAVINGS');
  if (p.id_generator_type === 'INCREMENTAL_NUMBER') {
    const { rows: [r] } = await c.query(
      'UPDATE savings_products SET id_next = COALESCE(id_next, $2::bigint) + 1 WHERE id = $1 RETURNING id_next - 1 AS n', [p.id, Number(p.id_pattern)]);
    let n = Number(r.n);
    for (let tries = 0; tries < 100000; tries += 1, n += 1) {
      const { rows: [t] } = await c.query("SELECT account_no_taken('SAVINGS', $1) AS taken", [String(n)]);
      if (!t.taken) {
        await c.query('UPDATE savings_products SET id_next = GREATEST(id_next, $2::bigint) WHERE id = $1', [p.id, n + 1]);
        return String(n);
      }
    }
    throw Object.assign(new Error(`NO_FREE_ACCOUNT_NUMBER: ${p.id}`), { status: 409 });
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const no = fillPattern(p.id_pattern);
    const { rows: [t] } = await c.query("SELECT account_no_taken('SAVINGS', $1) AS taken", [no]);
    if (!t.taken) return no;
  }
  throw Object.assign(new Error(`ID_PATTERN_EXHAUSTED: ${p.id_pattern}`), { status: 409 });
}

module.exports = { next, fillPattern, forProduct };
