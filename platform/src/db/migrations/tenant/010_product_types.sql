-- Loan product types and interest calculation methods, after Mambu.
--
-- Until now a product had one setting, `method`, that decided how the
-- schedule was drawn (FLAT or REDUCING) and the accrual read the actual
-- outstanding balance for REDUCING regardless of what kind of loan it was.
-- Mambu separates two things this had run together:
--
--   product_type   what the schedule *is*
--     FIXED_TERM     The schedule is set at disbursement and the interest on
--                    it is what the member owes. Paying early does not cut
--                    the interest and paying late does not add to it (that
--                    is what penalties are for). Interest accrues against the
--                    schedule, so the accrued figure on a due date is the
--                    schedule's figure.
--     DYNAMIC_TERM   Interest is earned on the actual outstanding principal
--                    for the actual days it was outstanding. A repayment
--                    that is more than what was due reduces the balance and
--                    the schedule is regenerated for what remains.
--
--   method         how interest on a period is worked out
--     FLAT                         on the original principal every period
--                                  (Mambu "Fixed Flat"; fixed-term only)
--     REDUCING                     on the declining balance, equal principal
--                                  each period (Mambu "Declining Balance")
--     REDUCING_EQUAL_INSTALLMENTS  on the declining balance with the same
--                                  total payment every period, so principal
--                                  rises as interest falls (Mambu "Declining
--                                  Balance (Equal Installments)")
--
-- Dynamic-term products also say what a prepayment does to the schedule
-- (Mambu's "prepayment recalculation") and whether interest keeps accruing
-- once the last installment date has passed (Mambu's "accrue late interest").
--
-- Everything existing becomes FIXED_TERM, which is exactly how those loans
-- have been behaving: the schedule they were given at disbursement is the
-- one they owe.

ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_method_check;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_method_check
    CHECK (method IN ('FLAT', 'REDUCING', 'REDUCING_EQUAL_INSTALLMENTS'));

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'FIXED_TERM'
    CHECK (product_type IN ('FIXED_TERM', 'DYNAMIC_TERM')),
  ADD COLUMN IF NOT EXISTS prepayment_recalculation text NOT NULL DEFAULT 'REDUCE_INSTALLMENT_AMOUNT'
    CHECK (prepayment_recalculation IN ('NONE', 'REDUCE_INSTALLMENT_AMOUNT', 'REDUCE_NUMBER_OF_INSTALLMENTS')),
  ADD COLUMN IF NOT EXISTS accrue_late_interest boolean NOT NULL DEFAULT true;

-- Flat interest on a balance that moves is not a thing: the flat method
-- charges on the original principal whatever the balance does, which is the
-- definition of a fixed-term loan.
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_flat_is_fixed_term;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_flat_is_fixed_term
    CHECK (NOT (product_type = 'DYNAMIC_TERM' AND method = 'FLAT'));

-- A loan remembers the type it was written under. Product type is not
-- changeable once a product exists (the API refuses it) but the loan carries
-- it anyway so a query over loans never needs the product to say how the
-- loan behaves.
ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'FIXED_TERM'
    CHECK (product_type IN ('FIXED_TERM', 'DYNAMIC_TERM'));

-- When a dynamic loan's schedule was last regenerated, and why. Nothing reads
-- it to decide anything; it is there for the person asking "why does this
-- schedule have nine lines when the loan was for twelve months".
ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS rescheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reschedule_count int NOT NULL DEFAULT 0;
