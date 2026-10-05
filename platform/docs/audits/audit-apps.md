# Audit: Apps against the reference platform

Audited on 5 October 2026, at the Getting Started and Sandbox commit. Nothing is built yet. The proposed build and its decisions are at the end. On 5 October 2026 John accepted the nine defaults.

## Reference pages read

- **Introduction to apps:**
  - an app is another provider's web application shown inside the back office, in an embedded frame;
  - it is hosted by its provider and talks to the platform securely, with a private key and API credentials;
  - the SACCO controls it: it can disable or uninstall it at any time;
  - the examples given are credit scoring, mobile money, regulatory reporting, peer-to-peer lending, insurance, social services and human resources.
- **Installing apps:**
  - **the definition:** an XML file with:
    - `id` (also the App ID used when the app authenticates), `name` (up to 256 characters), and optionally `provider` and `description`;
    - one or more extension points, each with a `location`, a `label` (up to 256 characters) and an HTTPS `url` that loads and authenticates the app;
    - optionally an `installURL` and an `uninstallURL`, called when the app is installed and uninstalled.
  - **the locations:** BRANCH_VIEW, CENTRE_VIEW, CLIENT_VIEW, DEPOSIT_ACCOUNT_VIEW, DEPOSIT_PRODUCT_VIEW, EXTENSION_MENU, GROUP_VIEW, LINE_OF_CREDIT_VIEW, LOAN_ACCOUNT_VIEW, LOAN_PRODUCT_VIEW, REPORTING_VIEW and USER_VIEW.
  - **the steps:** the XML is hosted at a URL. In Administration > Apps, Add App loads it from that URL, an App Key (up to 32 characters) is entered to secure the exchange, and the app is saved.
  - **managing:** an Actions menu disables or uninstalls an app.
- **Authenticating requests:**
  - when the app opens, the platform sends a signed request to the extension point's URL: `PART1.PART2`;
  - PART2 is Base64-encoded JSON of the context (the record the app was opened on, the tenant for apps that serve several, and other context);
  - PART1 is the HMAC-SHA256 of PART2 with the App Key;
  - the app checks the signature before trusting the context;
  - to read or write data, the app uses an API consumer's key, stored on its side.
  - The pages do not give the context's field names, an expiry or an example.

## What the platform has

- **Administration > Apps** is a placeholder tab.
- **API consumers** (Access > API Consumers): a name, a role or permissions, keys shown once, revocation and rotation. Calls are checked against the consumer's permissions, branch by branch.
- **The outbound guard** (`src/lib/outbound.js`): HTTPS only, no credentials in the URL, public addresses only (checked at connection time), no redirects. Webhooks and backup callbacks use it.
- **Sealed secrets** (`domain/notifications/secrets.js`) with `sacco-secrets-key`, used for webhook, email and SMS secrets.
- **Webhook signing:** HMAC-SHA256 of `<t>.<body>`.
- **Custom views and menu items** (Administration > Views): saved lists under the navigation. They do not embed other applications.
- **The console's CSP** is self-only: `default-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, and no `frame-src`, so no other site can be framed today.
- **A small YAML reader** of our own (`src/lib/yaml.js`); no XML reader and no XML dependency.

## Findings

### 1. No way to add another provider's screen

- **The gap:** a SACCO that buys a credit scoring or insurance service cannot show it on the member's page. Staff switch to another site and copy member details across by hand.
- **What exists to build on:** API consumers (the app's own access), the outbound guard (loading definitions, install calls), sealed secrets (the App Key) and HMAC signing.

### 2. The definition

- **Format:** the reference platform's XML. Accepting the same file means an app written for it installs here unchanged, as far as the definition goes.
- **Parsing XML safely:** no DOCTYPE, entities other than the five standard ones, or external references, so a definition cannot read local files or expand without limit. A small reader of the elements the definition uses, like the YAML one, avoids a new dependency.
- **Loading:** from an HTTPS source URL through the outbound guard, with a size limit. A pasted definition is useful for testing and for apps whose provider does not host one.

### 3. Where apps appear

| Reference location | On this platform |
| --- | --- |
| CLIENT_VIEW | the member page |
| GROUP_VIEW | the group page |
| LOAN_ACCOUNT_VIEW | the loan account page |
| DEPOSIT_ACCOUNT_VIEW | the deposit account page |
| LINE_OF_CREDIT_VIEW | the credit arrangement page |
| BRANCH_VIEW, CENTRE_VIEW | the branch and centre details |
| LOAN_PRODUCT_VIEW, DEPOSIT_PRODUCT_VIEW | the product pages |
| USER_VIEW | the user's details |
| REPORTING_VIEW | a tab on the Reports page |
| EXTENSION_MENU | an entry in the navigation that opens the app full page |

Each extension point becomes a tab (labelled by the definition) on that page, showing the app in a frame.

### 4. Opening an app securely

- **Signing on the server:** the App Key is sealed and never sent to the browser. The console asks the server to open an app on a record; the server checks the user may see that record, then signs the context.
- **The context:** the reference platform does not list the fields. A useful and small set: the app ID, the tenant, the location, the record's type and ID, the user's ID and email, the time issued and an expiry of a few minutes, and a random value so a request cannot be replayed.
- **How it reaches the app:** a form POST into the frame with a `signed_request` field keeps the signature out of the address bar, logs and the Referer header. A GET with the signature in the query is simpler for the provider but leaves it in their server logs.
- **The CSP:** the console's files are the same for every SACCO, so their CSP cannot list one SACCO's app origins. A launch page does the narrow part:
  - the server answers the launch with a one-time address of its own (`/apps/frame/<token>`, valid for a minute);
  - that page posts the signed request to the app, and its own CSP allows form posts to that app's origin only;
  - the console's CSP gains `frame-src 'self' https:` (a frame's later navigation to the app must be allowed) and keeps `form-action 'self'`.

  The frame is sandboxed (`allow-scripts allow-forms allow-same-origin allow-popups`, no top navigation), so the app cannot navigate or read the console.

### 5. The app's own access

The reference platform tells the app to use an API consumer. Installing an app can make one for it, named after the app, with a role the administrator chooses, and show its key once to give to the provider. Uninstalling the app can deactivate it. Linking an existing consumer instead is also possible.

### 6. Install and uninstall calls

The definition's `installURL` and `uninstallURL` are called through the outbound guard with a signed body (the same signing), so the provider learns the tenant installed or removed the app. A failed install call should not leave the app half installed.

### 7. Who manages apps and who sees them

- **The reference permission** for apps is not named in the pages read. Administration > Apps for administrators, plus a new `MANAGE_APPS` permission, matches how the other Administration tabs work.
- **Seeing an app:** anyone who can see the page it is on. Limiting an app to some roles is useful for apps such as HR or regulatory reporting.

### 8. Other surfaces

- **Sandbox:** after a clone, apps are copied but disabled and their App Keys dropped, as webhooks are, so a sandbox does not post production members' context to a provider.
- **Audit trail:** installs, changes, enables, disables, uninstalls and each opening of an app on a record.
- **Portal:** the reference platform has no member-facing apps. Not proposed.

## Proposed build

1. **Tenant migration:** `apps` (id from the definition, name, provider, description, source URL, the definition as loaded, the sealed App Key, state ENABLED or DISABLED, install and uninstall URLs, roles, the linked API consumer, who installed it and when) and `app_extension_points` (app, location, label, URL, position).
2. **The definition reader (`src/lib/appDefinition.js`):** the reference XML, with no DOCTYPE or external entities, a size limit, and checks: the ID, name and label lengths, known locations, HTTPS URLs.
3. **The API:**
   - `GET /api/apps`, `GET /api/apps/:id`;
   - `POST /api/apps` (from a source URL or a pasted definition, with the App Key);
   - `PATCH /api/apps/:id` (App Key, roles, state);
   - `POST /api/apps/:id:reload` (fetch the definition again, for a new version);
   - `DELETE /api/apps/:id` (uninstall);
   - `GET /api/apps/extensions?location=CLIENT_VIEW` (what the current user sees on a page);
   - `POST /api/apps/:id/launch` with `{ location, objectId }`, which checks access, signs the context and returns a one-time launch address;
   - `GET /apps/frame/<token>`, the launch page, used once.
4. **Signing:** `PART1.PART2` as on the reference platform, with base64url, HMAC-SHA256 with the App Key, and a context with an expiry of five minutes and a nonce.
5. **The app's API consumer:** made at install with the chosen role, key shown once, deactivated at uninstall.
6. **Install and uninstall calls** through the outbound guard, signed.
7. **The console:**
   - Administration > Apps: the list, Add App (URL or paste, App Key, role, who sees it), the details with its extension points, enable, disable, reload and uninstall;
   - a tab per extension point on each page in finding 3, and EXTENSION_MENU entries in the navigation;
   - the frame, opened through the one-time launch page, sandboxed.
8. **Sandbox and audit:** apps disabled with keys dropped after a clone; every change and opening audited.
9. **Tests:** `test/apps.test.js` with a test app served inside the test, and console checks.

## Decisions (my default in brackets)

1. **Definition format:** the reference platform's XML, read by our own small reader, with a pasted definition allowed as well as a source URL. [XML, URL or paste]
2. **Locations:** all twelve reference locations, mapped as in finding 3. [All twelve]
3. **Delivery of the signed request:** form POST into the frame. [POST]
4. **Context and expiry:** the fields in finding 4, valid for five minutes, with a nonce. [Five minutes]
5. **The app's API consumer:** made at install with a chosen role, key shown once; an existing one may be linked instead. [Make one at install]
6. **Install and uninstall calls:** made when the definition names them; a failed install call cancels the install. [Call, cancel on failure]
7. **Permission:** a new `MANAGE_APPS` (administrators hold it), and each app visible to all users or to chosen roles. [MANAGE_APPS, roles optional]
8. **CSP:** the console allows HTTPS frames, sandboxed; form posts go only from the one-time launch page to that app's origin. [Launch page]
9. **Sandbox:** apps copied disabled, App Keys dropped. [Disabled]
