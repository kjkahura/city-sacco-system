'use strict';

const { err } = require('./errors');
const { orgToday } = require('./orgDate');

/**
 * Dates a request posts money on. A posting is dated today or earlier (the
 * organization's day): interest, fees, repayments and share movements dated
 * in the future would credit or charge for days that have not happened.
 * Postdated payments are a separate, explicit flow and do not use this.
 */
const label = (name) => name.replace(/[A-Z]/g, (x) => `_${x}`).toUpperCase();

async function notAfterToday(c, v, name = 'valueDate') {
  if (v === undefined || v === null || v === '') return;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(s) || Number.isNaN(Date.parse(`${s.slice(0, 10)}T00:00:00Z`))) {
    throw err(`INVALID_${label(name)}: a date as yyyy-MM-dd`, 400);
  }
  if (s.slice(0, 10) > await orgToday(c)) throw err(`${label(name)}_IS_IN_THE_FUTURE: post on today or an earlier day`, 400);
}

module.exports = { notAfterToday };
