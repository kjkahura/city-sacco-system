# Data architecture

How the platform keeps money correct under concurrency, failure and growth: the consistency it promises, how it locks, how it reads, and the paths it will take when one database is not enough. The operator's steps are in `docs/deploy.md`, "The database". The rules a change must follow are in `CLAUDE.md` and `docs/ARCHITECTURE-ESSENTIALS.md`.

Written October 2026, with the database work in tenant migrations 052 and 053.

## 1. Consistency

- **One writer.** Every SACCO's data is written on one PostgreSQL primary. There is no multi-leader replication and there will not be: two places accepting writes could each let the same funds be withdrawn.
- **The ledger is ACID.** A posting is one transaction (`withTenant`): the balance change, the journal entry, the rollup and the audit row commit together or not at all. A deferred trigger checks at commit that every journal balances.
- **When the database is unreachable, postings fail.** In the terms of the CAP theorem the ledger chooses consistency over availability: during a failover or a network split a teller gets an error, never a posting that might later conflict. High availability (a standby in a second zone, `docs/deploy.md`) shortens that window to about a minute; it does not change the choice.
- **What is eventually consistent, on purpose:**

| Part | How far behind | Why it is safe |
| --- | --- | --- |
| Webhooks, SMS and email (`notification_events`, the outbox) | Seconds | The event is written with the change that caused it, so a committed change always gets its message and a rolled-back one never does. |
| Events streaming | Seconds | Read from the same outbox. |
| The climate-adaptation layer's tags | Seconds, or the next daily catch-up run | It never writes money. |
| Reports read from a replica (section 4) | Usually seconds or less | They answer with the time they are as at. |
| The session check | Up to 5 seconds | A sign-out, password change or suspension clears it at once (`forgetSessions` after commit); the 5 seconds bound anything missed. |

## 2. Locking

- **Money: pessimistic locks.**
  - `SELECT ... FOR UPDATE` on the account rows a posting changes, then the advisory lock `member-funds:<member>` for anything that weighs a member's other money (withdrawals, transfers, guarantor pledges). Always rows first, then the lock.
  - A transfer locks both accounts, in a fixed order, before the funds lock.
- **Queues: `FOR UPDATE SKIP LOCKED`.** Message dispatch and sandbox jobs claim work this way, so two workers never take the same item and neither waits for the other.
- **Configuration: optimistic locks (migration 053, `src/lib/versioning.js`).**
  - Loan and deposit products, transaction channels, and custom field sets and definitions carry `row_version`, raised by a trigger on any change except reordering and the account number counter. A product's fees count as part of the product: a fee change raises the product's version, and the fee routes check the product's tag.
  - Their GET answers with `ETag: "v<version>"`. A PUT or PATCH that sends it back in `If-Match` is refused with `412 PRECONDITION_FAILED` when the record has changed since. The console sends it on every edit of these records.
  - The configuration files (`/configuration/customfields.yaml`, `/configuration/transactionchannels.yaml`) have an ETag of their own, a hash of the file, checked the same way under a lock on their tables.
  - Without `If-Match` a change goes through as before, so existing integrations are unaffected.
  - 412 is the status HTTP defines for a failed `If-Match`; a client treats it as "read again, then repeat the change".
- **Deadlocks and serialization conflicts.** PostgreSQL ends one of the transactions and rolls it back. The request is run again (`retryConflicts` in `src/db/tenantContext.js`), up to `CONFLICT_RETRIES` times (default 2) with a short random wait, before the caller gets `409 CONFLICT_TRY_AGAIN`. This is safe because the rolled-back transaction left nothing behind. It is why a handler must not call an outside service inside its transaction: use `afterCommit` or the outbox.
- **Lock escalation** does not happen in PostgreSQL: row locks stay row locks. The platform takes table locks on purpose in one kind of place: a configuration file's PUT locks the tables it replaces (and checks `If-Match` under that lock) for its own transaction.

## 3. The daily rollup (migration 052)

- **What it is:** `gl_daily_balances` and `gl_branch_daily_balances` hold each GL account's debits and credits per day, kept by triggers on `journal_lines`, so reports read a few rows per account and day instead of every line. `cli ledger:verify` proves they match the journal.
- **The hot row:** with one row per account and day, every cash deposit of the day updated the same two rows (cash and the savings liability) and held them locked until it committed. A load test (`test/load/postings.js`) showed postings spending 88% of their time waiting for each other from eight concurrent tellers, and throughput flat from there.
- **Slots:** each account and day is now spread over 16 rows. A transaction writes to the slot its transaction ID falls in, and transactions running at the same time have consecutive IDs, so they take different slots. Every reader sums the rows, so the totals are unchanged. In the same test lock waiting fell to 4% at eight workers and under 1% at sixteen, and throughput rose by half on a 2-core machine (table in `docs/deploy.md`, "Load testing").

## 4. Reads

- **The primary** serves every posting and every read that comes before one (a balance check, a limit, a product rule), inside the posting's own transaction. Nothing that decides about money reads a replica.
- **A read replica** (optional, `PG_REPLICA_HOST`, `docs/deploy.md`) serves the financial statements, the trial balance, the portfolio and management reports, and the dashboard indicators (`withTenantReport`). The answer carries `Data-Source` and `Data-As-At`: now when the replica has applied everything it received, otherwise the time of the latest change it applied.
- **The primary takes over** when the replica cannot be reached (and is then skipped for 30 seconds), is more than `REPLICA_MAX_LAG_SECONDS` (default 60) behind, or cancels the report's query for a conflict with changes it is applying.
- **The data extract stays on the primary.** Its cursor only moves past rows older than the oldest transaction still open, which only the primary can see; on a replica a row committed late could fall behind the cursor and never be extracted.
- **MVCC and snapshots.** Readers never block writers. A tenant backup reads every table in one `REPEATABLE READ` snapshot, so the files agree with each other while postings go on.

## 5. Connections

- **One pool per process** (`PGPOOL_MAX`), never one per SACCO. A transaction picks its SACCO with `SET LOCAL search_path`, which ends with the transaction. A per-SACCO concurrency slot (`src/lib/limits.js`) stops one SACCO taking every connection.
- **Poolers:** because every setting is transaction-local, the platform works behind a pooler in transaction mode (PgBouncer, Cloud SQL managed connection pooling). The three places that hold a session advisory lock across transactions (the scheduler, migrations, sandbox jobs) use `directPool`, a small pool straight to the instance (`PG_DIRECT_HOST`), when one is set.
- **Sizing:** instances times `PGPOOL_MAX`, plus the jobs, must stay under the instance's `max_connections`. `cli db:connections` checks it.

## 6. Payments with outside systems (M-Pesa and others)

M-Pesa cannot take part in a database transaction, so there is no two-phase or three-phase commit across the platform and Safaricom. A payment is a saga: a sequence of local transactions, each with a way to undo it, held together by idempotency and reconciliation. This is the design for the M-Pesa integration (`docs/audits/NEXT.md`, section 3); it is not built yet.

**Money going out (B2C: a disbursement or withdrawal to a phone):**

1. **Intent.** In one transaction: lock the account, check the funds, place a hold for the amount, and write a `payment_requests` row (`PENDING`, a unique originator reference) and an outbox event. Nothing has left the SACCO yet.
2. **Call.** After commit, a worker claims the event (`SKIP LOCKED`) and calls M-Pesa with the originator reference. A timeout leaves the request `PENDING`; it is never treated as failed or as paid.
3. **Result.** The result callback, keyed on the originator reference and the M-Pesa transaction ID (unique in the table), settles the hold into a withdrawal and marks the request `PAID`; a failure result releases the hold and marks it `FAILED`. A repeated callback finds the request already settled and changes nothing.
4. **Unknown outcome.** A request still `PENDING` after a set time is asked about through M-Pesa's transaction status query, and settled by the answer.
5. **Reconciliation.** Daily, every M-Pesa statement line is matched to a request. A statement line with no request, or a request with no line, goes to a person, never to an automatic posting.

**Money coming in (C2B: paybill and till):**

1. The confirmation callback is recorded first, keyed on the M-Pesa transaction ID (unique), then posted to the account the bill reference names, in the same transaction. A repeat of the same transaction ID is answered as accepted and posts nothing.
2. A reference that matches no account posts to a suspense account for a person to allocate.
3. The same daily reconciliation covers it.

The webhook outbox, `Idempotency-Key` on POST routes and holds on deposit accounts already work this way; the M-Pesa module reuses them.

## 7. Outgrowing one instance

- **The order of steps:** a larger tier first (vertical scaling), then the read replica for reports, then a connection pooler, then more service instances (horizontal scaling, which needs Redis for the rate limits). Only after those would SACCOs be split across database instances.
- **The shard key exists:** every SACCO's data is in its own schema and no query spans two SACCOs, so a SACCO can live on another instance without its data being split.
- **What stands in the way, counted in October 2026:**
  - `withTenant` reads the SACCO's time zone from `platform.tenants` in every transaction;
  - tenant code refers to `platform.users` (28 places), `platform.tenants` (45, mostly in migrations and setup), `platform.branch_visible` (6), `platform.api_consumers` (4) and others, inside tenant transactions.
- **The path:**
  1. add a `db_cluster` column to `platform.tenants` (null: the main instance);
  2. keep one pool per cluster and choose it in `withTenant` from the tenant record the request already has, passing the time zone in rather than reading it;
  3. replace the cross-schema references in tenant transactions with values passed in, or a copy of the few platform rows a SACCO needs kept on its cluster;
  4. move a SACCO with the tenant backup (`backup:run`, then `backup:load` on the new instance), `ledger:verify` on both sides, and a switch of `db_cluster` during a maintenance window.
- **Rebalancing** is then moving the largest SACCO, or a group of small ones, the same way. A SACCO that alone outgrows one instance would need its own instance; splitting one SACCO's ledger across instances is not planned.

## 8. Terms used here, and where they apply

| Term | In this platform |
| --- | --- |
| ACID | Every posting (section 1). |
| BASE, eventual consistency | The outbox, streaming, the climate layer, replica reports (section 1). |
| Strong consistency | Everything that decides about money reads the primary in the posting's transaction. |
| Snapshot isolation, MVCC | Tenant backups and sandbox clones; PostgreSQL's own concurrency. |
| Write-ahead log, checkpoints | PostgreSQL's; Cloud SQL point-in-time recovery replays the log. The end of day is idempotent per business date, so a failed run resumes. |
| Failover, high availability | Cloud SQL's standby (`docs/deploy.md`). |
| Split-brain | Prevented by Cloud SQL for the database; the scheduler and migrations take an advisory lock so only one instance runs them. |
| Load balancing | Cloud Run across instances, and the HTTPS load balancer with Cloud Armor (`deploy/security/edge.sh`). |
| Connection pooling | Section 5. |
| Caching | The session check, API keys, and Redis for rate limits. |
| Materialized views | Not used; the daily rollup is a summary table kept exact by triggers (section 3). |
| Secondary, composite, partial, covering indexes | About 140 indexes in the migrations, many composite, 37 partial; covering (`INCLUDE`) indexes only when a measured plan needs one (`docs/deploy.md`, "Watching the database"). |
| B-tree, query planner | PostgreSQL's defaults; Query Insights and `cli db:top-queries` show what the planner chose. |
| Deadlock, optimistic locking | Section 2. |
| Hot partition | The daily rollup (section 3); at SACCO level, a per-SACCO concurrency slot. |
| Resharding, rebalancing, data locality | Section 7; the region choice is in `docs/deploy.md`. |
| Two-phase and three-phase commit | Not used; payments are sagas (section 6). |
| Quorum, consensus | Inside Cloud SQL; nothing in the platform needs them. |
| LSM tree, compaction, Bloom filter | Not used; they belong to write-optimised stores. Dead rows are watched instead (`cli db:bloat`). |
