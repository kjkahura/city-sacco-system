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
    memberAuth.js      member activation, PIN sign-in, lockout, sessions
  domain/
    accounting.js      double-entry posting, reversal, trial balance
    close.js           financial years, year-end close, statutory reserve
    loans.js           lifecycle, schedule, day counts, accrual, allocation,
                       guarantors, eligibility, arrears
    penalties.js       late payment charges, grace, waiver
    provisioning.js    loan loss provisioning by PAR band
    reports.js         balance sheet, income statement, prudential, PAR
    returns.js         regulatory return engine, templates held as data
    savings.js         deposit, withdraw, transfer, pledged-balance rules
    shares.js          share capital and the dividend cycle
  ops/
    eod.js             end-of-day jobs, idempotent per business date
    backup.js          pg_dump per tenant, retention, restore verification
    crypt.js           AES-256-GCM streaming encryption, key ring, rekey
    offsite.js         dir and command drivers for shipping backups
    scheduler.js       in-process timer behind a Postgres advisory lock
  routes/              auth, members, loans, loanProducts, savings, shares,
                       accounting, reports, finance (provisioning, periods,
                       returns), portal (the member-facing API)
  lib/
    http.js            error envelope, filter operators, legacy slicing
    page.js            SQL-side paging: offset, limit, count(*) OVER ()
    limits.js          rate limiting and per-tenant concurrency gates
    ratestore.js       Redis-backed counters, memory fallback
public/                the back office console: index.html, app.js, styles.css
portal/                the member portal: index.html, app.js, api.js, styles.css
bin/cli.js             migrate, provision, drift, eod, backup, close, returns
test/isolation.test.js     36 assertions
test/lending.test.js       48 assertions
test/ops.test.js           51 assertions
test/security.test.js      52 assertions
test/finance.test.js       54 assertions
test/provisioning.test.js  36 assertions
test/close.test.js         40 assertions
test/reporting.test.js     45 assertions
test/portal.test.js        49 assertions
test/loan-accounting.test.js 55 assertions
test/console.test.js       20 assertions, real browser, npm run test:browser
test/portal-ui.test.js     20 assertions, real browser, npm run test:browser
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

# provisioning, per tenant
npm run cli provision:bands --slug citysacco                      # show
npm run cli provision:bands --slug citysacco --band WATCH --rate 5
npm run cli provision:preview --slug citysacco [--date 2026-12-31]
npm run cli provision:run --slug citysacco [--date 2026-12-31]

# financial years
npm run cli year:open    --slug citysacco --year 2026
npm run cli year:preview --slug citysacco --year 2026
npm run cli year:close   --slug citysacco --year 2026
npm run cli year:reopen  --slug citysacco --year 2026 --reason "audit adjustment"

# regulatory returns
npm run cli returns:load   --slug citysacco --file ./sasra-return.json
npm run cli returns:render --slug citysacco --code SAMPLE_FINPOS

# the daily rollup, checked against the journal
npm run cli ledger:verify --slug citysacco [--from ... --to ...]
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

## Loan products and their accounting

A product is the template every loan under it follows: pricing, eligibility,
allocation order, and the accounting rules. `GET/POST/PATCH
/api/loan-products` manages them, with every GL mapping checked against the
chart of accounts for existence and type, and the console has a Products
screen. The rate is copied onto a loan at application, so repricing a
product does not touch running loans; the accounting method and GL mappings
are read live, so a wrong mapping can be corrected.

### The posting rules

Taken from Mambu's published behaviour for loan products
([Linking Products to Accounting](https://docs.mambu.com/docs/linking-products-to-accounting/),
[Cash vs Accruals Accounting](https://docs.mambu.com/docs/cash-vs-accruals-accounting/)).
Each product picks `accounting_method`:

| Event | ACCRUAL | CASH |
|---|---|---|
| Disbursement | Dr Portfolio, Cr Source | same |
| Interest applied | Dr Interest Receivable, Cr Interest Income | nothing booked |
| Fee applied | Dr Fee Receivable, Cr Fee Income | nothing booked |
| Penalty applied | Dr Penalty Receivable, Cr Penalty Income | nothing booked |
| Interest, fee, penalty paid | Dr Source, Cr the receivable | Dr Source, Cr income |
| Principal paid | Dr Source, Cr Portfolio | same |
| Write-off | Dr Write-off Expense, Cr Portfolio and each receivable | Dr Write-off Expense, Cr Portfolio |

Income is recognised exactly once under either method. The code before this
credited interest income at accrual and again at repayment, and debited
penalties to the loan portfolio, so income was overstated and the portfolio
carried uncollected penalties as if they were principal.
`test/loan-accounting.test.js` asserts the receivable rises and falls and
the income account moves once.

Each product names its own receivable, income and write-off accounts
(`gl_interest_rec`, `gl_fee_rec`, `gl_penalty_rec`, `gl_writeoff_exp`, and
the income accounts), defaulting to the seeded ones.

### Interest accrues per day

As in Mambu, interest accrues daily
([Interest Calculation Methods in Loans](https://docs.mambu.com/docs/interest-calculation-methods-in-loans/)):
a member who repays early owes interest for the days they had the money, a
late payer keeps accruing. Each loan records `accrued_through`; an accrual
books the days from there to the business date and moves the marker, so
running it twice for one date books nothing and running it after a missed
week books the week. The previous implementation booked one month per call,
and the nightly job called it nightly.

`interest_accrual` per product: `DAILY` (default), `MONTHLY` (booked on the
last day of the month, missed month-ends caught up), or `NONE`.

`day_count` per product, applied to the annualised rate (twelve times the
monthly rate):

| Convention | Behaviour |
|---|---|
| `THIRTY_360` (default) | 30E/360. Every calendar month is thirty days, so "1% a month" accrues to exactly 1% over any month and the accrued figure on an installment date equals the schedule. |
| `ACTUAL_365` | Mambu's default. Days that passed over 365. |
| `ACTUAL_360` | Days that passed over 360. |
| `ACTUAL_ACTUAL` | Each day is a fraction of its own year, leap years included. |

30E/360 is the default because SACCO products are quoted per month and
members expect the month's interest to be the month's interest. A product
priced per annum should use an actual convention.

### Eligibility is enforced at approval

Applying records a request; approving is the credit decision, and that is
where the product's rules bite. `enforce_deposit_multiplier` refuses a loan
above `max_multiplier` times the member's deposits; `require_guarantor_cover`
refuses one where deposits plus guarantor pledges fall short of
`min_cover_percent` of the principal. `GET /api/loans/:id/eligibility`
shows the same picture approval will judge by, guarantors included, so the
preview and the decision cannot disagree.

### Allocation order

`allocation_order` is the product's list, default penalty, fee, interest,
principal, the same idea as Mambu's drag-and-drop
([Repayment Allocation Order](https://docs.mambu.com/docs/repayment-allocation-order/)).
A partial repayment walks it. The database refuses an order that does not
name all four components once.

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

## The daily sequence

`eod.DEFAULT_JOBS`, run by the scheduler or by `cli eod:run`, in this order:

1. `ensureFinancialYear`: opens the calendar year covering the business date
   if no financial year does. On 1 January the new year opens itself; a SACCO
   on a July to June year opens its years by hand and this leaves them alone.
2. `accrueInterest`
3. `markArrears`
4. `accruePenalties`, which reads the arrears state the previous job produced
5. `provision`, which reads the same arrears and posts only the movement
   since the last run. While the bands have no rates it records a skip, not a
   failure, so a tenant that has not configured provisioning does not fill
   the job log with red.

Each job is idempotent per business date through `platform.job_runs`, so a
rerun is a no-op rather than a double posting.

## Reports read a rollup, not the journal

`gl_daily_balances` holds one row per account per day per closing flag,
maintained by an AFTER INSERT trigger on `journal_lines` (migration 007).
Every report reads it. A six-year trial balance touches days rather than
lines, which for a busy SACCO is two orders of magnitude fewer rows.

The rollup is exact rather than merely fresh because the journal is
append-only: lines cannot be updated or deleted, and the two entry columns
the rollup keys on (`booking_date`, `source_type`) are now immutable too. So
an insert trigger is the whole maintenance story. `cli ledger:verify`, and
`GET /api/accounting/verify` for an auditor, recompute from the lines and
report any account that disagrees; an empty list is the claim made good.
Run it after a restore or after any manual SQL against the ledger.

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
GET /api/reports/balance-sheet?asAt=[&offset=&limit=]
GET /api/reports/income-statement?from=&to=[&offset=&limit=][&includeClosing=]
GET /api/reports/prudential?asAt=
GET /api/reports/portfolio-at-risk?asAt=
GET /api/reports/portfolio-at-risk/loans?asAt=&bucket=&offset=&limit=
GET /api/reports/audit-log?action=&entity=&offset=&limit=
GET /api/reports/limits
GET /api/accounting/trial-balance?from=&to=&offset=&limit=
GET /api/accounting/journal?from=&to=&glCode=&offset=&limit=
```

All built from posted journal lines, so they cannot drift from the ledger.

### Paging happens in the database

Anything that grows with the book pages in SQL through `lib/page.js`:
`LIMIT`/`OFFSET` with `count(*) OVER ()` riding along on the same scan, so
the total costs nothing extra. Lists answer with a bare array and
`items-offset`, `items-limit` and `items-total` headers; reports carry the
same numbers inside the body, because a report is an object and you should
not have to read two places to know you are holding page one of nine.

The two statements are the exception. Their row count is bounded by the
chart of accounts rather than by the size of the book, and both need every
line to compute totals that are true, so they return everything unless you
ask for a window, and their totals are always over the whole set. A trial
balance whose totals add up only the fifty rows you can see would report
that the book does not balance.

Requests above the cap are clamped to 500 rather than refused. A page past
the end returns an empty array and the real total, so a client can recover
rather than guess.

### Two bugs paging turned up

Both were in the code before the paging work and both are now covered by
assertions in `test/reporting.test.js`:

- **The period filter did nothing.** `from` and `to` were applied in an
  outer `LEFT JOIN` onto `journal_entries`. A line row survives a failed
  left join with only the entry columns nulled, so every line was summed
  anyway: a one-month income statement reported the whole book. The filter
  now sits inside the aggregate (`accounting.MOVEMENT_SQL`).
- **Lookup by account number was a 500.** `WHERE id = $1 OR account_no =
  $1::text` makes Postgres infer `$1` as `uuid`, so `LN0001` failed to
  parse before the second branch was ever considered. Every by-number
  lookup on a loan, savings or share account threw. It is `id::text = $1 OR
  account_no = $1` now.

The balance sheet carries the current period surplus as its own equity line,
labelled as not yet closed, because no year-end closing entry has run. The
test asserts the sheet balances and that this figure equals the income
statement's surplus.

**Portfolio at risk** buckets outstanding principal by days late
(1-30, 31-90, 91-180, 181-360, over 360) and reports PAR as a percentage.

## Loan loss provisioning

Loans are classified by how many days their oldest unpaid installment is
overdue, using the same arrears measure as the PAR report so the two cannot
disagree. Each band carries a rate; the required allowance is outstanding
principal in each band times that rate.

```
GET   /api/provisioning/bands
PATCH /api/provisioning/bands/:code      { ratePercent, sourceNote }
GET   /api/provisioning/preview?asAt=
POST  /api/provisioning/run              { asAt }
POST  /api/provisioning/runs/:id/reverse { reason }
GET   /api/provisioning/runs
```

**No rates ship.** `provision_bands.rate_percent` starts NULL and every
entry point refuses to compute or post until each band has one. A
plausible-looking default nobody checked is worse than an empty column,
because it becomes the number a board relies on. The day boundaries are
seeded to match the PAR buckets and are equally editable.

Two things the database enforces rather than the code: bands cannot
overlap (a GiST exclusion constraint on the day range, so no loan is
provisioned twice), and only one run per as-at date can be POSTED (a
partial unique index, so a rerun is a no-op instead of a second charge).

**The movement is posted, never the balance.** The allowance is a standing
contra-asset. If it holds 400,000 and the calculation says 550,000, the
entry is 150,000. Posting the required balance every month is the classic
provisioning bug and it inflates the allowance without limit. A fall in
required provision is a release: it debits the allowance and credits the
same expense account, because it corrects an earlier charge rather than
earning anything.

The allowance account `100-150` is tagged `LOAN_PORTFOLIO`, so the balance
sheet and the prudential inputs both see the portfolio net of it.

## Year-end close and the statutory reserve

```
GET   /api/periods
POST  /api/periods                       { year, startsOn, endsOn }
GET   /api/periods/settings
PATCH /api/periods/settings              { statutoryReservePercent }
GET   /api/periods/:year/close-preview
POST  /api/periods/:year/close
POST  /api/periods/:year/reopen          { reason }
```

Closing a year, in one transaction:

1. sweeps every income and expense account to zero against retained
   earnings, so the new year starts from nothing;
2. transfers the configured share of the surplus to the statutory reserve
   (a deficit transfers nothing, because you cannot reserve a loss);
3. marks the year CLOSED, after which a **BEFORE INSERT trigger on
   `journal_entries` refuses any posting dated inside it**.

The order matters: the closing entries are themselves postings inside the
year, so they land while it is still open and the lock comes down after
them. In one transaction, a failure halfway leaves the year open and
unswept rather than half closed.

**The reserve percentage is not shipped either.** It comes from regulation
and from the society's own by-laws, and a close is refused until someone
sets it.

Reopening reverses the close and unlocks the year. The original close, the
reversal and the eventual second close all stay on the record, because that
is what an auditor is looking for. Reversals are dated with the entry they
reverse, not with today: reverse December's entry in January and let it
default to today and both periods are wrong.

A closed year still reports properly. The income statement excludes
closing and reserve entries by default (`includeClosing=true` shows the
swept view), so last year still shows what it earned rather than a tidy
zero. Financial years cannot overlap; another GiST exclusion constraint.

## Regulatory returns

A return is rows, not code: a template plus numbered lines, each of which
either sums a slice of the chart of accounts (by GL code, by regulatory
class, or by account type) or computes from other lines by an expression
like `A1 + A2 - A3`. Adding a form, or changing one when the regulator
reissues it, is an INSERT.

```
GET /api/returns
GET /api/returns/:code?asAt=            point-in-time templates
GET /api/returns/:code?from=&to=        period templates
GET /api/returns/:code/definition
PUT /api/returns/:code                  load or replace, admin only
```

**No official form ships.** The only template in the migration is a sample,
flagged `is_official = false`, and every render says which it is looking at.
The line items of a real return are a legal document; this system has not
read one. Load yours with `cli returns:load --file`.

Expressions are tokenised and walked, never handed to `eval` or
`new Function`. A template is data, data gets edited by whoever
administers the tenant, and giving an editable string to the JavaScript
engine is how a reporting form turns into remote code execution. Division
by zero yields null rather than Infinity, and a reference to a line the
form does not define is refused at load time rather than at render time.

## The back office console

Served at `/console` from `public/`: sign-in with MFA, member and loan
lookup, teller postings, the reports, provisioning, the close, and returns.

Plain JavaScript, no build step, no framework, no CDN. What is on disk is
what runs, which matters for software somebody may have to audit. The
console is an ordinary API client on the same origin: it holds no secrets,
every action goes through the same endpoints with the same role checks, and
the page is served under a self-only Content-Security-Policy with no inline
script or style, so a cross-site payload in a member's name has nowhere to
execute.

Tokens live in memory; only the refresh token is kept, in `sessionStorage`,
so a reload does not sign a teller out mid-transaction and nothing survives
the tab. `test/console.test.js` drives it in a real Chromium and fails on
any page error, which is the one class of bug server-side tests cannot see.

## The member portal

Served at `/portal` from `portal/`. The screens are the Qona-MBS client's;
everything behind them is new.

**Activation, not registration.** A member exists because the SACCO admitted
them. The portal lets an existing member claim their record by presenting
the member number, the national ID on file and their phone number, then
choosing a PIN. Every mismatch returns the same error, so the form does not
say which of the three was wrong. A record with no phone on file takes the
presented one, which is how members admitted before phones were captured
get on without a branch visit.

**PIN sign-in with a lockout that survives.** Five wrong PINs lock the
credential for fifteen minutes. The lockout and every attempt are written
before the refusal, and the refusal is returned rather than thrown, because
throwing inside the transaction would roll the lockout back with it
(`memberAuth.refuse`). Refresh tokens rotate; a replayed one revokes the
whole family, same as staff sessions. A PIN change signs out every other
device.

**Two populations that cannot cross.** A member token carries role MEMBER
and the member's id. `requireAuth` refuses it on every staff route, including
the ones that take no role list; `requireMember` refuses everything else.
Every portal query is filtered by the id in the token, and no portal
endpoint accepts a member id from the client.

```
POST /api/portal/auth/activate       { memberNo, nationalId, phone, pin }
POST /api/portal/auth/login          { phone, pin }
POST /api/portal/auth/refresh        { refreshToken }
POST /api/portal/auth/logout         { refreshToken, allDevices }
POST /api/portal/auth/pin            { currentPin, newPin }
GET  /api/portal/me
GET  /api/portal/accounts            savings, shares and loans in one list
GET  /api/portal/accounts/:no/transactions?offset=&limit=
GET  /api/portal/loans/:no/schedule
GET  /api/portal/stats
GET  /api/portal/transfers/lookup?phone=
POST /api/portal/transfers/own       { fromAccountId, toAccountId, amount }
POST /api/portal/transfers/internal  { recipientPhone, amount, description }
GET/POST/DELETE /api/portal/beneficiaries
```

A recipient lookup returns a first name, an initial and a masked account
number: enough to confirm the right person, not enough to enumerate the
membership. Transfers use the same `savings.transfer` as the teller, so the
pledged-balance and minimum-balance rules apply to members exactly as they
do at the counter.

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

## Numbers this system refuses to invent

Three figures decide what a SACCO reports and how much capital it holds
back, and all three are set by regulation and by the society's by-laws
rather than by software. Each of them starts empty here, and the code
refuses to proceed rather than assume:

| Figure | Where it lives | What happens while it is unset |
|---|---|---|
| Provisioning rate per band | `provision_bands.rate_percent` | Preview and run are both refused |
| Statutory reserve share of surplus | `close_settings.statutory_reserve_percent` | A year cannot be closed |
| Prudential minimums | `prudential_limits.minimum` | Seeded, flagged UNVERIFIED, reported with a disclaimer |

Return line items are the same idea one level up: the engine is here, the
official forms are not.

## Not done yet

1. **Return templates are yours to load.** The engine, the storage and the
   renderer are done and tested; no official SASRA form ships with it.
2. **No mobile money and no SMS.** The portal moves money between members'
   savings accounts; it cannot yet take a deposit from M-Pesa or send one
   out, and nobody is notified of anything.
3. **Dividends and provisioning do not talk to each other.** A surplus
   distributed before provisioning is recognised is a real risk and nothing
   here enforces the order. Accepted for now.
4. **Non-calendar financial years open by hand.** `ensureFinancialYear`
   opens calendar years only; a July to June SACCO uses `cli year:open`
   with explicit dates.

## Before real member data

Kenya's Data Protection Act 2019 and SASRA reporting both apply. At minimum:
encryption at rest, per-tenant backup and tested restore, retention policy on
`audit_log`, and a documented breach process. The isolation tests here are
evidence for the first question an auditor asks, not an answer to all of them.

Specific to the figures above: before anything is filed or any member is
told what they are owed, somebody with the current regulations open has to
enter the provisioning rates, the statutory reserve percentage and the
prudential minimums, and load the real return templates. The system is
built so that forgetting is loud rather than silent, but it cannot do that
part for you.
