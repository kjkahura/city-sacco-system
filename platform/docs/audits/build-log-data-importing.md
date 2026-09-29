# Data importing build (commit e164d90, 27 Sep 2026)

Section audited and built: the reference platform Data and Reporting > Data Importing (overview, Excel import, Excel Migration Template, import via API, database clone).

## What was built
- Template reads the reference platform's layout (sheet names, headings, dd.MM.yyyy, M/F, day initials, A/L/I/E/Q, D/H) with separate reference sheets, a column per custom field, 32/255 character limits, prerequisites.
- Members: ID documents against ID templates; credit officers checked against users. Groups refused (not part of the platform).
- Loans via src/domain/loanMigration.js (shared with POST /api/loans/migrate): all the reference platform states, schedules with or without paid columns, Loan Transactions replayed with no journal entries, principal in arrears placement.
- Deposits: overdraft balances and per-account overdraft rate (savings_accounts.overdraft_rate overrides the product).
- Chart of Accounts sheet with signed balances.
- Background validation with progress (src/ops/importRunner.js), preview endpoint, error workbook with red cells.
- The reference platform API: POST /api/data/import, GET /api/data/import/{key}, POST /api/data/import/events/{key}:action with Idempotency-Key (api_idempotency table).
- Backup ZIP carries restore.sql; cli backup:load.
- Migration 029_data_importing.

## Defects fixed
- Imported schedule fees due by the migration date were charged again by the end of day.
- workflow.markArrears used the loan's principal_paid in place of the installment's, so loans that had repaid more than one installment's principal never went into arrears.

## Decisions
- Nothing is written before approval; the preview stands in for the reference platform's browsable draft data.
- Transactions replay supported on fixed-term loans only; dynamic-term schedules always come from the product.
- Not imported: revolving, tranched, index-rate and adjustable-rate loans.

## Tests
31 suites, 1,943 checks, passing under UTC and Africa/Nairobi.
