# Build log: Deposits > Working with Deposit Accounts

Built on 29 September 2026, following `audit-working-with-deposit-accounts.md` (committed in 35e048e). John said "build it", so the audit's defaults were taken. The commit is on main, on the device, not pushed. John pushes with `git push origin main`.

## Decisions (the audit's defaults)

1. **Card authorization holds:** left out until there is a card processor to connect to. Transaction holds cover cheques and other pending payments now.
2. **Backdated transfers:** allowed with BACKDATE_SAVINGS_TRANSACTIONS and priced again like deposits. The reference platform refuses them; refusing would break API clients that send a past value date today.
3. **How far back:** to the day after the last interest application, so applied interest is never reposted.
4. **Future value dates:** refused for staff.
5. **Inter-client transfers:** MAKE_INTER_CLIENTS_TRANSFERS is given to every role and user holding MAKE_TRANSFER.
6. **Fees beyond the balance:** the account stays ACTIVE, as decided in 5be771e.
7. **Interest precision:** six decimals, as now.
8. **Withholding tax per account:** built, with the product's source as the default.
9. **Pending blocks and holds** keep an account open: it is not closed, written off, withdrawn, rejected or deleted while one is pending.

## Built

### Balances

The balance endpoint gives the reference platform's balances under `balances`:

- total;
- available (the balance and what the overdraft lends, less holds, blocks, the pledged amount and the product minimum);
- the available overdraft;
- holds;
- locked (the platform's pledged amount);
- blocked;
- the overdraft amount due;
- credits on their way.

The top-level `available` now takes blocks and holds off too.

### Blocked funds and seizures (`savings_blocks`, tenant migration 039)

- `POST`, `GET` and `DELETE /api/savings/:id/blocks` (BLOCK_AND_SEIZE_FUNDS, administrators by default).
- **Block rules:**
  - a block may exceed the balance;
  - it is allowed on ACTIVE, IN_ARREARS, LOCKED and DORMANT accounts;
  - deposits still come in, and interest accrues on the whole balance.
- **Seizures:** `POST /api/savings/:id/seizure-transactions` seizes all or part of a pending block, no more than the balance.
  - The money leaves through a channel (bank by default) as a SAVINGS_SEIZURE, a new transaction kind.
  - The block is SEIZED once nothing is left.
  - Reversing a seizure gives the block back what it held.

### Transaction holds (`savings_holds`)

- `POST`, `GET` and `DELETE /api/savings/:id/authorizationholds` (CREATE_HOLDS, VIEW_HOLDS, DELETE_HOLDS).
- **Types:**
  - a debit (DBIT) hold is no larger than what is available, and makes it unavailable;
  - a credit (CRDT) hold is money on its way.
- **Reference:** unique in the tenant, at most 32 characters.
- **Settling:** a withdrawal or deposit naming `holdExternalReferenceId`, for exactly the amount held and with no value date (UPDATE_HOLDS). The hold is SETTLED with the transaction's id.
- **Reversing:** makes it REVERSED. Holds do not expire.

### Value dates and interest priced again

- **Staff dating rules:**
  - no future value dates;
  - a past date needs BACKDATE_SAVINGS_TRANSACTIONS;
  - no date before the day after the last interest application.
- **Repricing (deposits, withdrawals, transfers, from any caller):**
  - the recorded daily balances (and the day's minimum and average) move from the value date to the last day accrued;
  - the interest on those days is priced again and the change booked;
  - the movement counts from the start of its day;
  - under the MINIMUM period basis the next accrual prices the period again itself.
- **Backdated withdrawals:** refused when they would take a past day below what the account may owe.
- **Code:** the accrual's per-day pricing moved into `dayInterest`, and its booking into `bookAccrued`, so the accrual and the repricing share one calculation.

### Inter-client transfers

- A transfer to another holder's account, or a repayment of another holder's loan from a deposit account, needs MAKE_INTER_CLIENTS_TRANSFERS.
- Transfers carry custom fields.

### Bulk deposits and bulk reversals

- `POST /api/savings/deposit-transactions:bulk`: up to 1,000 deposits, each posted on its own savepoint under the same checks (limits, channels, custom fields).
  - The outcome is kept in `bulk_processes` under a process key.
  - `GET /api/bulks/:key` lists what went through and what did not.
- `POST /api/savings/transactions/reversals` (BULK_DEPOSIT_CORRECTIONS) reverses several transactions, each on its own.

### Reversals

- **Newly reversible:**
  - interest applied, the latest application only: it goes back to accrued (and booked), its withholding tax is reversed with it, and the last application date moves back;
  - withholding tax on its own;
  - seizures.
- **Repricing:** a deposit, withdrawal, transfer, fee or seizure reversed after the last interest application has the interest from its date priced again.
- **Refused:**
  - a reversal on a closed account (the reference platform);
  - one that would overdraw an account without a technical overdraft. This now gets a clear error instead of the database floor error.

### The account's own limits and withholding tax

- **Limits:** `maxWithdrawalAmount` (within the product's; the lower applies) and `recommendedDepositAmount`, at opening or with `PATCH`.
- **Changing the source:** `POST /api/savings/:id:changeWithholdingTax` takes a WITHHOLDING rate source from today, or null to go back to the product's.
  - The change is kept in `savings_withholding_changes` (`GET /:id/withholdingtaxes`).
  - Interest applied is taxed at the source's rate in force that day.
  - The product must have a taxes payable account when it is linked to the ledger.

### Permissions

- Eight the reference platform codes: BACKDATE_SAVINGS_TRANSACTIONS, MAKE_INTER_CLIENTS_TRANSFERS, BULK_DEPOSIT_CORRECTIONS, BLOCK_AND_SEIZE_FUNDS, and the Holds group (VIEW_HOLDS, CREATE_HOLDS, UPDATE_HOLDS, DELETE_HOLDS). The catalogue is now 186 codes.
- **Grants (tenant migration 039, platform migration 013):**
  - backdating to holders of MAKE_DEPOSIT, MAKE_WITHDRAWAL or MAKE_TRANSFER;
  - inter-client transfers to holders of MAKE_TRANSFER;
  - bulk corrections to holders of APPLY_SAVINGS_ADJUSTMENTS;
  - VIEW_HOLDS to holders of VIEW_SAVINGS_ACCOUNT_DETAILS;
  - the other hold codes to holders of EDIT_SAVINGS_ACCOUNT;
  - BLOCK_AND_SEIZE_FUNDS to nobody, so only administrators hold it.

### Console

- The deposit account page shows blocked, held and incoming amounts, and has a "Blocks and holds" card to block, unblock and seize funds and to hold and reverse holds.
- The teller's posting form takes a value date for users who may backdate.

## Known limits

- **A backdated movement counts from the start of its day.** the reference platform places it by time within the day. The difference shows only under the daily minimum and average balance bases.
- **Today's figures after a backdated deposit:** the day's opening balance does not include it.
- **The reference platform reposts applied interest when a movement is dated before it.** The platform refuses such dates for staff instead.
- **Card authorization holds, and a separate technical overdraft for card "advice" transactions,** wait for a card processor.

## Tests

- New suite `test/deposit-transactions.test.js`, 64 checks.
- The console test gains 1 check.
- 41 suites, 2,861 checks, pass under both UTC and Africa/Nairobi.

## Not built

- **Card authorization holds and card transactions:** there is no card processor to connect to.
- **Ten-decimal interest storage:** it would change the cents on running accounts.
- **Putting an account In Arrears when a fee takes it beyond its limit:** it stays ACTIVE, as decided in 5be771e.
