-- Product accounting after Mambu's "Linking Products to Accounting", "Cash vs
-- Accruals Accounting", "Accounting Closures" and inter-branch rules:
--
--   * branches on accounts and on every journal line, with inter-branch GL
--     rules so an entry whose lines fall in two branches balances in each
--   * accounting closures, tenant-wide or per branch, manual or automatic,
--     that refuse anything dated on or before them
--   * deposit products with an accounting method (NONE, CASH, ACCRUAL), the
--     full set of Mambu's deposit GL mappings, interest (accrued daily,
--     applied on a schedule), withholding tax, negative rates, product fees
--     and overdrafts (authorised and technical)
--   * a GL accrual method and posting granularity on loan and deposit
--     products, separate from how interest is calculated on the account
--   * a suspense account for the cash side of products not linked to
--     accounting, a history of every product's GL mappings, and a record of
--     every change of accounting method on a product in use

-- --------------------------------------------------------------------------
-- Chart of accounts
-- --------------------------------------------------------------------------

INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('100-330', 'Negative Interest Receivable',   'ASSET',     'OTHER_ASSET'),
  ('100-400', 'Overdraft Portfolio',            'ASSET',     'LOAN_PORTFOLIO'),
  ('100-410', 'Overdraft Interest Receivable',  'ASSET',     'OTHER_ASSET'),
  ('200-110', 'Interest Payable on Deposits',   'LIABILITY', 'SHORT_TERM_LIABILITY'),
  ('200-330', 'Withholding Tax Payable',        'LIABILITY', 'SHORT_TERM_LIABILITY'),
  ('290-100', 'Inter-branch Clearing',          'LIABILITY', 'OTHER_LIABILITY'),
  ('290-900', 'Suspense: Products Without Accounting', 'LIABILITY', 'OTHER_LIABILITY'),
  ('300-900', 'Accounting Method Conversions',  'EQUITY',    'INSTITUTIONAL_CAPITAL'),
  ('400-300', 'Overdraft Interest Income',      'INCOME',    'INCOME'),
  ('400-310', 'Negative Interest Income',       'INCOME',    'INCOME'),
  ('500-320', 'Overdraft Write-off Expense',    'EXPENSE',   'EXPENSE')
ON CONFLICT (code) DO NOTHING;

-- --------------------------------------------------------------------------
-- Tenant accounting settings
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounting_settings (
  only_row                    boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  -- The other side of a cash movement on a product that is not linked to
  -- accounting, so the till still reconciles.
  gl_suspense                 text NOT NULL DEFAULT '290-900' REFERENCES gl_accounts(code),
  auto_closure_enabled        boolean NOT NULL DEFAULT false,
  auto_closure_interval_days  int CHECK (auto_closure_interval_days IS NULL OR auto_closure_interval_days BETWEEN 1 AND 366),
  last_auto_closure_on        date,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO accounting_settings (only_row) VALUES (true) ON CONFLICT (only_row) DO NOTHING;

-- --------------------------------------------------------------------------
-- Branches on accounts and journal lines
-- --------------------------------------------------------------------------

ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id);
ALTER TABLE loan_accounts    ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id);
ALTER TABLE transactions     ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id);
ALTER TABLE journal_entries  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id);
ALTER TABLE journal_lines    ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id);

UPDATE savings_accounts a SET branch_id = m.branch_id FROM members m
 WHERE m.id = a.member_id AND a.branch_id IS NULL AND m.branch_id IS NOT NULL;
UPDATE loan_accounts a SET branch_id = m.branch_id FROM members m
 WHERE m.id = a.member_id AND a.branch_id IS NULL AND m.branch_id IS NOT NULL;

-- A rule names the GL account that carries the balance between two
-- branches. The rule with both branches empty is the default for any pair.
CREATE TABLE IF NOT EXISTS inter_branch_rules (
  id          text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9]{1,32}$'),
  branch_a    uuid REFERENCES branches(id),
  branch_b    uuid REFERENCES branches(id),
  gl_code     text NOT NULL REFERENCES gl_accounts(code),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((branch_a IS NULL) = (branch_b IS NULL)),
  CHECK (branch_a IS NULL OR branch_a <> branch_b)
);
CREATE UNIQUE INDEX IF NOT EXISTS inter_branch_rules_pair
  ON inter_branch_rules (LEAST(COALESCE(branch_a::text, ''), COALESCE(branch_b::text, '')),
                         GREATEST(COALESCE(branch_a::text, ''), COALESCE(branch_b::text, '')));

-- Per-branch daily rollup, alongside the tenant-wide one (007), so a trial
-- balance can be run for one branch without scanning the lines.
CREATE TABLE IF NOT EXISTS gl_branch_daily_balances (
  gl_code      text NOT NULL REFERENCES gl_accounts(code),
  booking_date date NOT NULL,
  branch_key   uuid NOT NULL,   -- the nil uuid for lines with no branch
  is_closing   boolean NOT NULL,
  debit        numeric(18,2) NOT NULL DEFAULT 0,
  credit       numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (gl_code, booking_date, branch_key, is_closing)
);

CREATE OR REPLACE FUNCTION roll_journal_line_by_branch() RETURNS trigger AS $$
DECLARE
  e record;
BEGIN
  SELECT booking_date, source_type INTO e FROM journal_entries WHERE id = NEW.entry_id;
  INSERT INTO gl_branch_daily_balances (gl_code, booking_date, branch_key, is_closing, debit, credit)
  VALUES (
    NEW.gl_code, e.booking_date, COALESCE(NEW.branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    is_closing_source(e.source_type),
    CASE WHEN NEW.direction = 'DEBIT'  THEN NEW.amount ELSE 0 END,
    CASE WHEN NEW.direction = 'CREDIT' THEN NEW.amount ELSE 0 END
  )
  ON CONFLICT (gl_code, booking_date, branch_key, is_closing) DO UPDATE
    SET debit  = gl_branch_daily_balances.debit  + EXCLUDED.debit,
        credit = gl_branch_daily_balances.credit + EXCLUDED.credit;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_roll_branch ON journal_lines;
CREATE TRIGGER journal_lines_roll_branch
  AFTER INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION roll_journal_line_by_branch();

INSERT INTO gl_branch_daily_balances (gl_code, booking_date, branch_key, is_closing, debit, credit)
SELECT l.gl_code, e.booking_date, '00000000-0000-0000-0000-000000000000'::uuid, is_closing_source(e.source_type),
       SUM(CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE 0 END),
       SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE 0 END)
FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
GROUP BY 1, 2, 3, 4
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- Accounting closures
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounting_closures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid REFERENCES branches(id),   -- NULL: every branch
  closed_through date NOT NULL,
  notes          text,
  automatic      boolean NOT NULL DEFAULT false,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  deleted_by     text
);
CREATE INDEX IF NOT EXISTS accounting_closures_live ON accounting_closures (branch_id, closed_through) WHERE deleted_at IS NULL;

-- The latest closure date that covers a branch: its own or a tenant-wide one.
CREATE OR REPLACE FUNCTION closed_through_for(b uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT max(closed_through) FROM accounting_closures
   WHERE deleted_at IS NULL AND (branch_id IS NULL OR branch_id = b)
$$;

-- The lock, at the database, like the closed-year lock (005): nothing may be
-- posted on or before a closure that covers the line's branch.
CREATE OR REPLACE FUNCTION forbid_posting_before_closure() RETURNS trigger AS $$
DECLARE
  d date;
  c date;
  src text;
BEGIN
  SELECT booking_date, source_type INTO d, src FROM journal_entries WHERE id = NEW.entry_id;
  -- The year-end sweep is dated on the year's last day, which a closure has
  -- usually covered by the time the year is closed.
  IF is_closing_source(src) THEN RETURN NEW; END IF;
  c := closed_through_for(NEW.branch_id);
  IF c IS NOT NULL AND d <= c THEN
    RAISE EXCEPTION 'JOURNAL_ENTRY_BEFORE_CLOSURE: % is on or before the closure of %', d, c
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_closure ON journal_lines;
CREATE TRIGGER journal_lines_closure
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_posting_before_closure();

-- Transactions on products not linked to accounting write no journal lines,
-- so the lock also sits on the transaction record.
CREATE OR REPLACE FUNCTION forbid_transaction_before_closure() RETURNS trigger AS $$
DECLARE
  c date;
BEGIN
  c := closed_through_for(NEW.branch_id);
  IF c IS NOT NULL AND NEW.value_date <= c THEN
    RAISE EXCEPTION 'TRANSACTION_BEFORE_CLOSURE: % is on or before the closure of %', NEW.value_date, c
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_closure ON transactions;
CREATE TRIGGER transactions_closure
  BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_transaction_before_closure();

-- --------------------------------------------------------------------------
-- GL accrual method and posting granularity (loans)
-- --------------------------------------------------------------------------

-- interest_accrual (009) says when interest is added to what the member
-- owes. interest_accrued_accounting says when the accrued amount reaches the
-- ledger under accrual accounting (Mambu's "Interest Accrued Method"):
-- DAILY as it accrues, MONTHLY on the last day of the month, NONE not until
-- it is paid. Under CASH it is always NONE.
ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS interest_accrued_accounting text NOT NULL DEFAULT 'DAILY'
    CHECK (interest_accrued_accounting IN ('NONE', 'DAILY', 'MONTHLY')),
  ADD COLUMN IF NOT EXISTS accrual_granularity text NOT NULL DEFAULT 'PER_ACCOUNT'
    CHECK (accrual_granularity IN ('PER_ACCOUNT', 'AGGREGATED'));
UPDATE loan_products SET interest_accrued_accounting =
  CASE WHEN accounting_method = 'ACCRUAL' AND interest_accrual <> 'NONE' THEN 'DAILY' ELSE 'NONE' END;

-- A fee's own write-off account overrides the product's.
ALTER TABLE loan_product_fees ADD COLUMN IF NOT EXISTS gl_writeoff text REFERENCES gl_accounts(code);

-- --------------------------------------------------------------------------
-- Deposit products
-- --------------------------------------------------------------------------

ALTER TABLE savings_products ALTER COLUMN gl_liability DROP NOT NULL;
ALTER TABLE savings_products
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS accounting_method text NOT NULL DEFAULT 'CASH'
    CHECK (accounting_method IN ('NONE', 'CASH', 'ACCRUAL')),
  ADD COLUMN IF NOT EXISTS interest_accrued_accounting text NOT NULL DEFAULT 'NONE'
    CHECK (interest_accrued_accounting IN ('NONE', 'DAILY', 'MONTHLY')),
  ADD COLUMN IF NOT EXISTS accrual_granularity text NOT NULL DEFAULT 'PER_ACCOUNT'
    CHECK (accrual_granularity IN ('PER_ACCOUNT', 'AGGREGATED')),
  -- Interest. Off unless switched on, so a tenant upgraded to this migration
  -- does not start paying interest nobody configured.
  ADD COLUMN IF NOT EXISTS interest_paid_into_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS interest_calc_balance text NOT NULL DEFAULT 'END_OF_DAY'
    CHECK (interest_calc_balance IN ('END_OF_DAY', 'MINIMUM')),
  ADD COLUMN IF NOT EXISTS interest_day_count text NOT NULL DEFAULT 'ACTUAL_365'
    CHECK (interest_day_count IN ('ACTUAL_365', 'ACTUAL_360', 'THIRTY_360')),
  ADD COLUMN IF NOT EXISTS interest_application text NOT NULL DEFAULT 'MONTHLY'
    CHECK (interest_application IN ('MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL')),
  ADD COLUMN IF NOT EXISTS min_balance_for_interest numeric(18,2),
  ADD COLUMN IF NOT EXISTS allow_negative_rate boolean NOT NULL DEFAULT false,
  -- Withholding tax on interest paid. NULL: none. The rate is the
  -- regulator's, and this system does not guess it.
  ADD COLUMN IF NOT EXISTS withholding_tax_percent numeric(6,3)
    CHECK (withholding_tax_percent IS NULL OR withholding_tax_percent BETWEEN 0 AND 100),
  -- Overdrafts.
  ADD COLUMN IF NOT EXISTS allow_overdraft boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_overdraft_limit numeric(18,2) CHECK (max_overdraft_limit IS NULL OR max_overdraft_limit >= 0),
  ADD COLUMN IF NOT EXISTS overdraft_annual_rate numeric(8,4) NOT NULL DEFAULT 0 CHECK (overdraft_annual_rate >= 0),
  ADD COLUMN IF NOT EXISTS allow_technical_overdraft boolean NOT NULL DEFAULT false,
  -- GL mappings beyond Savings Control (gl_liability) and Interest Expense
  -- (gl_interest_exp) from 001. Which are required follows the method and
  -- the features switched on; see src/domain/productAccounting.js.
  ADD COLUMN IF NOT EXISTS gl_interest_payable text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_fee_inc          text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_tax_payable      text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_neg_interest_inc text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_neg_interest_rec text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_od_portfolio     text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_od_writeoff      text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_od_interest_inc  text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS gl_od_interest_rec  text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE savings_products DROP CONSTRAINT IF EXISTS savings_products_linked_has_gl;
ALTER TABLE savings_products ADD CONSTRAINT savings_products_linked_has_gl
  CHECK (accounting_method = 'NONE' OR gl_liability IS NOT NULL);
ALTER TABLE savings_products DROP CONSTRAINT IF EXISTS savings_products_annual_rate_check;

UPDATE savings_products SET gl_fee_inc = '400-200' WHERE gl_fee_inc IS NULL AND accounting_method <> 'NONE';

CREATE TABLE IF NOT EXISTS savings_product_fees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  text NOT NULL REFERENCES savings_products(id),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,16}$'),
  name        text NOT NULL,
  trigger     text NOT NULL CHECK (trigger IN ('MANUAL', 'MONTHLY')),
  amount      numeric(18,2) CHECK (amount IS NULL OR amount >= 0),
  gl_income   text REFERENCES gl_accounts(code),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, code)
);

-- Deposit accounts: overdraft and interest state.
ALTER TABLE savings_accounts DROP CONSTRAINT IF EXISTS savings_balance_non_negative;
ALTER TABLE savings_accounts
  ADD COLUMN IF NOT EXISTS overdraft_limit      numeric(18,2) NOT NULL DEFAULT 0 CHECK (overdraft_limit >= 0),
  -- Interest accrued and not yet applied, kept to six places so the sub-cent
  -- remainder carries into the next period instead of being lost.
  ADD COLUMN IF NOT EXISTS interest_accrued     numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS neg_interest_accrued numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS od_interest_accrued  numeric(18,6) NOT NULL DEFAULT 0,
  -- What of the above has reached the ledger (payable or receivable).
  ADD COLUMN IF NOT EXISTS interest_booked      numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS neg_interest_booked  numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS od_interest_booked   numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accrued_through      date,
  ADD COLUMN IF NOT EXISTS period_started_on    date,
  ADD COLUMN IF NOT EXISTS last_interest_applied_on date,
  -- Under cash accounting, overdraft interest and fees applied but not yet
  -- paid: in the balance, not yet income.
  ADD COLUMN IF NOT EXISTS od_interest_due      numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS od_fees_due          numeric(18,2) NOT NULL DEFAULT 0;

-- The floor a balance may reach: its authorised overdraft, or anything if
-- the product allows technical overdrafts (charges the system applies when
-- there is no money). Withdrawals are held to the authorised limit in code.
CREATE OR REPLACE FUNCTION enforce_savings_floor() RETURNS trigger AS $$
DECLARE
  technical boolean;
BEGIN
  IF NEW.balance >= 0 OR NEW.balance >= -NEW.overdraft_limit THEN
    RETURN NEW;
  END IF;
  SELECT allow_technical_overdraft INTO technical FROM savings_products WHERE id = NEW.product_id;
  IF technical THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'savings account % would go to %, below its floor of %', NEW.account_no, NEW.balance, -NEW.overdraft_limit
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS savings_floor ON savings_accounts;
CREATE TRIGGER savings_floor
  BEFORE INSERT OR UPDATE OF balance, overdraft_limit ON savings_accounts
  FOR EACH ROW EXECUTE FUNCTION enforce_savings_floor();

-- The balance each account was given interest on, per day: the audit trail
-- for every accrual, and what the MINIMUM method reads.
CREATE TABLE IF NOT EXISTS savings_daily_balances (
  account_id uuid NOT NULL REFERENCES savings_accounts(id),
  day        date NOT NULL,
  balance    numeric(18,2) NOT NULL,
  PRIMARY KEY (account_id, day)
);

-- --------------------------------------------------------------------------
-- Accrual lines: every interest accrual, per account, and the journal entry
-- that carried it (per account, or one per product and branch per day).
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accrual_lines (
  id            bigserial PRIMARY KEY,
  account_kind  text NOT NULL CHECK (account_kind IN ('LOAN', 'SAVINGS')),
  product_id    text NOT NULL,
  branch_id     uuid REFERENCES branches(id),
  account_id    uuid NOT NULL,
  member_id     uuid REFERENCES members(id),
  component     text NOT NULL CHECK (component IN ('INTEREST', 'INTEREST_TAX', 'NEG_INTEREST', 'OD_INTEREST')),
  booking_date  date NOT NULL,
  debit_gl      text NOT NULL REFERENCES gl_accounts(code),
  credit_gl     text NOT NULL REFERENCES gl_accounts(code),
  amount        numeric(18,2) NOT NULL,
  -- When the ledger should see it: now (per account, daily), at the day's
  -- end (aggregated), or at the month's end.
  post_mode     text NOT NULL CHECK (post_mode IN ('NOW', 'END_OF_DAY', 'END_OF_MONTH')),
  entry_id      uuid REFERENCES journal_entries(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Lines whose group nets to nothing are settled without an entry.
ALTER TABLE accrual_lines ADD COLUMN IF NOT EXISTS settled_at timestamptz;
CREATE INDEX IF NOT EXISTS accrual_lines_unposted ON accrual_lines (booking_date) WHERE entry_id IS NULL;
CREATE INDEX IF NOT EXISTS accrual_lines_entry ON accrual_lines (entry_id);
CREATE INDEX IF NOT EXISTS accrual_lines_account ON accrual_lines (account_id);

-- --------------------------------------------------------------------------
-- GL mapping history and accounting method changes
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_gl_mapping_history (
  id            bigserial PRIMARY KEY,
  product_kind  text NOT NULL CHECK (product_kind IN ('LOAN', 'DEPOSIT', 'LOAN_FEE', 'DEPOSIT_FEE')),
  product_id    text NOT NULL,
  resource      text NOT NULL,
  gl_code       text REFERENCES gl_accounts(code),
  effective_from timestamptz NOT NULL DEFAULT now(),
  changed_by    text
);
CREATE INDEX IF NOT EXISTS product_gl_mapping_history_product ON product_gl_mapping_history (product_kind, product_id, effective_from);

CREATE TABLE IF NOT EXISTS product_accounting_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_kind  text NOT NULL CHECK (product_kind IN ('LOAN', 'DEPOSIT')),
  product_id    text NOT NULL,
  from_method   text NOT NULL,
  to_method     text NOT NULL,
  from_accrued_accounting text,
  to_accrued_accounting   text,
  effective_on  date NOT NULL,
  reason        text NOT NULL,
  accounts      int NOT NULL DEFAULT 0,
  entry_ids     uuid[] NOT NULL DEFAULT '{}',
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Transaction kinds
-- --------------------------------------------------------------------------

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_kind_check CHECK (kind IN (
    'SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER',
    'SAVINGS_FEE', 'SAVINGS_INTEREST_ACCRUAL', 'SAVINGS_INTEREST_APPLIED', 'SAVINGS_WITHHOLDING_TAX',
    'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED', 'OVERDRAFT_WRITE_OFF', 'ACCOUNT_BRANCH_CHANGE',
    'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'LOAN_FEE', 'LOAN_FEE_WAIVED',
    'LOAN_INTEREST_ACCRUAL', 'LOAN_INTEREST_CAPITALIZED', 'LOAN_WRITE_OFF',
    'LOAN_RESCHEDULE', 'LOAN_REFINANCE',
    'LOAN_FUNDED', 'LOAN_REPAID_TO_FUNDER', 'CREDIT_BALANCE_DEPOSIT',
    'SHARE_PURCHASE', 'SHARE_TRANSFER', 'DIVIDEND_PAYOUT', 'REVERSAL'));
