-- Deposits > overdraft terms, after the reference platform: how often an index rate is
-- reviewed (the reference platform's Interest Rate Review Frequency), for the credit rate
-- and the overdraft rate. Unset keeps the platform's rule: the index rate
-- in force each day.
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_review_count integer CHECK (interest_review_count IS NULL OR interest_review_count > 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS interest_review_unit text CHECK (interest_review_unit IS NULL OR interest_review_unit IN ('DAYS', 'WEEKS', 'MONTHS'));
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_review_count integer CHECK (od_review_count IS NULL OR od_review_count > 0);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS od_review_unit text CHECK (od_review_unit IS NULL OR od_review_unit IN ('DAYS', 'WEEKS', 'MONTHS'));
ALTER TABLE savings_products DROP CONSTRAINT IF EXISTS savings_products_review_pairs;
ALTER TABLE savings_products ADD CONSTRAINT savings_products_review_pairs
  CHECK ((interest_review_count IS NULL) = (interest_review_unit IS NULL) AND (od_review_count IS NULL) = (od_review_unit IS NULL));
