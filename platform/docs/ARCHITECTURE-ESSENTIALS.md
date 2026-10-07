# Architecture essentials

The short version of `platform/README.md`, for a person or a coding agent starting work. Read this first; open the README section named in each heading when you need the detail. When this file and the code disagree, the code is right and this file is updated.

## What the system is

- **Purpose:** a core banking platform for Kenyan SACCOs: members and groups, deposits, shares, loans, the general ledger, reports, regulatory returns, a back office console and a member portal.
- **API shape:** follows the reference platform's API, so existing integrations carry over.
- **Stack:** Node 22 (CommonJS), Express 5, PostgreSQL 16, Redis for rate limits (memory fallback).
- **Hosting:** Cloud Run and Cloud SQL in `europe-west1` (`docs/deploy.md`).

## Tenancy (README: "Why schema per tenant", "How a tenant is selected")

- **Schemas:** each SACCO has its own schema `tenant_<slug>`. Shared data (tenants, users, API consumers, the migration ledger, the platform audit log) is in the `platform` schema.
- **One pool:** there is one connection pool for the process, never one per tenant.
- **`withTenant()` is the boundary** (`src/db/tenantContext.js`). It opens a transaction and sets `search_path` with `is_local = true`, so the setting ends with the transaction. Tenant data is touched nowhere else. `test/isolation.test.js` exists to catch a leak.
- **Which tenant a request belongs to:** the token's `tid` claim first, then the subdomain, then the `X-Tenant` header. A mismatch with the token is refused with 403.
- **Schema names** are checked by a CHECK constraint, `assertSchemaName()` and `format('%I')`. They are never built by string concatenation.
- **Sandboxes:** a tenant's sandbox is another schema with its own slug (`_sbx`), reached the same way.

## Money and the ledger (README: "What the database enforces", "Reports read a rollup")

- **Amounts** are `numeric`, and arithmetic is done in SQL with `FOR UPDATE` where a read precedes a write. A balance is never read into JavaScript, changed and written back.
- **Journals balance** by a deferred constraint trigger at COMMIT.
- **Nothing financial is edited or deleted.** Posted lines and transactions are immutable by trigger, and corrections are reversals.
- **Closed periods** are refused by triggers.
- **Reports read `gl_daily_balances`,** a rollup kept exact by trigger, never `journal_lines`. `cli ledger:verify` proves it. Each account and day is spread over 16 slots so concurrent postings do not queue on one row: sum them.
- **One writer.** Every write goes to the primary. Postings fail rather than risk a conflict when it is unreachable. Reports may read a replica (`withTenantReport`); nothing that decides about money does. The full model is `docs/data-architecture.md`.
- **The end of day** (`src/ops/eod.js`) is idempotent per business date: accruals, arrears, penalties, dormancy, maturity.
- **Concurrent postings on the same member** take the advisory lock `member-funds:<memberId>` after the account rows (withdrawals, transfers, guarantor pledges). Keep that order: rows first, then the lock.

## Identity and access (README: "Staff users", "Roles and permissions")

- **Staff** sign in with a password and, for administrators, a second factor. Access tokens last 15 minutes, and refresh tokens rotate with reuse detection (`src/auth/tokens.js`).
- **Members** sign in to the portal with a phone and PIN (`src/auth/memberAuth.js`).
- **Every request is tied to a live session.** The token's `sid` is checked against the session row (cached five seconds), so sign-out, a password or PIN change and suspension end access at once. After revoking sessions, call `RESOLVE.forgetSessions(c)`.
- **Member and staff tokens never cross.** `requireAuth` refuses MEMBER, and `requireMember` refuses everything else.
- **Permissions decide what staff may do,** not the built-in role. `src/lib/routePermissions.js` is the one table of the permission each `/api` route needs; a route missing from it is open only to administrators. Roles, base roles and permissions are read from the database on every request.
- **Branch-limited users** run as the `sacco_branch_scoped` database role under row security.
- **API consumers** use an `apikey` header, with a role, permissions and transaction limits of their own (`src/tenancy/consumers.js`).
- **Controls on money:** per-transaction and daily limits per user and API consumer (`src/domain/controls.js`); backdating needs `BACKDATE_SAVINGS_TRANSACTIONS`, `BACKDATE_LOAN_TRANSACTIONS` or `BACKDATE_SHARE_TRANSACTIONS`; future dates are refused to staff; four eyes on loans (`two_man_rule`) is on for new SACCOs.

## Requests (README: "Rate limiting", "API standards")

- **Route wrapper:** `src/lib/handlers.js` runs a route in a tenant transaction and replies with JSON. POST routes built on it honour `Idempotency-Key` (`src/lib/idempotency.js`).
- **Limits:** rate limits and a per-tenant concurrency slot (`src/lib/limits.js`). The slot is held until the request's database work ends, and statements are limited to 55 seconds except on job routes (`longRunning`).
- **Conflicts:** a request whose transaction PostgreSQL ends to break a deadlock is run again up to twice (`retryConflicts`), so call outside services after the commit. Configuration edits are checked against the version the editor read (`ETag`, `If-Match`, 412; `src/lib/versioning.js`).
- **Errors** are thrown with `err(message, status)` (`src/lib/errors.js`); the message starts with an upper-case code such as `INSUFFICIENT_AVAILABLE_BALANCE: ...`. A refusal that follows a write is returned, not thrown, so the write is not rolled back with it.
- **Outbound calls** to addresses a tenant chose (webhooks, email and SMS gateways, apps, backup callbacks) go through `src/lib/outbound.js`, which refuses private and metadata addresses.
- **Request context:** `src/lib/requestContext.js` carries the signed-in user to the database session settings that triggers read (till rules, branch limits, audit).

## Front ends (README: "The front ends, deployed apart from the API")

- **What they are:** `public/` (the console) and `portal/` (the member portal) are static files that use only the HTTP API under `/api` on their own origin. They import nothing outside their own folder; `test/frontends.test.js` enforces this.
- **Where they are served from:** in development and the tests, by the API server. In production, by the load balancer from a Cloud Storage bucket, published by the deploy workflow apart from the API (`FRONTEND_BUCKET`). `SERVE_FRONTENDS=off` stops the server serving them.
- **Headers** are defined once, in `src/lib/frontendHeaders.js`, and copied into `deploy/security/edge.sh` for the bucket.

## Audit (README: "Audit trail", "Activities")

- **Request log:** every staff and API request is recorded in `audit_events`.
- **Change log:** changes are recorded in `audit_log` through `recordAudit`, in the same transaction as the change.
- **Append-only:** both tables are protected by triggers. The only exceptions are the retention prune and member anonymization, each behind its own session flag.
- **Archive:** `cli audit:export` copies a day's trail to write-once storage.

## Migrations (README: "Migrations and drift")

- **Location:** `src/db/migrations/platform` and `src/db/migrations/tenant`, applied in file-name order.
- **A migration is never edited once committed.** The runner checks checksums and refuses a changed file; add a new file.
- **Commands:** `npm run migrate` applies the platform migrations, then every tenant. `npm run cli drift` lists tenants behind head.

## Code layout (README: "Layout")

- **`src/db`:** the pool, `withTenant`, the migration runner.
- **`src/tenancy`:** provisioning, tenant resolution and authentication middleware, users, API consumers, sandboxes.
- **`src/auth`:** passwords (scrypt), tokens, TOTP, member sign-in.
- **`src/domain`:** the banking rules. Loans in `loans/` and the product-type strategies in `productTypes/`, deposits in `savings/`, plus accounting, workflow, controls, fees, penalties, provisioning, reports, returns, shares and clients.
- **`src/routes`:** thin HTTP layers over `src/domain`.
- **`src/ops`:** end of day, backups (encrypted, shipped offsite), the scheduler, the audit archive.
- **Front ends:** `public/` is the back office console (ES modules, strict content security policy); `portal/` is the member portal.
- **`bin/cli.js`:** migrations, provisioning, end of day, backups, year-end, returns, four eyes, admin tokens.

## Testing

- **Setup:** each suite in `test/` is a plain Node script against a real Postgres. It creates its own tenants and prints `N passed, M failed`.
- **Commands:** `npm test` runs the suites in order. `npm run test:browser` runs the console and portal in a real browser.
- **Size:** about 3,800 checks across the suites. `test/load/postings.js` is a load test, not part of `npm test`.
- **Date-dependent suites:** some fail on certain calendar dates whatever the change, so compare against the commit before yours.
- **Security changes** get a check in `test/hardening.test.js`.

## The climate-adaptation layer (`layer/README.md`)

- **What it is:** a separate service for the ARCAFIM pilot. It tags new loans against the adaptation taxonomy, from the `LOAN_CREATED` webhook, and stores the tag in the `_arcafim` loan custom field set.
- **How it reaches the platform:** only through the API, with a narrow API key, and the signed webhook; never the database or the platform's code. Another core banking system needs only another adapter.
- **Rules:** every tag awaits review by credit staff; a reviewed tag is never overwritten; only the redacted purpose and notes reach a model.

## Where the rest is

| Topic | Where |
| --- | --- |
| Every design decision, in detail | `platform/README.md` |
| Consistency, locking, replicas, payments as sagas, growing past one database | `docs/data-architecture.md` |
| The API for integrators | `docs/developer-guide.md` |
| Going live, settings and rollback | `docs/deploy.md` |
| Security review, findings and what remains | `docs/audits/security-assessment-2026-10.md` |
| Audits and build logs per feature | `docs/audits/README.md` |
| Incident response and breach notice | `docs/incident-response.md` |
| Product requirements and the original specification | `Qona_MBS_Requirements.md`, `Qona_MBS_Technical_Specification.md` at the repository root |
