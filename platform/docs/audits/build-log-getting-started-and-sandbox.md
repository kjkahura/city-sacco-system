# Build log: Getting Started and Sandbox

Built on 5 October 2026 from `audit-getting-started-and-sandbox.md`. John accepted the ten decision defaults. The plan is `docs/superpowers/plans/2026-10-05-getting-started-and-sandbox.md`. There is one commit on main, not pushed.

## Built

### The sandbox (`src/tenancy/sandbox.js`, platform migration 015)

- **The tenant:** `<slug>_sbx`, with `environment` `SANDBOX`, a link to its production tenant and a `sandbox_state`. One open sandbox per SACCO, on the same release. A production tenant cannot take a name ending in `_sbx`.
- **Operations:**
  - **create:** an empty book with the seeds a new SACCO gets;
  - **reset:** the same, over an existing sandbox;
  - **clone:** production's book, members anonymized by default, or with production data;
  - **delete:** the schema dropped, the tenant closed and its users removed.
- **Running them:**
  - queued in `platform.sandbox_operations`, one open at a time per SACCO (409 `SANDBOX_BUSY` otherwise);
  - run straight after the request, by the scheduler's minute pass, by `cli notifications:run` and by `cli sandbox:run`;
  - a runner holds an advisory lock on the operation it runs. An operation left RUNNING with no lock held is marked failed (`INTERRUPTED`) by the next run, so the SACCO is never stuck;
  - before dropping a schema, the runner checks that it belongs to a sandbox of that SACCO and is not production's.
- **The clone:**
  - a new schema from the migrations, then every table copied from one snapshot of production (`REPEATABLE READ`), with foreign keys dropped and re-added and user triggers off, and the sequences set;
  - left out: the notification queues, stream records, idempotency records, member credentials and sessions, and the backup list. API keys live in the platform schema and are not copied;
  - in the same transaction, the anonymization and the switching off, so production's personal data is never committed to the sandbox when anonymizing.
- **The anonymized clone:**
  - members and groups renamed ("Client" or "Group" and the member number), and their contacts, IDs, addresses, birth dates and employers removed;
  - account names, task titles and every free-text column (notes, narrations, descriptions, reasons, purposes, migration fields) cleared, wherever they appear;
  - custom field values cleared on every table;
  - identification files, media, beneficiaries, attachments, the audit trail and audit events deleted;
  - imported files emptied;
  - members unsubscribed from email and SMS templates;
  - staff phone numbers and custom fields cleared.
- **Users:** production's staff copied with their roles, branches, limits and permissions, without passwords or second factors. The requester becomes the sandbox's administrator with a temporary password shown once and changed at the first sign-in.
- **Switched off after every operation:** webhooks (and each webhook template), email and SMS, with their secrets and the SMS report address dropped.
- **Security:** the sandbox takes production's access preferences and second-factor rules at every operation. A token for one tenant does not work in the other.
- **Backups:** sandboxes are left out of the nightly backup and refused by name.

### API, console and portal

- **For tenant administrators:** `GET`, `POST` and `DELETE /api/sandbox`, `POST /api/sandbox:reset` and `POST /api/sandbox:clone` with `{ anonymize }`. The four changes ask for the password again when re-authentication is on.
- **For platform administrators:** `GET` and `POST /admin/tenants/:slug/sandbox`, and `cli sandbox:request`.
- **Marking:** every answer from a SACCO's API carries `X-Environment`. The login answer's tenant has `environment`. The console and portal show a "Sandbox Environment" bar at the bottom of every page in a sandbox.
- **Administration > Sandbox** (administrators only): the state, the last operation, and create, reset, clone (with the anonymize choice) and delete, each confirmed. The temporary password is shown once.

### Getting Started

- **`GET /api/setup-checklist`** and **Administration > Getting Started:** fourteen setup steps in the reference platform's order, each `DONE`, `DEFAULT` (the seeded defaults are in place) or `TODO`, with a link to its page. The count shows the required steps done and those on the defaults.
- **`GET /healthcheck`** answers `{"status": "UP"}`, or 503 `DOWN`.
- **`docs/developer-guide.md`** for integrators: tenant selection, the health check, the sandbox, keys and tokens, paging, errors, idempotency, rate limits, versions, webhooks and streams, and a first request.

### Docs

- **README:** a "Getting started and the sandbox" section.
- **docs/deploy.md:** the notification job runs sandbox operations; sandboxes are not backed up.
- **Audits README:** row 22.

## Tests

- **`test/sandbox.test.js` (47 checks):** the checklist and its counts, the health check, the guide, the reserved names, create, the temporary password, the environment marking, isolation of tokens, the anonymized clone (with a scan of every text and JSON column of the book for production's personal data), webhooks off one by one, access preferences, staff details, production untouched, keys not copied, the clone with production data, reset, backups, re-authentication, an interrupted operation, delete, and the platform side.
- **`test/console.test.js`:** Getting Started with its links, the Sandbox tab (create, the password, ready, delete) and the bar.
- **Full runs in UTC and Africa/Nairobi:** all suites pass, except the known date-dependent checks in lending, loan-accounting and loan-accounts. These fail on the base commit too.

## Final review

A fresh reviewer found two critical issues, six important ones and six minor ones. All were fixed, test-first where a check could show them:

- **Critical:**
  - the clone read each table at a different moment, so a posting made during it could be copied in part;
  - an operation interrupted by a restart stayed RUNNING and blocked the SACCO's sandbox for good, the scheduler did not run the queue, and a request made while the runner was finishing could wait.
- **Important:**
  - imported files and several free-text columns kept members' details in the anonymized clone;
  - the anonymization ran after the copy was committed;
  - each webhook stayed on with production's address, so switching webhooks on would have sent sandbox events to production's receivers;
  - the sandbox ran without production's access preferences;
  - sandbox operations did not ask for the password again;
  - the seeded currencies and accounting settings made Getting Started count steps as done.
- **Minor:**
  - the tenant cache was not cleared when an operation failed;
  - no check before dropping a schema, and production tenants could take a `_sbx` name;
  - staff phone numbers and custom fields in the anonymized clone;
  - a sandbox could be backed up by name;
  - the guide promised `X-Environment` on answers given before the SACCO is known;
  - the Sandbox tab used a permission code that is not in the catalogue.

## Not built

- A sandbox one release ahead of production: it needs a second deployment (decision 1).
- Basic authentication (decision 8).
- Suspending a SACCO does not suspend its sandbox; its administrators can delete it.
- Another server keeps a sandbox's tenant record in its cache for up to a minute after an operation run elsewhere.
