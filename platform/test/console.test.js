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
    const soon = orgDay(12);
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

    section('lending controls');
    await page.click('nav button[data-view=controls]');
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
    await page.evaluate((no) => loanDetail({ account_no: no }), wl[0].no);
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
    await page.evaluate((m) => memberDetail(m), mid);
    await page.waitForSelector('#loan-history');
    check('the member shows their loan history and completed loan cycles', (await page.textContent('#cycles')).trim() === '1', await page.textContent('#cycles'));
    check('and their identification documents', await page.locator('#identifications').count() === 1);
    await T(async (c) => {
      const CF = require('../src/domain/customFields');
      await CF.createSet(c, { entity: 'MEMBER', name: 'Profile', id: '_profile' }, { createdBy: 'test' });
      await CF.createDefinition(c, { entity: 'MEMBER', setId: '_profile', id: 'occupation', name: 'Occupation', type: 'FREE_TEXT' }, { createdBy: 'test' });
    });
    await page.evaluate((m) => memberDetail(m), mid);
    await page.waitForSelector('#cf-edit');
    await page.click('#cf-edit');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name="_profile|occupation"]', 'Boda rider');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Boda rider/.test(document.querySelector('#custom-fields')?.textContent || ''));
    check('custom fields are shown and edited on the member', true);
    await page.click('nav button[data-view=organization]');
    await page.waitForSelector('#org-details');
    check('the organization page shows its details, end of day, channels and holidays',
      await page.locator('#org-channels table').count() === 1 && /AUTOMATIC/.test(await page.textContent('#eod-mode')));
    await page.click('#holiday-add');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] input[name=description]', 'Mashujaa Day');
    await page.fill('dialog[open] input[name=date]', '2026-10-20');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Mashujaa Day/.test(document.querySelector('#org-holidays')?.textContent || ''));
    check('a holiday is added from the page, and the calendar shows it needs a sync', await page.locator('#calendar-pending').count() === 1);
    await page.click('nav button[data-view=loans]');
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

    await page.selectOption('#r-which', 'risk');
    await page.waitForSelector('#r-out h2');
    check('the risk report groups loans in arrears and shows each risk level', /By risk level/.test(await page.textContent('#r-out')));
    await page.selectOption('#r-which', 'indicators');
    await page.waitForSelector('[data-indicator=GROSS_LOAN_PORTFOLIO]');
    check('indicators render by group', /Outreach/.test(await page.textContent('#r-out')) && (await page.textContent('[data-indicator=ACTIVE_BORROWERS]')).trim() !== '');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#r-xlsx')]);
    check('a report downloads as a workbook', /indicators\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());

    section('dashboard');
    await page.click('nav button[data-view=dashboard]');
    await page.waitForSelector('text=Upcoming repayments');
    const dash = await page.textContent('main');
    check('the dashboard shows indicators, upcoming repayments, favourite views and the latest activity',
      /Indicators/.test(dash) && /Upcoming repayments/.test(dash) && /favourite views/.test(dash) && /Latest activity/.test(dash));

    section('views');
    await page.click('nav button[data-view=views]');
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
    await page.click('nav button[data-view=dashboard]');
    await page.waitForSelector('#fav-views');
    check('marked a favourite, it is on the dashboard', /Console loans/.test(await page.textContent('#fav-views')));

    section('menu items, tasks and report templates');
    await page.waitForSelector('#menu-nav button[data-menu-item]');
    check('the menu items show as a second navigation row', (await page.$$('#menu-nav button[data-menu-item]')).length >= 6);
    await page.click('#menu-nav button:has-text("Loans")');
    await page.waitForSelector('main h1:has-text("Loans")');
    check('a menu item lists the views filed under it', /Console loans/.test(await page.textContent('main')), (await page.textContent('main')).slice(0, 200));
    await page.click('nav button[data-view=views]');
    await page.waitForSelector('#mi-new');
    await page.click('#mi-new');
    await page.fill('dialog[open] input[name=name]', 'Collections desk');
    await page.selectOption('dialog[open] select[name=type]', 'LOANS');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForSelector('#menu-nav button:has-text("Collections desk")');
    check('a new menu item is added to the navigation', true);
    await page.click('nav button[data-view=tasks]');
    await page.waitForSelector('#task-new');
    await page.click('#task-new');
    await page.fill('dialog[open] input[name=title]', 'Call the guarantor');
    await page.fill('dialog[open] input[name=memberId]', 'M0001');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /Call the guarantor/.test(document.getElementById('task-list')?.textContent || ''));
    check('a task is made on the Tasks page', true);
    await page.click('nav button[data-view=dashboard]');
    await page.waitForSelector('#your-tasks-counts');
    check('the Your Tasks widget counts it as due today', /1 due today/.test(await page.textContent('#your-tasks-counts')), await page.textContent('#your-tasks-counts'));
    await page.click('#your-tasks [data-act=complete]');
    await page.waitForFunction(() => /0 due today/.test(document.getElementById('your-tasks-counts')?.textContent || ''));
    check('and completing it there takes it off', true);
    check('the Tellers widget is on an administrator\'s dashboard', !!(await page.$('#tellers')));
    await page.click('nav button[data-view=reports]');
    await page.selectOption('#r-which', 'templates');
    await page.waitForSelector('#rt-list');
    check('Other reports lists the report templates', /No report templates yet|run/.test(await page.textContent('#r-out')));

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

    section('data: dictionary, import, backup');
    await page.click('nav button[data-view=data]');
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
    await page.click('nav button[data-view=members]');
    await page.click('nav button[data-view=data]');
    await page.waitForSelector('#bk-list');
    check('a backup is taken from the console and listed with a download', /COMPLETE/.test(await page.textContent('#bk-list')) && !!(await page.$('#bk-list button[data-bk]')));

    section('users');
    await page.click('nav button[data-view=users]');
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
    await page.click('nav button[data-view=tills]');
    await page.waitForSelector('#till-open');
    await page.click('#till-open');
    await page.waitForSelector('dialog[open] select[name=tellerEmail]');
    await page.selectOption('dialog[open] select[name=tellerEmail]', 'new.teller@uitest.local');
    await page.fill('dialog[open] input[name=openingAmount]', '5000');
    await page.click('dialog[open] button[value=ok]');
    await page.waitForFunction(() => /new.teller@uitest.local/.test(document.getElementById('till-list')?.textContent || ''));
    check('a supervisor opens a till for the new teller', /5,000\.00/.test(await page.textContent('#till-list')), await page.textContent('#till-list'));
    section('access administration');
    await page.click('nav button[data-view=access]');
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
    await page.click('nav button[data-view=teller]');
    await page.waitForSelector('#my-till');
    check('the Tellering card shows the teller\'s till and its expected cash', /5,000\.00/.test(await page.textContent('#my-till')), await page.textContent('#my-till'));
    check('closing is a supervisor\'s (CLOSE_TILL): the teller has no close button', !(await page.$('main [data-act=close]')));
    await page.click('nav button[data-view=dashboard]');
    await page.waitForSelector('#your-tasks-counts');
    check('a teller\'s dashboard has no Tellers widget, which needs OPEN_TILL', !(await page.$('#tellers')));

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
