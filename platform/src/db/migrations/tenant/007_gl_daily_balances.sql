-- Materialised daily balances per GL account.
--
-- Every report so far has been a scan over journal_lines. Paging stopped the
-- scans from reading the whole ledger into the process, but a trial balance
-- over six years of postings is still six years of postings. This table
-- holds one row per account per day, kept current by a trigger, so a report
-- reads days rather than lines: a busy SACCO posts thousands of lines a day
-- to a few hundred accounts, and the rollup is two orders of magnitude
-- smaller than what it summarises.
--
-- It can be kept exact rather than merely fresh because the journal is
-- append-only. Lines cannot be updated or deleted (001_core), and below the
-- same rule is extended to the two entry columns the rollup depends on. An
-- AFTER INSERT trigger is therefore the whole maintenance story: nothing
-- else can change a posted amount, so nothing else can make the rollup
-- drift. `cli ledger:verify` recomputes from the lines and compares, so the
-- claim can be checked rather than trusted.

CREATE TABLE IF NOT EXISTS gl_daily_balances (
  gl_code      text NOT NULL REFERENCES gl_accounts(code),
  booking_date date NOT NULL,
  -- Year-end sweep and reserve transfer entries kept apart, so the income
  -- statement can leave them out without going back to the lines.
  is_closing   boolean NOT NULL,
  debit        numeric(18,2) NOT NULL DEFAULT 0,
  credit       numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (gl_code, booking_date, is_closing)
);

CREATE INDEX IF NOT EXISTS gl_daily_balances_date_idx ON gl_daily_balances (booking_date);

CREATE OR REPLACE FUNCTION is_closing_source(source text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(source IN ('YEAR_END_CLOSE', 'STATUTORY_RESERVE'), false)
$$;

CREATE OR REPLACE FUNCTION roll_journal_line() RETURNS trigger AS $$
DECLARE
  e record;
BEGIN
  SELECT booking_date, source_type INTO e FROM journal_entries WHERE id = NEW.entry_id;
  INSERT INTO gl_daily_balances (gl_code, booking_date, is_closing, debit, credit)
  VALUES (
    NEW.gl_code, e.booking_date, is_closing_source(e.source_type),
    CASE WHEN NEW.direction = 'DEBIT'  THEN NEW.amount ELSE 0 END,
    CASE WHEN NEW.direction = 'CREDIT' THEN NEW.amount ELSE 0 END
  )
  ON CONFLICT (gl_code, booking_date, is_closing) DO UPDATE
    SET debit  = gl_daily_balances.debit  + EXCLUDED.debit,
        credit = gl_daily_balances.credit + EXCLUDED.credit;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_roll ON journal_lines;
CREATE TRIGGER journal_lines_roll
  AFTER INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION roll_journal_line();

-- The rollup keys on the entry's date and source type, so those two columns
-- have to be as immutable as the lines are. Nothing in the application
-- updates an entry, and now nothing outside it can either.
CREATE OR REPLACE FUNCTION forbid_entry_rekey() RETURNS trigger AS $$
BEGIN
  IF NEW.booking_date IS DISTINCT FROM OLD.booking_date
     OR NEW.source_type IS DISTINCT FROM OLD.source_type THEN
    RAISE EXCEPTION 'journal entry date and source type are immutable once posted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_no_rekey ON journal_entries;
CREATE TRIGGER journal_entries_no_rekey
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_entry_rekey();

-- Backfill from whatever is already posted. Exact, not incremental: the
-- table is emptied and rebuilt, so rerunning this on a tenant that somehow
-- had partial rows cannot double-count.
TRUNCATE gl_daily_balances;
INSERT INTO gl_daily_balances (gl_code, booking_date, is_closing, debit, credit)
SELECT l.gl_code, e.booking_date, is_closing_source(e.source_type),
       SUM(CASE WHEN l.direction = 'DEBIT'  THEN l.amount ELSE 0 END),
       SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE 0 END)
FROM journal_lines l
JOIN journal_entries e ON e.id = l.entry_id
GROUP BY l.gl_code, e.booking_date, is_closing_source(e.source_type);
