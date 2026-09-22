-- Loan loss provisioning by portfolio-at-risk bucket.
--
-- No rates are shipped. The bands below carry the day ranges the PAR report
-- already uses, with rate_percent left NULL, and provisioning refuses to run
-- until every band has a rate. That is deliberate: a provisioning rate is a
-- regulatory figure, and a plausible-looking default that nobody checked is
-- worse than an empty column, because it produces numbers a board might
-- believe.

-- The contra-asset the allowance sits in. Classed as LOAN_PORTFOLIO so that
-- prudential inputs and the balance sheet both see the portfolio net of the
-- allowance, which is what "total assets" is supposed to mean.
INSERT INTO gl_accounts (code, name, type, regulatory_class)
VALUES ('100-150', 'Allowance for Loan Losses', 'ASSET', 'LOAN_PORTFOLIO')
ON CONFLICT (code) DO UPDATE SET regulatory_class = EXCLUDED.regulatory_class;

CREATE TABLE IF NOT EXISTS provision_bands (
  code         text PRIMARY KEY,
  label        text NOT NULL,
  min_days     int  NOT NULL CHECK (min_days >= 0),
  -- NULL is the open-ended top band.
  max_days     int,
  -- NULL means "not configured". Provisioning refuses to run while any band
  -- is NULL rather than treating an unset rate as zero.
  rate_percent numeric(6,3) CHECK (rate_percent >= 0 AND rate_percent <= 100),
  sort_order   int NOT NULL DEFAULT 0,
  source_note  text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (max_days IS NULL OR max_days >= min_days)
);

-- Overlapping bands would double-provision the loans in the overlap and the
-- error would show up as a number slightly too large, which is exactly the
-- kind of mistake nobody catches by reading a report. The database refuses
-- the overlap instead.
ALTER TABLE provision_bands DROP CONSTRAINT IF EXISTS provision_bands_no_overlap;
ALTER TABLE provision_bands ADD CONSTRAINT provision_bands_no_overlap
  EXCLUDE USING gist (
    int4range(min_days, COALESCE(max_days + 1, 2147483647)) WITH &&
  );

INSERT INTO provision_bands (code, label, min_days, max_days, rate_percent, sort_order, source_note) VALUES
  ('PERFORMING',  'Performing',   0,   0,    NULL, 1, 'Rate not set. Enter the rate your regulator requires.'),
  ('WATCH',       'Watch',        1,   30,   NULL, 2, 'Rate not set. Enter the rate your regulator requires.'),
  ('SUBSTANDARD', 'Substandard',  31,  180,  NULL, 3, 'Rate not set. Enter the rate your regulator requires.'),
  ('DOUBTFUL',    'Doubtful',     181, 360,  NULL, 4, 'Rate not set. Enter the rate your regulator requires.'),
  ('LOSS',        'Loss',         361, NULL, NULL, 5, 'Rate not set. Enter the rate your regulator requires.')
ON CONFLICT (code) DO NOTHING;

-- One provisioning run per as-at date. The movement, not the required
-- balance, is what gets posted: the allowance is a standing balance and each
-- run moves it to where it should be.
CREATE TABLE IF NOT EXISTS provision_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_at          date NOT NULL,
  required_total numeric(18,2) NOT NULL,
  previous_total numeric(18,2) NOT NULL,
  movement       numeric(18,2) NOT NULL,
  gl_allowance   text NOT NULL REFERENCES gl_accounts(code),
  gl_expense     text NOT NULL REFERENCES gl_accounts(code),
  entry_id       uuid REFERENCES journal_entries(id),
  status         text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- A rerun for the same date is refused by the index, not by the job
-- remembering it already ran. A reversed run leaves the date free again.
CREATE UNIQUE INDEX IF NOT EXISTS provision_one_live_run_per_date
  ON provision_runs (as_at) WHERE status = 'POSTED';

CREATE TABLE IF NOT EXISTS provision_run_lines (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES provision_runs(id) ON DELETE CASCADE,
  band_code   text NOT NULL,
  loans       int NOT NULL,
  outstanding numeric(18,2) NOT NULL,
  rate        numeric(6,3) NOT NULL,
  required    numeric(18,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS provision_run_lines_run_idx ON provision_run_lines (run_id);
