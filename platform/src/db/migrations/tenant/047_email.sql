-- Email, after the reference platform (docs/audits/audit-email.md): each
-- channel's settings, templates with a subject and recipient, members'
-- subscriptions to templates, and the subject of each message. SMS uses the
-- same tables.

-- A channel's settings: the switch, the fields as JSON, the sealed secret (../domain/notifications/secrets).
CREATE TABLE IF NOT EXISTS notification_channels (
  channel          text PRIMARY KEY CHECK (channel IN ('EMAIL', 'SMS')),
  enabled          boolean NOT NULL DEFAULT false,
  settings         jsonb NOT NULL DEFAULT '{}',
  secret           text,
  pace_per_minute  integer NOT NULL DEFAULT 60 CHECK (pace_per_minute BETWEEN 1 AND 6000),
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS subject text CHECK (length(subject) <= 255);
ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS recipient text CHECK (recipient IN ('CLIENT', 'CREDIT_OFFICER', 'GROUP_ROLE'));
ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS recipient_role text REFERENCES group_role_names(id);
ALTER TABLE notification_templates DROP CONSTRAINT IF EXISTS notification_templates_content_type_check;
ALTER TABLE notification_templates ADD CONSTRAINT notification_templates_content_type_check
  CHECK (content_type IN ('PLAIN_TEXT', 'JSON', 'XML', 'HTML'));

-- A member's or group's choice for a template. Without a row, an opt-out
-- template sends and an opt-in one does not.
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  template_id  uuid NOT NULL REFERENCES notification_templates(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  subscribed   boolean NOT NULL,
  changed_by   text,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, member_id)
);
CREATE INDEX IF NOT EXISTS notification_subscriptions_member_idx ON notification_subscriptions (member_id);

ALTER TABLE notification_messages ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE notification_messages ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;
-- The pace: messages of a type sent in the last minute.
CREATE INDEX IF NOT EXISTS notification_messages_sent_idx ON notification_messages (type, sent_at) WHERE sent_at IS NOT NULL;
