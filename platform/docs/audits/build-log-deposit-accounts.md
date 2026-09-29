# Build log: Deposits > Deposit Accounts, offset loans, and the credit arrangement search and schedule

Built on 29 September 2026, following `audit-deposit-accounts.md`. After the Deposit Products commit (08b1ce6), John asked for whatever was not yet built to be built if it did not conflict with what is deployed, so the audit's defaults were taken. The commit is on main, on the device, not pushed. John pushes with `git push origin main`.

## Decisions (the audit's defaults)

1. **Initial state:** ACTIVE by default, so products and scripts that open accounts today behave as before.
2. **Closed accounts:** one CLOSED state, with `closed_as` (REJECTED, WITHDRAWN or WRITTEN_OFF) recording how. Every query that tests for CLOSED keeps working, and the API gives the reference platform's account state beside it.
3. **In Arrears:** only for an overdraft past its expiry date and a limit lowered below the balance. An account taken below zero by a fee or interest under a technical overdraft stays ACTIVE, as before.
4. **The overdraft write-off route:** unchanged; the account stays open. Close > Write Off is the new action.
5. **Undoing a write-off:** only a write-off recorded from this build, which keeps what it cleared.
6. **Grants:** holders of EDIT_SAVINGS_ACCOUNT get APPROVE_SAVINGS, LOCK and UNLOCK. Holders of CLOSE_SAVINGS_ACCOUNTS get REOPEN and the write-off undo. Deleting is left to administrators.
7. **Offset:** the linked (settlement) deposit account is the offset account, as in the reference platform. The settlement option may be NONE.
8. **Left out:** currencies per product, profit sharing, solidarity group holders and the category matrix.

## Built

### Deposit account life cycle (`src/domain/savings.js`, tenant migration 037)

- **Initial state:** `initialState` per deposit product: ACTIVE, PENDING_APPROVAL or APPROVED.
  - An approved account becomes ACTIVE with its first transaction and earns from that day, not from the day it was opened.
  - A loan disbursement into an approved account activates it too.
- **States:** PENDING_APPROVAL, APPROVED, ACTIVE, IN_ARREARS, DORMANT, LOCKED, MATURED and CLOSED. The old PENDING, which nothing wrote, maps to PENDING_APPROVAL.
- **`POST /api/savings/:id:changeState`** (also `/:id/state`), with `action` and `notes`. Each action checks its own permission:
  - APPROVE and UNDO_APPROVE (APPROVE_SAVINGS).
  - UNDO_ACTIVATE (APPROVE_SAVINGS): only for an account its first transaction activated, once no transaction stands on it.
  - CLOSE_REJECT and CLOSE_WITHDRAW (CLOSE_SAVINGS_ACCOUNTS).
  - LOCK (LOCK_SAVINGS_ACCOUNT) from ACTIVE, IN_ARREARS or DORMANT, and UNLOCK (UNLOCK_SAVINGS_ACCOUNT) back to the state it was locked in.
  - CLOSE, the existing close.
  - CLOSE_WRITE_OFF and UNDO_CLOSE_WRITE_OFF.
  - REOPEN (REOPEN_SAVINGS_ACCOUNT): current and savings accounts closed plainly, back to ACTIVE and earning from today.
- **Locked accounts:** no deposits, withdrawals, transfers or fees, and they are not closed.
- **Dormant accounts:** no interest accrues (credit or overdraft), though the days are recorded. No monthly fee is charged and no interest is applied until the account is active again.
- **In Arrears:**
  - an account overdrawn past its overdraft expiry date, when the expiry is set or by the end of day;
  - an account whose limit was lowered below what it owes;
  - a deposit that brings the balance back within what the overdraft lends makes it ACTIVE again;
  - an account in arrears counts as open for its holder, and in the sums that counted its negative balance before.
- **Close > Write Off:**
  - writes off what is overdrawn and closes the account as CLOSED (WRITTEN_OFF);
  - needs credit interest accrued applied first, and no running loan settled from the account;
  - the write-off transaction now records what it cleared (the charges owed, the overdraft interest, the limit and the state before).
- **Undo Write Off** (REVERSE_SAVINGS_ACCOUNT_WRITE_OFF): reverses the entry, puts the balances and limit back, and returns the account to its state before.
- **Delete** (`DELETE /api/savings/:id`, DELETE_SAVINGS_ACCOUNT): an account nothing was ever posted to, and that no loan, funding pledge, dividend or credit arrangement points at.
- **Balance endpoint** fields: `accountState` (the reference platform's), `closedAs`, `approvedOn`, `activatedOn`, `lockedOn`, `stateBeforeLock`, `inArrearsSince` and `closedOn`.

### Offset loans

- **Loan product `offsetEnabled`:** a DYNAMIC_TERM product, REDUCING_EQUAL_INSTALLMENTS, SIMPLE interest on PRINCIPAL_AND_INTEREST.
  - It turns linking on. The shape is checked by the API and by a database constraint.
  - It is frozen once the product has loans.
- **Deposit product `allowOffset`:** kept on while its accounts offset running loans.
- **Linking:** through `PUT /api/loans/:id/settlement-account`. An account whose product does not allow offset is refused.
- **Disbursement:** refused without the link, with `MISSING_LINKED_OFFSET_ACCOUNT`.
- **Interest:** on the principal and interest balance less the offset account's balance, never below zero. The accrual records the offset balance it used.
- **Reversals:** a reversal on an offset account is refused while the loan runs.

### Credit arrangements

- `POST /api/creditarrangements:search`: filter and sorting criteria on the arrangement's fields and custom fields, with paging headers.
- `GET /api/creditarrangements/:id/schedule`: the instalments of its loans that are not closed, by due date. Each has principal, interest and fees expected, paid and due, and the reference platform's instalment state (OVERDUE is LATE).

### Permissions

- The reference platform's DELETE_SAVINGS_ACCOUNT, APPROVE_SAVINGS, LOCK_SAVINGS_ACCOUNT, UNLOCK_SAVINGS_ACCOUNT, REOPEN_SAVINGS_ACCOUNT and REVERSE_SAVINGS_ACCOUNT_WRITE_OFF. The catalogue is now 178 codes.
- Tenant migration 037 and platform migration 012 grant them as in decision 6. The manager defaults hold all but deleting.
- `POST /savings/:id` in the permission table now lets in any of the state permissions. `:changeInterestRate` checks EDIT_SAVINGS_ACCOUNT itself.

### Console

- A "State" card on the deposit account page, with the actions the account and the user may take, and Delete for an account without transactions.
- The deposit product form and page have the initial state and offset.
- The loan product form has offset.

## Found on the way

- Changing a deposit product's accounting method in use skipped MATURED accounts (from the Deposit Products build). It now includes them, and accounts in arrears.

## Known limits

- **MINIMUM balance basis and dormancy:** under the MINIMUM (period) balance basis, when a dormant account becomes active again in the same interest period, the period is priced again over all its days, the dormant ones included.
- **Backdated movements on an offset account:** the reference platform recalculates the loan's interest. Here the offset balance is the one the accrual finds.
- **Overdraft interest on a locked account:** it still accrues. The product's "collect interest when locked" setting covers credit interest, as before.

## Tests

- New suite `test/deposit-accounts.test.js`, 83 checks.
- The console test gains 2 checks.
- 40 suites, 2,787 checks, pass under both UTC and Africa/Nairobi.

## Not built

- **Currencies per product:** conflicts with the single-currency ledger. It needs a multi-currency ledger first.
- **Profit sharing products:** a section of its own. It does not conflict, but it waits for John's go-ahead.
- **Solidarity groups as deposit holders:** the reference platform does not define what holding means.
- **The category-to-type matrix:** the reference platform refers to it but does not give it.
- **BACKDATE_SAVINGS_TRANSACTIONS:** not in scope.
