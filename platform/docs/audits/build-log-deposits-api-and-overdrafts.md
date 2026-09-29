# Build log: overdraft terms and the deposits API

Built on 29 September 2026, following `audit-deposits-api-and-overdrafts.md`, with its defaults. The commit is on main, on the device, not pushed. John pushes with `git push origin main`.

## Built

### `/api/deposits` (`src/routes/deposits.js`)

A layer over `src/domain/savings.js`. The two APIs work on the same accounts under the same rules and permissions: each `/deposits` route is let in by the permission of the `/savings` route it matches.

- **The account object:**
  - `encodedKey`, `id`, `name`, `accountHolderKey`, `accountHolderType`;
  - `accountState` (the reference platform's names: ACTIVE_IN_ARREARS, CLOSED_REJECTED, WITHDRAWN, CLOSED_WRITTEN_OFF and the rest as they are) and `accountType` (REGULAR_SAVINGS for a savings account);
  - `productTypeKey`, `assignedBranchKey`, `creditArrangementKey`, `currencyCode`, `notes` and the dates;
  - `balances` (total, available, forward available, blocked, hold, locked, overdraft amount, technical overdraft amount, overdraft interest due, fees due) and `accruedAmounts`;
  - `interestSettings` and `overdraftInterestSettings`, each with its `interestRateSettings`: rate, spread, source (FIXED_INTEREST_RATE or INDEX_INTEREST_RATE), terms, index source, review count and unit, tiers, and days in year;
  - `overdraftSettings` (`allowOverdraft`, `overdraftLimit`, `overdraftExpiryDate`), `internalControls` (`maxDepositBalance`, `maxWithdrawalAmount`, `recommendedDepositAmount`), and custom fields as `_set` objects.
- **Endpoints:**
  - `GET /api/deposits` (`accountState`, `branchId`, `accountHolderKey`, `sortBy`, paging headers) and `POST /api/deposits:search` (filter and sorting criteria, including `overdraftSettings.overdraftLimit`, `overdraftSettings.overdraftExpiryDate` and `balances.totalBalance`);
  - `POST /api/deposits` (the reference platform body, overdraft settings included), `GET /:id` (by number or key), `PUT /:id`, `PATCH /:id` (JSON Patch on nested paths) and `DELETE /:id`;
  - `POST /:id:changeState`, `:changeInterestRate`, `:changeWithholdingTax`, `:startMaturity` (a `maturityDate` a whole number of the product's term units away, or `termLength`), `:undoMaturity` and `:applyInterest` (`interestApplicationDate`, not in the future). Each checks its own permission;
  - `POST /:id/deposit-transactions`, `/withdrawal-transactions`, `/transfer-transactions` (to a deposit account or a loan), `/fee-transactions` and `/seizure-transactions`, and `GET /:id/transactions`;
  - transactions come back as the reference platform's DepositTransaction, with its type names; reversals show as `DEPOSIT_ADJUSTMENT`, `FEE_ADJUSTED` and so on;
  - `/:id/blocks`, `/:id/authorizationholds`, `/:id/withholdingtaxes` and `POST /api/deposits/deposit-transactions:bulk`.
- **PUT and PATCH:**
  - apply only what changed, each through its rule: the name, notes, limits and custom fields at any time; the credit rate before activation; the overdraft limit, expiry date, rate and spread as Adjusting Overdraft Terms;
  - the holder, product, type, ID, currency and state are refused (`FIELDS_NOT_EDITABLE`). The state changes through `:changeState`.

### The overdraft expiry date at opening

`POST /api/savings` takes `overdraftExpiryDate`, and `POST /api/deposits` takes `overdraftSettings.overdraftExpiryDate`. It needs an overdraft limit.

### An index rate's review frequency (tenant migration 040)

- Deposit products take `interestReviewCount` and `interestReviewUnit` for an INDEX credit rate, and `overdraftReviewCount` and `overdraftReviewUnit` for an INDEX overdraft rate.
- The unit is DAYS, WEEKS or MONTHS, counted from the account's activation (its opening where it opened ACTIVE).
- A day takes the index rate in force on its latest review date. Unset keeps the platform's rule, the rate in force each day, so running products do not change.
- The count and unit are given together, on an INDEX rate only.
- `depositRules.reviewDate` works out the review date. The accrual and the repricing both use it.

### 30E/360

- The platform's THIRTY_360 already was 30E/360 in its ISDA form: 31sts count as the 30th, and so does the last day of February.
- `/api/deposits` shows it as the reference platform's `E30_360`. It is unchanged, so running products keep their figures.

### Console

- An "Overdraft terms" button on a current account's page, to change the limit, expiry date and rate.
- The review frequency settings on the deposit product form.

## Known limits

- **Field names:** the reference platform's API reference pages did not load here. The `/api/deposits` field names follow the reference platform's published DepositAccount model, but were not checked one by one against the reference.
- **Transfers to a loan:** `transfer-transactions` returns the deposit side of the transfer.
- **Detail levels:** `GET /api/deposits` returns full objects, with no `detailsLevel` switch.

## Tests

- New suite `test/deposits-api.test.js`, 43 checks.
- 42 suites, 2,904 checks, pass under both UTC and Africa/Nairobi.
