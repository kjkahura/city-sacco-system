-- Repayment collection options, after Mambu's "Repayment collection" and
-- "Prepayment Recalculation Methods".
--
--   payment_method         VERTICAL (by balance, in the allocation order,
--                          what every product did) or HORIZONTAL (by the
--                          schedule: each installment in turn, its own
--                          penalties, fees, interest and principal)
--   allow_prepayments      refuse a payment above what is due
--   prepayment_interest    AUTOMATIC (interest to the day is applied before
--                          a payment) or MANUAL (after it), dynamic term
--   prepayment_allocation  UPCOMING_PENDING (the prepayment recalculation
--                          redraws the schedule) or NEXT_INSTALLMENTS (the
--                          prepayment pays the next installments' principal
--                          in turn, no redraw), equal installments dynamic
--   mark_paid_when         FULL_DUE (an installment is paid when all of it
--                          is, on or after its date) or PRINCIPAL_EXPECTED
--                          (when its principal is, before or on its date;
--                          its remaining interest moves to the next)

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'VERTICAL' CHECK (payment_method IN ('VERTICAL', 'HORIZONTAL')),
  ADD COLUMN IF NOT EXISTS allow_prepayments boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS prepayment_interest text NOT NULL DEFAULT 'AUTOMATIC' CHECK (prepayment_interest IN ('AUTOMATIC', 'MANUAL')),
  ADD COLUMN IF NOT EXISTS prepayment_allocation text NOT NULL DEFAULT 'UPCOMING_PENDING'
    CHECK (prepayment_allocation IN ('UPCOMING_PENDING', 'NEXT_INSTALLMENTS')),
  ADD COLUMN IF NOT EXISTS mark_paid_when text NOT NULL DEFAULT 'FULL_DUE' CHECK (mark_paid_when IN ('FULL_DUE', 'PRINCIPAL_EXPECTED'));
