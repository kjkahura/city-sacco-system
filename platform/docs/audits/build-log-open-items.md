# Build log: open items from earlier sections

Built on 28 September 2026. The items were taken from the "Not built" lists of earlier build logs and kept only where they change nothing already deployed. The loan-engine items were audited instead of built: see `audit-loan-engine-open-items.md`. The commit is on main, on the device, not pushed. John pushes with `git push origin main`.

## Decisions

1. **Scope:** all seven items that bring no conflict:
   1. Deposit and share account numbers from a counter.
   2. Group indicators and a GROUPS custom view.
   3. The report card on the deposit account and branch pages.
   4. Importing groups and group loans.
   5. Member pictures and signatures.
   6. ID document expiry flags.
   7. Larger ID document files, uploaded as the raw body.
2. **General ledger for branch-limited users:** scoped at the report level, not with row security on journal lines. Users with every branch see no change.
3. **Loan-engine items:** lines of credit, solidarity group loans, and importing revolving, tranched, index-rate and adjustable-rate loans were audited, not built. Their decisions are open in the audit.

## Built

### Account numbers

- Tenant migration 034 adds `account_counters`, one row each for SAVINGS (prefix SA) and SHARES (prefix SH), started after the highest number already given.
- `src/domain/accountNumbers.js` locks the counter row while a number is given out and steps over a number already taken, checked across every branch by `account_no_taken`.
- Numbers keep the six-digit format and widen instead of being cut: SA999999 is followed by SA1000000.
- Numbers already given do not change.

### Group indicators and custom views

- New indicators: GROUPS, ACTIVE_GROUPS, GROUP_MEMBERS (members in groups), GROUP_BORROWERS (groups with running loans) and GROUP_LOAN_PORTFOLIO. They work for the organization, a branch, a centre or a credit officer, and do not apply to product scopes.
- The client indicators still count individual members only.
- Custom views and menu items take the entity GROUPS, with 17 fields (group ID, name, type, state, member count, contact details, branch, centre, credit officer, running loans, loan and deposit balances, dates) and custom fields of groups. It needs VIEW_GROUP_DETAILS.
- `GET /api/groups?viewfilter=` lists what a saved view matches, as the reference platform's API does.
- The members view gains `expiredIdDocuments`.

### Report card on the deposit and branch pages

- The console has a deposit account page (balance, transactions, close) and a branch page, each with the report templates for its entity (DEPOSIT, BRANCH).
- The deposit page opens from a row of the member's deposit accounts; the branch page from "open" on the organization's branch list.

### Importing groups and group loans

- The template has a Groups sheet: Group ID, name, type, branch, centre, credit officer, phones, email, address, notes and the custom fields of groups.
- The Members sheet has Group ID (comma-separated for more than one group) and Group role.
- Reference sheets Group Types and Group Role Names come before ID Templates.
- Checks in the file: duplicate group IDs, a group ID that is also a member number, and a role with no group.
- Checks when the import runs: an unknown group, a loan with client type G held by a member, and a loan with client type C held by a group.
- Groups are created through the same path as the console (`clients.create` with the GROUP holder type), and memberships through `setGroupMembers`, so the group size and membership controls apply.
- The review lists `groups` and `groupMembers` among what it will create.

### Pictures and signatures

- `PUT`, `GET` and `DELETE /api/members/:id/picture` and `/signature`. The file is the raw request body, checked by its first bytes: PNG, JPEG or GIF. Up to 50 MB.
- Editing needs EDIT_CLIENT. Groups have neither. An anonymized member's cannot be set, and anonymizing removes them.
- The member page shows both, with upload and remove.

### ID document files and expiry

- `GET` and `POST /api/members/:id/identifications/:docId/files`, and `GET` and `DELETE .../files/:fileId`.
- PNG, JPEG or PDF, checked by the first bytes, up to 50 MB each and five on one document (the reference platform's limits). The old single scan (limit 700 KB) stays, is listed as file `original` and counts as one of the five.
- The ID template's "allows attachments" setting is checked.
- Permissions: CREATE_DOCUMENTS, VIEW_DOCUMENTS and DELETE_DOCUMENTS.
- Each document carries `expired` and `expiresInDays` from its valid-until date, as of the organization's today. An expired document is flagged, never refused. The member's detail has `expiredIdDocuments`, and the console shows a badge and a notice.

### General ledger for branch-limited users

`src/lib/ledgerScope.js` runs after the permission check and applies only to users limited to some branches.

- **Organization-only, refused with ALL_BRANCH_ACCESS_REQUIRED:** the GL account list, ledger verification, prudential returns and limits, returns, provisioning and accounting periods.
- **Branch reports** (balance sheet, income statement, trial balance, accounting reports through the API):
  - With no branch given, a user with one branch gets that branch; a user with several gets BRANCH_REQUIRED.
  - Another branch, or entries with no branch (NONE), are refused with OUTSIDE_YOUR_BRANCH_ACCESS.
- **Journal:** lists the lines of the user's branches only.
- **A report job** created by another branch is not readable.

## Found on the way

- Two tests asserted that groups and group loans were refused in the import. They now assert that the refusals are gone.
- The template's sheet order and the review's create counts changed with the Groups sheet; the data-management test was updated.

## Tests

- New suite `test/open-items.test.js` with 49 checks, including ten deposit accounts opened at once and a 3 MB scan.
- The console test gains checks for the branch page, the picture and signature card and the deposit page.
- 37 suites, 2,546 checks, pass under both UTC and Africa/Nairobi.

## Not built

- Lines of credit, solidarity group loans, and importing revolving, tranched, index-rate and adjustable-rate loans. The audit is written; its five decisions wait for John.
- Indicators for lines of credit, which follow the credit arrangements build.
