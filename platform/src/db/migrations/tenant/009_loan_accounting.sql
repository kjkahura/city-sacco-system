-- Loan product accounting, on the rules Mambu documents for loan products
-- under accrual accounting (docs.mambu.com, "Linking Products to Accounting"
-- and "Cash vs Accruals Accounting"):
--
--   Interest applied     Dr Interest Receivable   Cr Interest Income
--   Fee applied          Dr Fee Receivable        Cr Fee Income
--   Penalty applied      Dr Penalty Receivable    Cr Penalty Income
--   Interest paid        Dr Transaction Source    Cr Interest Receivable
--   Fee paid             Dr Transaction Source    Cr Fee Receivable
--   Penalty paid         Dr Transaction Source    Cr Penalty Receivable
--   Principal write-off  Dr Write-off Expense     Cr Portfolio Control
--   Interest write-off   Dr Write-off Expense     Cr Interest Receivable
--   (fee and penalty write-offs likewise, against their receivables)
--
-- and under cash accounting nothing is recognised until paid: interest,
-- fee and penalty payments credit the income accounts directly.
--
-- The code before this migration accrued interest to a receivable and then
-- credited income again when it was paid, so income was recognised twice
-- and the receivable never came down. Penalties had the same fault. This
-- gives every product the accounts to do it properly and a method to say
-- which set of rules it follows.

INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('100-300', 'Interest Receivable',      'ASSET',   'OTHER_ASSET'),
  ('100-310', 'Fees Receivable',          'ASSET',   'OTHER_ASSET'),
  ('100-320', 'Penalties Receivable',     'ASSET',   'OTHER_ASSET'),
  ('500-310', 'Loan Write-off Expense',   'EXPENSE', 'EXPENSE')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE loan_products
  -- ACCRUAL: income recognised when applied, held in receivables until paid.
  -- CASH: recognised when paid. Mambu offers both per product; so does this.
  ADD COLUMN IF NOT EXISTS accounting_method text NOT NULL DEFAULT 'ACCRUAL'
    CHECK (accounting_method IN ('ACCRUAL', 'CASH')),
  -- DAILY accrues each business day for the days elapsed; MONTHLY books the
  -- month on its last day; NONE never accrues (interest is still owed on the
  -- schedule, it is just not booked until paid).
  ADD COLUMN IF NOT EXISTS interest_accrual text NOT NULL DEFAULT 'DAILY'
    CHECK (interest_accrual IN ('DAILY', 'MONTHLY', 'NONE')),
  -- Day count convention. THIRTY_360 (30E/360) makes a rate quoted per month
  -- accrue to exactly one month's interest over any calendar month, which is
  -- what a SACCO member who was told "1% a month" expects to see. The
  -- ACTUAL_* conventions are what Mambu defaults to and what a bank would
  -- want; they are here for products priced per annum.
  ADD COLUMN IF NOT EXISTS day_count text NOT NULL DEFAULT 'THIRTY_360'
    CHECK (day_count IN ('THIRTY_360', 'ACTUAL_365', 'ACTUAL_360', 'ACTUAL_ACTUAL')),
  -- Defaults point at the seeded accounts so a product created without
  -- naming them still posts somewhere sensible; a product that wants its own
  -- receivables names them.
  ADD COLUMN IF NOT EXISTS gl_interest_rec text NOT NULL DEFAULT '100-300' REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_fee_rec      text NOT NULL DEFAULT '100-310' REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_penalty_rec  text NOT NULL DEFAULT '100-320' REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_writeoff_exp text NOT NULL DEFAULT '500-310' REFERENCES gl_accounts(code),
  -- What a partial repayment pays first. Mambu makes this a drag-and-drop
  -- list on the product; here it is an array in the same order.
  ADD COLUMN IF NOT EXISTS allocation_order text[] NOT NULL
    DEFAULT ARRAY['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'],
  -- Eligibility rules, enforced at approval rather than merely reported.
  ADD COLUMN IF NOT EXISTS enforce_deposit_multiplier boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS require_guarantor_cover   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS min_cover_percent          numeric(6,2) NOT NULL DEFAULT 100
    CHECK (min_cover_percent > 0 AND min_cover_percent <= 200),
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS min_principal numeric(18,2) CHECK (min_principal IS NULL OR min_principal > 0),
  ADD COLUMN IF NOT EXISTS max_principal numeric(18,2) CHECK (max_principal IS NULL OR max_principal > 0),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- The allocation order has to name each component exactly once.
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_allocation_complete;
ALTER TABLE loan_products ADD CONSTRAINT loan_products_allocation_complete CHECK (
  array_length(allocation_order, 1) = 4
  AND 'PENALTY'   = ANY (allocation_order)
  AND 'FEE'       = ANY (allocation_order)
  AND 'INTEREST'  = ANY (allocation_order)
  AND 'PRINCIPAL' = ANY (allocation_order)
);

-- Daily accrual needs to know how far it has got. NULL means "not yet
-- disbursed" or "never accrued"; disbursement sets it to the disbursement
-- date and each accrual moves it forward. Existing loans that already carry
-- accrued interest under the old scheme start from today so the change does
-- not back-accrue on top of what is there.
ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS accrued_through date;

UPDATE loan_accounts
   SET accrued_through = CASE
     WHEN status NOT IN ('ACTIVE', 'IN_ARREARS') THEN accrued_through
     WHEN interest_accrued > 0 THEN current_date
     ELSE disbursed_on
   END
 WHERE accrued_through IS NULL;
