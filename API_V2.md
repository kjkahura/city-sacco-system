# Mambu-conformant API (`/api/v2`)

Modelled on [Mambu API v2](https://docs.mambu.com/api/pages/api-v2/welcome/), read 21 September 2026.

The legacy dashboard API at `/api/*` is unchanged. Both surfaces read and write
the same in-memory collections in `src/store.js`, so a loan disbursed through
`/api/v2` shows up in the dashboard immediately.

```
npm start        # http://localhost:3000
npm test         # 33 end-to-end assertions
npm run coverage # group coverage report
npm run routes   # full route inventory
```

## Scale

| | |
|---|---|
| Mambu v2 operations published | 607 total, 387 across the 40 core resource groups |
| Resource groups mounted here | 40 of 40 |
| Routes on `/api/v2` | 400 |
| Legacy dashboard routes preserved | 83 |

"Mounted" means the group answers requests. It does not mean every one of
Mambu's documented operations for that group exists. See Depth below.

## Depth

**Full domain behaviour.** Loans, Deposits, Accounting. These have real state
machines, real money movement, and real double-entry postings.

**Baseline contract only.** The other 37 groups get list, get, create, update,
patch, delete and search over their collection. They are structurally correct
and will accept and return data, but they carry no domain rules yet.

## Architecture

```
src/
  store.js              in-memory collections, shared by both API surfaces
  lib/
    http.js             Mambu error envelope, pagination, detailsLevel,
                        sortBy, and the filter-criteria operators
    resource.js         generic router factory: the baseline contract
  domain/
    accounting.js       double-entry posting, reversal, trial balance
    loans.js            state machine, schedule, disbursement, repayment,
                        write-off, reschedule, refinance, payoff
    deposits.js         deposit, withdrawal, transfer, blocks, fees, interest
  routes/
    loans.js            loan action routes
    deposits.js         deposit action routes
    accounting.js       journal entries and GL
    index.js            the other 37 groups via the factory
scripts/
  smoke.js              end-to-end test
  coverage.js           route inventory and group coverage
```

## Conventions followed

**Error envelope.** `{ "errors": [{ "errorCode", "errorReason", "errorSource" }] }`

**Pagination.** `?offset=&limit=` with `items-offset`, `items-limit` and
`items-total` response headers. Default limit 50, maximum 1000.

**Details level.** `?detailsLevel=BASIC|FULL`. BASIC strips nested objects.

**Sorting.** `?sortBy=field:ASC` or `field:DESC`.

**Search.** `POST /api/v2/<resource>:search` with a body of
`{ filterCriteria: [{ field, operator, value }], sortingCriteria: { field, order } }`.
Operators implemented: EQUALS, DIFFERENT_THAN, MORE_THAN, LESS_THAN, BETWEEN,
ON, AFTER, BEFORE, BEFORE_INCLUSIVE, STARTS_WITH, IN, TODAY, EMPTY, NOT_EMPTY.

**Patch.** `PATCH /api/v2/<resource>/<id>` takes `[{ op, path, value }]` and
returns 204, as Mambu does.

## Loan lifecycle

States: `PARTIAL_APPLICATION`, `PENDING_APPROVAL`, `APPROVED`, `ACTIVE`,
`ACTIVE_IN_ARREARS`, `CLOSED`, `CLOSED_REPAID`, `CLOSED_WRITTEN_OFF`,
`CLOSED_REJECTED`, `CLOSED_WITHDRAWN`, `CLOSED_RESCHEDULED`, `CLOSED_REFINANCED`.

Invalid transitions return 409. You cannot disburse an unapproved loan.

```
POST /api/v2/loans                                   create (PENDING_APPROVAL)
POST /api/v2/loans/{id}/approve                      approve
POST /api/v2/loans/{id}/disbursement-transactions    disburse, posts to GL
GET  /api/v2/loans/{id}/schedule                     generated schedule
GET  /api/v2/loans/{id}/installments
POST /api/v2/loans/{id}/repayment-transactions       repay
GET  /api/v2/loans/{id}/balances
POST /api/v2/loans/{id}/fee-transactions
POST /api/v2/loans/{id}/interest-applied-transactions
POST /api/v2/loans/{id}/payoff
GET  /api/v2/loans/{id}/payoff/preview
POST /api/v2/loans/{id}/writeoff-transactions
POST /api/v2/loans/{id}/writeoff-transactions/undo
POST /api/v2/loans/{id}/reschedule
POST /api/v2/loans/{id}/refinance
POST /api/v2/loans/transactions/{txId}/adjustment
```

Repayment allocation order is penalty, fees, interest, principal, then any
surplus to the member's deposit account. This matches Mambu's default.

Due dates are shifted forward off weekends and off anything in
`/api/v2/holidays`, so Kenyan public holidays move an installment rather than
silently falling due on a day the SACCO is shut.

## Deposits

```
POST /api/v2/deposits/{id}/deposit-transactions
POST /api/v2/deposits/{id}/withdrawal-transactions
POST /api/v2/deposits/{id}/transfer-transactions
POST /api/v2/deposits/{id}/fee-transactions
POST /api/v2/deposits/{id}/interest-available-transactions
GET  /api/v2/deposits/{id}/balances
POST /api/v2/deposits/{id}/blocks
POST /api/v2/deposits/blocks/{blockKey}/seize
POST /api/v2/deposits/transactions/bulk          payroll runs
POST /api/v2/deposits/transactions/{txId}/adjustment
```

Withdrawals check available balance, which is total balance minus active
blocks. Overdrawing returns 409.

## Transactions are immutable

The legacy API exposes `PUT /api/transactions/:id` and
`DELETE /api/transactions/:id`. Mambu has neither, deliberately.

On `/api/v2` a posted transaction cannot be edited or deleted. Corrections go
through `POST .../{txId}/adjustment`, which writes a reversing journal entry,
restores the account balances, and links the two records. Both stay visible.
Adjusting the same transaction twice returns 409.

The legacy endpoints are left in place so the existing dashboard keeps working.
They should be removed before this handles real member data.

## Accounting

Every money movement posts a balanced journal entry. Nothing writes a balance
directly.

```
GET  /api/v2/accounting/journalentries
POST /api/v2/accounting/journalentries
POST /api/v2/accounting/journalentries/{entryId}/reversal
GET  /api/v2/accounting/glaccounts
GET  /api/v2/accounting/glaccounts/{code}/balance
GET  /api/v2/accounting/trialbalance
```

An unbalanced entry is rejected with 400. An entry referencing an unknown GL
account is rejected with 400. There is no delete: reversal is the only
correction, and it links both directions.

The trial balance is computed from posted entries, not from the hardcoded
`TB_DATA` the legacy reports use.

Transaction channels carry the settlement GL account, so an M-Pesa deposit
debits M-Pesa Settlement while a cash deposit debits Cash on Hand.

## Known gaps

This is an in-memory prototype. Before real member data:

1. **No persistence.** Everything resets on restart.
2. **No authentication.** Every endpoint is open. Mambu uses API keys or OAuth.
3. **Schema fidelity is approximate.** Mambu's machine-readable OpenAPI spec is
   only served from an authenticated tenant at
   `https://TENANT.mambu.com/api/openapi/resources/{resource}/v2`. Paths and
   payload shapes here follow the documented operation names and Mambu's
   conventions, but they have not been diffed against the actual spec. Pull the
   OAS from a sandbox tenant to close this.
4. **37 groups have no domain rules**, only the CRUD contract.
5. **Interest accrual is manual.** There is no scheduler; call the
   interest-applied endpoint or wire it to the EOD process.
6. **Flat-rate schedules only.** The seed products are flat monthly rate. No
   declining balance, no variable rate off an index.
