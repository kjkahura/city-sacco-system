-- Roles, tasks, menus, report templates and teller tills (the reference platform's Users and
-- Access Control, Tasks, Menu Items, custom reports and Tellers).

-- --------------------------------------------------------------------------
-- Roles. A row for a built-in role (TENANT_ADMIN, MANAGER, ACCOUNTANT,
-- TELLER, AUDITOR) holds the tenant's edits to it; without one the role has
-- the platform's defaults (lib/permissions). Any other row is the tenant's
-- own role, based on a built-in role for the routes still checked by role.
CREATE TABLE IF NOT EXISTS roles (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9_-]{1,64}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  base_role   text NOT NULL CHECK (base_role IN ('TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR')),
  user_type   text CHECK (user_type IN ('ADMINISTRATOR', 'TELLER', 'CREDIT_OFFICER')),
  api_access  boolean NOT NULL DEFAULT true,
  permissions text[] NOT NULL DEFAULT '{}',
  notes       text,
  builtin     boolean NOT NULL DEFAULT false,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_name ON roles (lower(name));

-- --------------------------------------------------------------------------
-- Tasks (the reference platform's Tasks): a to-do assigned to a user, optionally linked to a
-- member, with a due date.
CREATE TABLE IF NOT EXISTS task_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  target      text NOT NULL DEFAULT 'MEMBER' CHECK (target IN ('MEMBER')),
  title       text,
  content     text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS task_templates_name ON task_templates (lower(name));

CREATE TABLE IF NOT EXISTS tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  description    text,
  member_id      uuid REFERENCES members(id),
  assigned_to    uuid,
  assigned_email text,
  branch_id      uuid REFERENCES branches(id),
  due_date       date,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COMPLETED')),
  template_id    uuid REFERENCES task_templates(id) ON DELETE SET NULL,
  completed_at   timestamptz,
  completed_by   text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (lower(assigned_email), status, due_date);
CREATE INDEX IF NOT EXISTS tasks_member ON tasks (member_id);

-- --------------------------------------------------------------------------
-- Menu items (the reference platform's Menu Items): the navigation's items with views. A
-- custom view sits under one menu item of its kind.
CREATE TABLE IF NOT EXISTS menu_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
  type                text NOT NULL CHECK (type IN ('MEMBERS', 'LOANS', 'LOAN_TRANSACTIONS', 'DEPOSITS',
                        'DEPOSIT_TRANSACTIONS', 'JOURNAL_ENTRIES', 'ACTIVITIES', 'TASKS')),
  include_collections boolean NOT NULL DEFAULT false,
  owner_email         text NOT NULL,
  all_users           boolean NOT NULL DEFAULT false,
  roles               text[] NOT NULL DEFAULT '{}',
  predefined          boolean NOT NULL DEFAULT false,
  position            int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO menu_items (name, type, owner_email, all_users, predefined, position)
SELECT x.name, x.type, 'system', true, true, x.pos
FROM (VALUES ('Clients', 'MEMBERS', 1), ('Loans', 'LOANS', 2), ('Deposits', 'DEPOSITS', 3),
             ('Loan Transactions', 'LOAN_TRANSACTIONS', 4), ('Deposit Transactions', 'DEPOSIT_TRANSACTIONS', 5),
             ('Activities', 'ACTIVITIES', 6)) AS x(name, type, pos)
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE predefined);

ALTER TABLE custom_views DROP CONSTRAINT IF EXISTS custom_views_entity_check;
ALTER TABLE custom_views ADD CONSTRAINT custom_views_entity_check CHECK (entity IN ('MEMBERS', 'LOANS', 'LOAN_TRANSACTIONS',
  'DEPOSITS', 'DEPOSIT_TRANSACTIONS', 'JOURNAL_ENTRIES', 'ACTIVITIES', 'TASKS'));
ALTER TABLE custom_views ADD COLUMN IF NOT EXISTS menu_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL;

-- --------------------------------------------------------------------------
-- Report templates (in place of the reference platform's Jasper reports): a template shown
-- on one kind of record, or under Other reports, to the roles given.
CREATE TABLE IF NOT EXISTS report_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  report_type text NOT NULL CHECK (report_type IN ('MEMBER', 'LOAN', 'DEPOSIT', 'BRANCH', 'CENTRE', 'OTHER')),
  description text,
  definition  jsonb NOT NULL,
  file_name   text,
  all_users   boolean NOT NULL DEFAULT true,
  roles       text[] NOT NULL DEFAULT '{}',
  position    int NOT NULL DEFAULT 0,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_templates_name ON report_templates (report_type, lower(name));

-- --------------------------------------------------------------------------
-- Teller tills (the reference platform's Tellers and Tellering widgets). A till is a
-- teller's cash drawer for a session: opened with an amount, moved by the
-- teller's cash transactions and by cash added or removed, and closed with
-- the cash counted. The difference between counted and expected is booked
-- to cash over and short.
INSERT INTO gl_accounts (code, name, type, regulatory_class)
VALUES ('500-330', 'Cash Over and Short', 'EXPENSE', 'EXPENSE')
ON CONFLICT (code) DO NOTHING;
ALTER TABLE accounting_settings ADD COLUMN IF NOT EXISTS gl_cash_over_short text NOT NULL DEFAULT '500-330';

CREATE TABLE IF NOT EXISTS tills (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  till_code          text NOT NULL CHECK (till_code ~ '^[A-Z]{3}[0-9]{3}$'),
  teller_id          uuid NOT NULL,
  teller_email       text NOT NULL,
  branch_id          uuid REFERENCES branches(id),
  channel_id         text NOT NULL REFERENCES transaction_channels(id),
  gl_code            text NOT NULL REFERENCES gl_accounts(code),
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opening_amount     numeric(18,2) NOT NULL DEFAULT 0 CHECK (opening_amount >= 0),
  balance_constraint text NOT NULL DEFAULT 'NONE' CHECK (balance_constraint IN ('NONE', 'SOFT', 'HARD')),
  min_balance        numeric(18,2),
  max_balance        numeric(18,2),
  reopened_from      uuid REFERENCES tills(id),
  opened_by          text,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  closed_by          text,
  closed_at          timestamptz,
  expected_cash      numeric(18,2),
  counted_cash       numeric(18,2),
  difference         numeric(18,2),
  over_short_entry   uuid REFERENCES journal_entries(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (min_balance IS NULL OR max_balance IS NULL OR min_balance <= max_balance)
);
-- One open till per teller, and a till code open once at a time.
CREATE UNIQUE INDEX IF NOT EXISTS tills_one_open_per_teller ON tills (teller_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS tills_code_open ON tills (till_code) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS till_movements (
  id             bigserial PRIMARY KEY,
  till_id        uuid NOT NULL REFERENCES tills(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('TRANSACTION', 'REVERSAL', 'ADD_CASH', 'REMOVE_CASH')),
  amount         numeric(18,2) NOT NULL,
  transaction_id uuid REFERENCES transactions(id),
  entry_id       uuid REFERENCES journal_entries(id),
  note           text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS till_movements_till ON till_movements (till_id, id);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS till_id uuid REFERENCES tills(id);

-- Cash in or out of the drawer for a transaction kind: +1 in, -1 out, 0 none.
CREATE OR REPLACE FUNCTION till_sign(kind text) RETURNS int AS $$
  SELECT CASE
    WHEN kind IN ('SAVINGS_DEPOSIT', 'LOAN_REPAYMENT', 'SHARE_PURCHASE', 'LOAN_RECOVERY', 'CREDIT_BALANCE_DEPOSIT') THEN 1
    WHEN kind IN ('SAVINGS_WITHDRAWAL', 'LOAN_DISBURSEMENT', 'DIVIDEND_PAYOUT') THEN -1
    ELSE 0 END
$$ LANGUAGE sql IMMUTABLE;

-- The cash a transaction moves: a disbursement pays out net of fees taken from it.
CREATE OR REPLACE FUNCTION till_amount(kind text, amount numeric, allocation jsonb) RETURNS numeric AS $$
  SELECT CASE WHEN kind = 'LOAN_DISBURSEMENT' AND allocation ? 'paidOut'
              THEN COALESCE((allocation->>'paidOut')::numeric, amount) ELSE amount END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION till_expected(t uuid) RETURNS numeric AS $$
  SELECT (SELECT opening_amount FROM tills WHERE id = t) + COALESCE((SELECT SUM(amount) FROM till_movements WHERE till_id = t), 0)
$$ LANGUAGE sql STABLE;

/*
 * A cash transaction entered by a teller with an open till goes through it.
 * The request's user comes from the transaction's session settings
 * (db/tenantContext: app.actor, app.till_required); background jobs have
 * neither and are left alone. A user who must use a till and has none open
 * is refused on the channel tills use. A hard balance constraint refuses a
 * transaction that would take the till outside it.
 */
CREATE OR REPLACE FUNCTION transactions_till_link() RETURNS trigger AS $$
DECLARE
  actor text := nullif(current_setting('app.actor', true), '');
  required boolean := coalesce(current_setting('app.till_required', true), '') = 'true';
  t tills%ROWTYPE;
  s int;
  moved numeric;
  after numeric;
BEGIN
  IF actor IS NULL OR NEW.channel_id IS NULL OR NEW.till_id IS NOT NULL THEN RETURN NEW; END IF;
  s := till_sign(NEW.kind);
  IF s = 0 THEN RETURN NEW; END IF;
  SELECT * INTO t FROM tills WHERE status = 'OPEN' AND lower(teller_email) = lower(actor) AND channel_id = NEW.channel_id;
  IF NOT FOUND THEN
    IF required AND EXISTS (SELECT 1 FROM transaction_channels WHERE id = NEW.channel_id AND is_default) THEN
      RAISE EXCEPTION 'NO_OPEN_TILL: open a till before posting cash transactions' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  moved := s * till_amount(NEW.kind, NEW.amount, NEW.allocation);
  after := till_expected(t.id) + moved;
  IF t.balance_constraint = 'HARD' AND ((t.min_balance IS NOT NULL AND after < t.min_balance) OR (t.max_balance IS NOT NULL AND after > t.max_balance)) THEN
    RAISE EXCEPTION 'TILL_BALANCE_CONSTRAINT: the till would hold % (limits % to %)', after, coalesce(t.min_balance::text, 'none'), coalesce(t.max_balance::text, 'none')
      USING ERRCODE = '23514';
  END IF;
  IF after < 0 THEN
    RAISE EXCEPTION 'TILL_WOULD_GO_NEGATIVE: the till holds % and this pays out %', after - moved, -moved USING ERRCODE = '23514';
  END IF;
  NEW.till_id := t.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION transactions_till_movement() RETURNS trigger AS $$
BEGIN
  IF NEW.till_id IS NOT NULL THEN
    INSERT INTO till_movements (till_id, kind, amount, transaction_id, created_by)
    VALUES (NEW.till_id, 'TRANSACTION', till_sign(NEW.kind) * till_amount(NEW.kind, NEW.amount, NEW.allocation), NEW.id, NEW.created_by);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Reversing a till transaction takes its cash back out, while the till is
-- open. Once the till is closed its transactions stand until the close is
-- undone (the reference platform's Undo Close Till).
CREATE OR REPLACE FUNCTION transactions_till_reversal() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  IF NEW.till_id IS NOT NULL AND OLD.reversed_by IS NULL AND NEW.reversed_by IS NOT NULL THEN
    SELECT status INTO st FROM tills WHERE id = NEW.till_id;
    IF st <> 'OPEN' THEN
      RAISE EXCEPTION 'TILL_CLOSED: undo the close of till % to correct its transactions', NEW.till_id USING ERRCODE = '23514';
    END IF;
    INSERT INTO till_movements (till_id, kind, amount, transaction_id, created_by)
    VALUES (NEW.till_id, 'REVERSAL', -till_sign(NEW.kind) * till_amount(NEW.kind, NEW.amount, NEW.allocation), NEW.id,
            nullif(current_setting('app.actor', true), ''));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_till_link ON transactions;
CREATE TRIGGER transactions_till_link BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_till_link();
DROP TRIGGER IF EXISTS transactions_till_movement ON transactions;
CREATE TRIGGER transactions_till_movement AFTER INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_till_movement();
DROP TRIGGER IF EXISTS transactions_till_reversal ON transactions;
CREATE TRIGGER transactions_till_reversal BEFORE UPDATE OF reversed_by ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_till_reversal();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles', 'task_templates', 'tasks', 'menu_items', 'report_templates']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t || '_touch', t);
  END LOOP;
END $$;
