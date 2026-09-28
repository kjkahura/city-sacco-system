-- Lines of credit (the reference platform's credit arrangements) and solidarity group loans,
-- after the loan-engine audit. Nothing already in use changes: no product
-- is available to solidarity groups, and every loan and deposit product
-- starts with credit arrangements NOT_REQUIRED (none may be linked), until a
-- tenant says otherwise.

-- --------------------------------------------------------------------------
-- Solidarity group loans: one individual loan per member, made together
-- under a group. The product is available to solidarity groups only
-- (The reference platform: Client and Groups unticked), and the loan keeps the group it was
-- made under.
-- --------------------------------------------------------------------------
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_available_for_check;
ALTER TABLE loan_products ADD CONSTRAINT loan_products_available_for_check
  CHECK (cardinality(available_for) > 0 AND available_for <@ ARRAY['INDIVIDUALS', 'GROUPS', 'SOLIDARITY_GROUPS']::text[]
         AND (NOT ('SOLIDARITY_GROUPS' = ANY (available_for)) OR cardinality(available_for) = 1));

ALTER TABLE loan_accounts ADD COLUMN IF NOT EXISTS solidarity_group_id uuid REFERENCES members(id);
CREATE INDEX IF NOT EXISTS loan_accounts_solidarity_group_idx ON loan_accounts (solidarity_group_id) WHERE solidarity_group_id IS NOT NULL;

-- Who may open an account (033), with solidarity loans: a loan made under a
-- group is held by an individual, under a product for solidarity groups;
-- any other loan needs a product for its kind of holder. Membership of the
-- group is checked when the loans are opened (../domain/solidarityLoans),
-- so a member who has since left can still have their loan rescheduled.
CREATE OR REPLACE FUNCTION check_holder_may_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE m record; allowed text[]; closed boolean; prod text; kind text; grp text;
BEGIN
  closed := NEW.status LIKE 'CLOSED%';
  IF closed THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'loan_accounts' AND (to_jsonb(NEW)->>'parent_loan_id') IS NOT NULL THEN RETURN NEW; END IF;
  SELECT mb.status, mb.holder_type, mb.member_no, t.can_open_accounts, t.name AS type_name INTO m
    FROM members mb JOIN client_types t ON t.id = mb.client_type_id WHERE mb.id = NEW.member_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF m.status NOT IN ('INACTIVE', 'ACTIVE') THEN
    RAISE EXCEPTION 'HOLDER_MAY_NOT_OPEN_ACCOUNTS: % is %', m.member_no, m.status USING ERRCODE = '23514';
  END IF;
  IF NOT m.can_open_accounts THEN
    RAISE EXCEPTION 'TYPE_MAY_NOT_OPEN_ACCOUNTS: % is of the type %', m.member_no, m.type_name USING ERRCODE = '23514';
  END IF;
  prod := to_jsonb(NEW)->>'product_id';
  grp := CASE WHEN TG_TABLE_NAME = 'loan_accounts' THEN to_jsonb(NEW)->>'solidarity_group_id' END;
  IF TG_TABLE_NAME = 'loan_accounts' THEN SELECT available_for INTO allowed FROM loan_products WHERE id = prod;
  ELSIF TG_TABLE_NAME = 'savings_accounts' THEN SELECT available_for INTO allowed FROM savings_products WHERE id = prod;
  ELSE SELECT available_for INTO allowed FROM share_products WHERE id = prod; END IF;
  IF grp IS NOT NULL THEN
    IF m.holder_type = 'GROUP' THEN
      RAISE EXCEPTION 'A_SOLIDARITY_LOAN_IS_HELD_BY_A_MEMBER: % is a group', m.member_no USING ERRCODE = '23514';
    END IF;
    kind := 'SOLIDARITY_GROUPS';
  ELSE
    kind := CASE WHEN m.holder_type = 'GROUP' THEN 'GROUPS' ELSE 'INDIVIDUALS' END;
  END IF;
  IF allowed IS NOT NULL AND NOT (kind = ANY (allowed)) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE_FOR_%: %', kind, prod USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --------------------------------------------------------------------------
-- Credit arrangements (the reference platform's lines of credit): one holder's credit limit
-- across several loan accounts and deposit accounts with an overdraft.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_arrangements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arrangement_no       text NOT NULL UNIQUE,
  holder_id            uuid NOT NULL REFERENCES members(id),
  amount               numeric(18,2) NOT NULL CHECK (amount > 0),
  start_date           date NOT NULL,
  expire_date          date NOT NULL,
  exposure_limit_type  text NOT NULL DEFAULT 'APPROVED_AMOUNT' CHECK (exposure_limit_type IN ('APPROVED_AMOUNT', 'OUTSTANDING_AMOUNT')),
  state                text NOT NULL CHECK (state IN ('PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'CLOSED', 'WITHDRAWN', 'REJECTED')),
  state_before_close   text,
  notes                text,
  custom_fields        jsonb NOT NULL DEFAULT '{}',
  approved_at          timestamptz,
  closed_at            timestamptz,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (expire_date > start_date)
);
CREATE INDEX IF NOT EXISTS credit_arrangements_holder_idx ON credit_arrangements (holder_id);

-- A branch-limited user sees the arrangements of the holders they see.
ALTER TABLE credit_arrangements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branch_access ON credit_arrangements;
CREATE POLICY branch_access ON credit_arrangements USING (EXISTS (SELECT 1 FROM members m WHERE m.id = holder_id));

ALTER TABLE loan_accounts ADD COLUMN IF NOT EXISTS credit_arrangement_id uuid REFERENCES credit_arrangements(id);
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS credit_arrangement_id uuid REFERENCES credit_arrangements(id);
CREATE INDEX IF NOT EXISTS loan_accounts_credit_arrangement_idx ON loan_accounts (credit_arrangement_id) WHERE credit_arrangement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS savings_accounts_credit_arrangement_idx ON savings_accounts (credit_arrangement_id) WHERE credit_arrangement_id IS NOT NULL;

-- An overdraft's expiry date (the reference platform): after it the overdraft limit no longer
-- lends. Optional; an overdraft needs one to be linked to an arrangement.
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS overdraft_expires_on date;

-- Whether a product's accounts are linked: OPTIONAL, REQUIRED or
-- NOT_REQUIRED (the reference platform's Optional, Required and No).
ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS credit_arrangement_requirement text NOT NULL DEFAULT 'NOT_REQUIRED'
  CHECK (credit_arrangement_requirement IN ('OPTIONAL', 'REQUIRED', 'NOT_REQUIRED'));
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS credit_arrangement_requirement text NOT NULL DEFAULT 'NOT_REQUIRED'
  CHECK (credit_arrangement_requirement IN ('OPTIONAL', 'REQUIRED', 'NOT_REQUIRED'));

-- The state a new arrangement starts in (the reference platform's internal control).
ALTER TABLE client_controls ADD COLUMN IF NOT EXISTS credit_arrangement_initial_state text NOT NULL DEFAULT 'PENDING_APPROVAL'
  CHECK (credit_arrangement_initial_state IN ('PENDING_APPROVAL', 'APPROVED'));

-- Arrangement IDs from the same counters as deposit and share accounts (CA000001).
ALTER TABLE account_counters DROP CONSTRAINT IF EXISTS account_counters_kind_check;
ALTER TABLE account_counters ADD CONSTRAINT account_counters_kind_check CHECK (kind IN ('SAVINGS', 'SHARES', 'CREDIT_ARRANGEMENTS'));
INSERT INTO account_counters (kind, prefix, next_number) VALUES ('CREDIT_ARRANGEMENTS', 'CA', 1) ON CONFLICT (kind) DO NOTHING;
CREATE OR REPLACE FUNCTION account_no_taken(k text, no text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT CASE k WHEN 'SAVINGS' THEN EXISTS (SELECT 1 FROM savings_accounts WHERE account_no = no)
                WHEN 'SHARES' THEN EXISTS (SELECT 1 FROM share_accounts WHERE account_no = no)
                WHEN 'CREDIT_ARRANGEMENTS' THEN EXISTS (SELECT 1 FROM credit_arrangements WHERE arrangement_no = no) END
$$;

-- Custom views and menu items of credit arrangements.
ALTER TABLE custom_views DROP CONSTRAINT IF EXISTS custom_views_entity_check;
ALTER TABLE custom_views ADD CONSTRAINT custom_views_entity_check CHECK (entity IN ('MEMBERS', 'GROUPS', 'LOANS', 'LOAN_TRANSACTIONS',
  'DEPOSITS', 'DEPOSIT_TRANSACTIONS', 'CREDIT_ARRANGEMENTS', 'JOURNAL_ENTRIES', 'ACTIVITIES', 'TASKS'));
ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_type_check;
ALTER TABLE menu_items ADD CONSTRAINT menu_items_type_check CHECK (type IN ('MEMBERS', 'GROUPS', 'LOANS', 'LOAN_TRANSACTIONS', 'DEPOSITS',
  'DEPOSIT_TRANSACTIONS', 'CREDIT_ARRANGEMENTS', 'JOURNAL_ENTRIES', 'ACTIVITIES', 'TASKS'));

-- The reference platform's 13 credit arrangement permissions, given to the roles that hold
-- the matching loan permission.
DO $$
DECLARE pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['VIEW_LOAN_ACCOUNT_DETAILS', 'VIEW_LINE_OF_CREDIT_DETAILS'],
    ['CREATE_LOAN_ACCOUNT', 'CREATE_LINES_OF_CREDIT'],
    ['EDIT_LOAN_ACCOUNT', 'EDIT_LINES_OF_CREDIT'],
    ['EDIT_LOAN_ACCOUNT', 'ADD_ACCOUNTS_TO_LINE_OF_CREDIT'],
    ['EDIT_LOAN_ACCOUNT', 'REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT'],
    ['APPROVE_LOANS', 'APPROVE_LINE_OF_CREDIT'],
    ['APPROVE_LOANS', 'UNDO_APPROVE_LINE_OF_CREDIT'],
    ['WITHDRAW_LOAN_ACCOUNTS', 'WITHDRAW_LINE_OF_CREDIT'],
    ['UNDO_WITHDRAW_LOAN_ACCOUNTS', 'UNDO_WITHDRAW_LINE_OF_CREDIT'],
    ['REJECT_LOANS', 'REJECT_LINE_OF_CREDIT'],
    ['UNDO_REJECT_LOANS', 'UNDO_REJECT_LINE_OF_CREDIT'],
    ['CLOSE_LOAN_ACCOUNTS', 'CLOSE_LINES_OF_CREDIT'],
    ['DELETE_LOAN_ACCOUNT', 'DELETE_LINES_OF_CREDIT']]
  LOOP
    UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY[pair[2]]::text[]) c ORDER BY c)
     WHERE pair[1] = ANY (permissions) AND NOT (pair[2] = ANY (permissions));
  END LOOP;
END $$;
