-- Webhooks, after the reference platform's notifications
-- (docs/audits/audit-webhooks.md): templates, the outbox of events, the
-- communication log and the tenant-wide switch, and the triggers that
-- raise events in the same transaction as the change.
--
-- A trigger writes an event only when an activated template wants it, so a
-- tenant with no webhooks pays one indexed lookup per change and stores
-- nothing.

CREATE TABLE IF NOT EXISTS notification_templates (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 255),
  type                      text NOT NULL DEFAULT 'WEB_HOOK' CHECK (type IN ('WEB_HOOK', 'EMAIL', 'SMS')),
  target                    text NOT NULL,
  event                     text NOT NULL,
  body                      text NOT NULL DEFAULT '',
  activated                 boolean NOT NULL DEFAULT true,
  trigger                   text NOT NULL DEFAULT 'AUTOMATIC' CHECK (trigger IN ('AUTOMATIC', 'MANUAL')),
  trigger_days              integer NOT NULL DEFAULT 0,
  subscription_option       text NOT NULL DEFAULT 'OPT_OUT' CHECK (subscription_option IN ('OPT_IN', 'OPT_OUT')),
  filters_linking_operator  text NOT NULL DEFAULT 'MATCH_ALL' CHECK (filters_linking_operator IN ('MATCH_ALL', 'MATCH_ANY')),
  filter_constraints        jsonb NOT NULL DEFAULT '[]',
  url                       text,
  request_type              text NOT NULL DEFAULT 'POST' CHECK (request_type IN ('POST', 'PUT', 'PATCH')),
  content_type              text NOT NULL DEFAULT 'JSON' CHECK (content_type IN ('PLAIN_TEXT', 'JSON', 'XML')),
  auth_type                 text NOT NULL DEFAULT 'NONE' CHECK (auth_type IN ('NONE', 'BASIC')),
  auth_username             text,
  auth_secret               text,
  headers                   jsonb NOT NULL DEFAULT '[]',
  signing_enabled           boolean NOT NULL DEFAULT true,
  signing_secret            text,
  consecutive_failures      integer NOT NULL DEFAULT 0,
  circuit_open_until        timestamptz,
  last_sent_at              timestamptz,
  created_by                text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_templates_event_idx ON notification_templates (event) WHERE activated;

CREATE TABLE IF NOT EXISTS notification_events (
  id                     bigserial PRIMARY KEY,
  event                  text NOT NULL,
  target                 text NOT NULL,
  member_id              uuid,
  loan_id                uuid,
  savings_account_id     uuid,
  credit_arrangement_id  uuid,
  transaction_id         uuid,
  journal_entry_id       uuid,
  branch_id              uuid,
  activity_type          text,
  data                   jsonb NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS notification_events_pending_idx ON notification_events (id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id           uuid REFERENCES notification_templates(id) ON DELETE SET NULL,
  event_id              bigint REFERENCES notification_events(id) ON DELETE SET NULL,
  type                  text NOT NULL DEFAULT 'WEB_HOOK',
  event                 text NOT NULL,
  state                 text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'WAITING', 'SENT', 'FAILED')),
  waiting_reason        text CHECK (waiting_reason IN ('READY_TO_BE_SENT', 'WAIT_FOR_CLOSE_CIRCUIT', 'SENDING')),
  failure_reason        text,
  failure_cause         text,
  destination           text,
  request_type          text,
  content_type          text,
  body                  text,
  body_cleared_at       timestamptz,
  num_retries           integer NOT NULL DEFAULT 0,
  first_attempt_at      timestamptz,
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  idempotency_key       uuid NOT NULL DEFAULT gen_random_uuid(),
  response_status       integer,
  member_id             uuid,
  group_id              uuid,
  loan_id               uuid,
  savings_account_id    uuid,
  branch_id             uuid,
  test                  boolean NOT NULL DEFAULT false,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at               timestamptz
);
CREATE INDEX IF NOT EXISTS notification_messages_due_idx ON notification_messages (next_attempt_at) WHERE state IN ('QUEUED', 'WAITING');
CREATE INDEX IF NOT EXISTS notification_messages_created_idx ON notification_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS notification_messages_template_idx ON notification_messages (template_id, created_at DESC);

-- A user limited to some branches reads the messages of those branches
-- (row security under sacco_branch_scoped, as in migration 032). The
-- dispatcher runs as the system and sees them all.
ALTER TABLE notification_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branch_access ON notification_messages;
CREATE POLICY branch_access ON notification_messages USING (platform.branch_visible(branch_id, NULL));

CREATE TABLE IF NOT EXISTS notification_settings (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  webhook_state      text NOT NULL DEFAULT 'ENABLED' CHECK (webhook_state IN ('ENABLED', 'DISABLED')),
  last_reminder_day  date,
  last_purge_day     date,
  updated_by         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- Raising an event
-- --------------------------------------------------------------------------

-- Whether any webhook is active: each trigger asks first, so a SACCO with
-- none does no other lookup.
CREATE OR REPLACE FUNCTION notify_any() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM notification_templates WHERE activated)
$$;

CREATE OR REPLACE FUNCTION notify_event(p_event text, p_target text, p_member uuid, p_loan uuid, p_savings uuid,
  p_arrangement uuid, p_transaction uuid, p_journal uuid, p_branch uuid, p_activity text, p_data jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_event IS NULL OR NOT EXISTS (SELECT 1 FROM notification_templates WHERE event = p_event AND activated) THEN
    RETURN;
  END IF;
  INSERT INTO notification_events (event, target, member_id, loan_id, savings_account_id, credit_arrangement_id,
    transaction_id, journal_entry_id, branch_id, activity_type, data)
  VALUES (p_event, p_target, p_member, p_loan, p_savings, p_arrangement, p_transaction, p_journal, p_branch, p_activity, COALESCE(p_data, '{}'));
END $$;

-- Members and groups.
CREATE OR REPLACE FUNCTION notify_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  PERFORM notify_event(CASE WHEN NEW.holder_type = 'GROUP' THEN 'GROUP_CREATED' ELSE 'CLIENT_CREATED' END,
    CASE WHEN NEW.holder_type = 'GROUP' THEN 'GROUP' ELSE 'CLIENT' END, NEW.id, NULL, NULL, NULL, NULL, NULL, NEW.branch_id, NULL);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS members_notify ON members;
CREATE TRIGGER members_notify AFTER INSERT ON members FOR EACH ROW EXECUTE FUNCTION notify_members();

CREATE OR REPLACE FUNCTION notify_member_states() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record;
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  SELECT holder_type, branch_id INTO m FROM members WHERE id = NEW.member_id;
  IF m.holder_type = 'GROUP' THEN RETURN NULL; END IF;
  PERFORM notify_event(CASE NEW.action WHEN 'APPROVE' THEN 'CLIENT_APPROVED' WHEN 'REJECT' THEN 'CLIENT_REJECTED' END,
    'CLIENT', NEW.member_id, NULL, NULL, NULL, NULL, NULL, m.branch_id, NULL,
    jsonb_build_object('fromState', NEW.from_state, 'toState', NEW.to_state));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS member_state_changes_notify ON member_state_changes;
CREATE TRIGGER member_state_changes_notify AFTER INSERT ON member_state_changes FOR EACH ROW EXECUTE FUNCTION notify_member_states();

-- Loan accounts.
CREATE OR REPLACE FUNCTION notify_loans() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM notify_event('LOAN_CREATED', 'LOANS', NEW.member_id, NEW.id, NULL, NEW.credit_arrangement_id, NULL, NULL, NEW.branch_id, NULL);
  ELSIF NEW.credit_arrangement_id IS DISTINCT FROM OLD.credit_arrangement_id THEN
    IF OLD.credit_arrangement_id IS NOT NULL THEN
      PERFORM notify_event('CREDIT_ARRANGEMENT_ACCOUNT_REMOVED', 'CLIENT', NEW.member_id, NEW.id, NULL, OLD.credit_arrangement_id, NULL, NULL, NEW.branch_id, NULL);
    END IF;
    IF NEW.credit_arrangement_id IS NOT NULL THEN
      PERFORM notify_event('CREDIT_ARRANGEMENT_ACCOUNT_ADDED', 'CLIENT', NEW.member_id, NEW.id, NULL, NEW.credit_arrangement_id, NULL, NULL, NEW.branch_id, NULL);
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS loan_accounts_notify ON loan_accounts;
CREATE TRIGGER loan_accounts_notify AFTER INSERT OR UPDATE OF credit_arrangement_id ON loan_accounts FOR EACH ROW EXECUTE FUNCTION notify_loans();

CREATE OR REPLACE FUNCTION notify_loan_states() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l record;
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  SELECT member_id, branch_id INTO l FROM loan_accounts WHERE id = NEW.loan_id;
  PERFORM notify_event(CASE NEW.to_status
      WHEN 'APPROVED' THEN 'LOAN_APPROVAL' WHEN 'IN_ARREARS' THEN 'ACCOUNT_IN_ARREARS'
      WHEN 'CLOSED_REJECTED' THEN 'LOAN_ACCOUNT_REJECTION' WHEN 'CLOSED_REPAID' THEN 'LOAN_ACCOUNT_CLOSURE'
      WHEN 'CLOSED_WRITTEN_OFF' THEN 'LOAN_ACCOUNT_WRITE_OFF' WHEN 'CLOSED_RESCHEDULED' THEN 'LOAN_ACCOUNT_RESCHEDULED'
      WHEN 'CLOSED_REFINANCED' THEN 'LOAN_ACCOUNT_REFINANCED' END,
    'LOANS', l.member_id, NEW.loan_id, NULL, NULL, NULL, NULL, l.branch_id, NULL,
    jsonb_build_object('fromState', NEW.from_status, 'toState', NEW.to_status, 'action', NEW.action));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS loan_state_history_notify ON loan_state_history;
CREATE TRIGGER loan_state_history_notify AFTER INSERT ON loan_state_history FOR EACH ROW EXECUTE FUNCTION notify_loan_states();

-- Deposit accounts.
CREATE OR REPLACE FUNCTION notify_savings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM notify_event('SAVINGS_CREATED', 'SAVINGS', NEW.member_id, NULL, NEW.id, NEW.credit_arrangement_id, NULL, NULL, NEW.branch_id, NULL);
    RETURN NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM notify_event(CASE
        WHEN NEW.status = 'APPROVED' THEN 'SAVINGS_APPROVAL'
        WHEN NEW.status = 'ACTIVE' AND OLD.status IN ('PENDING_APPROVAL', 'APPROVED') THEN 'SAVINGS_ACCOUNT_ACTIVATED'
        WHEN NEW.status = 'IN_ARREARS' THEN 'ACCOUNT_IN_ARREARS'
        WHEN NEW.status = 'CLOSED' AND NEW.closed_as = 'REJECTED' THEN 'SAVINGS_ACCOUNT_REJECTION'
        WHEN NEW.status = 'CLOSED' THEN 'SAVINGS_ACCOUNT_CLOSURE' END,
      'SAVINGS', NEW.member_id, NULL, NEW.id, NULL, NULL, NULL, NEW.branch_id, NULL,
      jsonb_build_object('fromState', OLD.status, 'toState', NEW.status));
  END IF;
  IF NEW.credit_arrangement_id IS DISTINCT FROM OLD.credit_arrangement_id THEN
    IF OLD.credit_arrangement_id IS NOT NULL THEN
      PERFORM notify_event('CREDIT_ARRANGEMENT_ACCOUNT_REMOVED', 'CLIENT', NEW.member_id, NULL, NEW.id, OLD.credit_arrangement_id, NULL, NULL, NEW.branch_id, NULL);
    END IF;
    IF NEW.credit_arrangement_id IS NOT NULL THEN
      PERFORM notify_event('CREDIT_ARRANGEMENT_ACCOUNT_ADDED', 'CLIENT', NEW.member_id, NULL, NEW.id, NEW.credit_arrangement_id, NULL, NULL, NEW.branch_id, NULL);
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS savings_accounts_notify ON savings_accounts;
CREATE TRIGGER savings_accounts_notify AFTER INSERT OR UPDATE OF status, credit_arrangement_id ON savings_accounts
  FOR EACH ROW EXECUTE FUNCTION notify_savings();

-- Transactions: postings on loans and deposit accounts, and their reversals.
CREATE OR REPLACE FUNCTION notify_transactions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ev text;
  tgt text;
  original text;
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  IF NEW.kind = 'REVERSAL' THEN
    SELECT kind INTO original FROM transactions WHERE reference = NEW.allocation->>'reversalOf';
    ev := CASE original
      WHEN 'LOAN_REPAYMENT' THEN 'LOAN_REPAYMENT_REVERSAL' WHEN 'LOAN_DISBURSEMENT' THEN 'LOAN_DISBURSEMENT_REVERSAL'
      WHEN 'SAVINGS_DEPOSIT' THEN 'SAVINGS_DEPOSIT_REVERSAL' WHEN 'SAVINGS_WITHDRAWAL' THEN 'SAVINGS_WITHDRAWAL_REVERSAL' END;
  ELSE
    ev := CASE NEW.kind
      WHEN 'LOAN_DISBURSEMENT' THEN 'LOAN_DISBURSEMENT' WHEN 'LOAN_REPAYMENT' THEN 'LOAN_REPAYMENT'
      WHEN 'LOAN_FEE' THEN 'FEE_APPLIED' WHEN 'LOAN_FEE_ADJUSTED' THEN 'FEE_ADJUSTED' WHEN 'LOAN_FEE_WAIVED' THEN 'FEE_ADJUSTED'
      WHEN 'LOAN_PENALTY_ADJUSTED' THEN 'PENALTY_ADJUSTMENT' WHEN 'CREDIT_BALANCE_DEPOSIT' THEN 'CREDIT_BALANCE_DEPOSIT'
      WHEN 'SAVINGS_DEPOSIT' THEN 'SAVINGS_DEPOSIT' WHEN 'SAVINGS_WITHDRAWAL' THEN 'SAVINGS_WITHDRAWAL'
      WHEN 'SAVINGS_INTEREST_APPLIED' THEN 'DEPOSIT_INTEREST_APPLIED' END;
  END IF;
  IF ev IS NULL THEN RETURN NULL; END IF;
  tgt := CASE WHEN ev LIKE 'SAVINGS%' OR ev = 'DEPOSIT_INTEREST_APPLIED' THEN 'SAVINGS' ELSE 'LOANS' END;
  PERFORM notify_event(ev, tgt, NEW.member_id, NEW.loan_account_id, NEW.savings_account_id, NULL, NEW.id, NULL, NEW.branch_id, NULL,
    jsonb_build_object('kind', NEW.kind));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS transactions_notify ON transactions;
CREATE TRIGGER transactions_notify AFTER INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION notify_transactions();

-- Credit arrangements.
CREATE OR REPLACE FUNCTION notify_arrangements() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r record;
  ev text;
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'INSERT' THEN ev := 'CREDIT_ARRANGEMENT_CREATED';
  ELSIF TG_OP = 'DELETE' THEN ev := 'CREDIT_ARRANGEMENT_DELETED';
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    ev := CASE NEW.state WHEN 'APPROVED' THEN 'CREDIT_ARRANGEMENT_APPROVED' WHEN 'REJECTED' THEN 'CREDIT_ARRANGEMENT_REJECTED'
      WHEN 'WITHDRAWN' THEN 'CREDIT_ARRANGEMENT_WITHDRAWN' WHEN 'CLOSED' THEN 'CREDIT_ARRANGEMENT_CLOSED' ELSE 'CREDIT_ARRANGEMENT_EDITED' END;
  ELSE ev := 'CREDIT_ARRANGEMENT_EDITED';
  END IF;
  PERFORM notify_event(ev, 'CLIENT', r.holder_id, NULL, NULL, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE r.id END, NULL, NULL,
    (SELECT branch_id FROM members WHERE id = r.holder_id), NULL, jsonb_build_object('arrangementNo', r.arrangement_no, 'state', r.state));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS credit_arrangements_notify ON credit_arrangements;
CREATE TRIGGER credit_arrangements_notify AFTER INSERT OR UPDATE OR DELETE ON credit_arrangements FOR EACH ROW EXECUTE FUNCTION notify_arrangements();

-- Journal entries.
CREATE OR REPLACE FUNCTION notify_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  PERFORM notify_event(CASE WHEN NEW.reversal_of IS NULL THEN 'JOURNAL_ENTRY_ADDED' ELSE 'JOURNAL_ENTRY_ADJUSTED' END,
    'ACCOUNTING', NULL, NULL, NULL, NULL, NULL, NEW.id, NEW.branch_id, NULL,
    jsonb_build_object('transactionId', NEW.transaction_id, 'sourceType', NEW.source_type));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS journal_entries_notify ON journal_entries;
CREATE TRIGGER journal_entries_notify AFTER INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION notify_journal();

-- End of day.
CREATE OR REPLACE FUNCTION notify_eod() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  IF NEW.state = 'COMPLETE' THEN
    PERFORM notify_event('END_OF_DAY_PROCESSING_COMPLETED', 'BACKGROUND_PROCESS', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('businessDate', NEW.business_date, 'trigger', NEW.trigger));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS eod_completions_notify ON eod_completions;
CREATE TRIGGER eod_completions_notify AFTER INSERT ON eod_completions FOR EACH ROW EXECUTE FUNCTION notify_eod();

-- The change log: named events, and activity on a member, loan or deposit account.
CREATE OR REPLACE FUNCTION notify_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE group_member boolean;
BEGIN
  IF NOT notify_any() THEN RETURN NULL; END IF;
  IF NEW.action = 'HOLIDAY_SYNC_COMPLETED' THEN
    PERFORM notify_event('HOLIDAY_SYNC_COMPLETED', 'ADMINISTRATIVE', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  ELSIF NEW.action = 'MEMBER_PORTAL_ACTIVATED' THEN
    PERFORM notify_event('PORTAL_ACTIVATED', 'CLIENT', NEW.member_id, NULL, NULL, NULL, NULL, NULL, NEW.branch_id, NULL);
  ELSIF NEW.action = 'LOAN_RATE_CHANGED' THEN
    PERFORM notify_event('INTEREST_RATE_CHANGED', 'LOANS', NEW.member_id, NEW.loan_id, NULL, NULL, NULL, NULL, NEW.branch_id, NEW.action);
  END IF;
  IF NEW.loan_id IS NOT NULL THEN
    PERFORM notify_event('LOAN_ACCOUNT_ACTIVITY', 'LOANS', NEW.member_id, NEW.loan_id, NULL, NULL, NULL, NULL, NEW.branch_id, NEW.action);
  ELSIF NEW.savings_account_id IS NOT NULL THEN
    PERFORM notify_event('SAVINGS_ACCOUNT_ACTIVITY', 'SAVINGS', NEW.member_id, NULL, NEW.savings_account_id, NULL, NULL, NULL, NEW.branch_id, NEW.action);
  ELSIF NEW.member_id IS NOT NULL THEN
    SELECT holder_type = 'GROUP' INTO group_member FROM members WHERE id = NEW.member_id;
    PERFORM notify_event(CASE WHEN group_member THEN 'GROUP_ACTIVITY' ELSE 'CLIENT_ACTIVITY' END,
      CASE WHEN group_member THEN 'GROUP' ELSE 'CLIENT' END, NEW.member_id, NULL, NULL, NULL, NULL, NULL, NEW.branch_id, NEW.action);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS audit_log_notify ON audit_log;
CREATE TRIGGER audit_log_notify AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION notify_audit();
