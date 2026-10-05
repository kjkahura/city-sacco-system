-- SMS, after the reference platform (docs/audits/audit-sms.md): what the
-- gateway said about each message, and the token gateways use to report
-- delivery. Templates, channels and subscriptions are Email's (047).

ALTER TABLE notification_messages ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE notification_messages ADD COLUMN IF NOT EXISTS segments integer;
ALTER TABLE notification_messages ADD COLUMN IF NOT EXISTS delivery_status text CHECK (delivery_status IN ('DELIVERED', 'UNDELIVERED'));
ALTER TABLE notification_messages ADD COLUMN IF NOT EXISTS delivery_detail text;
ALTER TABLE notification_messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
CREATE INDEX IF NOT EXISTS notification_messages_provider_idx ON notification_messages (type, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- The SHA-256 of the token in the delivery report address; the token itself is shown once.
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS callback_token_hash text;
