-- Shares and the dividend cycle.
-- 001 created share_accounts, dividends and dividend_allocations. This adds
-- what the dividend run actually needs to be correct and repeatable.

ALTER TABLE dividends
  ADD COLUMN IF NOT EXISTS record_date    date NOT NULL DEFAULT current_date,
  ADD COLUMN IF NOT EXISTS basis          text NOT NULL DEFAULT 'UNITS'
    CHECK (basis IN ('UNITS','VALUE')),
  ADD COLUMN IF NOT EXISTS total_units    numeric(18,4),
  ADD COLUMN IF NOT EXISTS total_amount   numeric(18,2),
  ADD COLUMN IF NOT EXISTS gl_payable     text REFERENCES gl_accounts(code),
  ADD COLUMN IF NOT EXISTS declared_entry uuid REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS allocated_at   timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at        timestamptz;

ALTER TABLE dividend_allocations
  ADD COLUMN IF NOT EXISTS entry_id uuid REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS savings_account_id uuid REFERENCES savings_accounts(id);

-- A member's shareholding at a point in time is derived from share
-- transactions, not from a mutable units column alone. Keeping the movement
-- history means a dividend run can be reconstructed and audited later.
CREATE TABLE IF NOT EXISTS share_movements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES share_accounts(id),
  member_id    uuid NOT NULL REFERENCES members(id),
  units        numeric(18,4) NOT NULL,
  unit_price   numeric(18,2) NOT NULL,
  amount       numeric(18,2) NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('PURCHASE','TRANSFER_IN','TRANSFER_OUT','REVERSAL')),
  entry_id     uuid REFERENCES journal_entries(id),
  value_date   date NOT NULL DEFAULT current_date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_mv_member_idx ON share_movements (member_id, value_date);
CREATE INDEX IF NOT EXISTS share_mv_account_idx ON share_movements (account_id, value_date);

-- Shareholding as at a date, for dividend allocation at the record date
-- rather than at whatever the balance happens to be when the job runs.
CREATE OR REPLACE FUNCTION units_as_at(p_member uuid, p_date date)
RETURNS numeric AS $$
  SELECT COALESCE(SUM(units), 0)
  FROM share_movements
  WHERE member_id = p_member AND value_date <= p_date;
$$ LANGUAGE sql STABLE;
