-- Events streaming, after the reference platform's Streaming API
-- (docs/audits/audit-events-streaming.md): streaming templates publish to
-- a topic; API consumers subscribe, read batches and commit cursors.

ALTER TABLE notification_templates DROP CONSTRAINT IF EXISTS notification_templates_type_check;
ALTER TABLE notification_templates ADD CONSTRAINT notification_templates_type_check
  CHECK (type IN ('WEB_HOOK', 'EVENT_STREAM', 'EMAIL', 'SMS'));
-- A streaming template's topic, set when it is made and never changed.
ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS topic text UNIQUE;

-- What was published: one row per event and topic. The id is the offset.
CREATE TABLE IF NOT EXISTS stream_events (
  id             bigserial PRIMARY KEY,
  topic          text NOT NULL,
  eid            uuid NOT NULL DEFAULT gen_random_uuid(),
  event          text NOT NULL,
  category       text NOT NULL,
  template_name  text NOT NULL,
  content_type   text NOT NULL,
  body           text NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  branch_id      uuid
);
CREATE INDEX IF NOT EXISTS stream_events_topic_idx ON stream_events (topic, id);
CREATE INDEX IF NOT EXISTS stream_events_age_idx ON stream_events (occurred_at);
-- A user limited to some branches reads the events of those branches, as
-- with the communication log (migration 045). The dispatcher publishes as the system.
ALTER TABLE stream_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branch_access ON stream_events;
CREATE POLICY branch_access ON stream_events USING (platform.branch_visible(branch_id, NULL));

CREATE TABLE IF NOT EXISTS stream_subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owning_application  text NOT NULL CHECK (length(owning_application) BETWEEN 1 AND 255),
  consumer_group      text NOT NULL DEFAULT 'default',
  event_types         text[] NOT NULL,
  read_from           text NOT NULL DEFAULT 'end' CHECK (read_from IN ('begin', 'end', 'cursors')),
  created_by          text,
  -- The API consumer or user that made it; only they (and administrators) read, commit or delete it.
  owner_id            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owning_application, consumer_group, event_types)
);

-- The committed position of a subscription in each of its topics.
CREATE TABLE IF NOT EXISTS stream_cursors (
  subscription_id  uuid NOT NULL REFERENCES stream_subscriptions(id) ON DELETE CASCADE,
  topic            text NOT NULL,
  committed        bigint NOT NULL DEFAULT 0,
  committed_at     timestamptz,
  PRIMARY KEY (subscription_id, topic)
);

-- The one stream reading a subscription (one partition), while it is heard from.
CREATE TABLE IF NOT EXISTS stream_sessions (
  subscription_id  uuid PRIMARY KEY REFERENCES stream_subscriptions(id) ON DELETE CASCADE,
  stream_id        uuid NOT NULL,
  open             boolean NOT NULL DEFAULT true,
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);
