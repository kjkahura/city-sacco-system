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

module.exports = { next };
