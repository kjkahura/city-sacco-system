-- Deposits > Working with Deposit Accounts, after the reference platform: blocks and
-- seizures, transaction holds, bulk deposits, per-account limits and
-- withholding tax. Nothing here changes a running account until a block,
-- hold or account setting is made.

-- --------------------------------------------------------------------------
-- Blocked funds (the reference platform's Blocking Funds in Deposit Accounts): an amount the
-- holder may not withdraw or transfer, for example under a court order. It
-- is PENDING until it is seized in full or unblocked. Interest still
-- accrues on the whole balance.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_blocks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE,
  reference      text NOT NULL,
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),
  seized         numeric(18,2) NOT NULL DEFAULT 0 CHECK (seized >= 0),
  state          text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SEIZED', 'UNBLOCKED')),
  notes          text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  CHECK (seized <= amount),
  UNIQUE (account_id, reference)
);

-- --------------------------------------------------------------------------
-- Transaction holds (the reference platform's Transaction Holds): a debit (DBIT) or credit
-- (CRDT) authorised and not yet settled, by an external reference unique in
-- the tenant (at most 32 characters). A debit hold is unavailable to the
-- holder; a credit hold is money on its way. Holds on deposit accounts do
-- not expire (the reference platform).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_holds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE,
  external_reference_id text NOT NULL UNIQUE CHECK (length(external_reference_id) BETWEEN 1 AND 32),
  indicator             text NOT NULL CHECK (indicator IN ('DBIT', 'CRDT')),
  amount                numeric(18,2) NOT NULL CHECK (amount > 0),
  state                 text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SETTLED', 'REVERSED')),
  notes                 text,
  transaction_id        uuid,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz
);
CREATE INDEX IF NOT EXISTS savings_holds_account_idx ON savings_holds (account_id) WHERE state = 'PENDING';

-- Seized amounts are their own transaction kind (the reference platform's "Seized Amount").
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
    'MIGRATION_OPENING_BALANCE', 'SAVINGS_SEIZURE'));

-- --------------------------------------------------------------------------
-- Bulk deposits (the reference platform's POST /deposits/deposit-transactions:bulk): each
-- deposit posts on its own; the outcome is kept under a process key.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bulk_processes (
  process_key  text PRIMARY KEY,
  kind         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('QUEUED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')),
  items        jsonb NOT NULL DEFAULT '[]',
  errors       jsonb NOT NULL DEFAULT '[]',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- --------------------------------------------------------------------------
-- The account's own limits (the reference platform's account-level maximum withdrawal amount
-- and recommended deposit amount), within the product's, and its own
-- withholding tax source with its history (the reference platform's :changeWithholdingTax).
-- --------------------------------------------------------------------------
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS own_max_withdrawal numeric(18,2) CHECK (own_max_withdrawal IS NULL OR own_max_withdrawal > 0);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS own_recommended_deposit numeric(18,2) CHECK (own_recommended_deposit IS NULL OR own_recommended_deposit > 0);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS withholding_source_id text REFERENCES index_rate_sources(id);
CREATE TABLE IF NOT EXISTS savings_withholding_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE,
  source_id   text REFERENCES index_rate_sources(id),
  valid_from  date NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- The reference platform's permissions for these, given to the roles that hold the matching
-- permission. Blocking and seizing funds is left to administrators.
-- --------------------------------------------------------------------------
DO $$
DECLARE pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['MAKE_DEPOSIT', 'BACKDATE_SAVINGS_TRANSACTIONS'],
    ['MAKE_WITHDRAWAL', 'BACKDATE_SAVINGS_TRANSACTIONS'],
    ['MAKE_TRANSFER', 'BACKDATE_SAVINGS_TRANSACTIONS'],
    ['MAKE_TRANSFER', 'MAKE_INTER_CLIENTS_TRANSFERS'],
    ['APPLY_SAVINGS_ADJUSTMENTS', 'BULK_DEPOSIT_CORRECTIONS'],
    ['VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_HOLDS'],
    ['EDIT_SAVINGS_ACCOUNT', 'CREATE_HOLDS'],
    ['EDIT_SAVINGS_ACCOUNT', 'UPDATE_HOLDS'],
    ['EDIT_SAVINGS_ACCOUNT', 'DELETE_HOLDS']]
  LOOP
    UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY[pair[2]]::text[]) c ORDER BY c)
     WHERE pair[1] = ANY (permissions) AND NOT (pair[2] = ANY (permissions));
  END LOOP;
END $$;
