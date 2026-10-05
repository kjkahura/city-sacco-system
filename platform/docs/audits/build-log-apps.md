# Build log: Apps

Built on 5 October 2026 from `audit-apps.md`. John accepted the nine decision defaults. The plan is `docs/superpowers/plans/2026-10-05-apps.md`. There is one commit on main, not pushed.

## Built

### The definition and signing (`src/lib/appDefinition.js`)

- **The definition:** the reference platform's XML: `id`, `name`, `provider`, `description`, `installURL`, `uninstallURL` and one or more `extensionpoint` elements (`location`, `label`, `url`). The root element's name is not checked; element names are read without regard to case.
- **The reader** is our own and small:
  - elements, text, comments, CDATA, the XML declaration, the five standard entities and character references;
  - a DOCTYPE, entity declarations, processing instructions and a bare `&` are refused;
  - a `>` inside a quoted attribute does not end a tag;
  - limits: 64 KB, 500 elements, depth 8, 50 extension points.
- **Checks:** the ID (1 to 64 letters, digits, dots, dashes or underscores), the name and labels (up to 256 characters), the twelve locations, and HTTPS addresses through the outbound guard's URL rules.
- **Signing:** `PART1.PART2`, where PART2 is the base64url of the JSON context and PART1 the base64url HMAC-SHA256 of PART2 with the App Key.

### The apps (`src/domain/apps.js`, tenant migration 049)

- **Install** (`POST /api/apps`):
  - from an HTTPS source URL, fetched through the outbound guard (public addresses only, no redirects, 64 KB), or a pasted definition;
  - the App Key (1 to 32 printable characters) is sealed and never returned;
  - who sees it: everyone who sees its pages, or chosen roles;
  - API access: a new API consumer for the app with a role or permissions (its key shown once), which needs `CREATE_API_CONSUMERS_AND_KEYS`, or an existing one linked, which needs `VIEW_API_CONSUMERS_AND_KEYS`;
  - the definition's `installURL` gets a signed form post last; a failure cancels the install and removes the consumer it made.
- **Change** (`PATCH /api/apps/:id`): the App Key, who sees it, enabled or disabled.
- **Reload** (`POST /api/apps/:id:reload`): the definition fetched again outside the tenant's transaction; the ID must not change.
- **Uninstall** (`DELETE /api/apps/:id`): the `uninstallURL` gets a signed form post (its failure does not stop the uninstall and is reported); the app is removed; a consumer the install made is deactivated directly and its keys stop working at once.
- **Extensions** (`GET /api/apps/extensions?location=`): the enabled extension points a user sees at a location, without their addresses.
- **Launch** (`POST /api/apps/:id/launch` with `{ location, objectId }`):
  - staff users only; an API key is refused;
  - the app must be enabled, seen by the user and have that location;
  - the record is checked with the location's view permission, under the user's branch limits (row security on members, loans, deposits and credit arrangements);
  - the context: app, tenant, location, record type and ID, user ID and email, issued, an expiry five minutes on, a nonce, and the API base address from `PUBLIC_BASE_URL` only;
  - the answer is a one-time launch address, `/apps/frame/<tenant>/<token>` (192 bits, only its SHA-256 kept), good once within a minute.
- **The launch page** posts `signed_request` to the extension point. It is `no-store` and `no-referrer`; its CSP allows a form post to that app's origin only and loads only `appframe.js`. Once used, it keeps no signed request.
- **Audit:** `APP_INSTALLED`, `APP_UPDATED`, `APP_RELOADED`, `APP_UNINSTALLED` and `APP_OPENED`.
- **Permissions:** `MANAGE_APPS` (new) for the administration routes, with re-authentication when it is on. Listing and opening apps need no permission of their own; the record's view permission applies.

### Console

- **Administration > Apps:** the list, Add app (address or pasted definition, App Key, roles, API role, the key shown once), each app's details and extension points, enable or disable, a new App Key, reload, uninstall.
- **The apps on pages:** an Apps card with a tab per extension point on the member, group, loan, deposit, credit arrangement, branch, loan product and deposit product pages and on Reports; menu apps (EXTENSION_MENU) on the dashboard. A tab opens the app in a sandboxed frame (scripts, forms, popups and its own origin; no top navigation) through the launch page.
- **The console's CSP** gains `frame-src 'self' https:` and keeps `form-action 'self'` and `frame-ancestors 'none'`.

### Sandbox and docs

- **Sandbox:** a clone keeps the apps disabled, without App Keys or API consumers, and copies no launches.
- **Docs:** a README "Apps" section; the developer guide's section 6 for providers (the definition, the signed request and how to check it, the install calls, the frame); `docs/deploy.md` on `PUBLIC_BASE_URL`; the data dictionary; audits README row 23.

## Tests

- **`test/apps.test.js` (56 checks):** a provider served inside the test. The checks cover the reader (entities, CDATA, DOCTYPE, bare `&`, quoted `>`, limits, locations, HTTPS), signing, the App Key rules, a failed install call, installing by URL and by paste, the install call's signature, the API consumer and its permissions, roles, extensions by location and role, the launch page (single use, expiry, CSP, the posted context), branch limits, API keys refused, disabling, a new App Key, reloading, the outbound guard, the sandbox, uninstalling and the consumer's key stopping, the audit trail and the data dictionary.
- **`test/console.test.js`:** Administration > Apps, installing a pasted definition, the member page's app tab opening the sandboxed frame, uninstalling.
- **Full runs in UTC and Africa/Nairobi:** all suites pass, except the known date-dependent checks in lending, loan-accounting and loan-accounts. These fail on the base commit too.

## Final review

A fresh reviewer found no critical issues, four important ones and eleven minor ones. All were fixed or documented, test-first where a check could show them:

- **Important:**
  - the API base address in a signed context came from the request's Host when `PUBLIC_BASE_URL` was not set, so a caller could point a provider's API key at another server;
  - an API key could open any app and read the signed request from the launch page;
  - `MANAGE_APPS` alone could make API consumers and keys;
  - uninstalling could leave the app's consumer active and still report success.
- **Minor, fixed:** prototype names and a bare `&` read as entities; a quoted `>` ended a tag; the provider was told of an install before the audit was written; two installs of the same app at once gave a database error; reload held the tenant's transaction during the fetch; an unreadable App Key stopped an uninstall; used launches kept their signed request.
- **Minor, documented:** branch and centre, product and user records are not branch-limited, as on their own pages; the launch page's sandbox exception; a provider's cross-origin redirect after the post is blocked; the reload route's pattern; menu apps are on the dashboard rather than in the navigation.

## Not built

- Menu apps as entries in the navigation: they show on the dashboard.
- Centre and user pages: the console has none, so CENTRE_VIEW and USER_VIEW apps open only through the API.
- Member portal apps: the reference platform has none.
