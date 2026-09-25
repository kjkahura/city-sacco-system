#!/usr/bin/env node
'use strict';

/**
 * Schedule editing, payment holidays and the monthly due day, after Mambu's
 * "Repayments Schedule Editing".
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const acct = require('../src/domain/accounting');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'scheduletest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4097;
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
const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
let seq = 0;
const disbursed = (productId, principal, term, on) => T(async (c) => {
  seq += 1;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'S',$1) RETURNING *`, [`S${String(seq).padStart(4, '0')}`])).rows[0];
  const l = await L.apply(c, { memberId: m.id, productId, principal, termMonths: term, createdBy: 'officer' });
  await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
  await L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: on, createdBy: 'teller' });
  return l;
});
const lines = (rows) => rows.map((i) => ({ dueDate: ymd(i.due_date), principal: Number(i.principal_due), interest: Number(i.interest_due), fee: Number(i.fee_due) }));

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Schedule SACCO', mfaRequiredRoles: [], adminEmail: 'admin@scheduletest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    token = (await call('POST', '/api/auth/login', { email: 'admin@scheduletest.local', password: PASSWORD })).body.accessToken;

    section('what a product allows');
    const fxe = await mk('FXE', { productType: 'FIXED_TERM', method: 'REDUCING', scheduleEditing: ['PAYMENT_DATES', 'PRINCIPAL', 'INTEREST', 'FEES', 'PAYMENT_HOLIDAYS'] });
    const dye = await mk('DYE', { productType: 'DYNAMIC_TERM', method: 'REDUCING_EQUAL_INSTALLMENTS', scheduleEditing: ['NUMBER_OF_INSTALLMENTS', 'PAYMENT_HOLIDAYS'] });
    const noe = await mk('NOE', { productType: 'FIXED_TERM', method: 'REDUCING' });
    check('products take a list of schedule edits', fxe.status === 201 && dye.status === 201 && noe.status === 201, `${fxe.source} ${dye.source}`);
    check('number of installments brings payment dates and principal with it, as in Mambu',
      ['PAYMENT_DATES', 'PRINCIPAL', 'NUMBER_OF_INSTALLMENTS'].every((x) => dye.body.scheduleEditing.includes(x)), JSON.stringify(dye.body.scheduleEditing));
    check('a dynamic product cannot edit interest', (await mk('BAD1', { productType: 'DYNAMIC_TERM', method: 'REDUCING', scheduleEditing: ['INTEREST'] })).status === 400);
    check('a fixed-term product cannot change its number of installments', (await mk('BAD2', { productType: 'FIXED_TERM', method: 'REDUCING', scheduleEditing: ['NUMBER_OF_INSTALLMENTS'] })).status === 400);

    // ----------------------------------------------------------------------
    section('editing a fixed-term schedule');
    const none = await disbursed('NOE', 6000, 6, '2026-01-05');
    let r = await call('PUT', `/api/loans/${none.id}/schedule`, { installments: [{ principal: 1 }], asOf: '2026-01-06' });
    check('a product that allows nothing refuses edits', r.status === 409, r.reason);
    const f = await disbursed('FXE', 12000, 6, '2026-01-05');
    await T((c) => L.accrueInterest(c, f.id, { valueDate: '2026-01-20', createdBy: 'eod' }));
    const f0 = await sched(f.id);
    const tail = lines(f0.slice(1));
    r = await call('PUT', `/api/loans/${f.id}/schedule`, { installments: lines(f0), asOf: '2026-01-20' });
    check('the installment whose interest has started to be earned cannot change', r.status === 409 && /NUMBER_OF_INSTALLMENTS/.test(r.reason), r.reason);
    const bad = tail.map((x, k) => ({ ...x, principal: k === 0 ? x.principal + 1 : x.principal }));
    r = await call('PUT', `/api/loans/${f.id}/schedule`, { installments: bad, asOf: '2026-01-20' });
    check('principal must still add up', r.status === 400 && /PRINCIPAL_MUST_STILL_ADD_UP/.test(r.reason), r.reason);
    const edited = tail.map((x, k) => ({ ...x,
      principal: k === 0 ? x.principal - 1000 : k === 1 ? x.principal + 1000 : x.principal,
      interest: k === 1 ? x.interest + 50 : x.interest,
      dueDate: k === 2 ? ymd(new Date(new Date(x.dueDate).getTime() + 5 * 86400000)) : x.dueDate }));
    r = await call('PUT', `/api/loans/${f.id}/schedule`, { installments: edited, asOf: '2026-01-20', note: 'member asked' });
    check('principal moved between installments 2 and 3, interest on 3 changed, installment 4 moved five days',
      r.status === 200 && r.body.after[0].principal === tail[0].principal - 1000 && r.body.after[1].interest === round(tail[1].interest + 50)
      && r.body.after[2].dueDate === edited[2].dueDate, `${r.status} ${r.reason}`);
    const f1 = await sched(f.id);
    check('the first installment is untouched', lines(f1)[0].principal === lines(f0)[0].principal && lines(f1)[0].interest === lines(f0)[0].interest);
    await T((c) => L.accrueInterest(c, f.id, { valueDate: ymd(f1[2].nominal_due), createdBy: 'eod' }));
    const through3 = round(f1.slice(0, 3).reduce((a, x) => a + Number(x.interest_due), 0));
    check('a fixed-term loan accrues the edited schedule: through installment 3, exactly its interest', Number((await loanRow(f.id)).interest_accrued) === through3,
      `${(await loanRow(f.id)).interest_accrued} vs ${through3}`);

    section('a payment holiday');
    const before = await sched(f.id);
    r = await call('POST', `/api/loans/${f.id}/payment-holiday`, { from: 5, count: 1, asOf: ymd(before[2].nominal_due), note: 'school fees month' });
    const f2 = await sched(f.id);
    check('installment 5 falls due with nothing to pay', r.status === 201 && f2[4].payment_holiday && Number(f2[4].principal_due) === 0 && Number(f2[4].interest_due) === 0 && f2[4].status === 'GRACE',
      `${r.status} ${r.reason}`);
    check('the loan gains an installment and still repays all its principal', f2.length === 7 && Number((await loanRow(f.id)).term_months) === 7
      && round(f2.reduce((a, x) => a + Number(x.principal_due), 0)) === 12000, `${f2.length}`);
    check('the holiday\'s interest is carried by the installments after it',
      round(f2.slice(5).reduce((a, x) => a + Number(x.interest_due), 0)) > round(before.slice(5).reduce((a, x) => a + Number(x.interest_due), 0)));
    await T((c) => L.markArrears(c, { asOf: ymd(new Date(new Date(f2[4].due_date).getTime() + 10 * 86400000)) }));
    check('a holiday installment never goes overdue', (await sched(f.id))[4].status === 'GRACE');

    // ----------------------------------------------------------------------
    section('a dynamic loan: its interest follows its principal and dates');
    const d = await disbursed('DYE', 6000, 6, '2026-01-05');
    const d0 = await sched(d.id);
    const seven = [...lines(d0).map((x) => ({ dueDate: x.dueDate, principal: round(6000 / 7) })), { dueDate: '2026-08-05', principal: 0 }];
    seven[6].principal = round(6000 - seven.slice(0, 6).reduce((a, x) => a + x.principal, 0));
    r = await call('PUT', `/api/loans/${d.id}/schedule`, { installments: seven, asOf: '2026-01-10' });
    const d1 = await sched(d.id);
    check('an installment is added: seven, the principal spread over them', r.status === 200 && d1.length === 7 && Number((await loanRow(d.id)).term_months) === 7, `${r.status} ${r.reason}`);
    check('and the expected interest redrawn from them: the first on 6,000 for a month', Number(d1[0].interest_due) === 60, String(d1[0].interest_due));
    r = await call('PUT', `/api/loans/${d.id}/schedule`, { installments: lines(d1).map((x, k) => ({ ...x, interest: k === 0 ? 1 : x.interest })), asOf: '2026-01-10' });
    check('interest on a dynamic loan is not edited', r.status === 409, r.reason);
    r = await call('POST', `/api/loans/${d.id}/payment-holiday`, { from: 2, count: 1, asOf: '2026-01-10' });
    const d2 = await sched(d.id);
    check('a dynamic payment holiday: installment 2 empty, the next expects the holiday\'s interest too',
      r.status === 201 && d2[1].payment_holiday && Number(d2[2].interest_due) > Number(d1[2].interest_due) && d2.length === 8, `${r.status} ${r.reason}`);

    section('changing the monthly due day (Mambu\'s example: from the 10th to the 25th, asked on the 3rd)');
    const m = await disbursed('DYE', 6000, 6, '2026-01-10');
    const m0 = await sched(m.id);
    r = await call('POST', `/api/loans/${m.id}/due-day`, { day: 2, asOf: '2026-02-03' });
    check('a day that would put the next due date in the past is refused', r.status === 409, r.reason);
    r = await call('POST', `/api/loans/${m.id}/due-day`, { day: 25, asOf: '2026-02-03' });
    const m1 = await sched(m.id);
    check('the next installment moves from 10 to 25 February', r.status === 200 && ymd(m1[0].due_date) === '2026-02-25', `${r.status} ${r.reason} ${m1[0] && ymd(m1[0].due_date)}`);
    check('and grows by fifteen days of interest', Number(m1[0].interest_due) === round(Number(m0[0].interest_due) * 45 / 30), `${m0[0].interest_due} -> ${m1[0].interest_due}`);
    check('later installments fall on the 25th with their amounts unchanged',
      m1.slice(1).every((x, k) => ymd(x.nominal_due).endsWith('-25') && Number(x.principal_due) === Number(m0[k + 1].principal_due) && Number(x.interest_due) === Number(m0[k + 1].interest_due)),
      m1.map((x) => ymd(x.nominal_due)).join(','));
    check('one falling on a Saturday is due the Monday after', m1.some((x) => ymd(x.nominal_due) === '2026-04-25' && ymd(x.due_date) === '2026-04-27'));
    r = await call('POST', `/api/loans/${f.id}/due-day`, { day: 25 });
    check('the due day of a fixed-term loan does not change', r.status === 409, r.reason);
    const edits = await call('GET', `/api/loans/${f.id}/schedule-edits`);
    check('every edit is kept with the schedule before and after', edits.status === 200 && edits.body.map((x) => x.kind).join(',') === 'EDIT,PAYMENT_HOLIDAY'
      && edits.body[0].note === 'member asked', JSON.stringify(edits.body?.map((x) => x.kind)));
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
