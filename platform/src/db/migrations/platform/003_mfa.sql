-- Multi-factor authentication.

ALTER TABLE platform.users
  ADD COLUMN IF NOT EXISTS mfa_enabled     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_secret      text,
  ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz,
  -- The counter of the last accepted code. A code is good for 30 seconds;
  -- without this, one observed over someone's shoulder can be replayed
  -- inside that window.
  ADD COLUMN IF NOT EXISTS mfa_last_counter bigint;

-- Single-use recovery codes, stored hashed like any other credential.
CREATE TABLE IF NOT EXISTS platform.mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mfa_recovery_user_idx
  ON platform.mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- Short-lived tickets issued after a correct password, exchanged for a real
-- session once the second factor is presented. Keeps the half-authenticated
-- state off the client as anything more than an opaque string.
CREATE TABLE IF NOT EXISTS platform.mfa_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  ticket_hash  text NOT NULL UNIQUE,
  attempts     int NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mfa_challenges_expiry ON platform.mfa_challenges (expires_at);

-- Which roles must have a second factor. Enforced at login, per tenant, so
-- a SACCO can require it of admins before requiring it of every teller.
ALTER TABLE platform.tenants
  ADD COLUMN IF NOT EXISTS mfa_required_roles text[] NOT NULL
    DEFAULT ARRAY['TENANT_ADMIN']::text[];
