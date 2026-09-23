#!/usr/bin/env node
'use strict';

/**
 * The shape of the loan module: its files require each other in one
 * direction only (no cycles, no requires hidden inside functions), and the
 * settings a loan may carry of its own are one declared list
 * (ledger.OVERRIDES) that application, amendment, the loan read and the
 * set-based SQL all follow.
 */

const fs = require('fs');
const path = require('path');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const ledger = require('../src/domain/ledger');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'structtest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4091;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);

let server;
let token;
async function call(method, p, body) {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, reason: d?.errors?.[0]?.errorReason };
}

/** The require graph of src/domain: lazy requires and cycles. */
function requireGraph(dir) {
  const g = {};
  const lazy = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const name = f.replace(/\.js$/, '');
    g[name] = new Set();
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/require\('\.\/([a-zA-Z]+)'\)/g)) {
        g[name].add(m[1]);
        if (/^\s/.test(line) || /=>\s*require/.test(line)) lazy.push(`${f}:${i + 1}`);
      }
    });
  }
  const cycles = [];
  const state = {};
  const stack = [];
  const dfs = (n) => {
    state[n] = 1; stack.push(n);
    for (const m of g[n] || []) {
      if (state[m] === 1) cycles.push([...stack.slice(stack.indexOf(m)), m].join(' -> '));
      else if (!state[m]) dfs(m);
    }
    stack.pop(); state[n] = 2;
  };
  Object.keys(g).forEach((n) => { if (!state[n]) dfs(n); });
  return { g, lazy, cycles };
}

const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
const eff = (id) => T(async (c) => ledger.effective(await ledger.lock(c, id)));

(async () => {
  server = app.listen(PORT);
  try {
    // ----------------------------------------------------------------------
    section('module layers');
    const { g, lazy, cycles } = requireGraph(path.join(__dirname, '..', 'src', 'domain'));
    check('no domain module requires another from inside a function', lazy.length === 0, lazy.join(', '));
    check('the domain require graph has no cycles', cycles.length === 0, cycles.join(' | '));
    const below = ['accounting', 'schedule', 'tax'];
    check('ledger stands only on accounting, schedule and tax', [...g.ledger].every((m) => below.includes(m)), [...g.ledger].join(','));
    check('nothing below loans requires loans', Object.entries(g).every(([n, deps]) => n === 'restructure' || !deps.has('loans')),
      Object.entries(g).filter(([n, d]) => n !== 'restructure' && d.has('loans')).map(([n]) => n).join(','));
    const exported = ['lock', 'balances', 'principalOutstanding', 'effective', 'terms', 'isDynamic', 'isRevolving', 'isTranched',
      'isInterestFree', 'isAccrual', 'booksEntries', 'post', 'creditsFor', 'scheduleInputs', 'buildSchedule', 'previewSchedule',
      'shiftOffClosedDays', 'reschedule', 'maturityDate', 'apply', 'changeState', 'disburse', 'repay', 'accrueInterest',
      'capitalizeInterest', 'writeOff', 'reverseTransaction', 'addGuarantor', 'guarantorCoverage', 'releaseGuarantors',
      'checkEligibility', 'enforceEligibility', 'markArrears', 'applyToInstallments', 'dayCount', 'interestFor', 'isMonthEnd',
      'paidCredit', 'writeOffCredit', 'addMonths', 'annuityPayment', 'scheduledInterestThrough', 'scheduledOutstanding',
      'fillPattern', 'nextAccountNo', 'OPEN_APPLICATION'];
    const missing = exported.filter((k) => L[k] === undefined);
    check('loans still exports every name it exported before the split', missing.length === 0, missing.join(','));

    // ----------------------------------------------------------------------
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Structure SACCO', mfaRequiredRoles: [], adminEmail: 'admin@structtest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@structtest.local', password: PASSWORD })).body.accessToken;
    const prod = await call('POST', '/api/loan-products', {
      id: 'OV01', name: 'Overrides', enforceDepositMultiplier: false, ...GL, monthlyRate: 2, rateMin: 1, rateMax: 3,
      penaltyRate: 1, penaltyBasis: 'OVERDUE_PRINCIPAL', arrearsToleranceDays: 3, maxTerm: 24,
    });
    check('product created', prod.status === 201, JSON.stringify(prod.body).slice(0, 200));
    const member = await T(async (c) => (await c.query(
      "INSERT INTO members (member_no, first_name, last_name) VALUES ('S0001','Struct','One') RETURNING *")).rows[0]);
    const applyLoan = (body) => call('POST', '/api/loans', { memberId: member.id, productId: 'OV01', principal: 10000, termMonths: 6, ...body });

    // ----------------------------------------------------------------------
    section('SNAPSHOT and INHERIT');
    const aRes = await applyLoan({});
    check('an application is readable as soon as its 201 arrives', aRes.status === 201 && Boolean(await loanRow(aRes.body.id)));
    const a = aRes.body;
    let row = await loanRow(a.id);
    check('the rate is copied onto the loan when it opens (SNAPSHOT)', Number(row.monthly_rate) === 2);
    check('the penalty rate and arrears tolerance are left NULL, to follow the product (INHERIT)',
      row.penalty_rate === null && row.arrears_tolerance_days === null);
    let e = await eff(a.id);
    check('and read as the product\'s values', e.penaltyRate === 1 && e.arrearsToleranceDays === 3 && e.monthlyRate === 2, JSON.stringify(e));
    await T((c) => c.query("UPDATE loan_products SET monthly_rate = 2.5, penalty_rate = 1.5, arrears_tolerance_days = 5 WHERE id = 'OV01'"));
    e = await eff(a.id);
    check('changing the product moves the inherited values', e.penaltyRate === 1.5 && e.arrearsToleranceDays === 5, JSON.stringify(e));
    check('and leaves the snapshot alone', e.monthlyRate === 2);
    const sqlSide = await Rd(async (c) => (await c.query(
      `SELECT ${ledger.overrideSql('penaltyRate')} AS pen, ${ledger.overrideSql('arrearsToleranceDays')} AS tol
       FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id WHERE l.id = $1`, [a.id])).rows[0]);
    check('the SQL form of an override agrees with the loan read', Number(sqlSide.pen) === 1.5 && Number(sqlSide.tol) === 5);

    const b = await applyLoan({ penaltyRate: 0.5, arrearsTolerancePercent: 2 });
    check('a loan may be opened with its own values', b.status === 201, b.reason || '');
    e = await eff(b.body.id);
    check('which win over the product\'s', e.penaltyRate === 0.5 && e.arrearsTolerancePercent === 2, JSON.stringify(e));

    // ----------------------------------------------------------------------
    section('what the product allows');
    let r = await applyLoan({ monthlyRate: 4 });
    check('a rate above the product\'s band is refused', r.status === 400 && /RATE_ABOVE_PRODUCT_MAXIMUM/.test(r.reason), r.reason);
    r = await applyLoan({ orgCommission: 1 });
    check('an organisation commission on a product without funding is refused',
      r.status === 400 && /ORG_COMMISSION_NOT_USED_BY_THIS_PRODUCT/.test(r.reason), r.reason);
    r = await applyLoan({ revolvingRepaymentValue: 100 });
    check('a revolving repayment value on a term product is refused',
      r.status === 400 && /REVOLVING_REPAYMENT_VALUE_NOT_USED_BY_THIS_PRODUCT/.test(r.reason), r.reason);
    r = await applyLoan({ gracePeriods: 6 });
    check('grace as long as the term is refused', r.status === 400 && /GRACE_EXCEEDS_TERM/.test(r.reason), r.reason);

    // ----------------------------------------------------------------------
    section('amendments follow the same list');
    const g3 = (await applyLoan({ gracePeriods: 3 })).body;
    r = await call('PATCH', `/api/loans/${g3.id}`, { termMonths: 3 });
    check('shortening the term below an existing grace period is refused', r.status === 400 && /GRACE_EXCEEDS_TERM/.test(r.reason), r.reason);
    r = await call('PATCH', `/api/loans/${g3.id}`, { monthlyRate: null });
    check('a snapshot value cannot be cleared', r.status === 400 && /RATE_CANNOT_BE_CLEARED/.test(r.reason), r.reason);
    r = await call('PATCH', `/api/loans/${b.body.id}`, { penaltyRate: null });
    check('clearing an inherited value hands it back to the product', r.status === 200 && (await eff(b.body.id)).penaltyRate === 1.5, r.reason || '');
    r = await call('PATCH', `/api/loans/${a.id}`, { arrearsTolerancePercent: 1 });
    check('every override on the list is amendable while the application is open',
      r.status === 200 && Number((await loanRow(a.id)).arrears_tolerance_percent) === 1, r.reason || '');
    await T((c) => L.changeState(c, a.id, 'APPROVE', { createdBy: 'manager' }));
    r = await call('PATCH', `/api/loans/${a.id}`, { penaltyRate: 2 });
    check('and none of them once it is approved', r.status === 409 && /NOT_EDITABLE_IN_STATE_APPROVED/.test(r.reason), r.reason);
  } catch (err) {
    fail++; failures.push(`threw: ${err.stack}`);
    console.error(`\nFAILED: ${err.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
