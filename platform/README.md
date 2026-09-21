# SACCO Platform

Multi-tenant core banking for SACCOs. One Postgres schema per tenant.

No Mambu dependency. The API conventions carried over from the earlier work
(error envelope, offset/limit pagination, `detailsLevel`, `sortBy`, filter
operators) because they are sensible, not because Mambu invented them.

```bash
cp .env.example .env          # set PGDATABASE and JWT_SECRET
npm install
npm run migrate               # platform schema, then every tenant
npm test                      # 84 assertions: isolation + lending
npm start
```

## Why schema per tenant

| | Shared schema + RLS | **Schema per tenant** | Database per tenant |
|---|---|---|---|
| Isolation | Policy-enforced | **Namespace-enforced** | Physical |
| Per-tenant backup/restore | Hard | **`pg_dump -n tenant_x`** | Trivial |
| Migration cost | One run | **N runs, needs drift tracking** | N runs |
| Connections | One pool | **One pool** | N pools, does not scale |
| Noisy neighbour | Shared | **Shared** | Isolated |

Schema per tenant gives you the thing a SACCO board and an auditor actually
ask for: "show me our data, only ours, and restore it without touching anyone
else." One `pg_dump -n tenant_citysacco` is that answer. The cost is that
migrations run N times, which is why drift tracking is built in rather than
bolted on later.

## How a tenant is selected

Every tenant query runs inside a transaction that starts with

```sql
SELECT set_config('search_path', format('%I, public', $1), true)
```

The `true` is `is_local`. It scopes the setting to the transaction, and
Postgres reverts it on COMMIT or ROLLBACK. A plain `SET search_path` would
persist on the pooled connection, and the next request, for a different
SACCO, would silently inherit it. That is the classic multi-tenant leak, and
`test/isolation.test.js` fires 60 interleaved cross-tenant reads specifically
to catch it if the pattern ever regresses.

Schema names are validated against `^tenant_[a-z][a-z0-9_]{2,40}$` in three
places: a CHECK constraint on `platform.tenants`, `assertSchemaName()` before
any query, and `format('%I')` server-side. A slug like
`x"; DROP SCHEMA public; --` is refused at registration.

## Which tenant a request belongs to

Priority order:

1. **The `tid` claim in the JWT.** Authoritative, because we signed it.
2. **Subdomain**, `citysacco.core.example.com` → `citysacco`.
3. **`X-Tenant` header**, for server-to-server callers and tests.

When a token is present its claim wins, and a mismatched host or header is
**rejected with 403**, not ignored. A teller holding a City SACCO token cannot
reach Washa SACCO by editing a header. Tested both ways.

## Layout

```
src/
  db/
    pool.js            one pool for the process, never one per tenant
    tenantContext.js   withTenant / withTenantRead, the isolation boundary
    migrate.js         platform + per-tenant runner, checksums, drift report
    migrations/
      platform/        tenant registry, users, migration ledger, audit
      tenant/          one SACCO's whole book
  tenancy/
    provision.js       create schema, migrate, seed CoA, create first admin
    resolve.js         tenant resolution middleware, JWT, role guards
  auth/passwords.js    scrypt from node:crypto, no native build
  domain/
    accounting.js      double-entry posting, reversal, trial balance
    loans.js           lifecycle, schedule, allocation, guarantors, arrears
    savings.js         deposit, withdraw, transfer, pledged-balance rules
  routes/              auth, members, loans, savings, accounting
  lib/http.js          error envelope, pagination, filter operators
bin/cli.js             migrate, provision, drift
test/isolation.test.js  36 assertions
test/lending.test.js    48 assertions
```

## What the database enforces, not the app

Application bugs are certain over a long enough horizon. These rules live in
Postgres so a bug cannot produce a corrupt book:

- **Journal entries must balance.** A deferred constraint trigger sums debits
  and credits per entry at COMMIT and raises if they differ.
- **Posted journal lines are immutable.** UPDATE and DELETE raise. Corrections
  are reversing entries, which is what an auditor expects to see.
- **Transactions cannot be deleted.**
- **Savings balances cannot go negative.**
- **A tenant slug cannot be an unsafe identifier**, by CHECK constraint.

## Migrations and drift

Migrations are immutable: the runner stores a checksum and refuses to
re-run a file that changed after being applied. Add a new file instead.

With N schemas, a half-migrated fleet is the real operational risk.

```bash
npm run cli drift
```

```
head: 001_core (1 migrations)
  ok     citysacco    at 001_core
  BEHIND washasacco   at (none)  missing: 001_core
```

Exits non-zero when any tenant is behind, so CI can gate on it.

## CLI

```bash
npm run cli migrate:platform
npm run cli migrate:all
npm run cli drift
npm run cli tenant:create --slug citysacco --name "City SACCO" \
  --admin-email admin@citysacco.co.ke --admin-password "..."
npm run cli tenant:list
npm run cli tenant:drop --slug citysacco --confirm citysacco
```

## SACCO-specific modelling

Things a bank-shaped core banking system does not give you:

- **`loan_guarantors`** — members pledge their own deposits against another
  member's loan, with `PLEDGED` / `RELEASED` / `CALLED` states.
- **`loan_products.max_multiplier`** — the "three times your deposits" rule.
- **`share_accounts` and `dividends`** — share capital and annual dividend
  declaration and allocation, distinct from savings interest.
- **`transaction_channels`** — includes `PAYROLL` for check-off, alongside
  cash, M-Pesa, bank and cheque, each carrying its settlement GL account.
- **Per-tenant `audit_log`** — separate from `platform.audit_log`, so a
  tenant's audit trail leaves with their schema dump.

## Lending and savings

Ported to SQL. Balance columns are only ever changed by SQL expressions on
the `numeric` type, never read into JS, adjusted, and written back. That
closes the read-modify-write race two tellers posting to the same loan would
otherwise hit, and keeps the arithmetic in exact decimal. Ten concurrent
repayments against one loan are in the test suite for exactly this.

```
POST /api/loans/eligibility            deposits multiplier check
POST /api/loans                        apply
POST /api/loans/:id/guarantors         pledge deposits as security
POST /api/loans/:id/approve            state machine, 409 on bad transition
POST /api/loans/:id/disbursements      posts to GL, generates the schedule
POST /api/loans/:id/repayments         allocation, posts to GL
POST /api/loans/:id/accrue-interest
POST /api/loans/:id/write-off          calls the guarantors
POST /api/loans/transactions/:ref/reversal
POST /api/loans/arrears/run
GET  /api/loans/:id/schedule|balances|transactions|guarantors

POST /api/savings/:id/deposits|withdrawals|transfers
POST /api/savings/transactions/:ref/reversal
GET  /api/savings/:id/balance          total, pledged, available

GET  /api/accounting/trial-balance|journal|gl
```

**Repayment allocation** is penalty, then fees, then interest, then
principal. Anything left over is credited to the member's savings rather
than parked on the loan as an unexplained balance, and the reversal path
claws it back out again.

**Guarantors** are the SACCO-specific piece. A member pledges their own
deposits against someone else's loan. The pledge is checked against their
free balance at the time it is made, it reduces their withdrawable balance
while it stands, it is released when the loan is repaid, and it is marked
`CALLED` rather than released on write-off.

**The eligibility rule** is `principal <= deposits * product.max_multiplier`,
the "three times your savings" convention.

**Due dates** shift forward off weekends and off the `holidays` table, in
SQL, so no installment falls on a day the SACCO is shut.

The invariant the test suite asserts after *every single operation*,
corrections included: the trial balance still balances.

## Not done yet

1. **Shares and dividends have tables but no service layer.** Declaration,
   allocation by shareholding, and payout are not written.
2. **No rate limiting, no refresh tokens, no MFA.** Tokens are 12-hour HS256.
   For real deployment add refresh rotation and consider RS256 so the signing
   key is not shared with verifiers.
4. **No per-tenant backup automation.** `pg_dump -n tenant_x` is the primitive;
   scheduling and retention are not built.
5. **No connection limits per tenant.** One SACCO running a heavy report can
   starve the shared pool. Add per-tenant concurrency caps before onboarding
   anyone large.
6. **Migrations are not zero-downtime.**
7. **Interest accrual is on-demand.** There is no scheduler; wire
   `accrue-interest` and `arrears/run` to a cron or an end-of-day job.
8. **Only FLAT schedules are exercised.** `REDUCING` is implemented in
   `buildSchedule` but no seeded product uses it, so it is untested. `migrate:all` takes each schema in
   turn. Fine at tens of tenants, needs batching and a maintenance window
   strategy beyond that.

## Before real member data

Kenya's Data Protection Act 2019 and SASRA reporting both apply. At minimum:
encryption at rest, per-tenant backup and tested restore, retention policy on
`audit_log`, and a documented breach process. The isolation tests here are
evidence for the first question an auditor asks, not an answer to all of them.
