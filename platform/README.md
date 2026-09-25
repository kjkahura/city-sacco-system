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
    schedule.js        the schedule engine: dates, rates, interest types, lines
                       (pure functions, no database)
    ledger.js          the loan core: reading a loan with its product,
                       balances, the override list, accounting rules
    installments.js    drawing, previewing and redrawing schedules; spreading
                       payments over installments
    interest.js        accrual by product type and interest type, capitalising
    eligibility.js     guarantors, cover, the rules checked at approval
    controls.js        tenant lending controls, user approval and
                       disbursement limits
    productTypes/      one strategy per product type (FIXED_TERM with
                       INTEREST_FREE, DYNAMIC_TERM, TRANCHED, REVOLVING)
                       and the dispatcher, index.js
    loans.js           application, disbursement, repayment, reversal,
                       account numbering
    writeOffs.js       write-off against the allowance, recoveries from the
                       member, guarantors and collateral, and their reversal
    productAccounting.js  which GL mappings a product's settings require
    accruals.js        interest accrual postings: per account or aggregated,
                       daily or monthly
    accountingChanges.js  changing a product's accounting method in use
    branches.js        branches, inter-branch rules, closures, moving accounts
    savings.js         deposits: legs across zero, fees, interest, overdrafts
    fees.js            product fees of every type, applying, waiving, settling
    workflow.js        states and undo, amendments by state, arrears, cap on
                       charges
    restructure.js     reschedule, and top-ups as applications: request,
                       quote, and the payout that settles the old loan
    tranches.js        tranched disbursement
    revolving.js       revolving credit billing and credit balance deposits
    securities.js      collateral assets alongside guarantors
    tax.js             value-added tax on interest, fees and penalties
    funding.js         funding sources (peer-to-peer lending)
    penalties.js       late payment charges on Mambu's four bases, waiver
    provisioning.js    loan loss provisioning by PAR band
    reports.js         balance sheet, income statement, prudential, PAR
    returns.js         regulatory return engine, templates held as data
    shares.js          share capital and the dividend cycle
  ops/
    eod.js             end-of-day jobs, idempotent per business date
    backup.js          pg_dump per tenant, retention, restore verification
    crypt.js           AES-256-GCM streaming encryption, key ring, rekey
    offsite.js         dir and command drivers for shipping backups
    scheduler.js       in-process timer behind a Postgres advisory lock
  routes/              auth, members, loans, loanProducts, depositProducts, branches, savings, shares,
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
test/product-types.test.js 48 assertions
test/loan-config.test.js   135 assertions
test/loan-extensions.test.js 74 assertions
test/console.test.js       25 assertions, real browser, npm run test:browser
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
POST /api/loans/:id/write-off          request; /write-off/approve|reject
GET  /api/loans/write-offs             the written-off register
POST /api/loans/:id/recoveries         money recovered after a write-off
POST /api/loans/:id/guarantors/:gid/recover|release-call
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
`CALLED` rather than released on write-off. A called pledge keeps the
guarantor's deposits committed until it is recovered from them or the call
is released (see Write-offs and recoveries).

**The eligibility rule** is `principal <= deposits * product.max_multiplier`,
the "three times your savings" convention.

**Due dates** on a weekend or a day in the `holidays` table follow the
product's `non_working_days` rule, after Mambu's "Installments on
Non-Working Days":

| Rule | What happens |
|---|---|
| `MOVE_FORWARD` (default, and what every product did before) | due on the next working day |
| `MOVE_BACKWARD` | due on the previous working day, never on or before the disbursement or the previous installment (then forward) |
| `DO_NOT_RESCHEDULE` | due on the day as drawn |
| `EXTEND_SCHEDULE` | that installment and every later one move one repayment period on; the loan runs longer by the periods skipped, and the installment after a gap carries interest for both periods |

The nominal date an installment was drawn on is kept beside its due date,
and interest runs on nominal dates, except under `EXTEND_SCHEDULE`, where
the nominal dates themselves move. A revolving loan's bill under a rule
other than forward or backward moves forward, and a revolving product
cannot take `EXTEND_SCHEDULE`.

The invariant the test suite asserts after *every single operation*,
corrections included: the trial balance still balances.

## Product accounting: the switch, deposits, branches and closures

Accounting belongs to the product, after Mambu's "Linking Products to
Accounting". Every loan product and every deposit product has:

| Setting | Values | What it does |
|---|---|---|
| `accounting_method` | `NONE`, `CASH`, `ACCRUAL` | NONE: the product's own accounts are never posted; the cash side of each movement goes against the tenant's suspense account (`290-900`), so the till still reconciles. CASH: income and expense when money moves. ACCRUAL: through receivables and payables. |
| `interest_accrued_accounting` | `NONE`, `DAILY`, `MONTHLY` | When accrued interest reaches the ledger under ACCRUAL (Mambu's "Interest Accrued Method"). CASH and NONE force NONE; ACCRUAL with NONE recognises interest when paid while fees and penalties still go through their receivables. On loans this is separate from `interest_accrual`, which says when interest is added to what the member owes. |
| `accrual_granularity` | `PER_ACCOUNT`, `AGGREGATED` | One accrual entry per account, or one per product and branch per day (Mambu's default), with the per-account lines kept behind it (`GET /api/accounting/accruals/:entryId`). |

**The GL mappings a product needs are derived, not listed.** The catalogue
in `src/domain/productAccounting.js` says, for each financial resource,
which account types it takes and when the product uses it: receivables and
payables under ACCRUAL, Taxes Payable when a tax or withholding tax is set,
the overdraft accounts when overdrafts are allowed, the negative interest
accounts when negative rates are. Saving a product refuses a resource it
needs and lacks (`MISSING_ACCOUNTING_RULE`), a resource it cannot use
(`NOT_REQUIRED_ACCOUNTING_RULE`), a header account
(`HEADER_GL_ACCOUNT_NOT_ALLOWED`) and an account of the wrong type
(`INVALID_RULE_GLACCOUNT_TYPE`), the names Mambu's API uses. Every change of
mapping is kept in `product_gl_mapping_history` (`GET
/api/loan-products/:id/gl-mapping-history`, and the same for deposits);
postings always read the current mapping, so a change applies from then on.

### Deposit products

`GET/POST/PATCH /api/deposit-products`, with `/:id/fees` and `POST
/accounting-rules` (the mappings a set of settings would need, before it is
saved). A deposit product carries:

- **Interest**: `interest_paid_into_account` (off unless switched on, so an
  upgraded tenant does not start paying interest nobody configured), annual
  rate, `END_OF_DAY` or `MINIMUM` balance, `ACTUAL_365`, `ACTUAL_360` or
  `THIRTY_360`, applied `MONTHLY`, `QUARTERLY`, `SEMI_ANNUAL` or `ANNUAL` on the
  period's last day, a minimum balance to earn it, and negative rates when
  allowed. Interest accrues to six decimal places so the sub-cent remainder
  carries into the next period.
- **Withholding tax**: a percentage of interest applied, shipped unset.
- **Overdrafts**: authorised (a product maximum and an account limit, with
  its own annual rate) and technical (charges the system applies when there
  is no money). A withdrawal is held to the authorised limit; the floor
  trigger on `savings_accounts` refuses anything below it unless the product
  allows technical overdrafts.
- **Fees**: `MANUAL` and `MONTHLY`, each with its own income account if it
  wants one.

| Transaction | Debit | Credit |
|---|---|---|
| Deposit | Transaction Source (channel) | Savings Control, or Overdraft Portfolio for the overdrawn part |
| Withdrawal | Savings Control, then Overdraft Portfolio below zero | Transaction Source |
| Fee | Savings Control (Overdraft Portfolio below zero under accrual) | Fee Income |
| Interest accrued (ACCRUAL) | Interest Expense | Interest Payable |
| Interest applied | Interest Payable (what was accrued) and Interest Expense (the rest) | Savings Control |
| Withholding tax | Savings Control | Taxes Payable |
| Negative interest accrued, applied | Neg. Interest Receivable; Savings Control | Neg. Interest Income; Neg. Interest Receivable |
| Overdraft interest accrued, applied | OD Interest Receivable; Overdraft Portfolio | OD Interest Income; OD Interest Receivable |
| Overdraft write-off | OD Write-off Expense | Overdraft Portfolio (and OD Interest Receivable) |

Under CASH, overdraft interest and fees applied to an overdrawn balance are
owed but not yet income (`od_interest_due`, `od_fees_due`); the next deposit
pays them first and recognises them then. Mambu's accrual table books
"interest applied" as Dr Interest Expense, Cr Savings Control, the same as
cash; here the application clears the payable explicitly, so the expense is
recognised once.

Accounts: `POST /api/savings/:id/fees`, `PUT /:id/overdraft`, `POST
/:id/overdraft/write-off`, `POST /:id/interest` (accrue to a date, and apply
with `apply: true`), `POST /:id/branch`.

### Branches, inter-branch rules and closures

Every account carries a branch (its member's when opened) and every journal
line carries the branch it belongs to. An entry balances in each branch:
when money for an account at one branch is handled at another (`branchId` on
a deposit, withdrawal, disbursement or repayment), `accounting.post` squares
the two through the inter-branch account named by the rule for that pair, or
the default rule, and refuses with `NO_INTER_BRANCH_GL_ACCOUNT` when there
is none. `POST /api/loans/:id/branch` and `/api/savings/:id/branch` move an
account and its balances. The trial balance takes `?branchId=` and reads a
per-branch rollup.

`POST /api/accounting/closures` closes the book through a past date, for
every branch or one; the date must follow the closure already covering that
scope. Nothing may be dated on or before a closure: `accounting.post`
refuses early with `JOURNAL_ENTRY_BEFORE_CLOSURE`, and triggers on
`journal_lines` and `transactions` refuse at the database, so a product not
linked to accounting (which writes no journal) is held to the same line.
`DELETE /api/accounting/closures/:id` removes one, kept on record as
deleted, when something has to be backdated. `PUT /api/accounting/settings`
switches on automatic closures every N days. The year-end sweep is exempt:
it is dated on the year's last day, which a closure has usually covered by
the time the year is closed.

### Changing the accounting method of a product in use

A plain edit cannot change the method of a product that has accounts
(`ACCOUNTING_METHOD_CHANGES_THROUGH_CHANGE_ACTION`). `POST
/api/loan-products/:id/accounting-method` and `/api/deposit-products/:id/
accounting-method` take the new method, GL accrual method, any new mappings
and a reason. The change needs the previous month closed tenant-wide, is
booked today with one entry per account, and converts what is open so
nothing is stranded:

| From | To | What is booked |
|---|---|---|
| ACCRUAL | CASH or NONE | Receivables and payables built by accrual reversed against income or expense |
| CASH or NONE | ACCRUAL | What is owed at the change booked into them |
| CASH or ACCRUAL | NONE | Portfolio and deposit balances moved to suspense |
| NONE | CASH or ACCRUAL | And back from it |

Pending accruals are posted first, so the conversion reads booked figures.
The change is kept in `product_accounting_changes` with the amounts per
account (`GET .../accounting-changes`) and in the audit log.

### Loans, completed against the same rules

- A fee may name its own write-off account; paying a fee credits that fee's
  receivable (its income, under cash), and writing a loan off clears each
  fee against its own receivable and write-off account.
- A loan with capitalised amounts cannot be rescheduled or refinanced into a
  product on another method (`CAPITALIZED_AMOUNTS_NOT_ALLOWED_DUE_TO_DIFFERENT_ACCOUNTING`).
- A funded loan product uses ACCRUAL or NONE; a funding deposit product uses
  NONE or CASH, and earns no interest and cannot be overdrawn.

## Loan products and their accounting

A product is the template every loan under it follows, and the whole of
Mambu's loan product form is here: identity and numbering, type and
interest method, interest type, rate and its bands, amount and term,
repayment interval and grace, balloon and rounding, arrears and penalties,
the cap on charges, internal controls, fees, eligibility, allocation order,
and accounting. `GET/POST/PATCH /api/loan-products` manages products,
`/api/loan-products/:id/fees` their fees, and
`POST /api/loan-products/:id/schedule-preview` draws the schedule a loan
would get. The console's Products screen opens each product to its settings
and fees.

Changing a product does not touch loans already running: the rate and type
are copied onto the loan at application and the schedule is drawn at
disbursement. GL mappings and the accounting method are read live, so a
wrong mapping can be corrected. The settings that decide how interest is
computed (type, method, interest type, posting, rate frequency, day count,
repayment interval) are frozen once a loan exists under the product, and the
product type is frozen from creation: a SACCO that needs different
arithmetic creates a new product. Every setting has a default that
reproduces the behaviour before it existed, so an existing product is
unchanged until somebody edits it.

### What a loan may carry of its own

Most settings belong to the product and are read from it every time. A
short declared list, `OVERRIDES` in `src/domain/ledger.js`, names the ones a
loan may hold its own value for, and says how each behaves:

| Override | Loan column | Mode | Band on the product | Only for |
|---|---|---|---|---|
| `monthlyRate` | `monthly_rate` | SNAPSHOT | `rate_min`, `rate_max` | not INTEREST_FREE |
| `firstDueOffsetDays` | `first_due_offset_days` | SNAPSHOT | `first_due_offset_min/max` | |
| `penaltyRate` | `penalty_rate` | INHERIT | `penalty_rate_min/max` | |
| `gracePeriods` | `grace_periods` | INHERIT | fewer than the installments | |
| `amortizationPeriods` | `amortization_periods` | INHERIT | at least the installments | |
| `arrearsToleranceDays` | `arrears_tolerance_days` | INHERIT | | |
| `arrearsTolerancePercent` | `arrears_tolerance_percent` | INHERIT | | |
| `revolvingRepaymentValue` | `revolving_repayment_value` | INHERIT | | REVOLVING |
| `orgCommission` | `org_commission` | INHERIT | `org_commission_min/max` | funded products |

SNAPSHOT values are copied from the product when the loan is opened and do
not move after that. INHERIT values stay NULL on the loan unless someone
sets them, and NULL means "use the product's value as it is now", so
editing the product changes every loan that has not set its own. Clearing
an INHERIT value hands it back to the product; a SNAPSHOT value cannot be
cleared. Application and amendment validate against the same list, the
loan read (`ledger.effective`) resolves from it, and set-based SQL such as
the arrears and penalty jobs uses `ledger.overrideSql`, so the four cannot
disagree. Adding an override is one entry in the list plus its column.

### How the loan modules depend on each other

Each module requires only modules below it, at the top of the file:

    accounting, schedule
    tax, savings, controls
    ledger
    eligibility, funding, tranches
    productTypes
    securities
    workflow
    fees, penalties
    installments, writeOffs
    interest
    revolving
    loans
    restructure

`test/loan-structure.test.js` fails if a cycle or a require inside a function
comes back. `loans.js` re-exports the lower modules' functions under their
old names, so routes, the EOD job and older tests use one import.

### Product types are strategies

Everything that depends on a loan's product type is in `src/domain/productTypes/`,
one file per type:

    fixedTerm.js     FIXED_TERM and INTEREST_FREE: the schedule is the contract
    dynamicTerm.js   DYNAMIC_TERM: interest on the actual balance, redraws
    tranched.js      TRANCHED: dynamic term paid out in planned parts
    revolving.js     REVOLVING: a limit drawn and repaid at will
    index.js         forLoan(l) picks the strategy; the contract is documented here

Disbursement, repayment, reversal, interest accrual, fee placement,
restructuring and the EOD fee run ask the loan's strategy (`types.forLoan(l)`)
questions such as `disbursesAgain`, `disbursementAmount`, `afterDisbursement`,
`beforeRepayment`, `installmentScope`, `closesWhenPaid`, `accrualWindow`,
`accrualBase` and `dailyAccrual`, instead of testing `product_type`. Dynamic
term, tranched and revolving build on the fixed-term object and override only
what differs, so the differences between types can be read side by side.

The strategy files require only accounting, schedule, ledger and tranches.
Hooks that need the lifecycle above them (drawing a schedule, accruing,
redrawing, fees) receive those operations as `ops` from `loans.js`. Adding a
product type is a new file, a line in `BY_TYPE` and the value in the product
enum. `test/loan-structure.test.js` checks that every offered type has a
strategy that fills every hook, that the strategy files stay in their layer,
and that none of the lifecycle modules tests the type directly.

The product validation in `routes/loanProducts.js`, the override list in
`ledger.js` and the tranche guard in `tranches.js` still name product types:
they sit below or beside the strategies and describe what a product may be
configured with, not how a loan behaves.

### The configuration, setting by setting

| Area | Settings | Notes |
|---|---|---|
| Numbering | `id_pattern`, `id_mode` | `#` digit, `@` letter, `$` either, other characters literal. INCREMENTAL fills the `#` run from a counter shared by every product using the same prefix, so `LN######` continues the existing LN series; RANDOM draws each placeholder. |
| Initial state | `initial_state` | PENDING_APPROVAL, or PARTIAL_APPLICATION for a product whose applications need documents before they can be judged. |
| Type and method | `product_type`, `method` | FIXED_TERM, DYNAMIC_TERM, INTEREST_FREE, TRANCHED, REVOLVING; FLAT, REDUCING, REDUCING_EQUAL_INSTALLMENTS. See below. |
| Tranches | `max_tranches` | TRANCHED: the most parts a loan may be paid out in. |
| Revolving | `revolving_repayment_method/value/floor/ceiling`, `credit_balance_enabled`, `max_credit_balance`, `gl_credit_balance` | REVOLVING: how each billed installment's principal is set (flat, % of outstanding, % of total due) and whether overpayments are held on the loan. |
| Securities | `enable_guarantors`, `enable_collateral` | Which securities the product takes; both count towards the required cover. |
| Tax | `tax_rate_percent`, `tax_method`, `tax_on_interest/fees/penalties`, `gl_tax_payable` | EXCLUSIVE adds the tax on top for the member to pay; INCLUSIVE splits the quoted figure. Booked to Taxes Payable. A fee may be marked non-taxable. |
| Funding | `funding_enabled`, `funder_allocation`, `org_commission` (+ band), `funder_rate_default` (+ band), `lock_funds_at_approval` | FIXED_TERM and DYNAMIC_TERM products, ACCRUAL or NONE accounting. |
| Interest type | `interest_type`, `simple_base` | SIMPLE (linear), CAPITALIZED (applied interest joins the principal, Dr Portfolio Cr Income, and is repaid as principal; on Declining Balance every installment but the last is interest only and the principal falls due at the end), COMPOUND (daily exponential on the effective annual rate; the annuity uses the periodic compound rate), COMPOUND_DAILY_REST (the nominal rate over the days in the year, each day's interest earning interest the next day; the monthly payment is PMT(daily, months/12 x days, -P) x days/12). SIMPLE on a dynamic equal-installment product may run on principal and unpaid interest. Compound types are not available on FLAT or REVOLVING products. Figures reproduce Mambu's worked examples to the cent. |
| Posting | `interest_posting` | ON_REPAYMENT, or ON_DISBURSEMENT for a fixed-term product that applies the whole term's interest on day one. |
| Rate | `monthly_rate`, `rate_frequency`, `rate_min`, `rate_max` | The rate is quoted PER_MONTH, PER_YEAR, PER_WEEK or PER_DAY; a loan may take a rate inside the band. |
| Amount and term | `min/default/max_principal`, `min/default/max_term` | Bands checked at application and amendment. `term_months` on a loan is the number of installments. |
| Interval | `repayment_interval_unit/count`, `fixed_days_of_month`, `short_month_handling`, `first_due_offset_days` (+ band) | Every n months, weeks or days, or on fixed days of the month (payday: 1 and 15) with the 29th to 31st moved to the last day or the 1st of the next. |
| Grace | `grace_type`, `grace_periods` | PRINCIPAL: interest-only installments first. PURE: nothing due for those installments, their interest spread over the rest; stored as GRACE lines that never go overdue. |
| Balloon | `amortization_periods` | Amortise as if over this many periods; the last scheduled installment carries the balance. |
| Rounding | `rounding` | NONE, WHOLE, WHOLE_UP, applied to each payment. |
| Leftover principal | `residual_installment` | LAST (default) or FIRST: which installment takes the principal left over by a longer first period or by rounding. The annuity is priced on a regular period. |
| Non-working days | `non_working_days` | MOVE_FORWARD (default), MOVE_BACKWARD, DO_NOT_RESCHEDULE, EXTEND_SCHEDULE. See the due dates note above. |
| Arrears | `arrears_tolerance_days`, `arrears_tolerance_percent`, `arrears_tolerance_floor`, `arrears_count_from`, `arrears_non_working_days` | A loan stays ACTIVE for the tolerance days (working days only, if so set); a shortfall under the greater of the percentage of outstanding and the floor is a partial payment, not arrears. Days in arrears count from the oldest late installment or from when the loan first went into arrears. |
| Penalties | `penalty_rate` (+ band), `penalty_basis`, `penalty_tolerance_days` | Daily rate on OVERDUE_PRINCIPAL, OVERDUE_PRINCIPAL_INTEREST, OVERDUE_ALL or OUTSTANDING_PRINCIPAL, or NONE; applied once the tolerance lapses, for every late day. A loan may carry its own rate inside the band. |
| Cap on charges | `charge_cap_percent`, `charge_cap_base`, `charge_cap_mode` | When interest, fees and penalties charged since the loan went into arrears reach the percentage of the original or outstanding principal, the loan is LOCKED: HARD refuses the charge that would cross the line, SOFT applies it first. Ships unset; the in duplum position is 100% of outstanding principal, HARD. |
| Controls | `auto_lock_arrears_days`, `allow_arbitrary_fees` | Per product. Tenant-wide controls are separate, below. |
| Accounting | `accounting_method` | ACCRUAL, CASH, or NONE: balances kept, no journal entries, no GL accounts needed. |

### Fees

`loan_product_fees` holds a product's fees, after Mambu's "Loan Fees
Setup". Each says when it happens and how much:

| `fee_type` | When | `calculation` |
|---|---|---|
| MANUAL | a user applies it when the event occurs | FLAT (amount may be left to the teller), PERCENT_OF_AMOUNT |
| DISBURSEMENT_DEDUCTED | taken out of what the member receives | FLAT, PERCENT_OF_AMOUNT |
| DISBURSEMENT_CAPITALIZED | added to what the member repays | FLAT, PERCENT_OF_AMOUNT |
| DISBURSEMENT_UPFRONT | due at disbursement, paid with a later payment (first installment on a fixed-term loan, at once on a dynamic one) | FLAT, PERCENT_OF_AMOUNT |
| PAYMENT_DUE | on the schedule, one share per installment; applied at disbursement on a fixed-term loan, on each due date on a dynamic one | FLAT, FLAT_PER_INSTALLMENT, PERCENT_OF_AMOUNT, PERCENT_PER_INSTALLMENT |
| LATE_REPAYMENT | once per installment that goes overdue | FLAT, PERCENT_OF_AMOUNT, PERCENT_OF_INSTALLMENT_PRINCIPAL |

Each fee is Required or Optional (optional ones are named at
disbursement), has a min and max, and may name its own income and
receivable accounts. Applying a fee writes a `loan_fees` row, raises
`fees_due`, and under accrual books Dr Fee Receivable, Cr Fee Income
(deducted and capitalised fees credit income in the disbursement entry
itself). Waiving reverses the open part. A fee that has been applied can be
deactivated and repriced but not deleted or retyped. The legacy
`processing_fee` column is an upfront flat fee called "Processing fee".
Arbitrary fees (any name, any amount) need `allow_arbitrary_fees`.

### The life cycle

After Mambu's "Loan Account Life Cycle and States". Every step is a
`loan_state_history` row and a `POST /api/loans/:id/<action>`:

```
PARTIAL_APPLICATION --request-approval--> PENDING_APPROVAL --approve--> APPROVED --disbursements--> ACTIVE <--> IN_ARREARS
        ^                                       |                          |                            |
        +-------------set-incomplete------------+        undo-approve      |                    lock / unlock: LOCKED
reject / undo-reject, withdraw / undo-withdraw close and reopen an application (and an approved loan may be withdrawn)
repayments in full: CLOSED_REPAID    write-off: CLOSED_WRITTEN_OFF    reschedule / refinance: CLOSED_RESCHEDULED / CLOSED_REFINANCED
```

`PATCH /api/loans/:id` amends a loan: the terms (amount, installments,
rate, penalty rate, first due offset, grace, amortisation, arrears
tolerance, each inside the product's band) while the application is open;
only purpose and notes once approved. To change the terms of an approved
loan, undo the approval. Undoing a disbursement is the reversal of the
disbursement transaction, which removes the schedule and the fees it
created.

Approval is one step, guarded by the product's eligibility rules, the
tenant's exposure controls and the approving user's `approval_limit`
(`platform.users`); disbursement by the user's `disbursement_limit` and,
when the tenant's `two_man_rule` is on, by the rule that the approver may
not disburse. The loan records `approved_by` and `disbursed_by`.

`lending_controls` (`GET/PATCH /api/loans/controls`, TENANT_ADMIN) holds
the tenant-wide controls from Mambu's "Internal Controls": maximum
exposure per member (UNLIMITED, SUM_OF_LOANS, SUM_MINUS_DEPOSITS with an
amount), one active loan per member, minimum days in arrears before a
write-off, the window for undoing a closure, and the two-man rule, all off
by default; and whether a write-off needs a second person's approval, on
by default.

A LOCKED loan accrues nothing and takes no repayment until unlocked. A lock
for the charge cap lifts only once the charges are paid or the loan is out
of arrears; a manual lock lifts when a manager says so.

### Reschedule and refinance (top-up)

`POST /api/loans/:id/reschedule` closes the loan and opens a new one under it
(`parent_loan_id`) at once, with new installments and optionally a new rate
or product. It is a management decision on a loan in difficulty and no new
money leaves.

A top-up is new money, so it goes through the application life cycle:

1. `POST /api/loans/:id/refinance` with `topUp` (what the member asks to
   receive) or `principal` (the gross new loan), `termMonths` and
   optionally `productId`, `arrears` and the product's overrides. It opens
   an application with `refinance_of` pointing at the running loan. Its
   principal is what settling that loan costs now plus the top-up. The
   old loan keeps running, and only one top-up per loan may be in flight.
   A teller may record the request.
2. `POST /api/loans/:appId/approve` is the ordinary approval. Eligibility
   is judged on the gross principal: the deposit multiplier, guarantor
   cover (the old loan's pledges and collateral count, since they move
   across, and guarantors may be added to the application for the extra),
   the tenant's exposure controls (the old loan's balance is inside the new
   principal, so it is not counted twice, and one-active-loan does not
   block it) and the approver's limit. Approval is refused if the old loan
   is no longer running or settling it would leave nothing to pay out.
3. `POST /api/loans/:appId/disbursements` brings interest on the old loan
   to the day, settles it and pays the rest: top-up = approved principal
   minus settlement. The approved amount is the member's new loan; if the
   member repaid something in between, the top-up is larger by that much.
   The disbursing user's limit and the two-man rule apply to the top-up paid
   out. `GET /api/loans/:appId/refinance-quote` shows the figures first.

In both cases interest, fees and penalties owed are CAPITALIZED onto the new
principal or WRITTEN_OFF. The principal moves portfolio to portfolio in one
entry with no cash; a top-up leaves through the channel. Guarantors'
pledges and pledged collateral move to the new loan. Both accounts carry the
step in their history, and the old one is CLOSED_RESCHEDULED or
CLOSED_REFINANCED.

Not done yet for top-ups: qualification rules on the product (a minimum
share repaid, a minimum number of installments, no top-up in arrears),
disbursement or top-up fees on the new loan, paying the top-up into the
member's savings account instead of through a channel, and a top-up request
from the member portal.

### Write-offs and recoveries

A write-off is asked for and approved by different people:

- `POST /api/loans/:id/write-off` with a `reason` and optionally a
  `valueDate` records a request (a teller or loan officer may ask). The
  checks a write-off runs are made at once (the loan is running and owes
  something, the tenant's minimum days in arrears, the date), so a request
  that could never be approved is refused at the door. One request per loan
  may be pending; `GET /api/loans/write-off-requests` is the approvers'
  queue and `GET /api/loans/:id/write-off` a loan's requests.
- `POST /api/loans/:id/write-off/approve` (a manager) writes the loan off.
  The person who asked may not approve, and the amount must be within the
  approver's approval limit. `/write-off/reject` with a `note` declines it
  and the loan runs on.
- A tenant with a single manager may turn the second person off
  (`writeOffRequiresApproval: false` in the lending controls). The request
  is still recorded, approved by the same user, so the register reads the
  same.

A write-off may be dated back: not in the future, not before disbursement,
and not before the last repayment or disbursement on the loan. Interest on a
loan that accrues on the actual balance is brought to that date first;
interest already accrued past a back date stays owed and is written off with
the rest. The entry is booked on that date, so a closed period refuses it.

Written off, the loan is closed as CLOSED_WRITTEN_OFF. Each component is cleared against the account that
holds it: principal out of the portfolio, and under accrual the interest,
fee and penalty receivables. The principal is written off against the loan
loss allowance first, for the part of the allowance that stands for this
loan (its outstanding principal at its provisioning band's rate, capped by
what the allowance holds), and Loan Write-off Expense takes the rest. The
next provisioning run finds the loan gone and the allowance already lower
by its share, so nothing is released and charged twice. While the bands have
no rates, nothing is attributed and the expense takes it all.

Guarantors are called and collateral is seized. The loan keeps
`written_off_amount`, `written_off_on`, `written_off_by` and `recovered`.

Money recovered afterwards is income when it arrives, credited to the
product's Recoveries account (`gl_recoveries`, 400-400 by default), up to
what was written off:

- `POST /api/loans/:id/recoveries` with `amount`, `channelId` and `source`
  (MEMBER, COLLATERAL with a `collateralId` of seized collateral, or OTHER).
  Dr the channel, Cr Recoveries.
- `POST /api/loans/:id/guarantors/:gid/recover` takes a called guarantor's
  pledge (or part of it) from their deposits: Dr their savings, Cr
  Recoveries. Only deposits beyond their other commitments and the
  account's minimum balance can be taken; they need not be withdrawable.
  A called pledge keeps the guarantor's deposits committed until it is
  recovered in full (RECOVERED) or released.
- `POST /api/loans/:id/guarantors/:gid/release-call` forgoes the rest of a
  call and frees the deposits.

Reversing a recovery puts the money back where it came from and reopens the
call. Reversing the write-off is refused while any recovery stands; once
none does, the loan returns to the state it was in with its balances,
guarantors and collateral, and the allowance gets its share back.

`GET /api/loans/write-offs?from&to&branchId` is the register: every loan
written off in the period (by write-off date), with the amount split into
principal, interest, fees and penalties, the part the allowance took, who
asked, who approved and why, what has been recovered since (from guarantors
among it) and what is still owed. Totals cover the whole period, not the
page, and add the recoveries received in the period on loans written off at
any time. The console shows it under Reports as Written-off loans.



A TRANCHED product's loan is approved for one amount and paid out in parts
(`loan_tranches`: amount and expected date, set at application or with
`PUT /api/loans/:id/tranches`; they must add up to the principal and stay
within `max_tranches`, and approval refuses a loan whose tranches do not).
Each `POST /disbursements` pays the next planned tranche (the amount may be
lowered; upfront fees are charged with the first). The loan is ACTIVE from
the first tranche, interest runs on what has been disbursed, and each later
tranche redraws the future installments over the new balance.

### Revolving credit

A REVOLVING product's loan is a limit (`principal`) the member draws on and
repays for `term_months`. Drawdowns are `POST /disbursements` while ACTIVE,
up to limit − outstanding + credit balance. There is no schedule up front:
the `billRevolving` job generates an installment on each billing date (the
product's interval or fixed days of month) from the balance: principal by
`revolving_repayment_method` with its floor and ceiling, interest accrued
to the date, fees due. Arrears, penalties and late fees then work as on any
loan. A revolving loan does not close itself at zero; `POST /close` does,
and is refused while a credit balance stands. Interest keeps accruing on the
balance after the last billed installment, whether or not the product
accrues late interest, since a billing date is not a maturity. (Before the
strategy split a revolving loan with `accrue_late_interest` off treated its
last billed installment as maturity and stopped accruing there; that was a
bug.)

The credit balance (`credit_balance_enabled`) is the member's own money on
the loan: an overpayment lands there (up to `max_credit_balance`) instead of
in savings, `POST /credit-balance-deposits` tops it up, and the next
drawdown uses it first, owing nothing for that part. It is a liability
(`gl_credit_balance`). Restructuring and closing are blocked while it is
above zero, as in Mambu.

### Securities

Guarantors (members pledging deposits) and collateral assets
(`loan_collateral`: type, description, value, reference; `POST
/api/loans/:id/collateral`, `POST /api/loans/collateral/:id/release`) both
count towards `min_cover_percent` when `require_guarantor_cover` is on, and
`GET /eligibility` shows them. An asset cannot be released from a running
loan if that would leave it under cover; a write-off marks collateral
SEIZED, a payoff releases it. A product may take either, both or neither.

### Value-added tax

When a product taxes interest, fees or penalties, applying the charge books
Dr Receivable (gross), Cr Income (net), Cr Taxes Payable (tax) under
accrual; under cash the member's payment is split the same way. EXCLUSIVE:
the member pays the tax on top (1,000 of interest is owed as 1,160 at 16%).
INCLUSIVE: the quoted 1,000 is owed and 862.07 is income, 137.93 tax. The
loan's `tax_charged` says how much of what it is owed is tax.

### Funding sources

After Mambu's P2P lending (which Mambu withdrew from sale in 2022; the
mechanics are documented and reproduced here). A savings product flagged
`is_funding_account` makes funding accounts. A loan under a
`funding_enabled` product takes funders (`POST /api/loans/:id/funding`:
account, amount, rate under FIXED_COMMISSIONS) and cannot be approved until
funded to 100% with the money in place; at approval the funders' money is
locked (it counts as pledged) and, under FIXED_COMMISSIONS, the loan's rate
is set: commission + Σ(funder rate × share).

The principal is not the SACCO's asset: disbursement moves it from the
funders' accounts to the channel (no portfolio entry), each repayment
returns principal to them by share and their part of the interest, and
`LOAN_FUNDED` / `LOAN_REPAID_TO_FUNDER` transactions sit on their accounts.
The organisation's commission is its income and is accrued as such; fees
and penalties are its too. Reversing a repayment takes the money back.
Reproduces Mambu's worked examples (2.50 to the organisation, 30 + 1.75 and
70 + 4.08 to the funders on a 108.33 installment; 9.7% on the fixed-
commissions example). Funded loans are not rescheduled or refinanced here.

### The daily sequence, for loans

`billRevolving`, `accrueInterest`, `markArrears`, `accruePenalties`,
`applyFees` (a dynamic loan's payment-due fees on their dates, late fees on
installments that went overdue), `enforceControls` (lock at the cap or
after the product's days in arrears). Each is idempotent per business date.

### Product type decides what interest is

Mambu separates two things a single `method` column had run together here:
what kind of schedule a loan has, and how a period's interest is worked out
([Loan Product Types](https://docs.mambu.com/docs/loan-product-types/),
[Interest Calculation Methods in Loans](https://docs.mambu.com/docs/interest-calculation-methods-in-loans/)).
Before this the accrual read the actual balance for `REDUCING` and the
original principal for `FLAT`, whatever the product was meant to be, and a
prepayment never touched the schedule.

`product_type`, fixed once the product exists:

| Type | What the member owes | Prepayment | After the last due date |
|---|---|---|---|
| `FIXED_TERM` (default; everything existing) | The interest on the schedule drawn at disbursement, pro rata through the period in progress. Paying principal early does not lower next month's interest; paying late does not raise it. | Settles installments in order. Schedule unchanged. | Nothing more accrues: the schedule's total is the total. Penalties cover lateness. |
| `DYNAMIC_TERM` | Interest on the actual outstanding principal for the actual days, by the day count. | Settles what has fallen due; the rest reduces the balance and the future schedule is redrawn from it. | Keeps accruing if `accrue_late_interest` (default true), else stops at maturity. |

`method`, how a period is priced:

| Method | Mambu name | Period interest | Principal per period |
|---|---|---|---|
| `FLAT` | Fixed Flat | original principal × rate | equal shares |
| `REDUCING` | Declining Balance | outstanding × rate | equal shares |
| `REDUCING_EQUAL_INSTALLMENTS` | Declining Balance (Equal Installments) | outstanding × rate | payment − interest, the payment being the annuity on the principal |

`FLAT` on a `DYNAMIC_TERM` product is refused by the API and by a check
constraint: flat interest is charged on the original principal whatever the
balance does, which is the definition of a fixed schedule.

`prepayment_recalculation`, for dynamic products (Mambu's prepayment
recalculation): `REDUCE_INSTALLMENT_AMOUNT` (default) keeps the remaining
dates and spreads the new balance over them; `REDUCE_NUMBER_OF_INSTALLMENTS`
keeps the installment as it was and drops dates off the end;
`NONE` leaves the schedule as drawn. The first redrawn period starts on the
payment date, so its interest is the rest of the period on the new balance
plus any interest already accrued and unpaid. Reversing the payment puts the
disbursement schedule back and redraws from the balance as it then stands.
`loan_accounts.reschedule_count` and `rescheduled_at` say it happened.

Worked example, `test/product-types.test.js`: two 120,000 loans at 1% a
month over twelve months, each paying its first installment plus an extra
principal sum a month in. The fixed one accrues 1,100 the next month (the
schedule's figure on 110,000) and its interest stops at 7,800 however long
it runs; the dynamic one accrues 800 (1% of the 80,000 actually out), its
eleven remaining lines shrink to 7,272.73, or under
`REDUCE_NUMBER_OF_INSTALLMENTS` with equal installments the payment stays
10,661.85 and the loan ends three months early.

What this does not do: charge the remaining scheduled interest when a
fixed-term loan is settled early. Settlement pays what has accrued to that
day. A product that must recover the whole schedule on early settlement is
a setting still to be built, and a SACCO that wants early settlement to save
the member interest should use `DYNAMIC_TERM`.

### Interest accrues per day

As in Mambu, interest accrues daily
([Interest Calculation Methods in Loans](https://docs.mambu.com/docs/interest-calculation-methods-in-loans/)):
a member who repays early owes interest for the days they had the money, a
late payer keeps accruing (both on dynamic-term products; a fixed-term loan
accrues its schedule, above). Each loan records `accrued_through`; an accrual
books the days from there to the business date and moves the marker, so
running it twice for one date books nothing and running it after a missed
week books the week. The previous implementation booked one month per call,
and the nightly job called it nightly.

`interest_accrual` per product: `DAILY` (default), `MONTHLY` (booked on the
last day of the month, missed month-ends caught up), or `NONE`.

**Precision.** Each accrual works out the interest unrounded and adds the
fraction of a cent the previous run left (`interest_accrual_carry`); it
posts the whole cents and keeps the new fraction for the next run. The
interest posted therefore always equals the unrounded interest earned to
within half a cent, however many runs it took: 10,000 at 1% a month
accrues 100.00 over thirty daily runs (twenty days of 3.33, ten of 3.34),
where rounding each day used to give 99.90. This is Mambu's approach of
keeping accruals unrounded and rounding when posting ("Truncating and
rounding interest"). One difference: the arithmetic is JavaScript double
precision (about fifteen significant digits, far below a cent on any loan
amount) rather than Mambu's twenty decimals. Penalties carry their fraction
the same way (`penalty_accrual_carry`), and deposit interest was already
accrued unrounded and booked as the change in the rounded total.

**Currency decimals.** `accounting_settings.currency_decimals` is the
currency's minor units: 0 for UGX, RWF, JPY and the other currencies
without cents in use, 3 for the dinars, 2 otherwise, set from the tenant's
currency and changeable (`PUT /api/accounting/settings`). Amounts worked out
from a rate follow it: schedule lines, interest accrual and penalties. A
UGX loan's schedule is in whole shillings and its daily interest posts whole
shillings, carrying the fraction. Amounts people enter (disbursements,
repayments, fixed fees) are taken as entered; percentage fees and tax
splits still round to two decimals.

`day_count` per product, applied to the annualised rate (twelve times the
monthly rate):

| Convention | Behaviour |
|---|---|
| `THIRTY_360` (default) | 30E/360. Every calendar month is thirty days, so "1% a month" accrues to exactly 1% over any month and the accrued figure on an installment date equals the schedule. |
| `ACTUAL_365` | Mambu's default. Days that passed over 365. |
| `ACTUAL_360` | Days that passed over 360. |
| `ACTUAL_ACTUAL` | Each day is a fraction of its own year, leap years included. |
| `BUS_252` | Business days over 252: weekends and the days in the `holidays` table do not count. Brazil's convention; compound interest only, as in Mambu. |

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
2. `billRevolving`: generates the installment on every revolving loan whose
   billing date has come
3. `accrueInterest`
4. `accrueSavings`: deposit interest (positive, negative and overdraft)
   accrued through the date, applied on each product's application dates
   with withholding tax, and monthly deposit fees on the month's last day
5. `markArrears`
6. `accruePenalties`, which reads the arrears state the previous job produced
7. `applyFees`: a dynamic loan's payment-due fees on their dates, late fees on
   installments that went overdue
8. `enforceControls`: lock loans at the product's charge cap or after its
   days in arrears
9. `provision`, which reads the same arrears and posts only the movement
   since the last run. While the bands have no rates it records a skip, not a
   failure, so a tenant that has not configured provisioning does not fill
   the job log with red.
10. `postAccruals`: posts the accruals waiting for the day's end (aggregated
    products) or the month's end (monthly GL accrual)
11. `autoClosure`: closes the whole book through yesterday every N days, when
    the tenant has switched automatic closures on

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

Charged per installment per day, with a per-product rate (a loan may carry
its own, inside the product's band), a tolerance period, and Mambu's four
bases: `OVERDUE_PRINCIPAL`, `OVERDUE_PRINCIPAL_INTEREST`, `OVERDUE_ALL` (the
amount actually in arrears) and `OUTSTANDING_PRINCIPAL` (the whole remaining
principal, a penalty rate on top of the rate). A loan under a charge cap is
charged no further than the cap allows.

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
5. **Early settlement of a fixed-term loan charges accrued interest only.**
   Recovering the rest of the schedule on settlement is not a setting yet.
6. **Not modelled from Mambu's product form:** fee amortisation profiles
   (deferred fee income), index-linked rates, payment holidays, billing
   cycles distinct from due dates on revolving loans, refunds on revolving
   loans, and the secondary marketplace for funded loans. Auto-close of
   paid-off loans is moot: a paid-off loan closes at once.
7. **Deposit interest on catch-up days uses today's balance.** When the end
   of day misses days, each missed day is priced on the balance as it stands
   when it runs, and that is what `savings_daily_balances` records. A
   transaction backdated before an accrual does not re-price the days
   already accrued. Tiered deposit rates, fixed deposits with maturity, and
   Shari'ah profit-sharing products are not modelled.
8. **Taxes on loans are booked with the interest receivable.** Mambu keeps
   a separate Taxes Receivable account; here the member's tax sits in the
   interest (or fee) receivable, gross, and Taxes Payable carries the
   liability. The totals agree; the split is one account coarser.
9. **Funded loan products cannot change accounting method**, because the
   interest split with funders would have to be unwound per funder.
10. **Top-ups have no product rules or fees yet.** A minimum share repaid
    or installments paid before a top-up, a block while in arrears, fees on
    the new loan, payout into savings and a portal request are not built.
    A reschedule is still one step with no approval.

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
