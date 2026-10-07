# Build log: the database (availability, concurrency, reads, growth)

Built on 7 October 2026, from a review of the platform against the usual distributed-data concepts (replication, consistency, locking, scaling) and eleven recommendations, which John accepted with "Go with this". The design is written up in `docs/data-architecture.md`; the operator's steps are in `docs/deploy.md`, "The database". The commit is on main locally and on the device, not pushed.

## The eleven recommendations and what was done

| # | Recommendation | Done |
| --- | --- | --- |
| 1 | High availability and failover | `--availability-type=REGIONAL` in section 2 of `deploy.md`, the patch command for an existing instance, and a failover rehearsal (`gcloud sql instances failover`) for staging. Operator step in `NEXT.md`. |
| 2 | The hot row in `gl_daily_balances` | Measured with a new load test, then fixed: tenant migration 052 spreads each account and day over 16 slots. |
| 3 | Optimistic locking for configuration | Tenant migration 053 and `src/lib/versioning.js`: ETag, If-Match, 412. The console sends If-Match. |
| 4 | Connection pool sizing | `cli db:connections`; `directPool` (`PG_DIRECT_HOST`) for the three session advisory locks, so a pooler in transaction mode works; `deploy.md`, "Scaling the database". |
| 5 | A read replica for reports | `replicaPool` (`PG_REPLICA_HOST`, repository variable `CLOUD_SQL_REPLICA`) and `withTenantReport`, with `Data-As-At` and `Data-Source`, the console's "Includes changes up to" line, and fallback to the primary. |
| 6 | Retry on deadlock and serialization errors | `retryConflicts` around every handler transaction (`CONFLICT_RETRIES`, default 2). |
| 7 | Query monitoring | Query Insights in section 2, `cli db:top-queries` (pg_stat_statements), and the rule to measure with `EXPLAIN (ANALYZE, BUFFERS)` before adding an index. No index added: none was measured as needed. |
| 8 | Data locality | `deploy.md`, "Choosing the region": `africa-south1` offers Cloud Run and Cloud SQL; the 2021 regulations' localisation list does not name SACCO records. Operator step in `NEXT.md`. |
| 9 | M-Pesa as a saga | The design, step by step, in `data-architecture.md` section 6; `NEXT.md` points the M-Pesa item at it. Not built: M-Pesa itself is not built yet. |
| 10 | A resharding path | `data-architecture.md` section 7: the order of scaling steps, what stands in the way (counted), and the path. Not built: not needed at today's size. |
| 11 | Autovacuum on busy tables | `cli db:bloat` over the tables updated many times a day, with a threshold. No setting changed: nothing was measured as needing it. |

## Built

### Tenant migration 052: rollup slots

- `gl_daily_balances` and `gl_branch_daily_balances` gain `slot` (0 to 15) in their primary key. The triggers write to the slot `txid_current() % 16`. Existing rows are slot 0.
- Every reader already summed the rows; the review confirmed it (`accounting.js`, `managementReports.js`, backup, sandbox clone, year-end close).
- **Load test** (`test/load/postings.js`, 2-core machine): see the table in `deploy.md`, "Load testing". At 8 workers, lock waiting fell from 88% to 4%, the 95th percentile from 159 ms to 58 ms, and throughput rose from 138 to 207 postings a second.

### Retries (`src/db/tenantContext.js`, `src/lib/handlers.js`)

- A request whose transaction ends with 40P01 or 40001 is run again with a short random wait, up to `CONFLICT_RETRIES` (default 2, at most 5; 0 restores the old behaviour).
- Not retried once an answer has been sent or the client has gone (checked again after the wait).
- The status a failed try set is cleared before the next.
- Rule added to `CLAUDE.md`: outside calls belong after the commit.

### Tenant migration 053 and `src/lib/versioning.js`

- `row_version` on `loan_products`, `savings_products`, `transaction_channels`, `custom_field_sets` and `custom_field_definitions`, raised by `bump_row_version` on any change except `sort_order`, `updated_at` and `id_next` (the account number counter).
- A product's fees raise the product's version (`bump_product_version_for_fee`), and the six fee routes check the product's tag.
- **Routes:** GET answers with `ETag: "v<n>"`; PUT and PATCH check `If-Match` inside their transaction after locking the row, and refuse with 412 `PRECONDITION_FAILED`, carrying the current ETag. The two configuration files have a hash ETag, checked under a lock on their tables.
- **Console:** product, fee, channel, custom field set and definition edits send `If-Match`; the channel form reads the channel first.
- **Status:** 412 rather than the 409 first suggested, because 412 is what HTTP defines for a failed `If-Match`.

### Pools (`src/db/pool.js`)

- `directPool` (`PG_DIRECT_HOST`, `PGPOOL_DIRECT_MAX` 3): the scheduler's lock, the migration run's lock, and sandbox operations. Unset, it is the main pool.
- `replicaPool` (`PG_REPLICA_HOST`, `PGPOOL_REPLICA_MAX` 10). Unset, reports read the primary as before.
- `endAll()` closes them all (CLI, tests).

### Reports from the replica (`withTenantReport`)

- **Used by:** the `report()` routes (statements, portfolio, risk, management reports, indicators including the dashboard's) and the trial balance.
- **Not used by:** the data extract, whose cursor depends on the primary's open transactions.
- **Falls back to the primary when the replica:**
  - cannot be reached (skipped for 30 seconds);
  - is behind by more than `REPLICA_MAX_LAG_SECONDS` (60) without being caught up;
  - cancels a query (40001), is shutting down, or lacks a table not yet replicated.
- **As at:** now when the replica has applied everything it received; otherwise the last applied change.
- Exports carry a "Data as at" line.

### Health commands (`src/ops/dbHealth.js`)

- `db:connections --instances N --pool-max 10 --jobs 3`: limit, open connections by application, and whether the platform fits under 80% (counts the direct pool when set).
- `db:top-queries`: pg_stat_statements by total time.
- `db:bloat`: dead rows and last autovacuum for the busy tables in every schema, `LOOK` over 10,000 dead and 20%.

### Deploy workflow

- **Optional repository variables:** `CLOUD_SQL_REPLICA` (attaches the replica to the service and sets `PG_REPLICA_HOST`) and `CONFLICT_RETRIES`.
- **Flag change:** the service now uses `--set-cloudsql-instances`, so a replica that is removed from the variable is detached.

## Review

An independent review found the following, all fixed:

- **Opening any account raised the product's version** (the `id_next` counter), so an administrator's product edit on a busy SACCO would always be refused. `id_next` is now excluded, with a test.
- **Replica errors:**
  - a report the replica cancelled for a conflict with recovery failed instead of reading the primary;
  - a replica that was down cost every report five seconds;
  - a stopped replica would have been used indefinitely;
  - the as-at time was misleading when the primary was idle.
- **Product fees were outside the version,** and a 412 did not carry the current tag.
- **A retry could start after the client had gone.**
- **Smaller fixes:**
  - the migration run's lock and its migrations no longer share the small direct pool (the grants step timed out when they did);
  - the load test no longer migrates other SACCOs;
  - `db:connections` takes the service's pool size and counts jobs and the direct pool;
  - doc wording corrected (custom field set versions, table locks, migration 052 needing a quiet window).

It found the rollup readers, retry safety, the trigger order, standby compatibility of the report code, the direct-pool sites and the workflow change correct.

## Tests

- **`test/database.test.js`** (new, 47 checks):
  - the rollup key and slots;
  - a real deadlock resolved by a retry;
  - retry limits;
  - optimistic locking on products, fees, channels, custom fields and both files;
  - the account counter not raising the version;
  - report routing, headers and fallback.
- **A real streaming replica** (pg_basebackup on a second local server, not part of the suite):
  - reports, the trial balance and exports answered from it with `Data-Source: replica`;
  - with replay paused past the lag limit, reports read the primary;
  - a table not yet replicated was read from the primary;
  - after resuming, the replica served again.
- **`test/load/postings.js`:** the measurements above; the rollup total matched the postings in every run.
- **Full run, both time zones:** 3,792 checks passed in each of UTC and East Africa Time; the only failures are the known date failures (lending 2, loan-accounting 8, loan-accounts 1).

## Left out

- **Moving a SACCO to another instance:** a path only (`data-architecture.md` section 7).
- **The M-Pesa saga:** a design only, until M-Pesa is built.
- **Covering indexes and autovacuum settings:** to be added only after staging measurements.
- **The failover rehearsal, the region measurement and installing pg_stat_statements:** operator steps (`NEXT.md`).
