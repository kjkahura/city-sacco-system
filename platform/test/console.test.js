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

    // A top-up is an application: requested here, approved, then paid out.
    const oldNo = (await page.textContent('main h1')).match(/LN\d+/)[0];
    await page.click('button[data-action=refinance]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=topUp]', '10000');
    await page.fill('dialog[open] input[name=termMonths]', '18');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#top-up-quote');
    check('a top-up request opens an application awaiting approval, naming the loan it settles',
      /PENDING_APPROVAL/.test(await page.textContent('main h1')) && (await page.textContent('#top-up-quote')).includes(oldNo),
      await page.textContent('main h1'));
    await page.click('button[data-action=approve]');
    await page.waitForSelector('main h1 .badge:text("APPROVED")');
    await page.click('button[data-action=disburse]');
    await page.waitForSelector('dialog[open]');
    const dialogText = await page.textContent('dialog[open]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('main h1 .badge:text("ACTIVE")');
    check('disbursing it shows the settlement and top-up, and the new loan becomes active',
      /Settles/.test(dialogText) && /10,000/.test(dialogText) && (await page.textContent('main p.hint')).includes(`replaces ${oldNo}`),
      dialogText.slice(0, 160));

    // A write-off is requested and waits for a second person; rejected here.
    await page.click('button[data-action=write-off]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=narration]', 'member absconded');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#wo-pending');
    check('a write-off request shows as pending with approve and reject in place of write-off',
      (await page.textContent('#wo-pending')).includes('member absconded')
      && await page.locator('button[data-action=approve-write-off]').count() === 1
      && await page.locator('button[data-action=write-off]').count() === 0);
    await page.click('button[data-action=reject-write-off]');
    await page.waitForSelector('dialog[open]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('button[data-action=write-off]');
    // With approval turned off for the tenant, the same action writes it off; then something is recovered.
    await T((c) => c.query('UPDATE lending_controls SET write_off_requires_approval = false WHERE id = 1'));
    await page.click('button[data-action=write-off]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=narration]', 'member absconded');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('main h1 .badge:text("CLOSED_WRITTEN_OFF")');
    const leftBefore = await page.textContent('#wo-left');
    await page.click('button[data-action=recovery]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=amount]', '1000');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction((before) => document.querySelector('#wo-left') && document.querySelector('#wo-left').textContent !== before, leftBefore);
    const num = (t) => Number(String(t).replace(/[^0-9.]/g, ''));
    check('a written-off loan shows what is left to recover, and a recovery brings it down',
      Math.round(num(leftBefore) - num(await page.textContent('#wo-left'))) === 1000, `${leftBefore} -> ${await page.textContent('#wo-left')}`);

    section('schedule editing and postdated payments');
    const { appNo, runNo, runId } = await T(async (c) => {
      await c.query("UPDATE loan_products SET schedule_editing = ARRAY['PAYMENT_DATES','PRINCIPAL','INTEREST'], allow_postdated_payments = true, allow_arbitrary_fees = true WHERE id = 'NL01'");
      const ms = (await c.query("SELECT id FROM members WHERE member_no IN ('M0002','M0003') ORDER BY member_no")).rows;
      const a = await L.apply(c, { memberId: ms[0].id, productId: 'NL01', principal: 12000, termMonths: 3, createdBy: 'test' });
      const sav = await S.open(c, { memberId: ms[1].id });
      await S.deposit(c, sav.id, { amount: 50000, channelId: 'cash', createdBy: 'test' });
      const r = await L.apply(c, { memberId: ms[1].id, productId: 'NL01', principal: 12000, termMonths: 3, createdBy: 'test' });
      await L.changeState(c, r.id, 'APPROVE', { createdBy: 'test' });
      await L.disburse(c, r.id, { amount: 12000, channelId: 'bank', createdBy: 'test' });
      return { appNo: a.account_no, runNo: r.account_no, runId: r.id };
    });
    await page.evaluate((no) => loanDetail({ account_no: no }), appNo);
    await page.waitForSelector('#application-schedule');
    check('an application shows the schedule it would be drawn with', (await page.locator('#application-schedule tbody tr').count()) === 3);
    await page.click('button[data-action=edit-schedule]');
    await page.waitForSelector('dialog#schedule-editor');
    check('the editor opens with a row per installment', (await page.locator('dialog#schedule-editor tbody tr').count()) === 3);
    const soon = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
    await page.fill('dialog#schedule-editor tbody tr:first-child input[name=dueDate]', soon);
    await page.click('dialog#schedule-editor button[value=ok]');
    await page.waitForSelector('#application-schedule h2:has-text("edited")');
    check('saving it keeps the schedule on the application, with a way back to the product\'s',
      await page.locator('button[data-action=product-schedule]').count() === 1);
    await page.evaluate((no) => loanDetail({ account_no: no }), runNo);
    await page.waitForSelector('button[data-action=edit-schedule]');
    await page.click('button[data-action=edit-schedule]');
    await page.waitForSelector('dialog#schedule-editor');
    await page.fill('dialog#schedule-editor tbody tr:nth-child(3) input[name=interest]', '55');
    await page.click('dialog#schedule-editor button[value=ok]');
    await page.waitForFunction(() => !document.querySelector('dialog#schedule-editor'));
    await page.waitForTimeout(300);
    const edited = await T((c) => c.query('SELECT interest_due FROM loan_installments WHERE loan_id = $1 AND number = 3', [runId]));
    check('on a running loan the editor changes the installments that may change', Number(edited.rows[0].interest_due) === 55, String(edited.rows[0]?.interest_due));
    await page.click('button[data-action=postdate-all]');
    await page.waitForSelector('dialog[open]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('section:has(h2:text("Postdated payments")) tbody tr');
    check('the remaining installments can be postdated at once and are listed with a cancel link',
      (await page.locator('section:has(h2:text("Postdated payments")) tbody tr').count()) === 3
      && (await page.locator('[data-cancel-postdated]').count()) === 3,
      `${await page.locator('section:has(h2:text("Postdated payments")) tbody tr').count()} ${await page.locator('[data-cancel-postdated]').count()}`);

    await page.click('button[data-action=planned-fee]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=installment]', '3');
    await page.fill('dialog[open] input[name=name]', 'Site visit');
    await page.fill('dialog[open] input[name=amount]', '100');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('section:has(h2:text("Planned fees")) tbody tr');
    check('a fee can be planned on an installment and is listed with apply, edit and delete',
      (await page.locator('[data-apply-planned]').count()) === 1 && (await page.textContent('section:has(h2:text("Schedule")) tbody')).includes('planned'));
    await page.click('button[data-action=custom-repay]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=principal]', '100');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.waitForTimeout(300);
    const custom = await T((c) => c.query("SELECT allocation FROM transactions WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT' ORDER BY created_at DESC LIMIT 1", [runId]));
    check('a custom repayment puts the money where the teller says', custom.rows[0]?.allocation?.custom === true && Number(custom.rows[0].allocation.principal) === 100,
      JSON.stringify(custom.rows[0]?.allocation));

    section('reports');
    await page.click('nav button[data-view=reports]');
    await page.waitForSelector('#r-out table');
    const tbText = await page.textContent('#r-out');
    check('the trial balance renders', /Total \(whole book/.test(tbText));
    check('and it balances', !/does not balance/.test(tbText));

    await page.selectOption('#r-which', 'write-offs');
    await page.waitForSelector('#wo-totals');
    check('the written-off loans report lists the write-off with its totals',
      (await page.textContent('#r-out')).includes('member absconded') && /Recoveries received/.test(await page.textContent('#wo-totals')));

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
    // The list screen has a notice of its own, so wait for the rendered
    // return's disclaimer rather than for any notice.
    await page.waitForSelector('.notice:has-text("NOT an official return")', { timeout: 5000 }).catch(() => {});
    check('rendering it warns that it is not an official return',
      /NOT an official return/.test(await page.textContent('main')));
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
    await page.waitForSelector('#p-edit');
    const detailText = await page.textContent('main');
    check('a product opens to its settings, in words',
      /Fixed term/.test(detailText) && /every 1 months/.test(detailText) && /Cap on charges/.test(detailText) && /none set/.test(detailText)
      && /Settlement accounts/.test(detailText));
    await page.click('#p-edit');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=monthlyRate]', '1.25');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /NL01 saved/.test(document.getElementById('toast').textContent));
    await page.waitForFunction(() => /1\.25%/.test(document.querySelector('main').textContent));
    check('a product can be edited from the console', true);
    await page.click('#p-fee');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=code]', 'ADMIN');
    await page.fill('dialog[open] input[name=name]', 'Administration fee');
    await page.selectOption('dialog[open] select[name=feeType]', 'DISBURSEMENT_UPFRONT');
    await page.selectOption('dialog[open] select[name=calculation]', 'PERCENT_OF_AMOUNT');
    await page.fill('dialog[open] input[name=percent]', '1');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Fee ADMIN added/.test(document.getElementById('toast').textContent));
    await page.waitForFunction(() => /Administration fee/.test(document.querySelector('main').textContent));
    check('a fee can be added to a product from the console', true);
    await page.click('#back');
    await page.waitForSelector('#p-new');
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

    section('deposit products and accounting');
    await page.waitForSelector('#d-new');
    check('deposit products are listed under loan products with their accounting',
      /Deposit products/.test(await page.textContent('main')) && /SAV01/.test(await page.textContent('main')) && /CASH/.test(await page.textContent('main')));
    await page.click('#d-new');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=id]', 'UIACC');
    await page.fill('dialog[open] input[name=name]', 'Console accrual savings');
    await page.selectOption('dialog[open] select[name=interestPaidIntoAccount]', 'true');
    await page.fill('dialog[open] input[name=annualRate]', '6');
    await page.selectOption('dialog[open] select[name=accountingMethod]', 'ACCRUAL');
    await page.selectOption('dialog[open] select[name=interestAccruedAccounting]', 'DAILY');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /UIACC created|INVALID/.test(document.getElementById('toast').textContent));
    check('a deposit product on accrual is created, sending only the mappings it uses',
      /UIACC created/.test(await page.textContent('#toast')), await page.textContent('#toast'));
    await page.waitForFunction(() => /UIACC/.test(document.querySelector('main').textContent));
    const depRows = await page.$$('section table tbody tr');
    for (const r of depRows) { if (/UIACC/.test(await r.textContent())) { await r.click(); break; } }
    await page.waitForSelector('#d-method');
    check('it opens to its interest and accounting rules',
      /6% a year/.test(await page.textContent('main')) && /interestPayable 200-110/.test(await page.textContent('main')), await page.textContent('main'));
    await page.click('nav button[data-view=accounting]');
    await page.waitForSelector('#k-new');
    check('the accounting screen shows branches, inter-branch rules and closures',
      /Inter-branch rules/.test(await page.textContent('main')) && /The books are open/.test(await page.textContent('main')));
    await page.click('#b-new');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=code]', 'NKR');
    await page.fill('dialog[open] input[name=name]', 'Nakuru');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Branch NKR added/.test(document.getElementById('toast').textContent));
    check('a branch is added from the console', true);

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
