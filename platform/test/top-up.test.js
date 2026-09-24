#!/usr/bin/env node
'use strict';

/**
 * Top-ups (refinance) as applications: requested while the old loan keeps
 * running, approved under the same eligibility, cover and limit rules as any
 * loan, and paid out by settling the old loan first.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const { hashPassword } = require('../src/auth/passwords');
const L = require('../src/domain/loans');
const R = require('../src/domain/restructure');
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
  catch (e) { check(label, matcher ? matcher(e) : true, e.message.slice(0, 160)); }
}

const SLUG = 'topuptest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4093;
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
const login = async (email) => (await call('POST', '/api/auth/login', { email, password: PASSWORD }, null)).body.accessToken;
async function assertBalanced(label) {
  const tb = await Rd((c) => acct.trialBalance(c));
  check(`trial balance balances after ${label}`, tb.balanced, `dr ${tb.totals.debit} cr ${tb.totals.credit}`);
}

let seq = 0;
async function newMember(c, deposit = 0) {
  seq += 1;
  const no = `T${String(seq).padStart(4, '0')}`;
  const m = (await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ($1,'Top',$1) RETURNING *`, [no])).rows[0];
  const sav = await S.open(c, { memberId: m.id });
  if (deposit) await S.deposit(c, sav.id, { amount: deposit, channelId: 'cash', createdBy: 'test' });
  return m;
}
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
const balancesOf = (id) => T(async (c) => L.balances(await L.lock(c, id)));
const BANK = async () => (await Rd(async (c) => (await c.query("SELECT gl_account_code FROM transaction_channels WHERE id = 'bank'")).rows[0])).gl_account_code;

const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200' };

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Top-up SACCO', mfaRequiredRoles: [], adminEmail: 'admin@topuptest.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    const tenant = (await pool.query('SELECT * FROM platform.tenants WHERE slug=$1', [SLUG])).rows[0];
    const hash = await hashPassword(PASSWORD);
    for (const [who, approval, disbursement] of [['junior', 50000, 50000], ['senior', null, null], ['tiny', null, 10000]]) {
      await pool.query(
        `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role, approval_limit, disbursement_limit)
         VALUES ($1,$2,$3,$2,'MANAGER',$4,$5)`, [tenant.id, `${who}@topuptest.local`, hash, approval, disbursement]);
    }
    tokens.admin = await login('admin@topuptest.local');
    for (const who of ['junior', 'senior', 'tiny']) tokens[who] = await login(`${who}@topuptest.local`);
    check('staff signed in', tokens.admin && tokens.junior && tokens.senior && tokens.tiny);

    const p1 = await call('POST', '/api/loan-products', {
      id: 'TU01', name: 'Top-up product', ...GL, productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, maxTerm: 36,
      maxPrincipal: 1000000, enforceDepositMultiplier: true, maxMultiplier: 3, requireGuarantorCover: true, minCoverPercent: 100, enableCollateral: true,
    });
    const p2 = await call('POST', '/api/loan-products', {
      id: 'TU02', name: 'Plain', ...GL, productType: 'DYNAMIC_TERM', method: 'REDUCING', monthlyRate: 1, maxTerm: 36, enforceDepositMultiplier: false, allowArbitraryFees: true,
    });
    check('products created', p1.status === 201 && p2.status === 201, `${p1.status} ${p1.reason} ${p2.status} ${p2.reason}`);
    const ctl = await call('PATCH', '/api/loans/controls', { oneActiveLoanPerMember: true, twoManRule: true });
    check('one active loan per member and the two-man rule are on', ctl.status === 200 && ctl.body.one_active_loan_per_member && ctl.body.two_man_rule);

    // A member with 40,000 of deposits (ceiling 120,000 at three times), a
    // 90,000 loan covered by their deposits, a 50,000 pledge and collateral.
    const m = await T((c) => newMember(c, 40000));
    const g1 = await T((c) => newMember(c, 100000));
    const g2 = await T((c) => newMember(c, 100000));
    const old = await T(async (c) => {
      const l = await L.apply(c, { memberId: m.id, productId: 'TU01', principal: 90000, termMonths: 12, createdBy: 'officer' });
      await L.addGuarantor(c, l.id, { memberId: g1.id, amount: 50000 });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
      await L.disburse(c, l.id, { amount: 90000, channelId: 'bank', valueDate: plus(-20), createdBy: 'teller' });
      await L.accrueInterest(c, l.id, { valueDate: plus(0), createdBy: 'test' });
      return l;
    });
    const col = await call('POST', `/api/loans/${old.id}/collateral`, { assetType: 'VEHICLE', description: 'Probox KDA', value: 10000 });
    check('the running loan has collateral', col.status === 201, col.reason);
    const before = await balancesOf(old.id);
    const settleNow = round(before.principal + before.interest + before.fees + before.penalty);

    // ----------------------------------------------------------------------
    section('the request is an application; the old loan keeps running');
    const big = await call('POST', `/api/loans/${old.id}/refinance`, { topUp: 40000, termMonths: 24, note: 'school fees' }, 'junior');
    check('a top-up request opens an application', big.status === 201 && big.body.application.refinance_of === old.id
      && ['PENDING_APPROVAL', 'PARTIAL_APPLICATION'].includes(big.body.application.status), `${big.status} ${big.reason}`);
    check('even with one active loan per member, since the new loan replaces the old', big.status === 201);
    check('its principal is the settlement plus the top-up asked for',
      Number(big.body.application.principal) === round(settleNow + 40000) && big.body.quote.settlement === settleNow && big.body.quote.topUp === 40000,
      JSON.stringify(big.body.quote));
    check('the old loan is untouched', (await loanRow(old.id)).status === 'ACTIVE');
    const again = await call('POST', `/api/loans/${old.id}/refinance`, { topUp: 1000, termMonths: 24 });
    check('a second top-up on the same loan is refused while one is open', again.status === 409 && /TOP_UP_ALREADY_OPEN/.test(again.reason), again.reason);
    const nothing = await call('POST', `/api/loans/${old.id}/refinance`, { principal: settleNow, termMonths: 24 });
    check('a principal that leaves no top-up is refused', nothing.status === 409 || nothing.status === 400, `${nothing.status} ${nothing.reason}`);

    // ----------------------------------------------------------------------
    section('approval judges the gross new loan');
    let r = await call('POST', `/api/loans/${big.body.application.id}/approve`, {}, 'senior');
    check('a top-up past three times deposits is refused', r.status === 409 && /LOAN_EXCEEDS_DEPOSIT_MULTIPLIER/.test(r.reason), r.reason);
    await call('POST', `/api/loans/${big.body.application.id}/reject`, { note: 'too much' }, 'senior');
    const rq = await call('POST', `/api/loans/${old.id}/refinance`, { topUp: 20000, termMonths: 24 });
    check('once rejected, a smaller top-up can be asked for', rq.status === 201, rq.reason);
    const appId = rq.body.application.id;
    const gross = Number(rq.body.application.principal);
    const el = await call('GET', `/api/loans/${appId}/eligibility`);
    check('the old loan\'s pledge and collateral count towards cover', el.body.carried?.pledged === 50000 && el.body.carried?.collateral === 10000
      && el.body.pledged === 50000 && el.body.collateral === 10000, JSON.stringify(el.body.carried));
    check('and its balance is not counted as exposure beside the new loan', el.body.exposure.outstanding === 0 && el.body.exposure.activeLoans === 0,
      JSON.stringify(el.body.exposure));
    r = await call('POST', `/api/loans/${appId}/approve`, {}, 'senior');
    check('cover short of the gross principal is refused: 40,000 + 50,000 + 10,000 < gross',
      r.status === 409 && /INSUFFICIENT_GUARANTOR_COVER/.test(r.reason), r.reason);
    const g = await call('POST', `/api/loans/${appId}/guarantors`, { memberId: g2.id, amount: 25000 });
    check('a guarantor can be added to the top-up application', g.status === 201, g.reason);
    r = await call('POST', `/api/loans/${appId}/approve`, {}, 'junior');
    check('an approver whose limit is below the gross new loan is refused', r.status === 403 && /ABOVE_YOUR_APPROVAL_LIMIT/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${appId}/approve`, {}, 'senior');
    check('covered and within the multiple, it is approved', r.status === 200 && r.body.status === 'APPROVED', `${r.status} ${r.reason}`);

    // ----------------------------------------------------------------------
    section('disbursement settles the old loan and pays the rest');
    await throws('the ordinary disbursement refuses a top-up application',
      () => T((c) => L.disburse(c, appId, { channelId: 'bank', createdBy: 'someone' })), (e) => /TOP_UP_APPLICATION_DISBURSES_THROUGH_REFINANCE/.test(e.message));
    await throws('and a refinance cannot be done in one step any more',
      () => T((c) => R.restructure(c, old.id, { kind: 'REFINANCE', termMonths: 12, topUp: 100, createdBy: 'x' })), (e) => /TOP_UP_NEEDS_AN_APPLICATION/.test(e.message));
    r = await call('POST', `/api/loans/${appId}/disbursements`, { channelId: 'bank' }, 'senior');
    check('the approver may not disburse under the two-man rule', r.status === 403 && /TWO_MAN_RULE/.test(r.reason), r.reason);
    r = await call('POST', `/api/loans/${appId}/disbursements`, { channelId: 'bank' }, 'tiny');
    check('a disbursing user\'s limit applies to the top-up paid out', r.status === 403 && /ABOVE_YOUR_DISBURSEMENT_LIMIT/.test(r.reason), r.reason);

    // The member pays 5,000 on the old loan between approval and payout.
    await T((c) => L.repay(c, old.id, { amount: 5000, channelId: 'cash', valueDate: plus(0), createdBy: 'teller' }));
    const q = await call('GET', `/api/loans/${appId}/refinance-quote`);
    check('the quote moves with the old balance: the top-up grows by what was repaid', q.status === 200 && q.body.topUp === round(20000 + 5000),
      JSON.stringify(q.body));
    const bankPre = await bal(await BANK());
    const rf = await call('POST', `/api/loans/${appId}/disbursements`, { channelId: 'bank' }, 'junior');
    check('a user whose limit covers the top-up (not the gross loan) disburses it', rf.status === 201 && rf.body.topUp === 25000, `${rf.status} ${rf.reason}`);
    check('the old loan is closed as refinanced and settled to zero',
      rf.body.oldLoan?.status === 'CLOSED_REFINANCED' && (await balancesOf(old.id)).total === 0);
    const fresh = await loanRow(appId);
    check('the application is now the active loan, linked to the old one, for the approved principal',
      fresh.status === 'ACTIVE' && fresh.parent_loan_id === old.id && Number(fresh.principal_disbursed) === gross && (await balancesOf(appId)).principal === gross);
    check('only the top-up left the bank', round(bankPre - (await bal(await BANK()))) === 25000, String(round(bankPre - (await bal(await BANK())))));
    const gs = await Rd(async (c) => (await c.query("SELECT member_id, pledged_amount FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED' ORDER BY pledged_amount DESC", [appId])).rows);
    check('the old pledge moved across and the new one stands', gs.length === 2 && Number(gs[0].pledged_amount) === 50000 && Number(gs[1].pledged_amount) === 25000);
    const oldGs = await Rd(async (c) => (await c.query("SELECT count(*)::int AS n FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED'", [old.id])).rows[0].n);
    check('and nothing is left pledged on the old loan', oldGs === 0);
    const cols = await Rd(async (c) => (await c.query("SELECT loan_id FROM loan_collateral WHERE status = 'PLEDGED'")).rows);
    check('the collateral moved to the new loan', cols.length === 1 && cols[0].loan_id === appId);
    const hist = (await call('GET', `/api/loans/${appId}/history`)).body.map((h) => h.action);
    check('the new loan\'s history reads apply, approve, refinance', hist.includes('APPLY') && hist.includes('APPROVE') && hist.at(-1) === 'REFINANCE', hist.join(','));
    const read = await call('GET', `/api/loans/${appId}`);
    check('the loan read names the loan it refinanced', read.body.refinances_account_no === old.account_no && read.body.parent_account_no === old.account_no);
    check('the schedule is drawn on the new principal', (await Rd(async (c) => (await c.query('SELECT count(*)::int AS n FROM loan_installments WHERE loan_id = $1', [appId])).rows[0].n)) === 24);
    await assertBalanced('a top-up');

    // ----------------------------------------------------------------------
    section('approval checks there is still a top-up');
    const m2 = await T((c) => newMember(c, 50000));
    const old2 = await T(async (c) => {
      const l = await L.apply(c, { memberId: m2.id, productId: 'TU02', principal: 30000, termMonths: 6, createdBy: 'officer' });
      await L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' });
      await L.disburse(c, l.id, { amount: 30000, channelId: 'bank', valueDate: plus(0), createdBy: 'teller' });
      return l;
    });
    const thin = await call('POST', `/api/loans/${old2.id}/refinance`, { topUp: 100, termMonths: 6 });
    check('a thin top-up is requested', thin.status === 201, thin.reason);
    const fee = await call('POST', `/api/loans/${old2.id}/fees`, { name: 'Valuation', amount: 500 });
    check('a fee lands on the old loan afterwards', fee.status === 201, fee.reason);
    r = await call('POST', `/api/loans/${thin.body.application.id}/approve`, {}, 'senior');
    check('approval is refused once settlement leaves nothing to pay out', r.status === 409 && /NO_TOP_UP_LEFT/.test(r.reason), r.reason);
    await call('PATCH', '/api/loans/controls', { oneActiveLoanPerMember: false });
    const forged = await call('POST', '/api/loans', { memberId: m2.id, productId: 'TU02', principal: 1000, termMonths: 6, refinanceOf: old2.id, refinanceArrears: 'WRITE_OFF' });
    check('an ordinary application cannot make itself a top-up from the request body',
      forged.status === 201 && forged.body.refinance_of === null, `${forged.status} ${forged.body?.refinance_of}`);
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
