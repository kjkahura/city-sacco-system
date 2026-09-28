-- Clients and Groups, after the reference platform.
--
-- A group is kept in the members table as an account holder of its own
-- (holder_type GROUP), so every account, statement and report path that
-- takes a member takes a group too. Its name is in first_name and last_name
-- is empty. The API shows groups apart (/api/groups), as the reference platform does.

-- --------------------------------------------------------------------------
-- Client and group types (the reference platform's Client Types and Group Types)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_types (
  id                   text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,32}$'),
  holder_type          text NOT NULL CHECK (holder_type IN ('CLIENT', 'GROUP')),
  name                 text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 255),
  description          text CHECK (length(description) <= 256),
  id_pattern           text CHECK (id_pattern ~ '^[A-Za-z0-9#@$_.-]{1,32}$'),
  can_open_accounts    boolean NOT NULL DEFAULT true,
  can_guarantee        boolean NOT NULL DEFAULT true,
  require_id_documents boolean NOT NULL DEFAULT true,
  use_default_address  boolean NOT NULL DEFAULT true,
  is_default           boolean NOT NULL DEFAULT false,
  next_number          bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, holder_type)
);
CREATE UNIQUE INDEX IF NOT EXISTS client_types_one_default ON client_types (holder_type) WHERE is_default;

INSERT INTO client_types (id, holder_type, name, description, id_pattern, is_default, require_id_documents)
VALUES ('client', 'CLIENT', 'Client', 'The default client type.', 'M######', true, true),
       ('group', 'GROUP', 'Group', 'The default group type.', 'G######', true, false)
ON CONFLICT (id) DO NOTHING;

-- The counter carries on from the member numbers already given.
UPDATE client_types SET next_number = GREATEST(next_number,
  (SELECT COALESCE(MAX(substring(member_no FROM '^M([0-9]{1,15})$')::bigint), 0) + 1 FROM members))
 WHERE id = 'client';

-- --------------------------------------------------------------------------
-- Members: holder type, client type, language, life cycle
-- --------------------------------------------------------------------------
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS holder_type text NOT NULL DEFAULT 'CLIENT',
  ADD COLUMN IF NOT EXISTS client_type_id text NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS preferred_language text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS state_reason text,
  ADD COLUMN IF NOT EXISTS exit_reason text,
  ADD COLUMN IF NOT EXISTS blacklisted_from text,
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

DO $$ BEGIN
  ALTER TABLE members ADD CONSTRAINT members_holder_type_check CHECK (holder_type IN ('CLIENT', 'GROUP'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE members ADD CONSTRAINT members_client_type_fk FOREIGN KEY (client_type_id, holder_type)
    REFERENCES client_types (id, holder_type);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- An individual has both names; a group has no personal details.
  ALTER TABLE members ADD CONSTRAINT members_holder_details CHECK (
    (holder_type = 'CLIENT' AND btrim(first_name) <> '' AND btrim(last_name) <> '')
    OR (holder_type = 'GROUP' AND btrim(first_name) <> '' AND national_id IS NULL AND date_of_birth IS NULL AND gender IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE members ADD CONSTRAINT members_blacklisted_from_check
    CHECK (blacklisted_from IS NULL OR blacklisted_from IN ('PENDING_APPROVAL', 'INACTIVE', 'ACTIVE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE members ADD CONSTRAINT members_preferred_language_check CHECK (preferred_language IS NULL OR preferred_language IN (
    'ENGLISH', 'PORTUGESE', 'SPANISH', 'RUSSIAN', 'FRENCH', 'GEORGIAN', 'CHINESE', 'INDONESIAN', 'ROMANIAN', 'BURMESE',
    'GERMAN', 'PORTUGUESE_BRAZIL', 'VIETNAMESE', 'ITALIAN', 'THAI', 'NORWEGIAN', 'PHRASE', 'SWAHILI'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The reference platform's six states. PENDING becomes PENDING_APPROVAL; DECEASED becomes
-- EXITED with the reason kept; ACTIVE and DORMANT become ACTIVE or INACTIVE
-- by whether the member has a running account (dormancy is a deposit
-- account's state). A pending member who already has running accounts is
-- ACTIVE, since the reference platform opens accounts only for an approved client.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_status_check;
UPDATE members SET status = 'EXITED', exit_reason = 'DECEASED' WHERE status = 'DECEASED';
UPDATE members SET status = 'PENDING_APPROVAL' WHERE status = 'PENDING';
UPDATE members SET status = 'INACTIVE' WHERE status = 'DORMANT';
UPDATE members m SET status = CASE WHEN
    EXISTS (SELECT 1 FROM loan_accounts l WHERE l.member_id = m.id AND l.status IN ('ACTIVE', 'IN_ARREARS', 'LOCKED'))
    OR EXISTS (SELECT 1 FROM savings_accounts a WHERE a.member_id = m.id AND a.status IN ('ACTIVE', 'DORMANT', 'LOCKED'))
  THEN 'ACTIVE' ELSE CASE WHEN m.status = 'PENDING_APPROVAL' THEN 'PENDING_APPROVAL' ELSE 'INACTIVE' END END
 WHERE m.status IN ('ACTIVE', 'INACTIVE', 'PENDING_APPROVAL');
UPDATE members SET activated_at = created_at WHERE status = 'ACTIVE' AND activated_at IS NULL;
UPDATE members SET approved_at = created_at WHERE status IN ('ACTIVE', 'INACTIVE') AND approved_at IS NULL;
ALTER TABLE members ADD CONSTRAINT members_status_check
  CHECK (status IN ('PENDING_APPROVAL', 'INACTIVE', 'ACTIVE', 'EXITED', 'BLACKLISTED', 'REJECTED'));
ALTER TABLE members ALTER COLUMN status SET DEFAULT 'INACTIVE';

-- National IDs without spaces and in capitals, so the unique index means it.
-- A value that would then equal another member's is left as it is.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, national_id FROM members WHERE national_id IS NOT NULL
             AND national_id <> upper(regexp_replace(national_id, '\s', '', 'g')) LOOP
    BEGIN
      UPDATE members SET national_id = upper(regexp_replace(r.national_id, '\s', '', 'g')) WHERE id = r.id;
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'national ID of member % left as it is: another member holds it', r.id;
    END;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS members_holder_type_idx ON members (holder_type, status);
CREATE INDEX IF NOT EXISTS members_phone_key_idx ON members (right(regexp_replace(phone, '\D', '', 'g'), 9)) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS members_email_idx ON members (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS members_branch_idx ON members (branch_id);
CREATE INDEX IF NOT EXISTS members_credit_officer_idx ON members (lower(credit_officer)) WHERE credit_officer IS NOT NULL;

-- Every change of state: by a user (approve, reject, exit, blacklist and their
-- undos) or AUTOMATIC (a first running account, the last one closing).
CREATE TABLE IF NOT EXISTS member_state_changes (
  id          bigserial PRIMARY KEY,
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  from_state  text,
  to_state    text NOT NULL,
  action      text NOT NULL,
  reason      text,
  actor       text NOT NULL DEFAULT 'SYSTEM',
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_state_changes_member_idx ON member_state_changes (member_id, changed_at);

-- --------------------------------------------------------------------------
-- Groups: role names, members and their roles
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_role_names (
  id          text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,32}$'),
  name        text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 254),
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id    uuid NOT NULL REFERENCES members(id),
  member_id   uuid NOT NULL REFERENCES members(id),
  added_by    text,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, member_id),
  CHECK (group_id <> member_id)
);
CREATE INDEX IF NOT EXISTS group_members_member_idx ON group_members (member_id);

CREATE TABLE IF NOT EXISTS group_member_roles (
  group_id      uuid NOT NULL,
  member_id     uuid NOT NULL,
  role_name_id  text NOT NULL REFERENCES group_role_names(id),
  PRIMARY KEY (group_id, member_id, role_name_id),
  FOREIGN KEY (group_id, member_id) REFERENCES group_members (group_id, member_id) ON DELETE CASCADE
);

-- A group holds individuals only, and an exited or rejected client joins none.
-- These checks read members as the table owner (SECURITY DEFINER): a
-- branch-limited user's row security must not hide the row being checked.
CREATE OR REPLACE FUNCTION check_group_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE g record; m record;
BEGIN
  SELECT holder_type INTO g FROM members WHERE id = NEW.group_id;
  SELECT holder_type, status, member_no INTO m FROM members WHERE id = NEW.member_id;
  IF g.holder_type IS DISTINCT FROM 'GROUP' THEN
    RAISE EXCEPTION 'NOT_A_GROUP' USING ERRCODE = '23514';
  END IF;
  IF m.holder_type IS DISTINCT FROM 'CLIENT' THEN
    RAISE EXCEPTION 'A_GROUP_HOLDS_INDIVIDUAL_CLIENTS_ONLY' USING ERRCODE = '23514';
  END IF;
  IF m.status IN ('EXITED', 'REJECTED') THEN
    RAISE EXCEPTION 'CLIENT_MAY_NOT_JOIN_A_GROUP: % is %', m.member_no, m.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS group_members_check ON group_members;
CREATE TRIGGER group_members_check BEFORE INSERT ON group_members FOR EACH ROW EXECUTE FUNCTION check_group_member();

-- --------------------------------------------------------------------------
-- Internal controls for clients and groups (one row)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_controls (
  id                      smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  initial_state           text NOT NULL DEFAULT 'INACTIVE' CHECK (initial_state IN ('INACTIVE', 'PENDING_APPROVAL')),
  duplicate_checks        jsonb NOT NULL DEFAULT '{"DOCUMENT_ID":"ERROR","NAME_AND_BIRTH_DATE":"WARNING","PHONE":"WARNING","EMAIL":"NONE"}',
  required_assignments    text[] NOT NULL DEFAULT '{}'
                          CHECK (required_assignments <@ ARRAY['BRANCH', 'CENTRE', 'CREDIT_OFFICER']::text[]),
  multiple_groups         boolean NOT NULL DEFAULT true,
  group_size_limit_type   text NOT NULL DEFAULT 'NONE' CHECK (group_size_limit_type IN ('NONE', 'WARNING', 'HARD')),
  group_size_limit        int CHECK (group_size_limit IS NULL OR group_size_limit >= 1),
  anonymize_after_days    int CHECK (anonymize_after_days IS NULL OR anonymize_after_days >= 0),
  updated_by              text,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (group_size_limit_type = 'NONE' OR group_size_limit IS NOT NULL)
);
INSERT INTO client_controls (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- Products: who may hold them (the reference platform's "available for")
-- --------------------------------------------------------------------------
ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS available_for text[] NOT NULL DEFAULT '{INDIVIDUALS}';
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS available_for text[] NOT NULL DEFAULT '{INDIVIDUALS}';
-- Share capital is open to groups as well (a chama or other institutional member).
ALTER TABLE share_products ADD COLUMN IF NOT EXISTS available_for text[] NOT NULL DEFAULT '{INDIVIDUALS,GROUPS}';
DO $$ BEGIN
  ALTER TABLE loan_products ADD CONSTRAINT loan_products_available_for_check
    CHECK (cardinality(available_for) > 0 AND available_for <@ ARRAY['INDIVIDUALS', 'GROUPS']::text[]);
  ALTER TABLE savings_products ADD CONSTRAINT savings_products_available_for_check
    CHECK (cardinality(available_for) > 0 AND available_for <@ ARRAY['INDIVIDUALS', 'GROUPS']::text[]);
  ALTER TABLE share_products ADD CONSTRAINT share_products_available_for_check
    CHECK (cardinality(available_for) > 0 AND available_for <@ ARRAY['INDIVIDUALS', 'GROUPS']::text[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- Who may open an account or guarantee (the reference platform's life cycle and type rules)
-- --------------------------------------------------------------------------
-- A new running account needs a holder that is INACTIVE or ACTIVE, of a type
-- that may open accounts, and a product available to its kind of holder. An
-- account created closed (history brought in by an import) and a reschedule
-- or refinance of a running loan are let through.
CREATE OR REPLACE FUNCTION check_holder_may_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE m record; allowed text[]; closed boolean; prod text;
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
  IF TG_TABLE_NAME = 'loan_accounts' THEN SELECT available_for INTO allowed FROM loan_products WHERE id = prod;
  ELSIF TG_TABLE_NAME = 'savings_accounts' THEN SELECT available_for INTO allowed FROM savings_products WHERE id = prod;
  ELSE SELECT available_for INTO allowed FROM share_products WHERE id = prod; END IF;
  IF allowed IS NOT NULL AND NOT ((CASE WHEN m.holder_type = 'GROUP' THEN 'GROUPS' ELSE 'INDIVIDUALS' END) = ANY (allowed)) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE_FOR_%: %', CASE WHEN m.holder_type = 'GROUP' THEN 'GROUPS' ELSE 'INDIVIDUALS' END, prod
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS loan_accounts_holder_may_open ON loan_accounts;
CREATE TRIGGER loan_accounts_holder_may_open BEFORE INSERT ON loan_accounts FOR EACH ROW EXECUTE FUNCTION check_holder_may_open();
DROP TRIGGER IF EXISTS savings_accounts_holder_may_open ON savings_accounts;
CREATE TRIGGER savings_accounts_holder_may_open BEFORE INSERT ON savings_accounts FOR EACH ROW EXECUTE FUNCTION check_holder_may_open();
DROP TRIGGER IF EXISTS share_accounts_holder_may_open ON share_accounts;
CREATE TRIGGER share_accounts_holder_may_open BEFORE INSERT ON share_accounts FOR EACH ROW EXECUTE FUNCTION check_holder_may_open();

CREATE OR REPLACE FUNCTION check_guarantor_may_pledge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE m record;
BEGIN
  IF NEW.status <> 'PLEDGED' THEN RETURN NEW; END IF;
  SELECT mb.status, mb.member_no, t.can_guarantee, t.name AS type_name INTO m
    FROM members mb JOIN client_types t ON t.id = mb.client_type_id WHERE mb.id = NEW.member_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF m.status NOT IN ('INACTIVE', 'ACTIVE') THEN
    RAISE EXCEPTION 'GUARANTOR_MAY_NOT_PLEDGE: % is %', m.member_no, m.status USING ERRCODE = '23514';
  END IF;
  IF NOT m.can_guarantee THEN
    RAISE EXCEPTION 'TYPE_MAY_NOT_GUARANTEE: % is of the type %', m.member_no, m.type_name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS loan_guarantors_may_pledge ON loan_guarantors;
CREATE TRIGGER loan_guarantors_may_pledge BEFORE INSERT ON loan_guarantors FOR EACH ROW EXECUTE FUNCTION check_guarantor_may_pledge();

-- ACTIVE and INACTIVE follow the accounts: ACTIVE while the holder has a
-- running loan (active, in arrears or locked) or an open deposit account
-- (active, dormant or locked). Share accounts do not count (the reference platform has none).
-- Runs as the table owner so that a branch-limited user's posting still
-- moves the state of a member whose row they cannot see.
CREATE OR REPLACE FUNCTION refresh_member_state(mid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE cur text; nxt text;
BEGIN
  SELECT status INTO cur FROM members WHERE id = mid;
  IF cur IS NULL OR cur NOT IN ('INACTIVE', 'ACTIVE') THEN RETURN; END IF;
  nxt := CASE WHEN
      EXISTS (SELECT 1 FROM loan_accounts l WHERE l.member_id = mid AND l.status IN ('ACTIVE', 'IN_ARREARS', 'LOCKED'))
      OR EXISTS (SELECT 1 FROM savings_accounts a WHERE a.member_id = mid AND a.status IN ('ACTIVE', 'DORMANT', 'LOCKED'))
    THEN 'ACTIVE' ELSE 'INACTIVE' END;
  IF nxt = cur THEN RETURN; END IF;
  UPDATE members SET status = nxt, activated_at = COALESCE(activated_at, CASE WHEN nxt = 'ACTIVE' THEN now() END) WHERE id = mid;
  INSERT INTO member_state_changes (member_id, from_state, to_state, action) VALUES (mid, cur, nxt, 'AUTOMATIC');
END $$;

CREATE OR REPLACE FUNCTION member_state_follows_accounts() RETURNS trigger AS $$
BEGIN
  PERFORM refresh_member_state(NEW.member_id);
  IF TG_OP = 'UPDATE' AND OLD.member_id IS DISTINCT FROM NEW.member_id THEN PERFORM refresh_member_state(OLD.member_id); END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS loan_accounts_member_state ON loan_accounts;
CREATE TRIGGER loan_accounts_member_state AFTER INSERT OR UPDATE OF status, member_id ON loan_accounts
  FOR EACH ROW EXECUTE FUNCTION member_state_follows_accounts();
DROP TRIGGER IF EXISTS savings_accounts_member_state ON savings_accounts;
CREATE TRIGGER savings_accounts_member_state AFTER INSERT OR UPDATE OF status, member_id ON savings_accounts
  FOR EACH ROW EXECUTE FUNCTION member_state_follows_accounts();

-- --------------------------------------------------------------------------
-- Identification documents: the template that fills the national ID, and a
-- document number compared without spaces, hyphens or case
-- --------------------------------------------------------------------------
ALTER TABLE id_templates ADD COLUMN IF NOT EXISTS national_id boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS id_templates_one_national_id ON id_templates (national_id) WHERE national_id;
UPDATE id_templates SET national_id = true
 WHERE (SELECT count(*) FROM id_templates WHERE id_type ILIKE 'national id%') = 1 AND id_type ILIKE 'national id%'
   AND NOT EXISTS (SELECT 1 FROM id_templates WHERE national_id);
ALTER TABLE member_identifications ADD COLUMN IF NOT EXISTS document_key text
  GENERATED ALWAYS AS (upper(regexp_replace(document_id, '[\s-]', '', 'g'))) STORED;
CREATE INDEX IF NOT EXISTS member_identifications_key_idx ON member_identifications (document_key);

-- --------------------------------------------------------------------------
-- Permissions (the reference platform's Clients and Groups codes). What EDIT_CLIENT allowed
-- before (state, centre, credit officer) now has codes of its own; roles that
-- held it keep what it did. Deleting and anonymizing are new, and left to
-- administrators.
-- --------------------------------------------------------------------------
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['VIEW_GROUP_DETAILS']::text[]) c ORDER BY c)
 WHERE 'VIEW_CLIENT_DETAILS' = ANY (permissions);
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['CREATE_GROUP']::text[]) c ORDER BY c)
 WHERE 'CREATE_CLIENT' = ANY (permissions);
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['APPROVE_CLIENT', 'REJECT_CLIENT',
    'EXIT_CLIENT', 'BLACKLIST_CLIENT', 'UNDO_CLIENT_STATE_CHANGED', 'CHANGE_CLIENT_TYPE', 'MANAGE_CLIENT_ASSOCIATION', 'EDIT_CLIENT_ID',
    'EDIT_BLACKLISTED_CLIENT_CFV', 'EDIT_GROUP', 'CHANGE_GROUP_TYPE', 'MANAGE_GROUP_ASSOCIATION', 'EDIT_GROUP_ID']::text[]) c ORDER BY c)
 WHERE 'EDIT_CLIENT' = ANY (permissions);

-- --------------------------------------------------------------------------
-- Lookups across every branch (as the table owner): whether an ID is taken,
-- and the possible duplicates of a client. A branch-limited user must not
-- miss a duplicate held in a branch they cannot see; they learn only its
-- member number and state.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION member_no_taken(no text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT EXISTS (SELECT 1 FROM members WHERE member_no = no)
$$;

CREATE OR REPLACE FUNCTION duplicate_members(exclude uuid, doc_keys text[], fname text, lname text, dob date, phone_keys text[], mail text)
RETURNS TABLE (check_name text, member_id uuid, member_no text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT 'DOCUMENT_ID', m.id, m.member_no, m.status FROM members m
   WHERE cardinality(doc_keys) > 0 AND m.id IS DISTINCT FROM exclude AND m.holder_type = 'CLIENT' AND m.anonymized_at IS NULL
     AND (upper(regexp_replace(m.national_id, '[\s-]', '', 'g')) = ANY (doc_keys)
          OR EXISTS (SELECT 1 FROM member_identifications d WHERE d.member_id = m.id AND d.document_key = ANY (doc_keys)))
  UNION ALL
  SELECT 'NAME_AND_BIRTH_DATE', m.id, m.member_no, m.status FROM members m
   WHERE dob IS NOT NULL AND m.id IS DISTINCT FROM exclude AND m.holder_type = 'CLIENT' AND m.anonymized_at IS NULL
     AND lower(m.first_name) = lower(fname) AND lower(m.last_name) = lower(lname) AND m.date_of_birth = dob
  UNION ALL
  SELECT 'PHONE', m.id, m.member_no, m.status FROM members m
   WHERE cardinality(phone_keys) > 0 AND m.id IS DISTINCT FROM exclude AND m.holder_type = 'CLIENT' AND m.anonymized_at IS NULL
     AND (right(regexp_replace(m.phone, '\D', '', 'g'), 9) = ANY (phone_keys) OR right(regexp_replace(m.phone2, '\D', '', 'g'), 9) = ANY (phone_keys))
  UNION ALL
  SELECT 'EMAIL', m.id, m.member_no, m.status FROM members m
   WHERE mail IS NOT NULL AND m.id IS DISTINCT FROM exclude AND m.holder_type = 'CLIENT' AND m.anonymized_at IS NULL
     AND lower(m.email) = lower(mail)
$$;
