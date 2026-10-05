# Audit: Email against the reference platform

Audited on 5 October 2026, at the Events Streaming commit. Nothing is built yet. The proposed build and its decisions are at the end.

## Reference pages read

- **Email setup (Administration > Email > Settings):**
  - eight fields: From Name, From Email, Reply-to email, SMTP Host, SMTP Port, Transport Encryption Method (SSL/TLS, usually port 465, or STARTTLS, usually port 587), Username and Password;
  - the password is stored encrypted;
  - users with administration visibility or template permissions see the settings; only administrators change them;
  - a test email checks that the host resolves and connects with the chosen encryption, that the credentials authenticate, and that a message is accepted. It does not save the settings and does not prove inbox delivery;
  - the examples are Google Workspace and Amazon SES.
- **Automated email notifications (Administration > Email > Templates):**
  - name: unique, at most 255 characters, trimmed;
  - subscription option: opt out (recipients are subscribed and may unsubscribe) or opt in (recipients are added by hand);
  - target: clients or groups. The target decides the recipients, placeholders and events;
  - recipient: for clients, the client or the assigned credit officer; for groups, the credit officer or the group members holding a given role;
  - event trigger, and conditions with Match All or Match Any;
  - subject: at most 255 characters;
  - body: rich text and HTML, with placeholders;
  - a status (Active or Inactive) and a state (In Use or Not In Use), as for webhooks.
- **Manual email notifications:**
  - Send > Send Email on a client or group profile, or on one of its loan or deposit accounts;
  - a template (editable before sending only with the permission to edit templates) or free text in a rich text editor;
  - always addressed to the account holder's email address, also when sent from an account;
  - permission `SEND_MANUAL_EMAIL`;
  - needs the SMTP settings and an email address on the profile;
  - one recipient at a time; no bulk sending is described.
- **Troubleshooting email and SMS failures:** the failure reasons `INVALID_SMTP_CREDENTIALS`, `EMAIL_SERVICE_NOT_ENABLED`, `UNDEFINED_DESTINATION`, `MISSING_EMAIL_RECIPIENT` and `MESSAGING_EXCEPTION`, read in the communication log with the failure details.
- **From the Webhooks audit:** the communication log's message `type` includes `EMAIL`; failed messages are resent with RESEND_FAILED_MESSAGES; the templates API takes other types in the same shape.
- **SMS setup**, read for the parts Email and SMS share: Twilio, Infobip or None, a test send, and the same view and change rules.

These pages did not give the retry rules for email, a size limit, the API for sending a manual email, or how a client's subscription to a template is shown and changed.

## What the platform has

- **No email at all:** no SMTP client, no mail dependency, and no code that sends a message to a person. Portal activation, password resets and multi-factor enrolment do not send email.
- **From the Webhooks build:**
  - `notification_templates` with `type`, `subscription_option` (stored, with no effect yet), target, event, conditions and body;
  - the outbox of events, raised by database triggers;
  - the dispatcher: messages with a lease, retries and the communication log (`notification_messages`), resend, the tenant switch in `notification_settings`;
  - placeholders filled from the event's records, with escaping for JSON and XML;
  - secrets sealed with AES-GCM (`secrets.js`);
  - the outbound guard (`src/lib/outbound.js`), for HTTP only.
- **Recipients:**
  - members and groups have `email` and `phone`;
  - a member, group or loan has a `credit_officer`, held as the officer's email;
  - group members hold roles from `group_role_names`;
  - staff users have an email in `platform.users`.
- **The console:** Administration > Email is a placeholder tab. Member, group, loan and deposit pages have no Send action.
- **Hosting:** Cloud Run allows outbound connections on 465 and 587. Port 25 is blocked by Google Cloud.

## Findings

### 1. Settings

- **The model:** each SACCO sends from its own mail server or provider, with the reference platform's eight fields. The password is sealed like the webhook secrets.
- **Who:** administrators change the settings; template users and setup administrators read them, without the password.
- **The test:** a test email to an address the administrator types, reporting each stage (connect, TLS, sign-in, accepted) without saving.

### 2. A guard for the SMTP host

The SMTP host is typed by a tenant, so it must pass the same checks as a webhook URL: no internal or private addresses, checked at connection time against DNS rebinding. Only 465 (implicit TLS) and 587 (STARTTLS) should be allowed, with certificate checks on, so the password never travels in clear.

### 3. Templates of type EMAIL

The template table already holds the shared fields. Email adds:

- **subject**, at most 255 characters, with placeholders;
- **recipient:** for clients, the client or the credit officer; for groups, the credit officer or the members holding a role;
- **an HTML body.** Placeholder values must be escaped for HTML, so a member's name cannot add markup. A plain-text part should go with the HTML for mail clients that show text only.

The console's editor needs a preview. Rendering a tenant's HTML inside the console page would let a template run script there, so the preview belongs in a sandboxed frame.

### 4. Subscriptions (opt in and opt out)

- **The reference platform's model:** opt-out templates reach every recipient unless they unsubscribe; opt-in templates reach only those added.
- **On this platform:** this needs a record per member (or group) and template. Staff change it on the member's page. The member portal could let members change their own.

### 5. Delivery

- **The messages:** through the existing dispatcher, as `EMAIL` messages in the communication log, with the recipient's address as the destination.
- **Outcomes:**
  - a missing address is `MISSING_EMAIL_RECIPIENT`, with no attempt;
  - the switch off is `EMAIL_SERVICE_NOT_ENABLED`;
  - a refused sign-in is `INVALID_SMTP_CREDENTIALS`;
  - any other failure is `MESSAGING_EXCEPTION`, with the server's answer as the detail.
- **Retries:** the pages give none for email. An SMTP server says whether a failure is temporary (4xx) or permanent (5xx). Temporary ones can follow the webhook schedule, and permanent ones fail at once.
- **Pace:** providers limit how fast a sender may send. A per-tenant limit stops an end of day's reminders from tripping it.

### 6. Manual email

- **Where:** Send email on a member or group page and on a loan or deposit account page, addressed to the holder.
- **What:** a template, filled for that record, or free text with a subject.
- **The permission:** a new SEND_MANUAL_EMAIL.
- **The API:** the pages do not give one. The platform needs one for the console in any case.

### 7. Email the platform itself sends

Staff password resets and portal activation could use the same settings. The reference platform's email pages cover only notifications, so this is outside the audit unless you want it.

### 8. Sharing with SMS

SMS has the same parts: settings with a test, templates with recipients and subscriptions, manual sending, and the communication log. Only the provider and the body differ. If Email builds these shared parts with a channel interface, SMS is a provider and a short body on top.

## Proposed build

1. **Tenant migration 047:**
   - `notification_templates` gains `subject` and `recipient` (and `recipient_role` for group roles);
   - `notification_channels` holds the settings per channel (`EMAIL` now, `SMS` next): enabled, the non-secret fields as JSON, and the sealed secret;
   - `notification_subscriptions` (template, member or group, subscribed, changed by, changed at);
   - `notification_messages` gains `subject`.
2. **A channel interface (`src/domain/notifications/channels/`):** `email.js` validates settings, tests them and sends one message. SMS will add `sms.js` with providers behind the same interface.
3. **SMTP sending:**
   - with nodemailer, a widely used MIT-licensed library, connecting through the outbound guard;
   - 465 or 587 only, TLS required, a whole-send deadline.
4. **Templates:** `type: EMAIL` in `/api/templates`, with subject, recipient and HTML body checks. HTML escaping for placeholders, and a plain-text part made from the HTML.
5. **Delivery:**
   - the dispatcher queues `EMAIL` messages to each recipient who is subscribed;
   - outcomes and retries as in finding 5;
   - a per-tenant pace limit.
6. **Manual email:**
   - `POST /api/communications/messages:sendEmail` with the holder (member, group, loan or deposit) and either a template or a subject and body;
   - SEND_MANUAL_EMAIL;
   - logged in the communication log as a manual message.
7. **Settings API:** `GET` and `PUT /api/notificationsettings/email`, and `:test`.
8. **Console:**
   - Administration > Email: Templates (the list and a form with subject, recipient, HTML body, placeholders and a sandboxed preview) and Settings (the fields, the switch and the test);
   - Send email on member, group, loan and deposit pages;
   - email subscriptions on the member and group pages;
   - the communication log filters by type.
9. **Tests:** a new `test/email.test.js` with an SMTP server run inside the test, so nothing leaves the machine. Console checks.

## Decisions (my default in brackets)

1. **Whose mail server:** each SACCO configures its own SMTP server or provider. There is no platform-wide fallback. [Each SACCO's own]
2. **Ports and encryption:** 465 with SSL/TLS or 587 with STARTTLS only, certificates checked, and private addresses refused. [Yes]
3. **Recipients:** the reference platform's set (client or credit officer; group credit officer or members with a role). [Yes]
4. **Subscriptions:** stored per member or group and template, and changed by staff on the member's page. Members changing their own in the portal comes later. [Staff only for now]
5. **Retries:** temporary SMTP failures follow the webhook retry schedule; permanent ones fail at once and can be resent. [As stated]
6. **Pace:** at most 60 emails a minute per SACCO by default, changeable in the settings. [60 a minute]
7. **Manual email:** from member, group, loan and deposit pages, with a template or free text, under a new SEND_MANUAL_EMAIL permission held by managers and administrators. [Yes]
8. **Email the platform itself sends** (staff password resets, portal activation): not in this build. [Not now]
9. **Shared parts for SMS:** build the channel interface, settings, subscriptions and manual sending once, for Email and SMS. [Yes]
10. **The library:** nodemailer for SMTP. [nodemailer]
