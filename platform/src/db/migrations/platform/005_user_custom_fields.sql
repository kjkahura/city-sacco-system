-- Custom field values on users (the reference platform's custom fields for the Users
-- entity). The definitions live in each tenant's schema
-- (custom_field_definitions, entity USER); the values sit with the user.

ALTER TABLE platform.users
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';
