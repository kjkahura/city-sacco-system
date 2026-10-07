-- The daily rollups (007, 013) held one row per GL account per day. Every
-- cash deposit of the day added to the same cash row and the same savings
-- liability row, and each posting kept that row locked until it committed,
-- so concurrent postings in a SACCO queued behind one another. A load test
-- (test/load/postings.js) found postings waiting on those rows for most of
-- their time from eight concurrent tellers up.
--
-- Each account and day is now spread over 16 rows ("slots"). A transaction
-- writes to the slot its transaction ID falls in; transactions running at
-- the same time have consecutive IDs and so take different slots. Every
-- reader already sums the rows for an account and day, so reports and
-- verifyRollup read the same totals. Existing rows are slot 0.

ALTER TABLE gl_daily_balances ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 0;
ALTER TABLE gl_daily_balances DROP CONSTRAINT IF EXISTS gl_daily_balances_pkey;
ALTER TABLE gl_daily_balances ADD PRIMARY KEY (gl_code, booking_date, is_closing, slot);

ALTER TABLE gl_branch_daily_balances ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 0;
ALTER TABLE gl_branch_daily_balances DROP CONSTRAINT IF EXISTS gl_branch_daily_balances_pkey;
ALTER TABLE gl_branch_daily_balances ADD PRIMARY KEY (gl_code, booking_date, branch_key, is_closing, slot);

CREATE OR REPLACE FUNCTION rollup_slot() RETURNS smallint
LANGUAGE sql VOLATILE AS $$
  SELECT (txid_current() % 16)::smallint
$$;

CREATE OR REPLACE FUNCTION roll_journal_line() RETURNS trigger AS $$
DECLARE
  e record;
BEGIN
  SELECT booking_date, source_type INTO e FROM journal_entries WHERE id = NEW.entry_id;
  INSERT INTO gl_daily_balances (gl_code, booking_date, is_closing, slot, debit, credit)
  VALUES (
    NEW.gl_code, e.booking_date, is_closing_source(e.source_type), rollup_slot(),
    CASE WHEN NEW.direction = 'DEBIT'  THEN NEW.amount ELSE 0 END,
    CASE WHEN NEW.direction = 'CREDIT' THEN NEW.amount ELSE 0 END
  )
  ON CONFLICT (gl_code, booking_date, is_closing, slot) DO UPDATE
    SET debit  = gl_daily_balances.debit  + EXCLUDED.debit,
        credit = gl_daily_balances.credit + EXCLUDED.credit;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION roll_journal_line_by_branch() RETURNS trigger AS $$
DECLARE
  e record;
BEGIN
  SELECT booking_date, source_type INTO e FROM journal_entries WHERE id = NEW.entry_id;
  INSERT INTO gl_branch_daily_balances (gl_code, booking_date, branch_key, is_closing, slot, debit, credit)
  VALUES (
    NEW.gl_code, e.booking_date, COALESCE(NEW.branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    is_closing_source(e.source_type), rollup_slot(),
    CASE WHEN NEW.direction = 'DEBIT'  THEN NEW.amount ELSE 0 END,
    CASE WHEN NEW.direction = 'CREDIT' THEN NEW.amount ELSE 0 END
  )
  ON CONFLICT (gl_code, booking_date, branch_key, is_closing, slot) DO UPDATE
    SET debit  = gl_branch_daily_balances.debit  + EXCLUDED.debit,
        credit = gl_branch_daily_balances.credit + EXCLUDED.credit;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
