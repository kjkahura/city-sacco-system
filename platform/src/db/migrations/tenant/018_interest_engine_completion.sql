-- The rest of Mambu's "Configure interest and schedule" interest engine:
-- currency decimals for amounts worked out from a rate, leftover principal
-- on the first or last installment, compound interest with daily rest, the
-- BUS/252 day count, and penalties that carry their fraction of a cent like
-- interest does.

-- The currency's minor units, from the tenant's currency: 0 for currencies
-- without cents in use (UGX, RWF, JPY), 3 for the dinars, 2 otherwise.
ALTER TABLE accounting_settings
  ADD COLUMN IF NOT EXISTS currency_decimals smallint NOT NULL DEFAULT 2 CHECK (currency_decimals BETWEEN 0 AND 4);
UPDATE accounting_settings SET currency_decimals = CASE
    (SELECT currency_code FROM platform.tenants WHERE schema_name = current_schema())
    WHEN 'UGX' THEN 0 WHEN 'RWF' THEN 0 WHEN 'BIF' THEN 0 WHEN 'JPY' THEN 0 WHEN 'KRW' THEN 0
    WHEN 'XAF' THEN 0 WHEN 'XOF' THEN 0 WHEN 'GNF' THEN 0 WHEN 'KMF' THEN 0 WHEN 'DJF' THEN 0
    WHEN 'JOD' THEN 3 WHEN 'BHD' THEN 3 WHEN 'KWD' THEN 3 WHEN 'OMR' THEN 3 WHEN 'TND' THEN 3
    WHEN 'LYD' THEN 3 WHEN 'IQD' THEN 3
    ELSE 2 END;

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS residual_installment text NOT NULL DEFAULT 'LAST'
    CHECK (residual_installment IN ('FIRST', 'LAST'));

ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_interest_type_check;
ALTER TABLE loan_products ADD CONSTRAINT loan_products_interest_type_check
  CHECK (interest_type IN ('SIMPLE', 'CAPITALIZED', 'COMPOUND', 'COMPOUND_DAILY_REST'));
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_day_count_check;
ALTER TABLE loan_products ADD CONSTRAINT loan_products_day_count_check
  CHECK (day_count IN ('THIRTY_360', 'ACTUAL_365', 'ACTUAL_360', 'ACTUAL_ACTUAL', 'BUS_252'));

-- A carried fraction is under one minor unit whatever the currency.
ALTER TABLE loan_accounts DROP CONSTRAINT IF EXISTS loan_accounts_interest_accrual_carry_check;
ALTER TABLE loan_accounts ADD CONSTRAINT loan_accounts_interest_accrual_carry_check
  CHECK (abs(interest_accrual_carry) < 1);
ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS penalty_accrual_carry numeric(38,20) NOT NULL DEFAULT 0 CHECK (abs(penalty_accrual_carry) < 1);
