# Build log: Events Streaming

Built on 5 October 2026 from `audit-events-streaming.md`. John accepted its nine decision defaults, including 55-second streams that clients reconnect. The plan is `docs/superpowers/plans/2026-10-05-events-streaming.md`. There is one commit on main, not pushed.

## Built

### Streaming templates and publishing (tenant migration 046)

- **Templates:** `notification_templates` takes type `EVENT_STREAM`, alongside `WEB_HOOK`.
  - A streaming template has the webhook's event, target, conditions, trigger and body. It has no URL, authentication, headers or signing.
  - Its topic is `sacco.event.<tenant slug>.streamingapi.<name in snake case>`. It is set when the template is made and does not change when the template is renamed.
  - A topic is not given to a new template while another template, a subscription or kept events use it. A clash gets `_2`, `_3` and so on.
  - A template keeps its type. `:test` and `:rotateSecret` refuse streaming templates.
  - The audit trail records `STREAM_TEMPLATE_CREATED`, `STREAM_TEMPLATE_EDITED` and `STREAM_TEMPLATE_DELETED`.
- **Publishing (`dispatch.publish`):**
  - in the pass that turns events into webhook messages, a matching active streaming template publishes the event to `stream_events` with its filled body, event, category, template name, content type and branch;
  - a body that does not parse once filled is published as the platform's own JSON, so the event is not lost;
  - publishers take a per-tenant transaction lock before inserting, so a later offset is never visible before an earlier one;
  - no communication log row is written.
- **Retention:** the daily purge deletes events older than `STREAM_RETENTION_DAYS` (7).
- **Tables:** `stream_events`, `stream_subscriptions`, `stream_cursors` and `stream_sessions`, all described in the data dictionary.

### Subscriptions, streams, commits and statistics

- **Domain (`src/domain/streaming.js`)** and **routes (`src/routes/streaming.js`)** at `/api/v1/subscriptions`:
  - `POST /`: creates a subscription (201), or returns the same one (200). `read_from` is `begin`, `end` or `cursors` with `initial_cursors`. Unknown topics give 422. Two identical requests at once give one subscription;
  - `GET /`: the subscriptions, with their committed offsets, unconsumed events and stream state;
  - `GET /:id/events`: the stream;
  - `POST /:id/cursors`: commits;
  - `GET /:id/stats`: unconsumed events, and the lag with `show_time_lag=true`;
  - `DELETE /:id`.
- **The stream:**
  - newline-separated JSON batches, `{ cursor: { partition, offset, event_type, cursor_token }, events? }`, with the stream ID in `X-Stream-Id`;
  - one partition, `"0"`; offsets are the event's id padded to 18 digits;
  - parameters `batch_limit`, `stream_limit`, `batch_flush_timeout`, `stream_timeout`, `max_uncommitted_events` (at most 1000), `stream_keep_alive_limit` and `commit_timeout` (at most 60);
  - capped at `STREAM_MAX_SECONDS` (55);
  - keep-alive batches after `batch_flush_timeout` with nothing to send;
  - no new batch while `max_uncommitted_events` are sent and uncommitted; the stream closes when a batch stays uncommitted for `commit_timeout`;
  - writes wait for the client to read (backpressure);
  - each read of the database takes one of the tenant's request slots, which the stream does not hold while it waits.
- **One stream per subscription:**
  - `stream_sessions` holds the reading stream; a second stream gets 409;
  - a stream that ends or disconnects frees the subscription at once;
  - a session not heard from for 10 seconds can be taken over, and the old stream stops within a second.
- **Commits:** a cursor token is an HMAC (`secrets.sign`) of the subscription, stream, topic and offset. A commit with another stream's ID or a forged token gives 422. An offset at or below the committed one is `outdated`.
- **Ownership:** a subscription belongs to the API consumer or user that made it (`owner_id`). Others get 404 for it, and 409 for the same application, consumer group and topics. Administrators reach every one.
- **Branches:** row security on `stream_events` gives a branch-limited user only its branches' events.
- **Permission:** `CONSUME_EVENT_STREAMS` in the Communication group. The console's list is also open to those who see the templates.

### Console

- **Administration > Events Streaming** replaces the placeholder:
  - **Streaming Templates:** the list with each topic, and a form with the placeholder picker and conditions;
  - **Subscriptions:** application, consumer group, topics, committed offsets, unconsumed events and stream state, with delete.
- **Webhooks** lists only webhooks (`?type=WEB_HOOK`).

### Docs

- README section "Events streaming", the deploy note on long requests, and row 19 of the audits README.

## Tests

- **`test/events-streaming.test.js` (39 checks, real HTTP streams):** templates and topics, publishing, subscriptions, batches and keep-alives, limits, one stream at a time, commits, resuming, stats, `read_from`, delete and permissions. The final review added:
  - publishers taking turns;
  - ownership;
  - identical creates at once;
  - topic reuse;
  - audit names;
  - branch-limited readers.
- **`test/console.test.js`:** the Events Streaming screens, and the Webhooks list leaving out streaming templates.
- **Full runs in UTC and Africa/Nairobi:** all suites pass, except the known date-dependent checks in lending, loan-accounting and loan-accounts. These fail on the base commit too.

## Final review

A fresh reviewer found one critical issue, four important ones and four minor ones. All were fixed, test-first where a check could show them:

- **Critical:** offsets visible out of order could make a reader skip an event. Publishers now take turns until they commit.
- **Important:**
  - branch-limited readers saw every branch;
  - a client that did not read could make the server buffer without limit;
  - streams read the database outside the tenant's concurrency limit, with one query per topic;
  - any consumer could read, commit or delete another's subscription.
- **Minor:**
  - topic reuse;
  - a race on identical creates;
  - the commit clock restarted by any commit (now per batch);
  - console rows that looked clickable;
  - webhook audit names on streaming templates.

## Not built

- More than one partition per topic, and more than one reader per subscription.
- The communication log's `EVENT_STREAM` messages (decision 7).
- Streams longer than the cap through `web.app`. Raise the Cloud Run timeout and `STREAM_MAX_SECONDS` together, and read from the `run.app` address.
