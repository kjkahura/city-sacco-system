# Console Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the console's flat row of 20 buttons with a top bar of menus and dropdowns, icons for daily work, and one Administration page with tabs, as the spec sets out.

**Architecture:** One data module (`menuDef.js`) describes every menu, entry and tab. `topbar.js` draws the bar from it. `nav.js` opens a page with `go(view, filter)` and keeps the page in the address hash. Pages take an optional filter. Two new server endpoints search loan and deposit transactions across accounts.

**Tech Stack:** Node 22 CommonJS, Express 5, hand-written Postgres SQL, plain ES modules in `public/js` (no build step, CSP `script-src 'self'`), Playwright for the console test.

**Spec:** `platform/docs/superpowers/specs/2026-10-04-console-navigation-design.md`

## Global Constraints

- **Paths:** all paths below are relative to `platform/`.
- **Vendor name:** never in code, docs, commit messages or file paths. Write "the reference platform".
- **Writing style in docs and UI copy:** plain factual prose, no em dashes, no rhetorical triads, no hollow intensifiers.
- **Scope of change:** no migrations; no API removed; existing response shapes unchanged. The only API changes are the two search endpoints, the `status` list on `GET /loans` and the `FIXED` keys in `/api/menu`.
- **Existing calls:** `go(name)` with one argument keeps working everywhere it is called today.
- **Commits:** three, as the spec's Delivery section sets out:
  - Task 2 ends commit 1;
  - Task 5 ends commit 2;
  - Task 6 ends commit 3.
- **Commit details:**
  - author: `git -c user.name="John Karanja" -c user.email="john.kahura@wakandi.com" commit`;
  - trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01EDhxz73xox9HHMPdBgh8No`;
  - stage by path (`git add -A platform`), never `git add .`.
- **Tests before each commit:** every suite passes. Before commits 2 and 3, also run `TZ=Africa/Nairobi`. Use `runall.sh` and `runall-tz.sh` in the scratchpad.

## Review Focus

1. **A bad hash on load:** `#nonsense`, `#loans/%%%` and `#admin/unknown` open the dashboard (or the first Administration tab) without a JavaScript error.
2. **A refresh that resumes the session:** with `#deposits/DORMANT` in the address bar, it reopens that filtered list, not Members.
3. **Reversals in the Loan Transactions list:** they show only reversals of loan transactions, never deposit reversals, and the deposit list likewise.
4. **A 1024 px wide window:** the 13 menus and the icons fit or scroll inside the bar. The page itself never scrolls sideways.
5. **One dropdown at a time:** only one dropdown is open at once. Escape, a click outside, choosing an entry and Back all close it.

Each line has its test in the owning task: 1, 2, 4 and 5 in Task 2; 3 in Task 4.

---

### Task 1: Menu definition and the server's menu keys

**Files:**
- Create: `public/js/menuDef.js`
- Modify: `src/domain/menus.js:27-33` (`FIXED`)
- Test: `test/access.test.js` (menu section near line 164), `test/console.test.js` (new section "menu definition")

**Interfaces:**
- Produces (`menuDef.js`, all exported):
  - `TOP: Menu[]` where `Menu = { key, label, open?: Entry, entries?: Entry[] }`;
  - `RIGHT: Entry[]` (tasks, teller, tills, then the cog: `{ key: 'admin', icon: 'cog', view: 'admin' }`);
  - `ADMIN_TABS: Tab[]` where `Tab = { key, label, perms?: string[], placeholder?: string }`;
  - `Entry = { key, label, view, filter?: object, perms?: string[], divider?: boolean, icon?: string }`;
  - `visibleMenus(can: (...codes) => boolean): Menu[]`: menus with only the entries the user may open, dropping menus left empty;
  - `visibleTabs(can): Tab[]`;
  - `hashOf(view: string, filter?: object): string`;
  - `parseHash(hash: string): { view: string, filter: object }`.
- Hash rules: `#<view>`, or `#<view>/<value>` where `<value>` is the filter's first value (`state`, `type`, `tab`, `which` or `only`, in that order), URL-encoded.
  - `parseHash` maps the value back through the entry of `TOP`, `RIGHT` or `ADMIN_TABS` that produced it.
  - An unknown view, or an unknown value, gives `{ view: 'dashboard', filter: {} }`. An unknown `admin` value gives the first tab.
- Filters by menu:
  - Clients and Groups: `{ state }`, using `PENDING_APPROVAL`, `INACTIVE`, `ACTIVE`, `EXITED`, `BLACKLISTED`, `REJECTED`.
  - Loans: `{ state }`, with:
    - `Partial Application` = `PARTIAL_APPLICATION`, `Pending Approval` = `PENDING_APPROVAL`, `Approved` = `APPROVED`, `Active` = `ACTIVE`, `Active in Arrears` = `IN_ARREARS`;
    - `Closed` = `CLOSED_REPAID,CLOSED_RESCHEDULED,CLOSED_REFINANCED`;
    - `Written Off` = `CLOSED_WRITTEN_OFF`.
  - Deposits: `{ state }`, using `PENDING_APPROVAL`, `APPROVED`, `ACTIVE`, `ACTIVE_IN_ARREARS`, `MATURED`, `DORMANT`, `LOCKED`, `CLOSED`.
  - Credit Arrangements: `{ state }`, using `PENDING_APPROVAL`, `APPROVED`, `ACTIVE`, `CLOSED`, `WITHDRAWN`, `REJECTED`.
  - Loan Transactions: `{ type: <entry key> }`. The kinds each covers are in `LOAN_TX_TYPES`, exported:
    - `disbursements`: `LOAN_DISBURSEMENT`;
    - `repayments`: `LOAN_REPAYMENT`, `LOAN_RECOVERY`;
    - `fees`: `LOAN_FEE`, `LOAN_FEE_WAIVED`, `LOAN_FEE_ADJUSTED`, `LOAN_PENALTY_ADJUSTED`;
    - `interest`: `LOAN_INTEREST_ACCRUAL`, `LOAN_INTEREST_CAPITALIZED`;
    - `writeoffs`: `LOAN_WRITE_OFF`, `LOAN_BALANCE_WRITE_OFF`;
    - `reversals`: `REVERSAL`.
  - Deposit Transactions: `{ type }`, through `DEPOSIT_TX_TYPES`:
    - `deposits`: `SAVINGS_DEPOSIT`;
    - `withdrawals`: `SAVINGS_WITHDRAWAL`, `SAVINGS_SEIZURE`;
    - `transfers`: `SAVINGS_TRANSFER`;
    - `fees`: `SAVINGS_FEE`;
    - `interest`: `SAVINGS_INTEREST_APPLIED`, `SAVINGS_NEGATIVE_INTEREST`, `OVERDRAFT_INTEREST_APPLIED`;
    - `tax`: `SAVINGS_WITHHOLDING_TAX`;
    - `reversals`: `REVERSAL`.
  - Products: `{ tab: 'loan' | 'deposit' }`.
  - Reporting:
    - Reports: `view: 'reports'`;
    - Custom Views: `view: 'views'`;
    - Report Templates: `view: 'reports', filter: { which: 'templates' }`;
    - Regulatory Returns: `view: 'returns'`;
    - Indicators: `view: 'reports', filter: { which: 'indicators' }`.
  - Accounting:
    - Journal Entries: `journal`;
    - Chart of Accounts: `chart`;
    - Trial Balance, Balance Sheet, Income Statement: `reports` with `which` set to `trial-balance`, `balance-sheet` and `income-statement`;
    - Interest Accruals: `accruals` (new in Task 5);
    - then, after a divider, Periods and Year-end Close and Provisioning, both `finance`, and Branch Accounting, `accounting`.
- Permissions: copy each page's codes from today's `data-perm` attributes in `public/index.html`. New pages:
  - deposits and deposit transactions: `VIEW_SAVINGS_ACCOUNT_DETAILS`;
  - loan transactions: `VIEW_LOAN_ACCOUNT_DETAILS`;
  - activities: `AUDIT_TRANSACTIONS`;
  - credit arrangements: `VIEW_LINE_OF_CREDIT_DETAILS`;
  - indicators: `VIEW_INTELLIGENCE`;
  - the three accounting reports: `VIEW_ACCOUNTING_REPORTS`.
- `ADMIN_TABS` keys, in order: `general`, `clients`, `accounting`, `organization`, `access`, `products`, `fields`, `views`, `sms`, `email`, `webhooks`, `events`, `templates`, `reports`, `apps`, `data`. The five unbuilt tabs carry `placeholder` with one sentence each on what the feature will do.

- [ ] **Step 1: Write the failing server test.** In `test/access.test.js`, after the existing `fixed` check:

```js
const keys = nav.body.fixed.map((f) => f.key);
check('the menu reports the 13 top menus in order', JSON.stringify(keys) === JSON.stringify(['dashboard', 'clients', 'groups', 'loans', 'deposits',
  'loanTransactions', 'depositTransactions', 'activities', 'creditArrangements', 'products', 'reporting', 'accounting', 'administration']), keys.join());
```

Then fix line 164's `'reports'` to `'reporting'`. For a teller, check that `fixed` has no `administration` (use an existing teller token in the suite).

- [ ] **Step 2: Run it and check it fails.**
  - Run: `bash runsome.sh access` from the scratchpad, then read `results-some.txt`.
  - Expected: FAIL on "the menu reports the 13 top menus in order".

- [ ] **Step 3: Replace `FIXED` in `src/domain/menus.js`** with the 13 keys. Each has `permission` (one code or a list; the user needs any one), matching `menuDef.js`. `navigation()` filters with `PERMS.can(user, ...[].concat(f.permission))`. Dashboard, Products, Reporting and Accounting keep `null` unless every entry needs a permission.

- [ ] **Step 4: Run it and check it passes.** Run `bash runsome.sh access`. Expected: `access exit=0`.

- [ ] **Step 5: Write `public/js/menuDef.js`** to the interfaces above. It imports nothing: `can` is passed in.

- [ ] **Step 6: Add the console checks.** Add a "menu definition" section to `test/console.test.js` that runs in the page:

```js
const md = await page.evaluate(async () => {
  const m = await import('/console/js/menuDef.js');
  const all = () => true, none = () => false;
  return {
    top: m.TOP.map((x) => x.key), tabs: m.ADMIN_TABS.length,
    hidden: m.visibleMenus(none).map((x) => x.key),
    hash: m.hashOf('loans', { state: 'IN_ARREARS' }),
    back: m.parseHash('#loans/IN_ARREARS'), bad: m.parseHash('#nonsense/%%%'), badTab: m.parseHash('#admin/unknown'),
    full: m.visibleMenus(all).length,
  };
});
check('13 top menus', md.top.length === 13 && md.full === 13, md.top.join());
check('16 Administration tabs', md.tabs === 16);
check('a user with no permissions still has the Dashboard', md.hidden.includes('dashboard') && !md.hidden.includes('loans'), md.hidden.join());
check('a filter round-trips through the hash', md.hash === '#loans/IN_ARREARS' && md.back.view === 'loans' && md.back.filter.state === 'IN_ARREARS');
check('a bad hash opens the dashboard', md.bad.view === 'dashboard');
check('an unknown tab opens the first tab', md.badTab.view === 'admin' && md.badTab.filter.tab === 'general');
```

- [ ] **Step 7: Run the console test.** Run: `node test/console.test.js` with `e.sh` sourced. Expected: the six new checks pass. Nothing is committed yet; Task 2 commits.

### Task 2: The top bar, routing and the console test migration

**Files:**
- Create: `public/js/topbar.js`
- Modify:
  - `public/index.html`: empty `<nav id="nav">`; add `<nav id="subnav" hidden></nav>` between `menu-nav` and `#view`;
  - `public/js/nav.js`: `go`, `render`, the hash handling;
  - `public/js/main.js`: remove the `#nav` click handler;
  - `public/js/access.js`: `loadAccess` calls `drawTopbar()` instead of hiding buttons;
  - `public/js/session.js`: `start()` opens the page the hash names;
  - `public/styles.css`.
- Test: `test/console.test.js`

**Interfaces:**
- Consumes: `TOP`, `RIGHT`, `visibleMenus`, `hashOf`, `parseHash` from Task 1.
- Produces:
  - `nav.js`:
    - `go(view: string, filter?: object): void`. It sets `S.view` and `S.filter`, sets `location.hash` to `hashOf(view, filter)` without adding a history entry when the hash is unchanged, marks the active menu and calls `render()`.
    - `render()` calls `VIEWS[S.view](S.filter || {})`.
    - `openFromHash(): void`.
  - `topbar.js`:
    - `drawTopbar(): void` builds `#nav` from `visibleMenus(can)` and `RIGHT`;
    - `markActive(view, filter): void`.
  - DOM contract, which the tests rely on:
    - a menu button has `data-menu="<key>"`;
    - a dropdown is `<ul role="menu" data-dropdown="<key>">` holding `<button role="menuitem" data-entry="<menu key>.<entry key>">`;
    - a menu with no dropdown is a button with `data-menu` and `data-entry="<key>"`;
    - the right icons have `data-entry="right.<key>"` and an `aria-label`.

- [ ] **Step 1: Add the test helpers** to `test/console.test.js`, next to `check`:

```js
async function openMenu(page, menu, entry = null) {
  if (entry === null) return page.click(`#nav [data-menu="${menu}"]`);
  await page.click(`#nav [data-menu="${menu}"]`);
  await page.click(`#nav [data-entry="${menu}.${entry}"]`);
}
const openAdmin = async (page, tab) => { await page.click('#nav [data-entry="right.admin"]'); if (tab) await page.click(`#subnav [data-tab="${tab}"]`); };
```

Replace each `page.click('nav button[data-view=X]')` (lines 132 to 902) using this map:

| Old call | New call |
|---|---|
| `members` | `openMenu(page,'clients','all')` |
| `groups` | `openMenu(page,'groups','all')` |
| `loans` | `openMenu(page,'loans','all')` |
| `dashboard` | `openMenu(page,'dashboard')` |
| `reports` | `openMenu(page,'reporting','reports')` |
| `views` | `openMenu(page,'reporting','views')` |
| `returns` | `openMenu(page,'reporting','returns')` |
| `finance` | `openMenu(page,'accounting','periods')` |
| `chart` | `openMenu(page,'accounting','chart')` |
| `journal` | `openMenu(page,'accounting','journal')` |
| `accounting` | `openMenu(page,'accounting','branches')` |
| `products` | `openMenu(page,'products','loan')` |
| `tasks`, `teller`, `tills` | click `[data-entry="right.<key>"]` |
| `organization`, `controls`, `data`, `users`, `access` | for now, `page.evaluate(() => import('/console/js/nav.js').then((n) => n.go('<old key>')))`; Task 6 moves them to `openAdmin` |

- [ ] **Step 2: Add the new checks** in a section "top bar", before the members section:
  - **Dropdowns:**
    - the bar has 13 `[data-menu]` and four right icons;
    - clicking `loans` shows `[data-dropdown="loans"]` with eight entries, the last after a divider;
    - Escape hides it, and ArrowDown moves focus to the next entry;
    - opening `clients` then `groups` leaves one dropdown visible (Review Focus 5);
    - a click on `#view` closes it.
  - **Filters and the hash:**
    - `openMenu(page,'loans','arrears')` leads to `location.hash === '#loans/IN_ARREARS'`;
    - `page.goBack()` returns to the previous hash and page.
  - **Resume (Review Focus 2):**
    - `page.goto('/console/#loans/IN_ARREARS')` with the session stored, then reload;
    - the loans page shows with the status select at `IN_ARREARS`.
  - **Bad hashes (Review Focus 1):**
    - `page.goto('/console/#nonsense/%25%25%25')` opens the dashboard with no new entry in `jsErrors`.
  - **Width (Review Focus 4):**
    - `page.setViewportSize({ width: 1024, height: 800 })`, then check `document.documentElement.scrollWidth <= innerWidth`;
    - restore 1280 afterwards.
  - **Permissions:**
    - sign in as a teller user, created through the API in setup with role TELLER;
    - `[data-menu="administration"]` is absent and `[data-entry="right.teller"]` is present;
    - sign back in as the administrator.

- [ ] **Step 3: Run the console test and check it fails.** Expected: FAIL at the first `openMenu` call (no `[data-menu]`).

- [ ] **Step 4: Implement `topbar.js`, `go`, `render` and `openFromHash`**, and change `index.html`, `main.js`, `access.js`, `session.js` and `styles.css` as listed above.
  - **Dropdowns:** one module-level `openKey`. Opening a menu closes any other. Escape and a document `click` outside `#nav` close it. `hashchange` calls `openFromHash()`, which closes it.
  - **Keyboard:** ArrowDown and ArrowUp move focus within the open list.
  - **Width:** the bar is `display:flex; overflow-x:auto` so that it, not the page, scrolls.
  - **Session start:** `start()` calls `openFromHash()` when `location.hash` is set, otherwise `go('members')` as today.
  - **Existing pages:** `loansView`, `membersView` and `groupsView` accept `filter` and, when `filter.state` is set, put it into their state object (`loanState.status`, `memberState.status`, `groupState.state`) with `offset = 0` before loading. The groups list passes `state` to `GET /api/groups`. The loans status select gains an option for the joined closed list, labelled "closed".

- [ ] **Step 5: Run the console test and check it passes.** Expected: all checks pass, the count is 128 plus the new ones, and there are no JavaScript errors.

- [ ] **Step 6: Run all suites.** Run `runall.sh`. Expected: 45 suites pass. The browser suite runs separately in Step 5.

- [ ] **Step 7: Commit 1.**

```bash
git add -A platform
git -c user.name="John Karanja" -c user.email="john.kahura@wakandi.com" commit -m "Console: top bar with menus, filtered pages and the address hash" -m "<trailers>"
```

### Task 3: Several loan states, and the transaction search domain

**Files:**
- Modify: `src/routes/loans.js:136-150`, so `status` takes a comma-separated list
- Create: `src/domain/transactionSearch.js`
- Create: `test/transactions-search.test.js`, with port 4123 and slug `txsearch`
- Modify: `package.json` (`test` script: append `&& node test/transactions-search.test.js`); the scratchpad's `runall.sh` and `runall-tz.sh`

**Interfaces:**
- Produces: `search(c, side: 'LOAN' | 'DEPOSIT', body: { filterCriteria?, sortingCriteria? }, { offset, limit }): Promise<{ rows: TxRow[], total: number }>`.
- `TxRow = { reference, type, valueDate, createdAt, amount, accountId, accountKey, memberId, memberName, branchKey, productKey, user, reversed, reversalOf }`.
  - `valueDate` is `YYYY-MM-DD`, `amount` is a number and `reversed` is a boolean.
  - `reversalOf` is `allocation->>'reversalOf'`.
- Base WHERE:
  - LOAN: `t.loan_account_id IS NOT NULL`, joined to `loan_accounts`;
  - DEPOSIT: `t.savings_account_id IS NOT NULL`, joined to `savings_accounts`;
  - both join `members` for the names.
- `SEARCH.build` field map (search names to SQL):
  - `id` (`t.reference`) and `type` (`t.kind`): text;
  - `valueDate` (`t.value_date`): date;
  - `creationDate` (`t.created_at`): timestamp;
  - `amount`: number;
  - `accountId` (account no), `accountKey` (account id), `memberId` (member_no), `memberKey`, `branchKey` (`t.branch_id::text`), `productKey` (`product_id`), `user` (`t.created_by`): text;
  - `reversed` (`t.reversed_by IS NOT NULL`): boolean.
- Default order: `t.created_at DESC, t.id`.
- Sorting: by `valueDate`, `creationDate`, `amount` or `id`.

- [ ] **Step 1: Write the failing tests** in `test/transactions-search.test.js`, using the harness of `test/custom-fields.test.js` (the `call`, `login` and `check` helpers).
  - **Setup:**
    - two branches, HQ and NKR;
    - one member in each, each with a deposit account (two deposits and one withdrawal) and a disbursed loan with one repayment;
    - reverse one deposit transaction and one loan repayment;
    - a user limited to HQ with VIEW_LOAN_ACCOUNT_DETAILS and VIEW_SAVINGS_ACCOUNT_DETAILS;
    - a user with neither permission.
  - **Domain checks**, called through `withTenant`:
    - `search(c,'LOAN',{filterCriteria:[{field:'type',operator:'IN',values:['REVERSAL']}]})` returns exactly the one loan reversal, and its `reversalOf` names the loan repayment (Review Focus 3);
    - the same for DEPOSIT returns exactly the one deposit reversal;
    - `type IN ['SAVINGS_DEPOSIT']` returns 4 rows (two accounts with two deposits each);
    - `sortingCriteria:{field:'amount',order:'ASC'}` returns rows in ascending amounts;
    - `{field:'reversed',operator:'EQUALS',value:'true'}` returns the reversed originals only;
    - `offset:1, limit:1` gives one row with `total` unchanged.
  - **Loans route check:** `GET /api/loans?status=ACTIVE,CLOSED_REPAID` returns both an active and a closed-repaid loan. Close one loan first by paying it off through the API. `status=ACTIVE` alone still works.

- [ ] **Step 2: Run it and check it fails.** Run `bash runsome.sh transactions-search`. Expected: a non-zero exit with "Cannot find module '../src/domain/transactionSearch'".

- [ ] **Step 3: Implement `search` and the status list.** In `src/routes/loans.js`, the condition becomes `($1::text[] IS NULL OR l.status = ANY($1::text[]))`, with the parameter `req.query.status ? String(req.query.status).split(',') : null`.

- [ ] **Step 4: Run it and check it passes.** Run `bash runsome.sh transactions-search lending`. Expected: both exit 0. Do not commit; Task 5 commits.

### Task 4: The two search endpoints

**Files:**
- Modify:
  - `src/server.js`: mount `tenantApi.post('/loans/transactions\\:search', ...)` and `tenantApi.post('/deposits/transactions\\:search', ...)` before `tenantApi.use('/loans', ...)` and `tenantApi.use('/deposits', ...)`, so `/deposits/:id\\::action` does not take them;
  - `src/routes/deposits.js` and `src/routes/loans.js`: export the handler, as `search` is exported today;
  - `src/lib/routePermissions.js`: `['POST', '/loans/transactions:search', V_LOAN]` and `['POST', '/deposits/transactions:search', V_DEP]`.
- Test: `test/transactions-search.test.js`

**Interfaces:**
- Consumes: `search` from Task 3.
- Produces:
  - `POST /api/loans/transactions:search` and `POST /api/deposits/transactions:search`;
  - body `{ filterCriteria, sortingCriteria }`; query `offset`, `limit`, `paginationDetails=ON`;
  - response: a `TxRow[]` with the `items-total` header when paginationDetails is ON;
  - built on `H.run(..., { write: false })`, so the branch row security on `transactions` applies.

- [ ] **Step 1: Add the failing HTTP checks:**
  - the administrator's loan search with `type IN ['LOAN_REPAYMENT']` returns 2 rows and `items-total: 2`;
  - the HQ user sees only HQ rows on both endpoints (every `branchKey` is HQ's id);
  - the user without the permissions gets 403 on both;
  - an unknown field gives 400 with `UNKNOWN_SEARCH_FIELD`;
  - `POST /api/deposits/transactions:search` is not taken by the colon actions, so the response is an array, not `UNKNOWN_ACTION`.

- [ ] **Step 2: Run it and check it fails.** Expected: 404 `ROUTE_NOT_FOUND`.

- [ ] **Step 3: Mount the routes and add the permission rules.**

- [ ] **Step 4: Run it and check it passes.** Run `bash runsome.sh transactions-search uac deposits-api`. Expected: all exit 0.

### Task 5: The new list pages

**Files:**
- Create: `public/js/lists.js`, holding `depositsView`, `loanTransactionsView`, `depositTransactionsView`, `activitiesView` and `creditArrangementsView`
- Modify:
  - `public/js/accounting.js`: add `accrualsView` (POST `/api/accounting/interestaccrual:search`);
  - `public/js/nav.js`: add six `VIEWS` keys: `deposits`, `loanTransactions`, `depositTransactions`, `activities`, `creditArrangements`, `accruals`;
  - `public/js/products.js`: `productsView(filter)` shows deposit products (`depositProductsSection`) when `filter.tab === 'deposit'`;
  - `public/js/reports.js`: `reportsView(filter)` sets `R.which = filter.which` when given;
  - `public/js/main.js`: the module list in the header comment.
- Test: `test/console.test.js`

**Interfaces:**
- Consumes:
  - `LOAN_TX_TYPES` and `DEPOSIT_TX_TYPES` from Task 1;
  - the endpoints from Task 4;
  - `table`, `pager`, `wirePager`, `wireRows` from `ui.js`;
  - `creditArrangementDetail` and the deposit account detail from `accounts.js`;
  - `loanDetail` from `loans.js`.
- Produces: each page is `async (filter = {}) => void`.
  - The title is `<Menu>: <entry label>`, or the menu label alone for "All".
  - The toolbar has the same filter as a select, so it can be changed, and From and To dates where the data has dates (transactions, activities).
  - The Activities page also filters by user, entity and branch, passed to `GET /api/activities` as the existing route's query parameters.
  - Paging uses `paginationDetails=ON`.
  - A row opens its record:
    - a transaction opens its account;
    - an activity opens its record when it has one.

- [ ] **Step 1: Write the failing console checks:**
  - `openMenu(page,'deposits','active')` gives title "Deposits: Active" and at least one row;
  - `openMenu(page,'loanTransactions','disbursements')` lists the seeded disbursement of 60,000;
  - `openMenu(page,'depositTransactions','deposits')` lists the 250,000 deposit;
  - `openMenu(page,'activities')` shows rows;
  - `openMenu(page,'creditArrangements','all')` shows the empty message;
  - `openMenu(page,'accounting','accruals')` renders;
  - `openMenu(page,'accounting','trialBalance')` shows the reports page with "Trial balance" selected;
  - `openMenu(page,'products','deposit')` shows deposit products;
  - clicking the first loan transaction row opens the loan.

- [ ] **Step 2: Run them and check they fail.** Expected: FAIL at "Deposits: Active".

- [ ] **Step 3: Implement the pages and the view changes.**

- [ ] **Step 4: Run them and check they pass.** Run `node test/console.test.js`. Expected: all pass with no JavaScript errors.

- [ ] **Step 5: Run all suites in both time zones.** Run `runall.sh` and `runall-tz.sh`. Expected: 46 suites pass in each.

- [ ] **Step 6: Commit 2.** Message: "Console: deposits, transactions, activities and credit arrangement lists; transaction search".

### Task 6: Administration

**Files:**
- Create: `public/js/admin.js` (`adminView(filter)`, `placeholderTab(tab)`)
- Modify:
  - `public/js/organization.js`: `orgView({ only } = {})`;
  - `public/js/controls.js`: `controlsView({ only } = {})`;
  - `public/js/accounting.js`: `accountingView({ only } = {})`;
  - `public/js/products.js`: `productsView` takes `only` as well;
  - `public/js/nav.js`: `admin` in `VIEWS`; `go` hides `#subnav` unless the view is `admin`;
  - `public/styles.css`.
- Test: `test/console.test.js`

**Interfaces:**
- Consumes: `ADMIN_TABS` and `visibleTabs` from Task 1, and `go` from Task 2.
- Produces:
  - `adminView({ tab })` draws the tab bar into `#subnav` (`<button data-tab="<key>">`, the active one marked), then calls the tab's renderer, which writes `#view` as pages do today.
  - `only` is a list of part keys. A view given `only` renders just those cards and wires only the controls present, guarding each `$()` for null. With no `only`, it renders everything, as now.
- Part keys:
  - `orgView`: `details`, `branding`, `currencies`, `holidays`, `rates`, `idTemplates`, `channels`, `eod`, `clients`, `branches`, `fields`;
  - `controlsView`: `controls`, `limits`, `exclusions`;
  - `accountingView`: `branches`, `rules`, `closures`, `settings`;
  - `productsView`: `loan`, `deposit`.
- Tab renderers:

| Tab | Renderer |
|---|---|
| `general` | `orgView({ only: ['details','branding','currencies','holidays','rates','idTemplates','channels','eod'] })` |
| `clients` | `orgView({ only: ['clients'] })` (client and group types, ID patterns, role names, client controls) |
| `accounting` | `accountingView({ only: ['rules','closures','settings'] })` |
| `organization` | `orgView({ only: ['branches'] })` |
| `access` | `usersView()`, then `accessView()` appended |
| `products` | `productsView({ only: ['loan','deposit'] })`, then `controlsView()` appended (Lending Controls) |
| `fields` | `orgView({ only: ['fields'] })` |
| `views` | `viewsView()`, then `menuView()` appended |
| `sms`, `email`, `webhooks`, `events`, `apps` | `placeholderTab(tab)` |
| `templates` | `reportsView({ which: 'templates' })` |
| `reports` | `returnsView()` |
| `data` | `dataView()` |

- Appending a second view: render the first into `#view`, move its children into a holder, render the second, then put the holder first. Wrap this in `stack(...renderers)` in `admin.js`.

- [ ] **Step 1: Write the failing console checks:**
  - the cog and the Administration menu open `#admin/general` with 16 tabs, minus any hidden;
  - every tab opens without a JavaScript error, in a loop over `[data-tab]`;
  - the General Setup tab shows "Organization details" and not "Branches and centres";
  - the Organization tab shows "Branches and centres";
  - the Webhooks tab shows the placeholder sentence;
  - the teller user sees no `#subnav` tabs and no cog;
  - `#admin/fields` on load opens the Fields tab.

  Then move the Task 2 `go('organization' | 'controls' | 'data' | 'users' | 'access')` calls to `openAdmin(page, '<tab>')`, and update the selectors those sections use.

- [ ] **Step 2: Run them and check they fail.** Expected: FAIL at the cog check.

- [ ] **Step 3: Implement `admin.js` and the `only` parameters.**

- [ ] **Step 4: Run them and check they pass.** Run `node test/console.test.js`. Expected: all pass with no JavaScript errors.

- [ ] **Step 5: Run all suites in both time zones.** Expected: 46 suites pass in each.

- [ ] **Step 6: Write the build log and the README section.**
  - Write `docs/audits/build-log-console-navigation.md` in the style of `build-log-custom-fields.md`: what was built, the tests with their counts, and what was left as it was.
  - Add a README "Console" paragraph naming the menus.
  - Add row 17 to the audits README.

- [ ] **Step 7: Commit 3.** Message: "Console: Administration page with tabs".

## After the plan

1. Sync each commit to the device with the usual pattern: package, SendUserFile, `device_commit_files`, extract, check the md5 over tracked files, then commit on the device. John pushes.
2. Write the build log to the project as `claude/build-log-console-navigation.md`.
