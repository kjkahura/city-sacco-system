# Audit: overdraft terms and the deposits API against the reference platform

Audited on 29 September 2026, at commit 7882265. John asked whether overdraft terms and APIs on deposits were built, then said "Yes" to auditing and building the gaps found, so the defaults below were taken.

## Reference pages read

- Overdraft Products
- Adjusting Overdraft Terms
- Interest Rate Management Enhancements
- Deposit accounts (API v2): the reference pages did not load their content, so the field names below come from the reference platform's published DepositAccount model as used in its API, not from a page read here.

## What the platform had

- **Product settings:** overdrafts on current accounts with a maximum limit, technical overdrafts, a fixed, tiered or index rate with a spread range, the overdraft's own days in year and balance, and the accounting rules.
- **Account terms:** the limit, rate and spread at opening; `PUT /api/savings/:id/overdraft` for the limit, expiry date, rate and spread; write-off.
- **Behaviour:** the expiry and In Arrears; overdraft interest accrued, applied and repaid first.
- **API:** `/api/savings`, with the platform's own shapes and field names.

## Findings

1. **No reference-shaped deposits API:**
   - The reference platform's `/deposits` has the account object with `overdraftSettings` (`allowOverdraft`, `overdraftLimit`, `overdraftExpiryDate`), `overdraftInterestSettings.interestRateSettings`, `interestSettings`, `internalControls`, `balances` and `accruedAmounts`;
   - it has list, `:search`, create, read, `PUT`, JSON Patch and delete;
   - it has the colon actions, and the transaction, block and hold endpoints.
   - The platform had the same rules at `/api/savings` in other shapes.
2. **The expiry date at opening:** the reference platform takes it with the new account's overdraft settings. The platform set it only afterwards.
3. **An index rate's review frequency:** the reference platform reviews an index rate at a set frequency (Interest Rate Review Frequency). The platform took the index rate in force each day.
4. **30E/360:** the reference platform lists it.
   - The platform's THIRTY_360 is the ISDA form of 30E/360: 31sts count as the 30th, and so does the last day of February.
   - Nothing was missing, but the name did not say which rule it was.

## Proposed build

1. **`/api/deposits`,** a layer over the deposit domain, so the two APIs work on the same accounts under the same rules and permissions.
   - The account object, with the reference platform's state and type names.
   - `GET` (filters and paging), `POST /deposits:search`, `POST`, `GET /:id`, `PUT` and `PATCH` (JSON Patch on nested paths), and `DELETE`.
   - The colon actions: `:changeState`, `:changeInterestRate`, `:changeWithholdingTax`, `:startMaturity`, `:undoMaturity` and `:applyInterest`.
   - Transactions, blocks, holds and bulk deposits.
2. **`overdraftExpiryDate` at opening,** in both APIs.
3. **Review frequency:** `interestReviewCount` and `interestReviewUnit` (DAYS, WEEKS or MONTHS) for an INDEX credit rate, and the same pair for an INDEX overdraft rate, counted from the account's activation. Unset keeps the daily rate.
4. **30E/360:** show THIRTY_360 as the reference platform's `E30_360` in `/api/deposits`, and document the ISDA end-of-February rule.

## Decisions (my default in brackets)

1. **PUT:** apply only the fields that changed, each through the rule that governs it, and refuse changes to fields that cannot change (the holder, product, type, ID and state)? [Yes; the state changes through `:changeState`]
2. **Credit rate changes through PUT or PATCH:** before activation only, as Editing Accounts says. After activation `:changeInterestRate` is the way? [Yes]
3. **Reads:** under the account's row lock, as `/api/savings/:id/balance` reads? [Yes]
4. **The review anchor:** the account's activation date, or its opening date where it opened ACTIVE? [Yes]
5. **30E/360:** keep the ISDA end-of-February rule, which running products already use? [Keep]
