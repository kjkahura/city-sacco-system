-- Write-offs, completed: what was written off is kept on the loan, money
-- recovered afterwards is posted to it (from the member, a called guarantor's
-- deposits, the sale of collateral or anyone else), and the principal is
-- written off against the loan loss allowance before the expense.

INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('400-400', 'Recoveries on Written-off Loans', 'INCOME', 'INCOME')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS gl_recoveries text NOT NULL DEFAULT '400-400' REFERENCES gl_accounts(code);

ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS written_off_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (written_off_amount >= 0),
  ADD COLUMN IF NOT EXISTS written_off_on date,
  ADD COLUMN IF NOT EXISTS written_off_by text,
  ADD COLUMN IF NOT EXISTS recovered numeric(18,2) NOT NULL DEFAULT 0 CHECK (recovered >= 0);
ALTER TABLE loan_accounts ADD CONSTRAINT loan_recovered_within_written_off
  CHECK (recovered <= written_off_amount);

-- Loans written off before this migration: what they owed when they closed.
UPDATE loan_accounts SET
  written_off_amount = GREATEST(0, principal_disbursed + principal_capitalized - principal_paid
    + interest_accrued - interest_paid + fees_due - fees_paid + penalty_accrued - penalty_paid),
  written_off_on = closed_on
WHERE status = 'CLOSED_WRITTEN_OFF' AND written_off_on IS NULL;

-- A called guarantor's pledge stays committed until it is recovered or the
-- call is released: RECOVERED once the whole pledge has been taken.
ALTER TABLE loan_guarantors
  ADD COLUMN IF NOT EXISTS recovered numeric(18,2) NOT NULL DEFAULT 0 CHECK (recovered >= 0);
ALTER TABLE loan_guarantors DROP CONSTRAINT IF EXISTS loan_guarantors_status_check;
ALTER TABLE loan_guarantors ADD CONSTRAINT loan_guarantors_status_check
  CHECK (status IN ('PLEDGED', 'RELEASED', 'CALLED', 'RECOVERED'));
ALTER TABLE loan_guarantors ADD CONSTRAINT guarantor_recovered_within_pledge
  CHECK (recovered <= pledged_amount);

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
    'SHARE_PURCHASE', 'SHARE_TRANSFER', 'DIVIDEND_PAYOUT', 'REVERSAL'));
