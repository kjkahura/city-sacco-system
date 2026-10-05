# Events Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull-based event streaming after the reference platform: streaming templates publish events to topics, and API consumers subscribe, read batches over HTTP and commit cursors.

**Architecture:**
- **Templates:** `notification_templates` gains type `EVENT_STREAM` and a fixed `topic`.
- **Publishing:** the webhook dispatcher publishes a matching event to `stream_events` in the pass that queues webhooks.
- **Reading:** `src/domain/streaming.js` serves subscriptions, streams (newline-separated JSON batches, polled from the database), cursor commits and statistics at `/api/v1/subscriptions`.

**Tech Stack:** Node 22, Express 5, Postgres 16.

**Spec:** `platform/docs/audits/audit-events-streaming.md`. John accepted all nine defaults on 5 October 2026, including 55-second streams with reconnects.

## Global Constraints

- **Vendor name:** never in code, docs or commits.
- **Writing style:** no em dashes.
- **The topic:** `sacco.event.<tenant slug>.streamingapi.<template name in snake case>`. It is set when the template is made and never changes.
- **The stream:**
  - one partition, `"0"`; offsets are zero-padded to 18 digits;
  - the stream ID is in the header `X-Stream-Id`;
  - `stream_timeout` is capped by `STREAM_MAX_SECONDS` (default 55);
  - `batch_limit` defaults to 1, `batch_flush_timeout` to 30 s, `commit_timeout` to 60 s (at most 60), and `max_uncommitted_events` to 10.
- **Retention:** 7 days (`STREAM_RETENTION_DAYS`).
- **Readers:** one stream per subscription at a time; a second gets 409. A session not heard from for 10 s is free again.
- **Cursor tokens:** an HMAC of the subscription, stream, topic and offset.
- **Permissions:** a new CONSUME_EVENT_STREAMS, held by administrators by default. Streaming templates use CREATE_ and EDIT_COMMUNICATION_TEMPLATES.
- **The communication log:** no rows for streamed events.

## Review Focus

1. A reader that never commits stops getting new batches after `max_uncommitted_events`. Its stream closes after `commit_timeout`.
2. A client that disconnects releases its slot, so a new stream can start without waiting for the stale-session window.
3. A commit carrying another stream's ID, or a forged token, is refused.
4. A topic is unaffected when its template is renamed.
5. Events published while no stream is open are read from the committed cursor on the next stream.

## Tasks

### Task 1: Migration 046, templates of type EVENT_STREAM, publishing

- [x] **Write checks (RED):**
  - an EVENT_STREAM template is created without a URL and gets its topic;
  - renaming it keeps the topic;
  - a deposit with an active streaming template publishes one event, with its body, metadata and template name;
  - no communication log row is written.
- [x] **Implement:**
  - migration 046: the type check, `topic`, `stream_events`, `stream_subscriptions`, `stream_cursors`, `stream_sessions`;
  - the template validation per type;
  - publishing in `dispatch.processEvents`;
  - retention in the daily purge;
  - descriptions in the data dictionary.

### Task 2: Subscriptions, streams, commits, stats

- [x] **Write checks against a real HTTP stream (RED):**
  - creating returns 201, and the same subscription again returns 200;
  - `read_from` `end` and `begin`;
  - batches are newline-separated, with the cursor, token, events and the `X-Stream-Id` header;
  - keep-alive batches;
  - `batch_limit`, `stream_limit` and `stream_timeout` are honoured;
  - a second stream gets 409, and the slot is free after a disconnect;
  - a commit gives 204, an older offset gives `outdated`, and a wrong stream ID or a forged token gives 422;
  - streams resume from the committed cursor;
  - `max_uncommitted_events` holds back new batches;
  - stats report unconsumed events and lag;
  - delete;
  - permissions.
- [x] **Implement:** `src/domain/streaming.js` and `src/routes/streaming.js`, the mount, the route permissions and the permission code.

### Task 3: Console, docs, full runs

- [x] **Write console checks (RED):** Administration > Events Streaming shows the streaming templates with their topics, a form to create one, and the subscriptions with their lag.
- [x] **Implement:** `public/js/streaming.js`; the tab's screens; README; the build log; the audits README row; full runs in both time zones; commit and sync.
