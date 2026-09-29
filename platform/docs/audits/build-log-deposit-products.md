# Build log: Deposits > Deposit Products

Built on 29 September 2026, following the audit in `audit-deposit-products.md`. John asked for the audit and then for everything in scope to be built, so the audit's defaults were taken. The commit is on main, on the device, not pushed. John pushes with `git push origin main`.

## Decisions (the audit's defaults)

1. **Types for existing products:** a product with overdrafts or technical overdrafts became a Current Account, a funding product an Investor Account, the rest Savings Accounts. A writer that does not name a type (an older script, a direct insert) gets the type its settings imply, through a trigger.
2. **Balance basis:** MINIMUM keeps its meaning, the lowest balance in the interest period. The reference platform's MINIMUM_DAILY and AVERAGE_DAILY were added beside it.
3. **A product rate change:** it applies from the next accrual. The reference platform recalculates back to the last application; here, nothing already accrued moves. An account-level change can still be backdated to the day after the last application, as the reference platform allows.
4. **Dormancy:** every transaction counts as activity except interest postings and fees charged by the end of day. A deposit or withdrawal on a dormant account returns it to ACTIVE.
5. **Arbitrary fees:** allowed on every product, new ones included, until the tenant turns them off. The audit first proposed starting new products without them, as the reference platform does. The build found that API clients create products and charge arbitrary fees on them today, so the default stayed on. The audit was amended to match.
6. **Left out:** currencies per product, offset accounts, profit sharing, solidarity group holders, and the account initial state and approval (the Deposit Accounts section).

## Built

### Product types and categories

- Five types: CURRENT_ACCOUNT, SAVINGS_ACCOUNT, FIXED_DEPOSIT, SAVINGS_PLAN, INVESTOR_ACCOUNT.
- Six categories, kept as a label.
- **Overdrafts:** only on current accounts, enforced in the database. A savings account given overdrafts without a type named becomes a current account, which is the reference platform's definition of one.
- **Funding:** the funding flag and the INVESTOR_ACCOUNT type are kept in step.
- **Fixed deposits and savings plans:** they need a term, and interest is posted on maturity unless the product says otherwise.
- **Frozen once accounts exist:** the type, the account numbering type, the rate terms, the term unit and the overdraft rate terms. This is in addition to the three settings frozen before.

### Account numbers per product

- INCREMENTAL_NUMBER counts up from a starting number, digits only.
- RANDOM_PATTERN fills a pattern: `#` a digit, `@` a letter, `$` either.
- A product that sets neither keeps the shared SA series.
- The pattern filler moved from `loans.js` to `accountNumbers.js`, so loans and deposits share one. `loans` still exports it.

### Interest (`src/domain/depositRules.js`, the accrual in `savings.js`)

- **Rate terms:**
  - FIXED, with a range, so each account can have its own rate;
  - INDEX: an interest rate source plus a spread with a default, minimum and maximum;
  - TIERED_BALANCE, TIERED_BANDS and TIERED_PERIOD.
- **Rate given per:** a year, a month, 4 weeks, a week or X days. An index rate is always a year's rate.
- **Balances:**
  - MINIMUM_DAILY and AVERAGE_DAILY come from `savings_intraday_balances`. A trigger on the account balance keeps each day's opening balance, lowest balance, and the balances after each movement.
  - The reference platform's worked example (balances 40, 35 and 60) gives 45, 35 and 60.
  - END_OF_DAY takes a maximum balance.
- **Days in a year:** ACTUAL_ACTUAL_ISDA was added.
- **Posting:** DAILY, FIRST_DAY_OF_MONTH, WEEKLY, EVERY_OTHER_WEEK, four schedules from activation (clamped at month end), FIXED_DATES and ON_MATURITY. The calendar schedules are unchanged.
- **Locked and matured accounts:** collect interest when locked (on by default) and accrue after maturity (off by default).
- **Rate changes:**
  - On the product, `applyTo` ALL_ACCOUNTS (the default) or NEW_ACCOUNTS. With NEW_ACCOUNTS, existing accounts keep their rate; it applies to fixed rates only.
  - On the account, `POST /api/savings/:id:changeInterestRate` for fixed rates. It can be backdated to after the last application but never post-dated. Accrued interest is priced again and booked.
  - All changes are kept in `savings_interest_rate_changes`.

### Limits, term and maturity, dormancy

- **Maximum withdrawal:** one transaction may not take more than the product's maximum.
- **Opening balance:** a minimum, maximum and default. Before the term starts, a fixed deposit or savings plan may not hold more than the maximum.
- **Recommended deposit:** a guideline for fixed deposits and savings plans.
- **Account maximum balance:** set with `PATCH /api/savings/:id`. A deposit or transfer that would go beyond it is refused with MAXIMUM_DEPOSIT_BALANCE_EXCEEDED.
- **Maturity:**
  - `POST /api/savings/:id/maturity` (ACTIVATE_MATURITY) starts the term once the opening balance is reached. The term must be within the product's range.
  - `DELETE` undoes it before the maturity date (UNDO_MATURITY).
  - A fixed deposit takes no deposits once its maturity has started; a savings plan takes deposits until its maturity date.
  - Neither pays out during the term without MAKE_EARLY_WITHDRAWALS.
  - At the maturity date, the end of day sets the new MATURED state and posts interest if the product posts on maturity. A matured account can be withdrawn from and closed, but takes no deposits.
- **Dormancy:**
  - Each product can set a number of days (not for products with a maturity date). `last_activity_on` on each account records the last financial activity.
  - The end of day makes inactive accounts DORMANT.
  - Posting on a dormant account needs POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS.
- **A matured account counts as open** when working out whether the holder is ACTIVE.

### Fees

- **Monthly fees:** an apply date method of END_OF_MONTH (which existing fees keep), FIRST_DAY_OF_MONTH or MONTHLY_FROM_ACTIVATION.
- **Arbitrary fees:** allowed per product.
- **Deleting a fee:** `DELETE /api/deposit-products/:id/fees/:feeId` works for a fee never applied. A fee that has been applied is deactivated instead.

### Overdraft interest

- **Rate terms:** FIXED with a range, TIERED_BALANCE by the amount overdrawn, or INDEX plus spread (never below zero).
- **Calculation:** its own day count, and a balance basis of END_OF_DAY or MINIMUM_DAILY.
- **Per account:** the rate or spread is set with `PUT /overdraft`, within the product's range.
- **Product rate changes:** a change to the product's overdraft rate reaches new accounts only, as in the reference platform. Existing accounts keep their rate.
- **Technical overdrafts:** can be turned off only while the product has no accounts.

### Managing products

- `DELETE /api/deposit-products/:id` (DELETE_SAVINGS_PRODUCT) deletes a product that never had accounts.
- **Permissions:** the reference platform's MAKE_EARLY_WITHDRAWALS, ACTIVATE_MATURITY, UNDO_MATURITY, POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS and DELETE_SAVINGS_PRODUCT. The catalogue is now 172 codes.
- **Grants:** tenant migration 036 and platform migration 011 gave:
  - ACTIVATE_MATURITY to holders of MAKE_DEPOSIT;
  - the other three account codes to holders of EDIT_SAVINGS_ACCOUNT;
  - deleting a product only to administrators.

### Console

- The deposit product form has the new settings.
- A "Type and limits" card on the product page, with delete buttons for the product and for fees.
- A "Terms" card on the deposit account page, with start and undo maturity, change the interest rate, and the maximum balance.

## Found on the way

- A direct insert of an overdraft or funding product would have broken the new checks. The type-derivation trigger keeps such writers working.

## Tests

- New suite `test/deposit-products.test.js`, 75 checks.
- The console test gains 2 checks.
- The loan-structure test was not affected: `accountNumbers.js` stays below `loans.js`.
- 39 suites, 2,702 checks, pass under both UTC and Africa/Nairobi.

## Not built

- Currencies per product: the ledger is single-currency.
- Offset accounts: a change to the loan interest engine.
- Profit-sharing products.
- Solidarity groups as deposit holders.
- The account initial state and approval, which belong to the Deposit Accounts section.
- The reference platform's category-to-type matrix: the pages refer to it but do not give it.
