# Build log: SMS

Built on 5 October 2026 from `audit-sms.md`, under John's direction that SMS be pluggable, with no specific provider. He accepted the nine decision defaults and asked for delivery reports (decision 7). The plan is `docs/superpowers/plans/2026-10-05-sms.md`. There is one commit on main, not pushed.

## Built

### Providers (`src/domain/notifications/channels/sms-providers/`)

- **The interface (README.md there):**
  - `fields` for the settings form;
  - `validate`, `describe` and `server` (what a stored key belongs to);
  - `send(settings, secret, { to, text, from, id })`, returning the outcome with `permanent`;
  - an optional `parseDeliveryReport`.

  A provider is a file and a line in `index.js`. The dispatcher, templates, console and log do not change.
- **No company's gateway is built in.** The one provider, `HTTP`, is a generic HTTPS gateway configured by fields:
  - the URL (through the outbound guard, with no fragment);
  - the method (POST or GET) and the body format (JSON or form);
  - the API key header and prefix;
  - a body template with `{{to}}`, `{{text}}`, `{{from}}` and `{{id}}`. Values are escaped for JSON or form encoding, and a JSON template must stay JSON once filled;
  - where the answer carries the message ID, and an optional success field;
  - how delivery reports carry the message ID and the status, and which statuses mean delivered or not.
- **Outcomes:**
  - 401 and 403 are `INVALID_SMS_GATEWAY_CREDENTIALS`;
  - other 4xx answers fail at once as `SMS_GATEWAY_ERROR`;
  - 5xx answers and network errors are retried;
  - a 2xx answer without the success value fails.

### The channel (`channels/sms.js`, tenant migration 048)

- **Settings:**
  - the provider, the sender ID (up to 11 letters and digits, or a number) and the provider's fields;
  - the API key, sealed and never returned, which must be typed again when the gateway's origin or key header changes;
  - the switch, which starts off, and the pace of 60 a minute;
  - a test SMS.
- **Numbers (E.164):**
  - written with `+` or `00`, a number is read as international;
  - digits that start with a listed calling code and have that country's length are read as that country's;
  - otherwise a number is national to the tenant's country, with or without the trunk 0, and of that country's length;
  - a tenant country that is not listed reads international numbers only.
- **Length:** at most six segments. GSM-7 is 160 characters in one segment, then 153 a segment; UCS-2 is 70, then 67. An extension character or an emoji is never split across two segments.
- **The API:**
  - `GET` and `PUT /api/notificationsettings/sms`;
  - `GET .../sms/providers`;
  - `POST .../sms:test`;
  - `POST .../sms:callbackToken`.

  Template users read; administrators change, test and make the report address.

### Templates, delivery and reports

- **Templates:** type `SMS`, plain text, with the recipients `CLIENT` and `GROUP_ROLE`. Credit officers are left out, since staff have no phone number on record. The text is checked against the limit with sample values, and the segment count is returned.
- **Delivery:**
  - `SMS` messages in the communication log, with the number in E.164, the segments and the gateway's message ID;
  - recipients follow subscriptions, and exited members are skipped;
  - `MISSING_SMS_RECIPIENT`, `UNDEFINED_DESTINATION`, `SMS_SERVICE_NOT_ENABLED` and the size limit are checked when a message is queued and again when it is sent, so a resent message cannot skip them.
- **Delivery reports:**
  - **The address:** `/hooks/sms/<tenant>/<token>`. It is https (or `PUBLIC_BASE_URL`) and shown once; only the token's SHA-256 is kept, compared in constant time; a new address retires the old one; it is rate limited.
  - **A report:** JSON, a form or a query, one report or a list of up to 1,000. It marks SMS messages of that tenant `DELIVERED` or `UNDELIVERED` with the gateway's status. Reports for unknown messages are ignored.
- **Manual SMS:**
  - `POST /api/communications/messages:sendSms` from a member, group, loan or deposit account, to the holder's number;
  - checked for the number and the limit;
  - needs SEND_MANUAL_SMS, which is new and held by managers and administrators;
  - changing a template's text needs EDIT_COMMUNICATION_TEMPLATES;
  - `GET /api/communications/sms-templates` lists the templates for senders.

### Console and portal

- **Administration > SMS:**
  - **SMS Templates:** a character and segment count as you type;
  - **Settings:** the provider's fields drawn from its definition, the switch, a test, and a new delivery report address.
- **Send SMS** on member, group, loan and deposit pages, with the segment count.
- **The subscriptions card** and the portal list both email and SMS templates, with the channel.
- **The communication log** filters by SMS and shows the delivery status.

### Docs

- **README:** a new "SMS" section.
- **docs/deploy.md:** a note on `PUBLIC_BASE_URL` and the report address.
- **The provider README.**
- **Audits README:** row 21.

## Tests

- **`test/sms.test.js` (57 checks):** a gateway run inside the test. The checks cover:
  - numbers and segments;
  - the providers list, settings and the guard;
  - the key going to no other gateway;
  - templates;
  - each outcome, retries and the success field;
  - delivery reports (JSON, form, wrong token, unknown ID, a new address);
  - resends checked again;
  - a GET gateway with a six-segment UCS-2 text;
  - manual SMS and the portal.
- **`test/console.test.js`:** Administration > SMS, the report address, templates with the count, and Send SMS on the member page.
- **Full runs in UTC and Africa/Nairobi:** all suites pass, except the known date-dependent checks in lending, loan-accounting and loan-accounts. These fail on the base commit too.

## Final review

A fresh reviewer found no critical issues, three important ones and four minor ones. All were fixed, test-first where a check could show them:

- **Important:**
  - a resent SMS skipped the number and length checks;
  - international numbers without `+` got the tenant's code added;
  - a GET gateway refused long texts, and a URL fragment swallowed the query.
- **Minor:**
  - emoji and extension characters split across segments;
  - the report hook had no rate limit;
  - control characters in the API key;
  - the report address could be http.

## Not built

- Phone numbers for staff, and SMS to credit officers (decision 5).
- A provider for a specific company's gateway: the generic one covers most, and the README describes how to add one.
- Two-way SMS (replies).
