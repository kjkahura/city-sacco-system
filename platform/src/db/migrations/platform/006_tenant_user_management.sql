-- Tenant user management (the reference platform's Users and Access Control): a tenant
-- administrator creates staff, sets their role, branch and status, and
-- resets their password or second factor.

ALTER TABLE platform.users
  -- Set when an administrator creates the user or resets their password:
  -- the temporary password signs in only far enough to choose a new one.
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  -- The branch the user works in, an id in the tenant's own branches table.
  -- Not a foreign key: the branches live in the tenant's schema.
  ADD COLUMN IF NOT EXISTS branch_id  uuid,
  ADD COLUMN IF NOT EXISTS phone      text,
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
