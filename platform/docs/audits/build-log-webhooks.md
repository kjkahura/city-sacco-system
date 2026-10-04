# Build log: Webhooks

Built on 5 October 2026 from `audit-webhooks.md`. John accepted its 11 decision defaults, with signing on by default and HTTPS only. The plan is `docs/superpowers/plans/2026-10-04-webhooks.md`. There is one commit on main, not pushed.

## Built

### The outbound guard (`src/lib/outbound.js`)

- **One guard for every outbound request:** the backup callback's checks are now shared, so a tenant cannot make the platform call its own network.
  - The guard accepts https only.
  - It refuses URLs with credentials, and localhost or private addresses.
  - It checks each address the name resolves to at connection time, which stops DNS rebinding.
  - It follows no redirects.
- **`send()`:** never throws. It returns the status and the first 2 KB of the answer, or the error.
- **The backup callback:** uses the guard, with the same behaviour and error names as before.

### Events with their change (tenant migration 045)

- **Tables:**
  - `notification_templates`;
  - `notification_events` (the outbox);
  - `notification_messages` (the communication log);
  - `notification_settings` (the switch and the daily work).
- **Triggers on:** `members`, `member_state_changes`, `loan_accounts`, `loan_state_history`, `savings_accounts`, `transactions`, `credit_arrangements`, `journal_entries`, `eod_completions` and `audit_log`.
- **When an event is recorded:** a trigger records it in the same transaction as the change, and only when an activated webhook wants it. A SACCO with no webhooks stores nothing.
- **Events built:**
  - **clients and groups:** created, approved, rejected, activity, portal activated;
  - **loans:**
    - account events: created, approval, rejection, closure, write-off, rescheduled, refinanced, activity, interest rate changed;
    - transactions: disbursement and repayment, and their reversals; fee applied and adjusted; penalty adjustment; credit balance deposit;
    - arrears and repayment reminders;
  - **deposits:**
    - account events: created, approval, activated, rejection, closure, activity, in arrears;
    - transactions: deposit and withdrawal, and their reversals; interest applied;
  - **credit arrangements:** every state, edits, deletion, accounts added and removed;
  - **other:** journal entries added and adjusted; end of day completed; holiday sync completed.
- **Not built:** cards, payment and collection orders, data access and the others the platform has no source for. A webhook for one of them is refused with `EVENT_NOT_SUPPORTED`.

### Webhooks (`src/domain/notifications/templates.js`, `/api/templates`)

- **Routes:**
  - create, list, read, JSON Patch and delete;
  - `:test` sends a sample now and returns the outcome;
  - `:rotateSecret` makes a new signing secret;
  - `/api/templates/catalog` lists the events and placeholders for the console.
- **Fields:**
  - name (unique, at most 255 characters, trimmed), target and event;
  - URL (https, with no quotation marks or placeholders);
  - POST, PUT or PATCH, and a JSON, XML or plain text body;
  - basic authentication or none, static headers and signing;
  - conditions (MATCH_ALL or MATCH_ANY);
  - trigger, trigger days and subscription option.
- **Body checks:**
  - a JSON or XML body must be well formed once filled with sample values;
  - an unknown placeholder is refused;
  - a body is at most 64 KB.
- **Secrets:**
  - the basic authentication password and the signing secret are stored AES-256-GCM encrypted (`secrets.js`, key `SECRETS_KEY`);
  - they are never returned, except the signing secret, once, when it is made.

### Delivery (`src/domain/notifications/dispatch.js`)

- **Turning events into messages:** for each activated webhook whose conditions are met, a message is queued with its body filled from the event's records.
  - **Placeholders:** client, account, transaction, loan, installment, organization and custom field placeholders.
  - **Escaping:** values are escaped for JSON or XML, so a member named `O"Brien` still gives valid JSON.
- **Sending:**
  - due messages are claimed with `SKIP LOCKED` and a two-minute lease, so dispatchers running at once never send a message twice;
  - they are sent outside any database transaction, and each outcome is recorded afterwards.
- **Each request carries:**
  - `x-notifications-idempotency-key`, the same on retries;
  - `x-sacco-signature: t=…,v1=…`;
  - basic authentication and the static headers.
- **Outcomes:**
  - only `2xx` is delivered;
  - other answers give `INVALID_HTTP_RESPONSE`; timeouts and network errors give `HTTP_ERROR_WHILE_SENDING`; private addresses give `BLACKLISTED_URL`;
  - retries are 1, 5, 15 and 60 minutes, then 3, 6, 12, 18 and 24 hours after the first try, then `FAILED`.
- **The circuit breaker:** after 20 failures in a row, the webhook's messages wait (`WAIT_FOR_CLOSE_CIRCUIT`). One is tried every 10 minutes, and a success sends the rest.
- **The switch:** when it is off, messages fail with `WEBHOOK_NOTIFICATIONS_DISABLED` and can be resent later.
- **Daily work:**
  - a repayment reminder for each unpaid installment due in the webhook's trigger days, once a day;
  - message bodies older than 180 days are cleared, and processed events older than 30 days are removed.
- **What runs it:**
  - a pass after each request that changed something;
  - `cli notifications:run`;
  - the in-process scheduler every minute;
  - the `sacco-notify` Cloud Run job, every minute (`.github/workflows/deploy.yml`, `docs/deploy.md`).

### The communication log and the switch

- **API v2 `/api/communications/messages`:**
  - `GET /:key` (the body with `detailsLevel=FULL` on searches);
  - `:search` and `:searchSorted`;
  - `:resend` (failed messages only, a new idempotency key each, retries starting over);
  - `:resendAsyncByKeys` and `:resendAsyncByDate`.
- **API v1:** `POST /api/notifications/messages` (`action: resend`) and `/api/notifications/messages/search`.
- **`GET` and `PUT /api/notificationsettings/webhook`:** the switch, for administrators only.
- **New permissions:**
  - VIEW_COMMUNICATION_HISTORY (managers and auditors);
  - RESEND_FAILED_MESSAGES (managers).

  The webhooks themselves use CREATE_ and EDIT_COMMUNICATION_TEMPLATES.
- **The data dictionary** describes the four new tables.

### Console (`public/js/webhooks.js`)

- **Administration > Webhooks:**
  - the list, with the switch;
  - a form with a placeholder picker that writes at the cursor;
  - the signing secret shown once;
  - "Send a test" with its outcome;
  - a new signing secret, and delete.
- **Administration > Webhooks > Communication Log:**
  - filters by state, event and dates;
  - a message's body and outcome;
  - resend of selected failed messages.

## Tests

- **New suite:** `test/webhooks.test.js` has 68 checks. It covers:
  - the guard;
  - event capture, including a rolled-back change and a deactivated webhook;
  - every template validation, secrets and permissions;
  - delivery: headers, signature, escaping, conditions, retries, redirects, timeouts, the final failure, the circuit breaker, three dispatchers at once, the run after a request, `:test`, reminders and retention;
  - the log, resend, the v1 routes and the switch.
- **Console:** `test/console.test.js` has 179 checks, with the webhook form, the secret, a test, the switch and the log.
- **Full runs, 47 suites, in UTC and in Africa/Nairobi:** 44 pass in each. Lending, loan-accounting and loan-accounts fail the same date-dependent checks they fail on the commit before this build.

## Left as it was, or to confirm

- **Field names:** the reference platform's schema with the webhook's own fields (URL, method, headers, authorization) did not load during the audit. The names used are `url`, `requestType`, `contentType`, `authorization`, `headers`, and `signingEnabled`, which this platform adds.
- **Templates without a list endpoint:** the reference platform's templates API has no list; this platform adds `GET /api/templates` for the console.
- **Subscription option:** it is stored and has no effect until Email and SMS use it.
- **Deploying:**
  - the deploy now reads the secret `sacco-secrets-key`, so create it before the next deploy (`docs/deploy.md`, step 2);
  - add the `sacco-notify` schedule (step 6).
