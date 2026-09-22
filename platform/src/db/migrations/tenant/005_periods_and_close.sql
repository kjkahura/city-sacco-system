-- Financial years, the year-end close, and the lock that makes a closed year
-- actually closed.

-- Both accounts are created here rather than assumed. Migrations run before
-- provisioning seeds the chart of accounts, so on a fresh tenant the table
-- is empty at this point and the foreign keys below would have nothing to
-- point at.
INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('300-200', 'Retained Earnings', 'EQUITY', 'INSTITUTIONAL_CAPITAL'),
  ('300-300', 'Statutory Reserve', 'EQUITY', 'INSTITUTIONAL_CAPITAL')
ON CONFLICT (code) DO UPDATE SET regulatory_class = EXCLUDED.regulatory_class;

CREATE TABLE IF NOT EXISTS financial_years (
  year       int PRIMARY KEY,
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  status     text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_at  timestamptz,
  closed_by  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on > starts_on)
);

-- Two financial years cannot cover the same day. Without this, a posting
-- could fall in an open year and a closed one at the same time and the lock
-- below would depend on which row Postgres happened to find first.
ALTER TABLE financial_years DROP CONSTRAINT IF EXISTS financial_years_no_overlap;
ALTER TABLE financial_years ADD CONSTRAINT financial_years_no_overlap
  EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&);

-- Single-row settings table. The percentage starts NULL: how much of the
-- surplus goes to the statutory reserve is set by regulation and by the
-- society's own by-laws, and this system is not going to guess it.
CREATE TABLE IF NOT EXISTS close_settings (
  only_row                  boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  statutory_reserve_percent numeric(6,3) CHECK (statutory_reserve_percent >= 0
                                                AND statutory_reserve_percent <= 100),
  gl_retained_earnings      text NOT NULL DEFAULT '300-200' REFERENCES gl_accounts(code),
  gl_statutory_reserve      text NOT NULL DEFAULT '300-300' REFERENCES gl_accounts(code),
  source_note               text,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

INSERT INTO close_settings (only_row, statutory_reserve_percent, source_note)
VALUES (true, NULL, 'Statutory reserve percentage not set. Enter the figure your regulator and by-laws require before closing a year.')
ON CONFLICT (only_row) DO NOTHING;

CREATE TABLE IF NOT EXISTS year_end_closes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year             int NOT NULL REFERENCES financial_years(year),
  total_income     numeric(18,2) NOT NULL,
  total_expenses   numeric(18,2) NOT NULL,
  surplus          numeric(18,2) NOT NULL,
  reserve_percent  numeric(6,3) NOT NULL,
  reserve_amount   numeric(18,2) NOT NULL,
  retained_amount  numeric(18,2) NOT NULL,
  close_entry_id   uuid REFERENCES journal_entries(id),
  reserve_entry_id uuid REFERENCES journal_entries(id),
  status           text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_live_close_per_year
  ON year_end_closes (year) WHERE status = 'POSTED';

-- The lock. A closed year refuses new postings at the database, so it does
-- not matter which code path, script or psql session tries: last year's
-- audited numbers cannot move. The close itself posts while the year is
-- still OPEN and flips the status afterwards, inside the same transaction.
CREATE OR REPLACE FUNCTION forbid_posting_into_closed_year() RETURNS trigger AS $$
DECLARE
  closed_year int;
BEGIN
  SELECT year INTO closed_year FROM financial_years
   WHERE NEW.booking_date BETWEEN starts_on AND ends_on
     AND status = 'CLOSED';
  IF FOUND THEN
    RAISE EXCEPTION 'financial year % is closed; nothing can be posted on %', closed_year, NEW.booking_date
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_closed_year ON journal_entries;
CREATE TRIGGER journal_entries_closed_year
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_posting_into_closed_year();
