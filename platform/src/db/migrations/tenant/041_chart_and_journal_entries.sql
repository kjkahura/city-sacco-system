-- Accounting after the reference platform (docs/audits/audit-accounting.md): the chart
-- of accounts managed through the API, manual journal entries with their
-- files, and a closure's notes kept editable.

-- --------------------------------------------------------------------------
-- Allow Manual Journal Entries, per detail account. On for every existing
-- detail account except the control accounts products post their balances
-- to (Portfolio Control, Savings Control, Overdraft Portfolio Control): a
-- manual entry there puts the ledger out of step with the accounts. Off for
-- header accounts, which take no entries.
-- --------------------------------------------------------------------------
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS allow_manual_entries boolean NOT NULL DEFAULT true;

UPDATE gl_accounts g SET allow_manual_entries = false
 WHERE g.usage = 'HEADER'
    OR EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_code = g.code)
    OR g.code IN (SELECT gl_portfolio FROM loan_products WHERE gl_portfolio IS NOT NULL)
    OR g.code IN (SELECT gl_liability FROM savings_products WHERE gl_liability IS NOT NULL)
    OR g.code IN (SELECT gl_od_portfolio FROM savings_products WHERE gl_od_portfolio IS NOT NULL);

-- When an account was created; unknown (NULL) for the accounts before this.
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE gl_accounts ALTER COLUMN created_at SET DEFAULT now();

-- --------------------------------------------------------------------------
-- The reference platform's transaction ID on a journal entry: every line of the entry shares
-- it. Given (or generated) for manual entries; automatic entries show the
-- reference of the transaction that posted them.
-- --------------------------------------------------------------------------
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS transaction_id text;
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_transaction_id ON journal_entries (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_entries_manual ON journal_entries (booking_date) WHERE source_type = 'MANUAL';
CREATE INDEX IF NOT EXISTS journal_entries_reversal_of ON journal_entries (reversal_of) WHERE reversal_of IS NOT NULL;
CREATE SEQUENCE IF NOT EXISTS manual_journal_entry_seq;

-- --------------------------------------------------------------------------
-- Files on a manual journal entry (the reference platform: up to five). Kept like a loan's
-- attachments, under the same rules for what may be uploaded.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entry_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      uuid NOT NULL REFERENCES journal_entries(id),
  title         text NOT NULL,
  description   text,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size          int NOT NULL,
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_entry_attachments_entry ON journal_entry_attachments (entry_id, created_at);

-- --------------------------------------------------------------------------
-- A closure's notes may be edited (the reference platform: the description of a closure).
-- --------------------------------------------------------------------------
ALTER TABLE accounting_closures
  ADD COLUMN IF NOT EXISTS updated_by text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
