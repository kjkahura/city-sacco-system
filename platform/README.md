# SACCO Platform

Multi-tenant core banking for SACCOs. One Postgres schema per tenant.

No Mambu dependency. The API conventions carried over from the earlier work
(error envelope, offset/limit pagination, `detailsLevel`, `sortBy`, filter
operators) because they are sensible, not because Mambu invented them.

```bash
cp .env.example .env          # set PGDATABASE and JWT_SECRET
npm install
npm run migrate               # platform schema, then every tenant
npm test                      # 240 assertions across five suites
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
  auth/
    passwords.js       scrypt from node:crypto, no native build
    tokens.js          refresh rotation with reuse detection
    totp.js            RFC 6238, implemented on node:crypto
    mfa.js             enrolment, challenge tickets, recovery codes
  domain/
    accounting.js      double-entry posting, reversal, trial balance
    loans.js           lifecycle, schedule, allocation, guarantors, arrears
    penalties.js       late payment charges, grace, waiver
    reports.js         balance sheet, income statement, prudential, PAR
    savings.js         deposit, withdraw, transfer, pledged-balance rules
    shares.js          share capital and the dividend cycle
  ops/
    eod.js             end-of-day jobs, idempotent per business date
    backup.js          pg_dump per tenant, retention, restore verification
    crypt.js           AES-256-GCM streaming encryption, key ring, rekey
    offsite.js         dir and command drivers for shipping backups
    scheduler.js       in-process timer behind a Postgres advisory lock
  routes/              auth, members, loans, savings, shares, accounting
  lib/
    http.js            error envelope, pagination, filter operators
    limits.js          rate limiting and per-tenant concurrency gates
    ratestore.js       Redis-backed counters, memory fallback
bin/cli.js             migrate, provision, drift, eod, backup
test/isolation.test.js  36 assertions
test/lending.test.js    48 assertions
test/ops.test.js        50 assertions
test/security.test.js   52 assertions
test/finance.test.js    54 assertions
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

npm run cli eod:run [--date 2026-09-21] [--force]
npm run cli eod:history --slug citysacco
npm run cli backup:run [--slug citysacco]
npm run cli backup:verify --slug citysacco
npm run cli backup:prune --keep 14
npm run cli tokens:prune --days 60
```

## Backups are encrypted and shipped offsite

Set `BACKUP_ENCRYPTION_KEY` and dumps are compressed then encrypted with
AES-256-GCM, a key derived per file with scrypt from a random salt, so two
dumps never share key material. Streamed throughout, because a SACCO's dump
can be gigabytes.

GCM authenticates as well as encrypts: a dump altered on disk or in transit
**fails to decrypt** rather than restoring silently corrupted data. The test
flips one byte in the middle of a backup and confirms it is rejected.

The plaintext dump is deleted only after the encrypted copy has been
decrypted and size-checked. An encrypted file that cannot be decrypted is
not a backup.

`BACKUP_OFFSITE` takes either driver:

```
dir:/mnt/offsite                             another filesystem or mount
cmd:aws s3 cp {src} s3://bucket/{slug}/{name}
cmd:rclone copyto {src} remote:sacco/{slug}/{name}
```

No cloud SDK and no hand-rolled request signing. Shipping an untested SigV4
implementation into a backup path would be worse than calling the tool the
operator has already configured and can verify themselves.

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

## Shares and dividends

Shares are equity, not a deposit. Buying them credits share capital; a
dividend is a distribution out of retained earnings, not interest expense.
Getting that wrong is the kind of thing an auditor finds.

The cycle is three deliberate steps, because that is how an AGM decision
actually moves:

```
POST /api/dividends                    declare a rate for a financial year
POST /api/dividends/:year/allocate     allocate by holding at the record date
POST /api/dividends/:year/pay          clear the payable into members' savings
```

Allocation uses shareholding **as at the record date**, derived from
`share_movements` via `units_as_at()`, not whatever the balance happens to
be when the job runs. Rounding residual goes to the largest holder so the
sum of allocations equals the amount posted to the payable, exactly.

A shareholder with no active savings account is **reported, not silently
skipped**, and the dividend stays `ALLOCATED` until nobody is left unpaid.

## Sessions and MFA

Access tokens are 15 minutes. Refresh tokens are 30 days, single use, and
stored only as a SHA-256 hash, so a database dump does not hand over live
sessions. Rotation detects replay: presenting a spent token revokes the
**entire family**, logging out both the attacker and the real user. A forced
re-login beats a silent session hijack. Changing a password revokes
everything too.

**TOTP** is implemented directly on `node:crypto`, about forty lines,
checked against the RFC 6238 test vector. An authentication primitive is not
somewhere to inherit a supply chain.

Enrolment is two steps. You get a secret, and MFA only switches on once you
have proved the authenticator produces a working code, because enabling it
without that check is how people lock themselves out of their own SACCO. Ten
single-use recovery codes are issued at that point, hashed like any other
credential and shown exactly once.

Login with MFA is password, then a short-lived ticket, then the code. The
half-authenticated state is an opaque hashed row in the database, so a
client holding a ticket has nothing it can use against the API. A ticket
burns after five wrong codes.

**A code cannot be replayed inside its 30 second window.** The last accepted
counter is recorded, and a code at that same counter is refused. Someone
reading a code over your shoulder cannot use it.

Which roles must have a second factor is per tenant
(`tenants.mfa_required_roles`, default `TENANT_ADMIN`), so a SACCO can
require it of admins before requiring it of every teller.

There is one subtlety worth knowing about. Requiring MFA of an admin who has
not enrolled would deadlock a fresh tenant: no session without a code, no
code without a session. Login in that state returns 403 with an
**enrolment-scoped token**, valid for ten minutes and accepted by the
enrolment endpoints and nowhere else. The test suite confirms it is rejected
on an ordinary route.

## Rate limiting

Counters go through `ratestore`: Redis when `REDIS_URL` is set, in-process
otherwise. With Redis the limit is fleet-wide, and the test proves a second
client sees the same counter. Without it, counters are per-node and the
effective limit is N times looser on N instances.

If Redis is configured but unreachable, the limiter **fails open** and falls
back to memory. That is deliberate: a rate limiter is a guard rail, and
failing closed would turn a Redis blip into a total outage for every SACCO.
The degradation is logged and reported on `/health`.

Concurrency gates stay per-process by design. They protect this node's
connection pool, which is a local resource, so a local counter is the
correct scope rather than a limitation.

## Operations

**End of day** (`npm run cli eod:run`) accrues interest and marks arrears
across every active tenant. It is idempotent by construction: a unique index
on `(schema_name, job, business_date)` for any non-failed run means a second
run for the same date is refused *by the database*, not by a flag someone
might forget to check. Interest cannot be accrued twice. One tenant failing
does not stop the fleet.

**Backups** (`npm run cli backup:run`) are `pg_dump --format=custom -n
tenant_<slug>`, one file per SACCO, with a SHA-256 recorded in
`platform.backup_runs` and retention via `backup:prune --keep 14`.

`npm run cli backup:verify --slug x` restores the newest dump into a scratch
schema, counts the tables, and drops it. A backup nobody has restored is a
hope, not a backup, so the restore path is exercised rather than assumed.
The test suite runs a full backup, restore and integrity round trip.

**Scheduling** is a plain timer behind `pg_try_advisory_lock`, so two
instances cannot both fire a sweep. Set `SCHEDULER=on`. On Kubernetes, leave
it off and use a CronJob calling the CLI instead.

## Migrations at fleet scale

`migrate:all` takes a Postgres advisory lock, so two deploys rolling at once
cannot interleave DDL on the same schemas. It runs in bounded batches
(default 4) rather than opening a connection per tenant, and captures errors
per tenant so one bad schema does not abort the rest with no report of where
it stopped. Each migration sets `lock_timeout`, so DDL that cannot get its
lock fails fast instead of queueing every reader behind it.

This is safer, not zero-downtime. A migration taking an ACCESS EXCLUSIVE
lock still blocks that tenant while it runs. Keep migrations short and
additive.

## Penalties

Charged per installment per day, with a per-product rate, a grace period,
and a choice of basis: `OVERDUE` applies the rate to the amount actually in
arrears, `OUTSTANDING` to the whole remaining principal. SACCOs price it
both ways.

Rerunning the accrual charges nothing extra. A unique index on
`(installment_id, charged_on)` combined with `ON CONFLICT DO NOTHING` makes
a repeat a genuine no-op. Worth being precise about why it is written that
way: catching a unique violation in application code does not work inside a
transaction, because Postgres aborts the entire transaction on any statement
error and every later statement then fails. `ON CONFLICT` never raises.

Penalties sit first in the repayment allocation order, ahead of fees.

Waiving is common and is a management decision, so it reverses the posting
rather than deleting the charge. Both the penalty and the waiver, with who
waived it and why, stay on the record.

## Reporting

```
GET /api/reports/balance-sheet?asAt=
GET /api/reports/income-statement?from=&to=
GET /api/reports/prudential?asAt=
GET /api/reports/portfolio-at-risk?asAt=
GET /api/reports/limits
```

All built from posted journal lines, so they cannot drift from the ledger.

The balance sheet carries the current period surplus as its own equity line,
labelled as not yet closed, because no year-end closing entry has run. The
test asserts the sheet balances and that this figure equals the income
statement's surplus.

**Portfolio at risk** buckets outstanding principal by days late
(1-30, 31-90, 91-180, 181-360, over 360) and reports PAR as a percentage.

## Prudential ratios, and what they are not

The ratios are computed from GL accounts tagged with a `regulatory_class`,
because a balance sheet can be built from account type alone but prudential
ratios cannot: they need to know which liabilities are member deposits,
which assets count as liquid, and which equity is institutional rather than
members' own share capital.

**The thresholds are not verified.** They live in the `prudential_limits`
table, seeded with commonly cited values and a `source_note` marking most of
them UNVERIFIED. I could confirm the KES 10 million minimum core capital and
the 15% liquidity floor from published sources; the individual capital
ratios I could not confirm from anything I would build regulatory code on.

The arithmetic is tested. The limits are yours to confirm against the
current SASRA circular, and the report carries that disclaimer in its own
payload so it cannot be mistaken for a filing.

## Backup key rotation

Each encrypted file records which key wrote it. `BACKUP_ENCRYPTION_KEY` is
the current key; `BACKUP_ENCRYPTION_KEYS_OLD` holds retired ones so older
dumps still restore.

```bash
# 1. put the new key in BACKUP_ENCRYPTION_KEY, the old one in KEYS_OLD
npm run cli backup:keys     # which key each stored dump uses
npm run cli backup:rekey    # re-encrypt everything with the current key
# 2. once every file reports the new key, drop KEYS_OLD
```

Each file is decrypted, re-encrypted, verified by a full round trip, and
only then replaced. A failure leaves the original untouched, so a
half-finished rekey never costs you a backup. Files already on the current
key are skipped.

Pre-rotation files (format v1, no key id) are still readable: every
configured key is tried in turn.

## Not done yet

1. **No statutory reserve transfer.** Kenyan SACCOs move a share of surplus
   to a statutory reserve at year end. There is no year-end closing entry at
   all yet, which is why the balance sheet shows an unclosed surplus line.
2. **No loan loss provisioning schedule.** The GL account and write-off path
   exist, but nothing provisions by PAR bucket.
3. **No SASRA return formats.** The underlying figures are there; the actual
   return templates are not, and would need the current forms.
4. **Reports are unpaginated and uncached.** Fine at SACCO scale, will need
   attention with millions of journal lines.

## Before real member data

Kenya's Data Protection Act 2019 and SASRA reporting both apply. At minimum:
encryption at rest, per-tenant backup and tested restore, retention policy on
`audit_log`, and a documented breach process. The isolation tests here are
evidence for the first question an auditor asks, not an answer to all of them.
