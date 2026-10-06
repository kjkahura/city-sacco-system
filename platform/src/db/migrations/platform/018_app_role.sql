-- The service's own database role (security review, CFG-8): it reads and writes the books but
-- does not own the tables, so it cannot switch off the audit trail's triggers, alter a table or
-- delete audit rows. Migrations and jobs keep running as the owner. The role itself is made by
-- the operator (deploy/security/db-roles.sql); until it exists these grants do nothing.
CREATE OR REPLACE FUNCTION platform.grant_app_role(schema_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sacco_app') THEN RETURN; END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO sacco_app', schema_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO sacco_app', schema_name);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO sacco_app', schema_name);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO sacco_app', schema_name);
  -- The audit trail's triggers (tenant migration 042) refuse every change but two: the retention
  -- prune deletes old requests, and member anonymization clears personal details from change-log
  -- rows. The service keeps exactly those two privileges; it loses the rest, and, not owning the
  -- tables, it cannot switch the triggers off.
  IF to_regclass(format('%I.audit_log', schema_name)) IS NOT NULL THEN
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I.audit_log FROM sacco_app', schema_name);
  END IF;
  IF to_regclass(format('%I.audit_events', schema_name)) IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON %I.audit_events FROM sacco_app', schema_name);
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'grants to sacco_app on % not made', schema_name;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sacco_app') THEN
    PERFORM platform.grant_app_role('platform');
    REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_log FROM sacco_app;
  END IF;
END
$$;
