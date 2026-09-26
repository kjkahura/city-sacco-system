-- Securities and internal controls, and settlement deposit accounts, after
-- Mambu's "Configure securities and controls": Securities Settings,
-- Internal Controls for Loans and Linking Deposit and Loan Accounts.

-- --------------------------------------------------------------------------
-- Securities: whether the member's own deposits count towards cover
-- --------------------------------------------------------------------------
-- Mambu counts guarantees and collateral only. SACCOs commonly count the
-- member's own deposits too, which is what this platform has done; the
-- product now says which.
ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS cover_counts_deposits boolean NOT NULL DEFAULT true;

-- --------------------------------------------------------------------------
-- Internal controls
-- --------------------------------------------------------------------------
ALTER TABLE loan_products
  -- Count charges accrued and not yet applied (penalties inside their
  -- tolerance) when checking the cap at the end of day.
  ADD COLUMN IF NOT EXISTS cap_includes_accrued boolean NOT NULL DEFAULT false;

ALTER TABLE lending_controls
  -- The roles whose users may post repayments on a locked loan (Mambu's
  -- permission to post transactions on locked accounts).
  ADD COLUMN IF NOT EXISTS locked_posting_roles text[] NOT NULL DEFAULT '{}';

-- --------------------------------------------------------------------------
-- Settlement deposit accounts
-- --------------------------------------------------------------------------
INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('290-200', 'Settlement Clearing', 'LIABILITY', 'OTHER_LIABILITY')
ON CONFLICT (code) DO NOTHING;
INSERT INTO transaction_channels (id, name, channel_type, gl_account_code)
VALUES ('settlement', 'Settlement account transfer', 'INTERNAL', '290-200')
ON CONFLICT DO NOTHING;

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS settlement_enabled boolean NOT NULL DEFAULT false,
  -- NULL: any deposit product; otherwise that one.
  ADD COLUMN IF NOT EXISTS settlement_product_id text REFERENCES savings_products(id),
  ADD COLUMN IF NOT EXISTS settlement_auto_set boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS settlement_auto_create boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS settlement_option text NOT NULL DEFAULT 'FULL_DUES'
    CHECK (settlement_option IN ('FULL_DUES', 'PARTIAL', 'NONE'));

ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS settlement_account_id uuid REFERENCES savings_accounts(id),
  ADD COLUMN IF NOT EXISTS settlement_linked_at timestamptz;
CREATE INDEX IF NOT EXISTS loan_settlement_account_idx ON loan_accounts (settlement_account_id, settlement_linked_at)
  WHERE settlement_account_id IS NOT NULL;
