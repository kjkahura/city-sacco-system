# SACCO Platform

Multi-tenant core banking for SACCOs. One Postgres schema per tenant.

No reference platform dependency. The API conventions carried over from the earlier work
(error envelope, offset/limit pagination, `detailsLevel`, `sortBy`, filter
operators) because they are sensible, not because the reference platform invented them.

```bash
cp .env.example .env          # set PGDATABASE and JWT_SECRET
npm install
npm run migrate               # platform schema, then every tenant
npm test                      # 240 assertions across five suites
npm start
```

## Audits and build logs

Each section is audited before it is built against the documentation of the reference platform: the published core banking system whose features and API conventions this platform follows. The audits and build logs are in [docs/audits](docs/audits/README.md), and each one is committed with the code it describes.

## Deploying

`docs/deploy.md` is the runbook for going live. GitHub Actions
(`.github/workflows/deploy.yml`) tests and deploys every push to `main`: the
container (`Dockerfile`) runs on Google Cloud Run in `europe-west1` with
Cloud SQL for PostgreSQL 16, Firebase Hosting (`firebase.json`) serves it, and
Cloudflare holds the custom domain's DNS.

## The console's navigation

The back office console has a top bar after the reference platform. The menus are:

- Dashboard
- Clients and Groups: by state
- Loans and Deposits: by account state
- Loan Transactions and Deposit Transactions: by type
- Activities
- Credit Arrangements: by state
- Products: loan products and deposit products
- Reporting: reports, custom views, report templates, regulatory returns and indicators
- Accounting: journal entries, the chart of accounts, the three statements, interest accruals, periods and year-end close, provisioning and branch accounting
- Administration

On the right are Tasks, Teller, Till and a cog that opens Administration. Administration has 16 tabs, from General Setup to Data. SMS, Email, Webhooks, Events Streaming and Apps show that they are being built.

`public/js/menuDef.js` holds every menu, entry and tab as data, with the permissions each needs. An entry the user may not open is hidden, and so is a menu left empty. The page and its filter are kept in the address hash (`#loans/IN_ARREARS`), so Back, a reload and a bookmark open the same page. The design is in `docs/superpowers/specs/2026-10-04-console-navigation-design.md`.

## Webhooks

After the reference platform's notifications (`docs/audits/audit-webhooks.md`).

- **What a webhook sends:** it sends a request to another system when an event happens: a deposit, a loan approval, a client approved, the end of day and about 50 others.
- **Where to set it up:** Administration > Webhooks. Each webhook has:
  - its event and an HTTPS URL;
  - POST, PUT or PATCH, and a JSON, XML or text body with `{{PLACEHOLDER}}`s;
  - optional conditions and headers;
  - basic authentication if needed;
  - a signing secret.
- **How events are captured:** database triggers (tenant migration 045) record them in the same transaction as the change, and only when an active webhook wants them.
- **How messages are delivered:**
  - only a `2xx` answer is delivered;
  - anything else is retried 1, 5, 15 and 60 minutes, then 3, 6, 12, 18 and 24 hours after the first try, then marked failed;
  - after 20 failures in a row the webhook pauses, and one message is tried every 10 minutes until one gets through.
- **What each request carries:**
  - `x-notifications-idempotency-key`, the same on retries and new on a resend;
  - `x-sacco-signature: t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>">`.
- **The communication log** keeps every message. Failed ones can be resent. Bodies are cleared after 180 days.
- **The API:**
  - `/api/templates`;
  - `/api/communications/messages` (`:search`, `:searchSorted`, `:resend`, `:resendAsyncByKeys`, `:resendAsyncByDate`);
  - `/api/notifications/messages` (v1);
  - `/api/notificationsettings/webhook`, the tenant-wide switch.
- **What runs the delivery:**
  - a pass after each request that changed something;
  - `cli notifications:run`, which the `sacco-notify` Cloud Run job runs every minute;
  - the in-process scheduler, every minute, when it is on.

## Events streaming

After the reference platform's Streaming API (`docs/audits/audit-events-streaming.md`).

- **What it is:** a feed of the SACCO's events that other systems read at their own pace, where a webhook pushes each event to one address.
- **Where to set it up:** Administration > Events Streaming.
  - **Streaming Templates:** a template has the webhook's event, conditions and body, without the URL, authentication or signing. It publishes to its topic, `sacco.event.<tenant>.streamingapi.<template name in snake case>`, which is fixed when the template is made.
  - **Subscriptions:** each subscription with its topics, committed offsets, unconsumed events and whether a stream is reading it.
- **Publishing:** the webhook dispatcher publishes a matching event to `stream_events` in the same pass that queues webhooks (tenant migration 046). Publishers take turns until they commit, so offsets become visible in order. Streamed events are not written to the communication log. They are kept for 7 days (`STREAM_RETENTION_DAYS`).
- **Who may read:**
  - API consumers and users whose role has `CONSUME_EVENT_STREAMS`, and administrators;
  - a subscription belongs to the consumer that made it: others get 404 for it, and 409 when they ask for the same application, consumer group and topics;
  - a user limited to some branches reads only those branches' events (row security on `stream_events`).
- **The API, at `/api/v1/subscriptions`:**
  - `POST /` creates a subscription (201), or returns the one with the same application, consumer group and topics (200). `read_from` is `begin`, `end` (the default) or `cursors` with `initial_cursors`;
  - `GET /:id/events` is the stream: newline-separated JSON batches, `{ cursor, events? }`, with the stream ID in the `X-Stream-Id` header;
  - `POST /:id/cursors` commits `items` with the stream's `X-Stream-Id`: 204 when all are committed, else 200 with `committed` or `outdated` for each;
  - `GET /:id/stats` gives unconsumed events and, with `show_time_lag=true`, the lag in seconds;
  - `DELETE /:id`.
- **A stream:**
  - one partition, `"0"`; an offset is the event's number padded to 18 digits; a cursor token is signed, so a commit can only be for what that stream was sent;
  - one stream reads a subscription at a time; a second gets 409. A stream that disconnects frees the subscription at once, and one not heard from for 10 seconds is freed too;
  - parameters: `batch_limit` (1), `stream_limit`, `batch_flush_timeout` (30 s), `stream_timeout`, `max_uncommitted_events` (10), `stream_keep_alive_limit` and `commit_timeout` (60 s, at most 60);
  - a stream ends after `STREAM_MAX_SECONDS` (55 by default, inside the hosting's 60-second request limit) or the shorter `stream_timeout`, and when a sent batch is not committed within `commit_timeout`. It reads the database four times a second, taking one of the tenant's request slots for each read rather than for its whole life, and writes no faster than the client reads. The client reconnects and reads on from its committed cursor, so nothing is lost;
  - delivery is at least once, so a consumer removes duplicates by the event's `eid`.

## Email

After the reference platform's email notifications (`docs/audits/audit-email.md`).

- **Settings (Administration > Email > Settings):**
  - each SACCO sends through its own mail server or provider: From Name, From Email, Reply-to, SMTP Host, SMTP Port, Transport Encryption (SSL/TLS on 465 or STARTTLS on 587), Username and Password;
  - the password is sealed like the webhook secrets and never returned;
  - the SMTP host must resolve to public addresses only, and the connection goes to the address checked; TLS is required with the certificate checked;
  - a test email reports whether the server connected, signed in and accepted the message, without saving;
  - email starts switched off; at most 60 emails a minute go out by default (`pacePerMinute`);
  - template users read the settings; only administrators change and test them.
- **Templates (Administration > Email > Email Templates):** type `EMAIL` in `/api/templates`, with the webhook's event and conditions, a subject, an HTML body and a recipient:
  - `CLIENT`: the member, or the group itself;
  - `CREDIT_OFFICER`: the loan's credit officer, else the holder's;
  - `GROUP_ROLE`: the group members holding `recipientRole`.

  Placeholder values are escaped for HTML, and a subject stays one line. A plain-text part is made from the HTML. The console's preview is a sandboxed frame.
- **Subscriptions:** opt-out templates reach members and groups until they unsubscribe; opt-in ones only those subscribed. Staff change them on the member's page (`/api/clients/:id/notification-subscriptions`), and members in the portal's Settings (`/api/portal/notifications`). They do not apply to credit officers or to manual email.
- **Delivery:** through the webhook dispatcher, as `EMAIL` messages in the communication log with their subject:
  - no address: `MISSING_EMAIL_RECIPIENT`, with no attempt;
  - switched off: `EMAIL_SERVICE_NOT_ENABLED`;
  - a refused sign-in: `INVALID_SMTP_CREDENTIALS`, failed at once;
  - any other failure: `MESSAGING_EXCEPTION` with the server's answer. A 4xx answer, a timeout or a network error is retried on the webhook schedule; a 5xx answer fails at once.
- **Manual email:** Send email on member, group, loan and deposit pages, or `POST /api/communications/messages:sendEmail` with `clientKey`, `groupKey`, `loanAccountKey` or `depositAccountKey`, and a `templateKey` or a `subject` and `body`. It goes to the holder's address and needs SEND_MANUAL_EMAIL (managers and administrators); changing a template's text before sending needs EDIT_COMMUNICATION_TEMPLATES.

## SMS

After the reference platform's SMS notifications (`docs/audits/audit-sms.md`). Pluggable: no company's gateway is built in.

- **Providers (`src/domain/notifications/channels/sms-providers/`):**
  - a provider is a module with fields, `validate`, `describe`, `server`, `send` and an optional `parseDeliveryReport` (see the README there);
  - the built-in one, `HTTP`, is a generic HTTPS gateway described by fields: the URL, method, body format, the header the API key goes in, a body template with `{{to}}`, `{{text}}`, `{{from}}` and `{{id}}`, where the answer carries the message ID, an optional success field, and how delivery reports are read;
  - most aggregators are set up from Administration > SMS > Settings with no code.
- **Settings:**
  - the provider, the sender ID (up to 11 letters and digits, or a number) and the pace (60 a minute);
  - the API key is sealed, never returned, and must be typed again when the gateway's address or key header changes;
  - the gateway URL passes the outbound guard;
  - a test SMS reports the gateway's answer;
  - template users read the settings; administrators change and test them.
- **Numbers and length:**
  - numbers go to the gateway in E.164, read from local forms with the tenant's country;
  - a message is at most six segments (GSM-7: 160 characters in one, then 153 a segment; UCS-2: 70, then 67).
- **Templates (Administration > SMS > SMS Templates):** type `SMS`, with the webhook's events and conditions, a plain text and a recipient (`CLIENT` or `GROUP_ROLE`). Credit officers have no phone number on record. The form counts segments.
- **Delivery:**
  - as `SMS` messages in the communication log, with the gateway's message ID and the segments;
  - no number: `MISSING_SMS_RECIPIENT`;
  - an unreadable number: `UNDEFINED_DESTINATION`;
  - switched off: `SMS_SERVICE_NOT_ENABLED`;
  - 401 or 403: `INVALID_SMS_GATEWAY_CREDENTIALS`;
  - other 4xx answers: `SMS_GATEWAY_ERROR`, failed at once;
  - 5xx answers and network errors: `SMS_GATEWAY_ERROR`, retried on the webhook schedule.
- **Delivery reports:**
  - an administrator makes the address (`POST /api/notificationsettings/sms:callbackToken`), `/hooks/sms/<tenant>/<token>`, shown once (`PUBLIC_BASE_URL` sets its host);
  - the gateway posts JSON or a form there;
  - the provider's fields say where the message ID and status are and which statuses mean delivered or not;
  - the log shows `deliveryStatus`.
- **Manual SMS:** Send SMS on member, group, loan and deposit pages, or `POST /api/communications/messages:sendSms`. It needs SEND_MANUAL_SMS (managers and administrators).
- **Subscriptions:** as for email, on the member and group pages and in the portal's Settings.

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
    loans/             application, disbursement, repayment, reversal,
                       account numbering: core.js, disbursement.js,
                       repayment.js, reversals.js; index.js keeps the one
                       public API
    writeOffs.js       write-off against the allowance, recoveries from the
                       member, guarantors and collateral, and their reversal
    productAccounting.js  which GL mappings a product's settings require
    accruals.js        interest accrual postings: per account or aggregated,
                       daily or monthly
    accountingChanges.js  changing a product's accounting method in use
    branches.js        branches, inter-branch rules, closures, moving accounts
    savings/           deposits: legs across zero, fees, interest, overdrafts,
                       limits, maturity, dormancy, rate changes, the account
                       life cycle (approval, lock, arrears, write-off, reopen):
                       core.js, funds.js, interest.js, transactions.js,
                       reversals.js, terms.js, lifecycle.js, daily.js (the
                       end of day); index.js keeps the one public API
    depositRules.js    what a deposit product gives its accounts: types, rates
                       on a day, days in a year, posting dates, the checks
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
    penalties.js       late payment charges on the four bases, waiver
    provisioning.js    loan loss provisioning by PAR band
    reports.js         balance sheet, income statement, prudential, PAR
    returns.js         regulatory return engine, templates held as data
    shares.js          share capital and the dividend cycle
    clients.js         members and groups: create, edit, the life cycle,
                       reassigning, deleting, anonymizing, group membership,
                       The reference platform's Client and Group shapes
    clientSetup.js     client and group types, ID patterns, group role names,
                       the client controls
    duplicates.js      the duplicate client checks
    memberFiles.js     member pictures and signatures, identification document
                       files, expiry flags
    accountNumbers.js  deposit, share and credit arrangement numbers from a
                       counter
    creditArrangements.js  credit arrangements (lines of credit): states,
                       linked accounts, the exposure checks the engine calls
    solidarityLoans.js solidarity group loans: one loan per member, opened
                       together for a group
    customFields.js    custom field sets, definitions, values, rights, search
    customFieldConfig.js  the reference platform's metadata shapes and
                       configuration as code for custom fields
    dataImport/        the Excel data import: definitions.js, parse.js,
                       execute.js, workbooks.js, lifecycle.js; index.js
                       keeps the one public API
  ops/
    eod.js             end-of-day jobs, idempotent per business date
    backup.js          pg_dump per tenant, retention, restore verification
    crypt.js           AES-256-GCM streaming encryption, key ring, rekey
    offsite.js         dir and command drivers for shipping backups
    scheduler.js       in-process timer behind a Postgres advisory lock
  routes/              auth, members, clients (/clients and /groups),
                       creditArrangements (/creditarrangements), loans,
                       loanProducts, depositProducts, branches, savings,
                       shares, accounting, reports, finance (provisioning,
                       periods, returns), portal (the member-facing API)
  lib/
    http.js            error envelope, filter operators, legacy slicing
    page.js            SQL-side paging: offset, limit, count(*) OVER ()
    searchCriteria.js  :search bodies as SQL over a map of fields
    ledgerScope.js     accounting reports for a branch-limited user
    limits.js          rate limiting and per-tenant concurrency gates
    ratestore.js       Redis-backed counters, memory fallback
    yaml.js            the YAML subset configuration as code reads and writes
    handlers.js        the route wrapper: tenant transaction, JSON reply,
                       status, paging headers
    errors.js          err(message, status), the error every layer throws
    dates.js           local and UTC calendar days as yyyy-MM-dd
    auditLog.js        recordAudit, the one writer of audit_log rows
public/                the back office console: index.html, styles.css, and js/
                       (ES modules: main.js the entry, base.js, ui.js,
                       nav.js, one module per page)
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

Deposit and share account numbers (`SA000001`, `SH000001`) come from a
counter per kind (`account_counters`), locked while a number is given out,
so accounts opened at the same time get different numbers; a number already
taken (by an import or by hand) is stepped over, and the six digits widen
instead of being cut (`SA1000000` follows `SA999999`). Numbers already given
did not change. `POST /api/savings/:id/close` closes an empty deposit
account (`CLOSE_SAVINGS_ACCOUNTS`): no balance, nothing accrued or owed, and
not a running loan's settlement account.

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
GET  /api/loans/:id/rates              rate periods and every change of rate
POST /api/index-rates, /:id/rates      index sources and their dated values
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
product's `non_working_days` rule, after the reference platform's "Installments on
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

Accounting belongs to the product, after the reference platform's "Linking Products to
Accounting". Every loan product and every deposit product has:

| Setting | Values | What it does |
|---|---|---|
| `accounting_method` | `NONE`, `CASH`, `ACCRUAL` | NONE: the product's own accounts are never posted; the cash side of each movement goes against the tenant's suspense account (`290-900`), so the till still reconciles. CASH: income and expense when money moves. ACCRUAL: through receivables and payables. |
| `interest_accrued_accounting` | `NONE`, `DAILY`, `MONTHLY` | When accrued interest reaches the ledger under ACCRUAL (the reference platform's "Interest Accrued Method"). CASH and NONE force NONE; ACCRUAL with NONE recognises interest when paid while fees and penalties still go through their receivables. On loans this is separate from `interest_accrual`, which says when interest is added to what the member owes. |
| `accrual_granularity` | `PER_ACCOUNT`, `AGGREGATED` | One accrual entry per account, or one per product and branch per day (the reference platform's default), with the per-account lines kept behind it (`GET /api/accounting/accruals/:entryId`). |

**The GL mappings a product needs are derived, not listed.** The catalogue
in `src/domain/productAccounting.js` says, for each financial resource,
which account types it takes and when the product uses it: receivables and
payables under ACCRUAL, Taxes Payable when a tax or withholding tax is set,
the overdraft accounts when overdrafts are allowed, the negative interest
accounts when negative rates are. Saving a product refuses a resource it
needs and lacks (`MISSING_ACCOUNTING_RULE`), a resource it cannot use
(`NOT_REQUIRED_ACCOUNTING_RULE`), a header account
(`HEADER_GL_ACCOUNT_NOT_ALLOWED`) and an account of the wrong type
(`INVALID_RULE_GLACCOUNT_TYPE`), the names the reference platform's API uses. Every change of
mapping is kept in `product_gl_mapping_history` (`GET
/api/loan-products/:id/gl-mapping-history`, and the same for deposits);
postings always read the current mapping, so a change applies from then on.

### Deposit products

`GET/POST/PATCH/DELETE /api/deposit-products`, with `/:id/fees` (and `DELETE
/:id/fees/:feeId` for a fee never applied) and `POST /accounting-rules` (the
mappings a set of settings would need, before it is saved). A product that
never had accounts is deleted (`DELETE_SAVINGS_PRODUCT`); one that had is
deactivated instead. A deposit product carries:

- **Type and category** (the reference platform): `productType` CURRENT_ACCOUNT (the only
  type with overdrafts and technical overdrafts), SAVINGS_ACCOUNT,
  FIXED_DEPOSIT, SAVINGS_PLAN or INVESTOR_ACCOUNT (a funding product), and a
  `category` label. A product given overdrafts without a type named is a
  current account, a funding one an investor account, the rest savings
  accounts; products saved before this took their type the same way.
- **New account numbers**: `idGeneratorType` INCREMENTAL_NUMBER (from the
  first number in `idPattern`, digits only) or RANDOM_PATTERN (`#` a digit,
  `@` a letter, `$` either). A product that sets neither keeps the shared
  SA series.
- **Interest**: `interest_paid_into_account` (off unless switched on, so an
  upgraded tenant does not start paying interest nobody configured), and:
  - `interestRateTerms`: FIXED (the rate, and optional `interestRateMin` and
    `interestRateMax` for a rate per account), INDEX (an interest rate
    source plus a spread with a default, minimum and maximum), or
    TIERED_BALANCE (the whole balance at its tier's rate), TIERED_BANDS
    (each portion at its band's rate) or TIERED_PERIOD (the rate of the
    account's age in days), from `interestRateTiers` `[{ ending, rate }]`;
  - `interestRateFrequency`: the rate per year (ANNUALIZED), EVERY_MONTH,
    EVERY_FOUR_WEEKS, EVERY_WEEK or EVERY_X_DAYS;
  - the balance: END_OF_DAY (optionally capped at `interestMaxBalance`),
    MINIMUM_DAILY and AVERAGE_DAILY (the reference platform's: from the day's movements, the
    lowest balance and the average of the balances after each), or MINIMUM
    (the lowest balance of the interest period, the platform's first rule);
  - the days in a year: ACTUAL_365, ACTUAL_360, THIRTY_360 or
    ACTUAL_ACTUAL_ISDA;
  - applied MONTHLY, QUARTERLY, SEMI_ANNUAL or ANNUAL on the calendar
    period's last day, or DAILY, FIRST_DAY_OF_MONTH, WEEKLY or
    EVERY_OTHER_WEEK and the MONTHLY, QUARTERLY, SEMI_ANNUAL and ANNUAL
    `_FROM_ACTIVATION` schedules (clamped at month end), FIXED_DATES (up to
    12, MM-DD) or ON_MATURITY (fixed deposits and savings plans, their
    default);
  - a minimum balance to earn it, negative rates when allowed, whether a
    locked account earns (`collectInterestWhenLocked`, on) and whether a
    matured one does (`accrueInterestAfterMaturity`, off).
  Interest accrues to six decimal places so the sub-cent remainder carries
  into the next period. A change to a product's rate reaches every open
  account (`applyTo: ALL_ACCOUNTS`, the default) or new accounts only
  (`NEW_ACCOUNTS`, fixed rates: each existing account keeps the rate it
  had), from the next accrual; what has accrued stays. Changes are kept in
  `savings_interest_rate_changes`.
- **Deposits and withdrawals**: a maximum withdrawal in one transaction, an
  opening balance (minimum, maximum, default), and for fixed deposits and
  savings plans a recommended deposit (a guideline).
- **Term** (fixed deposits and savings plans): a unit (DAYS, WEEKS, MONTHS)
  and a default, minimum and maximum.
- **Dormancy**: the days without financial activity after which an account
  becomes dormant (not for products with a maturity date).
- **Withholding tax**: a percentage of interest applied, shipped unset.
- **Overdrafts**: authorised (a product maximum and an account limit, with
  its own annual rate) and technical (charges the system applies when there
  is no money). A withdrawal is held to the authorised limit; the floor
  trigger on `savings_accounts` refuses anything below it unless the product
  allows technical overdrafts. An overdraft may have an expiry date
  (The reference platform): after it the limit no longer lends, though what is overdrawn stays
  owed. It is optional, and needed to link the overdraft to a credit
  arrangement (see "Lines of credit").
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
pays them first and recognises them then. The reference platform's accrual table books
"interest applied" as Dr Interest Expense, Cr Savings Control, the same as
cash; here the application clears the payable explicitly, so the expense is
recognised once.

Accounts: `POST /api/savings/:id/fees`, `PUT /:id/overdraft` (`limit`,
`expiryDate`, and `interestRate` or `interestSpread` within the product's
range; each may be left out, and a null `expiryDate` clears it), `POST
/:id/overdraft/write-off`, `POST /:id/interest` (accrue to a date, and apply
with `apply: true`), `POST /:id/branch`, and:

- `PATCH /api/savings/:id` (the reference platform's Editing Accounts): at any time the
  account's `name` (blank shows the product's), `notes`, `customFields` and
  `maxBalance` (the reference platform's maximum deposit balance: deposits and transfers in
  beyond it are refused with `MAXIMUM_DEPOSIT_BALANCE_EXCEEDED`). Before
  activation (PENDING_APPROVAL or APPROVED) also its terms: `interestRate`,
  `interestSpread`, `overdraftRate`, `overdraftSpread` and `termLength`,
  within the product's ranges. After it the rate changes through
  `:changeInterestRate` and the overdraft through `PUT /overdraft`.
- `PUT /:id/overdraft` works on ACTIVE and IN_ARREARS accounts (the reference platform's
  Adjusting Overdraft Terms), and before activation as part of the terms.
- Opening an account takes its own `name`, `interestRate` (FIXED, within the range),
  `interestSpread` (INDEX), `overdraftRate`, `overdraftSpread`, `maxBalance`
  and `termLength`.
- `POST /api/savings/:id:changeInterestRate` (also `/:id/interest-rate`):
  a fixed-rate account's rate from a value date, today or back to the day
  after the last interest application, never forward. What accrued from
  the value date is priced again and booked.
- `POST /api/savings/:id/maturity` (ACTIVATE_MATURITY) starts a fixed
  deposit's or savings plan's term once the opening balance is reached;
  `DELETE` undoes it before the date (UNDO_MATURITY). A fixed deposit takes
  no deposits once its maturity has started, and a savings plan none after
  maturity. Neither pays out during the term without
  MAKE_EARLY_WITHDRAWALS. At its date the end of day makes the account
  MATURED: it pays out, takes nothing in, and closes when empty.
- Dormancy: the end of day makes an account DORMANT after the product's days
  without financial activity (interest postings and fees the end of day
  charges do not count). Deposits and withdrawals on it need
  POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS, and make it ACTIVE again. A
  dormant account accrues no interest, credit or overdraft, and is charged
  no monthly fee (the reference platform).
- Fees: a monthly fee is charged on the last day of the month (the
  platform's first rule, which existing fees keep), on the first day of
  every month, or monthly from the account's activation
  (`applyDateMethod`). A fee not defined on the product is charged only
  where the product allows arbitrary fees (on unless turned off).
- Overdraft interest: FIXED (the rate, with a range for a rate per account),
  INDEX (a source plus spread, never below zero) or TIERED_BALANCE (by the
  amount overdrawn), with its own day count and balance (END_OF_DAY or
  MINIMUM_DAILY). A change to the product's overdraft rate reaches new
  accounts only (the reference platform): existing accounts keep the rate they had.
  Technical overdrafts are turned off only while the product has no
  accounts.
- Not built from these pages: currencies per product (the ledger is in the
  organization's currency), profit-sharing products and solidarity groups
  as deposit holders.

**The account life cycle** (the reference platform's Deposit Accounts). A product's
`initialState` is the state new accounts start in: ACTIVE (the default,
the platform's rule so far), PENDING_APPROVAL or APPROVED. An approved
account becomes ACTIVE with its first transaction (a deposit, a withdrawal
into an overdraft, a transfer or a loan disbursement into it) and earns
from that day. `POST /api/savings/:id:changeState` (also `/:id/state`)
takes an `action` and `notes`:

| Action | From | To | Permission |
|---|---|---|---|
| APPROVE | PENDING_APPROVAL | APPROVED | APPROVE_SAVINGS |
| UNDO_APPROVE | APPROVED | PENDING_APPROVAL | APPROVE_SAVINGS |
| UNDO_ACTIVATE | ACTIVE (activated from APPROVED, no transactions standing) | APPROVED | APPROVE_SAVINGS |
| CLOSE_REJECT | PENDING_APPROVAL | CLOSED (REJECTED) | CLOSE_SAVINGS_ACCOUNTS |
| CLOSE_WITHDRAW | PENDING_APPROVAL, APPROVED | CLOSED (WITHDRAWN) | CLOSE_SAVINGS_ACCOUNTS |
| LOCK | ACTIVE, IN_ARREARS, DORMANT | LOCKED | LOCK_SAVINGS_ACCOUNT |
| UNLOCK | LOCKED | the state it was locked in | UNLOCK_SAVINGS_ACCOUNT |
| CLOSE | ACTIVE, IN_ARREARS, DORMANT, MATURED (empty) | CLOSED | CLOSE_SAVINGS_ACCOUNTS |
| CLOSE_WRITE_OFF | an overdrawn open account | CLOSED (WRITTEN_OFF) | CLOSE_SAVINGS_ACCOUNTS |
| UNDO_CLOSE_WRITE_OFF | CLOSED (WRITTEN_OFF) | the state before, balances restored | REVERSE_SAVINGS_ACCOUNT_WRITE_OFF |
| REOPEN | CLOSED, current and savings accounts | ACTIVE, earning from today | REOPEN_SAVINGS_ACCOUNT |

- **How it closed:** a closed account keeps the state CLOSED, and
  `closed_as` records REJECTED, WITHDRAWN or WRITTEN_OFF. The balance
  gives the reference platform's account state as `accountState` (CLOSED_REJECTED,
  WITHDRAWN, CLOSED_WRITTEN_OFF, ACTIVE_IN_ARREARS, and the rest as they
  are).
- **Locked:** no deposits, withdrawals, transfers or fees. Interest follows
  the product's `collectInterestWhenLocked`.
- **In Arrears:** an account overdrawn past its overdraft expiry date (the
  end of day checks), or one whose limit was lowered below what it owes. A
  deposit that brings it back within what the overdraft lends makes it
  ACTIVE again. An account taken below zero by a fee or interest under a
  technical overdraft stays ACTIVE, as before.
- **Write-off:** CLOSE_WRITE_OFF writes off what is overdrawn, as
  `POST /:id/overdraft/write-off` does, and closes the account. It needs any
  credit interest accrued applied first, and no running loan settled from
  the account. The undo reverses the entry and puts back the balance, the
  charges owed, the overdraft interest and the limit. A write-off recorded
  before this build cannot be undone. `POST /:id/overdraft/write-off` on
  its own still leaves the account open.
- **Delete:** `DELETE /api/savings/:id` (DELETE_SAVINGS_ACCOUNT) deletes an
  account nothing was ever posted to and no loan, funding pledge, dividend
  or credit arrangement points at.

**Working with deposit accounts** (the reference platform's Working with Deposit Accounts).

- **Balances:** the balance endpoint gives the reference platform's `balances`: total,
  available (after the overdraft lends, less holds, blocks and the pledged
  amount), the available overdraft, holds, locked (the pledged amount),
  blocked, the overdraft amount due, and credits on their way.
- **Blocked funds:** `POST /api/savings/:id/blocks` (`externalReferenceId`,
  `amount`, `notes`), `GET`, and `DELETE /:id/blocks/:reference` to unblock
  (BLOCK_AND_SEIZE_FUNDS, administrators by default). A block may be larger
  than the balance. What it holds is not available; deposits still come in
  and interest accrues on the whole balance. Allowed on ACTIVE, IN_ARREARS,
  LOCKED and DORMANT accounts.
- **Seizures:** `POST /api/savings/:id/seizure-transactions` (`blockId`,
  `amount`, `transactionChannelId`) takes all or part of what a block
  holds, no more than the balance, through a channel (bank by default), as
  a SAVINGS_SEIZURE. The block is SEIZED once nothing is left. A seizure is
  reversed like any transaction, and the block holds it again.
- **Transaction holds:** `POST /api/savings/:id/authorizationholds`
  (`externalReferenceId` up to 32 characters, unique; `amount`;
  `creditDebitIndicator` DBIT or CRDT) with CREATE_HOLDS, `GET` (VIEW_HOLDS,
  `?status=`) and `DELETE /:id/authorizationholds/:reference` (DELETE_HOLDS).
  A debit hold is no larger than what is available and makes it
  unavailable; a credit hold is money on its way. A withdrawal (DBIT) or
  deposit (CRDT) naming `holdExternalReferenceId`, for exactly the amount
  held and with no value date, settles it (UPDATE_HOLDS). Holds do not
  expire. Card authorization holds are not built: there is no card
  processor to connect to.
- **Value dates:** staff may not date a deposit, withdrawal or transfer in
  the future, and need BACKDATE_SAVINGS_TRANSACTIONS for a past date, back
  no further than the day after the last interest application. A backdated
  movement moves the recorded daily balances from its date and prices that
  interest again (the movement counts from the start of its day); a
  backdated withdrawal that would take a past day below what the account
  may owe is refused. Transfers are backdated the same way (the reference platform refuses
  them). The platform's own callers (the end of day, loan transfers,
  imports) date as before.
- **Inter-client transfers:** a transfer to another holder's account, or a
  repayment of another holder's loan, needs MAKE_INTER_CLIENTS_TRANSFERS.
  Transfers carry custom fields like deposits.
- **Bulk deposits:** `POST /api/savings/deposit-transactions:bulk`
  (`transactions`: `accountId`, `amount`, `transactionDetails.transactionChannelId`,
  `valueDate`, `notes`, `externalId`, `customFields`; up to 1,000) posts each
  on its own under the same checks and returns a `bulkProcessKey`;
  `GET /api/bulks/:key` lists what went through and what did not.
- **Reversals:** deposits, withdrawals, transfers, fees, seizures, interest
  applied (the latest only; it goes back to accrued, with its withholding
  tax) and withholding tax on its own. A reversal dated after the last
  interest application prices the interest again. A closed account's
  transactions are not reversed, and a reversal that would overdraw an
  account without a technical overdraft is refused.
  `POST /api/savings/transactions/reversals` (`references`, `notes`,
  BULK_DEPOSIT_CORRECTIONS) reverses several, each on its own.
- **The account's own limits:** `maxWithdrawalAmount` (within the
  product's; the lower applies) and `recommendedDepositAmount`, at opening
  or with `PATCH`.
- **Withholding tax per account:** `POST /api/savings/:id:changeWithholdingTax`
  (`withholdingTaxSourceKey`, a WITHHOLDING rate source; null goes back to
  the product's) from today, and `GET /:id/withholdingtaxes`. Interest
  applied is taxed at the source's rate in force that day.
- **Closing:** an account with pending blocks or holds is not closed,
  written off, withdrawn, rejected or deleted.

**The reference platform's deposits API** (`/api/deposits`). The same accounts and rules as
`/api/savings`, in the reference platform's API v2 shape: the account object with
`overdraftSettings` (`allowOverdraft`, `overdraftLimit`,
`overdraftExpiryDate`), `overdraftInterestSettings` and `interestSettings`
(each `interestRateSettings`: rate, spread, source, terms, index, review
frequency, tiers, days in year), `internalControls`, `balances`,
`accruedAmounts` and custom fields; `GET` (filters, paging headers),
`POST /api/deposits:search`, `POST`, `GET /:id`, `PUT /:id` and `PATCH /:id`
(JSON Patch; only what changed is applied, each through its rule; the
holder, product, type, ID and state are refused), `DELETE /:id`, the colon
actions `:changeState`, `:changeInterestRate`, `:changeWithholdingTax`,
`:startMaturity`, `:undoMaturity` and `:applyInterest`, the
`deposit-`, `withdrawal-`, `transfer-`, `fee-` and `seizure-transactions`,
`GET /:id/transactions` (the reference platform's transaction types, adjustments as
`DEPOSIT_ADJUSTMENT` and so on), blocks, holds, withholding tax history and
`deposit-transactions:bulk`. Each route is let in by the permission of the
`/api/savings` route it matches.

- **Overdraft expiry at opening:** `overdraftExpiryDate` on `POST /api/savings`
  (`overdraftSettings.overdraftExpiryDate` on `/api/deposits`), with a limit.
- **Index rate review frequency** (the reference platform's Interest Rate Review Frequency):
  `interestReviewCount` and `interestReviewUnit` (DAYS, WEEKS, MONTHS) for an
  INDEX credit rate, `overdraftReviewCount` and `overdraftReviewUnit` for an
  INDEX overdraft rate, from the account's activation. A day takes the index
  rate in force on its latest review date; unset, the rate in force that day.
- **30E/360:** THIRTY_360 is 30E/360 in its ISDA form (31sts and the last day
  of February count as the 30th); `/api/deposits` names it `E30_360`.

**Offset accounts** (the reference platform's offset loans). A loan product with
`offsetEnabled` (a DYNAMIC_TERM product, REDUCING_EQUAL_INSTALLMENTS, SIMPLE
interest on PRINCIPAL_AND_INTEREST) has its linked deposit account as its
offset account; the setting turns linking on, and the settlement option may
be NONE. The account must be under a deposit product with `allowOffset`.

- The loan is not disbursed without the link (`MISSING_LINKED_OFFSET_ACCOUNT`).
- Interest accrues on the principal and interest balance less the offset
  account's balance, never below zero. The balance is the one the accrual
  finds; the end of day accrues loans before deposits.
- Reversals on an offset account are refused while the loan runs (the reference platform).
- The offset account earns its own interest as usual.
- `offsetEnabled` is frozen once the product has loans, and `allowOffset`
  stays on while its accounts offset running loans.

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
the time the year is closed. `PATCH /api/accounting/closures/:id` edits a
closure's notes; its date and scope stay.

### The chart of accounts and journal entries (the reference platform's accounting API)

**GL accounts** (`/api/glaccounts`, `src/domain/chartOfAccounts.js`). Each
account in the reference platform's GLAccount shape: `glCode`, `name`, `type`, `usage`,
`description`, `activated`, `allowManualJournalEntries`, `parentGlCode`,
`currency` and `balance`.

- `GET` filters by `type`, `usage` and `activated`; `GET /:code` reads one.
  Both give balances for `from` and `to` (and a `branchId`), in each
  account's own sign. A header's balance is the sum of the accounts under it.
- `POST` creates one account or a list. `PUT`, `PATCH` (JSON Patch) and
  `DELETE` need MANAGE_ACCOUNTS and a user with every branch.
- A parent is a header of the same type, and a header takes no manual
  entries.
- The name, description, parent and flags change at any time. The GL code
  changes only while nothing uses the account. The type and usage never
  change.
- An account something maps (a product, channel, till, rule, setting, or a
  column default) stays active. An account is deleted only while nothing
  uses it (`GL_ACCOUNT_IN_USE` names what does).

**Journal entries** (`/api/gljournalentries`, `src/domain/journalEntries.js`).

- `GET` (`from`, `to`, `branchId`, `glAccountId`, `transactionId`) and
  `POST /api/gljournalentries:search` return one GLJournalEntry per line:
  `entryId`, `transactionId`, `type`, `amount`, `glAccount`, `bookingDate`,
  `creationDate`, `assignedBranchKey`, `userKey` and `reversalEntryKey`.
  An automatic entry also shows `productType`, `productKey`, `accountKey`
  and `accountId` from the transaction behind it.
- `GET /:ref` returns one entry with its lines (by its id, its transaction
  ID or a line's `entryId`).
- A user limited to some branches reads the lines of their branches.

**Manual entries** (`POST /api/gljournalentries`, LOG_JOURNAL_ENTRIES).

- The body is `date`, `branchId`, `notes` (required), `transactionId`
  (generated as `MJ-000001` when not given) and `debits` and `credits`, each
  a list of `{ glAccount, amount, branchId }`.
- Only active detail accounts that allow manual entries are used.
- The date may be backdated to after the closure and inside an open
  financial year, never in the future.
- A line in another branch is squared through the inter-branch rules, and
  the lines added are returned.
- `POST /:ref:reverse` (with `notes`, optionally a `date`) reverses a manual
  entry once. An automatic entry is refused with the transaction to reverse.
- `/:ref/attachments` keeps up to five files on a manual entry, under the
  loan attachment rules.
- Migration 041 turns manual entries off on the accounts products map as
  Portfolio Control, Savings Control and Overdraft Portfolio Control.

**Also:**

- `POST /api/accounting/interestaccrual:search` searches the accrual
  breakdown. Each accrual line is shown twice, once as its debit and once as
  its credit, with the account, product, branch and the entry that posted it.
- `/api/currencies/:code/accountingRates` is the reference platform's spelling of
  `accounting-rates`.
- The console's Chart of accounts and Journal pages manage accounts, log and
  reverse entries, and attach files.

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
The reference platform's loan product form is here: identity and numbering, type and
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
| Interest type | `interest_type`, `simple_base` | SIMPLE (linear), CAPITALIZED (applied interest joins the principal, Dr Portfolio Cr Income, and is repaid as principal; on Declining Balance every installment but the last is interest only and the principal falls due at the end), COMPOUND (daily exponential on the effective annual rate; the annuity uses the periodic compound rate), COMPOUND_DAILY_REST (the nominal rate over the days in the year, each day's interest earning interest the next day; the monthly payment is PMT(daily, months/12 x days, -P) x days/12). SIMPLE on a dynamic equal-installment product may run on principal and unpaid interest. Compound types are not available on FLAT or REVOLVING products. Figures reproduce the reference platform's worked examples to the cent. |
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
| Controls | `auto_lock_arrears_days`, `auto_close_paid_off_days`, `cap_includes_accrued`, `allow_arbitrary_fees` | Per product: lock after days in arrears; close a running loan that has owed nothing for the days given since its last transaction (revolving loans at nothing, mainly; the reference platform's Close dormant accounts); count charges accrued and not applied towards the cap. Tenant-wide controls are separate, below. |
| Accounting | `accounting_method` | ACCRUAL, CASH, or NONE: balances kept, no journal entries, no GL accounts needed. |

### Fees

`loan_product_fees` holds a product's fees, after the reference platform's "Loan Fees
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

The rest of the reference platform's "Loan Fees Setup" and "Non-Scheduled Fee Allocation":

- **A fee without a code** is given one from its name (`Bounced cheque`
  becomes `BOUNCED_CHEQUE`), unique on the product.
- **Where a manual fee goes** (`allocation`). NEXT_INSTALLMENT, the
  default, puts it on the next installment not yet paid, in grace or in a
  payment holiday, due on or after the day it is applied (failing that, the
  last unpaid one). It then falls due with that installment and is paid
  with it, and an unpaid one counts towards arrears. NO_ALLOCATION keeps
  it off the schedule in a balance of its own (`ns_fees_due`,
  `ns_fees_paid`). That balance counts in the loan's total, never falls
  due, is not paid by an ordinary repayment, and is written off, capitalised
  on a reschedule or top-up, or waived like any fee. Arbitrary fees choose
  per application; manual fees default to the fee's setting and may be
  overridden when applied (`allocation` on `POST /api/loans/:id/fees`).
- **A custom repayment** (`customAllocation` on
  `POST /api/loans/:id/repayments`: any of `penalty`, `fee`, `interest`,
  `principal`, `nonScheduledFee`) splits a payment as the teller says. No
  item may take more than it owes, and the parts must add up to the
  amount. It is the only way to pay fees kept off the schedule.
- **Percentage fees after disbursement** are on the amount disbursed plus
  any capitalised disbursement fees (the reference platform's examples: 1,000 with a
  deducted 100 is still 1,000; 1,000 with a capitalised 100 is 1,100).
- **Tranches.** A required disbursement fee is charged on the first tranche.
  On a later one it applies only if it is chosen for that disbursement.
  Payment due fees are refused on tranched products.
- **Planned fees** are manual fees placed on future installments ahead of
  time, before or after disbursement, on any product with a schedule:
  - `POST /api/loans/:id/planned-fees` takes `installment` and either `fee`
    (a MANUAL product fee; `amount` overrides its figure) or `name` and
    `amount` (where arbitrary fees are allowed). An optional `applyOn` must
    be after today.
  - `PATCH` and `DELETE /api/loans/planned-fees/:id` change or remove a fee
    until it is applied.
  - The schedule shows them (`planned_fees` on each installment).
  - The end-of-day job `applyPlannedFees` (before `markArrears`) applies
    each one on its installment's due date or its `applyOn` date. A fee
    whose installment was paid by its due date is SKIPPED.
  - `POST /api/loans/:id/planned-fees/apply` applies them early: now, or
    on a later `applyOn`.
  - Once applied, a planned fee is an ordinary fee on that installment.
  - Planned fees are not allowed on installments in grace or a payment
    holiday, or on revolving loans.
- **Fee amortisation** (`amortizationProfile`, accrual products that are
  not tranched or revolving). The fee's income is credited to deferred fee
  income: the fee's own `glDeferredIncome`, else the product's
  `glDeferredFeeIncome`, 200-350 Deferred Fee Income. Tax on the fee is
  payable at once and is not deferred. A plan (`loan_fee_amortization`,
  `GET /api/loans/:id/fee-amortization`) then spreads the income, and the
  end-of-day job `amortizeFees` moves each share to fee income:

  | Profile | Shares | Fee types |
  |---|---|---|
  | STRAIGHT_LINE | equal | manual, deducted, capitalised, upfront |
  | SUM_OF_YEARS_DIGITS | n, n-1 ... 1 parts of n(n+1)/2 | deducted |
  | EFFECTIVE_INTEREST_RATE | the rate that discounts the installments to the principal less the fee, applied to the carrying amount, less the contractual interest (IFRS 9) | manual, deducted, capitalised, upfront |

  - **Frequency** (`amortizationFrequency`):
    - INSTALLMENT_DUE_DATES recognises each share on its installment's due date.
    - INSTALLMENT_DUE_DATES_DAILY recognises it a day at a time through the period.
    - CUSTOM_INTERVAL (straight line) runs every `amortizationIntervalCount` `amortizationIntervalUnit` for `amortizationIntervals` intervals, from the day the fee is applied.
  - **Closure.** When the loan is paid off or written off, whatever is still deferred is recognised in one entry. Reversing the closing payment, or the write-off, puts it back.
  - **Reschedule or refinance.** With END_ON_ORIGINAL (the default) the deferred income is recognised when the old loan closes. With CONTINUE_ON_NEW the plan carries on on the new loan, which must be under the same product.
  - **Waiving the fee or undoing the disbursement** takes back what was recognised, so the deferred account clears.
  - **Catch-up.** A share recognised late is posted on its own date, or on the processing date when that date falls in a closed accounting period.
  - A fee's profile cannot change once the fee has been applied.
  - "Fee included in total due" (the reference platform's equal-installment fee rate, which needs Optimized Payments) is not built.

### The life cycle

After the reference platform's "Loan Account Life Cycle and States". Every step is a
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
the tenant-wide controls from the reference platform's "Internal Controls": maximum
exposure per member (UNLIMITED, SUM_OF_LOANS, SUM_MINUS_DEPOSITS with an
amount), one active loan per member, minimum days in arrears before a
write-off, the window for undoing a closure, and the two-man rule, all off
by default; and whether a write-off needs a second person's approval, on
by default.

Each user's limits are listed by `GET /api/loans/controls/users`
(TENANT_ADMIN, MANAGER) and set by
`PATCH /api/loans/controls/users/:userId` with `approvalLimit` and
`disbursementLimit` (TENANT_ADMIN; null lifts a limit). Every change is in
the audit log.

**In the console** the Controls page shows these controls and each user's
limits:

- A tenant administrator can change the controls, including the roles that
  may post on locked loans, and each user's limits.
- "Run now" runs the end-of-day controls on the spot (locking at the cap
  or after days in arrears, closing loans that owe nothing) and shows what
  they did.

A LOCKED loan applies no interest, fees or penalties while it is locked,
unless the lock leaves some of them running (see "Closing and exiting a
loan account"). Interest the lock held back is brought to date at the first
run after the unlock; penalties for the locked days are not charged, as
The reference platform's Locking page describes. It takes repayments only from
users whose role the tenant lists in `lockedPostingRoles`
(`PATCH /api/loans/controls`; none by default), and stays locked after
them. A lock for the charge cap lifts only once the charges are paid or the
loan is out of arrears. Lifting it restarts the count of charges the cap is
measured on, so what accrued while locked is applied up to the cap. A
manual lock lifts when a manager says so.

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
above zero, as in the reference platform.

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

After the reference platform's P2P lending (which the reference platform withdrew from sale in 2022; the
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
Reproduces the reference platform's worked examples (2.50 to the organisation, 30 + 1.75 and
70 + 4.08 to the funders on a 108.33 installment; 9.7% on the fixed-
commissions example). Funded loans are not rescheduled or refinanced here.

### The daily sequence, for loans

`billRevolving`, `accrueInterest`, `markArrears`, `accruePenalties`,
`applyFees` (a dynamic loan's payment-due fees on their dates, late fees on
installments that went overdue), `enforceControls` (lock at the cap or
after the product's days in arrears). Each is idempotent per business date.

### Product type decides what interest is

The reference platform separates two things a single `method` column had run together here:
what kind of schedule a loan has, and how a period's interest is worked out
(Loan Product Types,
Interest Calculation Methods in Loans).
Before this the accrual read the actual balance for `REDUCING` and the
original principal for `FLAT`, whatever the product was meant to be, and a
prepayment never touched the schedule.

`product_type`, fixed once the product exists:

| Type | What the member owes | Prepayment | After the last due date |
|---|---|---|---|
| `FIXED_TERM` (default; everything existing) | The interest on the schedule drawn at disbursement, pro rata through the period in progress. Paying principal early does not lower next month's interest; paying late does not raise it. | Settles installments in order. Schedule unchanged. | Nothing more accrues: the schedule's total is the total. Penalties cover lateness. |
| `DYNAMIC_TERM` | Interest on the actual outstanding principal for the actual days, by the day count. | Settles what has fallen due; the rest reduces the balance and the future schedule is redrawn from it. | Keeps accruing if `accrue_late_interest` (default true), else stops at maturity. |

`method`, how a period is priced:

| Method | The reference platform name | Period interest | Principal per period |
|---|---|---|---|
| `FLAT` | Fixed Flat | original principal × rate | equal shares |
| `REDUCING` | Declining Balance | outstanding × rate | equal shares |
| `REDUCING_EQUAL_INSTALLMENTS` | Declining Balance (Equal Installments) | outstanding × rate | payment − interest, the payment being the annuity on the principal |

`FLAT` on a `DYNAMIC_TERM` product is refused by the API and by a check
constraint: flat interest is charged on the original principal whatever the
balance does, which is the definition of a fixed schedule.

`prepayment_recalculation`, for dynamic products (the reference platform's prepayment
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

As in the reference platform, interest accrues daily
(Interest Calculation Methods in Loans):
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
where rounding each day used to give 99.90. This is the reference platform's approach of
keeping accruals unrounded and rounding when posting ("Truncating and
rounding interest"). One difference: the arithmetic is JavaScript double
precision (about fifteen significant digits, far below a cent on any loan
amount) rather than the reference platform's twenty decimals. Penalties carry their fraction
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
| `ACTUAL_365` | The reference platform's default. Days that passed over 365. |
| `ACTUAL_360` | Days that passed over 360. |
| `ACTUAL_ACTUAL` | Each day is a fraction of its own year, leap years included. |
| `BUS_252` | Business days over 252: weekends and the days in the `holidays` table do not count. Brazil's convention; compound interest only, as in the reference platform. |

30E/360 is the default because SACCO products are quoted per month and
members expect the month's interest to be the month's interest. A product
priced per annum should use an actual convention.

### Index and adjustable interest rates

After the reference platform's "Interest Rate Source" and "Adjustable Interest Rates".

**Index sources.** `POST /api/index-rates` creates a source (a central bank
rate, say); `POST /api/index-rates/:id/rates` gives it a value from a date.
Values are history: the value in force on a date is the latest dated on or
before it. The console sets them under Loan products, Index rates.

**INDEX products.** `interestRateSource: INDEX` with an `indexSourceId`:
the loan's rate is the index plus a spread, within `rateFloor` and
`rateCeiling`, reviewed every `rateReviewCount` `rateReviewUnit` (days,
weeks, months) from disbursement. The product's rate and its band are the
spread's. Not on FLAT or INTEREST_FREE products, as in the reference platform, and frozen
once loans exist.

**Adjustable rates.** A product with `adjustableRates` lets a loan be
opened with `ratePeriods`: a list, each `{ validFrom, source: FIXED, rate }`
or `{ validFrom, source: INDEX, indexSourceId, spread, floor, ceiling,
reviewCount, reviewUnit }` (the index settings default to the product's).
Fixed rates must sit in the product's band; index sources must be the
product's or in `allowedIndexSources`; a negative spread (a discount on the
index) needs `allowNegativeRate`, and the rate never goes below zero. When
the loan is disbursed on another day than its first period starts,
`shiftAdjustableInterestPeriods: true` moves every period by the difference,
`false` keeps them as opened, and leaving it out is refused, as in the reference platform.

**How a rate changes.** `loan_accounts.monthly_rate` is the rate in force.
The end of day reviews every loan with rate periods before accruing
interest (`reviewRates`; also `POST /api/loans/rates/review` and
`/api/loans/:id/rates/review`). A FIXED period's rate applies from the day
the period starts; an INDEX period's rate is the index on the latest review
date plus the spread, applied from that review date. When the rate differs
from the one in force, interest is brought to the change date at the old
rate, the rate changes, the change is recorded with the index and spread
(`GET /api/loans/:id/rates`), and the schedule's future installments are
redrawn on the new rate, an equal-installment loan getting a new payment.
A loan that earns interest on the actual balance changes on the date; a
fixed-term loan, whose schedule is the contract, changes from its next due
date, so the installment in progress keeps its amount. The reference platform's worked
example (5% index plus 2%, the index rising to 6% on 1 February, the third
installment priced at 8%) is in `test/interest-rates.test.js`.

### Schedule editing, payment holidays and the due day

After the reference platform's "Repayments Schedule Editing". A product lists what its loans'
schedules may have changed (`scheduleEditing`): PAYMENT_DATES, PRINCIPAL,
INTEREST (fixed term only; a dynamic loan's interest follows its balance),
FEES, PAYMENT_HOLIDAYS and NUMBER_OF_INSTALLMENTS (dynamic term only; it
brings PAYMENT_DATES and PRINCIPAL with it, as in the reference platform). A running loan's
installments may change when nothing has been paid on them, they have not
fallen due, and, on a fixed-term loan, their period has not started to earn
interest, so the interest already earned stays what the schedule said.

- `PUT /api/loans/:id/schedule` with `installments` replaces those
  installments: new due dates (rising, in the future), principal and fees
  reallocated (they must add up to what they were; apply or waive a fee to
  change the total), interest changed on a fixed-term loan. A dynamic
  loan's expected interest is redrawn from the new principal and dates.
- `POST /api/loans/:id/payment-holiday` with `from` and `count`: those
  installments fall due with nothing to pay (they never go overdue), the
  loan gains as many installments at the end, and the principal and the
  holiday's interest are spread over the installments after it.
- `POST /api/loans/:id/due-day` with `day` (dynamic term): the next
  installment and every later one move to that day of their month, after
  the product's non-working-day rule. The next installment's interest
  follows its longer or shorter period; later installments keep their
  amounts (the reference platform's example: from the 10th to the 25th, asked on the 3rd,
  the next installment grows by fifteen days of interest).

Every edit is kept with the schedule before and after
(`GET /api/loans/:id/schedule-edits`). Penalties are charged on the loan,
not placed on installments, so there is no penalty schedule to edit.

**In the console.** A loan whose product allows any of these edits has an
"Edit schedule" action. It opens a table of the installments that may
change (from `GET /api/loans/:id/schedule/editable`), with the fields the
product allows open for editing, a running total of principal, and rows
that can be added or removed where the number of installments may change.
Saving calls `PUT /api/loans/:id/schedule`. Payment holidays and the due
day have their own actions.

**On an application.** the reference platform edits a schedule once the loan is disbursed.
Here `PUT /api/loans/:id/schedule` also works on an application (partial,
pending approval or approved), because the schedule the member signs up to
is often agreed before the money moves (a harvest loan with its payments
after the harvest, say). What changes is kept on the application
(`custom_schedule`) and the loan is drawn with it at disbursement:

- The product's rights apply: PAYMENT_DATES to set dates, PRINCIPAL to
  move principal, INTEREST (fixed term) to set an installment's interest.
  The number of installments may change within the product's term band,
  as the term of an application may; the term follows it.
- Dates given stay as given. Dates left as the product's are drawn from
  the disbursement date. Disbursing on or after an edited date is refused
  until the schedule is edited again.
- Principal must add up to the loan. Principal gained at disbursement
  (capitalised fees) goes to the last installment.
- Interest not given is worked out on each installment's own period and
  balance (on the original principal under FLAT). If the edit moved no
  date and no principal, the product's figures stand.
- Fees are placed at disbursement and are edited once the loan runs.
- Amending the application's amount or term drops the edited schedule.
  `DELETE /api/loans/:id/application-schedule` goes back to the product's.

`GET /api/loans/:id/application-schedule` shows the schedule the
application would be drawn with if it were disbursed today; the console
shows it in place of the empty schedule, with "Edit schedule" and "Product
schedule" actions. Edits on an application are kept in the same register
with the kind APPLICATION. Tranched and revolving products draw no schedule
at disbursement and are refused.

### Repayment collection

After the reference platform's "Repayment collection" and "Prepayment Recalculation Methods":

| Setting | Values | What it does |
|---|---|---|
| `paymentMethod` | VERTICAL (default), HORIZONTAL | VERTICAL pays by balance in the allocation order: all penalties, then all fees, and so on. HORIZONTAL pays by the schedule: each unpaid installment in turn takes its own penalties, fees, interest and principal before the next is touched, interest never beyond what has been earned; what the loan owes outside its installments is then paid in the order. The reference platform offers VERTICAL on dynamic products only; here it stays available on fixed-term products because it is what they did before. |
| `allocationOrder` on a repayment | the four components | A custom order for one repayment, as the reference platform allows through the API. |
| `allowPrepayments` | true (default), false | false refuses a payment above what is due (charges owed and the principal of installments fallen due). |
| `prepaymentInterest` | AUTOMATIC (default), MANUAL | Dynamic term. AUTOMATIC applies interest to the day before a payment, so a prepayment pays it first; MANUAL applies it after the payment, on the lower balance. |
| `prepaymentAllocation` | UPCOMING_PENDING (default), NEXT_INSTALLMENTS | Dynamic equal installments. UPCOMING_PENDING redraws the schedule by `prepaymentRecalculation`; NEXT_INSTALLMENTS pays the next installments' principal in turn and redraws nothing. |
| `markPaidWhen` | FULL_DUE (default), PRINCIPAL_EXPECTED | Dynamic equal installments. FULL_DUE: an installment is paid once all of it is, on or after its date. PRINCIPAL_EXPECTED: a prepaid installment is paid once its principal is, and the interest it expected moves to the next installment. |

The reference platform's four Declining Balance recalculation methods map onto
`prepaymentRecalculation`: No recalculation is NONE; Reschedule remaining
repayments and Recalculate keeping the same number of terms are
REDUCE_INSTALLMENT_AMOUNT (on equal principal shares they draw the same
schedule); Recalculate keeping the same principal amount is
REDUCE_NUMBER_OF_INSTALLMENTS.

### Arrears settings

After the reference platform's "Arrears Settings". Tolerance days and the tolerance
percentage of outstanding principal (with a floor) are set per product,
with a minimum and maximum that each loan's own value must sit inside
(`arrearsToleranceDaysMin`, `arrearsToleranceDaysMax`,
`arrearsTolerancePercentMin`, `arrearsTolerancePercentMax`). The
setting for counting days in arrears (from the first arrears or from the
oldest late installment) and the setting for non-working days in the
tolerance work as before.

**Approval freezes these settings.** When a loan is approved it takes the
product's penalty rate and arrears tolerances as they stand, for any it
left to the product. Its penalty method, penalty tolerance, arrears floor
and counting rules are kept in `settings_snapshot`, which the loan reads
in place of the product's. A later change to the product therefore reaches
only loans still pending, as in the reference platform. Undoing the approval releases them.
Migration 023 froze the settings of loans that were already approved or
running.

`GET /api/loans/:id` shows the reference platform's two counters:

- `days_late` is counted from the oldest installment still unpaid after its
  due date.
- `days_in_arrears` is counted from the date the loan's arrears count from,
  less the tolerance. A loan 87 days late with two days' tolerance is 85
  days in arrears.

Provisioning and portfolio at risk stay on days past due, which is how
SASRA classifies.

### Interest paid in advance

On a fixed-term loan a payment made before a due date pays, by default, the
interest earned to that day, and the rest goes to principal. The product
setting `interestPrepayment` lets a payment take the installment's whole
interest instead, as the reference platform does with its deferred interest account:

| Value | What a payment before the due date does |
|---|---|
| NONE (default) | Pays the interest earned so far; the rest goes to principal. |
| NEXT_INSTALLMENT | Pays the next installment's whole interest before its principal. Anything beyond that goes to principal. |
| ALL_INSTALLMENTS | Each installment the payment reaches gives up its whole interest before its principal, in order. |

The part of that interest not yet earned is credited to the deferred
interest liability, 200-340 Interest Received in Advance (`gl_deferred_interest`,
mapped as the product's `deferredInterest` account), and kept on the loan
as `interest_prepaid`. Each accrual then settles what it earns from there:
Dr Deferred Interest, Cr the interest receivable (under cash, Cr interest
income). By the due date the installment's interest is earned, the
deferred account is back to nothing for it, and the installment is paid.

- A loan that closes with interest still held in advance (the last
  installment paid early) recognises the rest as income on the day, with
  its own interest transaction. Under ALL_INSTALLMENTS an early payoff
  therefore pays the scheduled interest of every installment; under
  NEXT_INSTALLMENT, at most one period's.
- Reversing the payment takes back what is still held and moves what has
  been earned since back into the interest owed (and undoes a closure
  recognition), so the deferred account returns to nothing.
- A write-off, reschedule or top-up of a loan with interest held in
  advance first applies it to principal (Dr Deferred Interest, Cr
  Portfolio): it was never earned.
- The option is for FIXED_TERM products that accrue interest, accept
  prepayments and are not funded; interest posted ON_DISBURSEMENT is all
  applied at once, so there is nothing to take in advance.

### Postdated payments

A fixed-term product with `allowPostdatedPayments` accepts payments recorded
now with a later value date: postdated cheques, standing orders, a check-off
promised for a date (a reference platform option for fixed-term loans).

- `POST /api/loans/:id/postdated-payments` with `amount`, `valueDate`
  (later than today), `channelId` and an optional `reference` records one.
  With `installments: true` it records one per unpaid installment not yet
  due, for what the installment still owes, on its due date (optionally
  from installment `from`, references numbered `CHQ-1`, `CHQ-2` from a
  given `reference`). Together they may not exceed what the schedule owes.
- Nothing moves when it is recorded. The end-of-day job
  `applyPostdatedPayments` (after the night's interest, before arrears)
  applies each pending payment on its value date as an ordinary repayment
  dated that day, so it settles what is owed that day in the product's
  allocation. One that cannot be applied (the loan has closed, the channel
  has gone) is marked FAILED with the reason; the rest carry on.
  `POST /api/loans/postdated-payments/run` runs it by hand.
- `POST /api/loans/postdated-payments/:id/cancel` cancels a pending one
  (a returned cheque). `GET /api/loans/:id/postdated-payments` lists them.
- The console has "Postdated payment" and "Postdate installments" actions
  and a list with a cancel link on each pending one.

### Eligibility is enforced at approval

Applying records a request; approving is the credit decision, and that is
where the product's rules bite. `enforce_deposit_multiplier` refuses a loan
above `max_multiplier` times the member's deposits; `require_guarantor_cover`
refuses one where the securities fall short of `min_cover_percent` of the
principal. `GET /api/loans/:id/eligibility` shows the same picture approval
will judge by, guarantors included, so the preview and the decision cannot
disagree.

After the reference platform's "Securities Settings":

- **What counts as cover.** The securities are guarantor pledges and
  collateral. The member's own deposits count as well unless the product
  sets `coverCountsDeposits` to false. The reference platform counts guarantees and
  collateral only; counting deposits is common SACCO practice and the
  default here.
- **When it is checked.** At approval and again at disbursement, including
  a top-up's. A guarantee released or collateral taken off after approval
  stops the money leaving (INSUFFICIENT_GUARANTOR_COVER_AT_DISBURSEMENT).

### Settlement deposit accounts

After the reference platform's "Linking Deposit and Loan Accounts". A loan linked to a
deposit account of its member has what it owes taken from that account.

- **Product settings.**
  - `settlementEnabled` turns linking on. `settlementProductId` names the
    deposit product the account must be under; leave it blank for any.
  - `settlementAutoSet` links a new loan to the member's account of that
    product when there is exactly one.
  - `settlementAutoCreate` opens one for a member who has none.
  - Auto-set and auto-create need a named deposit product that has no
    overdraft. An account with an overdraft is linked by hand only.
- **Settlement option** (`settlementOption`):
  - FULL_DUES: transfer only when the account covers the whole amount due.
  - PARTIAL: transfer whatever the account covers.
  - NONE: linked, no automated transfers.
- **Linking.** `PUT /api/loans/:id/settlement-account` takes a
  `savingsAccountId` (an id or account number); `DELETE` unlinks;
  `GET` shows the account and the loans it settles. The account must be:
  - the loan member's own, active, and not a funding account;
  - under the named deposit product, if one is set;
  - on a product linked to the ledger when the loan's is (or neither);
  - in the loan's branch.
- **The transfer.** The end-of-day job `collectSettlements` runs after the
  night's interest and postdated payments and before `markArrears`.
  - It takes what each linked loan owes now: its charges plus the principal
    of installments fallen due.
  - The money goes through the settlement channel as a withdrawal from the
    deposit account and a repayment of the loan. The clearing account,
    290-200 Settlement Clearing, nets to nothing.
  - The deposit account's own rules stand: whether it can be withdrawn
    from, its minimum balance, deposits pledged as security, and overdraft
    only where allowed. A transfer the account cannot make is not made,
    and the loan goes into arrears like any unpaid loan.
  - A deposit account that settles several loans pays them in the order
    they were linked.
  - `POST /api/loans/settlement/run` runs the job by hand.
- **Retries.** The job runs every day something is owed, so a loan that
  could not be paid on its due date is paid once the money arrives. The reference platform
  transfers on the due date only.
- **Branches.** Moving a loan to another branch moves its settlement account
  too, unless that account also settles other loans. Unlinking returns the
  account to its member's branch.
- **Console.** The loan page has a "Settlement account" action to link or
  unlink, and the product form has these settings.

### Allocation order

`allocation_order` is the product's list, default penalty, fee, interest,
principal, the same idea as the reference platform's drag-and-drop
(Repayment Allocation Order).
A partial repayment walks it. The database refuses an order that does not
name all four components once.

### Working with loan accounts

After the reference platform's "Working with loan accounts" pages.

- **The end of day leaves a broken loan out.** The loan jobs (billing,
  rate reviews, interest, arrears, penalties, fees, planned fees, fee
  amortisation, the lending controls) run each loan in its own savepoint.
  - A loan that throws is rolled back and put on `loan_eod_exclusions` with
    the job, the business date and the error. The job carries on with the
    other loans and lists the loans it left out in its result.
  - From then on every loan job leaves it out, as the reference platform does. Postdated
    payments and settlement transfers wait for it.
  - A failure on more than a tenth of the loans a job looks at (and at
    least three) is treated as a fault in the system: the job fails and no
    loan is left out. Database and connection errors fail the job as before.
  - `GET /api/loans/eod-exclusions` lists them. `POST /api/loans/:id/eod-include`
    brings a loan back and runs every loan job it missed up to today. If it
    still fails, the inclusion is refused and the loan stays out.
- **Pay-off.** `GET /api/loans/:id/pay-off` quotes the principal and the
  charges owed on a date; the interest brought to the day is worked out in a
  savepoint and not booked. `POST /api/loans/:id/pay-off` takes `interest`,
  `fees` and `penalty`, the amounts collected of each (default: all). What
  is not collected is written off against the write-off expense as a
  `LOAN_BALANCE_WRITE_OFF`. The principal is always paid in full, the
  payment is one repayment through the channel, and the loan closes as
  CLOSED_REPAID. A revolving loan is closed by it too.
- **Terminate.** `POST /api/loans/:id/terminate` makes everything owed fall
  due on the date: every installment not yet due stays, with its
  principal, and falls due that day. The interest earned to the day goes on
  the first of them, and of their fees only those already applied stay
  owed. The loan keeps its state and every running-loan rule; `sub_state`
  shows TERMINATED. `POST /api/loans/:id/undo-terminate`, or reversing the
  LOAN_TERMINATED transaction, puts the schedule back while no repayment
  has been posted since. The reference platform offers this for dynamic loans; here
  it is open to fixed-term, dynamic and interest-free loans, not revolving,
  tranched or funded ones.
- **Disbursement details.** An application may carry an anticipated
  disbursement date, a first repayment date, and the channel or the
  member's own deposit account the money will go to (on `POST /api/loans`,
  `PUT /api/loans/:id/disbursement-details`, or `PATCH /api/loans/:id`).
  Every change is kept in `loan_disbursement_detail_changes`. The tenant may
  restrict who sets them (`disbursementConditionsRoles` in the controls;
  blank means any role that edits applications). The first repayment date
  sets the first due date of the schedule.
- **Disbursing into a deposit account.** `POST /api/loans/:id/disbursements`
  with `savingsAccountId`, or with no channel when the details name an
  account, pays the loan into the member's deposit account: a Disbursement
  on the loan and a Deposit on the account through the transfer channel
  (290-210 Loan Transfer Clearing, which nets to nothing). The account must
  be active, not overdrawn and not a funding account, and both products
  linked to the ledger or neither. Reversing either half reverses both.
- **Repayment rules.**
  - A repayment cannot be dated before one already entered on the loan
    (The reference platform: backdate only where no repayment is entered after the date).
  - Repayments are reversed newest first.
  - A custom allocation needs the product's `allowCustomAllocation` (on by
    default for products set up before this) and, where the tenant lists
    them, one of the `customAllocationRoles`.
- **Repayment from a deposit account.** `POST /api/loans/:id/repayments`
  with `savingsAccountId`, or `POST /api/savings/:id/loan-repayments` with
  `loanAccountId`: a Withdrawal on the account (any member's, so member A
  may repay member B's loan) and a Repayment on the loan, each naming the
  other. The deposit account's own rules stand. Reversing the withdrawal
  from the savings side reverses both, as the reference platform does.
- **Bulk collection.** `GET /api/loans/collections/sheet` lists what is due:
  `view=REPAYMENTS` every installment in a date range at its expected
  amount, or `view=ACCOUNTS` everything due by account as of one date,
  filtered by branch, product or member; `format=csv` exports it.
  `POST /api/loans/collections/batches` posts the rows chosen, each in its
  own savepoint, with the batch's channel, date and reference filling in
  what a row does not give. One batch runs at a time per tenant. The
  console prints the sheet and highlights rows changed from their defaults.
- **Fees applied by hand** may be back dated as far as the last repayment,
  placed on a chosen installment (`installmentNumber`), and applied to a
  locked loan.
- **Adjust, waive and reduce.**
  - Adjust (`POST /api/loans/fees/:id/adjust`, `POST /api/loans/penalties/:id/adjust`)
    takes a charge back as if never applied: its entry is reversed and its
    transaction marked reversed. A fee is adjusted only while nothing has
    been paid on it; a penalty only before a repayment is entered after it.
  - Waive stays as before: the unpaid part comes off against income.
  - Reduce Balance (`POST /api/loans/:id/reduce-balance` with `component`
    FEE or PENALTY and `newBalance` or `amount`) writes the difference off
    against the write-off expense. On a fixed-term loan, a schedule edit that
    lowers a fee does the same (the reference platform's Fee Due Reduce).
- **Changing a running loan's rate.** `POST /api/loans/:id/interest-rate`
  with `rate` (or `spread` for an indexed loan) and `effectiveFrom`. The
  change is a new rate period; a loan with none gets one for its opening
  rate first. A date that has come applies at once, a later one at the end
  of that day, and a fixed-term loan takes the new rate at its next due
  date. It cannot be dated before a repayment on the loan, nor before the
  day interest has been accrued to: accrued interest here stands for
  The reference platform's Interest Applied. Each change is a non-financial
  `LOAN_RATE_CHANGED` transaction.
- **Payment holidays** take `kind` NO_PRINCIPAL_NO_INTEREST (the default:
  nothing due, the term extended) or PRINCIPAL_NO_INTEREST (principal due,
  no interest, the term unchanged). For the first kind `interest` is
  SPREAD over the installments after the holiday (the default), NONE, or
  APPLY_LATER, held on the loan until `POST /api/loans/:id/holiday-interest`
  applies it: on a dynamic loan booked at once on the current installment,
  on a fixed-term loan spread over the installments to come. Interest not
  charged or held does not accrue through the holiday on a dynamic loan.
- **Revolving installments added by hand.** `POST /api/loans/:id/revolving-installments`
  with a `dueDate`, on an application or a running loan, after the last
  installment billed. It is filled on its date like any bill, or marked
  GRACE when there is nothing to bill. The product's billing dates up to
  the last date added by hand are skipped and resume after it. One not yet
  billed may be removed; `GET /api/loans/:id/revolving-schedule` shows them.
- **Guarantors** may be added to an approved or running loan and removed
  (`DELETE /api/loans/:id/guarantors/:guarantorId`) when the loan stays
  covered under its product's rules.
- **Loan history.** `GET /api/members/:id/loan-history` gives the closed
  loans with how they closed, the largest amount approved, each loan's
  on-time repayment rate (installments paid in full on or before their due
  date, replayed from the repayments that stand), the overall rate, and
  the completed loan cycles (loans closed with all obligations met). The
  loan overview shows the cycles too.
- **Attachments.** `POST /api/loans/:id/attachments` takes a file as JSON
  (`fileName`, base64 `content`) or as the raw body with the name in the
  query, up to 10 MB, on the reference platform's list of types and name rules; an encrypted
  PDF is refused because it cannot be scanned. Files are listed, previewed,
  downloaded, retitled and deleted, and each of those is in the audit log.
- **Interest from arrears.** On a loan that earns interest on its balance,
  the part of each accrual earned on overdue principal is kept as interest
  from arrears (`interest_from_arrears_accrued`). It is a breakdown of the
  interest, never added to it, it is paid first, and the arrears tolerance
  does not affect it. The loan overview's `breakdown` shows, for principal,
  interest, fees and penalties, what is expected, due, paid and outstanding.
- **Reschedule and refinance.**
  - `capitalize` { interest, fees, penalty } capitalises those amounts and
    writes off the rest; `arrears` CAPITALIZE or WRITE_OFF still does all
    or nothing.
  - A reschedule may reduce the principal (`principal`, the new amount);
    the difference is written off.
  - Unpaid late repayment and payment-due fees move to the new loan as
    fees (`carryFees`, default true, the reference platform's rule) rather than being
    capitalised or written off.
  - `keepAccountNo` gives the new loan the old account number; the old loan
    is renumbered and keeps the number it had in `previous_account_no`.
  - `POST /api/loans/:newId/undo-restructure` undoes either while the new
    loan has taken no repayment: the entry is reversed (a top-up's payout
    too), the charges written off come back, what the new loan booked since
    is reversed, and fees, guarantors, collateral, deferred fee income and
    a kept number return. The original runs again and the new loan is
    Closed (Withdrawn).
- **Not built from these pages:** the secondary marketplace for funded
  loans, which the reference platform no longer offers. Solidarity group loans and lines of
  credit are in "Lines of credit and solidarity group loans".

### Lines of credit and solidarity group loans

After the reference platform's "Loans for Groups" and "Working with Credit Arrangements
(Lines of Credit)" pages. Nothing existing changes: no product is for
solidarity groups, and every loan and deposit product starts with credit
arrangements NOT_REQUIRED, until a tenant says otherwise.

**Solidarity group loans.** One individual loan account per member, each
with its own ID, amount and schedule, all opened together for a group
(`POST /api/groups/:id/solidarity-loans` with the product, the shared loan
settings and `members: [{ memberId, principal }]`; `GET` lists them with
their totals). Each loan is then approved, disbursed, repaid and written off
on its own, so one member's default leaves the others running and a member
who defaulted can be left out of the next cycle.

- The product is available to solidarity groups only (`availableFor:
  ['SOLIDARITY_GROUPS']`; the reference platform's `HYBRID_GROUPS` is read as it). The
  database refuses the product to an individual on their own and to the
  group itself.
- Every member named must be in the group, once. The loans sit in the
  group's branch with the group's credit officer.
- A member's loan keeps the group it was made under
  (`loan_accounts.solidarity_group_id`), and a reschedule keeps it where the
  new product is also for solidarity groups.
- Loan cycles advance per member: a repaid solidarity loan counts in the
  member's `loanCycle` and `groupLoanCycle`.
- A group with solidarity loans cannot be deleted. The group page in the
  console lists them and opens new ones.

**Lines of credit (credit arrangements).** the reference platform's API v2 at
`/api/creditarrangements`: list (filters `holderKey` and `state`, paging
headers), `POST`, `GET`, `PUT`, `PATCH` (JSON Patch or plain fields) and
`DELETE /:id`, `POST /:id:changeState`, `POST /:id:addAccount` and
`:removeAccount` (`accountId`, `accountType` LOAN or DEPOSIT), `GET
/:id/accounts`, `GET /:id/schedule` (the instalments of its loans that are
not closed, by due date, each with principal, interest and fees expected,
paid and due), `POST /api/creditarrangements:search` (the reference platform's
`filterCriteria` and `sortingCriteria` on the arrangement's fields and its
custom fields), and `GET /api/clients/:id/creditarrangements` and
`/api/groups/:id/creditarrangements`.

- **Fields:** an amount, an ID (CA000001 onwards, or given), a start date
  and an expire date, the exposure limit type, notes and custom fields
  (entity CREDIT_ARRANGEMENT).
- **Exposure:** APPROVED_AMOUNT counts the loan amounts and overdraft limits
  of the linked accounts that are not closed; OUTSTANDING_AMOUNT counts the
  principal they owe and the overdrawn balances. Consumed is the exposure,
  available the amount less consumed. Both bases are shown. The amount may
  be set below the exposure, making available negative (the reference platform); nothing more
  is then paid out.
- **States:** PENDING_APPROVAL, APPROVED (by approval, or on creation when
  the client controls say so: `creditArrangementInitialState`, shipped
  PENDING_APPROVAL), ACTIVE (the first account added), CLOSED (every linked
  account closed first), WITHDRAWN and REJECTED (from pending approval).
  Approve, reject and withdraw each have an undo; a closed arrangement is
  reopened with UNDO_CLOSE, and its accounts cannot reopen while it is
  closed.
- **Linking:** each product says whether its accounts are linked
  (`creditArrangementRequirement`: NOT_REQUIRED, OPTIONAL or REQUIRED). An
  account is added once the arrangement is approved; it must be the same
  holder's, open and in no other arrangement. A loan must be in partial
  application, pending approval, approved or active, disbursed inside the
  dates and maturing by the expire date. A deposit account needs an
  overdraft with an expiry date by the expire date. A loan can be linked
  when it is applied for (`creditArrangementId`). An account is removed
  unless it is closed or its product requires an arrangement; an
  arrangement is deleted only with no accounts.
- **The engine's checks:** the limit when an account is added, when a
  linked loan's amount or an overdraft limit is raised, at every payout
  (first disbursement, tranche or revolving draw), and on the outstanding
  basis when a withdrawal goes into a linked overdraft. A payout also needs
  the arrangement approved or active and the date inside its dates, and a
  new schedule must mature by the expire date. Under a REQUIRED product a
  loan is not approved or disbursed, and an overdraft is not set, without
  an arrangement. A product with linked open accounts cannot go back to
  NOT_REQUIRED.
- **Restructures:** a rescheduled or refinanced loan stays linked (the reference platform);
  the new principal must fit with the old loan left out.
- **Permissions:** the reference platform's 13 codes. Roles and users holding a loan
  permission were given the matching one (tenant migration 035, platform
  migration 010). `REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT` is the reference platform's own
  spelling.
- **Reading:** a CREDIT_ARRANGEMENTS custom view and menu item, the
  indicators CREDIT_ARRANGEMENTS and CREDIT_ARRANGEMENT_AMOUNT, and a
  branch-limited user sees the arrangements of the holders they see. In the
  console the member and group pages list them, and each opens on its own
  page with its state actions, accounts and edits.
- **The Excel import** still refuses revolving, tranched, index-rate and
  adjustable-rate loans and solidarity loans, as the reference platform's own template does.

### Closing and exiting a loan account

After the reference platform's "Closing and exiting a loan account" pages.

- **A lock that suspends only some activities.** `POST /api/loans/:id/lock`
  takes `suspend: { interest, fees, penalties }` (each true unless given
  false) and a `valueDate`. Interest keeps accruing on a lock that leaves
  it running, and the end of day's fee job applies late and payment-due
  fees on one that leaves fees running. `POST /api/loans/:id/lock-settings`
  changes what the lock suspends while the loan stays locked. Lock, change
  and unlock are each a non-financial transaction on the loan
  (LOAN_LOCKED, LOAN_LOCK_CHANGED, LOAN_UNLOCKED).
- **Penalties after an unlock.** On an overdue basis the days in arrears
  while locked are forfeited. On the outstanding principal, what accrued
  while locked is applied on the first installment due date after the
  unlock, against that installment. Penalties run again from the unlock
  date. The same happens when a lock change resumes penalties.
- **Delete.** `DELETE /api/loans/:id` (tenant admin) removes a loan created
  by mistake: an application, or one rejected or withdrawn, that was never
  disbursed and has no transaction (reversed ones included), no attachment,
  no loan referring to it and no funding moved. Its guarantors, collateral
  and other rows go with it; the audit log keeps a copy (LOAN_DELETED).
- **Name.** A loan takes a `name` on application and `PATCH /api/loans/:id`
  changes it in any state.
- **Undo closure.** `POST /api/loans/:id/undo-close` reopens a loan closed
  as CLOSED_REPAID, by a final repayment or a pay-off, within the tenant's
  `maxDaysUndoClose`. It returns to ACTIVE, or IN_ARREARS if it was in
  arrears; a lock it was closed from does not come back. The guarantors and
  collateral the closure released are pledged again (kept in
  `loan_accounts.closure`) and fee income recognised at closing is deferred
  again. The reopened loan owes nothing until the repayment that closed it
  is reversed. The undo is a non-financial transaction
  (LOAN_CLOSURE_UNDONE).
- **Collect securities.** A write-off request with `collectSecurities:
  true` takes each guarantor's pledge from their deposit accounts, oldest
  first, as a repayment of the loan before the rest is written off. It runs
  when the write-off is executed, at approval or at once where approval is
  off. Each amount is a withdrawal from the deposit account and a
  repayment through the `transfer` channel, linked to each other. The
  deposits need not be withdrawable; the guarantor's other pledges and
  each account's minimum balance are left alone. A pledge taken in full is
  RECOVERED; one taken in part is called by the write-off for the rest.
  If the securities pay the loan off, nothing is written off.
- **Permissions.** Three role lists on the lending controls, each NULL by
  default (any role the route allows): `payOffRoles` for a pay-off,
  `loanAdjustmentRoles` for writing charges off in a pay-off and for Reduce
  Balance, and `collectSecuritiesRoles` for asking or approving a write-off
  that collects securities.
- **Pay-off preview for a date to come.** `GET /api/loans/:id/pay-off?valueDate=`
  with a future date runs the end of day's interest, arrears and penalty
  steps to that date in a savepoint that is rolled back, so the figures
  include what will have accrued by then. A pay-off itself cannot be dated
  in the future.
- **Terminate** keeps the installment count (above, under "Working with
  loan accounts").
- **Unchanged:** interest a lock suspended is brought to date after the
  unlock, as before, because on a fixed schedule the installment interest
  is contractual.

### Managing your organization

After the reference platform's "Managing your Organization" pages. The console's
Organization page covers all of it.

- **Organization details.** `GET` and `PUT /api/organization` (tenant
  admin): institution name, contact details (street address, city,
  region, postcode, country, phone, email), base currency, time zone, date
  and date/time formats and the decimal mark. The name, time zone and
  currency live on `platform.tenants`. The base currency changes only while
  nothing is posted, and only to a currency in the register.
- **Branding.** `PUT /api/organization/branding/logo` or `/icon` with a
  base64 PNG, JPEG, GIF or WebP up to 512 KB (SVG is refused: it can carry
  script). The logo is public for the tenant, for the sign-in screen.
- **Branches.** Address, email and notes as well as code, name, town and
  phone; `GET /api/branches/:id` shows centres, counts, holidays and
  activity. A branch with active centres cannot be deactivated.
- **Centres.** `/api/centres`: a code, a name, a branch, an optional weekly
  meeting day (0 Sunday to 6 Saturday), deactivate and reactivate. A member
  may be put in a centre of their branch. A loan to a member of a centre
  with a meeting day has its first repayment moved to the next meeting day
  on or after the date the schedule would give it.
- **Product availability per branch.** `availableBranches` on loan and
  deposit products (IDs or codes; null for every branch). An application or
  deposit account in another branch is refused.
- **Holidays and non-working days.** `/api/holidays`: holidays on a date or
  recurring every year, organization-wide, for a branch or for a currency,
  each with an ID; `PUT /api/holidays/non-working-days` sets the days of the
  week. One SQL function, `is_closed_day`, answers for schedules, arrears
  tolerance and penalty days, with a loan's branch holidays counted for it.
  A change marks the calendar changed; `syncCalendar` (or
  `POST /api/holidays/sync`) then moves the unpaid installments due after
  today to where the product's rule puts their nominal dates. Amounts stay;
  installments already due are not moved.
- **Transaction channels.** `/api/transaction-channels`: create, edit,
  deactivate, delete if never used, and reorder. Cash is the default and
  cannot be deleted or deactivated. Usage rights by role, and loan and
  deposit constraints by amount, transaction type and product, matched ALL
  or ANY, are checked on disbursements, repayments, recoveries, deposits and
  withdrawals. The `internal` repayment flag and the `offsetPledge`
  withdrawal flag are refused from the wire.
- **ID templates.** `/api/id-templates`: ID type, issuing authority, an input
  mask (# digit, @ letter, $ either), mandatory, allow attachments; a toggle
  for Other documents. Members carry documents
  (`/api/members/:id/identifications`), checked against the mask; mandatory
  templates are required when a member is created. A template in use cannot
  be deleted.
- **Rates.** A rate source has a kind: INTEREST, VAT or WITHHOLDING. Loan
  products take `taxSourceId` (VAT) and deposit products
  `withholdingSourceId`; the value in force becomes the product's
  percentage, at once for a value dated today or earlier and through
  `updateTaxRates` for later ones. A value already in force for a source in
  use cannot be edited or deleted, nor can a source in use.
- **Currencies.** `/api/currencies`: the base currency and other ISO 4217
  fiat currencies (code and decimals fixed, name, symbol and position
  editable), exchange rates (buy and sell, from a moment, never before the
  latest) and accounting rates. Products and accounts stay in the base
  currency; cryptocurrencies and non-traditional currencies are not offered.
- **End of day.** `GET` and `PUT /api/organization/eod`: AUTOMATIC or MANUAL,
  an accounting cutoff time (a posting with no booking date after it is
  booked on the next local day) and hourly retries of loans left out.
  `POST /api/organization/eod/run` is Run Now for a tenant on manual end of
  day. Each run is recorded in `eod_completions` with its state, failed jobs
  and loans left out (the reference platform's Accounts Updated event, kept for when
  notifications exist).
- **Custom fields.** `/api/custom-fields`: sets (standard or grouped) and
  definitions for clients, groups, loan accounts, deposit accounts, deposit
  products (per product type), credit arrangements, guarantors, assets,
  branches, centres, users, transactions by channel and transactions by type
  (transfers). The reference platform's nine types: free text with a mask
  and a unique flag, selection with scores and dependent options, number,
  checkbox, date, date and time, client, group and user links. Usage is
  Available, Default or Required, per item where the reference platform
  allows it; a dependent field follows its parent. View and edit rights are
  per role. Values sit with the record in `custom_fields`;
  `GET` and `PUT /api/custom-fields/values/:entity/:id` read and change them
  with the entity's own permission, the user's branches and the member
  rules, and the create paths take `customFields`. `/clients`, `/groups`,
  `/deposits` and `/creditarrangements` show values as the reference
  platform does (strings, `_index` on grouped entries, only with
  `detailsLevel=FULL`), take JSON Patch paths into grouped sets, and search
  them by type. At most 200 values per record, 25 on a transaction.
  `GET /api/customfields/:id`, `/api/customfieldsets` and
  `GET`/`PUT /api/configuration/customfields.yaml` are the reference
  platform's metadata and configuration as code. The console's
  Organization page has the Fields administration.
- **Product documents.** `/api/documents/templates/:kind/:productId`: HTML
  templates per product, for an account or a transaction, with
  placeholders (organization, member, account, transaction and custom
  fields), statement and schedule blocks and page breaks.
  `GET /api/documents/:kind/:accountId/:docId` fills one in the
  organization's date format and decimal mark and serves it under a content
  security policy that allows no script.
- **Native fields** need nothing new: custom field sets appear in JSON
  under their `_` IDs, beside the native fields.
- **Found on the way:** new member numbers compared the digits of existing
  numbers as text, so '0006' sorted after '000007' and a number could repeat.
  They are compared as numbers now. (Member IDs now come from the client
  type's counter; see "Members and groups".)

## Data management

After the reference platform's Data and Reporting > Data Management pages. The console's
Data page covers the import, backups, the data dictionary and the extract.

### API standards

- **Dates.** A calendar day (a DATE column: due dates, value dates, dates
  of birth) is read and written as `yyyy-MM-dd`, with no time and no
  offset, and it is the organization's day. A moment (a timestamptz column)
  is returned in UTC as `yyyy-MM-ddTHH:mm:ss.sssZ`. The pg driver used to
  turn a DATE into a JavaScript Date at local midnight, so on a server
  running in Africa/Nairobi every date read back through `toISOString()`
  came out a day early; `src/db/pool.js` now keeps the database's string.
  The suite checks it under four time zones.
- **Paging.** `offset` and `limit` (default 50, at most 1,000, the reference platform's
  maximum), with `items-offset`, `items-limit` and `items-total` headers.
- **Nulls.** Every column is returned, null or not, unless the request asks
  for the reference platform's behaviour: `Accept: application/vnd.sacco.v2+json` or
  `?nulls=omit` leaves out every null field at any depth (nulls inside an
  array keep their place). The response then carries `x-nulls: omitted`.
- **Identifiers.** Members, loans, deposit and share accounts, branches,
  centres and product fees are found by id or by their own number or code.
- **Errors.** One envelope everywhere: `{ "errors": [{ "errorCode",
  "errorReason", "errorSource"? }] }`.

### Data dictionary

`GET /api/data-dictionary` (any staff user; `?format=csv` for a
spreadsheet; `/api/data-dictionary/:table` for one table) lists every
table and column of the tenant's schema with its type, nullability,
primary key, the table and column a foreign key refers to, whether a date
is an organization date or a UTC timestamp, and what it means. Structure
comes from the database catalog, so the dictionary is always the schema as
it stands; the words are in `src/db/dictionary.js`, by column or by
convention (every `member_id` is the member, every `gl_*` a GL account).
Every migration writes the words into the catalog as `COMMENT ON`, so
`\d+` in psql and any BI tool reading the catalog show them too
(`cli dictionary:apply --slug x` does it by hand, `cli dictionary:export`
prints the CSV). The data management suite fails when a table or column
has no description, so a migration that adds a column has to add its words.

### Database backup

After the reference platform's Database Backup API, for the SACCO rather than the platform
(the platform's own encrypted pg_dump backups are under Operations).

- `POST /api/database/backup` (tenant admin) returns 202 with the backup
  in `IN_PROGRESS`; it is taken in the background. Optional: `tables` (a
  list), `createBackupFromDate` (only rows created or changed from that
  moment, for tables that record either) and `callback` (a URL called with
  the result).
- `GET /api/database/backup/LATEST` downloads the most recent one; 409 if
  it is still running, 410 once it has expired. `GET /api/database/backup`
  lists them; `/:id` and `/:id/file` for one.
- The ZIP holds one CSV per table (header row, values in PostgreSQL's text
  form, timestamps in UTC, ordered by primary key), `schema.sql` (CREATE
  TABLE statements with the comments, so the CSVs load into an empty
  database), `dictionary.json` and `manifest.json` (snapshot time, row
  counts, what was left out).
- Every table is read in one REPEATABLE READ transaction, so the files
  agree with each other. Member PIN hashes, portal sessions and login
  attempts are never exported; binary columns (attachments, logos, stored
  import files) are left out and listed in the manifest.
- One backup runs at a time per tenant (a unique index, not a check in
  code). Files are removed 30 days after they finish
  (`TENANT_BACKUP_RETENTION_DAYS`); the record stays as `EXPIRED`.
- The callback is https only, with no credentials in the URL, and every
  address its name resolves to must be public. The check runs inside the
  connection's own DNS lookup, so a name that resolves elsewhere when
  connected (DNS rebinding) is caught, and redirects are not followed.
  `CALLBACK_ALLOW_PRIVATE=true` lifts this for development only.

### Incremental extract

`GET /api/extract` lists the streams (members, branches, centres, GL
accounts, loan and deposit products, loan accounts, installments and fees,
deposit and share accounts, transactions, journal entries and lines, the
audit log) with their key, what they are read on and a JSON Schema from the
dictionary. `GET /api/extract/:stream?cursor=…&limit=…` (tenant admin,
accountant or auditor; up to 1,000 rows) returns the rows after the cursor,
in order, with `nextCursor` and `hasMore`; `?since=` starts a first call
from a moment.

- Mutable tables are read on `updated_at`, which a trigger now sets on
  every change (migration 028, `clock_timestamp()` so a long end of day
  stamps each row when it changed), so no code path can change a row
  without the extract seeing it. Append-only tables are read on
  `created_at`, journal lines on their entry's.
- The cursor is the pair (timestamp, key) of the last row returned, so
  nothing is skipped or returned twice when many rows share a timestamp.
- A transaction that stamps a row and commits later could let a reader move
  its cursor past the row before it is visible. The extract never returns
  rows at or after its horizon: the start of the oldest transaction still
  writing in the database, less `EXTRACT_LAG_SECONDS` (default 5). The
  suite holds a transaction open and checks that later rows wait for it.

### Stitch, through a Singer tap

`bin/tap-sacco.js` is a Singer tap over the extract, which is how Stitch
(and any Singer target: Postgres, BigQuery, Snowflake, CSV) loads a source:

```
node bin/tap-sacco.js --config config.json --discover > catalog.json
node bin/tap-sacco.js --config config.json --catalog catalog.json --state state.json \
  | target-stitch --config stitch.json > state-out.json
```

`config.json` holds `api_url`, `tenant`, `email`, `password` and optionally
`page_size` and `start_date`. Use a dedicated user in the AUDITOR role: it
reads the extract and nothing else, and it is not a role that must use a
second factor by default (a tap cannot type a code). The tap writes SCHEMA,
RECORD and STATE messages; the state holds the extract cursor per stream,
so each run carries on where the last one stopped. `target-stitch` is
Stitch's own Python package and is not part of this repository.

### Data importing

After the reference platform's Data Importing pages: the Excel import with its review,
The reference platform's data import API, the external loan migration API, and loading a
backup back into a database.

**Before you import** (the reference platform's prerequisites): staff users to be credit
officers, branches, loan and deposit products, and any custom fields.
`GET /api/data-imports/prerequisites` says what is in place; the template's
Instructions sheet lists it, and an upload that needs something missing is
warned.

**The template.** `GET /api/data-imports/template` downloads the workbook.
Sheets to fill in have green headings: Settings (the migration date), GL
Accounts, Chart of Accounts, Branches, Centres, Members, Deposit Accounts,
Share Accounts, Loan Accounts, Loan Schedule, Loan Transactions and GL
Balances. Reference sheets have grey headings and are not imported:
Branches Data, Centres Data, Credit Officers (the SACCO's users), Loan,
Deposit and Share Products, GL Accounts Data and ID Templates. Every custom
field defined for members, branches, centres, deposit and loan accounts has
its column already, headed `Custom: _setId.fieldId (Name)`; checkboxes take
True or False.

**The reference platform's layout is read as well.** the reference platform's sheet names (Clients, Savings
Accounts, Loan Schedules, Transactions) and headings (Client ID, Date Joined
(dd.MM.yyyy), Mobile/Cellphone and Phone, Credit Officer username,
Individual Loan Cycle, Loan Length (# Installments), Repayment Period
(D/W/M/Y), Principal Expected, Current Balance, Overdraft Amount Due, Type
(A/L/I/E/Q), Usage (D/H)) map to this template's columns. Dates may be
dd.MM.yyyy or yyyy-MM-dd; gender M, F or O; meeting days M, T, W, TH, F,
SA, SU. IDs are at most 32 characters and other text 255, as in the reference platform.

**What each sheet carries.**

- Members: the reference platform's client fields, including an ID document (type, number,
  authority, valid until, checked against the ID templates), the credit
  officer (checked against the SACCO's active users) and loan cycles
  completed in the old system. The Status column takes Active, Inactive,
  Dormant or Exited: Active, Inactive and Dormant are imported INACTIVE and
  become ACTIVE with the member's running accounts. A member's Group ID
  column names the groups they belong to (comma separated, on the Groups
  sheet or already in the system) and Group role their role names there
  (IDs or names).
- Groups: Group ID, name, type (a group type ID; blank for the default),
  branch, centre, credit officer, phones, email, address, notes and custom
  fields (`GROUP`). They are created through the same rules as the console,
  and the group controls (membership of more than one group, the size limit)
  apply. A Group ID shares the member numbers' series, so the same ID on
  both sheets is refused. A deposit, share or loan account names a group by
  its Group ID; a loan of a group has client type G, and a G loan of a
  member (or a C loan of a group) is refused.
- Deposit Accounts: the balance (including interest accrued and not yet
  applied), the dates applied and opened (the balance is recorded on the
  opening date, as in the reference platform), notes, an overdraft limit, and for an
  overdrawn account the overdraft amount, interest and fees due and its own
  overdraft interest rate, which then replaces the product's.
- Loan Accounts: any reference platform state (Active, Pending Approval, Approved,
  Closed, Withdrawn, Rejected, Written Off), the dates applied, approved and
  disbursed, the repayment start date, grace installments, and the
  repayment frequency and period (which must be the product's). What was
  paid is given as principal paid or principal outstanding, with interest,
  fees and penalties outstanding, and optionally the principal in arrears.
  Closed loans are history and count as completed loan cycles; they are
  imported before running ones, so a product that allows one loan at a time
  still takes a member's old loans.
  Not imported: revolving and tranched loans, index-rate and
  adjustable-rate loans. Open them in the system.
- Loan Schedule (fixed-term loans): due dates with principal, interest,
  fees and penalties due, and optionally what was paid on each. Without the
  paid columns, what the account says was paid is applied oldest first.
  Installment numbers default to the order of the due dates. A dynamic-term
  loan's schedule is always the product's (the reference platform), so one given is refused.
- Loan Transactions (fixed-term loans): DISBURSEMENT, REPAYMENT, FEE and
  PENALTY, each loan's rows together, oldest first, starting with its
  disbursement. They are replayed against the schedule: repayments in the
  product's allocation order, installment by installment, interest never
  beyond what the schedule has earned by the payment date; fees and
  penalties on the first unpaid installment. They replace the paid and
  outstanding amounts on the account sheet, are recorded in the loan's
  history, and post no journal entries. Paying more than is owed is an
  error.
- Opening balances: GL Balances (debit and credit per account) or the reference platform's
  Chart of Accounts sheet (a balance signed by the account's type: asset and
  expense debit positive, liability, equity and income credit positive), not
  both. New accounts on the Chart of Accounts sheet are created. The
  opening entry is dated the migration date.

**Loans are built by one migration routine** (`src/domain/loanMigration.js`)
that the external migration API uses too. Balances are as at the end of the
migration date; interest accrues from it. Fees on installments due by the
migration date (or already paid) are recorded as applied, so the end of
day does not charge them again; fees on later installments come due on
their dates. Installments already late are exempt from the late fee and
their penalty counts from the migration date.

**Upload, progress and review.**

- `POST /api/data-imports` (the workbook as the body, or a multipart form
  with the file in `file`) stores it and returns 202 with the import
  QUEUED. The check runs in the background: GET `/api/data-imports/:id`
  shows IN_PROGRESS with a percentage, then the outcome. The console shows
  a progress bar. `?wait=true` waits and returns the outcome.
- An import with errors is INVALID; `/errors` returns the workbook with each
  offending cell red, an Errors column on its sheet and an Errors sheet
  last (the reference platform). A file that cannot be read is ERROR.
- A clean one is PENDING_APPROVAL (the reference platform's Draft). `GET /:id/preview`
  lists the records approval will create, by kind and paged (members,
  loans with their balances, arrears and schedules, deposit accounts, the
  opening entry): the reviewer's view of the draft, since nothing is
  written before approval.
- Approve (all or nothing; the uploader may not approve under the four-eyes
  rule) or reject (the reference platform's Reverted). Both take an `Idempotency-Key`.

**The reference platform's data import API** is served on the same imports:

```
POST /api/data/import                             multipart "file" -> { importKey, state }
GET  /api/data/import/{importKey}                 { importKey, state, progress, eventKey, importState, errors }
POST /api/data/import/events/{eventKey}:action    { "action": "APPROVE" | "REJECT" }, Idempotency-Key header
```

`state` is the job's (QUEUED, IN_PROGRESS, COMPLETE, ERROR); `importState`
is DRAFT, APPROVED, REVERTED or INVALID; errors carry the sheet, row,
`column { name, index }` and `errorMessage`. A request repeated with the
same Idempotency-Key gets the first response; the same key on a different
request is refused.

**Migrating loans through the API** (the reference platform's recommended route for large
books). `POST /api/loans/migrate` (tenant admin) creates one loan the way
the import does: the reference platform's body (`loanAccount` with `id`, `accountHolderKey`,
`productTypeKey`, `loanAmount`, `scheduleSettings.repaymentInstallments`,
`disbursementDetails.disbursementDate`, `balances.principalBalance`;
`migrationFields` with `principalInArrears`, `interest`, `interestAccrued`,
`interestFromArrears`, `lastSetToArrearsDate`, `contractualMonthlyPayment`,
`redrawBalance`; `firstRepaymentDate`), plus `migrationDate` and optionally
`schedule` and `transactions`. The migration fields are kept on the loan.
The sequence for a full API migration: members (`POST /api/members`),
deposit accounts with their opening balance, loans with `/loans/migrate`,
then the opening balances as an import with only Settings and a Chart of
Accounts sheet. Run it outside business hours; the rate limit per tenant
applies.

**Loading a backup back** (the reference platform's Import Database clone). The backup ZIP
carries `restore.sql`: unzip it, change into the folder, and run
`psql -d yourdb -v schema=copy -f restore.sql`. Or `cli backup:load --file
backup.zip --schema copy [--database postgres://...]` loads it from Node.
NULL and empty text are kept apart (an empty string is written `""`).

**Also fixed.** The end of day's arrears check read the loan's total
principal paid where it meant the installment's, so a loan that had repaid
more than one installment's principal was never marked in arrears. It now
reads the installment's.

## Members and groups

After the reference platform's Clients and Groups. The platform calls clients members. A
member (holder type `CLIENT`) and a group (`GROUP`) are both rows of
`members`: a group is an account holder of its own and holds loans,
deposit accounts and shares through the same code as a member. A group
keeps its name in `first_name` (`last_name` is empty) and has no personal
details. The members list and the reports' member counts are individuals;
`GET /api/members?holderType=GROUP` lists groups. This is a deviation in
storage only: the API shows groups apart (`/api/groups`), as the reference platform does.

The rules are in `src/domain/clients.js`, the setup in
`src/domain/clientSetup.js`, the duplicate checks in
`src/domain/duplicates.js`, and the reference platform's API shapes in `src/routes/clients.js`.

### Client and group types, and member IDs

`/api/client-types` (the reference platform's Client Types and Group Types): each type is for
members or for groups, with a name, description, ID pattern, whether its
holders may open accounts, whether they may guarantee loans, whether its
members must bring the mandatory ID documents, and whether the address
fields are shown. The defaults are Client (`M######`) and Group
(`G######`); a default type and a type in use cannot be deleted. Custom
fields for members and groups are set per type (the custom field's usage
items are type IDs). `CHANGE_CLIENT_TYPE` and `CHANGE_GROUP_TYPE` change a
holder's type.

An ID pattern is literal characters with `#` for a digit, `@` for a letter
and `$` for either. The run of `#` is filled from the type's counter,
zero-padded and never cut: `M######` gives `M000041`, and `M1000000` after
`M999999`. The counter row is locked while an ID is given out, so members
created at the same time get different IDs, and an ID already taken (by
hand or by an import) is stepped over. An ID by hand needs
`EDIT_CLIENT_ID` (`EDIT_GROUP_ID`) and is 1 to 32 letters, digits, dots,
hyphens or underscores.

### Creating and editing

`POST /api/members` takes the member's details, branch, centre, credit
officer, type, ID documents and custom fields. Without a branch the member
goes to the creator's own branch. Birth dates are checked (a real date, not
in the future, not before 1900), gender is MALE, FEMALE or OTHER (M and F
are read as those), email and phone numbers are checked, and the national
ID is kept without spaces and in capitals. One ID template may be marked as
the national ID (`nationalId: true`): its document fills the member's
national ID, and a change to the national ID changes the document.

`PATCH /api/members/:id` changes the details, each kind of change under its
own permission: the details `EDIT_CLIENT`, the ID `EDIT_CLIENT_ID`, the type
`CHANGE_CLIENT_TYPE`, the branch, centre and credit officer
`MANAGE_CLIENT_ASSOCIATION`. The state does not change by PATCH.

### Duplicate checks

Four checks, each at NONE, WARNING or ERROR in the client controls: the
document number (the national ID or any ID document, compared without
spaces, hyphens or case), name with birth date, phone (the last nine
digits, so `0712...` and `+254 712...` match) and email. ERROR refuses the
create or the edit with `409 DUPLICATE_CLIENT`; WARNING lets it through and
lists the matches in `duplicateWarnings`. The defaults are ERROR on the
document number, WARNING on name with birth date and on phone, and NONE on
email. The lookup runs in the database as the table owner, so a
branch-limited user does not miss a duplicate in a branch they cannot see.
`POST /api/members:duplicates` runs the checks without saving; the console
asks before it saves a member with warnings.

### The life cycle

The reference platform's six states. A new member starts INACTIVE or PENDING_APPROVAL (the
client controls; INACTIVE by default). `POST /api/members/:id/state` with
an `action` and an optional `reason`:

| Action | From | To | Permission |
|---|---|---|---|
| APPROVE | PENDING_APPROVAL | INACTIVE | APPROVE_CLIENT |
| UNDO_APPROVE | INACTIVE, with no accounts or guarantees ever | PENDING_APPROVAL | UNDO_CLIENT_STATE_CHANGED |
| REJECT | PENDING_APPROVAL | REJECTED | REJECT_CLIENT |
| UNDO_REJECT | REJECTED | PENDING_APPROVAL | UNDO_CLIENT_STATE_CHANGED |
| EXIT | INACTIVE | EXITED | EXIT_CLIENT |
| UNDO_EXIT | EXITED, not anonymized | INACTIVE | UNDO_CLIENT_STATE_CHANGED |
| BLACKLIST | PENDING_APPROVAL, INACTIVE, ACTIVE | BLACKLISTED | BLACKLIST_CLIENT |
| UNDO_BLACKLIST | BLACKLISTED | the state before | UNDO_CLIENT_STATE_CHANGED |

ACTIVE and INACTIVE follow the accounts on their own, in the database: a
member is ACTIVE while they have a running loan (active, in arrears or
locked) or an open deposit account (active, in arrears, dormant, locked or
matured). Share
accounts do not count. Exiting needs no open loan or application, no open
deposit account (`POST /api/savings/:id/close` closes an empty one), no
pledged guarantee on a running loan, no shares held (a member transfers
them first; the minimum holding applies to what stays, not to a full
transfer) and no group membership. The exit is dated, and emptied share
accounts close with it.

The database refuses a new running account unless its holder is INACTIVE
or ACTIVE and of a type that may open accounts, and unless the product is
available to that kind of holder. It refuses a guarantee unless the
guarantor is INACTIVE or ACTIVE and of a type that may guarantee. A
blacklisted member's existing accounts still transact; its details cannot
change, and its custom fields change only with
`EDIT_BLACKLISTED_CLIENT_CFV`. Groups have no state actions: a group is
INACTIVE or ACTIVE by its accounts. Every change of state, the automatic
ones included, is in `member_state_changes`
(`GET /api/members/:id/state-history`).

The migration mapped the old states: PENDING to PENDING_APPROVAL, DECEASED
to EXITED with the exit reason DECEASED, and ACTIVE and DORMANT to ACTIVE or
INACTIVE by the member's accounts (dormancy is a deposit account's state).

### Reassigning, deleting and anonymizing

`POST /api/members/:id/association` and `POST /api/members:reassign` (up to
1,000 members) change the branch, centre and credit officer
(`MANAGE_CLIENT_ASSOCIATION`). In bulk, a blank centre or credit officer
keeps each member's own. With `moveAccounts: true` the member's open loans
and deposit accounts move too, through the inter-branch postings (which
needs `MANAGE_LOAN_ASSOCIATION` and `MANAGE_DEPOSIT_ASSOCIATION` as well).

`DELETE /api/members/:id` (`DELETE_CLIENTS`; `DELETE_GROUP` for a group)
deletes a member or group that never held an account or a guarantee; its
copies in the audit log lose the personal details.
`POST /api/members/:id/anonymize` (`ANONYMIZE_CLIENT`) removes an exited
member's personal details, ID documents, portal access and custom field
values, and keeps the number, the accounts and the ledger. It waits for the
tenant to set `anonymizeAfterDays` in the client controls, and for that
many days to pass after the exit. The period ships unset, since how long
member records must be kept depends on the Kenya Data Protection Act 2019
and the SACCO's own obligations.

### Groups

`/api/groups` (the reference platform's API): a group has a name, a type, members (each with
any number of role names), a branch, centre and credit officer, contact
details, an address, notes and custom fields. `/api/group-role-names`
holds the role names (chairperson, treasurer, signatory); one in use is not
deleted. `POST /api/groups/:id/members` and
`DELETE /api/groups/:id/members/:memberId` add and remove members. A group
holds individuals only; an exited or rejected member joins none. The client
controls decide whether a member may be in more than one group, and the
group size limit (NONE, WARNING or HARD). Loan, deposit and share products
say who may hold them (`availableFor`: INDIVIDUALS, GROUPS; the reference platform's
`PURE_GROUPS` is read as GROUPS; a loan product may instead be for
SOLIDARITY_GROUPS alone). Loan and deposit products start as
INDIVIDUALS; share products start open to both, since a chama may hold share
capital. A group has no member portal. Groups are imported from the Groups
sheet (see "Data importing"). Solidarity group loans, one loan per member
made together for the group, are in "Lines of credit and solidarity group
loans".

### The reference platform's API v2

`/api/clients` and `/api/groups` take and return the reference platform's Client and Group
objects: `GET` (with `offset`, `limit`, `paginationDetails=ON`), `POST`,
`GET /:id`, `PUT /:id` (the whole object; personal fields left out are
cleared), `PATCH /:id` (the reference platform's JSON Patch, or a plain object of fields; a
patch of `/state` is the state action that leads there), `DELETE /:id`,
`POST /clients:search` and `POST /groups:search` (the reference platform's field names and
operators, custom fields as `_set.field`, done in SQL), and
`GET /clients/:id/role` (the client type). `/api/members` stays in the
platform's own shape.

### Pictures, signatures and identification document files

`PUT`, `GET` and `DELETE /api/members/:id/picture` and `/signature` (the reference platform's
profile picture and client signature): the image as the raw request body,
PNG, JPEG or GIF, up to 50 MB, checked by its first bytes and not by the
type the request claims. Setting one needs `EDIT_CLIENT`; a blacklisted
member's may still change (the reference platform); anonymizing removes them. Groups have
none.

An identification document takes up to five files of up to 50 MB each
(The reference platform's limits), PNG, JPEG or PDF, as the raw request body:
`POST /api/members/:id/identifications/:docId/files?fileName=`, listed by
`GET .../files`, downloaded by `GET .../files/:fileId` (`VIEW_DOCUMENTS`)
and removed by `DELETE .../files/:fileId`. The single scan a document could
carry before (sent as base64 JSON, up to 700 KB) still works and counts as
one of the five (file ID `original`).

A document past its valid-until date is flagged `expired` (and one still
valid has `expiresInDays`); nothing is refused because of it. A member
shows `expiredIdDocuments`, and the MEMBERS custom view has an Expired ID
documents field to find them.

### Groups in custom views

Custom views have a GROUPS entity (the reference platform's), with the group's ID, name,
type, state, number of members, contact details, association, running loans
and balances, and its custom fields; `GET /api/groups?viewfilter=` lists
what a saved view matches, and menu items can hold group views.

### Client controls

`GET /api/client-controls` (any staff user) and `PATCH` (administrators):
`initialState`, `duplicateChecks`, `requiredAssignments` (BRANCH, CENTRE,
CREDIT_OFFICER), `multipleGroups`, `groupSizeLimitType` and
`groupSizeLimit`, `anonymizeAfterDays`, and `creditArrangementInitialState`
(PENDING_APPROVAL or APPROVED).

**In the console** the Members page has the full create form (type,
details, branch, centre, credit officer, the mandatory ID documents and the
type's required custom fields), a bulk reassign, and on each member Edit,
Change association, the state actions, the state history, Anonymize and
Delete, as the user's permissions allow. The Groups page lists and creates
groups; a group's page shows its members and roles. The Organization page
has the client and group types, the group role names and the client
controls. A member's page has the picture and signature, and each
identification document its files and expiry. A deposit account and a
branch each open on a page of their own, with their report templates.

## Staff users

After the reference platform's Users and Access Control. Every user has a role (one of the
five built-in roles, `TENANT_ADMIN`, `MANAGER`, `ACCOUNTANT`, `TELLER`,
`AUDITOR`, or one of the tenant's own), may have extra permissions of their
own, an optional user type, a branch and branch access, and transaction
limits. The console's Users page covers users and roles; its Access page
covers the access preferences, API consumers and the audit trail.

```
GET  /api/users              GET /api/users/{id}          POST /api/users
PATCH /api/users/{id}        POST /api/users/{id}/unlock  GET /api/users/{id}/logins
POST /api/users/{id}/reset-password                       POST /api/users/{id}/reset-mfa
GET|PATCH /api/profile       GET /api/auth/logins         POST /api/auth/reauth
```

- `VIEW_USER_DETAILS` lists and reads users, `CREATE_USER` creates them,
  `EDIT_USER` changes them (and unlocks them). Only an administrator resets
  someone else's password, as in the reference platform; `MANAGE_TWO_FACTOR_AUTHENTICATION`
  resets a second factor. Custom field values on users need `EDIT_USER`.
- Only an administrator creates or edits an administrator. Someone who is
  not an administrator may give a user only a role, and extra permissions,
  that they hold themselves.
- User types, as in the reference platform: administrator (it goes with the administrator
  role), teller (a teller role, or the type set on the user) and credit
  officer. An administrator is never also a teller. A teller and a credit
  officer belong to a branch (checked when the user is created, and when
  their type, role or branch changes).
- A new user, and a user whose password is reset, is given a temporary
  password, shown once. Signing in with it returns 403
  `PASSWORD_CHANGE_REQUIRED` with a token scoped to `POST /auth/password`
  and nothing else; the user chooses their own password under the tenant's
  policy and then signs in.
- Nobody changes their own role, permissions or status, and the tenant's
  last active administrator can be neither demoted nor suspended (changes to
  one tenant's users are serialised).
- A user is ACTIVE, INACTIVE (suspended; the reference platform's deactivated) or LOCKED
  (too many failed sign-ins). Deactivating a credit officer who still has
  members needs `confirmCreditOfficerMembers: true` (the reference platform asks the same).
  Users are not deleted; deactivating keeps the history, which is what
  The reference platform recommends when deletion is refused.
- Suspending a user, changing their role, and resetting their password or
  second factor end their sessions. Every staff request reads the user's
  state, role and permissions (cached for ten seconds, cleared at once when
  this process changes them), not the token, so a change takes effect on
  the next request.
- A user edits their own name, title, phone and language, and changes their
  own password (`PATCH /api/profile`, `POST /api/auth/password`), and sees
  their own sign-in history, failures and why (`GET /api/auth/logins`).
- Every change is written to `platform.audit_log`; `GET /api/users/audit`
  shows the tenant's.

### Credit officers

A member's or loan's credit officer is a staff user of the tenant of the
credit officer type, or an administrator (who holds the credit officer's
rights in the reference platform). The database checks it whenever a credit officer is set or
changed, on members and loans alike; a loan that takes its member's credit
officer unchanged is not checked again. A credit officer who is not given
"other credit officers' clients" sees only their own members and those with
no credit officer (the reference platform's default for a new credit officer).

### Branch access

A user sees every branch, or their own branch and the ones given to them
(The reference platform's "Can access clients and accounts data for all branches"). Branch
access is row security in the database, on members, loan accounts, deposit
accounts and transactions: a request by a user limited to some branches runs
under the `sacco_branch_scoped` role, so every list, record, custom view,
report and export shows only those branches, and a record cannot be put into
a branch outside them (403 `OUTSIDE_YOUR_BRANCH_ACCESS`). The owner the app
normally runs as is not subject to it, and background jobs see everything.
Work on the whole organization (end of day and batch runs, provisioning, the
year-end close, dividends, imports, backups, extracts, accounting closures)
needs every branch (403 `ALL_BRANCH_ACCESS_REQUIRED`). A database where the
app may not create roles has no `sacco_branch_scoped` role; there a
branch-limited user is refused (503 `BRANCH_ACCESS_UNAVAILABLE`) rather than
shown every branch.

The general ledger has no row security: the daily balance rollups are
written by triggers as entries post, and hiding journal rows from them would
corrupt them. Branch access is applied to the accounting reports instead
(`src/lib/ledgerScope.js`), before their routes run. For a branch-limited
user:

- the balance sheet, the income statement, the trial balance and
  `POST /api/accounting/reports` run for one of their branches: their only
  one when they name none; with more than one they name it (403
  `BRANCH_REQUIRED`); another branch, or entries with none (`NONE`), is
  refused (403 `OUTSIDE_YOUR_BRANCH_ACCESS`);
- `GET /api/accounting/journal` shows the lines of their branches;
- an accounting report made through the API is read only for their
  branches;
- what is read for the whole organization only (GL balances, the rollup
  check, prudential ratios and limits, returns, provisioning, financial
  years) is refused (403 `ALL_BRANCH_ACCESS_REQUIRED`).

A user with every branch sees no change.

### Transaction limits

The reference platform's six: loan approval, loan disbursement, fee application, deposits,
withdrawals and repayments (`approvalLimit`, `disbursementLimit`,
`feeLimit`, `depositLimit`, `withdrawalLimit`, `repaymentLimit` on the
user, or `PATCH /api/loans/controls/users/{id}`). An amount above a limit is
refused (403 `ABOVE_YOUR_DEPOSIT_LIMIT` and so on). The reference platform offers limits for
users who are not administrators; here a limit set on an administrator holds
too. API consumers have none.

### Roles and permissions

```
GET  /api/roles/permissions           the catalogue, by group
GET  /api/roles                       POST /api/roles
GET|PATCH|PUT|DELETE /api/roles/{code}
PATCH /api/users/{id}  { role: "LOAN_OFFICER", permissions: ["VIEW_ACCOUNTING_REPORTS"] }
GET  /api/auth/me                     the signed-in user's permissions
```

A role is a set of permissions named with the reference platform's codes. The five built-in
roles come with default sets and can be edited but not deleted; the
administrator role always holds every permission. A tenant adds its own
roles, each with a code, a name, a user type, a base role (its starting
permissions, and what role lists naming built-in roles match) and the reference platform's
access rights: back office (signing in with a password) and API (the role
may be given to an API consumer). A user whose role has no back-office
access cannot sign in (403 `ROLE_HAS_NO_BACK_OFFICE_ACCESS`).

Every tenant API route needs a permission, set in one table
(`src/lib/routePermissions.js`): a code, one of several, all of several,
administrators only (the settings the reference platform keeps to the administrator type:
general setup, branding, the end of day schedule, lending controls,
approving imports, data dictionary comments, loan migration, resetting
passwords), or any signed-in staff user (views, menu items, your own
profile). A route the table does not list is refused to everyone but an
administrator. The catalogue holds only permissions that are checked,
186 of them: the reference platform's codes for what the platform has, and eleven of the platform's
own for what the reference platform does not have (shares and dividends, provisioning, the
year-end close, regulatory returns, data extracts, data imports read-only,
ID templates, approving write-off requests). A few permissions are checked
where the request does something: `ADD_CASH` and `REMOVE_CASH` when a
transaction goes through a till, `POST_TRANSACTIONS_ON_LOCKED_LOAN_ACCOUNTS`,
`PERFORM_REPAYMENTS_WITH_CUSTOM_AMOUNTS_ALLOCATION` and
`SET_DISBURSEMENT_CONDITIONS`. The lending controls' role lists (who may post
on a locked loan, pay off, adjust, collect securities, set disbursement
conditions) still narrow those permissions further, and name tenant roles as
well as built-in ones; so do custom field rights and transaction channel
usage rights, which the reference platform also manages by role.

The built-in roles' defaults were set so that each route lets in who the old
built-in role checks let in, with these changes: an auditor now reads user
details, staff transaction limits and the user audit log; a manager now runs
the end of day positions snapshot; and the till permissions take the reference platform's
meaning (below). Roles a tenant saved before this build were given, by
migration 032, the permissions their base role now needs, so their users
keep what they could do.

A user's access is their role's permissions plus any extra permissions set on
the user. The extras are a deviation from the reference platform, where a user has either a
role or permissions of their own, not both. Nobody changes their own role or
permissions.

Only an administrator creates or edits an administrator role. Someone who is
not an administrator, with `CREATE_ROLE` or `EDIT_ROLE`, cannot change the
role they hold, cannot give a role a permission they do not hold, and cannot
put a role on the administrator base; otherwise role editing would be a way
to any permission.

The built-in `TELLER` role keeps `POST_TRANSACTIONS_WITHOUT_OPENED_TILL` by
default so that tellers are not blocked on the day tills arrive. Remove it
from the role to make every teller post cash through an open till.

### Access preferences

```
GET|PUT|PATCH /api/access-preferences     (MANAGE_ACCESS_PREFERENCES)
GET  /api/access-preferences/blocked-ips  POST /api/access-preferences/blocked-ips/reset { ips }
```

The reference platform's Administration > Access > Preferences, per tenant:

| Setting | Default | Allowed |
|---|---|---|
| `sessionTimeoutMinutes`: signed out after this long without a request | 30 | 5 to 1440 |
| `password.minLength` | 12 | 8 to 128 |
| `password.minDigits`, `minUppercase`, `minSpecial` | 1, 0, 0 | digits at least 1 |
| `password.history`: previous passwords refused | 4 | 1 to 10 |
| `password.expiryDays` | none | 1 to 3650 |
| `lockout.maxFailedLogins` | 5 | 3 to 6 |
| `lockout.lockMinutes`: none means until an administrator unlocks | 60 | 15 to 10080, or none |
| `ipAllowlist`: `enabled`, `entries`, `applyTo` (ADMINS, USERS, API) | off | IPv4, `10.0.0.*`, `10.0.0.1-25`, CIDR |
| `reauthenticate`: the password again for critical actions | off | |
| `mfaRequiredRoles`: roles that must use a second factor | none | built-in or tenant roles |
| `apiKeys.rotationGraceSeconds`, `rotatedKeyExpirySeconds` | 1800, none | |
| `auditRetentionDays` | 365 | 30 to 3650 |

- A password always has a letter and a digit and never contains the
  username (the reference platform's fixed rules). The policy applies when a password is
  chosen; a temporary password is replaced at the first sign-in.
- An expired password signs in only to be changed (403 `PASSWORD_EXPIRED`).
- A wrong password counts against the user; at the limit the user is locked
  for the cooldown or until unlocked. Only someone who gives the right
  password is told the account is locked; everyone else gets
  `INVALID_CREDENTIALS`. A locked user's open sessions stop too, and an
  administrator's password reset also unlocks. This sits beside the
  platform's sign-in rate limit.
- Inactivity: an access token lives 15 minutes or the timeout, whichever is
  shorter, and a session whose last request is older than the timeout is
  not renewed (401 `SESSION_TIMED_OUT`; the console signs out and says so).
- The IP allowlist applies to administrators, back-office users and API
  keys as chosen, at sign-in and on every request. An allowlist that would
  shut out the person saving it is refused. IPv6 is not supported, as in
  The reference platform.
- Critical actions (the reference platform's list, where the platform has them: users, roles,
  access preferences, API consumers and keys, loan and deposit products,
  accounting and organization settings, branch changes, database backups,
  product document templates, lending controls): with `reauthenticate` on, a
  signed-in user sends `X-Reauth-Token`, which `POST /api/auth/reauth
  { password }` gives for five minutes. The console asks for the password
  when it is needed. API keys are not asked.

### API consumers and keys

```
GET|POST /api/consumers        GET|PATCH|DELETE /api/consumers/{id}
POST /api/consumers/{id}/keys { expirationTime }    DELETE /api/consumers/{id}/keys/{keyId}
POST /api/consumers/{id}/secret-key
POST /api/consumers/keys/rotation { apiKey, expirationTime }   (secretKey header)
```

After the reference platform's API Consumers. A consumer has a role (one with API access),
permissions of its own, or the administrator type; only an administrator
gives administrator access, and nobody gives more than they hold. It makes
keys, sent in the `apiKey` header with the tenant (`X-Tenant` or the
subdomain). A key is shown once; afterwards only its id and a six-character
prefix. A key may have a time to live. A secret key (one per consumer, shown
once) authenticates rotating a key: the replacement comes back with a new
secret key, the old key keeps working for the grace period, and a
`rotatedKeyExpirySeconds` in the preferences overrides the replacement's
expiry. An address that sends ten requests with a bad key is blocked for API
keys until an administrator resets it, whether or not it is on the
allowlist. A consumer whose keys have been used cannot be deleted (set it
INACTIVE); its activity stays in the audit trail. Transactions an API
consumer posts carry `api:` and its name.

### Audit trail

```
GET /api/audit-trail/events?username[eq]=teller@x&resource[eq]=members&occurred_at[gte]=2026-09-01T00:00:00Z
                            &from=0&size=100&sort_by=occurred_at&sort_order=desc     (MANAGE_AUDIT_TRAIL)
```

After the reference platform's Audit Trail: every request to the tenant's API by its staff
(`event_source` UI) and its API consumers (API), including refused ones and
sign-in attempts, with the method, path, resource, user, address, user agent
and response code. The request body is kept with passwords, secrets, keys
and personal details (names, phones, emails, addresses, dates of birth,
notes and the like) replaced by `***`; files are not kept. The filters are
The reference platform's: `FIELD[operator]=value` with `eq`, `ne`, `gt`, `gte`, `lt`, `lte`,
`startsWith`, `in` and `contains`; `from` plus `size` at most 10,000.
Events older than `auditRetentionDays` are removed at the end of day. The
member portal is not in it.

- `GET /api/v1/events` is the reference platform's path for the same query.
- A failed request (status 400 and above) also keeps its response body, with
  the same details removed, and `response_payload` can be filtered. A
  successful response is not kept.
- Group, loan and asset names are removed from bodies, as the reference platform does.
- `requireUserAgent` in the access preferences (off by default) refuses a
  request without a User-Agent header, as the reference platform does with its audit trail on.
- Neither `audit_events` nor `audit_log` can be changed, deleted from or
  emptied (migration 042). The two exceptions each set a session flag only
  they use: the retention prune, and member anonymization clearing a
  member's details from the change log.

### Activities

```
GET /api/activities?from=&to=&branchID=&clientID=&groupID=&centreID=&userID=&loanAccountID=
                   &savingsAccountID=&loanProductID=&savingsProductID=&creditArrangementID=&type=
                   &offset=&limit=                                          (AUDIT_TRANSACTIONS)
GET /api/{members|clients|groups|loans|savings|deposits|creditarrangements}/{id}/activities
GET /api/activities/feed      the dashboard's Latest Activity      GET /api/activities/types
```

After the reference platform's Tracking Activities and its API v1 activities. An activity
comes from one of three places:

- the change log (`audit_log`);
- a loan's state history, as `LOAN_<action>` (for example `LOAN_DISBURSE`);
- a member's state changes, as `MEMBER_<action>`.

A state change that is also in the change log shows once. Deposits,
withdrawals and repayments are in their transaction lists, not here.

- **The activity object** is the reference platform's Activity:
  - `type`, `timestamp`, `userKey` and `notes`;
  - the keys of its client or group, branch, centre, loan or deposit account,
    products and credit arrangement;
  - `fieldChanges`, worked out from the before and after values.
- **Links:** migration 042 links each change log row to its member, loan,
  deposit account, credit arrangement and branch when the row is written,
  and backfilled the rows already there. The request's IP address and
  channel go on each row.
- **One record's activities** need the permission that views the record.
  A member's include those of their accounts.
- **Branch access:** a user limited to some branches reads the activities of
  those branches, in the API and in the ACTIVITIES custom view.
- **The dashboard feed:**
  - every staff user sees the activities in their branches;
  - activities with no branch (products, settings, the chart of accounts)
    show only to holders of AUDIT_TRANSACTIONS or VIEW_REPORTS;
  - each user picks the types their feed shows (`activityTypes` on
    `PATCH /api/profile`).
- **Console:** member, group, loan, deposit account and credit arrangement
  pages have an Activity card with Show more.

## Tills

```
GET  /api/tills[?includeClosed=true]  GET /api/tills/mine   GET /api/tills/next-id
POST /api/tills { tellerEmail, tillId, openingAmount, channelId, glAccount,
                  balanceConstraint: NONE|SOFT|HARD, minBalance, maxBalance }
GET  /api/tills/{id}                  the till and its log
POST /api/tills/{id}/add-cash         POST /api/tills/{id}/remove-cash   { amount, note }
POST /api/tills/{id}/close { countedCash }   POST /api/tills/{id}/undo-close
POST /api/tills/{id}/reopen           DELETE /api/tills/{id}   (undo open)
```

After the reference platform's tills. A supervisor with `OPEN_TILL` opens a till for a
teller (a user of the teller user type), with an
ID of three letters and three digits, the opening cash and optional balance
limits. A teller has one open till at a time. Each till has a GL cash
account: by default the cash channel's, or an account of its own.

While a till is open, every cash-channel transaction the teller posts
(deposit, withdrawal, repayment, disbursement paid in cash) is linked to it
in the database, and the till's expected cash moves with it. A reversal of
a linked transaction moves the till back, and is refused once the till is
closed. A hard limit refuses a transaction that would take the till outside
its limits; a soft limit lets it through and flags the till. A till never
goes below zero. When the till has an account of its own, the ledger entry
posts to that account in place of the channel's.

The permissions take the reference platform's meaning. `ADD_CASH` lets a teller post
deposits and repayments through their till and `REMOVE_CASH` withdrawals and
disbursements (403 `PERMISSION_REQUIRED: ADD_CASH` without it). `OPEN_TILL`
and `CLOSE_TILL` are a supervisor's: opening a till, moving cash in and out
of it, and closing it. A teller whose role lacks
`POST_TRANSACTIONS_WITHOUT_OPENED_TILL` cannot post cash without an open till
(409 `NO_OPEN_TILL`). Adding or removing cash posts
an entry between the till's account and the account it came from or went to,
when the two differ. Closing takes the cash counted (the expected cash when
none is given); the difference is posted to Cash Over and Short (500-330,
settable in the accounting settings) against the till's account. Undoing a
close reverses that entry and opens the same till again; reopening starts a
new session of the till with the counted cash as its opening cash. Opening a
till by mistake can be undone while nothing has gone through it.

## Tasks

```
GET  /api/tasks[?assignedTo=&status=OPEN|COMPLETED&due=OVERDUE|TODAY|UPCOMING&memberId=]
GET  /api/tasks/mine                  counts for Your Tasks
POST /api/tasks { title, description, dueDate, assignedTo, memberId, template }
GET|PATCH|PUT|DELETE /api/tasks/{id}  POST /api/tasks/{id}/complete   POST /api/tasks/{id}/reopen
GET|POST /api/tasks/templates         PATCH|DELETE /api/tasks/templates/{id}
GET  /api/tasks?viewfilter={view id}  (a custom view of tasks)
```

After the reference platform's Tasks. A task has a title, a description, a due date, an
assignee and optionally a member; the reference platform's field names (`assignedUserKey`,
`taskLinkType: CLIENT` or `GROUP`, `taskLinkKey`) are accepted too. A task template fills a
task's title and description, with placeholders such as `{MEMBER_NAME}` and
`{CREDIT_OFFICER}` taking the linked member's details. A user sees the tasks
assigned to them or made by them, and, with `EDIT_TASK`, their branch's
tasks; administrators see all. Tasks are also a custom view entity.

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
it off and use a CronJob calling the CLI instead. The end-of-day sweep runs
every hour: each tenant whose end of day is AUTOMATIC runs it when the local
hour in its own time zone is `EOD_HOUR` (22 by default), on its local date,
and each tenant set to retry loans left out has them tried again.

## The daily sequence

`eod.DEFAULT_JOBS`, run by the scheduler or by `cli eod:run`, in this order
(abridged; `src/ops/eod.js` has the full list):

1. `ensureFinancialYear`: opens the calendar year covering the business date
   if no financial year does. On 1 January the new year opens itself; a SACCO
   on a July to June year opens its years by hand and this leaves them alone.
2. `syncCalendar`: re-dates open loans after a holiday or non-working day
   change; then `billRevolving`, which generates the installment on every
   revolving loan whose billing date has come, and `updateTaxRates` (after
   `reviewRates`): products with a VAT or withholding tax rate source take
   its value for the day
3. `accrueInterest`
4. `accrueSavings`: deposit interest (positive, negative and overdraft)
   accrued through the date, applied on each product's application dates
   with withholding tax, and monthly deposit fees on the month's last day
5. `markArrears`
6. `accruePenalties`, which reads the arrears state the previous job produced
7. `applyFees`: a dynamic loan's payment-due fees on their dates, late fees on
   installments that went overdue
8. `enforceControls`: lock loans at the product's charge cap (counting
   accrued, unapplied charges where `capIncludesAccrued` is set) or after
   its days in arrears, and close running loans that have owed nothing for
   the product's `autoClosePaidOffDays`
9. `provision`, which reads the same arrears and posts only the movement
   since the last run. While the bands have no rates it records a skip, not a
   failure, so a tenant that has not configured provisioning does not fill
   the job log with red.
10. `postAccruals`: posts the accruals waiting for the day's end (aggregated
    products) or the month's end (monthly GL accrual)
11. `autoClosure`: closes the whole book through yesterday every N days, when
    the tenant has switched automatic closures on
12. `snapshotPortfolio`: writes the day's loan positions, which reports for
    past dates read; then `pruneReports`, which removes accounting reports
    past their 24 hours

Each job is idempotent per business date through `platform.job_runs`, so a
rerun is a no-op rather than a double posting. A loan that breaks a loan job
is left out of the end of day until it is included again (see "Working with
loan accounts").

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

After the reference platform's "Loan Penalties Setup". A per-product rate (a loan may carry
its own, inside the product's band), a tolerance period, and the reference platform's four
bases: `OVERDUE_PRINCIPAL`, `OVERDUE_PRINCIPAL_INTEREST`, `OVERDUE_ALL` (the
amount actually in arrears) and `OUTSTANDING_PRINCIPAL` (the whole remaining
principal, a penalty rate on top of the rate). The first three rates are
daily. On OUTSTANDING_PRINCIPAL the rate is per the product's interest rate
period (a year, a month, a week or a day), as the reference platform requires. A loan under
a charge cap is charged no further than the cap allows.

- **Accrued from the first late day.** Nothing is applied while the
  installment is inside the tolerance. The tolerance is the penalty
  tolerance or the arrears tolerance, whichever is longer (the reference platform's worked
  examples). The accrued amount shows on the loan as `penalty_unapplied`
  and is not posted.
- **Applied after the tolerance.** The first charge covers every late day
  since the due date, and each later charge the days since the one before
  (`period_from`, `days_charged`). A day the end of day missed is covered
  by the next run.
- **Non-working days.** Where the product excludes them
  (`arrearsNonWorkingDays` EXCLUDE), weekends and holidays count neither
  towards the tolerance nor towards the penalty.
- **Locked loans.** A locked loan, whatever the lock was for, accrues
  penalties (shown as `penalty_unapplied`) and is not charged them. At the
  unlock, on the overdue bases, the locked days are forfeited (a zero
  charge marks them covered). On OUTSTANDING_PRINCIPAL, what accrued while
  locked is applied on the first installment due date after the unlock
  (`penalty_deferred`, `penalty_deferred_until`). A lock that leaves
  penalties running charges them as usual.
- **Changing the rate.** `POST /api/loans/:id/penalty-rate` (the reference platform's Edit
  Penalty Rate) changes a running loan's rate within the product band.
  Every change is kept (`GET /api/loans/:id/penalty-rate-changes`).
  Charges already applied stand; what accrues from then on uses the new
  rate.
- **Backdated repayments and reversals.** A repayment dated before
  penalties already charged takes back the unpaid charges after its date,
  works them out again to its date on what was owed then, and after the
  payment charges the days since on what is still owed. Reversing a
  repayment takes back the unpaid charges after its date, and the days are
  charged again on what is owed once more. A taken-back charge is marked
  reversed, not waived, and keeps its GL reversal. A charge already paid
  stays.

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

After the reference platform's Data and Reporting > Reporting pages.

```
GET  /api/reports/balance-sheet?asAt= | month=yyyy-MM [&branchId=][&format=csv|xlsx]
GET  /api/reports/income-statement?from=&to=[&branchId=][&includeClosing=][&format=]
GET  /api/accounting/trial-balance?from=&to=[&branchId=][&zeroBalances=true][&glTypes=ASSET,LIABILITY][&format=]
POST /api/accounting/reports              { startDate, endDate, balanceTypes, glTypes, branchId, currencyCode }
GET  /api/accounting/reports/{reportKey}
GET  /api/reports/prudential?asAt=
GET  /api/reports/portfolio-at-risk?asAt=[&branchId=&centreId=&productId=&creditOfficer=][&format=]
GET  /api/reports/portfolio-at-risk/loans?asAt=&bucket=&minDaysLate=&maxDaysLate=&offset=&limit=[&format=]
GET  /api/reports/risk?asAt=&minDaysLate=1&maxDaysLate=&band=&groupBy=BRANCH|CENTRE|PRODUCT|CREDIT_OFFICER[&format=]
GET  /api/reports/positions[?asAt=]           POST /api/reports/positions (today's, now)
GET  /api/reports/indicators?entityType=&entityId=&indicators=[&format=]
GET  /api/reports/indicators/catalog
GET|POST /api/reports/indicator-reports       GET|PUT|PATCH|DELETE /api/reports/indicator-reports/{id}
GET  /api/reports/portfolio?from=&to=&interval=DAILY|WEEKLY|MONTHLY[&branchId=][&format=]
GET  /api/reports/organization[?format=]
GET  /api/reports/earnings?from=&to=&groupBy=PRODUCT|BRANCH[&branchId=][&format=]
GET  /api/reports/cashflow?from=&to=[&branchId=][&format=]
GET  /api/reports/outreach?from=&to=[&format=]
GET  /api/reports/audit-log?action=&entity=&offset=&limit=
GET  /api/reports/limits
GET  /api/accounting/journal?from=&to=&glCode=&offset=&limit=
```

Every report downloads with `?format=csv` or `?format=xlsx`: the organization,
the report, its period and branch and when it was generated head the file,
then the rows. In Excel an amount is a number while it fits Excel's 15
significant digits and text beyond, so nothing is rounded (as the reference platform does).
Reports are for administrators, managers, accountants and auditors.

### The organization's day

A tenant transaction runs with the session time zone set to the tenant's
(`db/tenantContext`), so `current_date`, a DATE column's default and every
"today" in the code (`lib/orgDate.orgToday`) are the organization's calendar
day. Before this, the code took the UTC day: in Nairobi between midnight and
03:00 a report with no date was as at yesterday, a disbursement defaulted to
yesterday, and a loan disbursed "today" and accrued "today" disagreed by a
day. The platform-wide end of day (`eod:run` for every tenant) now runs each
tenant on its own local date too. `test/reports.test.js` sets a zone whose day
differs from UTC and checks all three.

### Accounting reports

The trial balance gives each account its opening balance (the day before
`from`), the period's debits and credits, the net change and the closing
balance, in the account's own sign: assets and expenses debit minus credit,
liabilities, equity and income credit minus debit. Accounts with no debit or
credit in the period are left out unless `zeroBalances=true`. The balance
sheet has the reference platform's two modes: `asAt` (the book from its start to the date) and
`month` (that month's postings, to today for the current month). All three
statements take a branch (id, code, or `NONE` for lines posted without one);
the branches add up to the whole.

`POST /api/accounting/reports` is the reference platform's accounting reports API: it answers
202 with a `reportKey` QUEUED, builds the report in the background, and `GET
/api/accounting/reports/{reportKey}` returns `{ reportKey, status, items:
[{ glAccount: { id, name, type }, amounts: { openingBalance, debits, credits,
netChange, closingBalance } }] }` with the balance types asked for. It takes
an `Idempotency-Key`, and a report can be read for 24 hours.

### Portfolio at risk, past days and the risk report

`domain/portfolio.js` holds the positions every portfolio report reads: each
running loan's principal, interest, fees and penalties outstanding, what of it
is overdue, and its days late (since the oldest unpaid installment fell due).
Running means ACTIVE, IN_ARREARS and LOCKED. A locked loan is usually the
latest in the book; it used to be left out of PAR and of the provisioning run.

Today's positions come from the loan tables. The loan tables only hold the
present, so a past day cannot be worked out of them: the old PAR report took
days late as at the date asked for but which loans ran, which installments
were unpaid and the principal outstanding from today, a figure the book never
showed. The end of day now writes the day's positions (`snapshotPortfolio`,
its last job, into `loan_daily_positions`), and a past date reads them. A past
date without positions is refused with the earliest date that has them; a
future date is refused. Positions can be taken for today or yesterday only.

PAR over X is the outstanding principal of loans more than X days late over
the gross loan portfolio (PAR is PAR over 0; a range 7-30 is more than 7 and
at most 30); VAR is the same with the overdue principal. The report gives
PAR, PAR over 7, 15, 30, 60, 90, 180 and 360, the ranges 7-30, 30-90, 90-180
and 180-360, VAR, VAR over 7, 15, 30 and 90, interest in suspense (unpaid
interest on late loans) and the old buckets, for the whole portfolio or one
branch, centre, product or credit officer. The risk report filters by days
late and provisioning band and groups by branch, centre, product or credit
officer, each band with its rate and the provision it calls for; a band whose
rate is not set shows the rate and the provision as not set.

### Indicators

Around fifty indicators in the reference platform's groups (outreach, deposits, loans, risk
and aging, organization), for the organization or one branch, centre, loan
product, deposit product or credit officer. They are the position now. An
indicator that does not apply to the scope (deposit figures for a loan
product) is null with the reason; the reference platform's indicators for groups and lines of
credit have no counterpart, as the platform has neither. Saved indicator
reports (name, description, entity, indicators) are the reference platform's Indicators tab.

### Management reports

- **Portfolio**: over a range of at most a year, by day, week or month: loans
  created, disbursed, written off and repaid in each interval, and at each
  interval end the loans by state, the portfolio, its risk and average balance
  (from that day's positions; null where there are none) and the capital
  structure from the ledger.
- **Organization**: by branch and by credit officer, members, borrowers,
  loans, portfolio and PAR over 30. A loan has its own credit officer now
  (`loan_accounts.credit_officer`), the member's unless the application
  names one, and it can be changed on the loan.
- **Earnings**: revenue and expenses by product or branch, each income and
  expense line attributed through the entry's source or its transaction. The
  total equals the income statement's surplus.
- **Cashflow**: income collected, expenses paid and the changes in the
  portfolio and in deposits, from the transactions, in the base currency.
  Reversed transactions and imported opening balances are left out.
- **Outreach**: clients, borrowers and savers, by gender and branch, with
  those who joined and left in the period.

### Custom views

```
GET  /api/views/entities                 GET /api/views/fields/{entity}
GET  /api/views[?entity=&favourites=true] POST /api/views
POST /api/views/run[?format=csv|xlsx]    (a temporary view)
GET|PUT|PATCH|DELETE /api/views/{id}
GET  /api/views/{id}/run?offset=&limit=  GET /api/views/{id}/export?format=csv|xlsx
POST /api/views/{id}/copy                PUT|DELETE /api/views/{id}/favourite
GET  /api/members?viewfilter={id}[&resultType=BASIC|FULL_DETAILS|SUMMARY]
     (also /loans, /loans/transactions, /savings, /savings/transactions,
      /accounting/journal, /activities, /clients, /groups, /creditarrangements)
GET  /api/users/{id|email|me}/views?for=LOANS
```

A view is a filter (match all or any), columns, a sort, totals and a display
mode over members, groups, loans, loan transactions, deposit accounts,
deposit transactions, credit arrangements, journal entries, system
activities or tasks. Every field is declared
with the SQL that produces it, so a view names fields and never carries SQL;
values are parameters. Custom fields on standard sets are fields too, under
their view rights. Operators follow the reference platform's search operators by field type.
Totals are over every matching row, not the page. An export holds at most
100,000 rows.

Any user makes views for themselves. Usage rights (all users, or chosen
roles) are an administrator's to give, as in the reference platform; the owner and an
administrator change or delete a view, anyone who can see it copies it.
Journal entries are for the ledger roles and activities for administrators,
managers and auditors. `?viewfilter=` on a list endpoint returns what the
view matches: its columns (BASIC), the whole records (FULL_DETAILS) or the
count and totals (SUMMARY).

### Grouped custom fields in views

A grouped custom field set (several entries of the same fields on one
record, such as references or next of kin) can be used in a view. Each field
of the set is a column showing every entry, joined with a semicolon in entry
order. A filter on a grouped field matches a record when any entry matches,
and for "is empty" and "different than" when no entry matches.

### Menu items

```
GET  /api/menu                        the signed-in user's navigation
GET  /api/menu-items                  POST /api/menu-items { name, type }
PATCH|DELETE /api/menu-items/{id}     PUT /api/menu-items/order { ids }
PATCH /api/views/{id} { menuItemId }
```

After the reference platform's Menu Items. The navigation has fixed items (Dashboard,
Reporting, Accounting, Products, Administration) and items with views. Six
items with views come predefined: Clients, Loans, Deposits, Loan
Transactions, Deposit Transactions and Activities. A user adds items of any
view kind (at most 32 characters to a name) and files views under them; a
view filed under nothing shows under the predefined item of its kind. As
with views, users see their own items and the ones shared with them, and
only an administrator shares items and puts them in order. A predefined item
can be renamed, moved and hidden from roles, not deleted. Deleting an item
leaves its views. The console shows the items as a second row of the
navigation and manages them on the Views page.

### Report templates

```
GET  /api/report-templates[?type=MEMBER|LOAN|DEPOSIT|BRANCH|CENTRE|OTHER]
POST /api/report-templates            { name, reportType, description, definition, usageRights }
GET|PATCH|DELETE /api/report-templates/{id}
GET  /api/report-templates/{id}/template        the JSON file
POST /api/report-templates/{id}/run?format=json|html|pdf|xlsx|csv  { parameters, recordId }
PUT  /api/report-templates/order
```

In place of the reference platform's Jasper reports, which the reference platform is retiring. A template is a
JSON file, uploaded and downloaded as a file as Jasper's are, with a title,
parameters and sections. A section is a table, a set of fields or text, and
takes its data from a custom view definition or from one of the built-in
reports (balance sheet, income statement, trial balance, portfolio at risk,
risk, indicators). There is no place for SQL in a template, so a template
can show only what its reader could already see: every section runs with the
reader's permissions, and a section needing a permission the reader lacks
refuses the whole report.

Placeholders fill the template: `{{record.x}}` from the record a template
runs on, `{{param.x}}`, `{{today}}`, `{{user.email}}` and
`{{organization.name}}`. A filter whose placeholder comes to nothing is
dropped, so optional parameters work. Parameters are dates (with defaults
such as today or the start of the month), text, numbers, yes or no, a fixed
selection, a branch, or a loan or deposit product.

A member, loan, deposit, branch or centre template runs from that record's
page, as the reference platform's entity reports do; an Other template runs from Reports. The
output is HTML (a page with no scripts), PDF, Excel (a sheet per section),
CSV or JSON. Excel and CSV need `EXPORT_TO_EXCEL`. Usage rights work as they
do for views.

### The dashboard

The console opens a Dashboard page with the reference platform's widgets that have a
counterpart here: indicators, upcoming repayments (the next seven days),
your clients (members whose credit officer you are), your favourite views,
the latest activity, Your Tasks (overdue, due today and upcoming, with
complete and new task), Tellering (the teller's own till and its expected
cash) and Tellers (the open tills, for users with `OPEN_TILL`). Each widget
shows only when the user holds its permission.

### Not built yet

Nothing from these pages. The client indicators count individual members
only; groups have their own: GROUPS, ACTIVE_GROUPS, GROUP_MEMBERS (members
in groups), GROUP_BORROWERS (groups with a running group or solidarity
loan), GROUP_LOAN_PORTFOLIO and SOLIDARITY_LOAN_PORTFOLIO. Lines of credit
have CREDIT_ARRANGEMENTS (approved and active) and
CREDIT_ARRANGEMENT_AMOUNT. All work for the organization, a branch, a
centre or a credit officer.

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
(1-30, 31-90, 91-180, 181-360, over 360) and reports PAR as a percentage,
with the reference platform's thresholds and VAR (see "Portfolio at risk, past days and the
risk report" above).

## Loan loss provisioning

Loans are classified by how many days their oldest unpaid installment is
overdue, using the same arrears measure as the PAR report so the two cannot
disagree. Each band carries a rate; the required allowance is outstanding
principal in each band times that rate. Locked loans are classified with the
rest: a loan locked for arrears still owes its principal (they were left out
before).

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

Served at `/console` from `public/`: sign-in with MFA (and the change of a
temporary password), member and loan lookup, teller postings, the reports,
provisioning, the close, returns, products, controls, accounting, the
organization, data (import, backups, dictionary, extract) and users.

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
6. **Not modelled from the reference platform's product form:** fee amortisation profiles
   (deferred fee income), billing
   cycles distinct from due dates on revolving loans, refunds on revolving
   loans, and the secondary marketplace for funded loans. Auto-close of
   paid-off loans is moot: a paid-off loan closes at once.
7. **Deposit interest on catch-up days uses today's balance.** When the end
   of day misses days, each missed day is priced on the balance as it stands
   when it runs, and that is what `savings_daily_balances` records. A
   transaction backdated before an accrual does not re-price the days
   already accrued. Tiered deposit rates, fixed deposits with maturity, and
   Shari'ah profit-sharing products are not modelled.
8. **Taxes on loans are booked with the interest receivable.** the reference platform keeps
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
