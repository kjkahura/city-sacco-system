#!/usr/bin/env node
'use strict';

/**
 * The back office console, driven in a real browser.
 *
 * Kept out of `npm test` because it needs Chromium, which a server running
 * this software has no reason to have. Run it with `npm run test:console`
 * after `npx playwright install chromium`, or set PLAYWRIGHT_MODULE to an
 * installed copy.
 *
 * What it is actually checking: that the console signs in, that each view
 * renders real data from the API, and that the page raises no JavaScript
 * error along the way. A console that throws in the browser passes every
 * server-side test ever written, which is why this one exists.
 */

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch {
  console.log('playwright is not installed; skipping the console test');
  console.log('  npm i -D playwright && npx playwright install chromium');
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

const SLUG = 'uitest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4099;
const PASSWORD = 'a sufficiently long passphrase';
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
      slug: SLUG, name: 'Console Test SACCO', mfaRequiredRoles: [],
      adminEmail: 'admin@uitest.local', adminPassword: PASSWORD,
    });
    await migrateAllTenants({});

    await T(async (c) => {
      for (let i = 1; i <= 30; i += 1) {
        const m = (await c.query(
          `INSERT INTO members (member_no, first_name, last_name, phone)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [`M${String(i).padStart(4, '0')}`, `Member${i}`, `Surname${String(i).padStart(3, '0')}`,
           `07000000${String(i).padStart(2, '0')}`])).rows[0];
        if (i === 1) {
          const sav = await S.open(c, { memberId: m.id });
          await S.deposit(c, sav.id, { amount: 250000, channelId: 'cash', createdBy: 'test' });
          const loan = await L.apply(c, {
            memberId: m.id, productId: 'NL01', principal: 60000, termMonths: 12, createdBy: 'test' });
          await L.changeState(c, loan.id, 'APPROVE', { createdBy: 'test' });
          await L.disburse(c, loan.id, { amount: 60000, channelId: 'bank', createdBy: 'test' });
        }
      }
    });

    browser = await playwright.chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const page = await browser.newPage();

    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e.message)));
    // A 4xx from the API is the console doing its job (a refusal it then
    // shows the user), not a broken page, so only real script failures and
    // policy violations count.
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/Failed to load resource/.test(m.text())) return;
      jsErrors.push(m.text());
    });

    section('sign in');
    await page.goto(`http://localhost:${PORT}/console/`);
    await page.fill('input[name=tenant]', SLUG);
    await page.fill('input[name=email]', 'admin@uitest.local');
    await page.fill('input[name=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForSelector('#app:not([hidden])', { timeout: 10000 });
    check('the console signs in and shows the shell', true);
    check('it names the SACCO it is signed in to',
      (await page.textContent('#sacco-name')).includes('Console Test SACCO'),
      await page.textContent('#sacco-name'));

    section('members');
    await page.waitForSelector('table tbody tr');
    const rows = await page.locator('table tbody tr').count();
    check('the member list renders a page of rows', rows === 25, String(rows));
    const pagerText = await page.textContent('.pager span');
    check('the pager counts the whole register', /of 30/.test(pagerText), pagerText);

    await page.click('.pager button:has-text("Next")');
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 5);
    check('the next page holds the remainder', true);

    await page.click('table tbody tr');
    await page.waitForSelector('main h1 .badge');
    const memberHeading = await page.textContent('main h1');
    check('a member opens', /Member\d+/.test(memberHeading), memberHeading);

    section('loans');
    await page.click('nav button[data-view=loans]');
    await page.waitForSelector('table tbody tr');
    await page.click('table tbody tr');
    await page.waitForSelector('main h1 .badge');
    const loanHeading = await page.textContent('main h1');
    check('a loan opens with its status', /LN|ACTIVE/.test(loanHeading), loanHeading);
    const schedule = await page.locator('section:has(h2:text("Schedule")) tbody tr').count();
    check('its schedule is there', schedule === 12, String(schedule));

    section('reports');
    await page.click('nav button[data-view=reports]');
    await page.waitForSelector('#r-out table');
    const tbText = await page.textContent('#r-out');
    check('the trial balance renders', /Total \(whole book/.test(tbText));
    check('and it balances', !/does not balance/.test(tbText));

    await page.selectOption('#r-which', 'prudential');
    await page.waitForSelector('.notice');
    check('the prudential report leads with its disclaimer',
      /must be confirmed/.test(await page.textContent('.notice')));

    section('period and provisions');
    await page.click('nav button[data-view=finance]');
    await page.waitForSelector('.notice');
    const financeText = await page.textContent('main');
    check('it says plainly that no provisioning rates are set',
      /have no rate/.test(financeText));
    check('and that no reserve percentage is set',
      /No statutory reserve percentage/.test(financeText));

    await page.click('#f-preview');
    await page.waitForTimeout(400);
    check('previewing without rates reports the refusal rather than a number',
      /NOT_CONFIGURED/.test(await page.textContent('#toast')),
      await page.textContent('#toast'));

    section('returns');
    await page.click('nav button[data-view=returns]');
    await page.waitForSelector('table tbody tr');
    check('the sample template is listed',
      (await page.textContent('main')).includes('SAMPLE_FINPOS'));
    await page.click('table tbody tr');
    await page.waitForSelector('.notice');
    check('rendering it warns that it is not an official return',
      /NOT an official return/.test(await page.textContent('.notice')));
    const x1 = await page.textContent('table tbody tr:last-child td:last-child');
    check('and it ties to the ledger', x1.trim() === '0.00', x1);

    section('loan products');
    await page.click('nav button[data-view=products]');
    await page.waitForSelector('table tbody tr');
    const productsText = await page.textContent('main');
    check('the seeded product is listed with its accounting settings',
      /NL01/.test(productsText) && /ACCRUAL · DAILY · THIRTY_360/.test(productsText));
    check('and its type and method, in words', /Fixed/.test(productsText) && /Flat/.test(productsText));
    await page.click('table tbody tr');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=monthlyRate]', '1.25');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /NL01 saved/.test(document.getElementById('toast').textContent));
    await page.waitForFunction(() => /1\.25/.test(document.querySelector('main').textContent));
    check('a product can be edited from the console', true);
    await page.click('#p-new');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=id]', 'UIDYN');
    await page.fill('dialog[open] input[name=name]', 'Console dynamic');
    await page.selectOption('dialog[open] select[name=productType]', 'DYNAMIC_TERM');
    await page.selectOption('dialog[open] select[name=method]', 'FLAT');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /FLAT/.test(document.getElementById('toast').textContent));
    check('a flat dynamic product is refused with the reason shown',
      /DYNAMIC_TERM product cannot use the FLAT method/.test(await page.textContent('#toast')),
      await page.textContent('#toast'));
    await page.click('#p-new');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=id]', 'UIDYN');
    await page.fill('dialog[open] input[name=name]', 'Console dynamic');
    await page.selectOption('dialog[open] select[name=productType]', 'DYNAMIC_TERM');
    await page.selectOption('dialog[open] select[name=method]', 'REDUCING_EQUAL_INSTALLMENTS');
    await page.selectOption('dialog[open] select[name=prepaymentRecalculation]', 'REDUCE_NUMBER_OF_INSTALLMENTS');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /UIDYN/.test(document.querySelector('main').textContent));
    check('a dynamic, equal-installment product is created from the console',
      /Dynamic/.test(await page.textContent('main')) && /Reducing, equal installments/.test(await page.textContent('main')));

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
