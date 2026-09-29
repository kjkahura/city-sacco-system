# Build log: report templates, menus, tasks, tills and permissions

Follows the Reporting build (commit 31f6924). Commit 065b1a7 on main ("Report templates, menu items, tasks, tills and permissions, after the reference platform"), on the device, not pushed. John pushes with `git push origin main`.

## Decisions

- **Jasper reports:** replaced by the platform's own report templates. A template is JSON with no SQL; its data comes from custom view definitions and the built-in reports, run with the reader's permissions. Output is HTML, PDF, Excel, CSV or JSON.
- **Groups and lines of credit:** not built. They wait for an audit against the reference platform's Groups and Credit Arrangements.
- **Tellers:** full till management, with a GL cash account per till, open and close with counted cash, cash in and out, over or short posted on close, and teller transactions tied to the open till.
- **Permissions:** a platform-wide model. Roles are editable permission sets using the reference platform's codes, plus per-user extra permissions. Reports, views, menus, report templates, tills, tasks and roles use it now; members, loans, deposits and administration still check the base role and move over later.

## Built

- **Roles and permissions** (platform migration 007, `lib/permissions.js`, `domain/roles.js`, `/api/roles`):
  - Permission catalogue in groups with the reference platform's codes, each marked enforced or not.
  - Five built-in roles with default sets, editable, not deletable; the administrator role always holds everything.
  - Tenant roles with a code, name, base role and user type (administrator, teller, credit officer).
  - Per-user extra permissions (`platform.users.permissions`), a deviation from the reference platform.
  - Each request reads the user's role and permissions from the database (10 second cache, cleared on change), so changes apply without a new token. `GET /api/auth/me` returns the permissions.
  - The TELLER default keeps `POST_TRANSACTIONS_WITHOUT_OPENED_TILL`; removing it enforces tills.
- **Finer report permissions:** VIEW_REPORTS, VIEW_ACCOUNTING_REPORTS, VIEW_INTELLIGENCE, CREATE/EDIT/DELETE_REPORTS, MANAGE_EOD_PROCESSING for positions, AUDIT_TRANSACTIONS for the audit log, EXPORT_TO_EXCEL for every export.
- **Report templates** (tenant migration 031, `domain/reportTemplates.js`, `lib/pdf.js`, `lib/reportRender.js`, `/api/report-templates`):
  - Types MEMBER, LOAN, DEPOSIT, BRANCH, CENTRE and OTHER; entity templates run on a record.
  - Sections TABLE, FIELDS or TEXT; data from a view definition or a built-in report (balance sheet, income statement, trial balance, portfolio at risk, risk, indicators).
  - Parameters: DATE (defaults TODAY, MONTH_START, YEAR_START), TEXT, NUMBER, BOOLEAN, SELECTION, BRANCH, LOAN_PRODUCT, DEPOSIT_PRODUCT.
  - Placeholders `{{record.x}}`, `{{param.x}}`, `{{today}}`, `{{user.email}}`, `{{organization.name}}`; filters left empty by a placeholder are dropped.
  - A hand-written PDF writer (A4, Helvetica, repeated table headers, page numbers).
- **Menu items** (`domain/menus.js`, `/api/menu`, `/api/menu-items`): fixed items, six predefined items with views, user items, usage rights set by administrators, ordering, views filed under items with `menuItemId`.
- **Tasks** (`domain/tasks.js`, `/api/tasks`): tasks linked to members, templates with placeholders, Your Tasks counts, branch visibility with EDIT_TASK, a TASKS custom view entity. Group links are refused.
- **Tills** (`domain/tills.js`, `/api/tills`, triggers on `transactions`):
  - Till IDs like TIL001, one open till per teller, opening cash, NONE, SOFT or HARD limits.
  - Cash-channel transactions link to the teller's open till in the database; reversals move the till back and are refused once it is closed.
  - A till with its own GL account posts there instead of the channel's account.
  - Add and remove cash, close with counted cash, over or short posted to 500-330 Cash Over and Short, undo close, reopen, undo open.
- **Grouped custom fields in views:** each field of a grouped set is a column of all entries; filters match any entry (no entry for EMPTY and DIFFERENT_THAN).
- **Console:**
  - Navigation shows only what the user's permissions allow; menu items form a second row.
  - Dashboard widgets Your Tasks, Tellering and Tellers.
  - Tasks page with templates; Tills page with the log; the Teller page shows the teller's till.
  - Roles on the Users page, with a permission editor; users get tenant roles and extra permissions.
  - Reports: "Other reports (templates)" with upload, replace, share, download and run (PDF, HTML, Excel, CSV); entity reports on member and loan pages; the report list follows the reader's permissions.
  - Views: menu item management and a menu item choice in the view editor.

## Fixes along the way

- Till trigger errors raised as P0001 surfaced as 500; they now raise ERRCODE 23514 and return 409.
- Rearranging menu items or report templates with a partial list left duplicate positions; the named items now go first and the rest keep their order.
- Three suites forged tokens with the administrator's user id and a lower role. Since the role is now read from the database, they create real staff users instead.

## Tests

- New suites: `test/tills.test.js` (60 checks: tills and tasks) and `test/access.test.js` (69 checks: roles, permissions, menus, report templates, grouped custom fields).
- The console test gains 14 checks (menu items, tasks, Your Tasks, Tellers, report templates, roles, a till opened by a supervisor and closed short by the teller).
- 34 suites, 2,245 checks pass under both UTC and Africa/Nairobi.

## Not built

- Indicators for groups and lines of credit (audit first).
- Permissions on member, loan, deposit and administration routes (still base-role checks).
- Deposit and branch pages have no entity report card yet; their templates run through the API.
