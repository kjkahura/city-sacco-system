-- Closing and exiting a loan account, after the reference platform's pages of that name:
-- locks that suspend only some activities, penalties after an unlock,
-- deleting a loan created by mistake, undoing a closure, collecting
-- securities before a write-off, pay-off permissions, and a loan name.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_kind_check CHECK (kind IN (
    'SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER',
    'SAVINGS_FEE', 'SAVINGS_INTEREST_ACCRUAL', 'SAVINGS_INTEREST_APPLIED', 'SAVINGS_WITHHOLDING_TAX',
    'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED', 'OVERDRAFT_WRITE_OFF', 'ACCOUNT_BRANCH_CHANGE',
    'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'LOAN_FEE', 'LOAN_FEE_WAIVED',
    'LOAN_INTEREST_ACCRUAL', 'LOAN_INTEREST_CAPITALIZED', 'LOAN_WRITE_OFF', 'LOAN_RECOVERY',
    'LOAN_RESCHEDULE', 'LOAN_REFINANCE',
    'LOAN_FUNDED', 'LOAN_REPAID_TO_FUNDER', 'CREDIT_BALANCE_DEPOSIT',
    'SHARE_PURCHASE', 'SHARE_TRANSFER', 'DIVIDEND_PAYOUT', 'REVERSAL',
    'LOAN_BALANCE_WRITE_OFF', 'LOAN_FEE_ADJUSTED', 'LOAN_PENALTY_ADJUSTED',
    'LOAN_RATE_CHANGED', 'LOAN_TERMINATED',
    -- Non-financial: a lock, a change to what it suspends, an unlock, and
    -- a closure undone, listed with the loan's transactions as the reference platform does.
    'LOAN_LOCKED', 'LOAN_LOCK_CHANGED', 'LOAN_UNLOCKED', 'LOAN_CLOSURE_UNDONE'));

ALTER TABLE loan_accounts
  -- What a lock suspends (the reference platform's Lock Account dialog). Read only while the
  -- loan is LOCKED; a lock sets all three unless told otherwise.
  ADD COLUMN IF NOT EXISTS lock_interest boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS lock_fees boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS lock_penalties boolean NOT NULL DEFAULT true,
  -- Penalties on the outstanding principal accrued while locked, applied on
  -- the first installment due date after the unlock (the reference platform).
  ADD COLUMN IF NOT EXISTS penalty_deferred numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS penalty_deferred_until date,
  -- What a closure released (guarantors, collateral), so an undo restores it.
  ADD COLUMN IF NOT EXISTS closure jsonb,
  -- A name for the account, editable in any state (the reference platform).
  ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE lending_controls
  -- The reference platform's permissions, as role lists. NULL: any role the action's route
  -- already allows.
  ADD COLUMN IF NOT EXISTS pay_off_roles text[],
  ADD COLUMN IF NOT EXISTS loan_adjustment_roles text[],
  ADD COLUMN IF NOT EXISTS collect_securities_roles text[];

ALTER TABLE loan_write_off_requests
  -- Take the guaranteed amounts from the guarantors' deposit accounts as a
  -- repayment before the rest is written off.
  ADD COLUMN IF NOT EXISTS collect_securities boolean NOT NULL DEFAULT false;
