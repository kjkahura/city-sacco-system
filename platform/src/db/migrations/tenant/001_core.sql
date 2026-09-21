-- Tenant schema: one SACCO's entire book.
-- Applied into each tenant_<slug> schema. No tenant_id columns anywhere:
-- the schema IS the tenant boundary.

CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  town        text,
  phone       text,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_no      text NOT NULL UNIQUE,
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  national_id    text,
  kra_pin        text,
  phone          text,
  email          text,
  date_of_birth  date,
  gender         text CHECK (gender IN ('MALE','FEMALE','OTHER')),
  branch_id      uuid REFERENCES branches(id),
  employer       text,
  status         text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('PENDING','ACTIVE','DORMANT','EXITED','DECEASED')),
  joined_on      date NOT NULL DEFAULT current_date,
  exited_on      date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX members_name_idx ON members (lower(last_name), lower(first_name));
CREATE INDEX members_status_idx ON members (status);
CREATE UNIQUE INDEX members_national_id_key ON members (national_id) WHERE national_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Chart of accounts and double entry
-- --------------------------------------------------------------------------

CREATE TABLE gl_accounts (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  parent_code text REFERENCES gl_accounts(code),
  is_active  boolean NOT NULL DEFAULT true
);

CREATE TABLE transaction_channels (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  channel_type   text NOT NULL CHECK (channel_type IN ('CASH','MOBILE','TRANSFER','CHEQUE','INTERNAL','PAYROLL')),
  gl_account_code text REFERENCES gl_accounts(code),
  is_active      boolean NOT NULL DEFAULT true
);

-- A journal entry is a header plus balanced lines. The balance is enforced by
-- a deferred constraint trigger, so an unbalanced entry cannot be committed
-- even if application code is wrong.
CREATE TABLE journal_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_date  date NOT NULL DEFAULT current_date,
  currency_code char(3) NOT NULL DEFAULT 'KES',
  narration     text,
  source_type   text,
  source_id     uuid,
  channel_id    text REFERENCES transaction_channels(id),
  reversal_of   uuid REFERENCES journal_entries(id),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id          bigserial PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  gl_code     text NOT NULL REFERENCES gl_accounts(code),
  direction   text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  member_id   uuid REFERENCES members(id),
  line_no     int NOT NULL
);

CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);
CREATE INDEX journal_lines_gl_idx ON journal_lines (gl_code);
CREATE INDEX journal_entries_date_idx ON journal_entries (booking_date);

CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  dr numeric(18,2);
  cr numeric(18,2);
  eid uuid := COALESCE(NEW.entry_id, OLD.entry_id);
BEGIN
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)
  INTO dr, cr
  FROM journal_lines WHERE entry_id = eid;

  IF dr <> cr THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits %, credits %', eid, dr, cr
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Posted lines are immutable. Corrections are reversing entries, not edits.
CREATE OR REPLACE FUNCTION forbid_journal_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal lines are immutable; post a reversing entry instead'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_lines_no_update
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_mutation();

-- --------------------------------------------------------------------------
-- Products
-- --------------------------------------------------------------------------

CREATE TABLE savings_products (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  annual_rate     numeric(6,3) NOT NULL DEFAULT 0,
  min_balance     numeric(18,2) NOT NULL DEFAULT 0,
  withdrawable    boolean NOT NULL DEFAULT true,
  gl_liability    text NOT NULL REFERENCES gl_accounts(code),
  gl_interest_exp text REFERENCES gl_accounts(code),
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE loan_products (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  method         text NOT NULL DEFAULT 'FLAT' CHECK (method IN ('FLAT','REDUCING')),
  monthly_rate   numeric(6,3) NOT NULL DEFAULT 0,
  max_term       int NOT NULL DEFAULT 60,
  processing_fee numeric(18,2) NOT NULL DEFAULT 0,
  max_multiplier numeric(6,2) NOT NULL DEFAULT 3,  -- x member deposits, SACCO norm
  gl_portfolio   text NOT NULL REFERENCES gl_accounts(code),
  gl_interest_inc text NOT NULL REFERENCES gl_accounts(code),
  gl_fee_inc     text REFERENCES gl_accounts(code),
  is_active      boolean NOT NULL DEFAULT true
);

CREATE TABLE share_products (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  unit_price   numeric(18,2) NOT NULL DEFAULT 1,
  min_units    int NOT NULL DEFAULT 0,
  gl_equity    text NOT NULL REFERENCES gl_accounts(code),
  is_active    boolean NOT NULL DEFAULT true
);

-- --------------------------------------------------------------------------
-- Accounts
-- --------------------------------------------------------------------------

CREATE TABLE savings_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_no  text NOT NULL UNIQUE,
  member_id   uuid NOT NULL REFERENCES members(id),
  product_id  text NOT NULL REFERENCES savings_products(id),
  status      text NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('PENDING','ACTIVE','DORMANT','LOCKED','CLOSED')),
  balance     numeric(18,2) NOT NULL DEFAULT 0,
  opened_on   date NOT NULL DEFAULT current_date,
  closed_on   date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT savings_balance_non_negative CHECK (balance >= 0)
);

CREATE INDEX savings_member_idx ON savings_accounts (member_id);

CREATE TABLE share_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_no  text NOT NULL UNIQUE,
  member_id   uuid NOT NULL REFERENCES members(id),
  product_id  text NOT NULL REFERENCES share_products(id),
  units       numeric(18,4) NOT NULL DEFAULT 0 CHECK (units >= 0),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX share_member_idx ON share_accounts (member_id);

CREATE TABLE loan_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_no         text NOT NULL UNIQUE,
  member_id          uuid NOT NULL REFERENCES members(id),
  product_id         text NOT NULL REFERENCES loan_products(id),
  status             text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN (
                       'DRAFT','PENDING_APPROVAL','APPROVED','ACTIVE','IN_ARREARS',
                       'CLOSED_REPAID','CLOSED_WRITTEN_OFF','CLOSED_REJECTED',
                       'CLOSED_WITHDRAWN','CLOSED_RESCHEDULED')),
  principal          numeric(18,2) NOT NULL CHECK (principal > 0),
  term_months        int NOT NULL CHECK (term_months > 0),
  monthly_rate       numeric(6,3) NOT NULL DEFAULT 0,
  principal_disbursed numeric(18,2) NOT NULL DEFAULT 0,
  principal_paid     numeric(18,2) NOT NULL DEFAULT 0,
  interest_accrued   numeric(18,2) NOT NULL DEFAULT 0,
  interest_paid      numeric(18,2) NOT NULL DEFAULT 0,
  fees_due           numeric(18,2) NOT NULL DEFAULT 0,
  fees_paid          numeric(18,2) NOT NULL DEFAULT 0,
  penalty_accrued    numeric(18,2) NOT NULL DEFAULT 0,
  penalty_paid       numeric(18,2) NOT NULL DEFAULT 0,
  applied_on         date NOT NULL DEFAULT current_date,
  approved_on        date,
  disbursed_on       date,
  parent_loan_id     uuid REFERENCES loan_accounts(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX loan_member_idx ON loan_accounts (member_id);
CREATE INDEX loan_status_idx ON loan_accounts (status);

-- Guarantors. A SACCO concept with no clean Mambu equivalent: members pledge
-- their own deposits against another member's loan.
CREATE TABLE loan_guarantors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES members(id),
  pledged_amount  numeric(18,2) NOT NULL CHECK (pledged_amount > 0),
  status          text NOT NULL DEFAULT 'PLEDGED'
                  CHECK (status IN ('PLEDGED','RELEASED','CALLED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, member_id),
  CONSTRAINT guarantor_not_self CHECK (true)  -- enforced in app: needs loan.member_id
);

CREATE INDEX guarantor_member_idx ON loan_guarantors (member_id);

CREATE TABLE loan_installments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id       uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  number        int NOT NULL,
  due_date      date NOT NULL,
  principal_due numeric(18,2) NOT NULL DEFAULT 0,
  interest_due  numeric(18,2) NOT NULL DEFAULT 0,
  fee_due       numeric(18,2) NOT NULL DEFAULT 0,
  principal_paid numeric(18,2) NOT NULL DEFAULT 0,
  interest_paid numeric(18,2) NOT NULL DEFAULT 0,
  fee_paid      numeric(18,2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PARTIALLY_PAID','PAID','OVERDUE')),
  UNIQUE (loan_id, number)
);

CREATE INDEX installment_due_idx ON loan_installments (due_date) WHERE status <> 'PAID';

-- --------------------------------------------------------------------------
-- Transactions. Append-only; corrections are reversals.
-- --------------------------------------------------------------------------

CREATE TABLE transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN (
                     'SAVINGS_DEPOSIT','SAVINGS_WITHDRAWAL','SAVINGS_TRANSFER',
                     'LOAN_DISBURSEMENT','LOAN_REPAYMENT','LOAN_FEE',
                     'LOAN_INTEREST_ACCRUAL','LOAN_WRITE_OFF',
                     'SHARE_PURCHASE','SHARE_TRANSFER','DIVIDEND_PAYOUT','REVERSAL')),
  member_id        uuid REFERENCES members(id),
  savings_account_id uuid REFERENCES savings_accounts(id),
  loan_account_id  uuid REFERENCES loan_accounts(id),
  share_account_id uuid REFERENCES share_accounts(id),
  channel_id       text REFERENCES transaction_channels(id),
  amount           numeric(18,2) NOT NULL,
  value_date       date NOT NULL DEFAULT current_date,
  entry_id         uuid REFERENCES journal_entries(id),
  reversed_by      uuid REFERENCES transactions(id),
  allocation       jsonb NOT NULL DEFAULT '{}'::jsonb,
  narration        text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tx_member_idx ON transactions (member_id, created_at DESC);
CREATE INDEX tx_savings_idx ON transactions (savings_account_id, created_at DESC);
CREATE INDEX tx_loan_idx ON transactions (loan_account_id, created_at DESC);
CREATE INDEX tx_kind_date_idx ON transactions (kind, value_date);

CREATE TRIGGER transactions_no_update
  BEFORE DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_mutation();

-- --------------------------------------------------------------------------
-- Supporting
-- --------------------------------------------------------------------------

CREATE TABLE holidays (
  holiday_date date PRIMARY KEY,
  name         text NOT NULL
);

CREATE TABLE dividends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_year int NOT NULL,
  rate_percent  numeric(6,3) NOT NULL,
  declared_on   date NOT NULL DEFAULT current_date,
  status        text NOT NULL DEFAULT 'DECLARED'
                CHECK (status IN ('DECLARED','ALLOCATED','PAID')),
  UNIQUE (financial_year)
);

CREATE TABLE dividend_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dividend_id uuid NOT NULL REFERENCES dividends(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES members(id),
  units       numeric(18,4) NOT NULL,
  amount      numeric(18,2) NOT NULL,
  paid_at     timestamptz,
  UNIQUE (dividend_id, member_id)
);

-- Tenant-scoped audit trail. Separate from platform.audit_log, which only
-- records control-plane events.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor      text,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_action_idx ON audit_log (action, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id);
