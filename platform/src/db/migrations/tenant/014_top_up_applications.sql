-- Top-ups (refinance) go through the application life cycle.
--
-- A top-up is a new loan application that settles a running loan when it is
-- disbursed: it is approved like any other (eligibility, cover, limits), and
-- the old loan keeps running until the payout. The application records
-- which loan it settles, what happens to the interest, fees and penalties
-- owed on it, and the top-up the member asked for.

ALTER TABLE loan_accounts ADD COLUMN IF NOT EXISTS refinance_of uuid REFERENCES loan_accounts(id);
ALTER TABLE loan_accounts ADD COLUMN IF NOT EXISTS refinance_arrears text
  CHECK (refinance_arrears IN ('CAPITALIZE', 'WRITE_OFF'));
ALTER TABLE loan_accounts ADD COLUMN IF NOT EXISTS top_up_requested numeric(18,2)
  CHECK (top_up_requested IS NULL OR top_up_requested > 0);

-- Both are set together or not at all.
ALTER TABLE loan_accounts ADD CONSTRAINT loan_refinance_complete
  CHECK ((refinance_of IS NULL) = (refinance_arrears IS NULL));

-- One top-up in flight per running loan.
CREATE UNIQUE INDEX IF NOT EXISTS loan_one_open_top_up ON loan_accounts (refinance_of)
  WHERE refinance_of IS NOT NULL AND status IN ('PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED');
