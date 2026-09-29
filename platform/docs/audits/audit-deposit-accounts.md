# Audit: Deposits > Deposit Accounts against the reference platform, with the items left from earlier sections

Audited on 29 September 2026, at commit 485b3a0. John asked for everything not yet built to be built where it does not conflict with what is deployed, so this audit is short and its defaults were taken.

## Reference pages read

- Deposit Accounts Life Cycle and States
- Locking and Unlocking Deposit Accounts
- Reopening, Rejecting, Withdrawing and Deleting Deposit Accounts
- Closing and Writing Off Deposit Accounts
- Redraw Facility and Offset Loans
- Setting Up Deposit Products with Profit Sharing, and the profit sharing pages it links to
- Permissions (deposit accounts)

## Scope

- The deposit account life cycle.
- Offset accounts, left out of the Deposit Products build.
- The reference platform's credit arrangement search and schedule endpoints, left out of the lines of credit build.

## What the platform had

- **States:** an account opened ACTIVE. DORMANT and MATURED came from the Deposit Products build. LOCKED and PENDING were in the state list, but no route set them.
- **Closing:** `POST /api/savings/:id/close` closed an empty account.
- **Overdraft write-off:** `POST /api/savings/:id/overdraft/write-off` wrote off an overdraft and left the account open. It could not be undone.
- **Dormant accounts** still accrued interest and were charged monthly fees.
- **No In Arrears state:** an account overdrawn past its overdraft expiry date stayed ACTIVE.
- **Accounts could not be approved, rejected, withdrawn, locked, unlocked, reopened or deleted.**
- **Offset:** none.
- **Credit arrangements:** listed by holder and state, with no reference platform search and no schedule.

## Findings

### 1. The life cycle (the reference platform)

- **Initial state:** a product sets the state new accounts start in: Pending Approval or Approved.
- **Approval:** Approve moves a pending account to Approved, and Undo Approve moves it back.
- **Activation:** an approved account becomes Active with its first transaction. Undo Activate is allowed while the account has no transactions.
- **Reject and withdraw:** a pending account may be rejected (Closed Rejected) or withdrawn. An approved account may be withdrawn.
- **Lock:** from Active, In Arrears or Dormant. A locked account takes no transactions. Unlock returns it to the state it was locked in.
- **Dormant:** a dormant account accrues no interest and gets no automated transactions. One transaction returns it to Active.
- **In Arrears:** an account overdrawn after its overdraft expiry date, or one whose limit was lowered below what it owes. A deposit that covers it makes it Active again.
- **Write-off:** Close > Write Off settles the balances and closes the account as Closed (Written Off). Undo Write Off reopens it and reverts the transactions.
- **Reopen:** only current and savings accounts, back to Active.
- **Delete:** only an account no transaction was ever made on.
- **API:** `POST /deposits/{id}:changeState` with the actions APPROVE, UNDO_APPROVE, LOCK, UNLOCK, CLOSE, CLOSE_WITHDRAW, CLOSE_REJECT and CLOSE_WRITE_OFF.
- **Account states in the reference platform's API:** PENDING_APPROVAL, APPROVED, ACTIVE, ACTIVE_IN_ARREARS, MATURED, LOCKED, DORMANT, CLOSED, CLOSED_WRITTEN_OFF, WITHDRAWN and CLOSED_REJECTED.
- **Permissions:** APPROVE_SAVINGS, LOCK_SAVINGS_ACCOUNT, UNLOCK_SAVINGS_ACCOUNT, REOPEN_SAVINGS_ACCOUNT, REVERSE_SAVINGS_ACCOUNT_WRITE_OFF and DELETE_SAVINGS_ACCOUNT.

### 2. Offset loans (the reference platform)

- **Loan product:** a Dynamic Term loan, declining balance with equal instalments, simple interest calculated on principal and interest, with "Enable Offset".
- **Deposit product:** "Allow accounts to be used for Offset".
- **Link:** the offset account is the loan's linked deposit account, one per loan. The loan is not disbursed without it ("Missing linked offset account").
- **Interest:** interest is charged on (outstanding principal + interest balance − offset account balance) × the daily rate, and nothing when the offset covers the balance.
- **Reversals:** not supported on offset deposit accounts.
- **Deposit interest:** the offset account still earns its own interest.

### 3. Credit arrangements (the reference platform's API)

- `POST /creditarrangements:search`, with filter and sorting criteria.
- `GET /creditarrangements/{id}/schedule`: the instalments of the arrangement's loan accounts.

### 4. What conflicts, or is not defined

- **Currencies per product:** conflicts. The ledger is single-currency, so this needs a multi-currency ledger first.
- **Profit sharing:** a product family of its own, with about twenty pages. The reference platform marks parts of its approval and distribution as unavailable or automated. It does not conflict, but it is a section of its own.
- **Solidarity groups as deposit holders:** the reference platform lists them but does not say what holding means.
- **The category-to-type matrix:** the reference platform refers to it but does not give it.
- **BACKDATE_SAVINGS_TRANSACTIONS:** not in scope. Value dates are taken as before.

## Proposed build

1. **Initial state:** per product, ACTIVE (the default, as now), PENDING_APPROVAL or APPROVED.
2. **State actions:** the reference platform's changeState actions, and UNDO_ACTIVATE, UNDO_CLOSE_WRITE_OFF and REOPEN for its console actions.
   - `POST /api/savings/:id:changeState` and `POST /api/savings/:id/state`.
   - `DELETE /api/savings/:id` for an account nothing was ever posted to.
3. **Closed states:** a closed account keeps the CLOSED state and records how it was closed (REJECTED, WITHDRAWN or WRITTEN_OFF). The API gives the reference platform's account state beside it.
4. **In Arrears:** for an overdraft past its expiry date and for a limit lowered below the balance. A technical overdraft reached through a fee or interest stays ACTIVE, as now.
5. **Dormant accounts:** no interest and no monthly fees.
6. **Locked accounts:** no fees.
7. **Offset:** the loan product and deposit product settings, the check at linking and disbursement, the interest base, and the reversal refusal.
8. **Credit arrangements:** the search and the schedule.
9. **Permissions:** the six codes, given to roles holding the matching permission.
10. **Console:** the account's state card and actions, and the new product settings.

## Decisions (my default in brackets)

1. **Default initial state:** ACTIVE, so products and scripts that open accounts today behave as before? [Yes]
2. **Closed accounts:** one CLOSED state plus how it closed, rather than new states, so every query that tests for CLOSED keeps working? [Yes]
3. **In Arrears:** only for the two cases the reference platform names that involve an overdraft? An account taken below zero by a fee under a technical overdraft stays ACTIVE. [Yes]
4. **The overdraft write-off route:** keep it as it is (the account stays open), with Close > Write Off as the new action? [Yes]
5. **Undoing a write-off:** only one recorded from this build, which keeps what it cleared? [Yes]
6. **Grants:** APPROVE_SAVINGS, LOCK and UNLOCK to holders of EDIT_SAVINGS_ACCOUNT; REOPEN and the write-off undo to holders of CLOSE_SAVINGS_ACCOUNTS; deleting to administrators only? [Yes]
7. **Offset:** the linked (settlement) deposit account is the offset account, as in the reference platform, with the settlement option free to be NONE? [Yes]
8. **Left out:** currencies, profit sharing, solidarity group holders and the category matrix? [Leave them out; profit sharing waits for John's go-ahead as its own section]
