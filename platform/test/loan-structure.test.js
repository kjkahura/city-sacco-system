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
const types = require('../src/domain/productTypes');

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

/**
 * The require graph of src/domain and its subfolders: lazy requires and
 * cycles. A node is the path from src/domain without .js, a folder's
 * index.js being the folder ('productTypes', 'productTypes/revolving').
 */
function requireGraph(root) {
  const g = {};
  const lazy = [];
  const node = (abs) => {
    const rel = path.relative(root, abs).replace(/\\/g, '/').replace(/\.js$/, '');
    return rel.endsWith('/index') ? rel.slice(0, -6) : rel;
  };
  const resolve = (from, spec) => {
    const abs = path.resolve(path.dirname(from), spec);
    if (fs.existsSync(`${abs}.js`)) return `${abs}.js`;
    if (fs.existsSync(path.join(abs, 'index.js'))) return path.join(abs, 'index.js');
    return null;
  };
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const abs = path.join(dir, f);
      if (fs.statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!f.endsWith('.js')) continue;
      const name = node(abs);
      g[name] = new Set();
      fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/require\('(\.\.?\/[a-zA-Z/.]+)'\)/g)) {
          const target = resolve(abs, m[1]);
          if (!target || !target.startsWith(root)) continue;
          g[name].add(node(target));
          if (/^\s/.test(line) || /=>\s*require/.test(line)) lazy.push(`${name}.js:${i + 1}`);
        }
      });
    }
  };
  walk(root);
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
    check('the graph includes the strategy folder', Boolean(g.productTypes && g['productTypes/revolving']), Object.keys(g).join(','));
    check('ledger stands only on accounting, schedule and tax', [...g.ledger].every((m) => below.includes(m)), [...g.ledger].join(','));
    const aboveLoans = ['restructure', 'postdated', 'settlement', 'eodExclusions', 'loanClosures', 'loanTransfers', 'collections'];
    check('nothing below loans requires loans', Object.entries(g).every(([n, deps]) => aboveLoans.includes(n) || !deps.has('loans')),
      Object.entries(g).filter(([n, d]) => !aboveLoans.includes(n) && d.has('loans')).map(([n]) => n).join(','));
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
    section('product types as strategies');
    const typeFiles = Object.keys(g).filter((n) => n.startsWith('productTypes'));
    const allowed = ['accounting', 'schedule', 'ledger', 'tranches'];
    const strays = typeFiles.flatMap((n) => [...g[n]].filter((m) => !m.startsWith('productTypes') && !allowed.includes(m)).map((m) => `${n}->${m}`));
    check('the strategy files stand only on accounting, schedule, ledger and tranches', strays.length === 0, strays.join(','));
    check('and nothing they stand on requires them back',
      allowed.every((m) => ![...g[m]].some((d) => d.startsWith('productTypes'))));
    const offered = require('../src/routes/loanProducts').ENUMS.product_type;
    check('every product type a product may have has a strategy, and every strategy is offered',
      offered.every((t) => types.BY_TYPE[t]) && types.TYPES.every((t) => offered.includes(t)),
      `offered ${offered} / strategies ${types.TYPES}`);
    const HOOKS = ['type', 'basis', 'schedulesUpfront', 'redrawsOnPrepayment', 'upfrontFeesOnSchedule', 'paymentDueFeesByCalendar',
      'paymentDueHorizon', 'plansTranches', 'disbursesAgain', 'disbursementAmount', 'fromCreditBalance', 'afterDisbursement',
      'recordDisbursement', 'appliesInterestAtDisbursement', 'bringsInterestToDate', 'beforeRepayment', 'closesWhenPaid',
      'surplusToCreditBalance', 'installmentScope', 'afterRepayment', 'redrawsOnReversal', 'accrues', 'accrualWindow',
      'accrualBase', 'dailyAccrual', 'capitalizes'];
    const gaps = Object.entries(types.BY_TYPE).flatMap(([t, s]) => HOOKS.filter((h) => s[h] === undefined).map((h) => `${t}.${h}`));
    check('every strategy fills every hook of the contract', gaps.length === 0, gaps.join(','));
    check('each strategy is named for its type', Object.entries(types.BY_TYPE).every(([t, s]) => s.type === t));
    check('an unknown type is refused, not treated as fixed term', (() => { try { types.forLoan({ product_type: 'NOPE' }); return false; } catch (e) { return /UNKNOWN_PRODUCT_TYPE/.test(e.message); } })());
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    const lifecycle = ['domain/loans.js', 'domain/interest.js', 'domain/installments.js', 'domain/fees.js', 'domain/restructure.js', 'ops/eod.js'];
    const TYPE_TEST = /\b(isDynamic|isRevolving|isTranched|isInterestFree)\s*\(|product_type\s*[!=]==|['"](DYNAMIC_TERM|TRANCHED|REVOLVING|INTEREST_FREE)['"]/;
    const testing = lifecycle.filter((f) => src(f).split('\n').some((line) => !/^\s*(\/\/|\*)/.test(line) && TYPE_TEST.test(line)));
    check('disbursement, repayment, accrual, fees, restructure and EOD ask the strategy instead of testing the type',
      testing.length === 0, testing.join(','));

    // The behaviour the dispatch must keep.
    const base = { monthly_rate: 2, interest_posting: 'ON_REPAYMENT', principal: 1000, credit_balance: 0 };
    const inst = [{ nominal_due: '2026-02-01', due_date: '2026-02-01' }];
    const at = (t, extra = {}) => types.forLoan({ ...base, product_type: t, ...extra });
    check('a dynamic loan without late interest stops accruing at maturity',
      at('DYNAMIC_TERM').accrualWindow({ ...base, accrue_late_interest: false }, '2026-01-15', '2026-03-01', inst) === '2026-02-01');
    check('a revolving loan keeps accruing past its last billed installment (it is not a maturity)',
      at('REVOLVING').accrualWindow({ ...base, accrue_late_interest: false }, '2026-02-15', '2026-03-01', inst) === '2026-03-01');
    check('only fixed-term interest is applied at disbursement',
      at('FIXED_TERM').appliesInterestAtDisbursement({ interest_posting: 'ON_DISBURSEMENT' })
      && !at('DYNAMIC_TERM').appliesInterestAtDisbursement({ interest_posting: 'ON_DISBURSEMENT' }));
    check('an interest-free loan never accrues', !at('INTEREST_FREE').accrues({ ...base, product_type: 'INTEREST_FREE' }));
    check('a revolving loan stays open at a zero balance; the others close',
      !at('REVOLVING').closesWhenPaid && ['FIXED_TERM', 'DYNAMIC_TERM', 'TRANCHED', 'INTEREST_FREE'].every((t) => at(t).closesWhenPaid));
    check('only tranched and revolving loans disburse again',
      Object.entries(types.BY_TYPE).every(([t, s]) => s.disbursesAgain === ['TRANCHED', 'REVOLVING'].includes(t)));
    check('the predicates read the strategy',
      types.isDynamic({ product_type: 'TRANCHED' }) && !types.isDynamic({ product_type: 'FIXED_TERM' })
      && types.isInterestFree({ product_type: 'FIXED_TERM', monthly_rate: 0 }) && types.isInterestFree({ product_type: 'INTEREST_FREE', monthly_rate: 0 }));

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
