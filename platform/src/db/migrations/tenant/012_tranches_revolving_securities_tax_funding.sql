-- The rest of Mambu's loan product form: tranched loans, revolving credit,
-- collateral alongside guarantors, value-added tax on loan income, and
-- funding sources (peer-to-peer lending). Each ships off; nothing existing
-- changes until a product turns it on.

-- Liability accounts the new pieces post to. Provisioning seeds them for
-- new tenants; existing tenants get them here.
INSERT INTO gl_accounts (code, name, type, regulatory_class) VALUES
  ('200-300', 'Taxes Payable',             'LIABILITY', 'SHORT_TERM_LIABILITY'),
  ('200-310', 'Loan Credit Balances',      'LIABILITY', 'SHORT_TERM_LIABILITY'),
  ('200-320', 'Funding Accounts',          'LIABILITY', 'MEMBER_DEPOSIT')
ON CONFLICT (code) DO NOTHING;

-- ==========================================================================
-- 1. Product types: TRANCHED and REVOLVING
-- ==========================================================================

ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_product_type_check;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_product_type_check
    CHECK (product_type IN ('FIXED_TERM', 'DYNAMIC_TERM', 'INTEREST_FREE', 'TRANCHED', 'REVOLVING'));
ALTER TABLE loan_accounts DROP CONSTRAINT IF EXISTS loan_accounts_product_type_check;
ALTER TABLE loan_accounts
  ADD CONSTRAINT loan_accounts_product_type_check
    CHECK (product_type IN ('FIXED_TERM', 'DYNAMIC_TERM', 'INTEREST_FREE', 'TRANCHED', 'REVOLVING'));

-- Tranched and revolving products price interest on the actual balance and
-- charge no flat interest (Mambu: Declining Balance only).
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_flat_is_fixed_term;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_flat_is_fixed_term
    CHECK (NOT (product_type IN ('DYNAMIC_TERM', 'TRANCHED', 'REVOLVING') AND method = 'FLAT'));

ALTER TABLE loan_products
  -- Tranched: the most tranches a loan may be disbursed in.
  ADD COLUMN IF NOT EXISTS max_tranches int CHECK (max_tranches IS NULL OR max_tranches > 1),
  -- Revolving: how each installment's principal is set when it is generated
  -- on the due date. PRINCIPAL_FLAT is a fixed amount, PRINCIPAL_PERCENT a
  -- percentage of the outstanding principal, TOTAL_DUE_PERCENT a percentage
  -- of the total balance (interest and fees included, principal last).
  ADD COLUMN IF NOT EXISTS revolving_repayment_method text
    CHECK (revolving_repayment_method IN ('PRINCIPAL_FLAT', 'PRINCIPAL_PERCENT', 'TOTAL_DUE_PERCENT')),
  ADD COLUMN IF NOT EXISTS revolving_repayment_value numeric(18,4),
  ADD COLUMN IF NOT EXISTS revolving_repayment_floor numeric(18,2),
  ADD COLUMN IF NOT EXISTS revolving_repayment_ceiling numeric(18,2),
  -- Revolving: the member's own money held on the loan (overpayments), which
  -- funds later drawdowns. A liability, so it needs its own GL account.
  ADD COLUMN IF NOT EXISTS credit_balance_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_credit_balance numeric(18,2),
  ADD COLUMN IF NOT EXISTS gl_credit_balance text REFERENCES gl_accounts(code);

ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_revolving_has_method;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_revolving_has_method
    CHECK (product_type <> 'REVOLVING' OR (revolving_repayment_method IS NOT NULL AND revolving_repayment_value IS NOT NULL));

-- The tranches a loan is disbursed in.
CREATE TABLE IF NOT EXISTS loan_tranches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id        uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  number         int NOT NULL,
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),
  expected_on    date NOT NULL,
  disbursed_on   date,
  disbursed_amount numeric(18,2),
  transaction_id uuid,
  status         text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'DISBURSED', 'CANCELLED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, number)
);

-- Revolving accounts: the limit is loan_accounts.principal; drawdowns add to
-- principal_disbursed. The credit balance is the member's money.
ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS credit_balance numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  ADD COLUMN IF NOT EXISTS next_billing_on date,
  ADD COLUMN IF NOT EXISTS revolving_repayment_value numeric(18,4);

-- ==========================================================================
-- 2. Securities: collateral assets alongside guarantors
-- ==========================================================================

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS enable_guarantors boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS enable_collateral boolean NOT NULL DEFAULT false;

-- Deposits, guarantor pledges and collateral all count towards the cover
-- the product requires (require_guarantor_cover / min_cover_percent).
CREATE TABLE IF NOT EXISTS loan_collateral (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  asset_type      text NOT NULL DEFAULT 'OTHER'
                  CHECK (asset_type IN ('VEHICLE', 'LAND', 'BUILDING', 'EQUIPMENT', 'SHARES', 'STOCK', 'OTHER')),
  description     text NOT NULL,
  value           numeric(18,2) NOT NULL CHECK (value > 0),
  original_currency text,
  original_value  numeric(24,6),
  reference       text,
  status          text NOT NULL DEFAULT 'PLEDGED' CHECK (status IN ('PLEDGED', 'RELEASED', 'SEIZED')),
  added_by        text,
  added_at        timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  note            text
);
CREATE INDEX IF NOT EXISTS loan_collateral_loan_idx ON loan_collateral (loan_id) WHERE status = 'PLEDGED';

-- ==========================================================================
-- 3. Value-added tax on interest, fees and penalties
-- ==========================================================================
--
-- EXCLUSIVE: the tax is charged on top of the interest, fee or penalty and
-- the member pays it. INCLUSIVE: the quoted figure already contains it and
-- the income recognised is the figure net of tax. Either way the tax is a
-- liability to the revenue authority, booked to gl_tax_payable when the
-- charge is applied (accrual) or paid (cash).

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS tax_rate_percent numeric(8,4),
  ADD COLUMN IF NOT EXISTS tax_method text NOT NULL DEFAULT 'EXCLUSIVE' CHECK (tax_method IN ('EXCLUSIVE', 'INCLUSIVE')),
  ADD COLUMN IF NOT EXISTS tax_on_interest boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_on_fees boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_on_penalties boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gl_tax_payable text REFERENCES gl_accounts(code);

ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_tax_has_rate;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_tax_has_rate
    CHECK (NOT (tax_on_interest OR tax_on_fees OR tax_on_penalties) OR tax_rate_percent IS NOT NULL);

-- Tax the member owes and has paid, kept apart from the charges it rides on
-- so a return can say how much of the receivable is tax.
ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS tax_charged numeric(18,2) NOT NULL DEFAULT 0;

-- A fee may be exempt from the product's tax (Mambu "nontaxable fee").
ALTER TABLE loan_product_fees ADD COLUMN IF NOT EXISTS taxable boolean NOT NULL DEFAULT true;

-- ==========================================================================
-- 4. Funding sources: loans financed from members' funding accounts
-- ==========================================================================
--
-- A funding account is a savings account under a product flagged
-- is_funding_account: no interest, no overdraft, its only purpose is to fund
-- loans and receive their repayments. A funded loan's principal is not the
-- SACCO's asset: disbursement and principal repayment move between the
-- funders' accounts and the channel, never through the portfolio. Interest
-- is split: the organisation's commission is its income (accrued as such),
-- the rest goes to the funders in proportion to what they put in.

ALTER TABLE savings_products
  ADD COLUMN IF NOT EXISTS is_funding_account boolean NOT NULL DEFAULT false;

ALTER TABLE loan_products
  ADD COLUMN IF NOT EXISTS funding_enabled boolean NOT NULL DEFAULT false,
  -- PERCENT_OF_FUNDING: the loan's rate is set, the organisation keeps its
  -- commission and funders split the rest by share. FIXED_COMMISSIONS: each
  -- funder names a rate; the loan's rate is the organisation's commission
  -- plus the funders' rates weighted by share.
  ADD COLUMN IF NOT EXISTS funder_allocation text NOT NULL DEFAULT 'PERCENT_OF_FUNDING'
    CHECK (funder_allocation IN ('PERCENT_OF_FUNDING', 'FIXED_COMMISSIONS')),
  ADD COLUMN IF NOT EXISTS org_commission numeric(8,4),
  ADD COLUMN IF NOT EXISTS org_commission_min numeric(8,4),
  ADD COLUMN IF NOT EXISTS org_commission_max numeric(8,4),
  ADD COLUMN IF NOT EXISTS funder_rate_default numeric(8,4),
  ADD COLUMN IF NOT EXISTS funder_rate_min numeric(8,4),
  ADD COLUMN IF NOT EXISTS funder_rate_max numeric(8,4),
  ADD COLUMN IF NOT EXISTS lock_funds_at_approval boolean NOT NULL DEFAULT true;

ALTER TABLE loan_accounts
  ADD COLUMN IF NOT EXISTS org_commission numeric(8,4);

CREATE TABLE IF NOT EXISTS loan_funding_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id             uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  savings_account_id  uuid NOT NULL REFERENCES savings_accounts(id),
  member_id           uuid NOT NULL REFERENCES members(id),
  amount              numeric(18,2) NOT NULL CHECK (amount > 0),
  funder_rate         numeric(8,4),
  status              text NOT NULL DEFAULT 'PLEDGED' CHECK (status IN ('PLEDGED', 'FUNDED', 'REPAID', 'RELEASED')),
  principal_returned  numeric(18,2) NOT NULL DEFAULT 0,
  interest_returned   numeric(18,2) NOT NULL DEFAULT 0,
  funded_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, savings_account_id)
);
CREATE INDEX IF NOT EXISTS loan_funding_member_idx ON loan_funding_sources (member_id, status);

-- Transaction kinds the new pieces record.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_kind_check CHECK (kind IN (
    'SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER',
    'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'LOAN_FEE', 'LOAN_FEE_WAIVED',
    'LOAN_INTEREST_ACCRUAL', 'LOAN_INTEREST_CAPITALIZED', 'LOAN_WRITE_OFF',
    'LOAN_RESCHEDULE', 'LOAN_REFINANCE',
    'LOAN_FUNDED', 'LOAN_REPAID_TO_FUNDER', 'CREDIT_BALANCE_DEPOSIT',
    'SHARE_PURCHASE', 'SHARE_TRANSFER', 'DIVIDEND_PAYOUT', 'REVERSAL'));
