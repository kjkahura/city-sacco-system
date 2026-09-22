#!/usr/bin/env node
'use strict';

/**
 * The member portal, driven in a real browser. Out of `npm test` for the
 * same reason as the console test: it needs Chromium.
 */

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch {
  console.log('playwright is not installed; skipping the portal test');
  process.exit(0);
}

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const L = require('../src/domain/loans');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'puitest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4095;
const T = (fn) => withTenant(SCHEMA, fn);

(async () => {
  const server = app.listen(PORT);
  let browser;
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Portal UI SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@puitest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});

    const two = await T(async (c) => {
      const a = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name, national_id, phone)
         VALUES ('M1','Wanjiru','Mwangi','11223344','0711000111') RETURNING *`)).rows[0];
      const b = (await c.query(
        `INSERT INTO members (member_no, first_name, last_name, national_id, phone)
         VALUES ('M2','Otieno','Ochieng','55667788','0722000222') RETURNING *`)).rows[0];
      const s1 = await S.open(c, { memberId: a.id });
      const s2 = await S.open(c, { memberId: a.id });
      const sb = await S.open(c, { memberId: b.id });
      for (let i = 0; i < 25; i += 1) {
        await S.deposit(c, s1.id, { amount: 1000 + i, channelId: 'cash', createdBy: 'test' });
      }
      await S.deposit(c, s2.id, { amount: 3000, channelId: 'mpesa', createdBy: 'test' });
      await S.deposit(c, sb.id, { amount: 500, channelId: 'cash', createdBy: 'test' });
      const loan = await L.apply(c, { memberId: a.id, productId: 'NL01', principal: 12000, termMonths: 6, createdBy: 'test' });
      await L.changeState(c, loan.id, 'APPROVE', { createdBy: 'test' });
      await L.disburse(c, loan.id, { amount: 12000, channelId: 'bank', createdBy: 'test' });
      return { s1, s2 };
    });

    // B is already activated, so A can send to them.
    const MA = require('../src/auth/memberAuth');
    await T((c) => MA.activate(c, { memberNo: 'M2', nationalId: '55667788', phone: '0722000222', pin: '2222' }));

    browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) jsErrors.push(m.text());
    });

    section('activation');
    await page.goto(`http://localhost:${PORT}/portal/`);
    await page.fill('#login-tenant', SLUG);
    await page.click('#show-register');
    await page.waitForSelector('#register-screen.active');
    await page.fill('#reg-member-no', 'M1');
    await page.fill('#reg-id', '00000000');
    await page.fill('#reg-phone', '0711000111');
    await page.fill('#reg-pin', '1111');
    await page.click('#register-form button[type=submit]');
    await page.waitForSelector('#register-error:not([hidden])');
    check('wrong details are refused with a sentence, not a code',
      /do not match/.test(await page.textContent('#register-error')), await page.textContent('#register-error'));

    await page.fill('#reg-id', '11223344');
    await page.click('#register-form button[type=submit]');
    await page.waitForSelector('#login-screen.active');
    check('the right details activate and return to sign-in', true);
    check('the phone number is carried over to the sign-in form',
      (await page.inputValue('#login-phone')) === '0711000111');

    section('sign-in');
    await page.fill('#login-pin', '9999');
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('#login-error:not([hidden])');
    check('a wrong PIN is refused', /Wrong phone number or PIN/.test(await page.textContent('#login-error')));
    await page.fill('#login-pin', '1111');
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('#app-container:not([hidden])');
    check('the right PIN signs in', true);
    check('the SACCO name is shown', (await page.textContent('#sidebar-sacco-name')).includes('Portal UI SACCO'));

    section('dashboard');
    await page.waitForSelector('#quick-accounts .account-card');
    const cards = await page.locator('#quick-accounts .account-card').count();
    check('every account is on the dashboard', cards === 3, String(cards));
    await page.waitForFunction(() => document.querySelectorAll('#dashboard-transactions tr').length > 0);
    const welcome = await page.textContent('#member-name');
    check('the member is greeted by name', /Wanjiru/.test(welcome), welcome);
    const balance = await page.textContent('#total-balance');
    check('total savings balance is the sum of the savings accounts', /28,300\.00/.test(balance), balance);

    section('transactions page');
    await page.click(`#quick-accounts .account-card[data-account="${two.s1.account_no}"]`);
    await page.waitForSelector('#view-transactions.active');
    await page.waitForFunction(() => document.querySelectorAll('#transactions-list tr').length === 20);
    check('the first page holds twenty rows', true);
    const info = await page.textContent('#page-info');
    check('the pager counts the whole history', /of 25/.test(info), info);
    await page.click('#next-page');
    await page.waitForFunction(() => document.querySelectorAll('#transactions-list tr').length === 5);
    check('the second page holds the remainder', true);
    check('next is disabled on the last page', await page.isDisabled('#next-page'));

    section('a transfer to another member');
    await page.click('.nav-item[data-view=transfer]');
    await page.click('#internal-transfer');
    await page.fill('#internal-phone', '0722000222');
    await page.click('#lookup-recipient');
    await page.waitForSelector('#recipient-info:not([hidden])');
    const who = await page.textContent('#recipient-name');
    check('the recipient is confirmed by first name only', who === 'Otieno O.', who);
    await page.fill('#internal-amount', '250');
    await page.fill('#internal-description', 'chama');
    await page.click('#internal-transfer-submit button[type=submit]');
    // An earlier success toast may still be showing; wait for this one.
    await page.waitForFunction(() => /Transfer posted/.test(document.getElementById('toast').textContent));
    check('the transfer posts', true);
    const bBalance = await T(async (c) => (await c.query(
      "SELECT balance FROM savings_accounts WHERE member_id = (SELECT id FROM members WHERE member_no = 'M2')")).rows[0].balance);
    check('and the money arrived', Number(bBalance) === 750, String(bBalance));

    section('beneficiaries');
    await page.click('.nav-item[data-view=beneficiaries]');
    await page.click('#add-beneficiary-btn');
    await page.waitForSelector('#add-beneficiary-modal:not([hidden])');
    await page.fill('#ben-name', 'Otieno');
    await page.fill('#ben-phone', '0722000222');
    await page.selectOption('#ben-relationship', { index: 1 });
    await page.click('#add-beneficiary-form button[type=submit]');
    await page.waitForSelector('#beneficiaries-list .beneficiary-card');
    check('a beneficiary who is a member is marked as one',
      /Member of this SACCO/.test(await page.textContent('#beneficiaries-list')));

    section('sign-out');
    await page.click('#logout-btn');
    await page.waitForSelector('#login-screen.active');
    check('signing out returns to the sign-in screen', true);
    const leftover = await page.evaluate(() => sessionStorage.getItem('portal.refresh'));
    check('and leaves no session behind', leftover === null, String(leftover));

    section('no JavaScript errors anywhere in that');
    check('the browser reported no page errors', jsErrors.length === 0, jsErrors.join(' | '));
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    await browser?.close();
    server.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
