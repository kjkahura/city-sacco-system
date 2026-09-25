#!/usr/bin/env node
'use strict';

/**
 * Repayment collection options, after Mambu: horizontal and vertical
 * allocation, a custom allocation order on one repayment, products that do
 * not accept prepayments, interest applied before or after a prepayment,
 * and where a prepayment goes on an equal-installment loan (next
 * installments or a redraw) with when an installment counts as paid.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/schedule');
const acct = require('../src/domain/accounting');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'collecttest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4098;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;

let server;
let token;
async function call(method, p, body) {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, reason: d?.errors?.[0]?.errorReason || '', source: d?.errors?.[0]?.errorSource || '' };
}
const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };
const mk = (id, body) => call('POST', '/api/loan-products', { id, name: id, ...GL, enforceDepositMultiplier: false, maxTerm: 36, monthlyRate: 1, ...body });
const sched = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id])).rows);
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
let seq = 0;
const disbursed = (productId, principal, term, on) => T(async (c) => {
  seq += 1;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'C',$1) RETURNING *`, [`C${String(seq).padStart(4, '0')}`])).rows[0];
  await c.query("INSERT INTO savings_accounts (account_no, member_id, product_id) VALUES ($1, $2, 'SAV01')", [`SV${seq}`, m.id]);
  const l = await L.apply(c, { memberId: m.id, productId, principal, termMonths: term, createdBy: 'officer' });
  await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
  await L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: on, createdBy: 'teller' });
  return l;
});
const repay = (id, amount, on, extra = {}) => call('POST', `/api/loans/${id}/repayments`, { amount, channelId: 'cash', valueDate: on, ...extra });

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Collection SACCO', mfaRequiredRoles: [], adminEmail: 'admin@collecttest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@collecttest.local', password: PASSWORD })).body.accessToken;
    const made = await Promise.all([
      mk('VERT', { productType: 'FIXED_TERM', method: 'REDUCING' }),
      mk('HORZ', { productType: 'FIXED_TERM', method: 'REDUCING', paymentMethod: 'HORIZONTAL' }),
      mk('NOPRE', { productType: 'DYNAMIC_TERM', method: 'REDUCING', allowPrepayments: false }),
      mk('AUTO', { productType: 'DYNAMIC_TERM', method: 'REDUCING' }),
      mk('MANU', { productType: 'DYNAMIC_TERM', method: 'REDUCING', prepaymentInterest: 'MANUAL' }),
      mk('NEXTF', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', prepaymentAllocation: 'NEXT_INSTALLMENTS' }),
      mk('NEXTP', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', prepaymentAllocation: 'NEXT_INSTALLMENTS', markPaidWhen: 'PRINCIPAL_EXPECTED' }),
    ]);
    check('products with each collection option', made.every((r) => r.status === 201), made.map((r) => r.source).join('|'));
    check('MANUAL prepayment interest is for dynamic products', (await mk('B1', { productType: 'FIXED_TERM', method: 'REDUCING', prepaymentInterest: 'MANUAL' })).status === 400);
    check('NEXT_INSTALLMENTS needs dynamic equal installments', (await mk('B2', { productType: 'DYNAMIC_TERM', method: 'REDUCING', prepaymentAllocation: 'NEXT_INSTALLMENTS' })).status === 400);
    check('PRINCIPAL_EXPECTED too', (await mk('B3', { productType: 'FIXED_TERM', method: 'REDUCING', markPaidWhen: 'PRINCIPAL_EXPECTED' })).status === 400);

    // ----------------------------------------------------------------------
    section('vertical and horizontal');
    const v = await disbursed('VERT', 3000, 3, '2026-01-01');
    const h = await disbursed('HORZ', 3000, 3, '2026-01-01');
    for (const x of [v, h]) await T((c) => L.accrueInterest(c, x.id, { valueDate: '2026-03-01', createdBy: 'eod' }));
    const s = await sched(v.id);
    const first = round(Number(s[0].principal_due) + Number(s[0].interest_due));
    const rv = await repay(v.id, first, '2026-03-01');
    const rh = await repay(h.id, first, '2026-03-01');
    check('vertical pays the interest of both overdue installments before any principal',
      rv.status === 201 && rv.body.allocation.interest === round(Number(s[0].interest_due) + Number(s[1].interest_due)), JSON.stringify(rv.body?.allocation));
    check('horizontal pays the first installment whole: its interest, then its principal',
      rh.status === 201 && rh.body.allocation.interest === Number(s[0].interest_due) && rh.body.allocation.principal === Number(s[0].principal_due), JSON.stringify(rh.body?.allocation));
    check('so the first installment is paid under horizontal and not under vertical',
      (await sched(h.id))[0].status === 'PAID' && (await sched(v.id))[0].status !== 'PAID');

    section('a custom allocation order on one repayment');
    const o = await disbursed('VERT', 3000, 3, '2026-01-01');
    await T((c) => L.accrueInterest(c, o.id, { valueDate: '2026-02-01', createdBy: 'eod' }));
    let r = await repay(o.id, 500, '2026-02-01', { allocationOrder: ['PRINCIPAL', 'INTEREST', 'FEE', 'PENALTY'] });
    check('principal first when the repayment says so', r.status === 201 && r.body.allocation.principal === 500 && r.body.allocation.interest === 0, JSON.stringify(r.body?.allocation));
    r = await repay(o.id, 10, '2026-02-01', { allocationOrder: ['PRINCIPAL', 'INTEREST'] });
    check('an order that does not list all four is refused', r.status === 400 && /ALLOCATION_ORDER/.test(r.reason), r.reason);

    // ----------------------------------------------------------------------
    section('a product that does not accept prepayments');
    const np = await disbursed('NOPRE', 3000, 3, '2026-01-01');
    r = await repay(np.id, 1500, '2026-02-01');
    check('more than is due is refused', r.status === 409 && /PREPAYMENT_NOT_ALLOWED/.test(r.reason), r.reason);
    const dueNow = Number(/PREPAYMENT_NOT_ALLOWED: ([0-9.]+)/.exec(r.reason)?.[1] || 0);
    r = await repay(np.id, dueNow, '2026-02-01');
    check('what is due is taken', r.status === 201 && round(r.body.allocation.principal + r.body.allocation.interest) === dueNow, `${r.status} ${r.reason}`);

    section('interest on a prepayment: applied before (automatic) or after (manual)');
    const au = await disbursed('AUTO', 6000, 6, '2026-01-01');
    const mu = await disbursed('MANU', 6000, 6, '2026-01-01');
    const ra = await repay(au.id, 3000, '2026-01-16');
    const rm = await repay(mu.id, 3000, '2026-01-16');
    check('automatic: the fifteen days\' interest is applied and paid first', ra.status === 201 && ra.body.allocation.interest === 30, JSON.stringify(ra.body?.allocation));
    check('manual: the whole payment goes to principal', rm.status === 201 && rm.body.allocation.interest === 0 && rm.body.allocation.principal === 3000, JSON.stringify(rm.body?.allocation));
    check('and the interest is applied after it, on the lower balance',
      Number((await loanRow(mu.id)).interest_accrued) === round(S.interestBetween(3000, { rate: 1 }, '2026-01-01', '2026-01-16', { exact: true })),
      String((await loanRow(mu.id)).interest_accrued));

    // ----------------------------------------------------------------------
    section('where a prepayment goes on an equal-installment loan');
    const nf = await disbursed('NEXTF', 6000, 6, '2026-01-01');
    const np0 = await sched(nf.id);
    const prepay = round(Number(np0[0].principal_due) + Number(np0[1].principal_due) / 2);
    r = await repay(nf.id, prepay, '2026-01-01');
    const nf1 = await sched(nf.id);
    check('on next installments: the first installment\'s principal is covered, the second\'s half, nothing redrawn',
      r.status === 201 && Number(nf1[0].principal_paid) === Number(np0[0].principal_due) && Number(nf1[1].principal_paid) === round(Number(np0[1].principal_due) / 2)
      && nf1.slice(2).every((x, k) => Number(x.principal_due) === Number(np0[k + 2].principal_due)), `${r.status} ${r.reason}`);
    check('full due is paid: the first stays partly paid until its interest is paid on its date', nf1[0].status === 'PARTIALLY_PAID', nf1[0].status);
    const pe = await disbursed('NEXTP', 6000, 6, '2026-01-01');
    const pe0 = await sched(pe.id);
    r = await repay(pe.id, prepay, '2026-01-01');
    const pe1 = await sched(pe.id);
    check('principal expected is paid: the first is paid, and the interest it expected moves to the second',
      r.status === 201 && pe1[0].status === 'PAID' && Number(pe1[0].interest_due) === 0
      && Number(pe1[1].interest_due) === round(Number(pe0[1].interest_due) + Number(pe0[0].interest_due)), `${pe1[0].status} ${pe1[1].interest_due}`);
    check('trial balance balances', (await Rd((c) => acct.trialBalance(c))).balanced);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const x of failures) console.log(`  - ${x}`);
    server.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
