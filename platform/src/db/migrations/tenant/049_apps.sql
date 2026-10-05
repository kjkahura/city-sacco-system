-- Apps, after the reference platform (docs/audits/audit-apps.md): another
-- provider's web application shown in the back office, its extension points,
-- and the one-time launch pages that open it with a signed request.

CREATE TABLE IF NOT EXISTS apps (
  id               text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  provider         text CHECK (length(provider) <= 256),
  description      text CHECK (length(description) <= 4000),
  source_url       text,
  definition       text NOT NULL,
  -- The App Key, sealed (domain/notifications/secrets); never returned.
  app_key          text,
  state            text NOT NULL DEFAULT 'ENABLED' CHECK (state IN ('ENABLED', 'DISABLED')),
  install_url      text,
  uninstall_url    text,
  all_users        boolean NOT NULL DEFAULT true,
  roles            text[] NOT NULL DEFAULT '{}',
  -- The app's API consumer (platform.api_consumers), and whether installing made it.
  consumer_id      uuid,
  consumer_created boolean NOT NULL DEFAULT false,
  installed_by     text,
  installed_at     timestamptz NOT NULL DEFAULT now(),
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_extension_points (
  app_id     text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  position   integer NOT NULL,
  location   text NOT NULL CHECK (location IN ('CLIENT_VIEW', 'GROUP_VIEW', 'LOAN_ACCOUNT_VIEW', 'DEPOSIT_ACCOUNT_VIEW', 'LINE_OF_CREDIT_VIEW',
               'BRANCH_VIEW', 'CENTRE_VIEW', 'LOAN_PRODUCT_VIEW', 'DEPOSIT_PRODUCT_VIEW', 'USER_VIEW', 'REPORTING_VIEW', 'EXTENSION_MENU')),
  label      text NOT NULL CHECK (length(label) BETWEEN 1 AND 256),
  url        text NOT NULL,
  PRIMARY KEY (app_id, position)
);
CREATE INDEX IF NOT EXISTS app_extension_points_location_idx ON app_extension_points (location);

-- A launch page opens once, within a minute; only the SHA-256 of its token is kept.
CREATE TABLE IF NOT EXISTS app_launches (
  token_hash     text PRIMARY KEY,
  app_id         text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  location       text NOT NULL,
  object_id      text,
  url            text NOT NULL,
  -- Cleared once the launch page is opened.
  signed_request text,
  nonce          text NOT NULL,
  actor          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);
CREATE INDEX IF NOT EXISTS app_launches_expiry_idx ON app_launches (expires_at);
ALTER TABLE app_launches ALTER COLUMN signed_request DROP NOT NULL;
