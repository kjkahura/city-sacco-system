-- Managing your organization, after the reference platform's pages of that name: the
-- organization's details and branding, branches completed and centres,
-- product availability per branch, holidays and non-working days,
-- transaction channel management, ID templates, tax rate sources,
-- currencies and exchange rates, end-of-day settings, custom fields and
-- product documents.

-- 1. Organization details, branding, calendar and end-of-day settings.
-- The institution name, time zone and base currency stay on
-- platform.tenants, where the request path reads them.
CREATE TABLE IF NOT EXISTS organization_settings (
  id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  street_address       text,
  city                 text,
  region               text,
  postcode             text,
  country              text,
  phone                text,
  email                text,
  date_format          text NOT NULL DEFAULT 'dd-MM-yyyy',
  datetime_format      text NOT NULL DEFAULT 'dd-MM-yyyy HH:mm:ss',
  decimal_mark         char(1) NOT NULL DEFAULT '.' CHECK (decimal_mark IN ('.', ',')),
  logo                 bytea,
  logo_type            text,
  icon                 bytea,
  icon_type            text,
  -- Days of the week with no installments, 0 Sunday to 6 Saturday.
  non_working_days     smallint[] NOT NULL DEFAULT '{0,6}',
  allow_other_id_templates boolean NOT NULL DEFAULT false,
  eod_mode             text NOT NULL DEFAULT 'AUTOMATIC' CHECK (eod_mode IN ('AUTOMATIC', 'MANUAL')),
  -- Transactions posted after this local time are booked on the next day.
  -- NULL: no cutoff, the booking day is the posting day.
  accounting_cutoff    time,
  -- Try loans the end of day left out again every hour (the reference platform does).
  eod_retry_excluded   boolean NOT NULL DEFAULT true,
  -- The earliest date whose schedules a holiday or non-working day change
  -- has touched, until the calendar sync has re-dated open loans.
  calendar_changed_from date,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           text
);
INSERT INTO organization_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- 2. Branches: the reference platform's address, email and notes.
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- 3. Centres: subdivisions of a branch, with a weekly meeting day.
CREATE TABLE IF NOT EXISTS centres (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,16}$'),
  name          text NOT NULL,
  branch_id     uuid NOT NULL REFERENCES branches(id),
  meeting_day   smallint CHECK (meeting_day BETWEEN 0 AND 6),
  address       text,
  notes         text,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  custom_fields jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);
CREATE INDEX IF NOT EXISTS centres_branch_idx ON centres (branch_id);

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS centre_id uuid REFERENCES centres(id),
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';

-- 4. Product availability per branch. NULL: every branch.
ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS branch_ids uuid[];
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS branch_ids uuid[];

-- 5. Holidays: organization-wide, per branch or per currency, recurring or
-- on one date, each with an ID.
ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_pkey;
ALTER TABLE holidays
  ADD COLUMN IF NOT EXISTS key uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS id text NOT NULL DEFAULT ('H' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10))),
  ADD COLUMN IF NOT EXISTS recurring boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS currency_code char(3),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE holidays ADD PRIMARY KEY (key);
ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_scope_check;
ALTER TABLE holidays ADD CONSTRAINT holidays_scope_check CHECK (branch_id IS NULL OR currency_code IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS holidays_id_key ON holidays (COALESCE(currency_code, ''), id);
CREATE UNIQUE INDEX IF NOT EXISTS holidays_day_key ON holidays (holiday_date, COALESCE(branch_id::text, ''), COALESCE(currency_code, ''));

-- One answer to "is this a working day", for every calendar check: the
-- organization's non-working days of the week, and holidays on the date or
-- recurring on its day and month, organization-wide, for the base currency,
-- or for the branch asked about.
CREATE OR REPLACE FUNCTION is_closed_day(d date, branch uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXTRACT(dow FROM d)::smallint = ANY (COALESCE((SELECT non_working_days FROM organization_settings WHERE id = 1), '{0,6}'::smallint[]))
      OR EXISTS (
        SELECT 1 FROM holidays h
        WHERE (h.branch_id IS NULL OR h.branch_id = branch)
          AND (h.currency_code IS NULL
               OR h.currency_code = (SELECT t.currency_code FROM platform.tenants t WHERE t.schema_name = current_schema()))
          AND (h.holiday_date = d
               OR (h.recurring AND EXTRACT(month FROM h.holiday_date) = EXTRACT(month FROM d)
                   AND EXTRACT(day FROM h.holiday_date) = EXTRACT(day FROM d))))
$$;

-- 6. Transaction channels: order, the protected default, usage rights by
-- role, and loan and deposit usage constraints.
ALTER TABLE transaction_channels
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  -- NULL: all users. Otherwise the roles that may post through it.
  ADD COLUMN IF NOT EXISTS usage_roles text[],
  -- NULL: unconstrained. Otherwise {"match": "ALL"|"ANY", "filters": [...]}.
  ADD COLUMN IF NOT EXISTS loan_constraints jsonb,
  ADD COLUMN IF NOT EXISTS savings_constraints jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
UPDATE transaction_channels SET is_default = true WHERE id = 'cash';
UPDATE transaction_channels t SET sort_order = x.n
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM transaction_channels) x
WHERE x.id = t.id AND t.sort_order = 0;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';

-- 7. ID templates and the identification documents members hold.
CREATE TABLE IF NOT EXISTS id_templates (
  id                text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9]{1,32}$'),
  id_type           text NOT NULL,
  issuing_authority text NOT NULL,
  mask              text NOT NULL,
  mandatory         boolean NOT NULL DEFAULT false,
  allow_attachments boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text
);

CREATE TABLE IF NOT EXISTS member_identifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id         uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  template_id       text REFERENCES id_templates(id),
  id_type           text NOT NULL,
  issuing_authority text,
  document_id       text NOT NULL,
  valid_until       date,
  attachment        bytea,
  attachment_name   text,
  attachment_type   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text
);
CREATE INDEX IF NOT EXISTS member_identifications_member_idx ON member_identifications (member_id);

-- 8. Tax rate sources: VAT and withholding tax as dated rates, like index
-- interest rates.
ALTER TABLE index_rate_sources
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'INTEREST' CHECK (kind IN ('INTEREST', 'VAT', 'WITHHOLDING'));
ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS tax_source_id text REFERENCES index_rate_sources(id);
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS withholding_source_id text REFERENCES index_rate_sources(id);

-- 9. Currencies, exchange rates and accounting rates.
CREATE TABLE IF NOT EXISTS currencies (
  code            char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name            text NOT NULL CHECK (length(name) <= 256),
  symbol          text NOT NULL CHECK (length(symbol) <= 10),
  decimals        smallint NOT NULL CHECK (decimals BETWEEN 0 AND 4),
  symbol_position text NOT NULL DEFAULT 'BEFORE' CHECK (symbol_position IN ('BEFORE', 'AFTER')),
  is_base         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text
);
CREATE UNIQUE INDEX IF NOT EXISTS currencies_one_base ON currencies (is_base) WHERE is_base;
INSERT INTO currencies (code, name, symbol, decimals, is_base)
SELECT t.currency_code, t.currency_code, t.currency_code,
       COALESCE((SELECT currency_decimals FROM accounting_settings LIMIT 1), 2), true
FROM platform.tenants t WHERE t.schema_name = current_schema()
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS exchange_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_code char(3) NOT NULL REFERENCES currencies(code) ON DELETE CASCADE,
  buy_rate      numeric(20,8) NOT NULL CHECK (buy_rate > 0),
  sell_rate     numeric(20,8) NOT NULL CHECK (sell_rate > 0),
  valid_from    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text
);
CREATE INDEX IF NOT EXISTS exchange_rates_idx ON exchange_rates (currency_code, valid_from DESC);

CREATE TABLE IF NOT EXISTS accounting_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_code char(3) NOT NULL REFERENCES currencies(code) ON DELETE CASCADE,
  rate          numeric(20,8) NOT NULL CHECK (rate > 0),
  valid_from    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text
);
CREATE INDEX IF NOT EXISTS accounting_rates_idx ON accounting_rates (currency_code, valid_from DESC);

-- 10. End of day: retries of loans left out, and a record of each run.
ALTER TABLE loan_eod_exclusions
  ADD COLUMN IF NOT EXISTS retries integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_retry_error text;

CREATE TABLE IF NOT EXISTS eod_completions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date   date NOT NULL,
  trigger         text NOT NULL CHECK (trigger IN ('AUTOMATIC', 'MANUAL')),
  state           text NOT NULL CHECK (state IN ('COMPLETE', 'FAILED')),
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL DEFAULT now(),
  failed_jobs     integer NOT NULL DEFAULT 0,
  failed_loans    integer NOT NULL DEFAULT 0,
  failed_deposits integer NOT NULL DEFAULT 0,
  jobs            jsonb NOT NULL DEFAULT '[]',
  created_by      text
);
CREATE INDEX IF NOT EXISTS eod_completions_idx ON eod_completions (business_date DESC, finished_at DESC);

-- 11. Custom fields: sets, definitions, and values kept with each record as
-- {"_setId": {"fieldId": value}} (a list of those for a grouped set), the
-- shape the reference platform's API v2 uses.
CREATE TABLE IF NOT EXISTS custom_field_sets (
  id          text PRIMARY KEY CHECK (id ~ '^_[A-Za-z0-9_]{1,63}$'),
  entity      text NOT NULL,
  name        text NOT NULL,
  set_type    text NOT NULL DEFAULT 'STANDARD' CHECK (set_type IN ('STANDARD', 'GROUPED')),
  notes       text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id                text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_]{1,64}$'),
  set_id            text REFERENCES custom_field_sets(id) ON DELETE CASCADE,
  entity            text NOT NULL,
  name              text NOT NULL,
  field_type        text NOT NULL CHECK (field_type IN
                      ('FREE_TEXT', 'SELECTION', 'NUMBER', 'CHECKBOX', 'DATE', 'DATE_TIME', 'MEMBER_LINK', 'USER_LINK')),
  long_field        boolean NOT NULL DEFAULT false,
  format            text,
  unique_value      boolean NOT NULL DEFAULT false,
  -- Selection options: [{"id", "label", "score", "parent"}].
  options           jsonb NOT NULL DEFAULT '[]',
  dependent_on      text REFERENCES custom_field_definitions(id),
  available_for_all boolean NOT NULL DEFAULT true,
  -- Basic: {"default": bool, "required": bool}. Granular:
  -- {"items": {"<item>": {"available", "default", "required"}}}.
  usage             jsonb NOT NULL DEFAULT '{"default": false, "required": false}',
  view_roles        text[],
  edit_roles        text[],
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  updated_at        timestamptz
);
CREATE INDEX IF NOT EXISTS custom_field_definitions_entity_idx ON custom_field_definitions (entity, sort_order);

ALTER TABLE loan_accounts ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE loan_guarantors ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE loan_collateral ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';

-- 12. Product documents: templates per product, for an account or for a
-- transaction, filled from placeholders when generated.
CREATE TABLE IF NOT EXISTS product_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_kind  text NOT NULL CHECK (product_kind IN ('LOAN', 'SAVINGS')),
  product_id    text NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  availability  text NOT NULL CHECK (availability IN ('ACCOUNT', 'TRANSACTION')),
  content       text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  updated_at    timestamptz,
  updated_by    text,
  UNIQUE (product_kind, product_id, name)
);
