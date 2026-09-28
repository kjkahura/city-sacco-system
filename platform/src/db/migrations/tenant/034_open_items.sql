-- The items left open by earlier sections that change nothing already in
-- use: deposit and share account numbers from a counter, member pictures
-- and signatures, and more than one file per identification document.

-- --------------------------------------------------------------------------
-- Account numbers. Deposit (SA) and share (SH) account numbers were
-- count(*) + 1, which repeats a number after an import or when two accounts
-- open at once, and is cut at six digits. They now come from a counter,
-- locked while a number is given out; numbers already taken are stepped
-- over. Numbers already given do not change.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_counters (
  kind         text PRIMARY KEY CHECK (kind IN ('SAVINGS', 'SHARES')),
  prefix       text NOT NULL,
  width        int NOT NULL DEFAULT 6 CHECK (width BETWEEN 1 AND 18),
  next_number  bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1)
);
INSERT INTO account_counters (kind, prefix, next_number)
VALUES ('SAVINGS', 'SA', (SELECT COALESCE(MAX(substring(account_no FROM '^SA([0-9]{1,15})$')::bigint), 0) + 1 FROM savings_accounts)),
       ('SHARES', 'SH', (SELECT COALESCE(MAX(substring(account_no FROM '^SH([0-9]{1,15})$')::bigint), 0) + 1 FROM share_accounts))
ON CONFLICT (kind) DO NOTHING;

-- Whether an account number is taken, across every branch (as the table
-- owner: a branch-limited user must not be handed a number another branch
-- holds).
CREATE OR REPLACE FUNCTION account_no_taken(k text, no text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT CASE k WHEN 'SAVINGS' THEN EXISTS (SELECT 1 FROM savings_accounts WHERE account_no = no)
                WHEN 'SHARES' THEN EXISTS (SELECT 1 FROM share_accounts WHERE account_no = no) END
$$;

-- --------------------------------------------------------------------------
-- A member's picture and signature (the reference platform's profile picture and client
-- signature), one of each, images only.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_media (
  member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('PICTURE', 'SIGNATURE')),
  content       bytea NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif')),
  file_name     text,
  size_bytes    int NOT NULL,
  uploaded_by   text NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, kind)
);

-- --------------------------------------------------------------------------
-- Files on an identification document: up to five, each up to 50 MB
-- (The reference platform's limits), uploaded as the raw request body. The single scan an
-- ID document could carry before (member_identifications.attachment) stays
-- and counts as one of the five.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_identification_files (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identification_id  uuid NOT NULL REFERENCES member_identifications(id) ON DELETE CASCADE,
  file_name          text NOT NULL,
  content_type       text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'application/pdf')),
  content            bytea NOT NULL,
  size_bytes         int NOT NULL,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_identification_files_doc_idx ON member_identification_files (identification_id);

-- --------------------------------------------------------------------------
-- Custom views and menu items of groups (the reference platform's Groups views).
-- --------------------------------------------------------------------------
ALTER TABLE custom_views DROP CONSTRAINT IF EXISTS custom_views_entity_check;
ALTER TABLE custom_views ADD CONSTRAINT custom_views_entity_check CHECK (entity IN ('MEMBERS', 'GROUPS', 'LOANS', 'LOAN_TRANSACTIONS',
  'DEPOSITS', 'DEPOSIT_TRANSACTIONS', 'JOURNAL_ENTRIES', 'ACTIVITIES', 'TASKS'));
ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_type_check;
ALTER TABLE menu_items ADD CONSTRAINT menu_items_type_check CHECK (type IN ('MEMBERS', 'GROUPS', 'LOANS', 'LOAN_TRANSACTIONS', 'DEPOSITS',
  'DEPOSIT_TRANSACTIONS', 'JOURNAL_ENTRIES', 'ACTIVITIES', 'TASKS'));
