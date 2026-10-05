# Build log: Email

Built on 5 October 2026 from `audit-email.md`. John accepted the ten decision defaults and asked for one addition to decision 4: members change their own subscriptions in the portal. The plan is `docs/superpowers/plans/2026-10-05-email.md`. There is one commit on main, not pushed.

## Built

### Settings and the email channel (tenant migration 047)

- **`notification_channels`:** one row per channel (`EMAIL` now, `SMS` next), with:
  - the switch, which starts off;
  - the fields as JSON;
  - the sealed secret;
  - the pace (60 a minute by default).
- **The email channel (`src/domain/notifications/channels/email.js`):**
  - the reference platform's fields: From Name, From Email, Reply-to, SMTP Host, SMTP Port, Transport Encryption (`SSL_TLS` or `STARTTLS`), Username and Password;
  - sends with nodemailer 10.
- **Address checks:**
  - the platform resolves the host itself, refuses it when any of its addresses is private, and connects to the address it checked;
  - only ports 465 and 587 are allowed;
  - TLS is required, at 1.2 or above, and the certificate is checked against the host name.
- **The password:**
  - it is sealed with the webhook secrets' key and never returned;
  - a change of host, port or username needs it typed again. This applies to tests as well as saves.
- **The API:**
  - `GET` and `PUT /api/notificationsettings/email`;
  - `POST /api/notificationsettings/email:test`, which tests with unsaved changes and reports the reference platform's failure reasons.
- **Who:**
  - users who see templates (and setup administrators) read the settings;
  - administrators change and test them.

### Templates of type EMAIL

- **Fields:** `notification_templates` gains `subject`, `recipient`, `recipient_role` and the content type `HTML`.
- **Validation:**
  - subject: required, one line, at most 255 characters;
  - recipient: `CLIENT`, `CREDIT_OFFICER` or `GROUP_ROLE`, with a role that exists;
  - target: client, group, loan or deposit events only;
  - placeholders: known names only, never in an unquoted attribute, and never at the start of a link.
- **Filling:** values are escaped for HTML, and the subject stays on one line. A plain-text part is made from the HTML.
- **Audit names:** `EMAIL_TEMPLATE_CREATED`, `EMAIL_TEMPLATE_EDITED` and `EMAIL_TEMPLATE_DELETED`.

### Delivery

- **Recipients:**
  - the member, or the group itself;
  - the loan's credit officer, else the holder's, but no suspended user;
  - for `GROUP_ROLE`, the group members holding the role.

  Rejected and exited members are skipped.
- **Subscriptions (`notification_subscriptions`):** opt-out templates send unless the member unsubscribed; opt-in ones only when subscribed. Credit officers are not subject to them.
- **Messages:** `EMAIL` messages in the communication log, with the subject.
- **Outcomes:**
  - no address: `MISSING_EMAIL_RECIPIENT`, with no attempt;
  - switched off: `EMAIL_SERVICE_NOT_ENABLED`;
  - a refused sign-in: `INVALID_SMTP_CREDENTIALS`, failed at once;
  - a 5xx answer: `MESSAGING_EXCEPTION`, failed at once;
  - a 4xx answer, a timeout or a network error: retried on the webhook schedule.

  Anything unexpected while sending is recorded on the message, so one message cannot stop the queue.
- **The circuit breaker** stays the webhooks' own.
- **The pace:** once a channel's pace is reached (sent, or being sent, in the last minute), its messages wait for the next pass.
- **Repayment reminders** queue emails too. Streaming templates now publish their reminders instead of being queued as webhooks.

### Manual email and subscriptions

- **`POST /api/communications/messages:sendEmail`:**
  - from a member, group, loan or deposit account, to the holder's address;
  - with a template or free text;
  - sent at once and logged as manual;
  - needs SEND_MANUAL_EMAIL, which is new and held by managers and administrators;
  - changing a template's text before sending needs EDIT_COMMUNICATION_TEMPLATES;
  - `GET /api/communications/email-templates` lists the active email templates for senders.
- **Subscriptions:**
  - staff use `/api/clients/:id/notification-subscriptions` (EDIT_CLIENT) and `/api/groups/:id/...` (EDIT_GROUP);
  - members use `/api/portal/notifications`, for active email templates that write to them, recorded as `portal:<member number>`.
- **Anonymizing a member** clears the address, subject and body of their messages, so they cannot be resent.

### Console and portal

- **Administration > Email:**
  - **Email Templates:** the list, and a form with recipient, group role, subscription option, conditions, the placeholder picker and a preview in a sandboxed frame;
  - **Settings:** the fields, the switch and a test.
- **Pages:**
  - Send email on member, group, loan and deposit pages;
  - Email subscriptions on member and group pages.
- **The communication log** filters by type and shows subjects.
- **The portal:** Settings lists the email notifications with a checkbox each.

### Docs

- README section "Email", the deploy note on ports 465 and 587, and row 20 of the audits README.

## Tests

- **`test/email.test.js` (66 checks):** two SMTP servers run inside the test (STARTTLS and implicit TLS, with a test-only certificate in `test/fixtures`). The checks cover:
  - settings and the guard;
  - the test email;
  - rendering;
  - templates;
  - each recipient kind;
  - subscriptions;
  - each outcome, retries, permanent failures, resend and the pace;
  - manual email;
  - anonymized members;
  - the portal.
- **`test/console.test.js`:** the Email screens, the preview, subscriptions and Send email on the member page, and the log's type filter.
- **`test/portal-ui.test.js`:** a member unsubscribes in Settings.
- **Full runs in UTC and Africa/Nairobi:** all suites pass, except the known date-dependent checks in lending, loan-accounting and loan-accounts. These fail on the base commit too.

## Final review

A fresh reviewer found no critical issues, five important ones and six minor ones. All were fixed, test-first where a check could show them:

- **Important:**
  - a character reference to no character could stop a tenant's queue;
  - a changed host would have received the stored password in a test;
  - the test certificate was ignored by git;
  - anonymized members' messages kept their address and could be resent;
  - the pace was counted once per row.
- **Minor:**
  - placeholders in unquoted attributes and at the start of links;
  - the send deadline did not cover the lookup;
  - an extra certificate authority replaced Node's;
  - group and client subscription routes accepted the other kind;
  - senders could not list templates without template permissions;
  - exited members and suspended officers still got automatic emails.

A send that times out after the server accepted the message can still be sent twice on retry. Delivery is at least once, as for webhooks.

## Not built

- Email the platform sends itself, such as staff password resets and portal activation (decision 8).
- Bulk manual email.
- Attachments.
