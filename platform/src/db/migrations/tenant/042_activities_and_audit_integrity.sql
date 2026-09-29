-- Auditing after the reference platform (docs/audits/audit-auditing.md): each change
-- log row linked to the member, account, credit arrangement and branch it
-- belongs to, so activities can be read per record and per branch; the
-- request's IP address and channel on each row; the response body of a
-- failed request in the audit trail; and both audit tables protected
-- against change.

-- --------------------------------------------------------------------------
-- Links on the change log. Plain columns, no foreign keys: the log outlives
-- what it describes (a deleted member or account keeps its history).
-- --------------------------------------------------------------------------
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS member_id uuid,
  ADD COLUMN IF NOT EXISTS loan_id uuid,
  ADD COLUMN IF NOT EXISTS savings_account_id uuid,
  ADD COLUMN IF NOT EXISTS credit_arrangement_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid,
  ADD COLUMN IF NOT EXISTS channel text;

CREATE INDEX IF NOT EXISTS audit_log_member ON audit_log (member_id, created_at DESC) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_loan ON audit_log (loan_id, created_at DESC) WHERE loan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_savings ON audit_log (savings_account_id, created_at DESC) WHERE savings_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_arrangement ON audit_log (credit_arrangement_id, created_at DESC) WHERE credit_arrangement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_branch ON audit_log (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log (created_at DESC);

CREATE OR REPLACE FUNCTION audit_uuid(v text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN v::uuid; END IF;
  RETURN NULL;
END $$;

/*
 * What a change log row belongs to, from its record kind and id, then from
 * the ids in its before and after values (for a record already deleted).
 * An account gives its member, branch and credit arrangement; a credit
 * arrangement its holder; a member their branch.
 */
CREATE OR REPLACE FUNCTION audit_links(p_entity text, p_id text, p_before jsonb, p_after jsonb,
  OUT o_member uuid, OUT o_loan uuid, OUT o_savings uuid, OUT o_arrangement uuid, OUT o_branch uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v uuid := audit_uuid(p_id);
  j jsonb := COALESCE(p_before, '{}'::jsonb) || COALESCE(p_after, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(j) <> 'object' THEN j := '{}'::jsonb; END IF;
  CASE p_entity
    WHEN 'member' THEN o_member := v;
    WHEN 'loan_account' THEN
      SELECT id INTO o_loan FROM loan_accounts WHERE id = v OR (v IS NULL AND account_no = p_id) LIMIT 1;
      o_loan := COALESCE(o_loan, v);
    WHEN 'savings_account' THEN
      SELECT id INTO o_savings FROM savings_accounts WHERE id = v OR (v IS NULL AND account_no = p_id) LIMIT 1;
      o_savings := COALESCE(o_savings, v);
    WHEN 'credit_arrangement' THEN o_arrangement := v;
    WHEN 'loan_attachment' THEN SELECT loan_id INTO o_loan FROM loan_attachments WHERE id = v;
    WHEN 'loan_fee' THEN SELECT loan_id INTO o_loan FROM loan_fees WHERE id = v;
    WHEN 'loan_guarantor' THEN SELECT loan_id INTO o_loan FROM loan_guarantors WHERE id = v;
    WHEN 'loan_collateral' THEN SELECT loan_id INTO o_loan FROM loan_collateral WHERE id = v;
    WHEN 'loan_funding_source' THEN SELECT loan_id INTO o_loan FROM loan_funding_sources WHERE id = v;
    WHEN 'loan_write_off_request' THEN SELECT loan_id INTO o_loan FROM loan_write_off_requests WHERE id = v;
    WHEN 'penalty_charge' THEN SELECT loan_id INTO o_loan FROM penalty_charges WHERE id = v;
    WHEN 'loan_planned_fee' THEN
      IF p_id ~ '^[0-9]{1,18}$' THEN SELECT loan_id INTO o_loan FROM loan_planned_fees WHERE id = p_id::bigint; END IF;
    WHEN 'branch' THEN o_branch := v;
    WHEN 'centre' THEN SELECT branch_id INTO o_branch FROM centres WHERE id = v;
    WHEN 'till' THEN SELECT branch_id INTO o_branch FROM tills WHERE id = v;
    ELSE NULL;
  END CASE;
  o_loan := COALESCE(o_loan, audit_uuid(j->>'loan_id'), audit_uuid(j->>'loanId'));
  o_savings := COALESCE(o_savings, audit_uuid(j->>'savings_account_id'), audit_uuid(j->>'savingsAccountId'));
  o_member := COALESCE(o_member, audit_uuid(j->>'member_id'), audit_uuid(j->>'memberId'));
  o_arrangement := COALESCE(o_arrangement, audit_uuid(j->>'credit_arrangement_id'), audit_uuid(j->>'creditArrangementId'));
  o_branch := COALESCE(o_branch, audit_uuid(j->>'branch_id'), audit_uuid(j->>'branchId'));
  IF o_loan IS NOT NULL THEN
    SELECT COALESCE(o_member, l.member_id), COALESCE(o_branch, l.branch_id), COALESCE(o_arrangement, l.credit_arrangement_id)
      INTO o_member, o_branch, o_arrangement FROM loan_accounts l WHERE l.id = o_loan;
  END IF;
  IF o_savings IS NOT NULL THEN
    SELECT COALESCE(o_member, a.member_id), COALESCE(o_branch, a.branch_id), COALESCE(o_arrangement, a.credit_arrangement_id)
      INTO o_member, o_branch, o_arrangement FROM savings_accounts a WHERE a.id = o_savings;
  END IF;
  IF o_arrangement IS NOT NULL AND o_member IS NULL THEN
    SELECT holder_id INTO o_member FROM credit_arrangements WHERE id = o_arrangement;
  END IF;
  IF o_member IS NOT NULL AND o_branch IS NULL THEN
    SELECT branch_id INTO o_branch FROM members WHERE id = o_member;
  END IF;
END $$;

-- Every row written from now on is linked, and carries the request's IP
-- address and channel (UI or API) from the session (db/tenantContext).
CREATE OR REPLACE FUNCTION audit_log_fill() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l record;
  ipv text := nullif(current_setting('app.ip', true), '');
BEGIN
  SELECT * INTO l FROM audit_links(NEW.entity, NEW.entity_id, NEW.before, NEW.after);
  NEW.member_id := COALESCE(NEW.member_id, l.o_member);
  NEW.loan_id := COALESCE(NEW.loan_id, l.o_loan);
  NEW.savings_account_id := COALESCE(NEW.savings_account_id, l.o_savings);
  NEW.credit_arrangement_id := COALESCE(NEW.credit_arrangement_id, l.o_arrangement);
  NEW.branch_id := COALESCE(NEW.branch_id, l.o_branch);
  IF NEW.ip IS NULL AND ipv IS NOT NULL THEN
    BEGIN NEW.ip := ipv::inet; EXCEPTION WHEN others THEN NEW.ip := NULL; END;
  END IF;
  NEW.channel := COALESCE(NEW.channel, nullif(current_setting('app.channel', true), ''));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_log_links ON audit_log;
CREATE TRIGGER audit_log_links BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_fill();

-- The rows already written, linked the same way.
UPDATE audit_log a SET member_id = l.o_member, loan_id = l.o_loan, savings_account_id = l.o_savings,
       credit_arrangement_id = l.o_arrangement, branch_id = l.o_branch
  FROM (SELECT x.id, (audit_links(x.entity, x.entity_id, x.before, x.after)).* FROM audit_log x) l
 WHERE l.id = a.id;

-- --------------------------------------------------------------------------
-- The response body of a failed request (status 400 and above), with
-- personal details removed as request bodies are (ops/auditTrail).
-- --------------------------------------------------------------------------
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS response_payload text;

-- --------------------------------------------------------------------------
-- Neither audit table is changed or emptied. The two exceptions each set a
-- session flag only they use: the retention prune deletes old requests
-- (app.audit_maintenance = 'prune'), and member anonymization clears
-- personal details from change log rows ('anonymize').
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m text := coalesce(current_setting('app.audit_maintenance', true), '');
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'audit_events' AND m = 'prune' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'audit_log' AND m = 'anonymize' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'AUDIT_RECORDS_ARE_IMMUTABLE: % on % is refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_change();
DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_change();
