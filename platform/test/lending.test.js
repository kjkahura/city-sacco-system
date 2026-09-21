#!/usr/bin/env node
'use strict';

/**
 * Lending and savings domain tests, against real Postgres.
 *
 * The point of these is the money, not the plumbing: allocation order,
 * guarantor pledges blocking withdrawals, reversals restoring both the loan
 * and the ledger, and the trial balance staying balanced after every
 * operation including the corrections.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const L = require('../src/domain/loans');
const S = require('../src/domain/savings');
const acct = require('../src/domain/accounting');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
async function throws(label, fn, matcher) {
  try { await fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, matcher ? matcher(e) : true, e.message.slice(0, 140)); }
}

const SLUG = 'lendtest';
const SCHEMA = `tenant_${SLUG}`;
const T = (fn) => withTenant(SCHEMA, fn);
const R = (fn) => withTenantRead(SCHEMA, fn);

/** The invariant that must hold after literally every operation. */
async function assertBalanced(label) {
  const tb = await R((c) => acct.trialBalance(c));
  check(`trial balance still balances after ${label}`, tb.balanced,
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
      slug: SLUG, name: 'Lending Test SACCO',
      mfaRequiredRoles: [],  // this SACCO has not turned MFA on yet
      adminEmail: 'admin@lendtest.local', adminPassword: 'a sufficiently long passphrase',
    });
    check('tenant provisioned', true);

    const { borrower, guarantor, bAcct, gAcct } = await T(async (c) => {
      const b = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name) VALUES ('M000001','Grace','Njeri') RETURNING *`)).rows[0];
      const g = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name) VALUES ('M000002','Peter','Otieno') RETURNING *`)).rows[0];
      return {
        borrower: b, guarantor: g,
        bAcct: await S.open(c, { memberId: b.id }),
        gAcct: await S.open(c, { memberId: g.id }),
      };
    });
    check('two members with savings accounts', !!bAcct.id && !!gAcct.id);

    section('savings');
    await T((c) => S.deposit(c, bAcct.id, { amount: 50000, channelId: 'mpesa', createdBy: 'test' }));
    await T((c) => S.deposit(c, gAcct.id, { amount: 80000, channelId: 'cash', createdBy: 'test' }));
    let sum = await T((c) => S.summary(c, bAcct.id));
    check('deposit credited', sum.balance === 50000, String(sum.balance));
    await assertBalanced('deposits');

    await T((c) => S.withdraw(c, bAcct.id, { amount: 10000, channelId: 'cash', createdBy: 'test' }));
    sum = await T((c) => S.summary(c, bAcct.id));
    check('withdrawal debited', sum.balance === 40000, String(sum.balance));

    await throws('overdraw refused', () =>
      T((c) => S.withdraw(c, bAcct.id, { amount: 999999, createdBy: 'test' })),
      (e) => /INSUFFICIENT_AVAILABLE_BALANCE/.test(e.message));
    await assertBalanced('withdrawals');

    section('eligibility, the deposits multiplier');
    const elig = await T((c) => L.checkEligibility(c, {
      memberId: borrower.id, productId: 'NL01', principal: 200000,
    }));
    check('ceiling is 3x deposits', elig.ceiling === 120000, JSON.stringify(elig));
    check('200k against 40k deposits is not eligible', elig.eligible === false);
    const elig2 = await T((c) => L.checkEligibility(c, {
      memberId: borrower.id, productId: 'NL01', principal: 100000,
    }));
    check('100k is eligible', elig2.eligible === true);

    section('loan application and guarantors');
    const loan = await T((c) => L.apply(c, {
      memberId: borrower.id, productId: 'NL01', principal: 120000, termMonths: 12, createdBy: 'test',
    }));
    check('loan starts PENDING_APPROVAL', loan.status === 'PENDING_APPROVAL', loan.status);

    await throws('member cannot guarantee own loan', () =>
      T((c) => L.addGuarantor(c, loan.id, { memberId: borrower.id, amount: 1000 })),
      (e) => /OWN_LOAN/.test(e.message));

    await throws('guarantor cannot pledge more than free deposits', () =>
      T((c) => L.addGuarantor(c, loan.id, { memberId: guarantor.id, amount: 500000 })),
      (e) => /INSUFFICIENT_FREE_DEPOSITS/.test(e.message));

    const g = await T((c) => L.addGuarantor(c, loan.id, { memberId: guarantor.id, amount: 60000 }));
    check('guarantor pledged 60k', g.pledged_amount === 60000, String(g.pledged_amount));

    const gSum = await T((c) => S.summary(c, gAcct.id));
    check('pledge reduces guarantor available balance',
      gSum.balance === 80000 && gSum.pledged === 60000 && gSum.available === 20000, JSON.stringify(gSum));

    await throws('guarantor cannot withdraw pledged funds', () =>
      T((c) => S.withdraw(c, gAcct.id, { amount: 30000, createdBy: 'test' })),
      (e) => /pledged as loan security/.test(e.message));

    section('disbursement');
    await throws('cannot disburse before approval', () =>
      T((c) => L.disburse(c, loan.id, { amount: 120000, createdBy: 'test' })),
      (e) => /LOAN_NOT_APPROVED/.test(e.message));

    await T((c) => L.changeState(c, loan.id, 'APPROVE', { createdBy: 'test' }));
    const disb = await T((c) => L.disburse(c, loan.id, { amount: 120000, channelId: 'bank', createdBy: 'test' }));
    check('disbursed', disb.kind === 'LOAN_DISBURSEMENT' && disb.amount === 120000);
    await assertBalanced('disbursement');

    const sched = await R(async (c) =>
      (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [loan.id])).rows);
    check('12 installments generated', sched.length === 12, String(sched.length));
    check('processing fee sits on installment 1 only',
      sched[0].fee_due === 1000 && sched.slice(1).every((i) => i.fee_due === 0));
    check('no installment falls on a weekend',
      sched.every((i) => ![0, 6].includes(new Date(i.due_date).getUTCDay())));
    check('principal sums to the loan amount',
      Math.round(sched.reduce((s, i) => s + i.principal_due, 0)) === 120000);

    section('repayment allocation order');
    let bal = await T(async (c) => L.balances(await L.lock(c, loan.id)));
    check('fees outstanding after disbursement', bal.fees === 1000, JSON.stringify(bal));

    const rep = await T((c) => L.repay(c, loan.id, { amount: 11000, channelId: 'mpesa', createdBy: 'test' }));
    check('fees cleared before principal',
      rep.allocation.fees === 1000 && rep.allocation.principal === 10000,
      JSON.stringify(rep.allocation));
    await assertBalanced('repayment');

    bal = await T(async (c) => L.balances(await L.lock(c, loan.id)));
    check('principal reduced to 110000', bal.principal === 110000, String(bal.principal));

    section('interest accrual then allocation');
    await T((c) => L.accrueInterest(c, loan.id, { createdBy: 'test' }));
    bal = await T(async (c) => L.balances(await L.lock(c, loan.id)));
    check('interest accrued at 1% of principal', bal.interest === 1200, String(bal.interest));
    await assertBalanced('accrual');

    const rep2 = await T((c) => L.repay(c, loan.id, { amount: 5000, createdBy: 'test' }));
    check('interest cleared before principal',
      rep2.allocation.interest === 1200 && rep2.allocation.principal === 3800,
      JSON.stringify(rep2.allocation));

    section('overpayment goes to savings, not a mystery credit');
    const before = (await T((c) => S.summary(c, bAcct.id))).balance;
    const bal2 = await T(async (c) => L.balances(await L.lock(c, loan.id)));
    const over = await T((c) => L.repay(c, loan.id, {
      amount: round(bal2.total + 7500), createdBy: 'test',
    }));
    check('surplus routed to savings', over.allocation.surplus === 7500, JSON.stringify(over.allocation));
    const after = (await T((c) => S.summary(c, bAcct.id))).balance;
    check('savings increased by the surplus', round(after - before) === 7500, `${before} -> ${after}`);

    const closed = await R(async (c) =>
      (await c.query('SELECT status FROM loan_accounts WHERE id = $1', [loan.id])).rows[0].status);
    check('loan closed as repaid', closed === 'CLOSED_REPAID', closed);

    const gAfter = await T((c) => S.summary(c, gAcct.id));
    check('guarantor pledge released on repayment', gAfter.pledged === 0, JSON.stringify(gAfter));
    await assertBalanced('payoff');

    section('reversal restores loan, ledger and savings');
    const beforeRev = await T(async (c) => L.balances(await L.lock(c, loan.id)));
    const savBefore = (await T((c) => S.summary(c, bAcct.id))).balance;
    await T((c) => L.reverseTransaction(c, over.reference, { createdBy: 'test' }));

    const afterRev = await T(async (c) => L.balances(await L.lock(c, loan.id)));
    check('reversal restored the loan balance',
      round(afterRev.total - beforeRev.total) === round(over.amount - over.allocation.surplus),
      `${beforeRev.total} -> ${afterRev.total}`);
    const savAfter = (await T((c) => S.summary(c, bAcct.id))).balance;
    check('reversal clawed back the surplus', round(savBefore - savAfter) === 7500, `${savBefore} -> ${savAfter}`);
    const reopened = await R(async (c) =>
      (await c.query('SELECT status FROM loan_accounts WHERE id = $1', [loan.id])).rows[0].status);
    check('loan reopened from CLOSED_REPAID', reopened === 'ACTIVE', reopened);
    await assertBalanced('reversal');

    await throws('double reversal refused', () =>
      T((c) => L.reverseTransaction(c, over.reference, { createdBy: 'test' })),
      (e) => /ALREADY_REVERSED/.test(e.message));

    section('the original entry survives the correction');
    const lines = await R(async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE reversal_of IS NOT NULL`)).rows[0].n);
    check('reversing entries exist alongside originals', lines > 0, String(lines));
    await throws('a posted line still cannot be edited', () =>
      T((c) => c.query('UPDATE journal_lines SET amount = 1 WHERE line_no = 1')),
      (e) => /immutable/i.test(e.message));

    section('concurrent repayments do not lose one another');
    const loan2 = await T(async (c) => {
      const l = await L.apply(c, {
        memberId: borrower.id, productId: 'NL01', principal: 60000, termMonths: 6, createdBy: 'test' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'test' });
      await L.disburse(c, l.id, { amount: 60000, channelId: 'bank', createdBy: 'test' });
      return l;
    });
    // Ten concurrent 1000 repayments. Without FOR UPDATE and SQL-side
    // arithmetic these would read-modify-write over each other.
    await Promise.all(Array.from({ length: 10 }, () =>
      T((c) => L.repay(c, loan2.id, { amount: 1000, createdBy: 'test' }))));
    const l2 = await T((c) => L.lock(c, loan2.id));
    check('all 10 concurrent repayments landed',
      round(l2.fees_paid + l2.principal_paid + l2.interest_paid) === 10000,
      `fees ${l2.fees_paid} principal ${l2.principal_paid}`);
    await assertBalanced('concurrent repayments');

    section('write-off calls the guarantors');
    const loan3 = await T(async (c) => {
      const l = await L.apply(c, {
        memberId: borrower.id, productId: 'NL01', principal: 30000, termMonths: 6, createdBy: 'test' });
      await L.addGuarantor(c, l.id, { memberId: guarantor.id, amount: 20000 });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'test' });
      await L.disburse(c, l.id, { amount: 30000, channelId: 'bank', createdBy: 'test' });
      return l;
    });
    await T((c) => L.writeOff(c, loan3.id, { createdBy: 'test' }));
    const gs = await R(async (c) => (await c.query(
      'SELECT status FROM loan_guarantors WHERE loan_id = $1', [loan3.id])).rows[0].status);
    check('guarantor marked CALLED, not released', gs === 'CALLED', gs);
    await assertBalanced('write-off');

    section('arrears');
    await T((c) => c.query(
      `UPDATE loan_installments SET due_date = current_date - 30
       WHERE loan_id = $1 AND number = 1`, [loan2.id]));
    const flagged = await T((c) => L.markArrears(c, {}));
    check('overdue loan flagged', flagged.some((r) => r.id === loan2.id), JSON.stringify(flagged));

    section('cleanup');
    await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query("DELETE FROM platform.users WHERE email = 'admin@lendtest.local'");
    await pool.query('DELETE FROM platform.tenants WHERE slug = $1', [SLUG]);
    check('tenant removed', true);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`); console.error(e);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
  await pool.end();
  process.exit(fail ? 1 : 0);
})();

function round(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
