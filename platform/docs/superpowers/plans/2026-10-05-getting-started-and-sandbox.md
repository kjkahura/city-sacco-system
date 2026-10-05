# Getting Started and Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a sandbox per SACCO after the reference platform (create, reset, clone anonymized or with production data, delete), a Getting Started checklist, `GET /healthcheck` and a developer guide.

**Architecture:**
- **The sandbox** is a tenant `<slug>_sbx` with `environment` `SANDBOX`, linked to its production tenant (platform migration 015).
- **Operations** are queued in `platform.sandbox_operations`, one open at a time, and run by `runPending()` in `src/tenancy/sandbox.js`.
- **The clone** migrates a new schema and copies each table with user triggers off.

**Spec:** `platform/docs/audits/audit-getting-started-and-sandbox.md`. On 5 October 2026 John accepted the ten defaults.

## Global Constraints

- **Vendor name:** never in code, docs or commits.
- **Writing style:** no em dashes.
- **Production is never written** by a sandbox operation; every write is in the sandbox schema or the platform tables.
- **Staff users** are copied without passwords or second factors. The requester's temporary password is shown once.
- **Outbound:** webhooks, email and SMS are off in a sandbox after every operation, and their secrets are dropped.
- **Backups** leave sandboxes out.
- **Deployed behaviour:** a production tenant behaves as before; the only additions are the `X-Environment` header and new routes.

## Tasks

- [x] **1. Platform migration 015:** `environment`, `production_tenant_id`, `sandbox_state` on tenants; `sandbox_operations`.
- [x] **2. `src/tenancy/sandbox.js`:** `status`, `request`, `runPending`; the clone, anonymization, quieting and users. Test: `test/sandbox.test.js`.
- [x] **3. Routes:** `/api/sandbox` and its `:reset` and `:clone`, `/admin/tenants/:slug/sandbox`, the CLI `sandbox:run` and `sandbox:request`, `X-Environment`, `GET /healthcheck`.
- [x] **4. Backups:** `backupTargets()` returns active production tenants only.
- [x] **5. Getting Started:** `src/domain/setupChecklist.js` and `GET /api/setup-checklist`.
- [x] **6. Console and portal:** Administration > Getting Started and Sandbox, the "Sandbox Environment" bar. Test: `test/console.test.js`.
- [x] **7. Docs:** `docs/developer-guide.md`, README, `docs/deploy.md`, the build log.
- [x] **8. Full runs in UTC and Africa/Nairobi, a final review, fixes.**
