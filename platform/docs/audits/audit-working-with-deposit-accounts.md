# Audit: Deposits > Working with Deposit Accounts against the reference platform

Audited on 29 September 2026 and committed in 6bb1bb1. John said "build it", so the defaults below were taken; see `build-log-working-with-deposit-accounts.md`.

## Reference pages read

- Creating a Deposit Account
- Deposit Account Life Cycle and States
- Deposit Account Overview Details
- Deposits, Withdrawals and Transfers
- Adjusting Transactions
- Managing Fees in Deposit Accounts
- Blocking Funds in Deposit Accounts
- Transaction Holds
- Card Transactions and Authorization Holds
- Technical Overdraft
- Truncating and Rounding Interest (deposits)
- Maximum Deposit Account Balance

## Scope

The day-to-day use of a deposit account: opening it, what its balances mean, money in and out (including backdating and bulk posting), correcting transactions, fees, and the ways funds are held back from the holder (blocks, seizures, transaction holds, card authorization holds).

## Already built

- **Creating an account:** `POST /api/savings`, with the product, branch, the account's own name, rates, overdraft limit, maximum balance, term and custom fields.
- **Life cycle and states:** built in 50a462b.
- **Maximum balance:** built in 08b1ce6.
- **Deposits, withdrawals and transfers:** transfers go between deposit accounts and to loans, and deposits and withdrawals carry custom fields.
- **Maturity:** withdrawals during a term need MAKE_EARLY_WITHDRAWALS.
- **Monthly, manual and arbitrary fees:** built, with fee reversal.
- **Locked balance:** the platform's pledged amount does this job. Guarantor pledges and funding pledged to approved loans are taken off the available balance.

## Findings

### 1. Creating an account

- **Per-account withdrawal and deposit amounts:** the reference platform sets a maximum withdrawal amount per transaction and a recommended deposit amount on the account. The platform has them on the product only.
- **Withholding tax per account:** the reference platform picks a withholding tax source per account. It changes it with `POST /deposits/{id}:changeWithholdingTax` and keeps a history (`GET /deposits/{id}/withholdingtaxes`). The platform has the source and percentage on the product only.

### 2. The account's balances (Overview Details)

The reference platform shows seven balances:

| The reference platform balance | Platform |
|---|---|
| Total | `balance` |
| Available (total + available overdraft − holds − blocked − locked) | `available`, without holds or blocks |
| Available overdraft limit | `overdraftLimit` less what is overdrawn, not shown as its own figure |
| Holds | none |
| Locked (a guarantee for loans) | `pledged` |
| Blocked (an ongoing investigation) | none |
| Overdraft amount due | `overdrawn` |

### 3. Blocking and seizing funds

- **Effect:** a block stops the holder withdrawing or transferring an amount. Deposits still come in, and interest accrues on the total balance.
- **Size:** a block may be larger than the available balance.
- **States:** a block is Pending until it is seized or unblocked. It may be set on Active, Active in Arrears, Locked and Dormant accounts.
- **Seizure:** takes blocked funds as a transaction ("Seized Amount"), in part if needed, for debt collection over time.
- **API:** `POST`, `GET` and `DELETE /deposits/{id}/blocks`, and `POST /deposits/{id}/seizure-transactions`.
- **Permission:** BLOCK_AND_SEIZE_FUNDS.
- **Platform:** none. A SACCO needs this for court orders and garnishee notices.

### 4. Transaction holds

- **What they are:** a debit (DBIT) or credit (CRDT) authorization for SEPA payments, cheques and multicurrency settlements. The amount is unavailable until the hold is settled or reversed.
- **Reference:** each hold has an `externalReferenceId`, unique, at most 32 characters.
- **Limits and expiry:** a debit hold may not exceed the available balance. Holds on deposit accounts never expire.
- **Settling:** a withdrawal (debit) or deposit (credit) that names `holdExternalReferenceId`, for exactly the held amount, with no value date.
- **Reversing:** `DELETE /deposits/{id}/authorizationholds/{ref}`.
- **Permissions:** CREATE_HOLDS, VIEW_HOLDS, UPDATE_HOLDS and DELETE_HOLDS.
- **Platform:** none. Cheque clearing is the use a SACCO has.

### 5. Card authorization holds

- **Needs:** a card processor integration: card token references, dual-message and single-message flows, and `createCardTransaction` for clearing.
- **Adjusting:** a hold may be increased or decreased.
- **Expiry:** 7 days by default (1 to 36,525), with MCC-specific periods and an expiry job.
- **Advice:** "advice" transactions bypass the balance check and may create a technical overdraft.
- **Platform:** no cards and no card processor. This conflicts with nothing, but it has nothing to connect to.

### 6. Deposits, withdrawals and transfers

- **Backdating:**
  - **The reference platform:** reverses the later transactions, posts the backdated one, reposts the rest, and reprices interest. Transfers cannot be backdated.
  - **Platform:** takes any value date after the last accounting closure (past or future, transfers included) and books the journal on it. It does not reprice the interest already accrued or applied, and there is no BACKDATE_SAVINGS_TRANSACTIONS permission.
- **Inter-client transfers:**
  - **The reference platform:** splits MAKE_TRANSFER (between a holder's own accounts) from MAKE_INTER_CLIENTS_TRANSFERS (to another holder).
  - **Platform:** MAKE_TRANSFER moves money to any member's account.
- **Bulk deposits:**
  - **The reference platform:** `POST /deposits/deposit-transactions:bulk` takes many deposits and processes each one separately. `GET /bulks/{processKey}` reports which went through.
  - **Platform:** posts one deposit at a time. The data import loads opening balances, not transactions.
- **Custom fields on transfers:** the reference platform lets transfers carry custom fields. The platform applies them to deposits and withdrawals only.

### 7. Adjusting (reversing) transactions

- **Adjustable types in the reference platform:** every financial transaction, including interest applied, withholding tax and write-off. The later transactions are reposted and interest is recalculated.
- **Rules:** the account must be open. A reversal whose repost would take the balance below zero is refused. Bulk corrections need BULK_DEPOSIT_CORRECTIONS.
- **Platform:**
  - reverses deposits, withdrawals, transfers and fees only;
  - does not recalculate interest;
  - does not check that the account is open;
  - undoes a write-off only through Undo Write Off.

### 8. Fees on an overdrawn account

- **The reference platform:** with overdrafts enabled, a fee may be applied beyond the balance and the account goes In Arrears. Fees beyond what is available become "Fees Due".
- **Platform:**
  - a fee may use the authorised overdraft, and beyond it only under a technical overdraft;
  - the account stays ACTIVE, which was the default taken in 50a462b;
  - under cash accounting, fees on the overdrawn part are already kept as `od_fees_due`.

### 9. Technical overdraft

- **The reference platform:** only card "advice" transactions create a technical overdraft, on current accounts. It is repaid first when money comes in.
- **Platform:** fees and interest create one where the product allows it. This is a different use of the same name. It conflicts with nothing, but the README should say so.

### 10. Rounding interest

- **The reference platform:** calculates accruals to 20 decimals and stores them truncated to 10. It aggregates per product and rounds to the currency when posting.
- **Platform:** stores six decimals and carries the remainder. Moving to ten decimals would change the cents on running accounts.

## Proposed build

1. **Blocks and seizures:** a `savings_blocks` table (amount, reference, reason, state PENDING, SEIZED or UNBLOCKED, seized so far).
   - `POST`, `GET` and `DELETE /api/savings/:id/blocks`, and `POST /api/savings/:id/seizure-transactions` (SAVINGS_SEIZURE, in part or in full, against a block).
   - The blocked balance comes off the available balance, and interest still accrues on the total.
   - Allowed on ACTIVE, IN_ARREARS, LOCKED and DORMANT accounts. BLOCK_AND_SEIZE_FUNDS.
2. **Transaction holds:** a `savings_holds` table (DBIT or CRDT, external reference, amount, state PENDING, SETTLED or REVERSED).
   - `POST /api/savings/:id/authorizationholds` and `DELETE /api/savings/:id/authorizationholds/:ref`.
   - Settled by a deposit or withdrawal that names `holdExternalReferenceId`.
   - Debit holds come off the available balance. They never expire.
   - CREATE_HOLDS, VIEW_HOLDS, UPDATE_HOLDS and DELETE_HOLDS.
3. **Balances:** the balance endpoint gives the reference platform's seven balances: total, available, available overdraft, holds, locked (the pledged amount), blocked, and overdraft amount due.
4. **Backdating:**
   - BACKDATE_SAVINGS_TRANSACTIONS for a value date before today, and no future value dates;
   - a backdated deposit or withdrawal reprices interest from its value date, back no further than the day after the last interest application;
   - the daily balances from that day are corrected, and what accrued is booked again.
5. **Inter-client transfers:** MAKE_INTER_CLIENTS_TRANSFERS for a transfer to another holder's account, given to every role that holds MAKE_TRANSFER so nothing changes for them.
6. **Bulk deposits:** `POST /api/savings/deposit-transactions:bulk` posts each deposit in its own savepoint and records the outcome under a process key. `GET /api/bulks/:processKey` reads it.
7. **Adjustments:**
   - reverse interest applied (with its withholding tax) and withholding tax on its own;
   - reprice interest when a deposit or withdrawal in the current interest period is reversed;
   - refuse any reversal on a closed account;
   - BULK_DEPOSIT_CORRECTIONS for reversing several at once.
8. **Account-level limits:** a maximum withdrawal amount and a recommended deposit amount per account, within the product's (the account's own tighter one wins).
9. **Custom fields on transfers.**
10. **Console:** the seven balances, a Blocks card (block, unblock, seize), holds, and the backdate field where the user holds the permission.

## Decisions (my default in brackets)

1. **Card authorization holds:** leave them out until there is a card processor to connect to? Transaction holds cover cheques now, and card holds can use the same table later. [Leave out]
2. **Backdated transfers:** the reference platform refuses them. Refusing would break API clients that send a past value date today. [Allow with BACKDATE_SAVINGS_TRANSACTIONS and reprice, like deposits; record this as a departure from the reference platform]
3. **How far back:** only to the day after the last interest application, so applied interest is never reposted? The reference platform reverses and reposts applied interest too. [Yes: after the last application]
4. **Future value dates:** refuse them? No platform flow uses one; postdated loan payments have their own route. [Refuse]
5. **Inter-client transfers:** give MAKE_INTER_CLIENTS_TRANSFERS to every role and user holding MAKE_TRANSFER? [Yes]
6. **Fees beyond the balance:** keep the account ACTIVE, as decided in 50a462b, rather than putting it In Arrears as the reference platform does? [Keep ACTIVE]
7. **Interest precision:** keep six decimals rather than the reference platform's ten? [Keep six]
8. **Withholding tax per account** (`:changeWithholdingTax` and its history): build it here? [Yes, with the product's source as the default]
9. **Blocks on a closing member:** refuse closing an account or exiting a member while a block is pending? [Yes]
