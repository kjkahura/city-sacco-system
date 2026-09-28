-- Users and Access Control, after the reference platform: user types and branch access on the
-- user, the four remaining transaction limits, lockout, password history and
-- expiry, per-tenant access preferences, session inactivity, API consumers
-- and keys, and blocked IP addresses.

ALTER TABLE platform.users
  ADD COLUMN IF NOT EXISTS user_type        text CHECK (user_type IN ('ADMINISTRATOR', 'TELLER', 'CREDIT_OFFICER')),
  ADD COLUMN IF NOT EXISTS title            text,
  ADD COLUMN IF NOT EXISTS language         text NOT NULL DEFAULT 'en',
  -- Branch access: every branch, or the user's branch and the ones listed.
  ADD COLUMN IF NOT EXISTS all_branches     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS branch_access    uuid[] NOT NULL DEFAULT '{}',
  -- A credit officer sees the members of other credit officers only with this.
  ADD COLUMN IF NOT EXISTS other_officers_clients boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS fee_limit        numeric(18,2),
  ADD COLUMN IF NOT EXISTS deposit_limit    numeric(18,2),
  ADD COLUMN IF NOT EXISTS withdrawal_limit numeric(18,2),
  ADD COLUMN IF NOT EXISTS repayment_limit  numeric(18,2),
  ADD COLUMN IF NOT EXISTS failed_logins    int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_at        timestamptz,
  ADD COLUMN IF NOT EXISTS locked_until     timestamptz,
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();

-- Passwords a user may not use again (the reference platform's Limit Previously Used Passwords).
CREATE TABLE IF NOT EXISTS platform.password_history (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_history_user ON platform.password_history (user_id, created_at DESC);

-- Access preferences (the reference platform's Administration > Access > Preferences), one
-- document per tenant; lib/accessPreferences holds the defaults and limits.
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS access_preferences jsonb NOT NULL DEFAULT '{}';

-- Session inactivity: the last request of a signed-in session (a refresh
-- token family), and the sign-in history's detail.
ALTER TABLE platform.refresh_tokens ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE platform.login_attempts
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS reason     text;

-- API consumers and their keys (the reference platform's API Consumers). Kept in the control
-- plane with the tenant, like users: a key is checked before any tenant
-- query runs. A consumer's access is a role, permissions of its own, or the
-- administrator type.
CREATE TABLE IF NOT EXISTS platform.api_consumers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  administrator boolean NOT NULL DEFAULT false,
  role_code     text,
  permissions   text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  secret_hash   text,
  secret_created_at timestamptz,
  prev_secret_hash  text,
  prev_secret_until timestamptz,
  notes         text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_consumers_name ON platform.api_consumers (tenant_id, lower(name));

CREATE TABLE IF NOT EXISTS platform.api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id  uuid NOT NULL REFERENCES platform.api_consumers(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  key_hash     text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  expires_at   timestamptz,
  rotated_at   timestamptz,
  grace_until  timestamptz,
  replaced_by  uuid,
  last_used_at timestamptz,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_consumer ON platform.api_keys (consumer_id);

-- Addresses that sent ten requests with a bad API key (the reference platform blocks them,
-- whitelisted or not, until an administrator resets them).
CREATE TABLE IF NOT EXISTS platform.ip_blocks (
  tenant_id  uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  ip         text NOT NULL,
  failures   int NOT NULL DEFAULT 0,
  blocked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ip)
);

-- Branch access is enforced by row security (tenant migration 032) under a
-- role the app switches to for a user limited to some branches. The role can
-- read the control plane and is given the tenant's tables as each tenant
-- migrates (db/migrate). Without the right to create roles the platform
-- refuses branch-limited users rather than let them see every branch.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sacco_branch_scoped') THEN
    CREATE ROLE sacco_branch_scoped NOLOGIN;
  END IF;
  EXECUTE format('GRANT sacco_branch_scoped TO %I', current_user);
  GRANT USAGE ON SCHEMA platform TO sacco_branch_scoped;
  GRANT SELECT ON ALL TABLES IN SCHEMA platform TO sacco_branch_scoped;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'sacco_branch_scoped not created (no CREATEROLE): branch-limited users will be refused';
END
$$;

CREATE OR REPLACE FUNCTION platform.grant_branch_scoped(schema_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sacco_branch_scoped') THEN RETURN; END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO sacco_branch_scoped', schema_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO sacco_branch_scoped', schema_name);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO sacco_branch_scoped', schema_name);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'grants to sacco_branch_scoped on % not made', schema_name;
END
$$;

-- Whether a row of a branch (and a credit officer) is visible to the request:
-- app.branches is empty for a user with every branch, else the branch ids;
-- app.officer is the credit officer whose members alone they see, or empty.
CREATE OR REPLACE FUNCTION platform.branch_visible(branch uuid, officer text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (COALESCE(current_setting('app.branches', true), '') = ''
          OR branch::text = ANY (string_to_array(current_setting('app.branches', true), ',')))
     AND (COALESCE(current_setting('app.officer', true), '') = ''
          OR officer IS NULL OR lower(officer) = current_setting('app.officer', true))
$$;
GRANT EXECUTE ON FUNCTION platform.branch_visible(uuid, text) TO PUBLIC;
