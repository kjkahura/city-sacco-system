# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Where the code is

Everything live is under `platform/`. The repository root holds only specification
markdown and `Qona-MBS/client/`, a front end candidate that is not wired up.

Read `platform/README.md` before changing anything. It explains the design decisions
and the reasons behind them; several of them look like over-engineering until you know
what went wrong without them.

```bash
cd platform
npm install
npm run migrate      # platform schema, then every tenant
npm test             # 240 assertions; run this after every change
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

## History

The pre-`platform/` tree — a legacy dashboard API, an in-memory Mambu-shaped `/api/v2`,
and a Sequelize server under `Qona-MBS/server/` — lives on the `archive/pre-platform`
branch. Do not resurrect code from it without a reason; it is kept for reference.
