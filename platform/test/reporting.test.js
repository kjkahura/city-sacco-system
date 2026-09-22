#!/usr/bin/env node
'use strict';

/**
 * Paging, the two reporting bugs that paging uncovered, and the regulatory
 * return engine.
 *
 * The paging assertions go through HTTP rather than calling the domain
 * directly, because the thing being tested is the contract a client sees:
 * the page, the headers, and the total.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const acct = require('../src/domain/accounting');
const R = require('../src/domain/reports');
const RT = require('../src/domain/returns');

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

const SLUG = 'rptest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4098;
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);

let server;
let token;

async function call(method, p, { body } = {}) {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORT}${p}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return {
    status: r.status,
    body: d,
    total: Number(r.headers.get('items-total')),
    offset: Number(r.headers.get('items-offset')),
    limit: Number(r.headers.get('items-limit')),
  };
}

const LAST_YEAR = new Date().getFullYear() - 1;

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Reporting Test SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@rptest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});

    const login = await call('POST', '/api/auth/login', {
      body: { email: 'admin@rptest.local', password: 'a sufficiently long passphrase' },
    });
    token = login.body?.accessToken;
    check('signed in', Boolean(token), JSON.stringify(login.body).slice(0, 120));

    // 137 members, so the page count is not a round number and an off-by-one
    // in the last page shows up.
    await T(async (c) => {
      for (let i = 1; i <= 137; i += 1) {
        await c.query(
          `INSERT INTO members (member_no, first_name, last_name, status)
           VALUES ($1,$2,$3,$4)`,
          [`M${String(i).padStart(4, '0')}`, `First${i}`, `Last${String(i).padStart(4, '0')}`,
           i % 10 === 0 ? 'DORMANT' : 'ACTIVE']
        );
      }
    });

    section('list paging happens in the database');
    const first = await call('GET', '/api/members?limit=25');
    check('a page is the size asked for', first.body.length === 25, String(first.body.length));
    check('the total counts the whole set, not the page', first.total === 137, String(first.total));
    check('the headers echo the window', first.offset === 0 && first.limit === 25,
      `${first.offset}/${first.limit}`);

    const last = await call('GET', '/api/members?limit=25&offset=125');
    check('the final page is the remainder', last.body.length === 12, String(last.body.length));
    check('and still reports the full total', last.total === 137, String(last.total));

    const past = await call('GET', '/api/members?limit=25&offset=500');
    check('a page past the end is empty rather than an error',
      past.status === 200 && past.body.length === 0, String(past.status));
    check('and still knows the total, so a client can recover',
      past.total === 137, String(past.total));

    const filtered = await call('GET', '/api/members?status=DORMANT&limit=5');
    check('the total respects the filter', filtered.total === 13, String(filtered.total));

    const capped = await call('GET', '/api/members?limit=99999');
    check('an absurd limit is clamped, not honoured', capped.limit === 500, String(capped.limit));
    check('and returns at most that many', capped.body.length <= 500, String(capped.body.length));

    const pages = [];
    for (let off = 0; off < 137; off += 20) {
      const p = await call('GET', `/api/members?limit=20&offset=${off}`);
      pages.push(...p.body.map((m) => m.member_no));
    }
    check('walking the pages visits every member exactly once',
      new Set(pages).size === 137 && pages.length === 137,
      `${pages.length} rows, ${new Set(pages).size} distinct`);

    section('lookup by account number');
    // id = $1 OR account_no = $1::text made Postgres parse the account
    // number as a uuid and throw, so every by-number lookup was a 500.
    const acctNo = await T(async (c) => {
      const m = (await c.query("SELECT id FROM members WHERE member_no = 'M0001'")).rows[0];
      const S = require('../src/domain/savings');
      const a = await S.open(c, { memberId: m.id });
      await S.deposit(c, a.id, { amount: 50000, channelId: 'cash', createdBy: 'test' });
      return a.account_no;
    });
    const byNo = await call('GET', `/api/savings/${acctNo}/transactions`);
    check('a savings account can be fetched by its account number',
      byNo.status === 200 && byNo.body.length === 1, `${byNo.status} ${JSON.stringify(byNo.body).slice(0, 90)}`);

    section('the journal pages too');
    await T(async (c) => {
      for (let i = 0; i < 40; i += 1) {
        await acct.post(c, {
          debits: [{ glCode: '100-200', amount: 100 + i }],
          credits: [{ glCode: '400-200', amount: 100 + i }],
          narration: `fee ${i}`, createdBy: 'test',
        });
      }
    });
    const j = await call('GET', '/api/accounting/journal?limit=10');
    check('journal lines page', j.body.length === 10, String(j.body.length));
    check('and the total counts every line', j.total >= 82, String(j.total));

    section('the trial balance totals the whole book, not the page');
    const tbFull = await Rd((c) => acct.trialBalance(c, {}));
    const tbPage = await Rd((c) => acct.trialBalance(c, { limit: 2 }));
    check('a page is short', tbPage.rows.length === 2, String(tbPage.rows.length));
    check('the totals are identical to the unpaged report',
      tbPage.totals.debit === tbFull.totals.debit && tbPage.totals.credit === tbFull.totals.credit,
      JSON.stringify([tbPage.totals, tbFull.totals]));
    check('a paged trial balance still says it balances', tbPage.balanced);
    check('the page metadata counts every account that moved',
      tbPage.page.total === tbFull.rows.length, `${tbPage.page.total} vs ${tbFull.rows.length}`);

    section('the period filter on the statements');
    // The filter used to sit in an outer join onto journal_entries, where
    // it did nothing: the line rows survived with the entry columns nulled
    // and were summed anyway, so every statement reported the whole book.
    await T((c) => acct.post(c, {
      debits: [{ glCode: '100-200', amount: 777 }],
      credits: [{ glCode: '400-100', amount: 777 }],
      narration: 'last year', bookingDate: `${LAST_YEAR}-03-31`, createdBy: 'test',
    }));
    const lastYear = await Rd((c) => R.incomeStatement(c, {
      from: `${LAST_YEAR}-01-01`, to: `${LAST_YEAR}-12-31` }));
    check('a period statement contains only that period',
      lastYear.totalIncome === 777, String(lastYear.totalIncome));
    const everything = await Rd((c) => R.incomeStatement(c, {}));
    check('and an unbounded one contains everything',
      everything.totalIncome > 777, String(everything.totalIncome));

    const oneDay = await Rd((c) => acct.trialBalance(c, {
      from: `${LAST_YEAR}-03-31`, to: `${LAST_YEAR}-03-31` }));
    check('the trial balance honours its dates too',
      oneDay.totals.debit === 777, String(oneDay.totals.debit));

    section('the daily rollup is exact');
    const v = await Rd((c) => acct.verifyRollup(c, {}));
    check('every account agrees between the rollup and the lines', v.exact,
      JSON.stringify(v.mismatches).slice(0, 200));
    check('and the rollup is smaller than what it summarises', v.rollupRows < v.lineRows,
      `${v.rollupRows} vs ${v.lineRows}`);
    const viaApi = await call('GET', '/api/accounting/verify');
    check('an auditor can ask over HTTP', viaApi.status === 200 && viaApi.body.exact === true,
      String(viaApi.status));

    await throws('an entry\'s booking date cannot be changed under the rollup',
      () => T(async (c) => {
        const { rows: [e] } = await c.query('SELECT id FROM journal_entries LIMIT 1');
        await c.query("UPDATE journal_entries SET booking_date = booking_date + 1 WHERE id = $1", [e.id]);
      }),
      (e) => /immutable/.test(e.message));

    section('PAR detail pages');
    const par = await call('GET', '/api/reports/portfolio-at-risk/loans?limit=5');
    check('the loan-level PAR report answers', par.status === 200, String(par.status));
    check('and carries page metadata', par.body.page !== undefined || par.body.items !== undefined,
      JSON.stringify(Object.keys(par.body || {})));

    section('the return engine');
    const templates = await call('GET', '/api/returns');
    check('the sample template is there', templates.body.some((t) => t.code === 'SAMPLE_FINPOS'),
      JSON.stringify(templates.body?.map?.((t) => t.code)));
    check('and nothing ships marked official',
      templates.body.every((t) => t.is_official === false),
      JSON.stringify(templates.body?.map?.((t) => [t.code, t.is_official])));

    const rendered = await call('GET', '/api/returns/SAMPLE_FINPOS');
    const line = (ref) => rendered.body.lines.find((l) => l.ref === ref);
    check('a rendered return says it is not official',
      /NOT an official return/.test(rendered.body.disclaimer), rendered.body.disclaimer);
    check('assets less liabilities and equity is zero, so the return ties to the ledger',
      line('X1').value === 0, JSON.stringify(line('X1')));
    check('member deposits come through as a positive figure',
      line('L1').value === 50000, String(line('L1').value));
    check('headings carry no value', line('A').heading === true && line('A').value === null);

    section('expressions are parsed, not evaluated');
    check('precedence', RT.evaluate('2 + 3 * 4', {}) === 14, String(RT.evaluate('2 + 3 * 4', {})));
    check('parentheses', RT.evaluate('(2 + 3) * 4', {}) === 20);
    check('line references', RT.evaluate('A1 - A2', { A1: 10, A2: 4 }) === 6);
    check('unary minus', RT.evaluate('-A1 + 5', { A1: 3 }) === 2);
    check('division by zero is null rather than Infinity',
      RT.evaluate('A1 / A2', { A1: 5, A2: 0 }) === null);
    await throws('an unknown line is refused',
      async () => RT.evaluate('A1 + NOPE', { A1: 1 }),
      (e) => /UNKNOWN_LINE/.test(e.message));
    await throws('an expression cannot smuggle in JavaScript',
      async () => RT.evaluate('process.exit(1)', {}),
      (e) => /RETURN_EXPRESSION/.test(e.message));

    section('loading a template');
    const loaded = await call('PUT', '/api/returns/TEST_RET', {
      body: {
        name: 'Loaded test return',
        periodKind: 'PERIOD',
        lines: [
          { ref: 'I1', label: 'Interest income', measure: 'GL_CODES', selector: ['400-100'], sign: -1 },
          { ref: 'I2', label: 'Fee income', measure: 'GL_CODES', selector: ['400-200'], sign: -1 },
          { ref: 'I9', label: 'Total income', measure: 'EXPRESSION', expression: 'I1 + I2' },
        ],
      },
    });
    check('a template loads over HTTP', loaded.status === 200 && loaded.body.lines.length === 3,
      `${loaded.status} ${JSON.stringify(loaded.body).slice(0, 120)}`);

    const ret = await call('GET',
      `/api/returns/TEST_RET?from=${LAST_YEAR}-01-01&to=${LAST_YEAR}-12-31`);
    const l = (ref) => ret.body.lines.find((x) => x.ref === ref);
    check('a period return reads movement for its window',
      l('I1').value === 777 && l('I9').value === 777,
      JSON.stringify([l('I1').value, l('I2').value, l('I9').value]));

    await throws('a template whose expression names a missing line is refused at load',
      () => T((c) => RT.loadTemplate(c, {
        code: 'BAD_RET', name: 'Bad', lines: [{ ref: 'X', label: 'x', measure: 'EXPRESSION', expression: 'Y + 1' }],
      }, { createdBy: 'test' })),
      (e) => /UNKNOWN_LINE/.test(e.message));

    const stillThere = await call('GET', '/api/returns');
    check('and the failed load left nothing behind',
      !stillThere.body.some((t) => t.code === 'BAD_RET'),
      JSON.stringify(stillThere.body.map((t) => t.code)));
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server?.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
