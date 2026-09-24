#!/usr/bin/env node
'use strict';

/**
 * Write-offs and what follows: the principal written off against the loan
 * loss allowance first, guarantors called with their deposits kept
 * committed, recoveries from the member, a guarantor or collateral, calls
 * released, and reversals that put everything back.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const { hashPassword } = require('../src/auth/passwords');
const L = require('../src/domain/loans');
const S = require('../src/domain/savings');
const PV = require('../src/domain/provisioning');
const acct = require('../src/domain/accounting');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'wotest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4094;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const round = (n) => Math.round(n * 100) / 100;
const bal = (code) => Rd((c) => acct.balance(c, code));
const plus = (n, from = new Date()) => new Date(from.getTime() + n * 86400000).toISOString().slice(0, 10);

let server;
const tokens = {};
async function call(method, p, body, who = 'admin') {
  const headers = { 'content-type': 'application/json', 'x-tenant': SLUG };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, reason: d?.errors?.[0]?.errorReason || '' };
}
async function assertBalanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced, `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}

let seq = 0;
async function newMember(c, deposit = 0) {
  seq += 1;
  const no = `W${String(seq).padStart(4, '0')}`;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'Write',$1) RETURNING *`, [no])).rows[0];
  const sav = await S.open(c, { memberId: m.id });
  if (deposit) await S.deposit(c, sav.id, { amount: deposit, channelId: 'cash', createdBy: 'test' });
  return { m, sav };
}
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
const balancesOf = (id) => T(async (c) => L.balances(await L.lock(c, id)));
const savBal = (id) => Rd(async (c) => Number((await c.query('SELECT balance FROM savings_accounts WHERE id = $1', [id])).rows[0].balance));
const guarantors = (loanId) => Rd(async (c) => (await c.query('SELECT * FROM loan_guarantors WHERE loan_id = $1 ORDER BY pledged_amount DESC', [loanId])).rows);

const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Write-off SACCO', mfaRequiredRoles: [], adminEmail: 'admin@wotest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    const tenant = (await pool.query('SELECT * FROM platform.tenants WHERE slug=$1', [SLUG])).rows[0];
    const hash = await hashPassword(PASSWORD);
    for (const [who, limit] of [['checker', null], ['small', 1000]]) {
      await pool.query(
        `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role, approval_limit)
         VALUES ($1,$2,$3,$2,'MANAGER',$4)`, [tenant.id, `${who}@wotest.local`, hash, limit]);
    }
    for (const who of ['admin', 'checker', 'small']) {
      tokens[who] = (await call('POST', '/api/auth/login', { email: `${who}@wotest.local`, password: PASSWORD }, null)).body.accessToken;
    }
    const p = await call('POST', '/api/loan-products', {
      id: 'WO01', name: 'Write-off product', ...GL, method: 'REDUCING', monthlyRate: 2, maxTerm: 24,
      enforceDepositMultiplier: false, enableCollateral: true,
    });
    check('product created, with Recoveries mapped by default', p.status === 201 && p.body.gl?.recoveries === '400-400', `${p.status} ${p.reason} ${JSON.stringify(p.body?.gl)}`);
    await T(async (c) => {
      for (const [code, rate] of Object.entries({ PERFORMING: 1, WATCH: 5, SUBSTANDARD: 25, DOUBTFUL: 50, LOSS: 100 })) {
        await PV.setBand(c, code, { ratePercent: rate, sourceNote: 'test fixture', createdBy: 'test' });
      }
    });

    const { m } = await T((c) => newMember(c, 10000));
    const g1 = await T((c) => newMember(c, 30000));
    const g2 = await T((c) => newMember(c, 16000));
    const m3 = await T((c) => newMember(c, 10000));
    const loanA = await T(async (c) => {
      const l = await L.apply(c, { memberId: m.id, productId: 'WO01', principal: 50000, termMonths: 6, createdBy: 'officer' });
      await L.addGuarantor(c, l.id, { memberId: g1.m.id, amount: 20000 });
      await L.addGuarantor(c, l.id, { memberId: g2.m.id, amount: 10000 });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
      await L.disburse(c, l.id, { amount: 50000, channelId: 'bank', valueDate: plus(-75), createdBy: 'teller' });
      await L.accrueInterest(c, l.id, { valueDate: plus(0), createdBy: 'test' });
      return l;
    });
    const loanB = await T(async (c) => {
      const l = await L.apply(c, { memberId: m3.m.id, productId: 'WO01', principal: 20000, termMonths: 12, createdBy: 'officer' });
      await L.addGuarantor(c, l.id, { memberId: g2.m.id, amount: 5000 });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
      await L.disburse(c, l.id, { amount: 20000, channelId: 'bank', valueDate: plus(0), createdBy: 'teller' });
      return l;
    });
    await T((c) => L.markArrears(c, { asOf: plus(0) }));
    const col = await call('POST', `/api/loans/${loanA.id}/collateral`, { assetType: 'VEHICLE', description: 'Probox', value: 5000 });
    check('loan A has two guarantors and collateral; loan B is performing', col.status === 201 && (await guarantors(loanA.id)).length === 2, col.reason);
    const run1 = await T((c) => PV.run(c, { asAt: plus(0), createdBy: 'test' }));
    const attr = await T(async (c) => PV.attributable(c, await L.lock(c, loanA.id), { asAt: plus(0) }));
    check('the provision run holds loan A at the substandard rate', run1.posted && attr.band === 'SUBSTANDARD' && attr.amount === 12500,
      JSON.stringify(attr));

    // ----------------------------------------------------------------------
    section('the write-off uses the allowance before the expense');
    const owed = await balancesOf(loanA.id);
    const expPre = await bal('500-310');
    const allowPre = await bal(PV.GL_ALLOWANCE);
    const asked = await call('POST', `/api/loans/${loanA.id}/write-off`, { reason: 'absconded' });
    check('a write-off is requested, not done', asked.status === 201 && asked.body.request.status === 'PENDING' && asked.body.transaction === null
      && (await loanRow(loanA.id)).status !== 'CLOSED_WRITTEN_OFF', `${asked.status} ${asked.reason}`);
    const queue = await call('GET', '/api/loans/write-off-requests');
    check('it waits in the approvers\' queue', queue.status === 200 && queue.body.length === 1 && queue.body[0].account_no === loanA.account_no);
    check('a second request on the same loan is refused', (await call('POST', `/api/loans/${loanA.id}/write-off`, { reason: 'again' })).status === 409);
    let dec = await call('POST', `/api/loans/${loanA.id}/write-off/approve`, {});
    check('the person who asked cannot approve it', dec.status === 403 && /WRITE_OFF_REQUESTER_CANNOT_APPROVE/.test(dec.reason), dec.reason);
    dec = await call('POST', `/api/loans/${loanA.id}/write-off/approve`, {}, 'small');
    check('an approver whose limit is below the amount cannot', dec.status === 403 && /ABOVE_YOUR_APPROVAL_LIMIT/.test(dec.reason), dec.reason);
    const woRes = await call('POST', `/api/loans/${loanA.id}/write-off/approve`, {}, 'checker');
    const wo = { status: woRes.status, reason: woRes.reason, body: woRes.body?.transaction };
    check('a second manager approves it and it is written off', woRes.status === 201 && woRes.body.request.status === 'APPROVED'
      && wo.body.allocation.allowanceUsed === 12500, `${woRes.status} ${woRes.reason} ${JSON.stringify(wo.body?.allocation)}`);
    check('the allowance took 12,500 of the principal', round((await bal(PV.GL_ALLOWANCE)) - allowPre) === 12500);
    check('and the expense the rest', round((await bal('500-310')) - expPre) === round(owed.total - 12500),
      `${round((await bal('500-310')) - expPre)} vs ${round(owed.total - 12500)}`);
    let row = await loanRow(loanA.id);
    check('the loan keeps what was written off, when and by whom', row.status === 'CLOSED_WRITTEN_OFF'
      && Number(row.written_off_amount) === owed.total && row.written_off_by === 'checker@wotest.local' && Number(row.recovered) === 0);
    let gs = await guarantors(loanA.id);
    check('both guarantors are called', gs.every((g) => g.status === 'CALLED'));
    check('the collateral is seized', (await Rd(async (c) => (await c.query('SELECT status FROM loan_collateral WHERE loan_id = $1', [loanA.id])).rows[0].status)) === 'SEIZED');
    const run2 = await T((c) => PV.run(c, { asAt: plus(1), createdBy: 'test' }));
    check('the next provision run finds nothing to release for it', Math.abs(run2.movement) < 1, JSON.stringify({ movement: run2.movement }));
    check('repayments are refused on a written-off loan', (await call('POST', `/api/loans/${loanA.id}/repayments`, { amount: 100, channelId: 'cash' })).status === 409);
    await assertBalanced('the write-off');

    // ----------------------------------------------------------------------
    section('a called guarantor\'s deposits stay committed');
    let r = await call('POST', `/api/savings/${g2.sav.id}/withdrawals`, { amount: 5000, channelId: 'cash' });
    check('a called guarantor cannot withdraw the deposits the call stands on', r.status === 409 && /INSUFFICIENT_AVAILABLE_BALANCE/.test(r.reason), `${r.status} ${r.reason}`);

    // ----------------------------------------------------------------------
    section('recoveries');
    const cashPre = await bal('100-200');
    const recPre = await bal('400-400');
    r = await call('POST', `/api/loans/${loanA.id}/recoveries`, { amount: 3000, channelId: 'cash', narration: 'member paid something' });
    check('the member pays 3,000 on the written-off loan', r.status === 201 && r.body.kind === 'LOAN_RECOVERY', `${r.status} ${r.reason}`);
    check('booked Dr cash, Cr Recoveries on Written-off Loans', round((await bal('100-200')) - cashPre) === 3000 && round(recPre - (await bal('400-400'))) === 3000);
    const tooMuch = await call('POST', `/api/loans/${loanA.id}/recoveries`, { amount: owed.total, channelId: 'cash' });
    check('more than is left of the write-off is refused', tooMuch.status === 409 && /RECOVERY_EXCEEDS_WRITTEN_OFF_BALANCE/.test(tooMuch.reason), tooMuch.reason);
    check('a recovery on a running loan is refused', (await call('POST', `/api/loans/${loanB.id}/recoveries`, { amount: 10, channelId: 'cash' })).status === 409);

    gs = await guarantors(loanA.id);
    const [G1, G2] = gs;
    const wrong = await call('POST', `/api/loans/${loanA.id}/guarantors/${G1.id}/recover`, { savingsAccountId: g2.sav.id });
    check('a guarantor recovery cannot draw on someone else\'s account', wrong.status === 409 && /ACCOUNT_NOT_THE_GUARANTORS/.test(wrong.reason), wrong.reason);
    r = await call('POST', `/api/loans/${loanA.id}/guarantors/${G1.id}/recover`, {});
    check('the first guarantor\'s whole pledge is taken from their deposits', r.status === 201 && Number(r.body.amount) === 20000, `${r.status} ${r.reason}`);
    check('their deposits fall by 20,000 and the pledge is recovered',
      (await savBal(g1.sav.id)) === 10000 && (await guarantors(loanA.id))[0].status === 'RECOVERED');
    r = await call('POST', `/api/loans/${loanA.id}/guarantors/${G2.id}/recover`, { amount: 6000 });
    check('part of the second guarantor\'s pledge is taken', r.status === 201 && (await guarantors(loanA.id))[1].status === 'CALLED'
      && Number((await guarantors(loanA.id))[1].recovered) === 6000, `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${loanA.id}/guarantors/${G2.id}/recover`, { amount: 5000 });
    check('more than is left of the pledge is refused', r.status === 409 && /EXCEEDS_CALLED_PLEDGE/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${loanA.id}/guarantors/${G2.id}/release-call`, { note: 'hardship' });
    check('the rest of the call is released', r.status === 200 && r.body.status === 'RELEASED', `${r.status} ${r.reason}`);
    r = await call('POST', `/api/savings/${g2.sav.id}/withdrawals`, { amount: 5000, channelId: 'cash' });
    check('and the guarantor may use those deposits again, less their other pledge', r.status === 201, `${r.status} ${r.reason}`);
    const kId = (await Rd(async (c) => (await c.query('SELECT id FROM loan_collateral WHERE loan_id = $1', [loanA.id])).rows[0].id));
    r = await call('POST', `/api/loans/${loanA.id}/recoveries`, { amount: 2000, channelId: 'bank', source: 'COLLATERAL', collateralId: kId });
    check('the proceeds of the seized collateral are recovered', r.status === 201 && r.body.allocation.collateralId === kId, `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${loanB.id}/recoveries`, { amount: 2000, channelId: 'bank', source: 'GUARANTOR' });
    check('guarantor recoveries go through the guarantor route', r.status === 409 || r.status === 400);
    row = await loanRow(loanA.id);
    check('the loan counts 31,000 recovered', Number(row.recovered) === 31000, String(row.recovered));
    await assertBalanced('recoveries');

    // ----------------------------------------------------------------------
    section('reversals');
    const woRef = wo.body.reference;
    r = await call('POST', `/api/loans/transactions/${woRef}/reversal`, { narration: 'wrong loan' });
    check('a write-off with recoveries standing cannot be reversed', r.status === 409 && /WRITE_OFF_HAS_RECOVERIES/.test(r.reason), r.reason);
    const recs = await Rd(async (c) => (await c.query(
      "SELECT reference, allocation FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_RECOVERY' ORDER BY created_at", [loanA.id])).rows);
    const g1Rec = recs.find((x) => x.allocation.guarantorId === G1.id);
    r = await call('POST', `/api/loans/transactions/${g1Rec.reference}/reversal`, {});
    check('reversing a guarantor recovery puts the money back in their account and the call back open',
      r.status === 201 && (await savBal(g1.sav.id)) === 30000 && (await guarantors(loanA.id))[0].status === 'CALLED'
      && Number((await guarantors(loanA.id))[0].recovered) === 0, `${r.status} ${r.reason}`);
    for (const x of recs.filter((y) => y.reference !== g1Rec.reference)) {
      await call('POST', `/api/loans/transactions/${x.reference}/reversal`, {});
    }
    check('with every recovery reversed the loan shows none', Number((await loanRow(loanA.id)).recovered) === 0);
    const allowBeforeUndo = await bal(PV.GL_ALLOWANCE);
    r = await call('POST', `/api/loans/transactions/${woRef}/reversal`, { narration: 'wrong loan' });
    check('then the write-off reverses', r.status === 201, `${r.status} ${r.reason}`);
    row = await loanRow(loanA.id);
    check('the loan is back in the state it was in, owing what it owed', ['IN_ARREARS', 'ACTIVE'].includes(row.status)
      && row.status === wo.body.allocation.previousStatus && (await balancesOf(loanA.id)).total === owed.total
      && Number(row.written_off_amount) === 0 && row.closed_on === null, `${row.status} ${(await balancesOf(loanA.id)).total}`);
    gs = await guarantors(loanA.id);
    check('both guarantors are pledged again, the released one included', gs.every((g) => g.status === 'PLEDGED'), gs.map((g) => g.status).join());
    check('the collateral is pledged again', (await Rd(async (c) => (await c.query('SELECT status FROM loan_collateral WHERE loan_id = $1', [loanA.id])).rows[0].status)) === 'PLEDGED');
    check('and the allowance holds its 12,500 again', round(allowBeforeUndo - (await bal(PV.GL_ALLOWANCE))) === 12500);
    const hist = (await call('GET', `/api/loans/${loanA.id}/history`)).body.map((h) => h.action);
    check('the history shows the write-off and its undoing', hist.includes('WRITE_OFF') && hist.at(-1) === 'UNDO_WRITE_OFF', hist.join(','));
    await assertBalanced('reversals');

    // ----------------------------------------------------------------------
    section('rejection, back-dating and the register');
    const m4 = await T((c) => newMember(c, 1000));
    const loanC = await T(async (c) => {
      const l = await L.apply(c, { memberId: m4.m.id, productId: 'WO01', principal: 8000, termMonths: 4, createdBy: 'officer' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
      await L.disburse(c, l.id, { amount: 8000, channelId: 'bank', valueDate: plus(-60), createdBy: 'teller' });
      await L.repay(c, l.id, { amount: 1000, channelId: 'cash', valueDate: plus(-20), createdBy: 'teller' });
      return l;
    });
    r = await call('POST', `/api/loans/${loanC.id}/write-off`, {});
    check('a write-off needs a reason', r.status === 400 && /A_WRITE_OFF_NEEDS_A_REASON/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${loanC.id}/write-off`, { reason: 'deceased', valueDate: plus(1) });
    check('it cannot be dated in the future', r.status === 400, r.reason);
    r = await call('POST', `/api/loans/${loanC.id}/write-off`, { reason: 'deceased', valueDate: plus(-30) });
    check('nor before the last repayment on the loan', r.status === 409 && /WRITE_OFF_BEFORE_LAST_TRANSACTION/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${loanC.id}/write-off`, { reason: 'deceased', valueDate: plus(-10) });
    check('dated back ten days, it is requested', r.status === 201, r.reason);
    r = await call('POST', `/api/loans/${loanC.id}/write-off/reject`, { note: 'estate may pay' }, 'checker');
    check('a request can be rejected, and the loan runs on', r.status === 200 && r.body.request.status === 'REJECTED'
      && (await loanRow(loanC.id)).status !== 'CLOSED_WRITTEN_OFF', `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${loanC.id}/write-off`, { reason: 'deceased', valueDate: plus(-10) });
    const cDone = await call('POST', `/api/loans/${loanC.id}/write-off/approve`, {}, 'checker');
    row = await loanRow(loanC.id);
    const ymd = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
    check('asked again and approved, it is written off on the date asked for',
      cDone.status === 201 && ymd(row.written_off_on) === plus(-10) && ymd(cDone.body.transaction.value_date) === plus(-10),
      `${cDone.status} ${cDone.reason} ${row.written_off_on}`);
    const entryDate = await Rd(async (c) => (await c.query('SELECT booking_date FROM journal_entries WHERE id = $1', [cDone.body.transaction.entry_id])).rows[0].booking_date);
    check('and booked on that date', ymd(entryDate) === plus(-10), String(entryDate));

    await T((c) => c.query('UPDATE lending_controls SET write_off_requires_approval = false WHERE id = 1'));
    const again = await call('POST', `/api/loans/${loanA.id}/write-off`, { reason: 'absconded, confirmed' });
    check('where the tenant does not require approval, the request writes the loan off at once',
      again.status === 201 && again.body.transaction?.kind === 'LOAN_WRITE_OFF' && again.body.request.status === 'APPROVED'
      && again.body.request.decided_by === 'admin@wotest.local', `${again.status} ${again.reason}`);
    await call('POST', `/api/loans/${loanA.id}/recoveries`, { amount: 500, channelId: 'cash' });

    const reg = await call('GET', `/api/loans/write-offs?from=${plus(-30)}&to=${plus(0)}`);
    const aRow = reg.body.items?.find((x) => x.account_no === loanA.account_no);
    const cRow = reg.body.items?.find((x) => x.account_no === loanC.account_no);
    check('the register lists both write-offs in the period', reg.status === 200 && reg.body.total === 2 && aRow && cRow, `${reg.status} ${reg.reason} ${reg.body?.total}`);
    check('with who asked, who approved and why', cRow?.requested_by === 'admin@wotest.local' && cRow?.approved_by === 'checker@wotest.local' && cRow?.reason === 'deceased');
    check('with the split, the allowance used and what has been recovered', aRow?.principal === 50000 && aRow?.recovered === 500
      && aRow?.outstanding === round(aRow.written_off_amount - 500) && aRow?.allowance_used > 0, JSON.stringify(aRow));
    check('and totals for the period', reg.body.totals.loans === 2 && reg.body.totals.written_off === round(aRow.written_off_amount + cRow.written_off_amount)
      && reg.body.totals.recovered === 500, JSON.stringify(reg.body.totals));
    check('recoveries received in the period count those reversed out: only standing ones', reg.body.recoveriesInPeriod.amount === 500, JSON.stringify(reg.body.recoveriesInPeriod));
    const before = await call('GET', `/api/loans/write-offs?to=${plus(-11)}`);
    check('a period before both write-offs is empty', before.body.total === 0 && before.body.totals.written_off === 0);
    await assertBalanced('everything');
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    server.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
