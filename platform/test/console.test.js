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

// Webhooks sent from the console checks go nowhere reachable; keep their wait short and do not send after requests.
process.env.NOTIFY_TIMEOUT_MS = '1500';
process.env.NOTIFY_AFTER_REQUEST = 'off';

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch {
  console.log('playwright is not installed; skipping the console test');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const { orgDay } = require('./_org');
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

async function openMenu(page, menu, entry = null) {
  if (entry === null) return page.click(`#nav [data-menu="${menu}"]`);
  await page.click(`#nav [data-menu="${menu}"]`);
  await page.click(`#nav [data-entry="${menu}.${entry}"]`);
}
// Each step waits for the page it opened to finish drawing: a page still loading
// when the next is opened would draw over it (the console does not cancel a render).
const settled = (page) => page.waitForFunction(() => !/Loading…/.test(document.getElementById('view').textContent));
const openAdmin = async (page, tab, part = null) => {
  await page.click('#nav [data-entry="right.admin"]');
  await settled(page);
  if (tab) { await page.click(`#subnav [data-tab="${tab}"]`); await settled(page); }
  if (part !== null) { await page.click(`#subnav [data-part="${part}"]`); await settled(page); }
};

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
    // One session clicks through every page inside a couple of minutes; the
    // per-minute limit is tested in the security suite, not here.
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});

    await T((c) => c.query("INSERT INTO branches (code, name) VALUES ('HQ', 'Head office')"));
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

    section('menu definition');
    const md = await page.evaluate(async () => {
      const m = await import('/console/js/menuDef.js');
      const all = () => true, none = () => false;
      return {
        top: m.TOP.map((x) => x.key), tabs: m.ADMIN_TABS.length,
        hidden: m.visibleMenus(none).map((x) => x.key),
        hash: m.hashOf('loans', { state: 'IN_ARREARS' }),
        back: m.parseHash('#loans/IN_ARREARS'), bad: m.parseHash('#nonsense/%%%'), badTab: m.parseHash('#admin/unknown'),
        badValue: m.parseHash('#loans/%%%'), full: m.visibleMenus(all).length,
      };
    });
    check('13 top menus', md.top.length === 13 && md.full === 13, md.top.join());
    check('16 Administration tabs', md.tabs === 16);
    check('a user with no permissions still has the Dashboard', md.hidden.includes('dashboard') && !md.hidden.includes('loanTransactions'), md.hidden.join());
    check('a filter round-trips through the hash', md.hash === '#loans/IN_ARREARS' && md.back.view === 'loans' && md.back.filter.state === 'IN_ARREARS', JSON.stringify(md.back));
    check('a bad hash opens the dashboard', md.bad.view === 'dashboard' && md.badValue.view === 'dashboard', JSON.stringify([md.bad, md.badValue]));
    check('an unknown tab opens the first tab', md.badTab.view === 'admin' && md.badTab.filter.tab === 'general', JSON.stringify(md.badTab));

    section('top bar');
    await page.waitForSelector('#nav [data-menu]');
    check('the bar has the 13 menus and four icons on the right', (await page.$$('#nav [data-menu]')).length === 13
      && (await page.$$('#nav [data-entry^="right."]')).length === 4, String((await page.$$('#nav [data-menu]')).length));
    await page.click('#nav [data-menu="loans"]');
    const loanEntries = await page.$$('#nav [data-dropdown="loans"]:not([hidden]) [role=menuitem]');
    check('Loans opens a dropdown of eight entries, All Loans after a divider', loanEntries.length === 8
      && await page.$eval('#nav [data-entry="loans.all"]', (b) => b.closest('li').classList.contains('divider')), String(loanEntries.length));
    await page.keyboard.press('ArrowDown');
    check('ArrowDown moves focus into the list', await page.evaluate(() => document.activeElement?.dataset.entry === 'loans.partial'));
    await page.keyboard.press('Escape');
    check('Escape closes it', await page.$eval('#nav [data-dropdown="loans"]', (u) => u.hidden));
    await page.click('#nav [data-menu="clients"]');
    await page.click('#nav [data-menu="groups"]');
    check('one dropdown open at a time', (await page.$$('#nav [data-dropdown]:not([hidden])')).length === 1);
    await page.click('#view', { position: { x: 5, y: 5 } });
    check('a click outside closes it', (await page.$$('#nav [data-dropdown]:not([hidden])')).length === 0);
    await openMenu(page, 'clients', 'all');
    await page.waitForSelector('#m-status');
    await openMenu(page, 'loans', 'arrears');
    await page.waitForSelector('#l-status');
    check('the page title names the filter', /Loans: Active in Arrears/.test(await page.textContent('main h1')), await page.textContent('main'));
    check('a dropdown entry opens the page filtered, and the hash names it', await page.evaluate(() => location.hash) === '#loans/IN_ARREARS'
      && await page.$eval('#l-status', (x) => x.value) === 'IN_ARREARS', await page.evaluate(() => location.hash));
    check('the open menu is marked', await page.$eval('#nav [data-menu="loans"]', (b) => b.classList.contains('active')));
    await page.goBack();
    await page.waitForSelector('#m-status');
    check('Back returns to the previous page', await page.evaluate(() => location.hash) === '#members');
    await page.goForward();
    await page.waitForSelector('#l-status');
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#l-status');
    check('a reload resumes the session on the filtered page', await page.$eval('#l-status', (x) => x.value) === 'IN_ARREARS');
    await openMenu(page, 'clients', 'pending');
    await page.waitForSelector('main h1:has-text("Clients: Pending Approval")');
    await openMenu(page, 'groups', 'active');
    await page.waitForSelector('main h1:has-text("Groups: Active")');
    check('Clients and Groups name their state in the title', true);
    const before = jsErrors.length;
    await page.goto(`http://localhost:${PORT}/console/#nonsense/%25%25%25`);
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#dash-tasks, #your-tasks-counts, .dashboard', { timeout: 10000 }).catch(() => {});
    check('a bad hash opens the dashboard without an error', await page.evaluate(() => location.hash) === '#dashboard' && jsErrors.length === before,
      `${await page.evaluate(() => location.hash)} ${jsErrors.slice(before).join(' | ')}`);
    await openMenu(page, 'loans', 'all');
    await page.waitForSelector('#l-status');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#dashboard');
    await page.goBack();
    await new Promise((r) => setTimeout(r, 1000));
    check('Back from the corrected hash leaves it, rather than landing on it again', await page.evaluate(() => location.hash) !== '#dashboard',
      await page.evaluate(() => location.hash));
    await page.goForward();
    await new Promise((r) => setTimeout(r, 500));
    await page.route('**/api/activities?**', () => {});
    await openMenu(page, 'activities');
    await openMenu(page, 'clients', 'all');
    const freed = await page.waitForSelector('#m-status', { timeout: 15000 }).then(() => true, () => false);
    check('a page that never finishes loading does not hold up the next one', freed);
    await page.unroute('**/api/activities?**');
    await page.setViewportSize({ width: 1024, height: 800 });
    check('at 1024 pixels the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      String(await page.evaluate(() => document.documentElement.scrollWidth)));
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMenu(page, 'clients', 'all');

    section('lists from the menus');
    await openMenu(page, 'deposits', 'active');
    await page.waitForSelector('main h1');
    check('Deposits: Active lists the active accounts', /Deposits: Active/.test(await page.textContent('main h1'))
      && (await page.$$('main table tbody tr[data-row]')).length >= 1, await page.textContent('main'));
    await openMenu(page, 'loanTransactions', 'disbursements');
    await page.waitForSelector('main h1:has-text("Loan Transactions: Disbursements")');
    check('Loan Transactions: Disbursements has the 60,000 disbursement', /60,000\.00/.test(await page.textContent('main table')), await page.textContent('main'));
    await openMenu(page, 'depositTransactions', 'deposits');
    await page.waitForSelector('main h1:has-text("Deposit Transactions: Deposits")');
    check('Deposit Transactions: Deposits has the 250,000 deposit', /250,000\.00/.test(await page.textContent('main table')), await page.textContent('main'));
    await openMenu(page, 'activities');
    await page.waitForSelector('main h1:has-text("Activities")');
    await page.waitForSelector('#act-user');
    check('Activities lists activity, with filters for dates, user, entity and branch', (await page.$$('main table tbody tr[data-row]')).length >= 1
      && await page.$('#act-from') && await page.$('#act-entity') && await page.$('#act-branch'));
    await openMenu(page, 'creditArrangements', 'all');
    await page.waitForSelector('main h1:has-text("Credit Arrangements")');
    check('Credit Arrangements: none yet', /No credit arrangements/.test(await page.textContent('main')));
    await openMenu(page, 'accounting', 'accruals');
    await page.waitForSelector('main h1:has-text("Interest Accruals")');
    check('Accounting: Interest Accruals opens', true);
    await openMenu(page, 'accounting', 'trialBalance');
    await page.waitForSelector('#r-which');
    check('Accounting: Trial Balance opens the report', await page.$eval('#r-which', (x) => x.value) === 'trial-balance');
    await openMenu(page, 'products', 'deposit');
    await page.waitForSelector('main h1:has-text("Deposit products")');
    check('Products: Deposit Products shows the deposit products only', !(await page.$('main h1:has-text("Loan products")')));
    await openMenu(page, 'loanTransactions', 'all');
    await page.waitForSelector('main h1:has-text("Loan Transactions")');
    await page.click('main table tbody tr[data-row]');
    await page.waitForSelector('#back');
    check('a transaction row opens its account', /Loan|LN0/.test(await page.textContent('main h1')), await page.textContent('main h1'));
    await openMenu(page, 'clients', 'all');

    section('administration');
    await page.click('#nav [data-entry="right.admin"]');
    await page.waitForSelector('#subnav [data-tab]');
    await page.waitForFunction(() => location.hash === '#admin/general', null, { timeout: 5000 }).catch(() => {});
    check('the cog opens Administration at General Setup, with its 16 tabs', await page.evaluate(() => location.hash) === '#admin/general'
      && (await page.$$('#subnav [data-tab]')).length === 16, await page.evaluate(() => location.hash));
    await openMenu(page, 'administration');
    await page.waitForFunction(() => location.hash === '#admin/general', null, { timeout: 5000 }).catch(() => {});
    check('so does the Administration menu', await page.evaluate(() => location.hash) === '#admin/general', await page.evaluate(() => location.hash));
    check('and the Administration menu is marked', await page.$eval('#nav [data-menu="administration"]', (b) => b.classList.contains('active')));
    await page.waitForSelector('#org-details');
    check('General Setup has the organization details, not the branches', !(await page.$('#org-branches')) && !!(await page.$('#org-channels')));
    for (const tab of await page.$$eval('#subnav [data-tab]', (bs) => bs.map((b) => b.dataset.tab))) {
      await page.click(`#subnav [data-tab="${tab}"]`);
      await page.waitForFunction((t) => location.hash === `#admin/${t}` && !/Loading/.test(document.getElementById('view').textContent), tab);
    }
    check('every tab opens', jsErrors.length === 0, jsErrors.join(' | '));
    await page.click('#subnav [data-tab="organization"]');
    await page.waitForSelector('#org-branches');
    check('Organization has the branches and centres', !(await page.$('#org-details')));
    await page.click('#subnav [data-tab="apps"]');
    await page.waitForSelector('main .notice');
    check('Apps says it is being built', /being built/.test(await page.textContent('main .notice')));
    await page.goto(`http://localhost:${PORT}/console/#admin/fields`);
    await page.waitForSelector('#cf-entity');
    check('#admin/fields opens the Fields tab', await page.$eval('#subnav [data-tab="fields"]', (b) => b.classList.contains('active')));
    await openMenu(page, 'clients', 'all');
    check('leaving Administration hides its tabs', await page.$eval('#subnav', (n) => n.hidden));
    await openAdmin(page, 'data');
    await openMenu(page, 'clients', 'all');
    await settled(page);
    await page.click('#nav [data-entry="right.admin"]');
    await page.click('#subnav [data-tab="access"]');
    await page.waitForSelector('#users-list');
    await new Promise((r) => setTimeout(r, 2500));
    check('a tab chosen while the last one is still loading is the one shown', !!(await page.$('#users-list')) && !(await page.$('#bk-list')));
    await openMenu(page, 'clients', 'all');

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
    await openMenu(page, 'loans', 'all');
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
    await page.evaluate(async (no) => (await import('/console/js/loans.js')).loanDetail({ account_no: no }), appNo);
    await page.waitForSelector('#application-schedule');
    check('an application shows the schedule it would be drawn with', (await page.locator('#application-schedule tbody tr').count()) === 3);
    await page.click('button[data-action=edit-schedule]');
    await page.waitForSelector('dialog#schedule-editor');
    check('the editor opens with a row per installment', (await page.locator('dialog#schedule-editor tbody tr').count()) === 3);
    const soon = orgDay(12);
    await page.fill('dialog#schedule-editor tbody tr:first-child input[name=dueDate]', soon);
    await page.click('dialog#schedule-editor button[value=ok]');
    await page.waitForSelector('#application-schedule h2:has-text("edited")');
    check('saving it keeps the schedule on the application, with a way back to the product\'s',
      await page.locator('button[data-action=product-schedule]').count() === 1);
    await page.evaluate(async (no) => (await import('/console/js/loans.js')).loanDetail({ account_no: no }), runNo);
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

    section('lending controls');
    await openAdmin(page, 'products', 1);
    await page.waitForSelector('#controls-kv');
    check('the controls page shows the tenant\'s controls and each user\'s limits',
      /none/.test(await page.textContent('#locked-roles')) && (await page.locator('[data-limits]').count()) >= 1);
    await page.click('#ctl-edit');
    await page.waitForSelector('dialog[open]');
    await page.selectOption('dialog[open] select[name=lock_MANAGER]', 'true');
    await page.selectOption('dialog[open] select[name=twoManRule]', 'true');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /MANAGER/.test(document.querySelector('#locked-roles')?.textContent || ''));
    const savedCtl = await T((c) => c.query('SELECT locked_posting_roles, two_man_rule FROM lending_controls WHERE id = 1'));
    check('changing them saves them', savedCtl.rows[0].locked_posting_roles.includes('MANAGER') && savedCtl.rows[0].two_man_rule === true,
      JSON.stringify(savedCtl.rows[0]));
    await T((c) => c.query('UPDATE lending_controls SET two_man_rule = false WHERE id = 1'));
    await page.click('[data-limits]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=approvalLimit]', '500000');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /500,000/.test(document.querySelector('main').textContent));
    check('a user\'s approval limit can be set', true);
    await T((c) => c.query("UPDATE platform.users SET approval_limit = NULL, disbursement_limit = NULL WHERE email = 'admin@uitest.local'"));
    await page.click('#ctl-run');
    await page.waitForSelector('#controls-run');
    check('the controls can be run from the page, with what they did', /Locked at the cap/.test(await page.textContent('#controls-run')));

    section('working with loan accounts');
    check('the controls page lists the loans the end of day left out', /every loan runs/.test(await page.textContent('#eod-exclusions')));
    const wl = await T(async (c) => {
      await c.query("INSERT INTO loan_product_fees (product_id, code, name, fee_type, calculation, amount) VALUES ('NL01','VISIT','Field visit','MANUAL','FLAT',50) ON CONFLICT DO NOTHING");
      const ms = (await c.query("SELECT id, member_no FROM members WHERE member_no IN ('M0004','M0005') ORDER BY member_no")).rows;
      const out = [];
      for (const m of ms) {
        const sav = await S.open(c, { memberId: m.id });
        await S.deposit(c, sav.id, { amount: 50000, channelId: 'cash', createdBy: 'test' });
        const l = await L.apply(c, { memberId: m.id, productId: 'NL01', principal: 12000, termMonths: 3, createdBy: 'test' });
        await L.changeState(c, l.id, 'APPROVE', { createdBy: 'test' });
        await L.disburse(c, l.id, { amount: 12000, channelId: 'bank', valueDate: orgDay(-40), createdBy: 'test' });
        out.push({ id: l.id, no: l.account_no, memberNo: m.member_no });
      }
      return out;
    });
    await page.evaluate(async (no) => (await import('/console/js/loans.js')).loanDetail({ account_no: no }), wl[0].no);
    await page.waitForSelector('#breakdown');
    check('a running loan shows its balances due and paid', (await page.locator('#breakdown tbody tr').count()) === 4);
    await page.click('button[data-action=fee]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=fee]', 'VISIT');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('[data-adjust-fee]');
    await page.click('[data-adjust-fee]');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=reason]', 'applied by mistake');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /ADJUSTED/.test(document.querySelector('main').textContent));
    check('a fee applied by mistake is adjusted from its row', true);
    await page.click('button[data-action=attach]');
    await page.waitForSelector('dialog[open]');
    await page.setInputFiles('dialog[open] input[name=file]', { name: 'agreement.txt', mimeType: 'text/plain', buffer: Buffer.from('signed agreement') });
    await page.fill('dialog[open] input[name=title]', 'Loan agreement');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#attachments [data-download]');
    check('a document is attached and listed with preview, download, edit and delete',
      (await page.textContent('#attachments')).includes('Loan agreement') && await page.locator('#attachments [data-preview]').count() === 1);
    await page.click('button[data-action=terminate]');
    await page.waitForSelector('dialog[open]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#terminated');
    check('terminating shows the loan as terminated, with undo in place of terminate',
      await page.locator('button[data-action=undo-terminate]').count() === 1 && await page.locator('button[data-action=terminate]').count() === 0);
    await page.click('button[data-action=undo-terminate]');
    await page.waitForSelector('button[data-action=terminate]');
    check('and undo puts it back', await page.locator('#terminated').count() === 0);
    await page.click('button[data-action=lock]');
    await page.waitForSelector('dialog[open] select[name=interest]');
    await page.selectOption('dialog[open] select[name=interest]', 'false');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#lock-suspends');
    check('a lock asks what it suspends and the loan says so', /interest still running/.test(await page.textContent('#lock-suspends')), await page.textContent('#lock-suspends'));
    await page.click('button[data-action=unlock]');
    await page.waitForSelector('dialog[open] input[name=valueDate]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('button[data-action=lock]');
    check('and unlocking lifts it', await page.locator('#lock-suspends').count() === 0);
    const payOff = async (fill) => {
      await page.click('button[data-action=pay-off]');
      await page.waitForSelector('dialog[open] input[name=valueDate]');
      await page.click('dialog[open] button[value=ok]');
      await page.waitForSelector('dialog[open] input[name=interest]');
      const text = await page.textContent('dialog[open]');
      if (fill) await page.fill('dialog[open] input[name=interest]', '0');
      await page.click('dialog[open] button[value=ok]');
      await page.waitForSelector('main h1 .badge:text("CLOSED_REPAID")');
      return text;
    };
    const payOffText = await payOff(true);
    check('paying off asks what is collected of each charge and closes the loan', /is paid in full/.test(payOffText) && /written off/.test(payOffText), payOffText.slice(0, 120));
    await page.click('button[data-action=undo-close]');
    await page.waitForSelector('dialog[open] input[name=valueDate]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('button[data-action=pay-off]');
    check('a closure can be undone from the page', await page.locator('main h1 .badge:text("CLOSED_REPAID")').count() === 0);
    await payOff(false);
    const mid = await T(async (c) => (await c.query('SELECT * FROM members WHERE member_no = $1', [wl[0].memberNo])).rows[0]);
    await page.evaluate(async (m) => (await import('/console/js/members.js')).memberDetail(m), mid);
    await page.waitForSelector('#loan-history');
    check('the member shows their loan history and completed loan cycles', (await page.textContent('#cycles')).trim() === '1', await page.textContent('#cycles'));
    check('and their identification documents', await page.locator('#identifications').count() === 1);
    await T(async (c) => {
      const CF = require('../src/domain/customFields');
      await CF.createSet(c, { entity: 'MEMBER', name: 'Profile', id: '_profile' }, { createdBy: 'test' });
      await CF.createDefinition(c, { entity: 'MEMBER', setId: '_profile', id: 'occupation', name: 'Occupation', type: 'FREE_TEXT' }, { createdBy: 'test' });
    });
    await page.evaluate(async (m) => (await import('/console/js/members.js')).memberDetail(m), mid);
    await page.waitForSelector('#cf-edit');
    await page.click('#cf-edit');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name="_profile|occupation"]', 'Boda rider');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Boda rider/.test(document.querySelector('#custom-fields')?.textContent || ''));
    check('custom fields are shown and edited on the member', true);

    section('members and groups');
    await openMenu(page, 'clients', 'all');
    await page.waitForSelector('#m-new');
    check('the state filter has the reference platform\'s six states', await page.locator('#m-status option').count() === 7);
    await page.click('#m-new');
    await page.waitForSelector('dialog[open] input[name=firstName]');
    await page.fill('dialog[open] input[name=firstName]', 'Wanjiku');
    await page.fill('dialog[open] input[name=lastName]', 'Console');
    await page.fill('dialog[open] input[name=dateOfBirth]', '1994-04-04');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Wanjiku Console/.test(document.querySelector('main h1')?.textContent || ''));
    check('a member is created from the full form and opens', await page.locator('#member-actions #m-edit').count() === 1);
    const newNo = (await page.textContent('main h1 .badge')).trim();
    await page.click('[data-state-action=BLACKLIST]');
    await page.waitForSelector('dialog[open] textarea[name=reason]');
    await page.fill('dialog[open] textarea[name=reason]', 'Console check');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('main h1 [data-state=BLACKLISTED]');
    check('a state action blacklists it, and its details are no longer editable', await page.locator('#member-actions #m-edit').count() === 0);
    await page.click('[data-state-action=UNDO_BLACKLIST]');
    await page.waitForSelector('dialog[open]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('main h1 [data-state=INACTIVE]');
    check('and undoing it brings it back', true);
    await page.click('#m-history');
    await page.waitForSelector('dialog[open] table');
    check('the state history lists the changes', /UNDO_BLACKLIST/.test(await page.textContent('dialog[open]')));
    await page.click('dialog[open] #dlg-close');
    await openMenu(page, 'groups', 'all');
    await page.waitForSelector('#g-new');
    await page.click('#g-new');
    await page.waitForSelector('dialog[open] input[name=groupName]');
    await page.fill('dialog[open] input[name=groupName]', 'Console Chama');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#group-members');
    check('a group is created from the Groups page', /Console Chama/.test(await page.textContent('main h1')));
    await page.click('#gm-add');
    await page.waitForSelector('dialog[open] input[name=memberId]');
    await page.fill('dialog[open] input[name=memberId]', newNo);
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction((no) => (document.querySelector('#group-members')?.textContent || '').includes(no), newNo);
    check('and a member is added to it', true);
    await page.waitForSelector('#solidarity-loans');
    check('the group page lists its solidarity loans', /No solidarity loans/.test(await page.textContent('#solidarity-loans')));
    await openAdmin(page, 'clients');
    await page.waitForSelector('#client-controls');
    check('the organization page has the client and group types, role names and client controls',
      /new members start/i.test(await page.textContent('#org-clients')) && /Client/.test(await page.textContent('#org-clients')));
    await openAdmin(page, 'organization');
    await page.waitForSelector('[data-branch-open]');
    await page.click('[data-branch-open]');
    await page.waitForSelector('#branch-detail');
    check('a branch opens on its own page (with its report templates, when there are any)', /Running loans/.test(await page.textContent('#branch-detail')));
    await page.evaluate(async (m) => (await import('/console/js/members.js')).memberDetail(m), mid);
    await page.waitForSelector('#member-media');
    check('the member page has the picture and signature card', true);
    if (await page.$('tr[data-tbl="dep"]')) {
      await page.click('tr[data-tbl="dep"]');
      await page.waitForSelector('#deposit-detail');
      check('a deposit account opens on its own page', /Balance/.test(await page.textContent('#deposit-detail')));
      check('with its terms: the type, the interest rate and its limits', /savings account/.test(await page.textContent('#deposit-terms'))
        && /Interest rate/.test(await page.textContent('#deposit-terms')) && await page.locator('#dep-rate').count() === 1);
      check('and its blocks and holds, with the actions an administrator may take', /No blocks or holds/.test(await page.textContent('#deposit-blocks'))
        && await page.locator('#dep-block').count() === 1 && await page.locator('#dep-hold').count() === 1);
      check('and its state, with the actions it may take', /active/.test(await page.textContent('#deposit-state'))
        && await page.locator('#dep-act-LOCK').count() === 1 && await page.locator('#dep-act-UNLOCK').count() === 0);
    } else check('the member has a deposit account to open', false);
    await page.evaluate(async (m) => (await import('/console/js/members.js')).memberDetail(m), mid);
    await page.waitForSelector('#credit-arrangements #ca-new');
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('activity-list')?.textContent || 'Loading'));
    check('a member\'s page lists its activity', /savings account|member created|loan/i.test(await page.textContent('#activity-list')), await page.textContent('#activity-list'));
    await page.click('#ca-new');
    await page.waitForSelector('dialog[open] input[name=amount]');
    await page.fill('dialog[open] input[name=amount]', '25000');
    await page.fill('dialog[open] input[name=expireDate]', '2030-12-31');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#credit-arrangements tr[data-tbl="ca"]');
    check('a credit arrangement is created from the member page', /PENDING_APPROVAL/.test(await page.textContent('#credit-arrangements')));
    await page.click('#credit-arrangements tr[data-tbl="ca"]');
    await page.waitForSelector('#credit-arrangement');
    await page.click('[data-ca-action=APPROVE]');
    await page.waitForSelector('dialog[open]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('main h1 [data-state=APPROVED]');
    check('and opens on its own page, where it is approved', /25,000|25000/.test(await page.textContent('#credit-arrangement')) && await page.locator('#ca-add').count() === 1);
    await openAdmin(page, 'general');
    await page.waitForSelector('#org-details');
    check('the organization page shows its details, end of day, channels and holidays',
      await page.locator('#org-channels table').count() === 1 && /AUTOMATIC/.test(await page.textContent('#eod-mode')));
    await page.click('#holiday-add');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=description]', 'Mashujaa Day');
    await page.fill('dialog[open] input[name=date]', '2026-10-20');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Mashujaa Day/.test(document.querySelector('#org-holidays')?.textContent || ''));

    section('administration: fields');
    await openAdmin(page, 'fields');
    await page.waitForSelector('#cf-entity');
    await page.selectOption('#cf-entity', 'LOAN_ACCOUNT');
    await page.waitForSelector('#cf-item');
    await page.click('#cf-set-add');
    await page.waitForSelector('dialog[open] input[name=name]');
    await page.fill('dialog[open] input[name=name]', 'Collateral');
    await page.selectOption('dialog[open] select[name=type]', 'GROUPED');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('[data-cf-def-add="_collateral"]');
    check('a set is created for loan accounts', /Collateral/.test(await page.textContent('#org-cf')) && /grouped/.test(await page.textContent('#org-cf')));
    const addField = async (name, type, perItem) => {
      await page.click('[data-cf-def-add="_collateral"]');
      await page.waitForSelector('dialog[open] input[name=name]');
      await page.fill('dialog[open] input[name=name]', name);
      await page.selectOption('dialog[open] select[name=type]', type);
      if (perItem) {
        await page.uncheck('dialog[open] input[name=availableForAll]');
        await page.selectOption('dialog[open] select[name^="item|"] >> nth=0', 'REQUIRED');
      }
      await page.click('dialog[open] button[value=ok]');
      await page.waitForFunction((n) => (document.querySelector('#org-cf')?.textContent || '').includes(n), name);
    };
    await addField('Asset', 'FREE_TEXT', true);
    await addField('Value', 'NUMBER', false);
    check('a field is created with usage per loan product', /: required/.test(await page.textContent('#org-cf')), await page.textContent('#org-cf'));
    await page.click('[data-cf-def-up="value"]');
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#org-cf tbody tr')].map((r) => r.textContent);
      return rows.findIndex((t) => t.includes('Value')) < rows.findIndex((t) => t.includes('Asset'));
    });
    check('and fields are rearranged', true);
    await page.click('[data-cf-def-active="asset"]');
    await page.waitForFunction(() => ![...document.querySelectorAll('#org-cf tbody tr')].some((r) => /Asset/.test(r.textContent)));
    await page.check('#cf-disabled');
    await page.waitForFunction(() => /Asset \(disabled\)/.test(document.querySelector('#org-cf')?.textContent || ''));
    check('a deactivated field shows with Show disabled fields', true);
    await page.click('[data-cf-def-edit="value"]');
    await page.waitForSelector('dialog[open] input[name=editRoles]');
    await page.fill('dialog[open] input[name=editRoles]', 'MANAGER');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /MANAGER/.test(document.querySelector('#org-cf')?.textContent || ''));
    check('a field\'s rights are edited in its form', true);
    await T(async (c) => {
      const CF = require('../src/domain/customFields');
      await CF.createSet(c, { entity: 'MEMBER', name: 'Next of kin', id: '_kin', type: 'GROUPED' }, { createdBy: 'test' });
      await CF.createDefinition(c, { entity: 'MEMBER', setId: '_kin', id: 'kinName', name: 'Name', type: 'FREE_TEXT' }, { createdBy: 'test' });
    });
    await page.evaluate(async (m) => (await import('/console/js/members.js')).memberDetail(m), mid);
    await page.waitForSelector('[data-cf-rows="_kin"]');
    await page.click('[data-cf-rows="_kin"]');
    await page.waitForSelector('dialog[open] [data-add]');
    await page.click('dialog[open] [data-add]');
    await page.fill('dialog[open] input[data-f=kinName]', 'Wairimu');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Wairimu/.test(document.querySelector('#custom-fields')?.textContent || ''));
    check('a grouped set is edited as rows on the record', true);
    await openAdmin(page, 'general');
    await page.waitForSelector('#org-details');
    check('a holiday is added from the page, and the calendar shows it needs a sync', await page.locator('#calendar-pending').count() === 1);
    await openMenu(page, 'loans', 'all');
    await page.waitForSelector('#collection-sheet');
    await page.click('#collection-sheet');
    await page.waitForSelector('#c-view');
    await page.selectOption('#c-view', 'ACCOUNTS');
    await page.waitForSelector('#c-asof');
    await page.waitForTimeout(200);
    const sheetRows = await page.locator('#collection-rows tbody tr').count();
    check('the collection sheet lists what is due by account', sheetRows >= 1, String(sheetRows));
    await page.click('#c-post');
    await page.waitForSelector('dialog[open]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#batch-result');
    check('posting the selected rows posts a batch and reports it', /Batch posted/.test(await page.textContent('#batch-result')), await page.textContent('#batch-result'));

    section('reports');
    await openMenu(page, 'reporting', 'reports');
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

    await page.selectOption('#r-which', 'risk');
    await page.waitForSelector('#r-out h2');
    check('the risk report groups loans in arrears and shows each risk level', /By risk level/.test(await page.textContent('#r-out')));
    await page.selectOption('#r-which', 'indicators');
    await page.waitForSelector('[data-indicator=GROSS_LOAN_PORTFOLIO]');
    check('indicators render by group', /Outreach/.test(await page.textContent('#r-out')) && (await page.textContent('[data-indicator=ACTIVE_BORROWERS]')).trim() !== '');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#r-xlsx')]);
    check('a report downloads as a workbook', /indicators\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());

    section('dashboard');
    await openMenu(page, 'dashboard');
    await page.waitForSelector('text=Upcoming repayments');
    const dash = await page.textContent('main');
    check('the dashboard shows indicators, upcoming repayments, favourite views and the latest activity',
      /Indicators/.test(dash) && /Upcoming repayments/.test(dash) && /favourite views/.test(dash) && /Latest activity/.test(dash));
    await page.click('#dash-activity-types');
    await page.waitForSelector('dialog[open] #activity-types input');
    await page.check('dialog[open] #activity-types input >> nth=0');
    await page.evaluate(() => document.getElementById('latest-activity').setAttribute('data-stale', '1'));
    await page.click('#activity-types-save');
    await page.waitForSelector('#latest-activity:not([data-stale])');
    check('the latest activity\'s types are chosen from the dashboard', true);
    await page.click('#dash-activity-types');
    await page.waitForSelector('dialog[open] #activity-types input');
    await page.uncheck('dialog[open] #activity-types input >> nth=0');
    await page.evaluate(() => document.getElementById('latest-activity').setAttribute('data-stale', '1'));
    await page.click('#activity-types-save');
    await page.waitForSelector('#latest-activity:not([data-stale])');

    section('views');
    await openMenu(page, 'reporting', 'views');
    await page.click('#v-new');
    await page.waitForSelector('#v-form');
    await page.selectOption('#v-form select[name=entity]', 'LOANS');
    await page.waitForSelector('#v-form select[name=columns] option[value=daysLate]');
    await page.fill('#v-form input[name=name]', 'Console loans');
    await page.check('#v-form input[name=includeTotals]');
    await page.click('#v-form button[type=submit]');
    await page.waitForSelector('#v-out table');
    check('a view is made in the console and runs, with totals', (await page.textContent('main h1')) === 'Console loans' && /Total/.test(await page.textContent('#v-out')),
      `${await page.textContent('main h1')} | ${(await page.textContent('#v-out')).slice(0, 200)}`);
    await page.click('#v-back');
    await page.waitForSelector('[data-v-fav]');
    await page.click('[data-v-fav]');
    await page.waitForSelector('[data-v-fav][data-on=""]');
    await openMenu(page, 'dashboard');
    await page.waitForSelector('#fav-views');
    check('marked a favourite, it is on the dashboard', /Console loans/.test(await page.textContent('#fav-views')));

    section('menu items, tasks and report templates');
    await page.waitForSelector('#menu-nav button[data-menu-item]');
    check('the menu items show as a second navigation row', (await page.$$('#menu-nav button[data-menu-item]')).length >= 6);
    await page.click('#menu-nav button:has-text("Loans")');
    await page.waitForSelector('main h1:has-text("Loans")');
    check('a menu item lists the views filed under it', /Console loans/.test(await page.textContent('main')), (await page.textContent('main')).slice(0, 200));
    await openMenu(page, 'reporting', 'views');
    await page.waitForSelector('#mi-new');
    await page.click('#mi-new');
    await page.fill('dialog[open] input[name=name]', 'Collections desk');
    await page.selectOption('dialog[open] select[name=type]', 'LOANS');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#menu-nav button:has-text("Collections desk")');
    check('a new menu item is added to the navigation', true);
    await page.click('#nav [data-entry="right.tasks"]');
    await page.waitForSelector('#task-new');
    await page.click('#task-new');
    await page.fill('dialog[open] input[name=title]', 'Call the guarantor');
    await page.fill('dialog[open] input[name=memberId]', 'M0001');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Call the guarantor/.test(document.getElementById('task-list')?.textContent || ''));
    check('a task is made on the Tasks page', true);
    await openMenu(page, 'dashboard');
    await page.waitForSelector('#your-tasks-counts');
    check('the Your Tasks widget counts it as due today', /1 due today/.test(await page.textContent('#your-tasks-counts')), await page.textContent('#your-tasks-counts'));
    await page.click('#your-tasks [data-act=complete]');
    await page.waitForFunction(() => /0 due today/.test(document.getElementById('your-tasks-counts')?.textContent || ''));
    check('and completing it there takes it off', true);
    check('the Tellers widget is on an administrator\'s dashboard', !!(await page.$('#tellers')));
    await openMenu(page, 'reporting', 'reports');
    await page.selectOption('#r-which', 'templates');
    await page.waitForSelector('#rt-list');
    check('Other reports lists the report templates', /No report templates yet|run/.test(await page.textContent('#r-out')));

    section('period and provisions');
    await openMenu(page, 'accounting', 'periods');
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
    await openMenu(page, 'reporting', 'returns');
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
    await openMenu(page, 'products', 'loan');
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
    await openMenu(page, 'products', 'deposit');
    await page.waitForSelector('#d-new');
    check('deposit products are listed, with their accounting',
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
    check('and its type, account numbers and limits', /savings account/.test(await page.textContent('#deposit-product-type'))
      && /the shared SA series/.test(await page.textContent('#deposit-product-type')) && await page.locator('#d-delete').count() === 1);
    check('and the state its new accounts start in', /New accounts start/.test(await page.textContent('#deposit-product-type'))
      && /active/.test(await page.textContent('#deposit-product-type')));
    await openMenu(page, 'accounting', 'branches');
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

    section('chart of accounts and journal entries');
    await openMenu(page, 'accounting', 'chart');
    await page.waitForSelector('#coa-table');
    check('the chart of accounts lists the accounts with their balances', /100-200/.test(await page.textContent('#coa-table')) && /Manual entries/.test(await page.textContent('#coa-table')));
    await page.click('#coa-new');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=glCode]', '580-100');
    await page.fill('dialog[open] input[name=name]', 'Printing and stationery');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /580-100 saved/.test(document.getElementById('toast').textContent));
    await page.waitForFunction(() => /Printing and stationery/.test(document.getElementById('coa-table')?.textContent || ''));
    check('an account is added from the console', true);
    await openMenu(page, 'accounting', 'journal');
    await page.waitForSelector('#je-new');
    await page.click('#je-new');
    await page.waitForSelector('dialog[open] textarea[name=debits]');
    await page.fill('dialog[open] textarea[name=debits]', '580-100, 1500');
    await page.fill('dialog[open] textarea[name=credits]', '100-200, 1500');
    await page.fill('dialog[open] input[name=notes]', 'Printer paper');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Journal entry MJ-\d+ logged/.test(document.getElementById('toast').textContent));
    await page.waitForFunction(() => /Printer paper/.test(document.getElementById('je-table')?.textContent || ''));
    check('a manual journal entry is logged from the console and listed', true);
    await page.click('#je-table tr.clickable');
    await page.waitForSelector('dialog[open] #je-reverse');
    check('its entry opens with its lines, files and a reverse button', /580-100/.test(await page.textContent('dialog[open]')) && /No files/.test(await page.textContent('dialog[open]')));
    await page.click('dialog[open] #dlg-close');

    section('data: dictionary, import, backup');
    await openAdmin(page, 'data');
    await page.waitForSelector('#dd-table');
    await page.selectOption('#dd-table', 'loan_installments');
    await page.waitForFunction(() => /late_fee_exempt/.test(document.getElementById('dd-cols')?.textContent || ''));
    check('the data dictionary shows a table\'s columns with what they mean', /repayment schedules/i.test(await page.textContent('#dd-desc')), await page.textContent('#dd-desc'));
    const XLSX = require('../src/lib/xlsx');
    const book = XLSX.write([
      { name: 'Settings', rows: [['Setting', 'Value'], ['Migration date', orgDay(0)]] },
      { name: 'Members', rows: [['Member number*', 'First name*', 'Last name*'], ['UIIMP1', 'Imported', 'Member']] },
    ]);
    await page.setInputFiles('#imp-file', { name: 'ui-import.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: book });
    await page.click('#imp-upload');
    await page.waitForSelector('#import-review');
    check('an uploaded workbook is checked in the background and opens for review as a Draft', /Draft \(pending approval\)/.test(await page.textContent('#import-review')), await page.textContent('#import-review'));
    await page.waitForFunction(() => /UIIMP1/.test(document.getElementById('imp-preview')?.textContent || ''));
    check('with a preview of the records it will create', /Imported Member/.test(await page.textContent('#imp-preview')), await page.textContent('#imp-preview'));
    check('and the list shows it as a Draft', /Draft \(pending approval\)/.test(await page.textContent('#imp-list')));
    await page.click('#import-review button[data-act=approve]');
    await page.waitForSelector('dialog[open] input[name=note]');
    await page.fill('dialog[open] input[name=note]', 'console check');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Imported|failed/.test(document.getElementById('toast').textContent));
    const imported = await T((c) => c.query("SELECT count(*)::int AS n FROM members WHERE member_no = 'UIIMP1'"));
    check('approving it from the console creates the member', imported.rows[0].n === 1, await page.textContent('#toast'));
    await page.waitForSelector('#bk-run');
    await page.click('#bk-run');
    await page.waitForFunction(() => /Backup started/.test(document.getElementById('toast').textContent));
    for (let i = 0; i < 40; i += 1) {
      const b = await T((c) => c.query("SELECT status FROM database_backups ORDER BY created_at DESC LIMIT 1"));
      if (b.rows[0]?.status !== 'IN_PROGRESS') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await openMenu(page, 'clients', 'all');
    await openAdmin(page, 'data');
    await page.waitForSelector('#bk-list');
    check('a backup is taken from the console and listed with a download', /COMPLETE/.test(await page.textContent('#bk-list')) && !!(await page.$('#bk-list button[data-bk]')));

    section('users');
    await openAdmin(page, 'access', 0);
    await page.waitForSelector('#user-add');
    check('the users page lists the tenant\'s staff', /admin@uitest.local/.test(await page.textContent('#users-list')));
    check('and the roles with their permissions', /LOAN|TELLER/.test(await page.textContent('#roles-list')) && /AUDITOR/.test(await page.textContent('#roles-list')));
    await page.click('#user-add');
    await page.waitForSelector('dialog[open] input[name=email]');
    await page.fill('dialog[open] input[name=email]', 'new.teller@uitest.local');
    await page.selectOption('dialog[open] select[name=role]', 'TELLER');
    await page.selectOption('dialog[open] select[name=branchId]', 'HQ');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('dialog[open] input[name=p]');
    const tempPw = await page.inputValue('dialog[open] input[name=p]');
    check('a new user is created and the temporary password is shown once', /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(tempPw), tempPw);
    await page.click('dialog[open] button[value=cancel]');
    await page.waitForFunction(() => /new.teller@uitest.local/.test(document.getElementById('users-list')?.textContent || ''));
    await page.click('#nav [data-entry="right.tills"]');
    await page.waitForSelector('#till-open');
    await page.click('#till-open');
    await page.waitForSelector('dialog[open] select[name=tellerEmail]');
    await page.selectOption('dialog[open] select[name=tellerEmail]', 'new.teller@uitest.local');
    await page.fill('dialog[open] input[name=openingAmount]', '5000');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /new.teller@uitest.local/.test(document.getElementById('till-list')?.textContent || ''));
    check('a supervisor opens a till for the new teller', /5,000\.00/.test(await page.textContent('#till-list')), await page.textContent('#till-list'));
    section('webhooks');
    await openAdmin(page, 'webhooks', 0);
    await page.waitForSelector('#wh-new');
    await page.click('#wh-new');
    await page.waitForSelector('#wh-name');
    await page.fill('#wh-name', 'Deposits to the bank');
    await page.selectOption('#wh-event', 'SAVINGS:SAVINGS_DEPOSIT');
    await page.fill('#wh-url', 'https://example.org/hooks/deposits');
    await page.fill('#wh-body', '{"client": "');
    await page.click('#wh-placeholders [data-ph="CLIENT_NAME"]');
    await page.type('#wh-body', '", "amount": {{TRANSACTION_AMOUNT}}}');
    check('the placeholder picker writes into the body', /\{\{CLIENT_NAME\}\}/.test(await page.inputValue('#wh-body')), await page.inputValue('#wh-body'));
    await page.click('#wh-save');
    await page.waitForSelector('#wh-secret');
    check('saved: the signing secret is shown once', /^[0-9a-f]{64}$/.test((await page.textContent('#wh-secret')).trim()));
    await page.click('#dlg-close');
    await page.waitForSelector('#wh-list');
    check('the webhook is listed', /Deposits to the bank/.test(await page.textContent('#wh-list')) && /SAVINGS_DEPOSIT/.test(await page.textContent('#wh-list')));
    await page.click('#wh-list tr[data-row]');
    await page.waitForSelector('#wh-test');
    await page.click('#wh-test');
    await page.waitForSelector('#wh-test-result', { timeout: 15000 });
    check('a test is sent and its outcome shown', /SENT|FAILED/.test(await page.textContent('#wh-test-result')), await page.textContent('#wh-test-result'));
    await openAdmin(page, 'webhooks', 0);
    await page.waitForSelector('#wh-switch');
    await page.click('#wh-switch');
    await page.waitForFunction(() => /off/i.test(document.getElementById('wh-state')?.textContent || ''));
    check('webhooks are switched off from the page', true);
    await page.click('#wh-switch');
    await page.waitForFunction(() => /on/i.test(document.getElementById('wh-state')?.textContent || ''));
    await openAdmin(page, 'webhooks', 1);
    await page.waitForSelector('#msg-list tr[data-row]');
    check('the communication log lists the test message', /SAVINGS_DEPOSIT/.test(await page.textContent('#msg-list')));
    await page.click('#msg-list tr[data-row]');
    await page.waitForSelector('dialog[open] #msg-body');
    check('a message opens with its body', /amount/.test(await page.textContent('dialog[open] #msg-body')));
    await page.click('#dlg-close');

    section('events streaming');
    await openAdmin(page, 'events', 0);
    await page.waitForSelector('#es-new');
    check('the streaming templates do not list the webhooks', !/Deposits to the bank/.test(await page.textContent('#es-list')), await page.textContent('#es-list'));
    await page.click('#es-new');
    await page.waitForSelector('#es-name');
    check('a streaming template has no URL or signing', !(await page.$('#es-url')) && !(await page.$('#wh-sign')));
    await page.fill('#es-name', 'Deposits Feed');
    await page.selectOption('#es-event', 'SAVINGS:SAVINGS_DEPOSIT');
    await page.fill('#es-body', '{"amount": ');
    await page.click('#es-placeholders [data-ph="TRANSACTION_AMOUNT"]');
    await page.type('#es-body', '}');
    await page.click('#es-save');
    await page.waitForFunction(() => /Deposits Feed/.test(document.getElementById('es-list')?.textContent || ''));
    check('the streaming template is listed with its topic', /sacco\.event\.uitest\.streamingapi\.deposits_feed/.test(await page.textContent('#es-list')), await page.textContent('#es-list'));
    await withTenant(SCHEMA, (c) => require('../src/domain/streaming').create(c, { owning_application: 'warehouse', event_types: ['sacco.event.uitest.streamingapi.deposits_feed'], read_from: 'begin' }, { actor: 'test' }));
    await openAdmin(page, 'events', 1);
    await page.waitForFunction(() => /warehouse/.test(document.getElementById('es-subs')?.textContent || ''));
    const subsText = await page.textContent('#es-subs');
    check('the subscriptions are listed with their topics, unconsumed events and stream state', /warehouse/.test(subsText) && /deposits_feed/.test(subsText) && /no stream/.test(subsText), subsText);
    await openAdmin(page, 'webhooks', 0);
    await page.waitForSelector('#wh-list');
    check('the webhooks list leaves out streaming templates', !/Deposits Feed/.test(await page.textContent('#wh-list')));

    section('email');
    await openAdmin(page, 'email', 1);
    await page.waitForSelector('#em-settings');
    check('the email settings start switched off', /off/i.test(await page.textContent('#em-state')));
    await page.fill('#em-fromName', 'UI SACCO');
    await page.fill('#em-fromEmail', 'noreply@ui-sacco.test');
    await page.fill('#em-host', 'localhost');
    await page.fill('#em-port', '587');
    await page.selectOption('#em-encryption', 'STARTTLS');
    await page.fill('#em-username', 'mailer');
    await page.fill('#em-password', 'smtp password 2026');
    await page.click('#em-save');
    await page.waitForFunction(() => /set/.test(document.getElementById('em-password')?.placeholder || ''));
    check('the settings are saved; the password field stays empty', (await page.inputValue('#em-password')) === '' && (await page.inputValue('#em-host')) === 'localhost');
    await page.fill('#em-test-to', 'admin@ui-sacco.test');
    await page.click('#em-test');
    await page.waitForSelector('#em-test-result');
    check('a test shows its outcome (a private host is refused)', /MUST_BE_PUBLIC|MESSAGING_EXCEPTION/.test(await page.textContent('#em-test-result')), await page.textContent('#em-test-result'));
    await page.click('#em-switch');
    await page.waitForFunction(() => /on/i.test(document.getElementById('em-state')?.textContent || ''));
    check('email is switched on from the page', true);
    await openAdmin(page, 'email', 0);
    await page.waitForSelector('#em-new');
    await page.click('#em-new');
    await page.waitForSelector('#em-name');
    await page.fill('#em-name', 'Deposit receipt');
    await page.selectOption('#em-event', 'SAVINGS:SAVINGS_DEPOSIT');
    await page.fill('#em-subject', 'Deposit received');
    await page.fill('#em-body', '<p>Dear ');
    await page.click('#em-placeholders [data-ph="FIRST_NAME"]');
    await page.type('#em-body', ',</p><script>alert(1)</script>');
    await page.click('#em-preview-btn');
    await page.waitForSelector('#em-preview');
    const sandbox = await page.getAttribute('#em-preview', 'sandbox');
    const srcdoc = await page.getAttribute('#em-preview', 'srcdoc');
    check('the preview is a sandboxed frame, filled with sample values', sandbox === '' && /Dear Jane/.test(srcdoc), `${sandbox} ${srcdoc}`);
    await page.click('#em-save-tpl');
    await page.waitForFunction(() => /Deposit receipt/.test(document.getElementById('em-list')?.textContent || ''));
    check('the email template is listed with its subject and recipient', /Deposit received/.test(await page.textContent('#em-list')) && /client/i.test(await page.textContent('#em-list')));
    await T((c) => c.query("UPDATE members SET email = 'member@ui-sacco.test' WHERE id = $1", [mid.id]));
    await page.evaluate(async (m) => (await import('/console/js/members.js')).memberDetail(m), mid);
    await page.waitForSelector('#member-subs');
    await page.waitForFunction(() => /Deposit receipt/.test(document.getElementById('member-subs')?.textContent || ''));
    check('the member page lists the email subscriptions', /subscribed/i.test(await page.textContent('#member-subs')));
    await page.click('#member-subs [data-sub-toggle]');
    await page.waitForFunction(() => /not subscribed/i.test(document.getElementById('member-subs')?.textContent || ''));
    check('staff unsubscribe the member from the page', true);
    await page.click('#member-actions #m-email');
    await page.waitForSelector('dialog[open] #em-send-subject');
    await page.fill('dialog[open] #em-send-subject', 'Hello');
    await page.fill('dialog[open] #em-send-body', '<p>Hello {{FIRST_NAME}}</p>');
    await page.click('dialog[open] #em-send-go');
    await page.waitForSelector('#em-send-result');
    check('Send email from the member page: the message and its outcome', /EMAIL/.test(await page.textContent('#em-send-result')) || /FAILED|SENT|QUEUED/.test(await page.textContent('#em-send-result')), await page.textContent('#em-send-result'));
    await page.click('#dlg-close');
    await openAdmin(page, 'webhooks', 1);
    await page.waitForSelector('#msg-type');
    await page.selectOption('#msg-type', 'EMAIL');
    // Filtered: every row is an email (the type column), and the manual one shows its subject.
    await page.waitForFunction(() => { const t = document.getElementById('msg-list')?.textContent || ''; return /Hello/.test(t) && !/webhook/.test(t); });
    check('the communication log filters by type and shows the email\'s subject', !/https:/.test(await page.textContent('#msg-list')));

    section('sms');
    await openAdmin(page, 'sms', 1);
    await page.waitForSelector('#sms-settings');
    check('the SMS settings start switched off', /off/i.test(await page.textContent('#sms-state')));
    await page.selectOption('#sms-provider', 'HTTP');
    await page.waitForSelector('#sms-f-url');
    await page.fill('#sms-senderId', 'UISACCO');
    await page.fill('#sms-f-url', 'https://sms-gateway.example.org/send');
    await page.fill('#sms-f-apiKey', 'gateway key 2026');
    await page.click('#sms-save');
    await page.waitForFunction(() => /set/.test(document.getElementById('sms-f-apiKey')?.placeholder || ''));
    check('the gateway is saved with the provider\'s fields; the key field stays empty', (await page.inputValue('#sms-f-apiKey')) === ''
      && (await page.inputValue('#sms-f-url')) === 'https://sms-gateway.example.org/send' && /\{\{to\}\}/.test(await page.inputValue('#sms-f-bodyTemplate')));
    await page.click('#sms-callback');
    await page.waitForSelector('#sms-callback-url');
    check('the delivery report address is shown once', /\/hooks\/sms\/uitest\//.test(await page.textContent('#sms-callback-url')));
    await page.click('#dlg-close');
    await openAdmin(page, 'sms', 0);
    await page.waitForSelector('#sms-new');
    await page.click('#sms-new');
    await page.waitForSelector('#sms-name');
    await page.fill('#sms-name', 'Deposit SMS');
    await page.selectOption('#sms-event', 'SAVINGS:SAVINGS_DEPOSIT');
    await page.fill('#sms-body', 'Dear ');
    await page.click('#sms-placeholders [data-ph="FIRST_NAME"]');
    await page.type('#sms-body', ', we received your deposit.');
    await page.waitForFunction(() => /1 segment/.test(document.getElementById('sms-count')?.textContent || ''));
    check('the form counts characters and segments', /GSM-7/.test(await page.textContent('#sms-count')));
    await page.click('#sms-save-tpl');
    await page.waitForFunction(() => /Deposit SMS/.test(document.getElementById('sms-list')?.textContent || ''));
    check('the SMS template is listed', true);
    await T((c) => c.query("UPDATE members SET phone = '0712345678' WHERE id = $1", [mid.id]));
    await page.evaluate(async (m) => (await import('/console/js/members.js')).memberDetail(m), mid);
    await page.waitForSelector('#member-actions #m-sms');
    await page.waitForFunction(() => /Deposit SMS/.test(document.getElementById('member-subs')?.textContent || ''));
    check('the member page lists SMS subscriptions with their channel', /SMS/.test(await page.textContent('#member-subs')));
    await page.click('#member-actions #m-sms');
    await page.waitForSelector('dialog[open] #sms-send-body');
    await page.fill('dialog[open] #sms-send-body', 'Hello {{FIRST_NAME}}');
    check('the Send SMS dialog counts segments', /segment/.test(await page.textContent('dialog[open] #sms-send-count')));
    await page.click('dialog[open] #sms-send-go');
    await page.waitForSelector('#sms-send-result');
    check('Send SMS from the member page shows the outcome', /SMS|FAILED|SENT|QUEUED|SMS_SERVICE_NOT_ENABLED/.test(await page.textContent('#sms-send-result')), await page.textContent('#sms-send-result'));
    await page.click('#dlg-close');

    section('access administration');
    await openAdmin(page, 'access', 1);
    await page.waitForSelector('#ap-form');
    check('the access preferences show the defaults', (await page.inputValue('#ap-form input[name=sessionTimeoutMinutes]')) === '30'
      && (await page.inputValue('#ap-form input[name=minLength]')) === '12');
    await page.click('#ac-new');
    await page.fill('dialog[open] input[name=name]', 'Warehouse feed');
    await page.selectOption('dialog[open] select[name=role]', 'AUDITOR');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Warehouse feed/.test(document.getElementById('ac-list')?.textContent || ''));
    check('an API consumer is added', true);
    await page.click('#ac-list [data-ac-key]');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#ac-key-value');
    check('its key is shown once', (await page.textContent('#ac-key-value')).trim().length >= 40);
    await page.click('#dlg-close');
    await page.waitForSelector('#at-out table');
    check('the audit trail lists the requests made in this session', /\/api\/consumers/.test(await page.textContent('#at-out')));
    await page.click('#whoami');
    await page.waitForSelector('dialog[open] input[name=title]');
    await page.fill('dialog[open] input[name=title]', 'Chief executive');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#dlg-close');
    check('your own profile, then your sign-ins', /signed in/.test(await page.textContent('dialog[open]')));
    await page.click('#dlg-close');
    await page.click('#logout');
    await page.waitForSelector('#login:not([hidden])');
    // The page was reloaded in the top bar section, so the SACCO field starts empty.
    await page.fill('input[name=tenant]', SLUG);
    await page.fill('input[name=email]', 'new.teller@uitest.local');
    await page.fill('input[name=password]', tempPw);
    await page.click('button[type=submit]');
    await page.waitForSelector('#pwchange:not([hidden])');
    check('signing in with it asks for a new password', /Choose a new password/.test(await page.textContent('#login-error')));
    await page.fill('input[name=newPassword]', 'The new one chose 2026');
    await page.click('button[type=submit]');
    await page.waitForSelector('#app:not([hidden])', { timeout: 10000 });
    check('and then signs in', /TELLER/.test(await page.textContent('#whoami')), await page.textContent('#whoami'));

    section('a teller\'s till');
    await page.click('#nav [data-entry="right.teller"]');
    await page.waitForSelector('#my-till');
    check('the Tellering card shows the teller\'s till and its expected cash', /5,000\.00/.test(await page.textContent('#my-till')), await page.textContent('#my-till'));
    check('closing is a supervisor\'s (CLOSE_TILL): the teller has no close button', !(await page.$('main [data-act=close]')));
    await openMenu(page, 'dashboard');
    await page.waitForSelector('#your-tasks-counts');
    check('a teller\'s dashboard has no Tellers widget, which needs OPEN_TILL', !(await page.$('#tellers')));
    check('a teller sees no Administration tabs', await page.$eval('#subnav', (n) => n.hidden));
    check('a teller has no Administration menu and no cog', !(await page.$('#nav [data-menu="administration"]')) && !(await page.$('#nav [data-entry="right.admin"]')));
    check('a teller has no Activities menu (AUDIT_TRANSACTIONS)', !(await page.$('#nav [data-menu="activities"]')));

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
