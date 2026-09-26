-- Working with loan accounts, after Mambu's pages of that name: the end of
-- day that skips a broken loan, pay-off and terminate, disbursement details
-- and disbursing into a deposit account, repayment rules and transfers from
-- deposit accounts, bulk collection, fee and penalty adjustments and
-- balance reductions, rate changes on running loans, payment holiday
-- options, revolving schedules with custom installments, loan history,
-- attachments, interest from arrears, and the rest of reschedule and
-- refinance.

-- --------------------------------------------------------------------------
-- New transaction kinds
-- --------------------------------------------------------------------------
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
    -- A write-off of part of a running loan's interest, fees or penalties
    -- (pay-off, reduce balance, a reschedule's written-off charges).
    'LOAN_BALANCE_WRITE_OFF',
    -- A fee or penalty taken back as if it had not been applied.
    'LOAN_FEE_ADJUSTED', 'LOAN_PENALTY_ADJUSTED',
    -- Non-financial: a rate change and a termination, kept with the
    -- transactions as Mambu shows them.
    'LOAN_RATE_CHANGED', 'LOAN_TERMINATED'));

-- --------------------------------------------------------------------------
-- End of day: loans left out after they broke a job
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_eod_exclusions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id        uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  job            text NOT NULL,
  business_date  date NOT NULL,
  error          text NOT NULL,
  error_code     text,
  excluded_at    timestamptz NOT NULL DEFAULT now(),
  included_at    timestamptz,
  included_by    text,
  catch_up       jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS loan_eod_excluded_once ON loan_eod_exclusions (loan_id) WHERE included_at IS NULL;

-- --------------------------------------------------------------------------
-- Loan accounts
-- --------------------------------------------------------------------------
ALTER TABLE loan_accounts
  -- Disbursement details kept on the application (Mambu's Disbursement
  -- Details): the anticipated disbursement date, the first repayment date,
  -- the channel or the member's deposit account the money will go to.
  ADD COLUMN IF NOT EXISTS expected_disbursement_date date,
  ADD COLUMN IF NOT EXISTS first_repayment_date date,
  ADD COLUMN IF NOT EXISTS disbursement_channel_id text REFERENCES transaction_channels(id),
  ADD COLUMN IF NOT EXISTS disbursement_savings_account_id uuid REFERENCES savings_accounts(id),
  -- Terminated: everything owed fell due on this date. The loan keeps its
  -- running state (repayments, arrears and penalties go on); the schedule
  -- it had is kept so the termination can be undone.
  ADD COLUMN IF NOT EXISTS terminated_on date,
  ADD COLUMN IF NOT EXISTS terminated_by text,
  ADD COLUMN IF NOT EXISTS termination jsonb,
  -- Interest of a payment holiday held off the schedule until applied.
  ADD COLUMN IF NOT EXISTS holiday_interest_pending numeric(18,2) NOT NULL DEFAULT 0,
  -- Interest from arrears: the part of the interest earned on principal
  -- that is overdue. It is a breakdown of interest_accrued, never added to it.
  ADD COLUMN IF NOT EXISTS interest_from_arrears_accrued numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_from_arrears_paid numeric(18,2) NOT NULL DEFAULT 0,
  -- The number this account had before a reschedule or refinance that kept
  -- the account number gave it to the new loan.
  ADD COLUMN IF NOT EXISTS previous_account_no text,
  -- A top-up application's settlement terms: the interest, fees and
  -- penalties to capitalise (the rest written off), whether late and
  -- payment-due fees move to the new loan, and whether it takes the
  -- running loan's account number.
  ADD COLUMN IF NOT EXISTS refinance_capitalize jsonb,
  ADD COLUMN IF NOT EXISTS refinance_carry_fees boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS keep_account_no boolean NOT NULL DEFAULT false;

ALTER TABLE loan_accounts DROP CONSTRAINT IF EXISTS loan_holiday_interest_pending_check;
ALTER TABLE loan_accounts ADD CONSTRAINT loan_holiday_interest_pending_check CHECK (holiday_interest_pending >= 0);

-- Every change to the disbursement details before disbursement.
CREATE TABLE IF NOT EXISTS loan_disbursement_detail_changes (
  id          bigserial PRIMARY KEY,
  loan_id     uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  before      jsonb NOT NULL,
  after       jsonb NOT NULL,
  changed_by  text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Products and controls
-- --------------------------------------------------------------------------
ALTER TABLE loan_products
  -- Mambu's "Allow Custom Repayment Allocation". On by default so products
  -- set up before this keep taking custom repayments.
  ADD COLUMN IF NOT EXISTS allow_custom_allocation boolean NOT NULL DEFAULT true;

ALTER TABLE lending_controls
  -- The roles that may post a custom repayment, and set or change the
  -- disbursement details of an application (Mambu's permissions). NULL:
  -- any role that may post repayments or edit applications.
  ADD COLUMN IF NOT EXISTS custom_allocation_roles text[],
  ADD COLUMN IF NOT EXISTS disbursement_conditions_roles text[];

-- --------------------------------------------------------------------------
-- Transfers between loans and deposit accounts
-- --------------------------------------------------------------------------
INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('290-210', 'Loan Transfer Clearing', 'LIABILITY', 'OTHER_LIABILITY')
ON CONFLICT (code) DO NOTHING;
INSERT INTO transaction_channels (id, name, channel_type, gl_account_code)
VALUES ('transfer', 'Deposit account transfer', 'INTERNAL', '290-210')
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- Bulk repayment collection
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_collection_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  text REFERENCES transaction_channels(id),
  value_date  date,
  reference   text,
  rows        int NOT NULL DEFAULT 0,
  posted      int NOT NULL DEFAULT 0,
  failed      int NOT NULL DEFAULT 0,
  amount      numeric(18,2) NOT NULL DEFAULT 0,
  results     jsonb NOT NULL DEFAULT '[]',
  posted_by   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Fees and penalties: adjusted, and balances reduced
-- --------------------------------------------------------------------------
ALTER TABLE loan_fees DROP CONSTRAINT IF EXISTS loan_fees_status_check;
ALTER TABLE loan_fees ADD CONSTRAINT loan_fees_status_check CHECK (status IN ('DUE', 'PAID', 'WAIVED', 'ADJUSTED'));
ALTER TABLE loan_fees
  -- What a balance reduction wrote off of this fee (its amount is lowered by it).
  ADD COLUMN IF NOT EXISTS written_off numeric(18,2) NOT NULL DEFAULT 0;

ALTER TABLE penalty_charges
  ADD COLUMN IF NOT EXISTS adjusted_at timestamptz,
  ADD COLUMN IF NOT EXISTS adjusted_by text;

-- Every write-off of part of a running loan's interest, fees or penalties.
CREATE TABLE IF NOT EXISTS loan_balance_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('PAY_OFF', 'REDUCE_BALANCE', 'RESCHEDULE', 'REFINANCE')),
  interest        numeric(18,2) NOT NULL DEFAULT 0,
  fees            numeric(18,2) NOT NULL DEFAULT 0,
  penalty         numeric(18,2) NOT NULL DEFAULT 0,
  principal       numeric(18,2) NOT NULL DEFAULT 0,
  value_date      date NOT NULL,
  reason          text,
  entry_id        uuid REFERENCES journal_entries(id),
  transaction_id  uuid REFERENCES transactions(id),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Payment holidays
-- --------------------------------------------------------------------------
ALTER TABLE loan_installments
  -- NO_PRINCIPAL_NO_INTEREST or PRINCIPAL_NO_INTEREST, on a holiday installment.
  ADD COLUMN IF NOT EXISTS holiday_kind text,
  -- What became of a holiday's interest: SPREAD over the installments after
  -- it, NONE (not charged), or APPLY_LATER (held until applied).
  ADD COLUMN IF NOT EXISTS holiday_interest text;
ALTER TABLE loan_installments DROP CONSTRAINT IF EXISTS loan_installments_holiday_kind_check;
ALTER TABLE loan_installments ADD CONSTRAINT loan_installments_holiday_kind_check
  CHECK (holiday_kind IS NULL OR holiday_kind IN ('NO_PRINCIPAL_NO_INTEREST', 'PRINCIPAL_NO_INTEREST'));
ALTER TABLE loan_installments DROP CONSTRAINT IF EXISTS loan_installments_holiday_interest_check;
ALTER TABLE loan_installments ADD CONSTRAINT loan_installments_holiday_interest_check
  CHECK (holiday_interest IS NULL OR holiday_interest IN ('SPREAD', 'NONE', 'APPLY_LATER'));

-- --------------------------------------------------------------------------
-- Revolving loans: installments added by hand, filled on their due date
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_billing_dates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  due_on          date NOT NULL,
  installment_id  uuid REFERENCES loan_installments(id) ON DELETE SET NULL,
  billed_at       timestamptz,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, due_on)
);

-- --------------------------------------------------------------------------
-- Attachments
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id       uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size          int NOT NULL CHECK (size > 0),
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  updated_at    timestamptz
);
CREATE INDEX IF NOT EXISTS loan_attachments_loan_idx ON loan_attachments (loan_id, created_at);
