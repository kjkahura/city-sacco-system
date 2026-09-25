-- Three repayment and schedule features after Mambu.
--
-- 1. Interest prepaid on a fixed-term loan. With interest_prepayment set, a
--    payment made before an installment's due date pays that installment's
--    whole interest, not only what has been earned so far. The part not yet
--    earned is held in a deferred interest liability (interest received in
--    advance, 200-340) and moves out of it as the interest is earned.
--      NONE               a payment pays the interest earned so far and the
--                         rest goes to principal (what every product did)
--      NEXT_INSTALLMENT   the next installment's interest is taken in full
--      ALL_INSTALLMENTS   every installment the payment reaches has its
--                         interest taken in full before its principal
--
-- 2. Postdated payments on a fixed-term loan: a payment recorded now with a
--    later value date (a postdated cheque, a standing order), applied as a
--    repayment by the end of day on that date.
--
-- 3. A schedule on an application: the dates and principal (and, on a fixed
--    term, the interest) the loan will be drawn with at disbursement.

INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('200-340', 'Interest Received in Advance', 'LIABILITY', 'SHORT_TERM_LIABILITY')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS interest_prepayment text NOT NULL DEFAULT 'NONE'
    CHECK (interest_prepayment IN ('NONE', 'NEXT_INSTALLMENT', 'ALL_INSTALLMENTS')),
  ADD COLUMN IF NOT EXISTS gl_deferred_interest text NOT NULL DEFAULT '200-340' REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS allow_postdated_payments boolean NOT NULL DEFAULT false;

ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS interest_prepaid numeric(18,2) NOT NULL DEFAULT 0 CHECK (interest_prepaid >= 0),
  ADD COLUMN IF NOT EXISTS custom_schedule jsonb;

CREATE TABLE IF NOT EXISTS loan_postdated_payments (
  id              bigserial PRIMARY KEY,
  loan_id         uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  amount          numeric(18,2) NOT NULL CHECK (amount > 0),
  value_date      date NOT NULL,
  channel_id      text NOT NULL,
  reference       text,
  note            text,
  installment_no  integer,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPLIED', 'CANCELLED', 'FAILED')),
  failure         text,
  transaction_ref text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  settled_by      text,
  settled_at      timestamptz
);
CREATE INDEX IF NOT EXISTS loan_postdated_due_idx ON loan_postdated_payments (value_date) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS loan_postdated_loan_idx ON loan_postdated_payments (loan_id, value_date);

ALTER TABLE loan_schedule_edits DROP CONSTRAINT IF EXISTS loan_schedule_edits_kind_check;
ALTER TABLE loan_schedule_edits ADD CONSTRAINT loan_schedule_edits_kind_check
  CHECK (kind IN ('EDIT', 'PAYMENT_HOLIDAY', 'DUE_DAY', 'APPLICATION'));
