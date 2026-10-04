# Audit: Webhooks against the reference platform

Audited on 4 October 2026, at commit dadf6f3 (the console navigation fixes). Nothing is built yet. The proposed build and its decisions are at the end.

## Reference pages read

- **Webhooks overview.**
  - Webhooks push an HTTP request when an event happens.
  - Every notification is stored with its destination, state, timestamps and payload.
  - A manual resend sends the stored payload again.
  - Failures are retried with exponential backoff, and only a `2xx` answer counts as delivered.
- **Defining a new webhook:**
  - name: unique, at most 255 characters, trimmed;
  - target and event trigger;
  - URL: HTTP or HTTPS, with no quotation marks;
  - request type: POST, PUT or PATCH;
  - content type: plain text, `application/json` or `application/xml`;
  - authorization: none, or basic with a username and password;
  - custom request headers: static, with no placeholders;
  - conditions on fields: Match All or Match Any;
  - the request body, with placeholders;
  - a subscription option: opt in or opt out.

  A template shows a state (In Use once it has sent, otherwise Not In Use) and a status (Active or Inactive). JSON and XML bodies must be valid before they are saved. Creating a webhook needs CREATE_COMMUNICATION_TEMPLATES; editing or changing its status needs EDIT_COMMUNICATION_TEMPLATES.
- **Webhooks best practices:**
  - **What counts as delivered:** only a `2xx` answer. A `3xx` answer is a failure, as are `4xx`, `5xx`, a timeout and a network or TLS error.
  - **Retries:** made with backoff. The schedule is not published.
  - **The idempotency key:** every request carries `x-notifications-idempotency-key`. An automatic retry keeps the key; a manual resend makes a new one. Delivery is at least once, so the receiver must remove duplicates.
  - **Secrets:** they belong in headers, never in the URL.
  - **Failing endpoints:** a circuit breaker pauses or slows delivery to an endpoint that keeps failing, and resumes on its own.
  - **Deactivated templates:** deactivating one stops new notifications, but messages already queued may still go.
- **Notification placeholders:**
  - the forms are `{{NAME}}`, `{{CUSTOM_FIELD_ID}}` for a custom field, and an indexed form for grouped custom fields;
  - the groups are client, account and product, transaction and balance, loan and repayment, payment, and system;
  - which placeholders are available depends on the event;
  - an empty value becomes an empty string.
- **Event triggers:** about 80 event names, such as `CLIENT_CREATED`, `LOAN_REPAYMENT`, `SAVINGS_DEPOSIT`, `ACCOUNT_IN_ARREARS`, `REPAYMENT_REMINDER`, `END_OF_DAY_PROCESSING_COMPLETED`, `CREDIT_ARRANGEMENT_*` and `JOURNAL_ENTRY_ADDED`. Some need a capability the platform does not have: cards, payment orders, collection orders and data access.
- **API v2 `templates`:**
  - `POST /templates`, and `GET`, `PATCH` (JSON Patch) and `DELETE /templates/{templateId}`;
  - fields: `id`, `name`, `type` (`WEB_HOOK` only), `event`, `target`, `body`, `activated`, `trigger` (`AUTOMATIC` or `MANUAL`), `triggerDays`, `subscriptionOption`, `filtersLinkingOperator` and `filterConstraints`;
  - targets: `CLIENT`, `GROUP`, `LOANS`, `SAVINGS`, `BACKGROUND_PROCESS`, `DATA_ACCESS`, `PAYMENT_ORDER`, `ACCOUNTING` and `ADMINISTRATIVE`;
  - there is no list endpoint.

  The schema with the webhook's own fields (URL, method, headers, authorization) did not load. Its names are to be confirmed at build time.
- **API v2 `notificationsettings/webhook`:** `GET` and `PUT` a tenant-wide switch, `ENABLED` or `DISABLED`, for administrators only.
- **API v2 `communications/messages`:**
  - routes: `GET /{encodedKey}`, `:search`, `:searchSorted`, `:resend`, `:resendAsyncByKeys` and `:resendAsyncByDate`;
  - a message has: `type` (`EMAIL`, `SMS`, `WEB_HOOK`, `EVENT_STREAM`, `TASK`), `state` (`SENT`, `QUEUED`, `QUEUED_FOR_STREAM`, `WAITING`, `SENDING_ASYNC`, `FAILED`), `failureReason` (for example `INVALID_HTTP_RESPONSE`, `HTTP_ERROR_WHILE_SENDING`, `INVALID_JSON_BODY_SYNTAX`, `BLACKLISTED_URL`, `WEBHOOK_NOTIFICATIONS_DISABLED`, `MAX_MESSAGE_SIZE_LIMIT_EXCEEDED`), `numRetries`, `destination`, `body`, `event`, `templateKey` and the keys of the client, group, user and accounts involved;
  - permissions: VIEW_COMMUNICATION_HISTORY to read; RESEND_FAILED_MESSAGES to resend;
  - a waiting message gives its reason: `READY_TO_BE_SENT`, `WAIT_FOR_CLOSE_CIRCUIT` or `SENDING`.
- **API v1 `notifications/messages`:** `POST /notifications/messages` with `{ action: "resend", identifiers }`, and `POST /notifications/messages/search` with `filterConstraints`.

## What the platform has

- **No webhooks:** there is no webhook, notification, outbox or message log code or table.
- **The only outbound HTTP call** is the callback when a tenant's own database backup finishes (`src/ops/tenantBackup.js`). It already guards against requests to internal addresses:
  - it accepts https only;
  - it rejects URLs with credentials, and localhost or private IP addresses;
  - it checks each address the name resolves to while connecting, which also stops DNS rebinding;
  - it follows no redirects and gives up after 10 seconds.

  These helpers (`isPrivateAddress`, `checkCallbackUrl`, `guardedLookup`) are not exported.
- **Event sources that exist today:**
  - `transactions`: every posting, with its kind, account and member;
  - `loan_state_history`: every loan state change;
  - `member_state_changes`: client and group states;
  - `audit_log`: about 130 action names, such as `SAVINGS_ACCOUNT_CLOSED`, `MEMBER_PORTAL_ACTIVATED`, `HOLIDAY_SYNC_COMPLETED` and `MANUAL_JOURNAL_ENTRY_LOGGED`, written in the same transaction as the change;
  - `eod_completions`.
- **Permissions:** `CREATE_COMMUNICATION_TEMPLATES` and `EDIT_COMMUNICATION_TEMPLATES` exist. Today they guard the task templates. VIEW_COMMUNICATION_HISTORY and RESEND_FAILED_MESSAGES do not exist.
- **Background work:**
  - **On a single server:** the in-process scheduler (`SCHEDULER=on`) runs end of day, backups and token pruning.
  - **On Cloud Run:** the deploy sets `SCHEDULER=off`. Scheduled work runs as Cloud Run jobs started by Cloud Scheduler, and the service scales to zero when idle.
- **The console:** Administration > Webhooks is a placeholder tab, from the navigation build.

## Findings

### 1. Templates

The platform has nothing to hold a webhook. It needs a template with the reference platform's fields:

- **Common to every template:** name, target, event, body, activated, trigger, trigger days, subscription option, conditions and the condition operator.
- **For a webhook:** URL, request type, content type, authorization, and headers.

### 2. Events

The platform can raise most of the reference platform's events from what it already records. Each comes from the source shown.

| Target | Events | Source |
|---|---|---|
| CLIENT, GROUP | CLIENT_CREATED, CLIENT_APPROVED, CLIENT_REJECTED, CLIENT_ACTIVITY, GROUP_CREATED, GROUP_ACTIVITY | members insert, `member_state_changes`, `audit_log` |
| LOANS | LOAN_CREATED, LOAN_APPROVAL, LOAN_ACCOUNT_REJECTION, LOAN_ACCOUNT_CLOSURE, LOAN_ACCOUNT_WRITE_OFF, LOAN_ACCOUNT_RESCHEDULED, LOAN_ACCOUNT_REFINANCED, LOAN_ACCOUNT_ACTIVITY, INTEREST_RATE_CHANGED | `loan_state_history`, `audit_log` |
| LOANS | LOAN_DISBURSEMENT, LOAN_DISBURSEMENT_REVERSAL, LOAN_REPAYMENT, LOAN_REPAYMENT_REVERSAL, FEE_APPLIED, FEE_ADJUSTED, PENALTY_APPLIED, PENALTY_ADJUSTMENT, CREDIT_BALANCE_DEPOSIT | `transactions` |
| LOANS | ACCOUNT_IN_ARREARS, REPAYMENT_REMINDER (with trigger days) | end of day |
| SAVINGS | SAVINGS_CREATED, SAVINGS_APPROVAL, SAVINGS_ACCOUNT_ACTIVATED, SAVINGS_ACCOUNT_REJECTION, SAVINGS_ACCOUNT_CLOSURE, SAVINGS_ACCOUNT_ACTIVITY | savings state changes, `audit_log` |
| SAVINGS | SAVINGS_DEPOSIT, SAVINGS_DEPOSIT_REVERSAL, SAVINGS_WITHDRAWAL, SAVINGS_WITHDRAWAL_REVERSAL, DEPOSIT_INTEREST_APPLIED, ACCOUNT_AUTHORISATION_HOLD_CREATED / REVERSED / SETTLED | `transactions`, holds |
| (credit arrangements) | CREDIT_ARRANGEMENT_CREATED, _APPROVED, _REJECTED, _WITHDRAWN, _CLOSED, _DELETED, _EDITED, _ACCOUNT_ADDED, _ACCOUNT_REMOVED | credit arrangement changes |
| ACCOUNTING | JOURNAL_ENTRY_ADDED, JOURNAL_ENTRY_ADJUSTED | journal entries |
| ADMINISTRATIVE, BACKGROUND_PROCESS | END_OF_DAY_PROCESSING_COMPLETED, HOLIDAY_SYNC_COMPLETED | `eod_completions`, `audit_log` |
| CLIENT | PORTAL_ACTIVATED, PORTAL_PASSWORD_RESET | the member portal |

Some events have no source, because the platform has no cards, payment orders, collection orders or data access requests:

- CARDS_* and CARD_*_REVERSAL;
- PAYMENT_ORDER_ACTIVITY and COLLECTION_ORDER_ACTIVITY;
- DATA_ACCESS_STATE_CHANGED;
- REFUND_FORWARD_ONLY.

### 3. Capturing an event with the change

- **The requirement:** an event must be recorded only when its change is saved, and must not be lost when the server stops between the change and the send. An outbox in the same database transaction meets both.
- **What makes this cheap:** `transactions`, `loan_state_history`, `member_state_changes` and `audit_log` are all written in that transaction. Database triggers on them can write the outbox without changing any domain code.

### 4. Placeholders and the body

- **Rendering:** the body is a template with `{{NAME}}` placeholders, filled from the event's records.
- **Validation:** a JSON or XML body is checked when it is saved, and the rendered body is checked when it is sent. A rendered body that fails is recorded as `INVALID_JSON_BODY_SYNTAX`.
- **Escaping:** values inside a JSON body must be escaped, or a member's name with a quotation mark would break the request.
- **Placeholders the data supports:**
  - members: name, ID, phone, email, branch, state;
  - accounts: ID, name, state, product, balances;
  - transactions: ID, type, amount, value date, channel, reversal of;
  - loans: amount, rate, next installment, arrears;
  - the organization: name, currency, dates;
  - custom fields, by their IDs.

### 5. Delivery, retries and the log

- **The reference platform's rules:**
  - only a `2xx` answer is delivered;
  - retries back off exponentially;
  - an idempotency header carries the same key on a retry and a new one on a manual resend;
  - a failing endpoint is paused by a circuit breaker;
  - a tenant-wide switch can turn webhooks off;
  - failures carry a reason, such as `INVALID_HTTP_RESPONSE`, `HTTP_ERROR_WHILE_SENDING` or `WEBHOOK_NOTIFICATIONS_DISABLED`.
- **The log:** every message is kept with its state, retry count, destination, body and timestamps. It can be searched, and failed messages can be resent one at a time, in bulk, or by date.

### 6. Running the sender on Cloud Run

- **The problem:** on Cloud Run the service scales to zero, and the in-process scheduler is off. Nothing would run a retry while no requests are coming in.
- **The fix:**
  - try a message as soon as the change that raised it is saved;
  - retry from a `sacco-notify` job that Cloud Scheduler starts every minute;
  - leave the in-process scheduler to do the same on a single server.

### 7. Outbound safety

- **The risk:** a webhook URL is set by a tenant user, so a careless or hostile URL could reach the platform's own network. This includes the cloud metadata address and Cloud SQL.
- **The fix:** the backup callback's guard covers this and should become a shared module that every webhook goes through.
- **What it means for users:** the reference platform allows plain HTTP; this platform should not on the internet, because basic authentication and member data would travel in clear.

### 8. Authenticating the request

- **The reference platform's options:** none, or basic authentication, plus headers that can carry a key.
- **Signing:** this platform can add an HMAC signature of the body with a per-template secret, so the receiver can check the request came from the SACCO and was not changed.
- **Storing secrets:** basic authentication passwords and signing secrets must be stored encrypted and never returned by the API.

### 9. Permissions

- **To add:** VIEW_COMMUNICATION_HISTORY and RESEND_FAILED_MESSAGES.
- **Already there:** CREATE_COMMUNICATION_TEMPLATES and EDIT_COMMUNICATION_TEMPLATES. They now cover webhook templates as well as task templates.
- **Administrators only:** the tenant-wide switch.

### 10. Console

- **Administration > Webhooks:**
  - a list of webhooks with state and status;
  - a form with every field and a placeholder picker;
  - a "send a test" button;
  - the tenant-wide switch.
- **The communication log:** a list with filters, the stored body of each message, and resend for failed messages.

### 11. Size and retention

- **Size:** a body should be capped, for example at 64 KB, with `MAX_MESSAGE_SIZE_LIMIT_EXCEEDED` when it is larger.
- **Retention:** the log grows with every posting, so message bodies need a retention period.

## Proposed build

1. **Tenant migration 045:**
   - `notification_templates` (type `WEB_HOOK` for now; EMAIL and SMS later use the same table);
   - `notification_events` (the outbox);
   - `notification_messages` (the log);
   - `notification_settings`;
   - triggers on `transactions`, `loan_state_history`, `member_state_changes`, `audit_log` and `eod_completions` that write events.
2. **`src/lib/outbound.js`:** the URL guard moved out of `tenantBackup.js` and shared with webhooks.
3. **`src/domain/notifications/`:**
   - templates (create, read, patch, delete, test);
   - events to messages: matching events to templates, conditions, rendering with placeholders;
   - the sender: idempotency header, signature, the 2xx rule, retries with backoff, the circuit breaker;
   - the log and resend.
4. **API, in the reference platform's shapes:**
   - `/api/templates`;
   - `/api/notificationsettings/webhook`;
   - `/api/communications/messages` with `:search`, `:searchSorted`, `:resend`, `:resendAsyncByKeys` and `:resendAsyncByDate`;
   - the v1 `/api/notifications/messages` routes.
5. **Running:**
   - a CLI command `notifications:run`;
   - a `sacco-notify` Cloud Run job started every minute;
   - the in-process scheduler doing the same when it is on;
   - an immediate try after each request that raised events.
6. **Console:** Administration > Webhooks (templates and the switch) and the communication log, replacing the placeholder.
7. **Tests:** a new `test/webhooks.test.js` against a local receiver, and console checks.

## Decisions (my default in brackets)

1. **Events:** build every event in finding 2 that has a source, and leave out cards, payment and collection orders and data access. [Yes]
2. **Capture:** database triggers into an outbox, in the change's own transaction. [Triggers]
3. **Retry schedule:** 1, 5, 15 and 60 minutes, then every 3 hours up to 24 hours (9 tries), then FAILED, which can be resent by hand. [As stated]
4. **Circuit breaker:** pause an endpoint after 20 failures in a row (WAITING, `WAIT_FOR_CLOSE_CIRCUIT`), and try one message every 10 minutes until one succeeds. [As stated]
5. **HTTPS only,** except in development. [HTTPS only]
6. **Signing:** add an HMAC-SHA256 signature header of the body with a per-template secret, alongside the reference platform's none or basic authentication. [Add it, on by default]
7. **Idempotency header:** use the reference platform's name, `x-notifications-idempotency-key`. [Same name]
8. **Templates for other channels:** design the template table for Email and SMS now, but build only webhooks. [Yes]
9. **Opt-in and opt-out:** store the option, which has no effect on webhooks until Email and SMS use it. [Store it]
10. **Body size and retention:** 64 KB per body; keep message bodies 180 days and the rest of the log for good. [As stated]
11. **Cloud Run:** add the `sacco-notify` job and its every-minute schedule to the deploy workflow and `docs/deploy.md`. [Yes]
