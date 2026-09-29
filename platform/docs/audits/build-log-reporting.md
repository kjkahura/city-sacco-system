# Build log: Data and Reporting > Reporting

Commit 31f6924 on main ("Reporting, after the reference platform"), on the device, not pushed. John pushes with `git push origin main`.

## Defects found and fixed

1. **Default dates used the UTC day.** Tenant transactions now set the session time zone to the tenant's (`db/tenantContext`, one `set_config` with the search path). All "today" defaults in the code go through `lib/orgDate.orgToday(c)` (`SELECT current_date`). The fleet `eod:run` runs each tenant on its local date. The scheduler's run key uses the scheduler zone's day.
2. **PAR for a past date mixed dates.** Only days late used the requested date; everything else was today's. The fix is `loan_daily_positions`, written by the new last EOD job `snapshotPortfolio` (today or yesterday only). A past date reads the snapshot. A past date with no snapshot returns 409 NO_PORTFOLIO_POSITIONS_FOR_DATE. A future date returns 400.
3. **LOCKED loans were excluded from PAR and provisioning.** They are now included in `domain/portfolio` and in `provisioning.compute`.

## Built

- **`domain/portfolio.js`:** positions (live or snapshot), filters (branch, centre, product, officer), PAR over 0/7/15/30/60/90/180/360, ranges 7-30, 30-90, 90-180 and 180-360, VAR over 0/7/15/30/90, interest in suspense, the legacy buckets, the loans list and the risk report.
- **Trial balance:** opening balance, debits, credits, net change and closing balance in each account's natural sign; `zeroBalances`, `glTypes` and `branchId` (id, code or NONE). Uses `accounting.movement()` and `branchScope()`.
- **Balance sheet:** `month=yyyy-MM` mode and `branchId`. The income statement also takes `branchId`.
- **Exports:** `?format=csv|xlsx` on every report (`lib/export.js`). Amounts longer than 15 digits are written as text in Excel.
- **Accounting reports API:** `POST/GET /api/accounting/reports` (the reference platform shape: `reportKey`, `status`, `items[{glAccount, amounts}]`), with `ops/reportRunner`, Idempotency-Key, 24 hour expiry and the `pruneReports` EOD job.
- **Indicators:** about 50 in 5 groups, scoped by ORGANIZATION, BRANCH, CENTRE, LOAN_PRODUCT, DEPOSIT_PRODUCT or CREDIT_OFFICER. Indicators that don't apply return null with NOT_APPLICABLE_TO_SCOPE. Saved `indicator_reports` are CRUD for TENANT_ADMIN and MANAGER.
- **Management reports:** portfolio (at most 1 year, DAILY, WEEKLY or MONTHLY), organization, earnings (totals equal the income statement surplus), cashflow and outreach.
- **Credit officer on loans:** `loan_accounts.credit_officer` defaults from the member and is editable via PATCH (`creditOfficer`).
- **Custom views:**
  - Entities: MEMBERS, LOANS, LOAN_TRANSACTIONS, DEPOSITS, DEPOSIT_TRANSACTIONS, JOURNAL_ENTRIES, ACTIVITIES.
  - The field catalog holds the SQL; a view definition only names fields, and values are passed as parameters.
  - Standard-set custom fields are available as fields.
  - Usage rights are set by admins only. Also supported: copy, favourites, export up to 100k rows.
  - `?viewfilter=` with resultType BASIC, FULL_DETAILS or SUMMARY on /members, /clients, /loans, /loans/transactions, /savings, /savings/transactions, /accounting/journal and /activities.
  - `GET /users/{id|email|me}/views?for=`.
- **Console:** Dashboard (indicators, upcoming repayments, your clients, favourite views, latest activity), Views page, report filters and CSV/Excel buttons. `today()` now uses the tenant's time zone, and login returns the tenant timezone.

## Tests

- New suite `test/reports.test.js` with 153 checks.
- `test/_org.js`: an org-date helper for tests. Tests computing UTC days were failing between 21:00 and 24:00 UTC.
- The console test tenant's rate limit is raised to 5000/min, because the added pages pushed a single session past 600/min.
- 32 suites, 2,102 checks pass under both UTC and Africa/Nairobi.

## Not built

- Jasper (the reference platform is retiring it).
- Configurable menu items.
- Tasks, Tellers and Tellering widgets (the platform has no tasks or tills).
- Group and line-of-credit indicators.
- Fine-grained report permissions (belongs to Users and Access Control).
- Grouped custom field sets in views.
- History for dates before the first EOD snapshot, since no positions exist for them.
