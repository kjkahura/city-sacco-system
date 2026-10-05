# Audit: SMS against the reference platform

Audited on 5 October 2026, at the Email commit. Nothing is built yet. The proposed build and its decisions are at the end.

John's direction for this section: SMS is pluggable, with no specific provider, and the interface and APIs are ready for a provider to be plugged in.

## Reference pages read

- **SMS setup (Administration > SMS > Settings):**
  - the gateway is one of Twilio, Infobip or None (switched off). Other gateways need the vendor's support;
  - the fields are a username, a password (or API key), the sender's phone number and, for one gateway, a base URL;
  - a test send checks the connection and the credentials by sending a message;
  - users with administration visibility or template permissions see the settings; only administrators change them.
- **Automated SMS notifications (Administration > SMS > Templates):**
  - the same fields as email (name, subscription option, target, recipient, event trigger, conditions), with the text and placeholders in place of a subject and body;
  - recipients are the same: the client or the credit officer; for groups, the credit officer or members holding a role;
  - long messages are split into segments by the gateway and billed as several. The platform refuses messages over a maximum length before sending.
- **Manual SMS notifications:**
  - Send SMS on a client or group profile, or on one of its loan or deposit accounts;
  - from a template (changed before sending only with EDIT_COMMUNICATION_TEMPLATES) or typed;
  - sent to the account holder's phone number;
  - permission `SEND_MANUAL_SMS`;
  - the button is hidden when SMS is off, the holder has no phone number, or the user lacks the permission.
- **Troubleshooting email and SMS failures:** `SMS_SERVICE_NOT_ENABLED`, `INVALID_SMS_GATEWAY_CREDENTIALS`, `MISSING_SMS_RECIPIENT`, `UNDEFINED_DESTINATION` and `SMS_GATEWAY_ERROR`.

These pages did not give the maximum length, the phone number format sent to the gateway, or whether delivery reports are read.

## What the platform has

- **From the Email build, ready for a second channel:**
  - `notification_channels` already allows `SMS`. It holds a switch, the fields, a sealed secret and a pace;
  - `channels/index.js` loads, saves and tests any channel that implements `validate`, `describe`, `server`, `send` and `test`;
  - the template table, recipients (`CLIENT`, `CREDIT_OFFICER`, `GROUP_ROLE`), subscriptions (including the portal), the dispatcher's sending by type, outcomes, retries, the pace, resend and the communication log;
  - the manual email route and console dialog, which a manual SMS can copy.
- **Phone numbers:**
  - members and groups have `phone` (and `phone2`), typed in local or international form;
  - the portal reads Kenyan numbers in four forms and stores them as `2547...`;
  - a tenant has a `country_code` (KE by default).
- **Credit officers** are users with an email address and no phone number on record.
- **The outbound guard** checks HTTPS addresses for webhooks, including at connection time.
- **The console:** Administration > SMS is a placeholder tab.

## Findings

### 1. Providers, and why the reference platform's model does not fit

- **The reference platform** has two gateways built in, and others need the vendor.
- **SACCOs in this market** use local aggregators (bulk SMS resellers and telcos), each with its own HTTP API. No single provider covers them, and building one in would tie the platform to it.
- **What fits John's direction:** a provider interface that any gateway can be written against, and one built-in provider that is not tied to a company: a generic HTTPS gateway configured by fields. Most aggregators take a POST with the number, the text, a sender ID and an API key in a header. That can be described without code.

### 2. The provider interface

A provider module has:

- **its fields:** what the settings form shows, which of them is secret, and checks;
- **`send(settings, secret, { to, text, from, id })`:** returns `{ ok, providerMessageId }` or `{ ok: false, reason, cause, permanent }`;
- **`test`.**

The registry lists the providers. Adding one is adding a file and a line, with no change to the dispatcher, templates or console.

### 3. The generic HTTPS gateway

- **Settings:**
  - the URL (HTTPS, a public address, through the outbound guard);
  - the method (POST or GET);
  - a header for the API key and its name;
  - the content type (JSON or form);
  - a body template with `{{to}}`, `{{text}}`, `{{from}}` and `{{id}}`;
  - where to find the message ID in the answer;
  - optionally, a field and value that mark success.
- **Values:** escaped for the content type, so a message cannot change the request.
- **Outcomes:**
  - a 2xx answer (and the success field, when given) is sent;
  - 401 and 403 are `INVALID_SMS_GATEWAY_CREDENTIALS`;
  - other 4xx answers are `SMS_GATEWAY_ERROR`, failed at once;
  - 5xx answers, timeouts and network errors are `SMS_GATEWAY_ERROR` and retried.

### 4. Phone numbers

A gateway needs one form. Numbers should be sent in international form without spaces (E.164, for example `+254712345678`), read from the local form with the tenant's country. A number that cannot be read is `UNDEFINED_DESTINATION`. A holder with none is `MISSING_SMS_RECIPIENT`.

### 5. Length

- **Segments:** a GSM-7 message is 160 characters in one segment and 153 a segment after that. A message with any other character (UCS-2) is 70, then 67.
- **The reference platform** refuses long messages without saying where the limit is.
- **A limit** of six segments (918 GSM-7 or 402 UCS-2 characters) covers statements and reminders and bounds the cost.

The template form can show the segment count of the sample.

### 6. Recipients

Credit officers have no phone number on record. SMS templates can write to the client or group and to group members with a role. `CREDIT_OFFICER` would need a phone on users, which is outside this section.

### 7. Delivery reports

The reference platform does not say it reads them. Gateways that send them call back an address. A callback endpoint can come with a later provider; the message ID is kept so it can be matched.

### 8. Shared with Email

- **Shared parts:** subscriptions (staff pages and the portal), the pace, retries, resend and the communication log work unchanged.
- **New parts:** a SEND_MANUAL_SMS permission, and a manual route like the email one.

## Proposed build

1. **Tenant migration 048:**
   - `notification_messages` gains `provider_message_id` and `segments`;
   - SMS templates use `content_type` `PLAIN_TEXT` and the existing `recipient`.
2. **The SMS channel (`channels/sms.js`):**
   - settings: `provider`, the sender ID, the provider's fields, and the sealed secret;
   - phone numbers in E.164 from the tenant's country;
   - segment counting and the limit.
3. **Providers (`channels/sms-providers/`):**
   - `index.js` is the registry;
   - `http.js` is the generic HTTPS gateway;
   - `README.md` describes the interface for whoever writes the next one.
4. **Templates:** `type: SMS` in `/api/templates`, with a text of at most the limit once filled with sample values, and the recipients `CLIENT` and `GROUP_ROLE`.
5. **Delivery:** the dispatcher queues `SMS` messages per subscribed recipient and sends them through the provider, with the outcomes above.
6. **Manual SMS:** `POST /api/communications/messages:sendSms`, SEND_MANUAL_SMS, and `GET /api/communications/sms-templates`.
7. **Settings API:** `GET` and `PUT /api/notificationsettings/sms`, `:test`, and `GET /api/notificationsettings/sms/providers` (each provider's fields, for the form).
8. **Console:**
   - Administration > SMS: Templates (with the segment count) and Settings (provider, fields, switch, test);
   - Send SMS on member, group, loan and deposit pages;
   - subscriptions on the member page and in the portal list SMS too;
   - the log's type filter adds SMS.
9. **Tests:** `test/sms.test.js` against an HTTPS gateway run inside the test, with the test certificate.

## Decisions (my default in brackets)

1. **Providers:** a provider interface plus one built-in generic HTTPS gateway configured by fields. No company's gateway is built in. [Interface and generic gateway]
2. **Phone numbers:** sent in E.164, read from local forms with the tenant's country. [Yes]
3. **Length:** at most six segments; longer messages are refused, and templates are checked with sample values. [Six segments]
4. **Sender ID:** one setting per SACCO, sent to the gateway as `{{from}}`. [Yes]
5. **Recipients:** the client or group, and group members with a role. Credit officers are left out until users have phone numbers. [As stated]
6. **Retries:** 5xx answers and network errors retried on the webhook schedule; 4xx answers fail at once. [As stated]
7. **Delivery reports:** not read now; the provider's message ID is kept for a later callback. [Not now]
8. **Manual SMS:** from member, group, loan and deposit pages, under a new SEND_MANUAL_SMS permission held by managers and administrators. [Yes]
9. **Pace:** 60 messages a minute per SACCO by default, changeable. [60 a minute]
