#!/usr/bin/env node
'use strict';

/**
 * Financial years, the year-end close and the statutory reserve transfer.
 *
 * Everything happens in last year so the current year stays open and the
 * other suites can keep posting.
 */

const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const acct = require('../src/domain/accounting');
const CL = require('../src/domain/close');
const R = require('../src/domain/reports');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
async function throws(label, fn, matcher) {
  try { await fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, matcher ? matcher(e) : true, e.message.slice(0, 160)); }
}

const SLUG = 'cltest';
const SCHEMA = `tenant_${SLUG}`;
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);

const YEAR = new Date().getFullYear() - 1;
const IN_YEAR = `${YEAR}-06-30`;
const YEAR_END = `${YEAR}-12-31`;

const bal = (code) => Rd((c) => acct.balance(c, code));
// pg hands back DATE as a Date object; compare the calendar day, not the
// stringified timestamp.
const day = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

async function assertBalanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced,
    `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}

(async () => {
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Close Test SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@cltest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});

    // A year of trading: 500,000 of interest income and 200,000 of running
    // costs, both settled in cash, so the surplus is 300,000.
    await T(async (c) => {
      await acct.post(c, {
        debits: [{ glCode: '100-200', amount: 500000 }],
        credits: [{ glCode: '400-100', amount: 500000 }],
        narration: 'Interest income', bookingDate: IN_YEAR, createdBy: 'test',
      });
      await acct.post(c, {
        debits: [{ glCode: '500-200', amount: 200000 }],
        credits: [{ glCode: '100-200', amount: 200000 }],
        narration: 'Operating expenses', bookingDate: IN_YEAR, createdBy: 'test',
      });
    });

    section('financial years');
    const y = await T((c) => CL.openYear(c, { year: YEAR, createdBy: 'test' }));
    check('a year opens with sensible defaults',
      day(y.starts_on) === `${YEAR}-01-01` && day(y.ends_on) === YEAR_END, JSON.stringify(y));

    await throws('the same year cannot be opened twice',
      () => T((c) => CL.openYear(c, { year: YEAR, createdBy: 'test' })),
      (e) => /ALREADY_EXISTS/.test(e.message));

    await throws('two years cannot cover the same day',
      () => T((c) => CL.openYear(c, {
        year: YEAR + 50, startsOn: `${YEAR}-07-01`, endsOn: `${YEAR + 1}-06-30`, createdBy: 'test' })),
      (e) => /financial_years_no_overlap|exclusion/i.test(e.message));

    section('closing refuses until the reserve percentage is set');
    const s0 = await Rd((c) => CL.settings(c));
    check('no percentage ships with the system', s0.statutory_reserve_percent === null,
      String(s0.statutory_reserve_percent));
    await throws('a close without a configured percentage is refused',
      () => T((c) => CL.close(c, YEAR, { createdBy: 'test' })),
      (e) => /STATUTORY_RESERVE_PERCENT_NOT_CONFIGURED/.test(e.message));

    await T((c) => CL.setSettings(c, {
      statutoryReservePercent: 20,
      sourceNote: 'test fixture, not a regulatory figure',
      createdBy: 'test',
    }));

    section('preview says what the close will do');
    const p = await Rd((c) => CL.preview(c, YEAR));
    check('income for the year', p.totalIncome === 500000, String(p.totalIncome));
    check('expenses for the year', p.totalExpenses === 200000, String(p.totalExpenses));
    check('surplus', p.surplus === 300000, String(p.surplus));
    check('reserve is the configured share of the surplus', p.reserveAmount === 60000, String(p.reserveAmount));
    check('the rest goes to retained earnings', p.retainedAmount === 240000, String(p.retainedAmount));

    section('the close itself');
    const done = await T((c) => CL.close(c, YEAR, { createdBy: 'test' }));
    check('the close reports what it posted',
      done.surplus === 300000 && done.reserveAmount === 60000 && done.closeEntryId,
      JSON.stringify({ s: done.surplus, r: done.reserveAmount }));

    check('income accounts are swept to zero', (await bal('400-100')) === 0, String(await bal('400-100')));
    check('expense accounts are swept to zero', (await bal('500-200')) === 0, String(await bal('500-200')));
    check('retained earnings holds the surplus less the reserve',
      (await bal('300-200')) === -240000, String(await bal('300-200')));
    check('the statutory reserve holds its share',
      (await bal('300-300')) === -60000, String(await bal('300-300')));
    await assertBalanced('the close');

    section('a closed year is closed');
    await throws('the database refuses a posting dated inside it',
      () => T((c) => acct.post(c, {
        debits: [{ glCode: '100-200', amount: 100 }],
        credits: [{ glCode: '400-100', amount: 100 }],
        narration: 'late entry', bookingDate: IN_YEAR, createdBy: 'test',
      })),
      (e) => /is closed/.test(e.message));

    const today = new Date().toISOString().slice(0, 10);
    const stillOpen = await T((c) => acct.post(c, {
      debits: [{ glCode: '100-200', amount: 100 }],
      credits: [{ glCode: '400-100', amount: 100 }],
      narration: 'this year', bookingDate: today, createdBy: 'test',
    }));
    check('the current year still accepts postings', Boolean(stillOpen.entryId));

    await throws('closing twice is refused',
      () => T((c) => CL.close(c, YEAR, { createdBy: 'test' })),
      (e) => /ALREADY_CLOSED/.test(e.message));

    section('reports after a close');
    const is = await Rd((c) => R.incomeStatement(c, { from: `${YEAR}-01-01`, to: YEAR_END }));
    check('the income statement for the closed year still shows the trading',
      is.totalIncome === 500000 && is.totalExpenses === 200000 && is.surplus === 300000,
      JSON.stringify({ i: is.totalIncome, e: is.totalExpenses }));

    const swept = await Rd((c) => R.incomeStatement(c, {
      from: `${YEAR}-01-01`, to: YEAR_END, includeClosing: true }));
    check('and nets to nothing once the closing entries are counted',
      swept.surplus === 0, String(swept.surplus));

    const bs = await Rd((c) => R.balanceSheet(c, { asAt: YEAR_END }));
    check('the balance sheet balances after the close', bs.balances, `difference ${bs.difference}`);
    check('equity is retained earnings and the reserve, with no unclosed surplus line',
      bs.equity.filter((l) => l.code === null).length === 0 && bs.totalEquity === 300000,
      JSON.stringify(bs.equity));

    section('the period filter actually filters');
    const thisYear = await Rd((c) => R.incomeStatement(c, {
      from: `${YEAR + 1}-01-01`, to: `${YEAR + 1}-12-31` }));
    check('last year\'s trading is not in this year\'s statement',
      thisYear.totalIncome === 100, String(thisYear.totalIncome));

    section('reopening');
    await throws('a reopen needs a reason',
      () => T((c) => CL.reopen(c, YEAR, { createdBy: 'test' })),
      (e) => /REOPEN_REASON_REQUIRED/.test(e.message));

    const re = await T((c) => CL.reopen(c, YEAR, {
      reason: 'audit adjustment arrived late', createdBy: 'test' }));
    check('the year reopens', re.status === 'OPEN' && re.reversedClose, JSON.stringify(re));
    check('retained earnings is back where it was', (await bal('300-200')) === 0, String(await bal('300-200')));
    check('so is the statutory reserve', (await bal('300-300')) === 0, String(await bal('300-300')));
    check('and the income account holds its balance again',
      (await bal('400-100')) === -500100, String(await bal('400-100')));
    await assertBalanced('the reopen');

    const isAfter = await Rd((c) => R.incomeStatement(c, { from: `${YEAR}-01-01`, to: YEAR_END }));
    check('the income statement is unchanged by closing and reopening',
      isAfter.totalIncome === 500000 && isAfter.surplus === 300000,
      JSON.stringify({ i: isAfter.totalIncome, s: isAfter.surplus }));

    const late = await T((c) => acct.post(c, {
      debits: [{ glCode: '500-200', amount: 5000 }],
      credits: [{ glCode: '100-200', amount: 5000 }],
      narration: 'the late audit adjustment', bookingDate: IN_YEAR, createdBy: 'test',
    }));
    check('the reopened year accepts the adjustment', Boolean(late.entryId));

    section('closing again after the adjustment');
    const second = await T((c) => CL.close(c, YEAR, { createdBy: 'test' }));
    check('the second close picks up the adjustment',
      second.totalExpenses === 205000 && second.surplus === 295000,
      JSON.stringify({ e: second.totalExpenses, s: second.surplus }));
    check('and the reserve follows the new surplus', second.reserveAmount === 59000,
      String(second.reserveAmount));
    await assertBalanced('the second close');

    const closes = await Rd(async (c) => (await c.query(
      'SELECT status, surplus FROM year_end_closes ORDER BY created_at')).rows);
    check('both closes stay on the record, the first marked reversed',
      closes.length === 2 && closes[0].status === 'REVERSED' && closes[1].status === 'POSTED',
      JSON.stringify(closes));
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
