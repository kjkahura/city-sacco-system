-- Editing a running loan's schedule, payment holidays and changing the
-- monthly due date, after Mambu's "Repayments Schedule Editing".
--
-- A product lists what its loans' schedules may have changed:
--   PAYMENT_DATES            move due dates
--   PRINCIPAL                reallocate principal between installments
--   INTEREST                 change expected interest (fixed term only;
--                            a dynamic loan's interest follows its balance)
--   FEES                     reallocate fees between installments
--   PAYMENT_HOLIDAYS         give installments nothing due, the schedule
--                            longer by as many
--   NUMBER_OF_INSTALLMENTS   add or remove installments (dynamic term only;
--                            implies PAYMENT_DATES and PRINCIPAL)

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS schedule_editing text[] NOT NULL DEFAULT '{}'
    CHECK (schedule_editing <@ ARRAY['PAYMENT_DATES', 'PRINCIPAL', 'INTEREST', 'FEES', 'PAYMENT_HOLIDAYS', 'NUMBER_OF_INSTALLMENTS']::text[]);

ALTER TABLE loan_installments
  ADD COLUMN IF NOT EXISTS payment_holiday boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS loan_schedule_edits (
  id          bigserial PRIMARY KEY,
  loan_id     uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('EDIT', 'PAYMENT_HOLIDAY', 'DUE_DAY')),
  before      jsonb NOT NULL,
  after       jsonb NOT NULL,
  note        text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_schedule_edits_loan_idx ON loan_schedule_edits (loan_id, created_at);
