-- Platform schema: the control plane.
-- Holds the tenant registry and credentials. Never holds member or money data.

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  schema_name   text NOT NULL UNIQUE,
  name          text NOT NULL,
  country_code  char(2) NOT NULL DEFAULT 'KE',
  currency_code char(3) NOT NULL DEFAULT 'KES',
  timezone      text NOT NULL DEFAULT 'Africa/Nairobi',
  status        text NOT NULL DEFAULT 'PROVISIONING'
                CHECK (status IN ('PROVISIONING','ACTIVE','SUSPENDED','CLOSED')),
  plan          text NOT NULL DEFAULT 'STANDARD',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- The slug becomes a schema name, so it must be a safe identifier even
  -- before quote_ident runs. Enforced here so a bad slug cannot be stored.
  CONSTRAINT tenants_slug_is_safe CHECK (slug ~ '^[a-z][a-z0-9_]{2,40}$'),
  CONSTRAINT tenants_schema_is_safe CHECK (schema_name ~ '^tenant_[a-z][a-z0-9_]{2,40}$')
);

-- Credentials live here, scoped to a tenant. Email uniqueness is per tenant,
-- so two SACCOs can both have admin@ without colliding.
CREATE TABLE IF NOT EXISTS platform.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES platform.tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,
  full_name     text,
  role          text NOT NULL DEFAULT 'TELLER'
                CHECK (role IN ('PLATFORM_ADMIN','TENANT_ADMIN','MANAGER','ACCOUNTANT','TELLER','AUDITOR')),
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','SUSPENDED')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- PLATFORM_ADMIN has no tenant; everyone else must have one.
  CONSTRAINT users_tenant_scope CHECK (
    (role = 'PLATFORM_ADMIN' AND tenant_id IS NULL) OR
    (role <> 'PLATFORM_ADMIN' AND tenant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_key
  ON platform.users (tenant_id, lower(email)) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_platform_email_key
  ON platform.users (lower(email)) WHERE tenant_id IS NULL;

-- Per-schema migration ledger. Each tenant schema advances independently, so
-- drift between tenants is detectable rather than silent.
CREATE TABLE IF NOT EXISTS platform.schema_migrations (
  schema_name text NOT NULL,
  version     text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_name, version)
);

-- Control-plane audit. Tenant-level audit lives inside each tenant schema.
CREATE TABLE IF NOT EXISTS platform.audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid REFERENCES platform.tenants(id) ON DELETE SET NULL,
  actor      text,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON platform.audit_log (tenant_id, created_at DESC);
