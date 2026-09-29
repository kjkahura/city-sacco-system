# Audit: Accounting against the reference platform (setup docs and APIs)

Audited on 29 September 2026, at commit 931cacc. John accepted the defaults below with "build it"; `build-log-accounting.md` records the build.

## Reference pages read

- Accounting Setup
- Creating your Chart of Accounts
- Cash vs Accruals Accounting
- Linking Products to Accounting
- Inter-Branch Transfer GL Account (with Accounting in Multicurrency)
- Journal Entries
- Accounting Closures
- Accounting Reports

The reference platform's API reference pages (GL accounts, journal entries, accounting reports, interest accrual, accounting rates) did not load here. The API findings below use the endpoint and field names of the reference platform's published API v2 as I know them, not a page read in this audit.

## What the platform has

- **Chart of accounts (`gl_accounts`):**
  - code (text, such as `100-200`), name, type (ASSET, LIABILITY, EQUITY, INCOME, EXPENSE), usage (HEADER or DETAIL), parent code, active flag, notes, and a regulatory class for the returns;
  - accounts come from provisioning, migrations and the data import only;
  - `GET /api/accounting/gl` lists them with balances.
- **Journal:**
  - entries and lines, append-only;
  - a deferred trigger makes every entry balance, and each branch balances through the inter-branch rules;
  - reversal writes the mirror entry;
  - `GET /api/accounting/journal` lists lines (from, to, GL code, branch, paging), with a JOURNAL_ENTRIES custom view;
  - every posting comes from a transaction or a process; there is no manual journal entry.
- **Cash and accrual accounting:**
  - NONE, CASH or ACCRUAL per product;
  - accrued interest reaches the ledger DAILY or MONTHLY, per account or aggregated per product and branch, for loans and deposits;
  - the breakdown behind an aggregated entry is `GET /api/accounting/accruals/:entryId`.
- **Linking products:**
  - loans have the reference platform's fourteen financial resources, deposits its twelve, and transaction channels their GL account;
  - a header account cannot be mapped;
  - the accounting method of a product in use changes through its own action.
- **Branches:**
  - inter-branch rules (a default and branch pairs), `PUT /api/accounting/inter-branch-rules`;
  - moving an account moves its balances.
- **Closures:**
  - per branch or organization-wide, in the past, in order;
  - deleted (kept on record) to backdate;
  - automatic every N days;
  - enforced by triggers on journal lines and transactions.
- **Other:** the accounting cutoff time, and the year-end close with the statutory reserve.
- **Reports:**
  - trial balance, balance sheet (as at a date, or a month) and income statement, by branch, from a daily rollup;
  - `GET /api/accounting/verify` recomputes the rollup;
  - `POST /api/accounting/reports` and `GET /api/accounting/reports/:reportKey` are the reference platform's asynchronous API.
- **Currencies:** a register with exchange and accounting rates (`POST /api/currencies/:code/accounting-rates`). The ledger is single-currency.
- **Permissions in the catalogue:** MANAGE_ACCOUNTS, LOG_JOURNAL_ENTRIES, VIEW_ACCOUNTING_REPORTS, MAKE_ACCOUNTING_CLOSURE, APPLY_ACCOUNTING_ADJUSTMENTS, MANAGE_INTERBRANCH_GLACCOUNT_RULES, CREATE_ACCOUNTING_RATES. MANAGE_ACCOUNTS and LOG_JOURNAL_ENTRIES guard only the accounting settings and posting pending accruals today.

## Findings

### 1. Chart of accounts

**The reference platform:**

- name, GL code, type, usage (Header or Detail), description;
- currency (with multicurrency), "Allow Manual Journal Entries" (detail accounts), and "Ignore Trailing Zeros in Reports Calculations" (header accounts);
- the hierarchy follows the GL code's digits: a header sums every account whose code starts with its own;
- the name, description and code can be edited, and the change applies to every transaction; the type and usage cannot;
- only an account never used (no product link, no manual entry) can be deleted;
- existing charts are migrated with the Excel template.

**Platform:**

- the fields, with the hierarchy by parent code rather than by digits;
- no manual-entries flag and no trailing-zeros setting;
- no API or console page to create, edit, deactivate or delete an account. Only the import and migrations add them.

**Gap:** the chart cannot be managed.

### 2. Manual journal entries

**The reference platform:**

- a user posts balanced debits and credits to GL accounts, on a booking date (backdating allowed), for a branch or none;
- notes are mandatory;
- one transaction ID covers the entry;
- up to five files can be attached;
- only manual entries are reversed, with notes; an automatic entry is corrected by reversing its transaction;
- entries across branches carry their own inter-branch lines.

**Platform:** none. The posting and reversal code exists (`accounting.post`, `accounting.reverse`) but no route uses it for a person's entry.

**Gap.** This is the largest one: payroll, depreciation, bank charges and corrections cannot be booked.

### 3. Journal listing and search (API)

**The reference platform:** `GET /gljournalentries` (from, to, branch, GL account, paging) and `POST /gljournalentries:search` (filter and sorting criteria). Each entry has:

- `encodedKey`, `entryId`, `transactionId`;
- `type` (DEBIT or CREDIT), `amount`, `glAccount`, `bookingDate`, `creationDate`;
- `productKey`, `productType`, `accountKey`, `assignedBranchKey`, `userKey` and `reversalEntryKey`.

**Platform:** the journal list in its own shape. Lines carry the member and branch but not the product or account they came from (that is on the transaction).

**Gap:** the reference platform's shape and search.

### 4. GL accounts (API)

**The reference platform:**

- `GET /glaccounts` by type, `POST /glaccounts` (one or several);
- `GET /glaccounts/{id}` with the balance for a date range;
- `PUT` and `PATCH`.

**Platform:** `GET /api/accounting/gl` only.

**Gap.**

### 5. Cash and accrual accounting

**The reference platform:**

- daily or monthly posting of accrued interest;
- a monthly posting reverses the month's earlier entries and logs the new amount;
- aggregated, or per account for loans.

**Platform:**

- daily or monthly, per account or aggregated, for loans and deposits;
- each run books the change since the last one instead of reversing and relogging. The totals are the same; the journal holds fewer entries.

**No gap in substance.**

### 6. Linking products to accounting

**The reference platform:** the same financial resources, which must be set before the product is saved.

**Platform:** the same resources, with a check at save.

**No gap.**

### 7. Inter-branch transfer GL account

**The reference platform:**

- a default rule over all branches (an asset account in the base currency, needed even before branches are used), and rules per branch pair;
- per currency under multicurrency.

**Platform:**

- a default rule and pairs;
- a posting between branches with no rule is refused;
- no per-currency rules, since the ledger is single-currency.

**No gap** beyond currencies.

### 8. Accounting closures

**The reference platform:**

- per branch or organization, in the past, in order;
- deleted to backdate;
- automatic every N days;
- the description can be edited.

**Platform:** all of it, except editing a closure's notes.

**Small gap.**

### 9. Accounting reports

**The reference platform:**

- balance sheet (a month, or cumulative to a date), profit and loss, and trial balance (opening, debits, credits, closing);
- by branch, with zero balances optional;
- profit and loss and the trial balance span at most 366 days;
- read from daily summaries;
- an asynchronous API.

**Platform:** all of it, with no 366-day limit.

**No gap.** The limit is not needed: the rollup keeps long ranges fast.

### 10. Accounting rates and multicurrency

**The reference platform:**

- accounting rates per currency, used by transaction date, and at the start of the day for manual entries and the end of day;
- GL accounts and journal entries in foreign currencies, with the foreign amount on the entry;
- `POST /currencies/{code}/accountingRates`.

**Platform:** the rates are kept, but no account or entry is in another currency, and the path is spelled `accounting-rates`.

**Gap:** a multi-currency ledger (conflicts with the single-currency ledger), and the path's spelling.

### 11. The interest accrual breakdown (API)

**The reference platform:** a search over the interest accrual breakdown (`POST /accounting/interestaccrual:search`).

**Platform:** the breakdown of one entry, by entry id.

**Gap:** the search.

## Proposed build

1. **Chart of accounts:**
   - `GET /api/glaccounts` (`type`, `usage`, `activated`, paging) and `POST` (one or a list);
   - `GET /api/glaccounts/:code` with the balance for `from` and `to` (and a branch);
   - `PUT` and `PATCH`, and `DELETE` for an account never used.
   - New columns `allow_manual_entries` (detail accounts) and `description` (the existing `notes`).
   - Editing: name, description, active and the manual-entries flag at any time; the code only while the account is unused; the type and usage never.
   - Deleting: an account with no journal line, product mapping, channel, till, inter-branch rule or child account.
   - A header's balance is the sum of its children by parent code.
2. **Manual journal entries:** `POST /api/gljournalentries` in the reference platform's shape (`date`, `branchId`, `notes`, `transactionId`, `debits` and `credits` of `{ glAccount, amount, branchId }`), with LOG_JOURNAL_ENTRIES.
   - Detail accounts that allow manual entries only.
   - The entry balances.
   - Notes are required.
   - The date may be backdated to after the closure and inside an open year, and not in the future.
   - Kept with `source_type` MANUAL and the transaction ID.
3. **Reversing a manual entry:** `POST /api/gljournalentries/:entryId:reverse` with notes (LOG_JOURNAL_ENTRIES). An automatic entry is refused with the transaction to reverse instead.
4. **Attachments** on a manual entry, up to five, through the platform's attachments.
5. **Journal API:** `GET /api/gljournalentries` (from, to, branch, GL account, paging) and `POST /api/gljournalentries:search`.
   - Each line in the reference platform's shape: `entryId`, `transactionId`, `type`, `amount`, `glAccount`, `bookingDate`, `creationDate`, `branch`, `userKey`, `reversalEntryKey`, and `productKey`, `productType` and `accountKey` from the transaction behind the entry.
6. **Closures:** `PATCH /api/accounting/closures/:id` for the notes.
7. **Interest accrual breakdown search:** `POST /api/accounting/interestaccrual:search` (from, to, product, account, branch).
8. **Accounting rates:** `/api/currencies/:code/accountingRates` as well as `accounting-rates`.
9. **Console:**
   - a Chart of Accounts page (the tree with balances, create, edit, deactivate, delete);
   - a Journal Entries page (list, post a manual entry, reverse, attach files).
10. **Permissions:**
    - MANAGE_ACCOUNTS for the chart;
    - LOG_JOURNAL_ENTRIES to post and reverse manual entries;
    - VIEW_ACCOUNTING_REPORTS to read accounts and entries.

## Decisions (my default in brackets)

1. **The hierarchy:** keep the parent code rather than the reference platform's digit prefix, since the platform's codes carry hyphens (`100-200`) and the returns map by parent? [Keep the parent code; the reference platform's trailing-zeros setting does not apply]
2. **Changing a GL code:** the reference platform lets a used code change everywhere. Here the code is the key that products, channels, tills, rules and every journal line point at. [Only while the account is unused; a used account keeps its code]
3. **Manual entries on control accounts:** the reference platform leaves the flag to each account. A manual entry on a portfolio or savings control account puts the ledger out of step with the accounts. [Allow manual entries on every existing detail account except the accounts products map as Portfolio Control, Savings Control and Overdraft Portfolio Control, which start with manual entries off]
4. **An entry across branches:** the reference platform makes the user add the inter-branch lines. The platform squares branches through the inter-branch rules for every other posting. [Square it through the rules, as other postings are; the entry shows the lines added]
5. **Reversal permission:** the reference platform's pages do not name one. [LOG_JOURNAL_ENTRIES]
6. **The 366-day report limit:** leave it out? [Leave it out]
7. **Accrual journal shape:** keep booking the change rather than reversing and relogging each month? [Keep]
8. **Left out:** the multi-currency ledger (it conflicts with the single-currency ledger and is a section of its own), and accounting rules as configuration files? [Leave them out]
