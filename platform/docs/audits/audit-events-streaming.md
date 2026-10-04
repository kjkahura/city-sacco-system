# Audit: Events Streaming against the reference platform

Audited on 5 October 2026, at the Webhooks fixes commit (8df391a on the device). Nothing is built yet. The proposed build and its decisions are at the end.

## Reference pages read

- **Streaming API (user guide):**
  - **The model:** event streaming is pull-based. An application subscribes to topics and reads events over a long-lived connection. This suits several systems that each need the same events, where webhooks push one request per event to one address.
  - **Templates:** events come from event streaming templates (Administration > Events Streaming > Templates). Each template has:
    - a unique name of at most 255 characters;
    - a target and an event trigger;
    - an Active status;
    - optional conditions (AND or OR) and an opt-in or opt-out subscription option;
    - a body with placeholders, usually JSON.

    The platform makes a topic from each template.
  - **Delivery:** at least once, so consumers must remove duplicates. Events are in order within a stream and partition, with no order across topics. Events are kept for a limited time, and an idle subscription can lose old events.
  - **Authentication:** an API consumer and its API key.
- **Streaming API reference (OpenAPI):**
  - **`POST /subscriptions`:**
    - body: `owning_application`, `event_types` (topics), `consumer_group` (default `default`), `read_from` (`begin`, `end` (the default) or `cursors`) and `initial_cursors`;
    - answers 201 when created, or 200 with the existing subscription when the same one already exists.
  - **`GET /subscriptions/{id}/events`:**
    - the stream, as newline-separated JSON batches;
    - parameters: `batch_limit` (default 1), `stream_limit`, `batch_flush_timeout` (default 30 s), `stream_timeout` (default 3600 ± 600 s, at most 4200), `max_uncommitted_events`, `stream_keep_alive_limit` and `commit_timeout` (at most 60 s);
    - the answer carries a stream ID header that commits must send back;
    - answers 409 when there is no free slot.
  - **`POST /subscriptions/{id}/cursors`:** `items` of `{ partition, offset, event_type, cursor_token }`. It answers 204 when all are committed, or 200 with `committed` or `outdated` per cursor.
  - **`DELETE /subscriptions/{id}`.**
  - **`GET /subscriptions/{id}/stats`:** per event type and partition, it gives `state` (`assigned`, `unassigned`, `reassigning`), `unconsumed_events`, `consumer_lag_seconds` (with `show_time_lag`) and `stream_id`.
  - **A batch:** `{ cursor, info?, events: [...] }`. An event is `{ metadata: { eid, event_type, occurred_at, content_type, category }, body, template_name }`. A batch with no events keeps the connection alive.
  - **Limits:** at most 100 partitions per subscription. A stream closes when a delivered batch is not committed within the commit timeout.
- **Creating subscriptions:** the topic is `<prefix>.event.<TENANT>.streamingapi.<event name>`, for example `...streamingapi.client_approved`.
- **The communication log** has message type `EVENT_STREAM` and the state `QUEUED_FOR_STREAM`.

These pages did not give the retention period, the number of partitions per topic, the number of readers per subscription, or the default `max_uncommitted_events`.

## What the platform has

- **From the Webhooks build:**
  - the outbox of events, written by triggers in the change's own transaction;
  - templates that already allow other types (`type` in `notification_templates`), with conditions, placeholders and the subscription option;
  - the dispatcher that turns events into messages;
  - the communication log.
- **API consumers and API keys:** the `apikey` header authenticates as an API consumer with a role (Access > API Consumers).
- **The console:** Administration > Events Streaming is a placeholder tab.
- **Hosting:**
  - the service runs on Cloud Run with a 60-second request timeout and at most one instance taking 80 requests at a time;
  - Firebase Hosting in front of it ends any request after 60 seconds, so a long-lived stream through the `web.app` address is cut off after a minute;
  - the Cloud Run address itself (`run.app`) allows up to 60 minutes when the service's timeout is raised.

## Findings

### 1. Templates of type EVENT_STREAM

The template table and API can hold `EVENT_STREAM` templates with the same fields as a webhook, except the address, method, authentication and signing. Each gets a topic named from the tenant and the template.

### 2. Publishing

- **The mechanism:** when an event matches an active streaming template, the dispatcher publishes it to the template's topic with its rendered body, the same way it queues a webhook message.
- **What is stored:** the event is appended with an increasing offset per topic.

### 3. Subscriptions, streams and cursors

- **Subscriptions** are owned by the API consumer that creates them, and are found again by `owning_application`, `event_types` and `consumer_group`.
- **A stream** reads from the committed cursor, sends batches as events arrive, and sends keep-alive batches.
- **Commits:**
  - a commit must carry the stream's ID and each cursor's token;
  - committing an older offset than the one held is `outdated`;
  - a stream whose batches stay uncommitted past the commit timeout is closed.
- **Partitions:** a topic has one partition, so one stream reads a subscription at a time. A second reader gets 409 until the first ends.

### 4. Retention and statistics

- **Retention:** events are removed after a retention period, so a subscription idle longer than that misses them, as on the reference platform.
- **Statistics:** they report the unconsumed events and the lag from the oldest of them.

### 5. Long connections on this hosting

- **Through `web.app`:** a stream is cut at 60 seconds by Firebase Hosting, and the Cloud Run service is set to 60 seconds too.
- **The options:**
  - cap a stream at about 55 seconds by default, and let clients reconnect from their cursor (nothing is lost);
  - or raise the Cloud Run timeout and have stream clients use the `run.app` address.
- **One instance:** with one instance, many long streams also hold connections that ordinary requests share.

### 6. Naming

- **The stream ID header** carries the vendor's name on the reference platform. This repository cannot use that name, so the header must be named differently, for example `X-Stream-Id`. Clients written for the reference platform would need that one header changed.
- **The topic prefix** on the reference platform is an abbreviation of its own name.

### 7. The communication log

- **The reference platform's model:** streamed events appear in the log as `EVENT_STREAM` messages.
- **On this platform:** recording every streamed event as a message would double the storage. The stream's own store already keeps each event, and the statistics show what is unread.

### 8. Permissions

- **The reference platform's rule:** any API consumer with a key may subscribe.
- **On this platform:** consumers have roles, so subscribing can need a permission. Templates use CREATE_ and EDIT_COMMUNICATION_TEMPLATES as webhooks do.

### 9. Console

- **Administration > Events Streaming:**
  - templates (the webhook form without the address part) with each one's topic;
  - the subscriptions, with their consumer, cursors and lag.

## Proposed build

1. **Tenant migration 046:**
   - `stream_events` (topic, offset, event ID, occurred at, content type, body, template name, category);
   - `stream_subscriptions` (consumer, application, consumer group, topics, `read_from`, created);
   - `stream_cursors` (subscription, topic, committed offset);
   - `stream_sessions` (subscription, stream ID, started, last seen).
2. **Templates:** `type: EVENT_STREAM` accepted by `/api/templates`, each with its `topic`.
3. **Publishing:** the dispatcher appends to `stream_events` in the same pass that queues webhooks. It also clears events past retention once a day.
4. **API in the reference platform's shape:**
   - `POST /api/v1/subscriptions`, `GET /api/v1/subscriptions/:id/events`, `POST /api/v1/subscriptions/:id/cursors`, `DELETE /api/v1/subscriptions/:id` and `GET /api/v1/subscriptions/:id/stats`;
   - the stream parameters above, with the stream timeout capped (decision 5);
   - one partition, `"0"`;
   - cursor tokens signed so they cannot be forged.
5. **Console:** templates and subscriptions under Administration > Events Streaming.
6. **Tests:** a new `test/events-streaming.test.js` that reads real streams over HTTP, and console checks.

## Decisions (my default in brackets)

1. **Templates:** event streaming templates share the webhook template table and form, with type `EVENT_STREAM`. [Yes]
2. **Partitions:** one partition per topic, so one reader per subscription at a time. [One]
3. **Retention:** keep streamed events for 7 days. [7 days]
4. **Stream ID header name:** `X-Stream-Id`. [X-Stream-Id]
5. **Topic name:** `sacco.event.<tenant>.streamingapi.<template name in snake case>`. [As stated]
6. **Long connections:**
   - cap a stream at 55 seconds by default, so it works through `web.app`; clients reconnect from their cursor;
   - an environment setting raises the cap where clients use the `run.app` address and the Cloud Run timeout is raised.

   [55 s cap]
7. **The communication log:** do not log each streamed event; the stream store and its statistics take that role. [Do not log]
8. **Who may subscribe:** API consumers whose role has a new permission, CONSUME_EVENT_STREAMS, and administrators. [New permission]
9. **Batch defaults:** `batch_limit` 1, `batch_flush_timeout` 30 s and `commit_timeout` 60 s as on the reference platform, with `max_uncommitted_events` 10. [As stated]
