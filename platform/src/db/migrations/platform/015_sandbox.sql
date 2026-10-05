-- Sandboxes, after the reference platform (docs/audits/audit-getting-started-and-sandbox.md):
-- a second tenant per SACCO, linked to its production tenant, and the
-- queue of operations that create, reset, clone and delete it.

ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'PRODUCTION'
  CHECK (environment IN ('PRODUCTION', 'SANDBOX'));
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS production_tenant_id uuid REFERENCES platform.tenants(id) ON DELETE SET NULL;
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS sandbox_state text CHECK (sandbox_state IN ('READY', 'CREATING', 'RESETTING', 'CLONING', 'DELETING', 'FAILED'));
-- One sandbox per production tenant (a closed one does not count).
CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_sandbox ON platform.tenants (production_tenant_id)
  WHERE production_tenant_id IS NOT NULL AND status <> 'CLOSED';

CREATE TABLE IF NOT EXISTS platform.sandbox_operations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_tenant_id    uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  kind                    text NOT NULL CHECK (kind IN ('CREATE', 'RESET', 'CLONE', 'DELETE')),
  anonymize               boolean,
  state                   text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
  detail                  text,
  -- The sandbox administrator the operation leaves: who asked, with a password shown to them once.
  admin_email             text,
  admin_password_hash     text,
  requested_by            text NOT NULL,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  started_at              timestamptz,
  finished_at             timestamptz
);
CREATE INDEX IF NOT EXISTS sandbox_operations_tenant_idx ON platform.sandbox_operations (production_tenant_id, requested_at DESC);
-- One operation at a time per SACCO.
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_operations_one_open ON platform.sandbox_operations (production_tenant_id)
  WHERE state IN ('QUEUED', 'RUNNING');
