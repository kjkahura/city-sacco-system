# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Where the code is

Everything live is under `platform/`: the API in `src/`, the back office in
`public/`, the member portal in `portal/`. The repository root holds only
specification markdown.

Read `platform/docs/ARCHITECTURE-ESSENTIALS.md` first: two pages on tenancy, money,
access, requests, audit, migrations and tests. Then read the sections of
`platform/README.md` that touch your change. The README explains the design decisions
and the reasons behind them; several of them look like over-engineering until you know
what went wrong without them.

```bash
cd platform
npm install
npm run migrate      # platform schema, then every tenant
npm test             # about 3,600 checks in 52 suites; run this after every change
npm start
```

## Rules that are not negotiable

- **Tenant data is only ever touched inside `withTenant()`** (`src/db/tenantContext.js`).
  It opens a transaction and sets `search_path` with `is_local = true`, so Postgres
  reverts it on COMMIT or ROLLBACK. A query outside that wrapper runs against whatever
  schema the pooled connection was last used for. Never build a schema name by string
  concatenation and never add a second connection pool.
- **Money is `numeric` and arithmetic happens in SQL**, with `FOR UPDATE` where a read
  precedes a write. Do not read a balance into JavaScript, add to it, and write it back.
- **Nothing financial is edited or deleted.** A mistake is corrected by posting a
  reversal, so both entries stay visible to an auditor.
- **Do not catch a unique violation inside a transaction.** Postgres aborts the whole
  transaction on any statement error, so the caught 23505 leaves every later statement
  failing. Use `ON CONFLICT DO NOTHING` and check the returned rows.
- **Invariants belong in the database**: deferred constraint triggers for journal
  balance, BEFORE UPDATE/DELETE triggers for immutability. Application checks are a
  convenience on top, never the guarantee.
- **Reports read `gl_daily_balances`, never `journal_lines`.** The rollup is kept
  exact by a trigger because the journal is append-only; `cli ledger:verify` proves
  it. A report that scans lines is a regression.
- **A refusal that follows a write must be returned, not thrown.** See
  `memberAuth.refuse`: throwing rolls back the failed-attempt record and the
  lockout with it.
- **Member tokens and staff tokens never cross.** `requireAuth` refuses role
  MEMBER; `requireMember` refuses everything else. Do not add a role list that
  includes both.

- **A committed migration is never edited.** The runner stores checksums and refuses a
  changed file. Add a new numbered file under `src/db/migrations/platform` or `tenant`.
- **Every `/api` route has a line in `src/lib/routePermissions.js`.** A route missing from
  it is open only to administrators. Permissions, not the built-in role, decide access.
- **Sessions are checked on every request.** After revoking refresh tokens or member
  sessions, call `RESOLVE.forgetSessions(c)` so the cached session state is cleared once
  the transaction commits.
- **Money limits and dates go through the shared checks**: `assertWithinLimit` in
  `src/domain/controls.js` for amounts, and the backdating permissions
  (`BACKDATE_SAVINGS_TRANSACTIONS`, `BACKDATE_LOAN_TRANSACTIONS`,
  `BACKDATE_SHARE_TRANSACTIONS`) for past value dates. Staff may not date a posting in
  the future.
- **Lock order for a member's money:** account rows (`FOR UPDATE`) first, then the
  advisory lock `member-funds:<memberId>`. Reversing the order deadlocks against a
  withdrawal.
- **Outbound calls to an address a tenant chose** go through `src/lib/outbound.js`.
- **The front ends talk to the server only through `/api`.** `platform/public` and
  `platform/portal` import nothing from `src/` or from each other, and request no other
  origin. Their headers are in `src/lib/frontendHeaders.js`; when the CSP changes, change
  the copy in `deploy/security/edge.sh` too. `test/frontends.test.js` checks all of this.
- **A security fix gets a check in `test/hardening.test.js`.**
- **Do not name the vendor whose API this platform follows** in code, docs, commits,
  paths or header names. Write "the reference platform".

## Before you commit

- Run the suites your change touches, then `npm test`. Some loan suites fail on certain
  calendar dates whatever the change; compare against the previous commit before
  treating a failure as yours.
- Stage files by path. Never `git add .`: the repository root holds files that are not
  part of the platform.
- Update the README section, `docs/deploy.md` (for settings) and the audit or build log
  that the change belongs to.

## History

The pre-`platform/` tree (a legacy dashboard API, an in-memory reference-shaped `/api/v2`,
and the original Qona-MBS server and client) lives on the `archive/pre-platform`
branch. Do not resurrect code from it without a reason; it is kept for reference.
