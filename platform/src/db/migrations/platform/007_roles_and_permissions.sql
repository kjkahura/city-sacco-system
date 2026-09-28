-- Roles and permissions (the reference platform's Users and Access Control): a user holds one
-- role, which may be one of the tenant's own roles (role_code, a code in the
-- tenant schema's roles table), and may be given permissions beyond it.
-- `role` stays the built-in role the user's role is based on: the routes not
-- yet moved to permissions check it.

ALTER TABLE platform.users
  ADD COLUMN IF NOT EXISTS role_code   text,
  ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT '{}';
