-- Users and Access Control, after the reference platform.

-- A role's access rights: the reference platform (the back office: signing in with a password)
-- and API (API consumers may be given the role). api_access exists already.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS console_access boolean NOT NULL DEFAULT true;

-- Every route now checks a permission (lib/routePermissions). Before this,
-- most of them checked the built-in role, so a role saved earlier held only
-- the permissions checked then. Give each saved role the new permissions its
-- base role holds, so what its users could do stays what they could do.
-- Tellers now post cash through a till with ADD_CASH and REMOVE_CASH (the reference platform's
-- meaning), and closing a till is a supervisor's permission.
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['VIEW_BRANCH_DETAILS','VIEW_CENTRE_DETAILS','VIEW_TRANSACTION_CHANNELS','VIEW_DOCUMENTS','VIEW_LOAN_PRODUCT_DETAILS','VIEW_SAVINGS_PRODUCT_DETAILS','VIEW_CUSTOM_FIELD','CREATE_CLIENT','CREATE_DOCUMENTS','EDIT_DOCUMENTS','CREATE_SAVINGS_ACCOUNT','MAKE_DEPOSIT','MAKE_WITHDRAWAL','MAKE_TRANSFER','APPLY_SAVINGS_FEES','ENTER_REPAYMENT','CREATE_LOAN_ACCOUNT','EDIT_LOAN_ACCOUNT','CREATE_SECURITIES','REQUEST_LOAN_APPROVAL','SET_LOAN_INCOMPLETE','WITHDRAW_LOAN_ACCOUNTS','PAY_OFF_LOAN','EDIT_LOAN_TRANCHES','EDIT_INVESTOR_FUNDS','APPLY_LOAN_FEES','REFINANCE_LOAN_ACCOUNT','WRITE_OFF_LOAN_ACCOUNTS','LINK_ACCOUNTS','BUY_SHARES','POST_TRANSACTIONS_ON_LOCKED_LOAN_ACCOUNTS','PERFORM_REPAYMENTS_WITH_CUSTOM_AMOUNTS_ALLOCATION','SET_DISBURSEMENT_CONDITIONS','EDIT_CLIENT','DELETE_DOCUMENTS','EDIT_SAVINGS_ACCOUNT','CLOSE_SAVINGS_ACCOUNTS','APPLY_ACCRUED_SAVINGS_INTEREST','MANAGE_DEPOSIT_ASSOCIATION','APPLY_SAVINGS_ADJUSTMENTS','DELETE_SECURITIES','EDIT_SECURITIES','COLLECT_GUARANTIES','APPROVE_LOANS','REJECT_LOANS','UNDO_REJECT_LOANS','UNDO_WITHDRAW_LOAN_ACCOUNTS','LOCK_LOAN_ACCOUNTS','CLOSE_LOAN_ACCOUNTS','UNDO_LOAN_ACCOUNT_CLOSURE','TERMINATE_LOAN_ACCOUNTS','EDIT_INTEREST_RATE','RESCHEDULE_LOAN_ACCOUNT','EDIT_REPAYMENT_SCHEDULE','APPLY_LOAN_ADJUSTMENTS','DIBURSE_LOANS','APPLY_ACCRUED_LOAN_INTEREST','EDIT_PENALTY_RATE','APPROVE_WRITE_OFFS','MANAGE_LOAN_ASSOCIATION','CREATE_LOAN_PRODUCT','EDIT_LOAN_PRODUCT','CREATE_SAVINGS_PRODUCT','EDIT_SAVINGS_PRODUCT','MANAGE_INDEX_RATES','CREATE_BRANCH','EDIT_BRANCH','CREATE_CENTRE','EDIT_CENTRE','MANAGE_INTERBRANCH_GLACCOUNT_RULES','MAKE_ACCOUNTING_CLOSURE','APPLY_ACCOUNTING_ADJUSTMENTS','MANAGE_ACCOUNTS','LOG_JOURNAL_ENTRIES','MANAGE_HOLIDAYS','CREATE_TRANSACTION_CHANNELS','EDIT_TRANSACTION_CHANNELS','DELETE_TRANSACTION_CHANNELS','MANAGE_GENERAL_SETUP','CREATE_EXCHANGE_RATE','CREATE_ACCOUNTING_RATES','CREATE_CUSTOM_FIELD','EDIT_CUSTOM_FIELD','DELETE_CUSTOM_FIELD','CREATE_PRODUCT_DOCUMENT_TEMPLATES','EDIT_PRODUCT_DOCUMENT_TEMPLATES','DELETE_PRODUCT_DOCUMENT_TEMPLATES','IMPORT_DATA','VIEW_DATA_IMPORTS','TRANSFER_SHARES','MANAGE_DIVIDENDS','MANAGE_PROVISIONING','RUN_PROVISIONING','CLOSE_FINANCIAL_YEAR','MANAGE_RETURNS','VIEW_USER_DETAILS']::text[]) c ORDER BY c) WHERE base_role = 'MANAGER';
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['VIEW_BRANCH_DETAILS','VIEW_CENTRE_DETAILS','VIEW_TRANSACTION_CHANNELS','VIEW_DOCUMENTS','VIEW_LOAN_PRODUCT_DETAILS','VIEW_SAVINGS_PRODUCT_DETAILS','VIEW_CUSTOM_FIELD','MAKE_ACCOUNTING_CLOSURE','EXTRACT_DATA','RUN_PROVISIONING']::text[]) c ORDER BY c) WHERE base_role = 'ACCOUNTANT';
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['VIEW_BRANCH_DETAILS','VIEW_CENTRE_DETAILS','VIEW_TRANSACTION_CHANNELS','VIEW_DOCUMENTS','VIEW_LOAN_PRODUCT_DETAILS','VIEW_SAVINGS_PRODUCT_DETAILS','VIEW_CUSTOM_FIELD','CREATE_CLIENT','CREATE_DOCUMENTS','EDIT_DOCUMENTS','CREATE_SAVINGS_ACCOUNT','MAKE_DEPOSIT','MAKE_WITHDRAWAL','MAKE_TRANSFER','APPLY_SAVINGS_FEES','ENTER_REPAYMENT','CREATE_LOAN_ACCOUNT','EDIT_LOAN_ACCOUNT','CREATE_SECURITIES','REQUEST_LOAN_APPROVAL','SET_LOAN_INCOMPLETE','WITHDRAW_LOAN_ACCOUNTS','PAY_OFF_LOAN','EDIT_LOAN_TRANCHES','EDIT_INVESTOR_FUNDS','APPLY_LOAN_FEES','REFINANCE_LOAN_ACCOUNT','WRITE_OFF_LOAN_ACCOUNTS','LINK_ACCOUNTS','BUY_SHARES','POST_TRANSACTIONS_ON_LOCKED_LOAN_ACCOUNTS','PERFORM_REPAYMENTS_WITH_CUSTOM_AMOUNTS_ALLOCATION','SET_DISBURSEMENT_CONDITIONS','ADD_CASH','REMOVE_CASH']::text[]) c ORDER BY c)  WHERE base_role = 'TELLER';
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['VIEW_BRANCH_DETAILS','VIEW_CENTRE_DETAILS','VIEW_TRANSACTION_CHANNELS','VIEW_DOCUMENTS','VIEW_LOAN_PRODUCT_DETAILS','VIEW_SAVINGS_PRODUCT_DETAILS','VIEW_CUSTOM_FIELD','VIEW_USER_DETAILS','EXTRACT_DATA','VIEW_DATA_IMPORTS']::text[]) c ORDER BY c) WHERE base_role = 'AUDITOR';
UPDATE roles SET permissions = array_remove(permissions, 'CLOSE_TILL') WHERE base_role = 'TELLER';
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['MANAGE_EOD_PROCESSING']::text[]) c ORDER BY c)
 WHERE base_role = 'MANAGER';

-- Branch access (the reference platform's Access Rights on a user). Row security under the
-- sacco_branch_scoped role, which the app switches to only for a user limited
-- to some branches or to their own members (platform migration 008). The
-- owner the app normally runs as is not subject to it.
UPDATE transactions t SET branch_id = COALESCE(
    (SELECT branch_id FROM loan_accounts WHERE id = t.loan_account_id),
    (SELECT branch_id FROM savings_accounts WHERE id = t.savings_account_id),
    (SELECT branch_id FROM members WHERE id = t.member_id))
 WHERE t.branch_id IS NULL;
ALTER TABLE members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_accounts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions     ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branch_access ON members;
DROP POLICY IF EXISTS branch_access ON loan_accounts;
DROP POLICY IF EXISTS branch_access ON savings_accounts;
DROP POLICY IF EXISTS branch_access ON transactions;
CREATE POLICY branch_access ON members USING (platform.branch_visible(branch_id, credit_officer));
CREATE POLICY branch_access ON loan_accounts USING (platform.branch_visible(branch_id, credit_officer));
CREATE POLICY branch_access ON savings_accounts USING (platform.branch_visible(branch_id, NULL));
CREATE POLICY branch_access ON transactions USING (platform.branch_visible(branch_id, NULL));

-- The audit trail (the reference platform's Audit Trail): one row per API request, staff or
-- API consumer. Payloads are kept with personal details and secrets removed.
CREATE TABLE IF NOT EXISTS audit_events (
  id                bigserial PRIMARY KEY,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  event_source      text NOT NULL CHECK (event_source IN ('UI', 'API')),
  request_method    text NOT NULL,
  request_uri       text NOT NULL,
  resource          text,
  resource_fragment text,
  username          text,
  client_ip         text,
  user_agent        text,
  response_code     int,
  request_payload   text,
  duration_ms       int
);
CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_user ON audit_events (lower(username), occurred_at DESC);

-- Posting through a till needs ADD_CASH (cash in) or REMOVE_CASH (cash out); the
-- request's permissions are in app.till_add and app.till_remove (db/tenantContext).
CREATE OR REPLACE FUNCTION transactions_till_link() RETURNS trigger AS $$
DECLARE
  actor text := nullif(current_setting('app.actor', true), '');
  required boolean := coalesce(current_setting('app.till_required', true), '') = 'true';
  may_add boolean := coalesce(current_setting('app.till_add', true), 'true') = 'true';
  may_remove boolean := coalesce(current_setting('app.till_remove', true), 'true') = 'true';
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
  -- The reference platform's Add Cash and Remove Cash: a teller's permission to post cash in or out through a till.
  IF s = 1 AND NOT may_add THEN
    RAISE EXCEPTION 'PERMISSION_REQUIRED: ADD_CASH, to post deposits and repayments through till %', t.till_code USING ERRCODE = '42501';
  END IF;
  IF s = -1 AND NOT may_remove THEN
    RAISE EXCEPTION 'PERMISSION_REQUIRED: REMOVE_CASH, to post withdrawals and disbursements through till %', t.till_code USING ERRCODE = '42501';
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

-- A credit officer on a member or a loan is a staff user of this tenant of
-- the credit officer type (the reference platform), or an administrator, who has the credit
-- officer's rights. Checked when it is set or changed; a loan that takes its
-- member's credit officer unchanged is not checked again.
CREATE OR REPLACE FUNCTION check_credit_officer() RETURNS trigger AS $$
DECLARE u record;
BEGIN
  IF NEW.credit_officer IS NULL OR NEW.credit_officer = '' THEN NEW.credit_officer := NULL; RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.credit_officer IS NOT DISTINCT FROM OLD.credit_officer THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'loan_accounts' AND TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM members m WHERE m.id = (to_jsonb(NEW)->>'member_id')::uuid AND lower(m.credit_officer) = lower(NEW.credit_officer)) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT pu.email, pu.status, pu.role, COALESCE(pu.user_type, r.user_type) AS user_type INTO u
    FROM platform.users pu LEFT JOIN roles r ON r.code = pu.role_code
   WHERE pu.tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema()) AND lower(pu.email) = lower(NEW.credit_officer);
  IF NOT FOUND OR u.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'CREDIT_OFFICER_NOT_AN_ACTIVE_USER: %', NEW.credit_officer USING ERRCODE = '22023';
  END IF;
  IF u.role <> 'TENANT_ADMIN' AND COALESCE(u.user_type, '') <> 'CREDIT_OFFICER' THEN
    RAISE EXCEPTION 'NOT_A_CREDIT_OFFICER: % is not of the credit officer user type', NEW.credit_officer USING ERRCODE = '22023';
  END IF;
  NEW.credit_officer := lower(u.email);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS members_credit_officer ON members;
CREATE TRIGGER members_credit_officer BEFORE INSERT OR UPDATE OF credit_officer ON members FOR EACH ROW EXECUTE FUNCTION check_credit_officer();
DROP TRIGGER IF EXISTS loan_accounts_credit_officer ON loan_accounts;
CREATE TRIGGER loan_accounts_credit_officer BEFORE INSERT OR UPDATE OF credit_officer ON loan_accounts FOR EACH ROW EXECUTE FUNCTION check_credit_officer();
