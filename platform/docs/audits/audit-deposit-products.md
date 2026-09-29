# Audit: Deposits > Deposit Products against the reference platform

Audited on 29 September 2026, at commit 7b74ec4.

## Reference pages read

- Deposit Products Configuration
- Setting Up New Deposit Products
- Managing Deposit Products
- Maximum Deposit Account Balance
- Interest Calculation Methods in Deposit Accounts
- Changing the Interest Rate
- Deposit Fees Setup
- Overdraft Products
- Technical Overdraft
- Setting Up Deposit Products with Profit Sharing
- Linking Products to Accounting (deposit rules)
- Permissions (deposit accounts and deposit products)

## Scope

The deposit product and the rules it gives its accounts: types, identification, availability, new account numbering, interest, limits, term and maturity, dormancy, fees, overdrafts, accounting, editing and deleting.

The deposit account life cycle (approval, the initial state, locking, reopening, blocking funds, authorization holds) belongs to the next section, Deposit Accounts. Only the parts a product setting drives are here: maturity and dormancy.

## What the platform has

**Products** (`savings_products`, `/api/deposit-products`):

- **Identification:** ID (2 to 16 capitals, digits or underscores), name, description, active or inactive.
- **Interest:**
  - one annual rate, applied to every account;
  - the balance used: END_OF_DAY, or MINIMUM (the lowest balance in the interest period, which is not the reference platform's daily minimum);
  - the day count: ACTUAL_365, ACTUAL_360 or THIRTY_360;
  - how often it is applied: MONTHLY, QUARTERLY, SEMI_ANNUAL or ANNUAL, on the calendar period's last day;
  - whether it is paid into the account, a minimum balance to earn it, negative rates, and withholding tax (a percentage or a rate source).
- **Overdrafts:** allowed, a maximum limit and a rate; the account has its own limit, rate and (since 7b74ec4) expiry date. Technical overdrafts can be allowed.
- **Fees:** MANUAL and MONTHLY (charged on the last day of the month), flat amounts. Any amount can also be charged by hand.
- **Accounting:** NONE, CASH or ACCRUAL, with DAILY or MONTHLY accrual, per account or aggregated, and the reference platform's twelve GL rules.
- **Other:** branch availability, individuals and groups, custom fields, the credit arrangement requirement, and the funding account flag.
- **Frozen once accounts exist:** the funding flag, the balance used and the day count.
- **Deleting:** products cannot be deleted.

**Accounts:** states PENDING, ACTIVE, DORMANT, LOCKED and CLOSED. Accounts open straight to ACTIVE, and nothing sets PENDING, DORMANT or LOCKED. Deposit account numbers are SA000001 onwards for every product.

## Findings

### 1. Product types

**The reference platform:**

| Type | Rules |
|---|---|
| Current Account | Savings with overdrafts. The only type with overdrafts and technical overdrafts. |
| Savings Account | Deposits and withdrawals at will. No overdrafts. |
| Fixed Deposit | A fixed term. Deposits until the opening balance is reached. Maturity is then started, after which no deposits are taken. No withdrawals during the term without Make Early Withdrawals. |
| Savings Plan | As a fixed deposit, but deposits are taken during the term; none after maturity. |
| Investor (Funding) Account | Peer-to-peer funding; deprecated in the reference platform. |

There is also a product category (Stored Value, Daily Banking, Personal Deposits, Business Banking, Business Deposits, Uncategorized), which is a label.

**Platform:** no type or category. Any product may have overdrafts. There is no term or maturity.

**Gap.** Existing products can be given a type without conflict: a product with overdrafts (or technical overdrafts) becomes a Current Account, a funding product an Investor Account, and the rest Savings Accounts.

### 2. New account numbers

**The reference platform:** each product numbers its accounts, either from a random pattern or from an incremental number (digits only, starting where the product says).

**Platform:** one series for every product (SA000001, from the counter built in f6e92de).

**Gap.** A product that sets nothing keeps the shared series.

### 3. Interest

**The reference platform:**

- **Rate terms:**
  - Fixed, with a default, a minimum and a maximum; each account may have its own rate between them.
  - Index: a rate source plus a spread, with a default, a minimum and a maximum.
  - Tiered per balance: the whole balance earns the rate of the tier it falls in.
  - Tiered per band: each portion of the balance earns its band's rate.
  - Tiered per period: the rate of the tier matching the account's age.
- **Rate given per:** year, month, 4 weeks, week, or X days.
- **Balance used:** minimum daily, average daily, or end of day. End of day may be capped by a maximum balance.
- **Days in year:** Actual/365 Fixed, Actual/360, 30E/360 and Actual/Actual ISDA.
- **Posting:**
  - the first day of every month or every day;
  - every week, every other week, month, three months, six months or year, counted from the activation date (month-end dates clamp);
  - up to 12 fixed dates;
  - on maturity, for fixed deposits and savings plans (their default).
- **Other settings:** collect interest when locked; accrue interest after maturity.
- **Changing the rate on a product:** the change applies to all existing and new accounts, or to new accounts only. The reference platform recalculates accruals from the last application.
- **Changing the rate on an account:** `POST /deposits/{id}:changeInterestRate`, for fixed rates only. It may be backdated but not post-dated, and accruals are recalculated from the value date.

**Platform:** one fixed rate per product and no rate per account. The balance and day count options are listed above. There are no tiers, index rates, rate periods, maximum balance, posting options beyond the calendar ones, rate changes, or the locked and maturity settings.

**Gap.** Existing products keep their meaning: the rate is per year, the posting options stay as they are, and MINIMUM keeps its period-minimum meaning alongside the reference platform's daily minimum.

### 4. Deposits and withdrawals

**The reference platform:**

- a recommended deposit amount (fixed deposits and savings plans; a guideline only);
- a maximum withdrawal amount for one transaction;
- an opening balance (minimum, maximum, default);
- a maximum deposit balance on the account, checked on deposits, transfers in and loan disbursements into the account, with the error MAXIMUM_DEPOSIT_BALANCE_EXCEEDED.

**Platform:** none of these.

**Gap.**

### 5. Term length and maturity

**The reference platform:** fixed deposits and savings plans have a term length (default, minimum, maximum, in days, weeks or months). The account's maturity is started once the opening balance is reached (ACTIVATE_MATURITY) and can be undone before the maturity date (UNDO_MATURITY). At the maturity date the account is matured.

**Platform:** none.

**Gap.**

### 6. Dormancy

**The reference platform:** for every type without a maturity date, a number of days after which an account with "no financial activity on that account other than posting of interest" becomes dormant. Funds can still be claimed. Posting on a dormant account needs POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS.

**Platform:** a DORMANT state that nothing sets. Deposits and withdrawals on it are refused.

**Gap.**

### 7. Fees

**The reference platform:**

- manual fees with a fixed amount;
- monthly fees, applied monthly from activation or on the first day of every month;
- arbitrary fees, allowed per product (the reference platform advises against them);
- a fee is deleted only if never applied, and a deactivated fee is no longer applied.

**Platform:** manual and monthly fees (the last day of the month). Arbitrary amounts are always allowed. Fees cannot be deleted.

**Gap.** Existing monthly fees keep the last-day rule. Arbitrary fees stay allowed unless a product turns them off.

### 8. Overdrafts

**The reference platform:**

- overdrafts and technical overdrafts on current accounts only;
- the overdraft rate is fixed (default, minimum, maximum), tiered per balance, or index plus spread;
- its own day count and balance used (minimum daily or end of day);
- technical overdrafts can be turned off only while the product has no accounts;
- on an account, the fixed rate or the index spread can be changed (Adjust Overdraft Terms).

**Platform:**

- overdrafts on any product, with one fixed rate and no range;
- the product's day count is shared with credit interest;
- the account rate is set only by an import;
- technical overdrafts can be turned off at any time.

**Gap.** Existing overdraft products become Current Accounts (finding 1), so nothing existing is refused.

### 9. Managing products

**The reference platform:**

- some fields lock once a product is in use;
- a product is deactivated (its accounts stay active) or, if it never had accounts, deleted (DELETE_SAVINGS_PRODUCT);
- activating needs the GL accounts when accounting is on.

**Platform:** deactivation; three settings frozen; no deleting.

**Gap:**

- delete an unused product;
- freeze the type, the numbering type, the term unit, and technical overdrafts being turned off, once accounts exist.

### 10. Accounting

**The reference platform:** twelve rules, and Daily or Monthly accrual under accrual accounting.

**Platform:** the same twelve rules, and accrual per account or aggregated.

**No gap.**

### 11. Beyond this build

- **Currencies per product:** the ledger and every product are in the organization's currency, and loans are the same. This needs a multi-currency ledger, which is a section of its own.
- **Offset accounts:** a deposit balance reduces a dynamic-term loan's interest. This is a change to the loan interest engine and belongs with loan products.
- **Profit sharing (Shari'ah) products:** a separate product family, base currency only.
- **Solidarity groups as deposit holders:** the reference platform lists them in availability. The platform opens solidarity loans only.
- **The account initial state and approval:** these belong to the Deposit Accounts section.
- **The category-to-type matrix:** the reference platform refers to it but the pages do not give it. The category is kept as a label.

## Proposed build

1. **Product type and category**, with the mapping in finding 1. Overdrafts and technical overdrafts are for current accounts only. The type is frozen once accounts exist.
2. **Account numbers per product:** RANDOM_PATTERN (# a digit, @ a letter, $ either) or INCREMENTAL_NUMBER from a starting number. Unset keeps the shared SA series.
3. **Interest:**
   - Rate terms FIXED (default, minimum, maximum; a rate per account), INDEX (source, spread range), TIERED_BALANCE, TIERED_BANDS and TIERED_PERIOD.
   - The rate given per year, month, 4 weeks, week or X days.
   - The balance used adds MINIMUM_DAILY and AVERAGE_DAILY, built from the day's balance movements; END_OF_DAY takes a maximum balance.
   - The day count adds ACTUAL_ACTUAL_ISDA.
   - Posting adds DAILY, FIRST_DAY_OF_MONTH, WEEKLY, EVERY_OTHER_WEEK, the four from-activation options, FIXED_DATES and ON_MATURITY.
   - Collect interest when locked, and accrue after maturity.
   - Product rate changes to all or new accounts only.
   - `POST /api/savings/:id:changeInterestRate`.
4. **Limits:** a recommended deposit, a maximum withdrawal, an opening balance (minimum, maximum, default), and a maximum balance per account.
5. **Term and maturity:**
   - the term on fixed deposits and savings plans;
   - `POST /api/savings/:id/maturity` (ACTIVATE_MATURITY) and `DELETE` to undo it (UNDO_MATURITY);
   - the MATURED state at the end of day;
   - deposit and withdrawal rules by type;
   - MAKE_EARLY_WITHDRAWALS.
6. **Dormancy:** days per product, applied at the end of day. POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS for deposits and withdrawals on a dormant account, which return it to ACTIVE.
7. **Fees:** the monthly apply method, arbitrary fees per product, and deleting a fee never applied.
8. **Overdrafts:**
   - the rate: FIXED with a range, TIERED_BALANCE, or INDEX plus spread;
   - its own day count and balance used;
   - the rate or spread per account through `PUT /overdraft`;
   - technical overdrafts turned off only without accounts.
9. **Deleting an unused product** (DELETE_SAVINGS_PRODUCT), and the extra frozen settings.
10. **Console:** the deposit product form and page with the new settings; the deposit account page with maturity, the interest rate and the limits.

## Decisions (my default in brackets)

1. **Types for existing products:** map as in finding 1? [Yes]
2. **MINIMUM:** keep the platform's period minimum as it is, and add the reference platform's daily minimum and daily average beside it? [Yes, so running products do not change]
3. **A product rate change:** applied from the next day, not recalculated back to the last application as the reference platform does? [From the next day: nothing already accrued moves. An account-level change may still be backdated to after the last application, as the reference platform allows]
4. **Dormancy:** count every transaction except interest postings and fees charged by the end of day, and return a dormant account to ACTIVE on a deposit or withdrawal? [Yes]
5. **Arbitrary fees:** allowed on every product, new ones included, until the tenant turns them off? The reference platform starts them off, but API clients charge them today. [Yes: allowed by default]
6. **Beyond this build:** currencies, offset accounts, profit sharing, solidarity group holders and the account initial state, as in finding 11? [Leave them out]
