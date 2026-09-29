# Build log: Accounting (the chart of accounts, journal entries and the reference platform's accounting API)

Built on 29 September 2026, following `audit-accounting.md` and its eight decision defaults, which John accepted with "build it". The commit is on main, on the device, not pushed. John pushes with `git push origin main`.

## Built

### Tenant migration 041

- **`gl_accounts.allow_manual_entries`** (the reference platform's Allow Manual Journal Entries):
  - on for every existing detail account;
  - off on header accounts, and on the accounts products map as Portfolio Control (`loan_products.gl_portfolio`), Savings Control (`savings_products.gl_liability`) and Overdraft Portfolio Control (`savings_products.gl_od_portfolio`);
  - provisioning sets the same for a new tenant's seeded products.
- **`gl_accounts.created_at`**, unknown (NULL) for older accounts.
- **`journal_entries.transaction_id`:**
  - unique, and shared by the lines of a manual entry;
  - generated from `manual_journal_entry_seq` as `MJ-000001` when not given.
- **`journal_entry_attachments`**, the files on a manual entry.
- **`accounting_closures.updated_by` and `updated_at`**, for editing notes.

No permission codes were added. MANAGE_ACCOUNTS, LOG_JOURNAL_ENTRIES and VIEW_ACCOUNTING_REPORTS were already in the catalogue.

### GL accounts: `/api/glaccounts` (`src/domain/chartOfAccounts.js`)

- **The account object:**
  - `encodedKey` and `glCode` (the code), `name`, `type`, `usage`, `description` (the existing `notes`);
  - `activated`, `allowManualJournalEntries`, `parentGlCode`, `regulatoryClass`;
  - `currency.code` (the base currency), `creationDate`, `lastModifiedDate` and `balance`.
- **Balances:**
  - in each account's own sign: assets and expenses read debit minus credit, the rest credit minus debit;
  - a header's balance is the sum of every account under it, at any depth, by parent code (decision 1);
  - for `from` and `to`, the whole book or one branch (`branchId`, `NONE` for lines with no branch).
- **Endpoints:**
  - `GET /api/glaccounts` (`type`, `usage`, `activated`, `from`, `to`, `branchId`, paging headers) and `GET /:code`, with VIEW_ACCOUNTING_REPORTS;
  - `POST` (one account or a list, created in order), `PUT /:code`, `PATCH /:code` (JSON Patch) and `DELETE /:code`, with MANAGE_ACCOUNTS.
- **Rules:**
  - A parent must be a header of the same type. An account is not put under itself.
  - A header takes no manual entries.
  - The name, description, parent, regulatory class, the active flag and the manual-entries flag change at any time.
  - The GL code changes only while nothing uses the account (decision 2). The type and usage never change (`FIELDS_NOT_EDITABLE`).
  - An account something maps stays active (`GL_ACCOUNT_IS_MAPPED`). The mappings are products, channels, tills, rules, settings and column defaults.
  - An account is deleted only while nothing uses it (`GL_ACCOUNT_IN_USE`, naming the uses).
  - A new account is in the base currency; another currency is refused, as the ledger holds one.
- **Where an account is used,** read from the database catalog:
  - every text column that points at `gl_accounts` by foreign key, or is named `gl_*` or `*_gl`;
  - child accounts, and column defaults that name the code;
  - the three accounts the platform posts to by code: 200-200, 300-200 and 500-330.
- **Branch access:** changing the chart needs a user with every branch (`ALL_BRANCH_ACCESS_REQUIRED`). A user limited to some branches reads balances for one of their branches (`lib/ledgerScope`).

### Journal entries: `/api/gljournalentries` (`src/domain/journalEntries.js`)

- **The line object** (the reference platform's GLJournalEntry):
  - `encodedKey` and `entryId` (the line), `journalEntryId` (the entry), `transactionId`;
  - `type` (DEBIT or CREDIT), `amount`, `glAccount`, `bookingDate`, `creationDate`;
  - `assignedBranchKey` and `branchId`, `userKey`, `reversalEntryKey` and `reversalOf`, `sourceType` and `notes`;
  - for an automatic entry, `productType`, `productKey`, `accountKey` and `accountId` from the transaction behind it, and its reference as `transactionId`.
- **Reading:**
  - `GET /api/gljournalentries` (`from`, `to`, `branchId`, `glAccountId`, `transactionId`, paging headers);
  - `POST /api/gljournalentries:search` (filter and sorting criteria on the fields above);
  - `GET /:ref`: one entry with its lines, found by its id, its transaction ID or a line's `entryId`;
  - a user limited to some branches reads the lines of their branches.
- **Manual entries** (`POST /api/gljournalentries`, LOG_JOURNAL_ENTRIES):
  - the body is `date`, `branchId`, `notes`, `transactionId`, and `debits` and `credits` of `{ glAccount, amount, branchId }`;
  - notes are required;
  - each account is an active detail account that allows manual entries;
  - amounts are above zero with at most two decimals, and the entry balances;
  - the date is today or earlier, after the closure covering each branch, and not in a closed financial year (`FINANCIAL_YEAR_CLOSED`);
  - a line in another branch is squared through the inter-branch rules, and the lines added come back with the entry (decision 4);
  - a user limited to some branches posts only to them, and never to no branch;
  - the entry is kept with source type MANUAL and written to the audit log.
- **Reversal** (`POST /:ref:reverse`, LOG_JOURNAL_ENTRIES per decision 5):
  - it takes notes and optionally a date; the default is the entry's own date;
  - the reversal carries the transaction ID `<id>-REV`;
  - an entry is reversed once, and a reversal is not reversed;
  - an automatic entry is refused with `AUTOMATIC_JOURNAL_ENTRY`, naming the transaction to reverse instead.
- **Files** (`/:ref/attachments`):
  - up to five on a manual entry, under the loan attachment rules;
  - sent as JSON with the file in base64, or as the raw body;
  - listed, downloaded and previewed.

### Closures, accruals and rates

- **Closures:** `PATCH /api/accounting/closures/:id` edits a closure's notes, with MAKE_ACCOUNTING_CLOSURE. The date and scope are refused; delete the closure and close again to move them.
- **Accrual breakdown search:** `POST /api/accounting/interestaccrual:search` searches the breakdown behind the accrual entries.
  - Each accrual line shows twice, once as its debit and once as its credit.
  - Each row carries the GL account, product, account, branch, and the entry that posted it (`parentEntryId`, empty while waiting to be posted).
  - A user limited to some branches reads their branches.
- **Accounting rates:** `POST` and `GET /api/currencies/:code/accountingRates` are the reference platform's spelling of `accounting-rates`.

### Console

- **Chart of accounts page:**
  - the tree, with balances as at a date and a type filter;
  - add, edit, activate or deactivate, and delete an account;
  - a link to the account's journal lines.
- **Journal page:**
  - the lines, filtered by dates, GL code and manual entries, paged;
  - log an entry (lines typed as "GL code, amount[, branch]");
  - open an entry to reverse it and to attach and download files.

### Not changed (decisions 6, 7 and 8)

- There is no 366-day limit on reports.
- Accruals still book the change since the last run.
- The ledger holds one currency, and accounting rules are not kept as configuration files.
- `/api/accounting/gl` and `/api/accounting/journal` are unchanged.

## Known limits

- **Field names:** the reference platform's API reference pages did not load here, so the `/glaccounts`, `/gljournalentries` and `interestaccrual:search` field names follow the reference platform's published models from memory and were not checked one by one.
- **New mappings:** a product created later that maps a new control account does not turn that account's manual-entries flag off. The flag is set by hand.
- **Roles:** the built-in ACCOUNTANT role does not hold MANAGE_ACCOUNTS or LOG_JOURNAL_ENTRIES. Adding them would also give accountants the accounting settings and posting pending accruals. An administrator, or a custom role given those permissions, manages the chart and logs entries.
- **Files:** files on a journal entry are not edited or deleted. The entry is part of the ledger's record.

## Tests

- New suite `test/general-ledger.test.js`, 97 checks.
- `test/console.test.js` gained checks for the two pages.
- 43 suites, 3,005 checks, pass under both UTC and Africa/Nairobi.
