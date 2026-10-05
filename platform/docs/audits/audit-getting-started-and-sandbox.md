# Audit: Getting Started and Sandbox against the reference platform

Audited on 5 October 2026, at the SMS commit. Nothing is built yet. The proposed build and its decisions are at the end.

## Reference pages read

### Getting Started

- **Initial setup:** an onboarding team guides a new customer, who gets access through the vendor's customer portal. The setup tasks are listed as "non-exhaustive" and not strictly in order:
  - administration settings: organization details, branches, holidays and user roles;
  - custom field definitions;
  - client types, then clients and groups;
  - transaction channels, currencies, and index and tax rates;
  - loan and deposit products;
  - accounting settings and the chart of accounts.

  Data migration from a legacy system comes after setup.
- **Developer overview:**
  - every paying organization and partner has a second environment, the sandbox, to develop and test against;
  - the APIs are REST with JSON (and YAML for configuration as code);
  - a health check is `GET /healthcheck` on the tenant's own host;
  - the APIs are not versioned, but stay backward compatible for at least one release;
  - webhooks are user-defined callbacks.
- **Base URLs:** `https://<tenant>.<the vendor's domain>/api` in production, and the same with a `sandbox` label in the host for the sandbox. The tenant is the host name.
- **Authentication:**
  - basic authentication with a user's login, for users with API access, HTTPS only;
  - API keys in an `apiKey` header, from API consumers.

### Sandbox

- **What it is:** a separate, isolated tenant for testing configuration, upgrades and new products before production. The full UI and API are available.
- **Release:** it is usually one release ahead of production.
- **Filling it, through the customer portal (admin and technical users only):**
  - **reset** to empty;
  - **clone with production anonymized client data** (recommended);
  - **clone with production data**;
  - **delete**.

  A clone takes seconds for an empty tenant and up to days for one over 100 GB. The portal shows progress.
- **What a clone does not copy:**
  - API keys (administrators make new ones);
  - the notification queues (streaming, webhook, SMS and email).
- **What the anonymized clone does:**
  - client names are obfuscated, and contact details, IDs, addresses and attachments are deleted;
  - account names are obfuscated, and transaction details and comments are removed;
  - all notifications are removed and clients are unsubscribed;
  - custom field values are deleted;
  - activities and profile pictures are removed.
- **No redundancy:** a sandbox has no redundant servers or database backups, so it must not hold live data.
- **Visible difference:** a blue bar labelled "Sandbox Environment" at the bottom of every page.
- **Single sign-on:** federated authentication needs an identity provider application per tenant.

## What the platform has

- **Tenants:**
  - `platform.tenants` (slug, schema, country, currency, time zone, plan, status). A schema per tenant;
  - provisioning (`src/tenancy/provision.js`, `POST /admin/tenants`, `cli provision:run`) builds the schema, seeds the chart of accounts, channels, one savings, loan and share product, and the first administrator;
  - deprovisioning drops a schema.
- **Which tenant a request is for:** the token's claim, then the subdomain, then `X-Tenant`. Slugs use underscores, which are not valid in host names, so subdomains only work for slugs without them.
- **Backups:**
  - per-tenant `pg_dump` with encryption, offsite copies and a restore into another schema;
  - a nightly backup of every tenant;
  - a restore keeps the schema name recorded in the dump, so it cannot make a copy under a new name while the original is live.
- **Anonymizing one exited member:** names, IDs, contacts, addresses, custom fields, media, portal access and the audit trail are redacted, and their messages cleared.
- **Health:** `GET /health` checks the platform: the database, the rate store and the scheduler. There is no `/healthcheck`.
- **API authentication:**
  - a JWT from `/api/auth/login`;
  - API keys in an `apikey` header (from Access > API Consumers);
  - no basic authentication.
- **Setup:** Administration has every setup screen, but nothing tells a new SACCO what to do first or what is still missing.
- **Docs:** the README describes the platform for its developers. There is no guide for someone integrating with a SACCO's API.

## Findings

### 1. No second environment

- **The gap:** a SACCO cannot try a product change, a webhook or an import without doing it in its live book. This is the main gap.
- **What the platform already has:** a schema per tenant, so a sandbox can be another tenant linked to its production one, with the same code and migrations. A sandbox one release ahead would need a second deployment, which the platform does not have.

### 2. Cloning a tenant

- **Why backups do not work:** the backup tools restore into the dumped schema's own name.
- **What works instead:** a clone can provision the sandbox schema with the migrations, then copy each table from production in foreign-key order. User triggers are off while copying, so no events are raised and the ledger's guards do not fire twice. Sequences are then set to production's values.
- **Large tenants:** this needs a job, not a request. The Cloud Run request limit is 60 seconds.

### 3. What a clone leaves out and switches off

- **Left out, as on the reference platform:** API keys, and the notification queues (events, messages, stream events).
- **Switched off in a sandbox by default:** webhooks, email and SMS. A sandbox that sends a real member an SMS about a test loan is the risk to avoid. Templates are kept, so they can be tested once a test channel is set.
- **Staff users:**
  - the reference pages do not say;
  - copying them with their passwords makes the sandbox a second door into production credentials;
  - copying them without passwords, so each sets one, keeps the roles to test with.

### 4. The anonymized clone

- **Reuse:** the platform's member anonymization covers most of the reference platform's list.
- **What it lacks:**
  - account names;
  - transaction notes;
  - activities;
  - attachments and documents on accounts;
  - groups;
  - subscriptions.

  Phone numbers and emails must go, so that nothing in the sandbox can reach a real member.

### 5. Telling the environments apart

The console and portal need the reference platform's bar ("Sandbox Environment"). The API needs a header that says which environment answered.

### 6. Backups and the scheduler

A sandbox should be left out of the nightly backup and offsite copies, as on the reference platform. The end of day can run there, so it can be tested.

### 7. Who manages a sandbox

- **The reference platform:** a vendor portal, for the customer's admin and technical users.
- **On this platform:** this maps to tenant administrators (from Administration) and to platform administrators (`/admin` and the CLI).

### 8. Getting started

- **Initial setup:** a checklist of the reference platform's setup tasks would tell a new SACCO what is left. Each step's state can be read from its data, for example whether any branch, product or user other than the first administrator exists. Each step links to its screen.
- **Health check:** a `GET /healthcheck` that answers at the tenant's address would match the reference platform's.
- **A developer guide** for integrators, covering:
  - base URL and tenant selection;
  - authentication (API consumers and keys);
  - headers, paging, errors and idempotency;
  - webhooks, streaming and the sandbox.
- **Basic authentication:** the reference platform allows a user's password on every request. The platform's API keys and short-lived tokens do the same job without sending a staff password each time.

## Proposed build

1. **Platform migration:** `platform.tenants` gains:
   - `environment` (`PRODUCTION` or `SANDBOX`);
   - `production_tenant_id`;
   - `sandbox_state` (`READY`, `CLONING`, `RESETTING`, `FAILED`) and its detail.
2. **Sandbox operations (`src/tenancy/sandbox.js`):**
   - **create** an empty sandbox `<slug>_sbx`, with the requester as its administrator;
   - **reset** to empty;
   - **clone**, anonymized or with production data;
   - **delete**.

   Each runs as a queued operation picked up by the scheduler or `cli sandbox:run`, with progress and the outcome recorded.
3. **The clone:**
   - tables copied in foreign-key order with user triggers off, and sequences set;
   - left out: API consumers' keys, notification events, messages, stream events, sessions and portal sessions;
   - staff users copied with their roles but no password: each sets one from the sandbox's sign-in, by an administrator's reset;
   - webhooks, email and SMS switched off;
   - members and groups unsubscribed when anonymized.
4. **Anonymization for the clone:** members and groups, their contacts and documents, account names, transaction notes, custom field values, activities, media and attachments. It is applied in the sandbox schema, never in production.
5. **Marking:**
   - the console and portal show a "Sandbox Environment" bar;
   - API answers carry `X-Environment: SANDBOX`;
   - the sandbox is left out of backups and offsite copies.
6. **API and console:**
   - **for tenant administrators:** `GET /api/sandbox` (state, last clone, the address), `POST /api/sandbox` (create), `POST /api/sandbox:reset`, `POST /api/sandbox:clone` with `{ anonymize }`, and `DELETE /api/sandbox`;
   - **Administration > Sandbox** shows these with progress;
   - **for platform administrators:** the same under `/admin/tenants/:slug/sandbox`, and the CLI.
7. **Getting started:**
   - `GET /api/setup-checklist` and an Administration > Getting Started screen with each step, its state and a link to its screen;
   - `GET /healthcheck`;
   - `docs/developer-guide.md`.
8. **Tests:** `test/sandbox.test.js` and console checks.

## Decisions (my default in brackets)

1. **A sandbox per SACCO:** one sandbox tenant linked to production, on the same deployment and release. A release-ahead sandbox needs a second deployment and is left out. [One, same release]
2. **Who manages it:** tenant administrators from Administration > Sandbox, and platform administrators from `/admin` and the CLI. [Both]
3. **Clone options:** empty, anonymized (the default) and with production data. [All three, anonymized by default]
4. **Staff users in a clone:** copied with roles, without passwords or second factors. Each user's password is set by an administrator's reset in the sandbox. [Without passwords]
5. **Outbound in a sandbox:** webhooks, email and SMS start switched off after every clone and reset; an administrator may switch them on to test. [Off]
6. **Backups:** sandboxes are not backed up or copied offsite. [Not backed up]
7. **Getting Started checklist:** an Administration > Getting Started screen with the reference platform's setup steps and their state. [Yes]
8. **Basic authentication:** not added; integrators use API consumers and keys. [Not added]
9. **Health check:** add `GET /healthcheck` at the tenant's address, as on the reference platform. [Yes]
10. **Developer guide:** a `docs/developer-guide.md` for integrators. [Yes]
