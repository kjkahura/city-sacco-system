-- Fees, penalties and arrears, after Mambu's "Configure fees, penalties,
-- and arrears": Loan Fees Setup, Loan Penalties Setup, Arrears Settings and
-- Non-Scheduled Fee Allocation.

-- --------------------------------------------------------------------------
-- Penalties: a charge covers the late days since the last one
-- --------------------------------------------------------------------------
--
-- A penalty accrues from the first late day. Nothing is applied while the
-- installment is inside the tolerance; the first charge after it covers
-- every late day since the due date, and each charge after that the days
-- since the last. A day the end of day missed is covered by the next run.
-- A charge taken back by a backdated repayment or a reversal is marked
-- reversed (not waived), so its days are charged again on what is then owed.
-- A charge on a loan locked by the charge cap is recorded at nothing
-- (forfeited): its days are covered and never charged.

ALTER TABLE penalty_charges
  ADD COLUMN IF NOT EXISTS period_from date,
  ADD COLUMN IF NOT EXISTS days_charged int,
  ADD COLUMN IF NOT EXISTS tax numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forfeited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by text,
  ADD COLUMN IF NOT EXISTS reversal_reason text;
UPDATE penalty_charges SET days_charged = 1, period_from = charged_on - 1 WHERE days_charged IS NULL;
ALTER TABLE penalty_charges DROP CONSTRAINT IF EXISTS penalty_charges_amount_check;
ALTER TABLE penalty_charges ADD CONSTRAINT penalty_charges_amount_check CHECK (amount > 0 OR (amount = 0 AND forfeited));
ALTER TABLE penalty_charges ALTER COLUMN rate TYPE numeric(9,4);
DROP INDEX IF EXISTS penalty_once_per_installment_per_day;
CREATE UNIQUE INDEX IF NOT EXISTS penalty_once_per_installment_per_day
  ON penalty_charges (installment_id, charged_on) WHERE waived_at IS NULL AND reversed_at IS NULL;
CREATE INDEX IF NOT EXISTS penalty_installment_idx ON penalty_charges (installment_id, charged_on DESC);

ALTER TABLE loan_accounts
  -- Penalty accrued and not yet applied (inside the tolerance, or on a
  -- locked loan): shown on the loan, not posted.
  ADD COLUMN IF NOT EXISTS penalty_unapplied numeric(18,2) NOT NULL DEFAULT 0,
  -- The product's penalty and arrears settings as they were when the loan
  -- was approved; later product changes reach only pending loans.
  ADD COLUMN IF NOT EXISTS settings_snapshot jsonb,
  -- Fees applied with no allocation to the schedule.
  ADD COLUMN IF NOT EXISTS ns_fees_due numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ns_fees_paid numeric(18,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS loan_penalty_rate_changes (
  id          bigserial PRIMARY KEY,
  loan_id     uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  from_rate   numeric(9,4),
  to_rate     numeric(9,4) NOT NULL,
  changed_on  date NOT NULL,
  note        text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Arrears: a band for the tolerance days and the tolerance percentage
-- --------------------------------------------------------------------------

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS arrears_tolerance_days_min int CHECK (arrears_tolerance_days_min >= 0),
  ADD COLUMN IF NOT EXISTS arrears_tolerance_days_max int CHECK (arrears_tolerance_days_max >= 0),
  ADD COLUMN IF NOT EXISTS arrears_tolerance_percent_min numeric(6,3) CHECK (arrears_tolerance_percent_min >= 0),
  ADD COLUMN IF NOT EXISTS arrears_tolerance_percent_max numeric(6,3) CHECK (arrears_tolerance_percent_max >= 0);

-- Loans already approved or running keep the settings they run on today.
UPDATE loan_accounts l SET
  settings_snapshot = jsonb_build_object(
    'penalty_basis', p.penalty_basis, 'penalty_tolerance_days', p.penalty_tolerance_days,
    'arrears_tolerance_floor', p.arrears_tolerance_floor, 'arrears_count_from', p.arrears_count_from,
    'arrears_non_working_days', p.arrears_non_working_days),
  penalty_rate = COALESCE(l.penalty_rate, p.penalty_rate),
  arrears_tolerance_days = COALESCE(l.arrears_tolerance_days, p.arrears_tolerance_days),
  arrears_tolerance_percent = COALESCE(l.arrears_tolerance_percent, p.arrears_tolerance_percent)
FROM loan_products p
WHERE p.id = l.product_id AND l.settings_snapshot IS NULL
  AND l.status IN ('APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED');

-- --------------------------------------------------------------------------
-- Fees: where a manual fee goes, amortisation, planned fees
-- --------------------------------------------------------------------------

INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('200-350', 'Deferred Fee Income', 'LIABILITY', 'SHORT_TERM_LIABILITY')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS gl_deferred_fee_income text NOT NULL DEFAULT '200-350' REFERENCES gl_accounts(code);

ALTER TABLE loan_product_fees
  -- A manual fee goes on the next installment (NEXT_INSTALLMENT) or into a
  -- balance of its own collected by a custom repayment (NO_ALLOCATION).
  ADD COLUMN IF NOT EXISTS allocation text NOT NULL DEFAULT 'NEXT_INSTALLMENT'
    CHECK (allocation IN ('NEXT_INSTALLMENT', 'NO_ALLOCATION')),
  ADD COLUMN IF NOT EXISTS amortization_profile text NOT NULL DEFAULT 'NONE'
    CHECK (amortization_profile IN ('NONE', 'STRAIGHT_LINE', 'SUM_OF_YEARS_DIGITS', 'EFFECTIVE_INTEREST_RATE')),
  ADD COLUMN IF NOT EXISTS amortization_frequency text NOT NULL DEFAULT 'INSTALLMENT_DUE_DATES'
    CHECK (amortization_frequency IN ('INSTALLMENT_DUE_DATES', 'INSTALLMENT_DUE_DATES_DAILY', 'CUSTOM_INTERVAL')),
  ADD COLUMN IF NOT EXISTS amortization_interval_count int CHECK (amortization_interval_count > 0),
  ADD COLUMN IF NOT EXISTS amortization_interval_unit text CHECK (amortization_interval_unit IN ('DAYS', 'WEEKS', 'MONTHS', 'YEARS')),
  ADD COLUMN IF NOT EXISTS amortization_intervals int CHECK (amortization_intervals > 0),
  ADD COLUMN IF NOT EXISTS amortization_on_reschedule text NOT NULL DEFAULT 'END_ON_ORIGINAL'
    CHECK (amortization_on_reschedule IN ('END_ON_ORIGINAL', 'CONTINUE_ON_NEW')),
  ADD COLUMN IF NOT EXISTS gl_deferred_income text REFERENCES gl_accounts(code);

ALTER TABLE loan_fees
  ADD COLUMN IF NOT EXISTS non_scheduled boolean NOT NULL DEFAULT false,
  -- The income of the fee held in deferred fee income, and how much of it
  -- has been recognised.
  ADD COLUMN IF NOT EXISTS deferred numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recognised numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gl_deferred text;

CREATE TABLE IF NOT EXISTS loan_fee_amortization (
  id            bigserial PRIMARY KEY,
  loan_fee_id   uuid NOT NULL REFERENCES loan_fees(id) ON DELETE CASCADE,
  loan_id       uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  number        int NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  amount        numeric(18,2) NOT NULL CHECK (amount >= 0),
  recognised    numeric(18,2) NOT NULL DEFAULT 0,
  daily         boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
  -- What a closure recognised at once, so a reversal that reopens the loan
  -- can take it back.
  closure_entry_id uuid,
  closure_amount   numeric(18,2),
  UNIQUE (loan_fee_id, number)
);
CREATE INDEX IF NOT EXISTS loan_fee_amortization_open_idx ON loan_fee_amortization (period_start) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS loan_planned_fees (
  id                  bigserial PRIMARY KEY,
  loan_id             uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  installment_number  int NOT NULL CHECK (installment_number > 0),
  product_fee_id      uuid REFERENCES loan_product_fees(id),
  name                text NOT NULL,
  amount              numeric(18,2) NOT NULL CHECK (amount > 0),
  apply_on            date,
  status              text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'APPLIED', 'SKIPPED', 'DELETED')),
  loan_fee_id         uuid REFERENCES loan_fees(id) ON DELETE SET NULL,
  reason              text,
  note                text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_planned_fees_loan_idx ON loan_planned_fees (loan_id, installment_number) WHERE status = 'PLANNED';
