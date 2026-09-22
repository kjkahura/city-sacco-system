-- Loan product configuration, the full set, after Mambu's loan product form
-- ("Setting Up New Loan Products", "Loan Fees Setup", "Loan Penalties
-- Setup", "Arrears Settings", "Internal Controls for Loans", "Interest
-- Types", "Loan Account Life Cycle and States").
--
-- The point of putting all of it in one migration: a SACCO deploys once and
-- configures products for years without a schema change. Every setting has
-- a default that reproduces today's behaviour, so nothing existing changes
-- until somebody edits a product.

-- ==========================================================================
-- 1. Identity: how loans under the product are numbered
-- ==========================================================================
--
-- id_pattern is a template. '#' is a digit, '@' a letter, '$' either, and
-- any other character is literal. INCREMENTAL fills the '#' run from
-- id_next, so 'LN######' continues today's LN000001 series exactly; RANDOM
-- draws each placeholder at random, which is what Mambu recommends because
-- it does not serialise account creation on one counter.

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS id_pattern text NOT NULL DEFAULT 'LN######',
  ADD COLUMN IF NOT EXISTS id_mode text NOT NULL DEFAULT 'INCREMENTAL'
    CHECK (id_mode IN ('RANDOM', 'INCREMENTAL')),
  ADD COLUMN IF NOT EXISTS id_next bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS initial_state text NOT NULL DEFAULT 'PENDING_APPROVAL'
    CHECK (initial_state IN ('PARTIAL_APPLICATION', 'PENDING_APPROVAL')),
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'UNCATEGORIZED'
    CHECK (category IN ('PERSONAL', 'PURCHASE_FINANCING', 'MORTGAGE', 'SME', 'COMMERCIAL', 'UNCATEGORIZED'));

-- Existing tenants have loans numbered by count; the counter continues from
-- there rather than colliding with them.
UPDATE loan_products p
   SET id_next = COALESCE((SELECT max(substring(account_no FROM '[0-9]+$')::bigint) + 1
                           FROM loan_accounts WHERE account_no ~ '^LN[0-9]+$'), 1)
 WHERE id_next = 1;

-- ==========================================================================
-- 2. Interest
-- ==========================================================================

ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_product_type_check;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_product_type_check
    CHECK (product_type IN ('FIXED_TERM', 'DYNAMIC_TERM', 'INTEREST_FREE'));
ALTER TABLE loan_accounts DROP CONSTRAINT IF EXISTS loan_accounts_product_type_check;
ALTER TABLE loan_accounts
  ADD CONSTRAINT loan_accounts_product_type_check
    CHECK (product_type IN ('FIXED_TERM', 'DYNAMIC_TERM', 'INTEREST_FREE'));

ALTER TABLE loan_products
  -- SIMPLE: linear on the base. CAPITALIZED: applied interest joins the
  -- principal (Dr Portfolio, Cr Income) and is repaid as principal.
  -- COMPOUND: daily exponential, base × ((1 + annual)^(days/year) − 1).
  ADD COLUMN IF NOT EXISTS interest_type text NOT NULL DEFAULT 'SIMPLE'
    CHECK (interest_type IN ('SIMPLE', 'CAPITALIZED', 'COMPOUND')),
  -- For SIMPLE on dynamic equal-installment loans: whether unpaid interest
  -- joins the base ("Principal and Interest" in Mambu).
  ADD COLUMN IF NOT EXISTS simple_base text NOT NULL DEFAULT 'PRINCIPAL_ONLY'
    CHECK (simple_base IN ('PRINCIPAL_ONLY', 'PRINCIPAL_AND_INTEREST')),
  -- ON_REPAYMENT: interest becomes due per installment. ON_DISBURSEMENT:
  -- the whole term's interest is applied on day one (fixed-term only).
  ADD COLUMN IF NOT EXISTS interest_posting text NOT NULL DEFAULT 'ON_REPAYMENT'
    CHECK (interest_posting IN ('ON_REPAYMENT', 'ON_DISBURSEMENT')),
  -- The unit monthly_rate is quoted in. The column keeps its historical
  -- name; rate_frequency says what it means.
  ADD COLUMN IF NOT EXISTS rate_frequency text NOT NULL DEFAULT 'PER_MONTH'
    CHECK (rate_frequency IN ('PER_YEAR', 'PER_MONTH', 'PER_WEEK', 'PER_DAY')),
  ADD COLUMN IF NOT EXISTS rate_min numeric(8,4),
  ADD COLUMN IF NOT EXISTS rate_max numeric(8,4);

COMMENT ON COLUMN loan_products.monthly_rate IS
  'Default interest rate, in the unit named by rate_frequency (historically always per month).';

-- An interest-free product charges nothing, whatever else it says.
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_interest_free_has_no_rate;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_interest_free_has_no_rate
    CHECK (product_type <> 'INTEREST_FREE' OR monthly_rate = 0);
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_rate_band;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_rate_band
    CHECK (rate_min IS NULL OR rate_max IS NULL OR rate_min <= rate_max);

-- ==========================================================================
-- 3. Amount, term and schedule shape
-- ==========================================================================

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS default_principal numeric(18,2),
  ADD COLUMN IF NOT EXISTS min_term int,
  ADD COLUMN IF NOT EXISTS default_term int,
  -- Installments fall every repayment_interval_count units, or on fixed
  -- days of the month (payday loans: 1st and 15th). term_months on the
  -- loan is then simply the number of installments.
  ADD COLUMN IF NOT EXISTS repayment_interval_unit text NOT NULL DEFAULT 'MONTHS'
    CHECK (repayment_interval_unit IN ('MONTHS', 'WEEKS', 'DAYS')),
  ADD COLUMN IF NOT EXISTS repayment_interval_count int NOT NULL DEFAULT 1 CHECK (repayment_interval_count > 0),
  ADD COLUMN IF NOT EXISTS fixed_days_of_month int[],
  ADD COLUMN IF NOT EXISTS short_month_handling text NOT NULL DEFAULT 'LAST_DAY'
    CHECK (short_month_handling IN ('LAST_DAY', 'FIRST_OF_NEXT')),
  ADD COLUMN IF NOT EXISTS first_due_offset_days int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_due_offset_min int,
  ADD COLUMN IF NOT EXISTS first_due_offset_max int,
  -- PRINCIPAL grace: interest-only installments first. PURE grace: nothing
  -- due for those installments; interest still accrues and lands after.
  ADD COLUMN IF NOT EXISTS grace_type text NOT NULL DEFAULT 'NONE'
    CHECK (grace_type IN ('NONE', 'PRINCIPAL', 'PURE')),
  ADD COLUMN IF NOT EXISTS grace_periods int NOT NULL DEFAULT 0 CHECK (grace_periods >= 0),
  -- Balloon: amortise as if over this many periods, so the last scheduled
  -- installment carries the remaining principal.
  ADD COLUMN IF NOT EXISTS amortization_periods int,
  ADD COLUMN IF NOT EXISTS rounding text NOT NULL DEFAULT 'NONE'
    CHECK (rounding IN ('NONE', 'WHOLE', 'WHOLE_UP'));

COMMENT ON COLUMN loan_accounts.term_months IS 'Number of installments (one per repayment interval of the product).';

-- ==========================================================================
-- 4. Arrears
-- ==========================================================================

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS arrears_tolerance_days int NOT NULL DEFAULT 0 CHECK (arrears_tolerance_days >= 0),
  ADD COLUMN IF NOT EXISTS arrears_tolerance_percent numeric(6,3),
  ADD COLUMN IF NOT EXISTS arrears_tolerance_floor numeric(18,2),
  ADD COLUMN IF NOT EXISTS arrears_count_from text NOT NULL DEFAULT 'OLDEST_LATE'
    CHECK (arrears_count_from IN ('FIRST_ARREARS', 'OLDEST_LATE')),
  ADD COLUMN IF NOT EXISTS arrears_non_working_days text NOT NULL DEFAULT 'INCLUDE'
    CHECK (arrears_non_working_days IN ('INCLUDE', 'EXCLUDE'));

-- ==========================================================================
-- 5. Penalties: Mambu's four bases, a tolerance separate from arrears
-- ==========================================================================

ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_penalty_basis_check;
UPDATE loan_products SET penalty_basis = 'OVERDUE_ALL' WHERE penalty_basis = 'OVERDUE';
UPDATE loan_products SET penalty_basis = 'OUTSTANDING_PRINCIPAL' WHERE penalty_basis = 'OUTSTANDING';
ALTER TABLE loan_products ALTER COLUMN penalty_basis SET DEFAULT 'OVERDUE_ALL';
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_penalty_basis_check
    CHECK (penalty_basis IN ('NONE', 'OVERDUE_PRINCIPAL', 'OVERDUE_PRINCIPAL_INTEREST', 'OVERDUE_ALL', 'OUTSTANDING_PRINCIPAL'));

-- The old name said grace; Mambu calls the same thing the penalty tolerance
-- period, and it is distinct from the arrears tolerance above.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'loan_products' AND column_name = 'penalty_grace_days') THEN
    ALTER TABLE loan_products RENAME COLUMN penalty_grace_days TO penalty_tolerance_days;
  END IF;
END $$;
ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS penalty_rate_min numeric(6,3),
  ADD COLUMN IF NOT EXISTS penalty_rate_max numeric(6,3);

-- ==========================================================================
-- 6. Cap on charges (the in duplum mechanism), internal controls, fees flag
-- ==========================================================================

ALTER TABLE loan_products
  -- When interest + fees + penalties charged since the loan went into
  -- arrears reach this percentage of the base, the loan is locked: SOFT
  -- applies the charge that crossed the line first, HARD refuses it. Null
  -- means no cap. Ships unset; a SACCO sets it to its legal position.
  ADD COLUMN IF NOT EXISTS charge_cap_percent numeric(8,3),
  ADD COLUMN IF NOT EXISTS charge_cap_base text NOT NULL DEFAULT 'OUTSTANDING_PRINCIPAL'
    CHECK (charge_cap_base IN ('ORIGINAL_PRINCIPAL', 'OUTSTANDING_PRINCIPAL')),
  ADD COLUMN IF NOT EXISTS charge_cap_mode text NOT NULL DEFAULT 'HARD'
    CHECK (charge_cap_mode IN ('SOFT', 'HARD')),
  ADD COLUMN IF NOT EXISTS auto_close_paid_off_days int,
  ADD COLUMN IF NOT EXISTS auto_lock_arrears_days int,
  ADD COLUMN IF NOT EXISTS allow_arbitrary_fees boolean NOT NULL DEFAULT false;

-- Accounting can be switched off for a product: balances are kept, no
-- journal entries are written, and the product needs no GL accounts.
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_accounting_method_check;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_accounting_method_check
    CHECK (accounting_method IN ('ACCRUAL', 'CASH', 'NONE'));
ALTER TABLE loan_products ALTER COLUMN gl_portfolio DROP NOT NULL;
ALTER TABLE loan_products ALTER COLUMN gl_interest_inc DROP NOT NULL;
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_linked_has_gl;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_linked_has_gl
    CHECK (accounting_method = 'NONE' OR (gl_portfolio IS NOT NULL AND gl_interest_inc IS NOT NULL));

-- ==========================================================================
-- 7. Fees: a table of predefined fees per product, and the fees applied
-- ==========================================================================
--
-- fee_type says when the fee happens; calculation says how much.
--   MANUAL                    applied by a user whenever the event occurs
--   DISBURSEMENT_DEDUCTED     taken out of the amount paid to the member
--   DISBURSEMENT_CAPITALIZED  added to the principal the member repays
--   DISBURSEMENT_UPFRONT      applied as due at disbursement, paid later
--   PAYMENT_DUE               placed on the schedule, per installment
--   LATE_REPAYMENT            applied when an installment goes late
-- The legacy processing_fee column is treated as an upfront flat fee named
-- "Processing fee"; a product may use either or both.

CREATE TABLE IF NOT EXISTS loan_product_fees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     text NOT NULL REFERENCES loan_products(id) ON DELETE CASCADE,
  code           text NOT NULL,
  name           text NOT NULL,
  fee_type       text NOT NULL CHECK (fee_type IN (
                   'MANUAL', 'DISBURSEMENT_DEDUCTED', 'DISBURSEMENT_CAPITALIZED',
                   'DISBURSEMENT_UPFRONT', 'PAYMENT_DUE', 'LATE_REPAYMENT')),
  calculation    text NOT NULL CHECK (calculation IN (
                   'FLAT', 'FLAT_PER_INSTALLMENT', 'PERCENT_OF_AMOUNT',
                   'PERCENT_PER_INSTALLMENT', 'PERCENT_OF_INSTALLMENT_PRINCIPAL')),
  amount         numeric(18,2),
  percent        numeric(8,4),
  min_amount     numeric(18,2),
  max_amount     numeric(18,2),
  required       boolean NOT NULL DEFAULT true,
  gl_income      text REFERENCES gl_accounts(code),
  gl_receivable  text REFERENCES gl_accounts(code),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, code),
  -- Which calculations make sense for which event.
  CONSTRAINT loan_product_fees_calculation_fits CHECK (
    (fee_type IN ('MANUAL', 'DISBURSEMENT_DEDUCTED', 'DISBURSEMENT_CAPITALIZED', 'DISBURSEMENT_UPFRONT')
       AND calculation IN ('FLAT', 'PERCENT_OF_AMOUNT'))
    OR (fee_type = 'PAYMENT_DUE'
       AND calculation IN ('FLAT', 'FLAT_PER_INSTALLMENT', 'PERCENT_OF_AMOUNT', 'PERCENT_PER_INSTALLMENT'))
    OR (fee_type = 'LATE_REPAYMENT'
       AND calculation IN ('FLAT', 'PERCENT_OF_AMOUNT', 'PERCENT_OF_INSTALLMENT_PRINCIPAL'))
  ),
  -- A flat fee names an amount (or, for MANUAL, may leave it to the teller);
  -- a percentage fee names a percentage.
  CONSTRAINT loan_product_fees_has_figure CHECK (
    (calculation IN ('FLAT', 'FLAT_PER_INSTALLMENT') AND (amount IS NOT NULL OR fee_type = 'MANUAL'))
    OR (calculation NOT IN ('FLAT', 'FLAT_PER_INSTALLMENT') AND percent IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS loan_product_fees_product_idx ON loan_product_fees (product_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS loan_fees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  product_fee_id  uuid REFERENCES loan_product_fees(id),
  installment_id  uuid REFERENCES loan_installments(id) ON DELETE SET NULL,
  name            text NOT NULL,
  fee_type        text NOT NULL,
  amount          numeric(18,2) NOT NULL CHECK (amount >= 0),
  paid            numeric(18,2) NOT NULL DEFAULT 0,
  applied_on      date NOT NULL DEFAULT current_date,
  entry_id        uuid,
  status          text NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE', 'PAID', 'WAIVED')),
  waived_at       timestamptz,
  waived_by       text,
  note            text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_fees_loan_idx ON loan_fees (loan_id, applied_on);

-- ==========================================================================
-- 8. The loan: states, locks, overrides, capitalised principal
-- ==========================================================================

ALTER TABLE loan_accounts DROP CONSTRAINT IF EXISTS loan_accounts_status_check;
UPDATE loan_accounts SET status = 'PARTIAL_APPLICATION' WHERE status = 'DRAFT';
ALTER TABLE loan_accounts
  ADD CONSTRAINT loan_accounts_status_check CHECK (status IN (
    'PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED',
    'CLOSED_REPAID', 'CLOSED_WRITTEN_OFF', 'CLOSED_REJECTED', 'CLOSED_WITHDRAWN',
    'CLOSED_RESCHEDULED', 'CLOSED_REFINANCED'));

ALTER TABLE loan_accounts
  -- Interest capitalised into principal (CAPITALIZED interest type, and
  -- arrears capitalised at reschedule). Outstanding principal is
  -- disbursed + capitalized − paid everywhere.
  ADD COLUMN IF NOT EXISTS principal_capitalized numeric(18,2) NOT NULL DEFAULT 0,
  -- Per-loan settings chosen within the product's bands at application.
  ADD COLUMN IF NOT EXISTS penalty_rate numeric(6,3),
  ADD COLUMN IF NOT EXISTS arrears_tolerance_days int,
  ADD COLUMN IF NOT EXISTS arrears_tolerance_percent numeric(6,3),
  ADD COLUMN IF NOT EXISTS first_due_offset_days int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grace_periods int,
  ADD COLUMN IF NOT EXISTS amortization_periods int,
  ADD COLUMN IF NOT EXISTS purpose text,
  ADD COLUMN IF NOT EXISTS notes text,
  -- Workflow bookkeeping.
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS disbursed_by text,
  ADD COLUMN IF NOT EXISTS arrears_since date,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_reason text CHECK (locked_reason IN ('MANUAL', 'CAPPED', 'ARREARS')),
  ADD COLUMN IF NOT EXISTS status_before_lock text,
  ADD COLUMN IF NOT EXISTS closed_on date,
  -- Charges since the loan last went into arrears, for the cap.
  ADD COLUMN IF NOT EXISTS charges_since_arrears numeric(18,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS loan_state_history (
  id           bigserial PRIMARY KEY,
  loan_id      uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  action       text NOT NULL,
  actor        text,
  note         text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_state_history_loan_idx ON loan_state_history (loan_id, at);

ALTER TABLE loan_installments DROP CONSTRAINT IF EXISTS loan_installments_status_check;
ALTER TABLE loan_installments
  ADD CONSTRAINT loan_installments_status_check
    CHECK (status IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'GRACE'));
-- The date the installment falls on before weekends and holidays push it,
-- so interest periods are measured on the contract's dates, not the bank's
-- opening days.
ALTER TABLE loan_installments ADD COLUMN IF NOT EXISTS nominal_due date;
UPDATE loan_installments SET nominal_due = due_date WHERE nominal_due IS NULL;
ALTER TABLE loan_installments ALTER COLUMN nominal_due SET NOT NULL;
ALTER TABLE loan_installments ALTER COLUMN nominal_due SET DEFAULT current_date;

-- ==========================================================================
-- 9. Tenant-wide lending controls (Mambu "Internal Controls")
-- ==========================================================================

CREATE TABLE IF NOT EXISTS lending_controls (
  id                              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  max_exposure_mode               text NOT NULL DEFAULT 'UNLIMITED'
                                  CHECK (max_exposure_mode IN ('UNLIMITED', 'SUM_OF_LOANS', 'SUM_MINUS_DEPOSITS')),
  max_exposure_amount             numeric(18,2),
  one_active_loan_per_member      boolean NOT NULL DEFAULT false,
  min_arrears_days_before_writeoff int NOT NULL DEFAULT 0,
  max_days_undo_close             int,
  -- The approver of a loan may not disburse it. Off until a SACCO turns it
  -- on, as in Mambu.
  two_man_rule                    boolean NOT NULL DEFAULT false,
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lending_controls (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Transaction kinds the new pieces record.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_kind_check CHECK (kind IN (
    'SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER',
    'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'LOAN_FEE', 'LOAN_FEE_WAIVED',
    'LOAN_INTEREST_ACCRUAL', 'LOAN_INTEREST_CAPITALIZED', 'LOAN_WRITE_OFF',
    'LOAN_RESCHEDULE', 'LOAN_REFINANCE',
    'SHARE_PURCHASE', 'SHARE_TRANSFER', 'DIVIDEND_PAYOUT', 'REVERSAL'));
