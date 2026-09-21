-- Penalties, and the GL tagging that regulatory reporting needs.

-- --------------------------------------------------------------------------
-- Penalty configuration, per loan product
-- --------------------------------------------------------------------------

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS penalty_rate      numeric(6,3) NOT NULL DEFAULT 0,
  -- OUTSTANDING: rate applied to the whole outstanding principal
  -- OVERDUE:     rate applied only to the amount actually in arrears
  ADD COLUMN IF NOT EXISTS penalty_basis     text NOT NULL DEFAULT 'OVERDUE'
    CHECK (penalty_basis IN ('OVERDUE', 'OUTSTANDING')),
  ADD COLUMN IF NOT EXISTS penalty_grace_days int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gl_penalty_inc    text REFERENCES gl_accounts(code);

-- One row per installment per accrual date. The unique index is what stops a
-- rerun charging a member twice for the same day, enforced by the database
-- rather than by remembering to check a flag.
CREATE TABLE IF NOT EXISTS penalty_charges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id        uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  installment_id uuid REFERENCES loan_installments(id) ON DELETE CASCADE,
  charged_on     date NOT NULL,
  days_late      int NOT NULL,
  basis_amount   numeric(18,2) NOT NULL,
  rate           numeric(6,3) NOT NULL,
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),
  entry_id       uuid REFERENCES journal_entries(id),
  waived_at      timestamptz,
  waived_by      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS penalty_once_per_installment_per_day
  ON penalty_charges (installment_id, charged_on) WHERE waived_at IS NULL;
CREATE INDEX IF NOT EXISTS penalty_loan_idx ON penalty_charges (loan_id, charged_on DESC);

-- --------------------------------------------------------------------------
-- Regulatory tagging on the chart of accounts
-- --------------------------------------------------------------------------

-- A balance sheet can be built from account type alone. Prudential ratios
-- cannot: they need to know which liabilities are member deposits, which
-- assets count as liquid, and which equity is institutional rather than
-- member share capital. Tagging the accounts keeps that mapping in data
-- instead of hardcoded account codes in a report.
ALTER TABLE gl_accounts
  ADD COLUMN IF NOT EXISTS regulatory_class text
    CHECK (regulatory_class IN (
      'LIQUID_ASSET', 'LOAN_PORTFOLIO', 'OTHER_ASSET',
      'MEMBER_DEPOSIT', 'SHORT_TERM_LIABILITY', 'OTHER_LIABILITY',
      'SHARE_CAPITAL', 'INSTITUTIONAL_CAPITAL',
      'INCOME', 'EXPENSE'
    ));

UPDATE gl_accounts SET regulatory_class = CASE
  WHEN code IN ('100-200','100-210','100-220') THEN 'LIQUID_ASSET'
  WHEN code = '100-100' THEN 'LOAN_PORTFOLIO'
  WHEN type = 'ASSET' THEN 'OTHER_ASSET'
  WHEN code = '200-100' THEN 'MEMBER_DEPOSIT'
  WHEN code = '200-200' THEN 'SHORT_TERM_LIABILITY'
  WHEN type = 'LIABILITY' THEN 'OTHER_LIABILITY'
  WHEN code = '300-100' THEN 'SHARE_CAPITAL'
  WHEN type = 'EQUITY' THEN 'INSTITUTIONAL_CAPITAL'
  WHEN type = 'INCOME' THEN 'INCOME'
  WHEN type = 'EXPENSE' THEN 'EXPENSE'
END
WHERE regulatory_class IS NULL;

-- Prudential thresholds live in data because regulators change them, and
-- because the exact figures must be confirmed against the current SASRA
-- circular rather than trusted from a code comment.
CREATE TABLE IF NOT EXISTS prudential_limits (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  minimum     numeric(18,4),
  unit        text NOT NULL CHECK (unit IN ('PERCENT', 'AMOUNT')),
  source_note text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO prudential_limits (code, label, minimum, unit, source_note) VALUES
  ('MIN_CORE_CAPITAL', 'Minimum core capital', 10000000, 'AMOUNT',
   'KES 10 million for deposit-taking SACCOs. Confirm against the current SASRA circular.'),
  ('CORE_CAPITAL_TO_ASSETS', 'Core capital to total assets', 10.0, 'PERCENT',
   'UNVERIFIED default. Confirm against the Sacco Societies (Deposit-Taking Business) Regulations before relying on it.'),
  ('CORE_CAPITAL_TO_DEPOSITS', 'Core capital to total deposits', 8.0, 'PERCENT',
   'UNVERIFIED default. Confirm against the current SASRA circular.'),
  ('INSTITUTIONAL_CAPITAL_TO_ASSETS', 'Institutional capital to total assets', 8.0, 'PERCENT',
   'UNVERIFIED default. Confirm against the current SASRA circular.'),
  ('LIQUIDITY_RATIO', 'Liquid assets to savings deposits and short term liabilities', 15.0, 'PERCENT',
   '15% is the commonly cited SASRA minimum. Confirm against the current circular.')
ON CONFLICT (code) DO NOTHING;
