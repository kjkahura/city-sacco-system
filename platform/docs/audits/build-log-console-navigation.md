# Build log: console navigation

Built on 4 October 2026 from the design that John approved (`docs/superpowers/specs/2026-10-04-console-navigation-design.md`) and its plan (`docs/superpowers/plans/2026-10-04-console-navigation.md`). There are four commits on main, each starting "Console:": three for the build and one for the fixes from the final review. They are not pushed.

## Built

### The top bar

- **Where the menus are defined:** `public/js/menuDef.js` describes them as data:
  - the 13 top menus and their dropdown entries;
  - the icons on the right;
  - the 16 Administration tabs.
- **What each entry carries:**
  - the page it opens;
  - its filter, such as a state or a transaction type;
  - the permissions it needs.
- **Drawing the bar:** `public/js/topbar.js` draws the bar for the signed-in user. An entry the user may not open is hidden, and so is a menu left empty.
- **Dropdowns:**
  - one is open at a time;
  - Escape, a click outside and choosing an entry close it;
  - the arrow keys move between entries.
- **Layout:** the bar takes a row of its own under the SACCO's name. Menus wrap onto a second line on a narrow screen rather than being hidden.
- **The right side:** Tasks, Teller, Till and the cog. The cog opens Administration.
- **Custom menu items:** they keep their own row under the bar.

### Opening a page

- **`go(view, filter)`:** it passes the filter to the page and keeps the page in the address hash, for example `#loans/IN_ARREARS` or `#admin/fields`.
- **The hash:**
  - Back and Forward work;
  - a reload resumes the session on the same page;
  - a bookmark opens it.
- **A bad hash:** an unknown hash, or a bad value in one, opens the dashboard. An unknown Administration tab opens the first tab.
- **A corrected hash replaces the one it corrects,** so Back leaves it instead of returning to it and being corrected again.
- **Pages that left the bar:** Organization, Controls, Data, Users and Access still open from their hash.

### Pages filtered from the menus

- **Clients, Groups and Loans:** they take a state, and the title names it ("Loans: Active in Arrears"). Groups gained a State select.
- **Loans, Closed:** this covers repaid, rescheduled and refinanced loans. `GET /api/loans?status=` takes several states separated by commas.
- **Products:**
  - Loan Products and Deposit Products each show their own list;
  - Administration > Products shows both.
- **Reporting and Accounting:** entries open the reports page at the report named:
  - Reports opens the trial balance, as the page did before;
  - Report Templates, Indicators, Trial Balance, Balance Sheet and Income Statement each open their own report.
- **Provisioning:** it opens the Period page at its Provisioning card.

### New list pages (`public/js/lists.js`, `accrualsView` in `accounting.js`)

| Page | Filters | A row opens |
|---|---|---|
| Deposits | account state | the account |
| Loan Transactions | type and dates | the account |
| Deposit Transactions | type and dates | the account |
| Activities | dates, user, record kind with its ID, and branch | the record |
| Credit Arrangements | state | the arrangement |
| Interest Accruals | booking dates | none |

### Transaction search (`src/domain/transactionSearch.js`, `src/routes/transactionSearch.js`)

- **Endpoints:** `POST /api/loans/transactions:search` and `POST /api/deposits/transactions:search`.
- **Request:**
  - `filterCriteria` and `sortingCriteria`, as the other searches take them;
  - paging by offset and limit, with Items-Total when `paginationDetails=ON`.
- **Search fields:** id, type, valueDate, creationDate, amount, accountId, accountKey, memberId, memberKey, branchKey, productKey, user and reversed.
- **Which side a transaction belongs to:**
  - a loan transaction is one posted on a loan account;
  - a deposit transaction is one posted on a deposit account;
  - a posting on both kinds of account, such as a recovery taken from a guarantor's deposit and its reversal, is a loan transaction unless it is a deposit kind;
  - a reversal is listed with the side it reverses and names what it reverses.
- **Access:**
  - the branch rules apply as on every read;
  - each endpoint needs VIEW_LOAN_ACCOUNT_DETAILS or VIEW_SAVINGS_ACCOUNT_DETAILS.
- **Route order:** the routes are mounted before `/loans` and `/deposits`, whose colon actions would otherwise take them.

### Administration (`public/js/admin.js`)

- **The page:** one page with its tabs in a row under the bar.
- **Screens:**
  - each tab shows the existing screens limited to its parts;
  - `orgView` and `accountingView` take `only` and keep the cards named (`keepCards` in `ui.js`).
- **Tabs with two screens:** Access, Products and Templates show their screens one at a time, chosen in a second row. Each screen redraws the page when it saves, so two cannot share it.
- **Unbuilt tabs:** SMS, Email, Webhooks, Events Streaming and Apps say what each will do and that it is being built.
- **Permissions:**
  - tabs carry setup permissions such as MANAGE_GENERAL_SETUP, EDIT_BRANCH and CREATE_CUSTOM_FIELD;
  - so a teller has no Administration menu and no cog;
  - every menu entry carries the permission the server checks for its page, so no entry is shown that would be refused;
  - the server's checks are unchanged.

### Pages draw one at a time

- **The fault:** a page that was still loading when another was opened could finish later and draw over it. The full test run caught this when the cog was clicked and a tab was chosen straight away.
- **The fix:** `render()` in `nav.js` now draws pages one at a time, the latest last, and skips a page left before it started.
- **A cap on the wait:** a page waits at most three seconds for the one before it, so a request that never answers does not hold up the console.

### Server menu keys

`GET /api/menu` reports the 13 top menus in order. Each carries the permissions of its entries.

## Tests

- **New suite:** `test/transactions-search.test.js` has 22 checks. It covers:
  - reversals on each side;
  - filters, sorting and paging;
  - branch limits and permissions;
  - an unknown field;
  - the route order;
  - several loan states;
  - a posting on both kinds of account;
  - the menus of a user without account rights.
- **Changed suites:**
  - `test/access.test.js`: the menu keys and a teller's menus (71);
  - `test/console.test.js` drives the new bar throughout (172 checks). New checks cover:
    - the dropdowns and keyboard;
    - filtered pages and the hash;
    - Back and reload;
    - a bad hash;
    - a 1024 pixel window;
    - each new list;
    - every Administration tab, and a tab chosen while the last one is still loading;
    - Back from a corrected hash, and a page whose request never answers;
    - the teller's menus.
- **A test fix outside this build:** `test/custom-fields.test.js` saves one unique value for two members at once. Either save may win, but the test assumed the first did and failed 5 checks when the second won. It now handles either outcome.
- **Full runs, 46 suites, in UTC and in Africa/Nairobi:** all pass except lending (2 checks), loan-accounting (8) and loan-accounts (1). Those fail the same way on the commit before this build:
  - interest for "thirty days" comes out at 29/30 of the expected amount;
  - one payment holiday check.

  They depend on today's date and are not caused by this build.

## Left as it was

- **Menu-item views:** the predefined menu items with views (Clients, Loans, Deposits, Loan Transactions, Deposit Transactions, Activities) stay in their own row, as agreed, although the top menus now cover the same lists.
- **The SACCO field:** it starts empty after a reload. The session resumes without it.
