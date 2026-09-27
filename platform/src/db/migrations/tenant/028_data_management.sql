-- Data management, after the reference platform's Data and Reporting > Data Management pages:
-- the Excel data import and its review, the tenant database backup, the
-- incremental extract and the data dictionary.

-- --------------------------------------------------------------------------
-- Member fields the import template carries (the reference platform's client import sheet)
-- --------------------------------------------------------------------------
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS middle_name       text,
  ADD COLUMN IF NOT EXISTS phone2            text,
  ADD COLUMN IF NOT EXISTS address_line1     text,
  ADD COLUMN IF NOT EXISTS address_line2     text,
  ADD COLUMN IF NOT EXISTS city              text,
  ADD COLUMN IF NOT EXISTS postcode          text,
  ADD COLUMN IF NOT EXISTS region            text,
  ADD COLUMN IF NOT EXISTS country           text,
  ADD COLUMN IF NOT EXISTS notes             text,
  ADD COLUMN IF NOT EXISTS credit_officer    text,
  -- Loan cycles completed in the system the member came from. Counted with
  -- the cycles completed here wherever a product asks for a cycle count.
  ADD COLUMN IF NOT EXISTS prior_loan_cycles int NOT NULL DEFAULT 0 CHECK (prior_loan_cycles >= 0);

-- --------------------------------------------------------------------------
-- The chart of accounts: headers group, details are posted to (the reference platform's GL
-- account usage). Every account created so far is a detail account.
-- --------------------------------------------------------------------------
ALTER TABLE gl_accounts
  ADD COLUMN IF NOT EXISTS usage text NOT NULL DEFAULT 'DETAIL' CHECK (usage IN ('HEADER', 'DETAIL'));

-- --------------------------------------------------------------------------
-- Installments already late when a loan was imported: the late fee for them
-- was charged, or not, in the system the loan came from.
-- --------------------------------------------------------------------------
ALTER TABLE loan_installments
  ADD COLUMN IF NOT EXISTS late_fee_exempt boolean NOT NULL DEFAULT false;

-- --------------------------------------------------------------------------
-- Imports. The uploaded workbook is validated by running the whole import in
-- a transaction that is rolled back; nothing reaches the live tables until
-- someone approves it, and then it is run again for real. `pending` holds
-- the parsed rows between the two.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name     text NOT NULL,
  file_size     int NOT NULL,
  sha256        text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING_APPROVAL'
                CHECK (status IN ('INVALID', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'FAILED')),
  as_of         date,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors        jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings      jsonb NOT NULL DEFAULT '[]'::jsonb,
  file          bytea NOT NULL,
  error_file    bytea,
  pending       jsonb,
  entry_id      uuid REFERENCES journal_entries(id),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text
);
CREATE INDEX IF NOT EXISTS data_imports_recent ON data_imports (created_at DESC);

-- What each import created, so a record can be traced to its workbook.
ALTER TABLE branches         ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES data_imports(id);
ALTER TABLE centres          ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES data_imports(id);
ALTER TABLE members          ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES data_imports(id);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES data_imports(id);
ALTER TABLE share_accounts   ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES data_imports(id);
ALTER TABLE loan_accounts    ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES data_imports(id);
ALTER TABLE gl_accounts      ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES data_imports(id);

-- --------------------------------------------------------------------------
-- Database backups (the reference platform's Database Backup API): a ZIP of one CSV per
-- table, taken from one snapshot. One may be in progress at a time.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS database_backups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status          text NOT NULL DEFAULT 'IN_PROGRESS'
                  CHECK (status IN ('IN_PROGRESS', 'COMPLETE', 'FAILED', 'EXPIRED')),
  tables          text[],
  from_date       timestamptz,
  callback_url    text,
  callback_result jsonb,
  file            bytea,
  file_name       text,
  file_size       bigint,
  sha256          text,
  row_counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  expires_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS database_backups_one_running
  ON database_backups ((true)) WHERE status = 'IN_PROGRESS';
CREATE INDEX IF NOT EXISTS database_backups_recent ON database_backups (created_at DESC);

-- --------------------------------------------------------------------------
-- Last-modified times for the incremental extract. A trigger keeps them, so
-- no code path can change a row without the extract seeing it.
-- --------------------------------------------------------------------------
ALTER TABLE savings_accounts  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE share_accounts    ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE loan_installments ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE gl_accounts       ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE transactions      ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE loan_fees         ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE savings_accounts SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE share_accounts   SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE transactions     SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE loan_fees        SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE loan_installments i SET updated_at = COALESCE(l.updated_at, l.created_at)
  FROM loan_accounts l WHERE l.id = i.loan_id AND i.updated_at IS NULL;
UPDATE gl_accounts SET updated_at = now() WHERE updated_at IS NULL;
UPDATE branches SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE centres  SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE savings_accounts  ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE share_accounts    ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE loan_installments ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE gl_accounts       ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE transactions      ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE loan_fees         ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE branches          ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE centres           ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;

-- clock_timestamp, not now(): now() is the start of the transaction, so a
-- long end of day would stamp its last rows with a time long past.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['members', 'branches', 'centres', 'loan_accounts', 'loan_installments',
    'savings_accounts', 'share_accounts', 'loan_products', 'savings_products', 'gl_accounts',
    'transactions', 'loan_fees']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t || '_touch', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (updated_at, %I)', t || '_extract', t,
      CASE t WHEN 'gl_accounts' THEN 'code' ELSE 'id' END);
  END LOOP;
END $$;

-- Append-only tables are extracted on their creation time.
CREATE INDEX IF NOT EXISTS journal_entries_extract ON journal_entries (created_at, id);
CREATE INDEX IF NOT EXISTS audit_log_extract ON audit_log (created_at, id);

-- --------------------------------------------------------------------------
-- An imported deposit account's balance, and an imported share holding, are
-- recorded as the first line of the account's history. No journal entry:
-- the import's opening balances entry carries the money.
-- --------------------------------------------------------------------------
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_kind_check CHECK (kind IN (
    'SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER',
    'SAVINGS_FEE', 'SAVINGS_INTEREST_ACCRUAL', 'SAVINGS_INTEREST_APPLIED', 'SAVINGS_WITHHOLDING_TAX',
    'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED', 'OVERDRAFT_WRITE_OFF', 'ACCOUNT_BRANCH_CHANGE',
    'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'LOAN_FEE', 'LOAN_FEE_WAIVED',
    'LOAN_INTEREST_ACCRUAL', 'LOAN_INTEREST_CAPITALIZED', 'LOAN_WRITE_OFF', 'LOAN_RECOVERY',
    'LOAN_RESCHEDULE', 'LOAN_REFINANCE',
    'LOAN_FUNDED', 'LOAN_REPAID_TO_FUNDER', 'CREDIT_BALANCE_DEPOSIT',
    'SHARE_PURCHASE', 'SHARE_TRANSFER', 'DIVIDEND_PAYOUT', 'REVERSAL',
    'LOAN_BALANCE_WRITE_OFF', 'LOAN_FEE_ADJUSTED', 'LOAN_PENALTY_ADJUSTED',
    'LOAN_RATE_CHANGED', 'LOAN_TERMINATED',
    'LOAN_LOCKED', 'LOAN_LOCK_CHANGED', 'LOAN_UNLOCKED', 'LOAN_CLOSURE_UNDONE',
    'MIGRATION_OPENING_BALANCE'));

ALTER TABLE share_movements DROP CONSTRAINT IF EXISTS share_movements_kind_check;
ALTER TABLE share_movements
  ADD CONSTRAINT share_movements_kind_check CHECK (kind IN ('PURCHASE', 'TRANSFER_IN', 'TRANSFER_OUT', 'REVERSAL', 'MIGRATION'));
