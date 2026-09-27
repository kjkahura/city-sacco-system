-- Reporting (the reference platform's Data and Reporting > Reporting): the credit officer on
-- a loan, the portfolio at the end of each business day, saved custom views,
-- saved indicator reports and accounting reports generated in the background.

-- --------------------------------------------------------------------------
-- The user (email) responsible for a loan. A new loan takes its member's
-- officer unless the application names one; existing loans take it now.
ALTER TABLE loan_accounts ADD COLUMN IF NOT EXISTS credit_officer text;
UPDATE loan_accounts l SET credit_officer = m.credit_officer
FROM members m
WHERE m.id = l.member_id AND l.credit_officer IS NULL AND m.credit_officer IS NOT NULL;

-- --------------------------------------------------------------------------
-- The loan portfolio as it stood at the end of a business day, one row per
-- running loan, written by the end of day. A report for a past date reads
-- these rows, because the loan tables only hold the present: an installment
-- paid since then no longer shows as late, and the outstanding principal has
-- moved on.
CREATE TABLE IF NOT EXISTS loan_daily_positions (
  business_date         date NOT NULL,
  loan_id               uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  account_no            text NOT NULL,
  member_id             uuid NOT NULL,
  product_id            text NOT NULL,
  branch_id             uuid,
  centre_id             uuid,
  credit_officer        text,
  status                text NOT NULL,
  disbursed_on          date,
  principal_outstanding numeric(18,2) NOT NULL DEFAULT 0,
  interest_outstanding  numeric(18,2) NOT NULL DEFAULT 0,
  fees_outstanding      numeric(18,2) NOT NULL DEFAULT 0,
  penalty_outstanding   numeric(18,2) NOT NULL DEFAULT 0,
  principal_overdue     numeric(18,2) NOT NULL DEFAULT 0,
  interest_overdue      numeric(18,2) NOT NULL DEFAULT 0,
  fees_overdue          numeric(18,2) NOT NULL DEFAULT 0,
  days_late             int NOT NULL DEFAULT 0,
  PRIMARY KEY (business_date, loan_id)
);
CREATE INDEX IF NOT EXISTS loan_daily_positions_loan ON loan_daily_positions (loan_id, business_date);

-- One row per business date that has positions, with when they were taken.
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  business_date date PRIMARY KEY,
  loans         int NOT NULL,
  taken_at      timestamptz NOT NULL DEFAULT now(),
  taken_by      text
);

-- --------------------------------------------------------------------------
-- Saved custom views (the reference platform's Custom Views): a named filter, set of columns
-- and sort over one kind of record, visible to its creator, to every user or
-- to users holding one of the roles listed.
CREATE TABLE IF NOT EXISTS custom_views (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity            text NOT NULL CHECK (entity IN ('MEMBERS', 'LOANS', 'LOAN_TRANSACTIONS', 'DEPOSITS',
                      'DEPOSIT_TRANSACTIONS', 'JOURNAL_ENTRIES', 'ACTIVITIES')),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  description       text,
  owner_id          uuid,
  owner_email       text NOT NULL,
  match             text NOT NULL DEFAULT 'ALL' CHECK (match IN ('ALL', 'ANY')),
  filters           jsonb NOT NULL DEFAULT '[]',
  columns           jsonb NOT NULL DEFAULT '[]',
  sort_by           text,
  sort_dir          text NOT NULL DEFAULT 'ASC' CHECK (sort_dir IN ('ASC', 'DESC')),
  include_totals    boolean NOT NULL DEFAULT false,
  include_timestamp boolean NOT NULL DEFAULT false,
  display           text NOT NULL DEFAULT 'LIST' CHECK (display IN ('LIST', 'DETAIL')),
  all_users         boolean NOT NULL DEFAULT false,
  roles             text[] NOT NULL DEFAULT '{}',
  position          int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_views_name ON custom_views (entity, lower(name), owner_email);

CREATE TABLE IF NOT EXISTS custom_view_favourites (
  view_id    uuid NOT NULL REFERENCES custom_views(id) ON DELETE CASCADE,
  user_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (view_id, user_email)
);

-- --------------------------------------------------------------------------
-- Saved indicator reports (the reference platform's Indicators tab): a named set of
-- indicators for the organization or for one branch, centre, product or
-- credit officer.
CREATE TABLE IF NOT EXISTS indicator_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 255),
  description text,
  entity_type text NOT NULL DEFAULT 'ORGANIZATION' CHECK (entity_type IN
                ('ORGANIZATION', 'BRANCH', 'CENTRE', 'LOAN_PRODUCT', 'DEPOSIT_PRODUCT', 'CREDIT_OFFICER')),
  entity_id   text,
  indicators  text[] NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((entity_type = 'ORGANIZATION') = (entity_id IS NULL))
);

-- --------------------------------------------------------------------------
-- Accounting reports generated in the background (the reference platform's POST
-- /accounting/reports): the request, its state and, once COMPLETE, the lines.
-- A report can be read for 24 hours.
CREATE TABLE IF NOT EXISTS accounting_report_jobs (
  report_key   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'IN_PROGRESS', 'COMPLETE', 'ERROR')),
  params       jsonb NOT NULL,
  items        jsonb,
  error        text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['custom_views', 'indicator_reports']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t || '_touch', t);
  END LOOP;
END $$;

-- The earnings report attributes income and expense to a product through the
-- transaction that posted it.
CREATE INDEX IF NOT EXISTS transactions_entry ON transactions (entry_id);
