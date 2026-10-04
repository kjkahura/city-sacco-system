# Console navigation: design

Date: 4 October 2026. Approved by John Karanja on 4 October 2026.

## Goal

Replace the console's flat row of 20 buttons with a top bar arranged like the reference platform's: top menus with dropdowns, icons on the right for daily work, and one Administration page with tabs. John chose the contents of every menu.

## Current state

- `public/index.html` holds `<nav id="nav">` with 20 buttons. Each has a `data-view` and an optional `data-perm`.
- `public/js/nav.js` maps view names to page functions (`VIEWS`) and opens them with `go(name)`.
- `public/js/access.js` hides buttons whose `data-perm` the user lacks, and fills `<nav id="menu-nav">` with custom menu items from `GET /api/menu`.
- `src/domain/menus.js` reports five fixed keys (`FIXED`) in `/api/menu`.
- A refresh always returns to the dashboard; the address bar does not record the page.

## 1. Menu definition and routing

### Definition

A new module, `public/js/menuDef.js`, is the single source of the navigation. It exports:

- `TOP`: the top menus in order, each with `key`, `label` and either `open` (a menu with no dropdown) or `entries` (its dropdown);
- `RIGHT`: the icons on the right of the bar;
- `ADMIN_TABS`: the Administration tabs in order.

An entry has:

| Field | Meaning |
|---|---|
| `key` | Unique within its menu; used in the address hash |
| `label` | The text shown |
| `view` | The page it opens (a key of `VIEWS`) |
| `filter` | Optional; passed to the page, for example `{ state: 'IN_ARREARS' }` |
| `perms` | Optional; the user needs any one of them |
| `divider` | Optional; draws a line before the entry (used before the "All" entries) |

### Rendering

- `index.html` keeps `<nav id="nav">` empty; a new module, `public/js/topbar.js`, builds the bar from the definition after sign-in.
- A menu with entries is a button with `aria-haspopup="menu"` that opens a dropdown list. The dropdown closes on Escape, on a click outside and after an entry is chosen. Arrow keys move between entries.
- The right side holds the Tasks, Teller and Till icons, then the cog. Each icon has a visible tooltip and an `aria-label`.
- The open menu is marked active. The sign-in details and sign-out stay where they are.
- Custom menu items keep their own bar (`menu-nav`) under the top bar, unchanged.

### Opening a page

- `go(view, filter)` replaces `go(name)`. The page function receives the filter: `VIEWS[view](filter)`. Existing pages ignore an unknown filter, so current calls keep working.
- Opening a page sets the address hash to `#<view>` or `#<view>/<filter value>`, for example `#loans/IN_ARREARS` or `#admin/fields`. On load and on `hashchange`, the console opens the page the hash names. Back, Refresh and bookmarks then work. An unknown hash opens the dashboard.
- Every existing caller of `go(name)` keeps working, because the filter is optional.

### Server

- `FIXED` in `src/domain/menus.js` lists the 13 top menu keys: dashboard, clients, groups, loans, deposits, loanTransactions, depositTransactions, activities, creditArrangements, products, reporting, accounting, administration. Each carries the permission that hides it when the user has none of its entries.
- The `/api/menu` response keeps its shape (`fixed`, `items`).

## 2. Menus and their entries

States are the values stored on each record. The "All" entry opens the list with no state filter.

| Menu | Entries | Page |
|---|---|---|
| Dashboard | (no dropdown) | dashboard |
| Clients | Active, Inactive, Pending Approval, Exited, Blacklisted, Rejected, then All Clients | members |
| Groups | Active, Inactive, Pending Approval, Exited, Blacklisted, Rejected, then All Groups | groups |
| Loans | Partial Application, Pending Approval, Approved, Active, Active in Arrears, Closed, Written Off, then All Loans | loans |
| Deposits | Pending Approval, Approved, Active, Active in Arrears, Matured, Dormant, Locked, Closed, then All Deposits | deposits (new) |
| Loan Transactions | Disbursements, Repayments, Fees and Penalties, Interest, Write-offs, Reversals, then All | loanTransactions (new) |
| Deposit Transactions | Deposits, Withdrawals, Transfers, Fees, Interest Applied, Withholding Tax, Reversals, then All | depositTransactions (new) |
| Activities | (no dropdown) | activities (new) |
| Credit Arrangements | Pending Approval, Approved, Active, Closed, Withdrawn, Rejected, then All | creditArrangements (new) |
| Products | Loan Products, Deposit Products | products, with the tab chosen |
| Reporting | Reports, Custom Views, Report Templates, Regulatory Returns, Indicators | reports, views, templates, returns, reports (indicators) |
| Accounting | Journal Entries, Chart of Accounts, Trial Balance, Balance Sheet, Income Statement, Interest Accruals, then Periods and Year-end Close, Provisioning, Branch Accounting | journal, chart, accounting (with the report chosen), finance |
| Administration | (no dropdown; opens the tabs) | admin (new) |

Right of the bar: Tasks (tasks), Teller (teller), Till (tills), and the cog, which opens Administration.

Where a state label and the stored value differ, the definition maps them: "Active in Arrears" is `IN_ARREARS`, and "Partial Application" is `PARTIAL_APPLICATION`. A transaction "type" entry may cover several stored types; for example "Fees and Penalties" covers fee and penalty postings. The definition lists the stored types for each entry.

## 3. New list pages and endpoints

| Page | Data | Work |
|---|---|---|
| Clients and Groups by state | `/clients:search`, `/groups:search` | Existing pages gain a state filter |
| Loans by state | `GET /loans?state=` | Existing page gains a state filter |
| Deposits | `/deposits:search` | New page |
| Credit Arrangements | `/creditarrangements:search` | New page |
| Loan Transactions | `POST /loans/transactions:search` | New endpoint and page |
| Deposit Transactions | `POST /deposits/transactions:search` | New endpoint and page |
| Activities | `GET /activities` | New page |

### The two transaction search endpoints

- They take `filterCriteria` and `sortingCriteria` through the existing `src/lib/searchCriteria.js`, with `offset`, `limit` and `paginationDetails=ON` as the other searches do.
- Fields: type, value date, booking date, amount, account ID, member ID, branch ID, product ID, user, and whether the entry was reversed.
- Results are limited to the user's branches, as the account lists are.
- Loan transactions need VIEW_LOAN_ACCOUNT_DETAILS; deposit transactions need VIEW_SAVINGS_ACCOUNT_DETAILS.
- They are added to `src/lib/routePermissions.js` with those rules.

### List pages

- Each list page has the state or type filter from the menu, a date range where it applies, paging with a total count, and a link from each row to the record.
- The page title names the filter, for example "Loans: Active in Arrears".
- The Activities page filters by date, user, entity and branch.

## 4. Administration

One page, `admin`, with tabs in this order. The tab is part of the hash (`#admin/<tab>`). Each tab reuses the screens that exist today.

| Tab | Contents | From |
|---|---|---|
| General Setup | Organization details and branding, currencies and exchange rates, holidays and non-working days, index rates, ID templates, transaction channels, end of day | organization |
| Client Setup | Client and group types, ID patterns, role names, client controls | organization, controls |
| Accounting Setup | Accounting rules, GL mappings, inter-branch rules and closures | accounting |
| Organization | Branches and Centres | organization |
| Access | Users, Roles, Access Preferences, API Consumers, Audit Trail | users, access |
| Products | Loan and deposit product setup, Lending Controls | products, controls |
| Fields | The Fields administration | organization (fields.js) |
| Views | Custom Views and Menu Items | views, menu |
| SMS | Being built | new placeholder |
| Email | Being built | new placeholder |
| Webhooks | Being built | new placeholder |
| Events Streaming | Being built | new placeholder |
| Templates | Report Templates and Product Documents | templates, products |
| Reports | Regulatory return templates | returns |
| Apps | Being built | new placeholder |
| Data | Import, Backups, Data Dictionary, Extract | data |

- A placeholder tab says what the feature will do and that it is being built. Each is replaced by its own project, in the order Webhooks, Events Streaming, Email, SMS, Apps. SMS will be a provider interface and API with no specific provider.
- Where a screen today combines parts that now sit in different tabs, the screen's module exports each part as its own function so a tab can show only its part. The behaviour of each part does not change.
- The pages that leave the top bar (Controls, Period & provisions, Returns, Chart of accounts, Journal, Organization, Data, Users, Access, Views) stay reachable from the menus or tabs above. Their view keys stay in `VIEWS`, so a hash or a custom link to them still works.

## 5. Permissions

- Every entry and tab carries the permissions of the page it opens. An entry the user may not open is hidden.
- A menu whose entries are all hidden is hidden. The cog and the Administration menu are hidden when every tab is hidden.
- Hiding is a convenience. The server checks do not change, and the new endpoints check permissions and branches themselves.
- Opening a hidden page through the hash shows the page's own permission error, as a direct call does today.

## 6. Testing

- `test/console.test.js` gets a helper, `openMenu(menu, entry)`, which opens the dropdown and clicks the entry. The existing clicks on `nav button[data-view=...]` move to it or to `openAdmin(tab)`.
- New console checks:
  - each dropdown entry opens its page with the filter applied, shown in the title;
  - each Administration tab opens and shows its screens;
  - entries, menus and tabs hide without permission;
  - the hash opens the right page on load, and Back returns to the previous page;
  - the dropdown opens and closes from the keyboard.
- A new suite, `test/transactions-search.test.js`, covers both search endpoints: filters by type and date, paging, sorting, branch limits and permissions.
- All suites pass in UTC and in Africa/Nairobi.

## Out of scope

- The SMS, Email, Webhooks, Events Streaming and Apps features themselves. Each has its own audit and build.
- Changes to the member portal.
- Any change to the API apart from the two new search endpoints and the `FIXED` keys in `/api/menu`.
- Database migrations; none are needed.

## Delivery

Three commits, each with all suites passing:

1. The menu definition, the top bar, `go(view, filter)` and the hash routing, with the existing pages placed in the menus.
2. The new list pages (Deposits, Loan Transactions, Deposit Transactions, Activities, Credit Arrangements), the state filters and the two search endpoints.
3. The Administration page and its tabs, including the placeholders.

Deployed behaviour is unchanged apart from the layout and the new pages.
