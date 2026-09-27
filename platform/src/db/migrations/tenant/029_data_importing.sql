-- Data importing, after the reference platform's Data Importing pages: imports processed in
-- the background with progress and a preview, the reference platform's data import API with
-- idempotent actions, loan migration fields, deposit account details the
-- template carries, and imported penalties.

-- --------------------------------------------------------------------------
-- Imports run in the background: QUEUED, then IN_PROGRESS with a
-- percentage, then one of the outcomes. ERROR is a file that could not be
-- processed at all (or a run that was interrupted).
-- --------------------------------------------------------------------------
ALTER TABLE data_imports DROP CONSTRAINT IF EXISTS data_imports_status_check;
ALTER TABLE data_imports ADD CONSTRAINT data_imports_status_check CHECK (status IN (
  'QUEUED', 'IN_PROGRESS', 'ERROR', 'INVALID', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'FAILED'));
ALTER TABLE data_imports
  ADD COLUMN IF NOT EXISTS progress     int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS progress_at  timestamptz,
  ADD COLUMN IF NOT EXISTS started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at  timestamptz,
  -- What approval would create, record by record, captured during the
  -- validation run: the reviewer's view of the data before it exists.
  ADD COLUMN IF NOT EXISTS preview      jsonb;

-- --------------------------------------------------------------------------
-- Idempotency keys (the reference platform's Idempotency-Key header): a repeated request with
-- the same key gets the first response instead of acting twice.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_idempotency (
  key          text PRIMARY KEY,
  route        text NOT NULL,
  request_hash text NOT NULL,
  status       int NOT NULL,
  response     jsonb,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_idempotency_age ON api_idempotency (created_at);

-- --------------------------------------------------------------------------
-- Deposit account details from the template (the reference platform's deposit accounts
-- sheet): when the account was applied for, notes, and an overdraft rate of
-- its own in place of the product's.
-- --------------------------------------------------------------------------
ALTER TABLE savings_accounts
  ADD COLUMN IF NOT EXISTS applied_on    date,
  ADD COLUMN IF NOT EXISTS notes         text,
  ADD COLUMN IF NOT EXISTS overdraft_rate numeric(8,4) CHECK (overdraft_rate IS NULL OR overdraft_rate >= 0);

-- Notes on a GL account (the chart of accounts sheet).
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS notes text;

-- The migration fields a loan was created with (the reference platform's external
-- migration), kept as given for audit.
ALTER TABLE loan_accounts ADD COLUMN IF NOT EXISTS migration_fields jsonb;

-- A penalty brought across from the system a loan came from: owed, but
-- never worked out here.
ALTER TABLE penalty_charges ADD COLUMN IF NOT EXISTS imported boolean NOT NULL DEFAULT false;
