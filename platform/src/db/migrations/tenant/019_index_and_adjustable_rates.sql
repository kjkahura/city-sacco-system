-- Index interest rates and Adjustable Interest Rates, after Mambu's
-- "Interest Rate Source", "Customizing Index Rates" and "Adjustable Interest
-- Rates".
--
-- An index rate source (a central bank rate, an interbank rate) keeps a
-- history of values by the date each took effect. A product's interest rate
-- source is FIXED or INDEX; an INDEX product's rate is the index plus a
-- spread (the product's rate and band are the spread's), within a floor and
-- ceiling, reviewed every N days, weeks or months. A product with
-- adjustable rates lets each loan carry a list of periods, each fixed or
-- indexed, valid from a date. Every change of a loan's rate is recorded.

CREATE TABLE IF NOT EXISTS index_rate_sources (
  id          text PRIMARY KEY CHECK (id ~ '^[A-Z0-9_]{2,20}$'),
  name        text NOT NULL,
  notes       text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS index_rates (
  source_id   text NOT NULL REFERENCES index_rate_sources(id) ON DELETE CASCADE,
  valid_from  date NOT NULL,
  rate        numeric(9,4) NOT NULL,
  notes       text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, valid_from)
);

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS interest_rate_source text NOT NULL DEFAULT 'FIXED' CHECK (interest_rate_source IN ('FIXED', 'INDEX')),
  ADD COLUMN IF NOT EXISTS index_source_id text REFERENCES index_rate_sources(id),
  ADD COLUMN IF NOT EXISTS rate_floor numeric(9,4),
  ADD COLUMN IF NOT EXISTS rate_ceiling numeric(9,4),
  ADD COLUMN IF NOT EXISTS rate_review_count int CHECK (rate_review_count IS NULL OR rate_review_count > 0),
  ADD COLUMN IF NOT EXISTS rate_review_unit text CHECK (rate_review_unit IS NULL OR rate_review_unit IN ('DAYS', 'WEEKS', 'MONTHS')),
  ADD COLUMN IF NOT EXISTS adjustable_rates boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allowed_index_sources text[],
  ADD COLUMN IF NOT EXISTS allow_negative_rate boolean NOT NULL DEFAULT false;
ALTER TABLE loan_products ADD CONSTRAINT loan_products_index_needs_a_source
  CHECK (interest_rate_source <> 'INDEX' OR index_source_id IS NOT NULL);
ALTER TABLE loan_products ADD CONSTRAINT loan_products_floor_below_ceiling
  CHECK (rate_floor IS NULL OR rate_ceiling IS NULL OR rate_floor <= rate_ceiling);

-- INDEX: the one period an indexed loan gets at disbursement.
-- ADJUSTABLE: periods given when the loan was opened.
ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS rate_plan text CHECK (rate_plan IS NULL OR rate_plan IN ('INDEX', 'ADJUSTABLE'));
ALTER TABLE loan_accounts ALTER COLUMN monthly_rate TYPE numeric(9,4);

CREATE TABLE IF NOT EXISTS loan_rate_periods (
  loan_id          uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  valid_from       date NOT NULL,
  source           text NOT NULL CHECK (source IN ('FIXED', 'INDEX')),
  index_source_id  text REFERENCES index_rate_sources(id),
  rate             numeric(9,4) NOT NULL,          -- the rate (FIXED) or the spread (INDEX)
  floor            numeric(9,4),
  ceiling          numeric(9,4),
  review_count     int CHECK (review_count IS NULL OR review_count > 0),
  review_unit      text CHECK (review_unit IS NULL OR review_unit IN ('DAYS', 'WEEKS', 'MONTHS')),
  PRIMARY KEY (loan_id, valid_from),
  CHECK (source <> 'INDEX' OR (index_source_id IS NOT NULL AND review_count IS NOT NULL AND review_unit IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS loan_rate_changes (
  id               bigserial PRIMARY KEY,
  loan_id          uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  reviewed_on      date NOT NULL,
  effective_from   date NOT NULL,
  old_rate         numeric(9,4),
  new_rate         numeric(9,4) NOT NULL,
  source           text NOT NULL,
  index_source_id  text,
  index_rate       numeric(9,4),
  spread           numeric(9,4),
  reason           text NOT NULL,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_rate_changes_loan_idx ON loan_rate_changes (loan_id, effective_from);
