-- Deposits > Deposit Products, after the reference platform. Every setting added here starts
-- where the platform already was, so running products and accounts behave
-- as before until a tenant changes them.

-- --------------------------------------------------------------------------
-- Product type and category. A product with overdrafts (or technical
-- overdrafts) is a current account, a funding product an investor account,
-- the rest savings accounts.
-- --------------------------------------------------------------------------
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS product_type text;
UPDATE savings_products SET product_type = CASE
    WHEN is_funding_account THEN 'INVESTOR_ACCOUNT'
    WHEN allow_overdraft OR allow_technical_overdraft THEN 'CURRENT_ACCOUNT'
    ELSE 'SAVINGS_ACCOUNT' END
 WHERE product_type IS NULL;
ALTER TABLE savings_products ALTER COLUMN product_type SET DEFAULT 'SAVINGS_ACCOUNT';
ALTER TABLE savings_products ALTER COLUMN product_type SET NOT NULL;
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'UNCATEGORIZED';
-- A writer that does not name the type (an older script, a direct insert)
-- gets the one its settings imply, as the API derives it: a funding product
-- is an investor account, and a savings account given overdrafts a current
-- account.
CREATE OR REPLACE FUNCTION savings_product_type_follows() RETURNS trigger AS $$
BEGIN
  IF NEW.is_funding_account AND NEW.product_type = 'SAVINGS_ACCOUNT' THEN NEW.product_type := 'INVESTOR_ACCOUNT'; END IF;
  IF NOT NEW.is_funding_account AND NEW.product_type = 'INVESTOR_ACCOUNT'
     AND (TG_OP = 'INSERT' OR OLD.is_funding_account) THEN NEW.product_type := 'SAVINGS_ACCOUNT'; END IF;
  IF (NEW.allow_overdraft OR NEW.allow_technical_overdraft) AND NEW.product_type = 'SAVINGS_ACCOUNT' THEN NEW.product_type := 'CURRENT_ACCOUNT'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS savings_product_type ON savings_products;
CREATE TRIGGER savings_product_type BEFORE INSERT OR UPDATE ON savings_products FOR EACH ROW EXECUTE FUNCTION savings_product_type_follows();
DO $$ BEGIN
  ALTER TABLE savings_products ADD CONSTRAINT savings_products_product_type_check
    CHECK (product_type IN ('CURRENT_ACCOUNT', 'SAVINGS_ACCOUNT', 'FIXED_DEPOSIT', 'SAVINGS_PLAN', 'INVESTOR_ACCOUNT'));
  ALTER TABLE savings_products ADD CONSTRAINT savings_products_category_check
    CHECK (category IN ('STORED_VALUE', 'DAILY_BANKING', 'PERSONAL_DEPOSIT', 'BUSINESS_BANKING', 'BUSINESS_DEPOSIT', 'UNCATEGORIZED'));
  -- Overdrafts and technical overdrafts are for current accounts (the reference platform).
  ALTER TABLE savings_products ADD CONSTRAINT savings_products_overdraft_is_current
    CHECK (product_type = 'CURRENT_ACCOUNT' OR NOT (allow_overdraft OR allow_technical_overdraft));
  ALTER TABLE savings_products ADD CONSTRAINT savings_products_funding_is_investor
    CHECK (is_funding_account = (product_type = 'INVESTOR_ACCOUNT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- New account numbers per product: a random pattern (# a digit, @ a letter,
-- $ either) or an incremental number from a starting number. Unset keeps
-- the shared SA series.
-- --------------------------------------------------------------------------
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS id_generator_type text
  CHECK (id_generator_type IS NULL OR id_generator_type IN ('RANDOM_PATTERN', 'INCREMENTAL_NUMBER'));
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS id_pattern text;
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS id_next bigint;

-- --------------------------------------------------------------------------
-- Interest
-- --------------------------------------------------------------------------
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_rate_terms text NOT NULL DEFAULT 'FIXED'
  CHECK (interest_rate_terms IN ('FIXED', 'INDEX', 'TIERED_BALANCE', 'TIERED_BANDS', 'TIERED_PERIOD'));
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_rate_min numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_rate_max numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_rate_frequency text NOT NULL DEFAULT 'ANNUALIZED'
  CHECK (interest_rate_frequency IN ('ANNUALIZED', 'EVERY_MONTH', 'EVERY_FOUR_WEEKS', 'EVERY_WEEK', 'EVERY_X_DAYS'));
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_rate_x_days int CHECK (interest_rate_x_days IS NULL OR interest_rate_x_days > 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_index_source_id text REFERENCES index_rate_sources(id);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_spread_min numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_spread_max numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_spread_default numeric(9,4);
-- [{ "ending": balance or day, "rate": n }], ending ascending; the last may be null (no ceiling).
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_rate_tiers jsonb NOT NULL DEFAULT '[]';
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_max_balance numeric(18,2) CHECK (interest_max_balance IS NULL OR interest_max_balance > 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_fixed_dates text[];
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS collect_interest_when_locked boolean NOT NULL DEFAULT true;
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS accrue_interest_after_maturity boolean NOT NULL DEFAULT false;

ALTER TABLE savings_products DROP CONSTRAINT IF EXISTS savings_products_interest_calc_balance_check;
ALTER TABLE savings_products ADD CONSTRAINT savings_products_interest_calc_balance_check
  CHECK (interest_calc_balance IN ('END_OF_DAY', 'MINIMUM', 'MINIMUM_DAILY', 'AVERAGE_DAILY'));
ALTER TABLE savings_products DROP CONSTRAINT IF EXISTS savings_products_interest_day_count_check;
ALTER TABLE savings_products ADD CONSTRAINT savings_products_interest_day_count_check
  CHECK (interest_day_count IN ('ACTUAL_365', 'ACTUAL_360', 'THIRTY_360', 'ACTUAL_ACTUAL_ISDA'));
ALTER TABLE savings_products DROP CONSTRAINT IF EXISTS savings_products_interest_application_check;
ALTER TABLE savings_products ADD CONSTRAINT savings_products_interest_application_check
  CHECK (interest_application IN ('MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL', 'DAILY', 'FIRST_DAY_OF_MONTH', 'WEEKLY',
    'EVERY_OTHER_WEEK', 'MONTHLY_FROM_ACTIVATION', 'QUARTERLY_FROM_ACTIVATION', 'SEMI_ANNUAL_FROM_ACTIVATION', 'ANNUAL_FROM_ACTIVATION',
    'FIXED_DATES', 'ON_MATURITY'));

-- --------------------------------------------------------------------------
-- Deposits, withdrawals, term and dormancy
-- --------------------------------------------------------------------------
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS recommended_deposit_amount numeric(18,2) CHECK (recommended_deposit_amount IS NULL OR recommended_deposit_amount >= 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS max_withdrawal_amount numeric(18,2) CHECK (max_withdrawal_amount IS NULL OR max_withdrawal_amount >= 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS min_opening_balance numeric(18,2) CHECK (min_opening_balance IS NULL OR min_opening_balance >= 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS max_opening_balance numeric(18,2) CHECK (max_opening_balance IS NULL OR max_opening_balance >= 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS default_opening_balance numeric(18,2) CHECK (default_opening_balance IS NULL OR default_opening_balance >= 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS term_unit text CHECK (term_unit IS NULL OR term_unit IN ('DAYS', 'WEEKS', 'MONTHS'));
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS term_min int CHECK (term_min IS NULL OR term_min > 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS term_max int CHECK (term_max IS NULL OR term_max > 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS term_default int CHECK (term_default IS NULL OR term_default > 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS dormancy_days int CHECK (dormancy_days IS NULL OR dormancy_days > 0);

-- --------------------------------------------------------------------------
-- Fees: arbitrary amounts allowed per product (every product, new ones
-- too, keeps allowing them until the tenant turns them off: API clients
-- charge them today), and how a monthly fee is dated (existing monthly fees
-- keep the last day).
-- --------------------------------------------------------------------------
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS allow_arbitrary_fees boolean NOT NULL DEFAULT true;
ALTER TABLE savings_products ALTER COLUMN allow_arbitrary_fees SET DEFAULT true;
ALTER TABLE savings_product_fees ADD COLUMN IF NOT EXISTS apply_date_method text;
UPDATE savings_product_fees SET apply_date_method = 'END_OF_MONTH' WHERE trigger = 'MONTHLY' AND apply_date_method IS NULL;
DO $$ BEGIN
  ALTER TABLE savings_product_fees ADD CONSTRAINT savings_product_fees_apply_date_method_check
    CHECK ((trigger = 'MONTHLY' AND apply_date_method IN ('END_OF_MONTH', 'FIRST_DAY_OF_MONTH', 'MONTHLY_FROM_ACTIVATION'))
        OR (trigger <> 'MONTHLY' AND apply_date_method IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- Overdraft interest: fixed with a range, tiered per balance, or an index
-- plus spread, with its own day count and balance.
-- --------------------------------------------------------------------------
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_rate_terms text NOT NULL DEFAULT 'FIXED'
  CHECK (od_rate_terms IN ('FIXED', 'INDEX', 'TIERED_BALANCE'));
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_rate_min numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_rate_max numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_index_source_id text REFERENCES index_rate_sources(id);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_spread_min numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_spread_max numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_spread_default numeric(9,4);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_rate_tiers jsonb NOT NULL DEFAULT '[]';
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_day_count text
  CHECK (od_day_count IS NULL OR od_day_count IN ('ACTUAL_365', 'ACTUAL_360', 'THIRTY_360', 'ACTUAL_ACTUAL_ISDA'));
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_calc_balance text NOT NULL DEFAULT 'END_OF_DAY'
  CHECK (od_calc_balance IN ('END_OF_DAY', 'MINIMUM_DAILY'));

-- --------------------------------------------------------------------------
-- Accounts: their own rate or spread, a maximum balance, the term and
-- maturity, the last financial activity (dormancy), and the MATURED state.
-- --------------------------------------------------------------------------
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS interest_rate numeric(9,4);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS interest_spread numeric(9,4);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS overdraft_spread numeric(9,4);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS max_balance numeric(18,2) CHECK (max_balance IS NULL OR max_balance >= 0);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS term_length int CHECK (term_length IS NULL OR term_length > 0);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS maturity_started_on date;
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS maturity_date date;
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS last_activity_on date;
UPDATE savings_accounts a SET last_activity_on = GREATEST(a.opened_on, COALESCE((
    SELECT max(t.value_date) FROM transactions t WHERE t.savings_account_id = a.id
       AND t.kind IN ('SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER')), a.opened_on))
 WHERE a.last_activity_on IS NULL;
ALTER TABLE savings_accounts DROP CONSTRAINT IF EXISTS savings_accounts_status_check;
ALTER TABLE savings_accounts ADD CONSTRAINT savings_accounts_status_check
  CHECK (status IN ('PENDING', 'ACTIVE', 'DORMANT', 'LOCKED', 'MATURED', 'CLOSED'));

-- A matured account is still open: it counts for the holder being ACTIVE.
CREATE OR REPLACE FUNCTION refresh_member_state(mid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE cur text; nxt text;
BEGIN
  SELECT status INTO cur FROM members WHERE id = mid;
  IF cur IS NULL OR cur NOT IN ('INACTIVE', 'ACTIVE') THEN RETURN; END IF;
  nxt := CASE WHEN
      EXISTS (SELECT 1 FROM loan_accounts l WHERE l.member_id = mid AND l.status IN ('ACTIVE', 'IN_ARREARS', 'LOCKED'))
      OR EXISTS (SELECT 1 FROM savings_accounts a WHERE a.member_id = mid AND a.status IN ('ACTIVE', 'DORMANT', 'LOCKED', 'MATURED'))
    THEN 'ACTIVE' ELSE 'INACTIVE' END;
  IF nxt = cur THEN RETURN; END IF;
  UPDATE members SET status = nxt, activated_at = COALESCE(activated_at, CASE WHEN nxt = 'ACTIVE' THEN now() END) WHERE id = mid;
  INSERT INTO member_state_changes (member_id, from_state, to_state, action) VALUES (mid, cur, nxt, 'AUTOMATIC');
END $$;

-- --------------------------------------------------------------------------
-- The day's balance movements, for the minimum and average daily balance:
-- the balance the day opened with, the lowest it went, and the balances
-- after each movement (the reference platform's average is of those).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_intraday_balances (
  account_id    uuid NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE,
  day           date NOT NULL,
  open_balance  numeric(18,2) NOT NULL,
  min_balance   numeric(18,2) NOT NULL,
  sum_after     numeric(24,2) NOT NULL,
  movements     int NOT NULL,
  PRIMARY KEY (account_id, day)
);
CREATE OR REPLACE FUNCTION savings_intraday_track() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO savings_intraday_balances AS x (account_id, day, open_balance, min_balance, sum_after, movements)
  VALUES (NEW.id, current_date, OLD.balance, LEAST(OLD.balance, NEW.balance), NEW.balance, 1)
  ON CONFLICT (account_id, day) DO UPDATE SET min_balance = LEAST(x.min_balance, EXCLUDED.min_balance),
    sum_after = x.sum_after + EXCLUDED.sum_after, movements = x.movements + 1;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS savings_intraday ON savings_accounts;
CREATE TRIGGER savings_intraday AFTER UPDATE OF balance ON savings_accounts
  FOR EACH ROW WHEN (OLD.balance IS DISTINCT FROM NEW.balance) EXECUTE FUNCTION savings_intraday_track();

-- Interest rate changes: on a product (to all or new accounts) or on one account.
CREATE TABLE IF NOT EXISTS savings_interest_rate_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  text REFERENCES savings_products(id) ON DELETE CASCADE,
  account_id  uuid REFERENCES savings_accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('CREDIT', 'OVERDRAFT')),
  scope       text NOT NULL CHECK (scope IN ('ALL_ACCOUNTS', 'NEW_ACCOUNTS', 'ACCOUNT')),
  value_date  date NOT NULL,
  old_rate    numeric(9,4),
  new_rate    numeric(9,4),
  notes       text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS savings_interest_rate_changes_account_idx ON savings_interest_rate_changes (account_id);

-- --------------------------------------------------------------------------
-- The reference platform's deposit permissions for what this adds, given to the roles that
-- hold the matching deposit permission.
-- --------------------------------------------------------------------------
DO $$
DECLARE pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['MAKE_DEPOSIT', 'ACTIVATE_MATURITY'],
    ['EDIT_SAVINGS_ACCOUNT', 'UNDO_MATURITY'],
    ['EDIT_SAVINGS_ACCOUNT', 'MAKE_EARLY_WITHDRAWALS'],
    ['EDIT_SAVINGS_ACCOUNT', 'POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS']]
  LOOP
    UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY[pair[2]]::text[]) c ORDER BY c)
     WHERE pair[1] = ANY (permissions) AND NOT (pair[2] = ANY (permissions));
  END LOOP;
END $$;
