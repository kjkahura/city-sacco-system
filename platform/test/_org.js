'use strict';

/**
 * The organization's calendar in tests. A tenant's day is its local day
 * (Africa/Nairobi unless a test changes it), so a date a test computes has to
 * start from that day, not from the UTC day, or a run between 21:00 and
 * midnight UTC compares dates a day apart.
 */
const { addDays } = require('../src/lib/orgDate');

const orgToday = (tz = 'Africa/Nairobi') => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const orgDay = (n = 0, tz = 'Africa/Nairobi') => addDays(orgToday(tz), n);

module.exports = { orgToday, orgDay, addDays };
