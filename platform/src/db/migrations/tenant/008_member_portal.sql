-- Member self-service: credentials, sessions, beneficiaries.
--
-- Members are not platform users. Staff live in platform.users and carry
-- roles; a member lives in this schema, signs in with a phone number and a
-- PIN, and can see and move only what is theirs. Keeping the two apart in
-- the data model is what keeps them apart in the code: there is no column
-- on platform.users that could accidentally be set to make a member a
-- teller, and no member row that could be promoted.

-- Activation, not registration. A member exists because the SACCO admitted
-- them; the portal only lets an existing member claim their record by
-- proving they know the identifiers on it. One credential per member.
CREATE TABLE IF NOT EXISTS member_credentials (
  member_id       uuid PRIMARY KEY REFERENCES members(id),
  phone           text NOT NULL UNIQUE,
  pin_hash        text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_attempts int  NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  activated_at    timestamptz NOT NULL DEFAULT now(),
  pin_changed_at  timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

-- Refresh tokens for members, same shape and same rules as the staff ones
-- in platform.refresh_tokens: hashed at rest, single use, reuse burns the
-- family. Held here rather than in the platform schema so a tenant backup
-- carries its members' sessions and a tenant drop removes them.
CREATE TABLE IF NOT EXISTS member_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES members(id),
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_sessions_member_idx ON member_sessions (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS member_sessions_family_idx ON member_sessions (family_id);

-- Saved recipients. A beneficiary who is also a member of this SACCO is
-- linked, so a transfer to them resolves to a real account; one who is not
-- is a name and a phone number for the member's own reference.
CREATE TABLE IF NOT EXISTS beneficiaries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id             uuid NOT NULL REFERENCES members(id),
  name                  text NOT NULL,
  phone                 text,
  account_no            text,
  relationship          text,
  beneficiary_member_id uuid REFERENCES members(id),
  daily_limit           numeric(18,2) CHECK (daily_limit IS NULL OR daily_limit > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (phone IS NOT NULL OR account_no IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS beneficiaries_member_idx ON beneficiaries (member_id);

-- Portal sign-in attempts, so a lockout can be reasoned about afterwards.
CREATE TABLE IF NOT EXISTS member_login_attempts (
  id          bigserial PRIMARY KEY,
  phone       text NOT NULL,
  member_id   uuid REFERENCES members(id),
  succeeded   boolean NOT NULL,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_login_attempts_phone_idx ON member_login_attempts (phone, created_at DESC);
