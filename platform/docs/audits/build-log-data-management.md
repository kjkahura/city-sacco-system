# Data management build (commit 3941eae, 27 Sep 2026)

Section audited and built: the reference platform Data and Reporting > Data Management, plus the Excel data import, tenant user management, a Singer tap for Stitch and the reference platform's null handling.

## What was built
- Dates: DATE columns read as yyyy-MM-dd strings (src/db/pool.js). Timestamps stay ISO UTC.
- API standards: page limit 1,000; nulls omitted with Accept: application/vnd.sacco.v2+json or ?nulls=omit (src/lib/apiStandards.js).
- Data dictionary: GET /api/data-dictionary (JSON/CSV), words in src/db/dictionary.js, COMMENT ON written by every migration, test fails on undescribed columns.
- Tenant backup: POST /api/database/backup, GET /api/database/backup/LATEST; ZIP of CSVs + schema.sql + dictionary.json + manifest.json; SSRF-guarded callback; one at a time; 30-day retention (src/ops/tenantBackup.js).
- Incremental extract: GET /api/extract/:stream, (timestamp, key) cursor, updated_at by trigger, horizon at oldest open writing transaction (src/domain/extract.js).
- Singer tap: bin/tap-sacco.js (use an AUDITOR user).
- Excel import: /api/data-imports (template, upload, errors workbook, approve, reject). Nothing is written before approval; validation is a dry run in a savepoint (src/domain/dataImport.js).
- Staff users: /api/users (src/tenancy/users.js); temporary passwords with forced change; status checked on every staff request.
- Migrations: tenant 028_data_management, platform 006_tenant_user_management.

## Decisions
- Import creates records only on approval (no draft rows in live tables), so nothing needs excluding from end of day.
- Imported accounts post no journal entries; the GL Balances sheet is posted as one opening entry, with reconciliation warnings.
- Not imported: revolving, tranched, index-rate, adjustable-rate and funded loans.
- Nulls are kept by default; omission is opt-in.

## Tests
30 suites, 1,852 assertions, passing under UTC and Africa/Nairobi.
