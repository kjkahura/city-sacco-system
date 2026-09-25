-- Interest accrual keeps the fraction of a cent between runs, and loan
-- products say what happens to an installment that falls on a non-working
-- day, after Mambu's "Truncating and rounding interest" and "Installments on
-- Non-Working Days".

-- What the last accrual earned beyond the whole cents it posted. The next
-- run adds it before rounding, so daily accruals never drift from the
-- interest actually earned. Always under half a cent either way.
ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS interest_accrual_carry numeric(38,20) NOT NULL DEFAULT 0
    CHECK (abs(interest_accrual_carry) < 0.01);

--   DO_NOT_RESCHEDULE   the installment stays on the day
--   MOVE_FORWARD        to the next working day (what every product did)
--   MOVE_BACKWARD       to the previous working day
--   EXTEND_SCHEDULE     that installment and every later one move one
--                       repayment period on; the loan runs one period longer
ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS non_working_days text NOT NULL DEFAULT 'MOVE_FORWARD'
    CHECK (non_working_days IN ('DO_NOT_RESCHEDULE', 'MOVE_FORWARD', 'MOVE_BACKWARD', 'EXTEND_SCHEDULE'));
