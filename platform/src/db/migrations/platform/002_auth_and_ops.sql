-- Refresh tokens and operational bookkeeping.

-- Only the hash is stored. A leaked database does not hand over live
-- sessions, and rotation makes a stolen token single-use.
CREATE TABLE IF NOT EXISTS platform.refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  user_agent  text,
  ip          inet
);

CREATE INDEX IF NOT EXISTS refresh_user_idx ON platform.refresh_tokens (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS refresh_family_idx ON platform.refresh_tokens (family_id);

-- Failed login tracking, for lockout independent of the in-memory limiter.
CREATE TABLE IF NOT EXISTS platform.login_attempts (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid REFERENCES platform.tenants(id) ON DELETE CASCADE,
  email      text NOT NULL,
  ip         inet,
  succeeded  boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_lookup
  ON platform.login_attempts (tenant_id, lower(email), created_at DESC);

CREATE TABLE IF NOT EXISTS platform.backup_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES platform.tenants(id) ON DELETE CASCADE,
  schema_name text NOT NULL,
  path        text,
  bytes       bigint,
  sha256      text,
  status      text NOT NULL DEFAULT 'RUNNING'
              CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','PRUNED')),
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS backup_runs_tenant_idx
  ON platform.backup_runs (tenant_id, started_at DESC);

-- End-of-day job ledger. One row per tenant per job per business date, so a
-- rerun cannot double-accrue interest.
CREATE TABLE IF NOT EXISTS platform.job_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES platform.tenants(id) ON DELETE CASCADE,
  schema_name   text NOT NULL,
  job           text NOT NULL,
  business_date date NOT NULL,
  status        text NOT NULL DEFAULT 'RUNNING'
                CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- The idempotency guard: a succeeded run blocks a second one for that date.
CREATE UNIQUE INDEX IF NOT EXISTS job_runs_once_per_day
  ON platform.job_runs (schema_name, job, business_date)
  WHERE status <> 'FAILED';

-- Per-tenant resource limits, so one SACCO running a heavy report cannot
-- starve the shared pool for everyone else.
ALTER TABLE platform.tenants
  ADD COLUMN IF NOT EXISTS max_concurrent_queries int NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS rate_limit_per_min int NOT NULL DEFAULT 600;
