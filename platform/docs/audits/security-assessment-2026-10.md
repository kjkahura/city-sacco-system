# Security assessment, October 2026

Assessed on 6 October 2026, at the Apps commit, on John's request for a security review "from a different method" in two ways: as an attacker would look at the platform, and against the standard frameworks (OWASP and STRIDE). The fixes are in the "Security review" commit; each one has a check in `test/hardening.test.js`.

## Scope and method

- **What was reviewed:** the whole platform under `platform/`:
  - about 46,000 lines of server code;
  - the console and portal;
  - the migrations;
  - the Dockerfile, `firebase.json` and the GitHub Actions deploy workflow;
  - the dependency tree.
- **Two angles:**
  1. **The attacker's view.** For each way in (staff sign-in, member portal, API keys, the control plane, file uploads, outbound calls, the money routes), the question was what someone holding that access, or none, could reach that they should not. The weaknesses come from that reading.
  2. **The standards.** The same code was mapped against four frameworks:
     - OWASP Top 10:2025;
     - OWASP API Security Top 10:2023;
     - the OWASP Application Security Verification Standard 5.0 (ASVS), at Level 2, the level for applications that handle sensitive data and money;
     - Microsoft's STRIDE threat categories, for each trust boundary.
- **How:**
  - four independent reviews, one per area:
    - identity and access;
    - input and data handling;
    - money integrity and resource limits;
    - configuration, cryptography, logging and supply chain;
  - `npm audit` on the dependency tree;
  - fixes written with a regression check each, then the full test runs in UTC and Africa/Nairobi.
- **Limits:**
  - this was a code-level review with regression tests. It was not a penetration test of a deployed environment: nothing was run against Cloud Run, Firebase or Cloud SQL, and the cloud settings were read from the workflow, not inspected.
  - An independent penetration test of the deployed platform before real member data goes in remains recommended (see "Before real member data").

## The system and its trust boundaries

| Boundary | Who crosses it | How it is authenticated |
| --- | --- | --- |
| Staff console and `/api` | SACCO staff | Password, second factor (required for administrators by default), 15-minute access token, rotating refresh token |
| Member portal and `/api/portal` | Members | Phone and PIN, lockout, 30-minute access token, rotating refresh token |
| `/api` with `apikey` | Integrations (API consumers, apps) | Hashed API key, role and permissions, branch limits |
| `/admin` control plane | Platform operators | Since this review: off unless enabled, its own signing key and audience, audited |
| `/hooks/sms/...` | SMS gateways | A token in the address, stored hashed, compared in constant time, rate limited |
| `/apps/frame/...` | The console frame | A one-time token, a minute long |
| Outbound (webhooks, email, SMS, apps, backup callbacks) | The platform calling out | The outbound guard: HTTPS, public addresses only, checked when connecting |
| Database | The application | One schema per SACCO; row-level security for branch-limited users |

## Findings and what was done

**How to read the table:**
- **Severity** is likelihood times impact for a SACCO holding members' money and personal data.
- **Fixed** means the code was changed and a check proves it.
- **Mitigated** means the risk was reduced and the remainder is stated.
- **Open** means it is recommended, not built.

### Identity and access

| ID | Finding | Severity | OWASP / API / ASVS / STRIDE | Status |
| --- | --- | --- | --- | --- |
| IAM-1 | A branch-limited user who may create or edit users could give access to every branch, higher transaction limits, or change their own access and limits | High | A01 / API5, API3 / V8 / E | Fixed: users made or changed stay inside the changer's branches and limits (a user made without saying takes the maker's); nobody changes their own access or limits, though the form can send them back unchanged |
| IAM-2 | The permission to make API keys could make a key for an administrator consumer | High | A01 / API5 / V8 / E | Fixed: making a key or secret key needs the right to give that consumer's access; both are now critical actions (re-authentication) |
| IAM-3 | A session could restart second-factor enrolment and replace a working second factor without a code | Medium | A07 / API2 / V6 / S, E | Fixed: refused while a second factor is on; a session token goes through the full sign-in check |
| IAM-4 | The sign-in limiter put refresh, MFA verification and re-authentication into one shared bucket per SACCO, which anyone could fill to lock everyone out | Medium | A07 / API2, API4 / V6 / D | Fixed: each route limits by its own account (email, phone, member number, a hash of the token or ticket, the signed-in user) and never by an empty key |
| IAM-5 | The `/admin` plane trusted any token with the admin role signed with the staff key, with no audit | Medium | A01, A07 / API2, API5 / V6, V9 / S, E, R | Fixed: off unless `ADMIN_API=on`; tokens only from `cli admin:token`, signed with `ADMIN_JWT_SECRET`, audience `platform-admin`, at most an hour; optional address list; every request audited, refused and aborted ones included |
| IAM-6 | Portal activation said a member's status before checking identity, and lets a member with no phone on file record any phone | Medium | A07 / API2 / V6 / S, I | Fixed (status after identity). Mitigated: `PORTAL_ACTIVATION_REQUIRES_PHONE_ON_FILE=true` sends those members to a branch; it is off by default so existing members can still activate |
| IAM-7 | An older one-time code stayed usable after a newer one was accepted | Low | A07 / V6 / S | Fixed: a code at or before the last accepted step is refused |
| IAM-8 | Second-factor reset had no check on who was reset | Low | A01 / API5 / V8 / E | Fixed: not one's own, not an administrator by a non-administrator, inside the resetter's branches |
| IAM-9 | Share holdings could be read by any staff user and across branches | Low to Medium | A01 / API1 / V8 / I | Fixed: needs the member permission; share lookups go through members, so branch limits apply |
| IAM-10 | Access tokens stay valid for up to 15 minutes (30 for members) after logout or a password change | Low | A07 / V7 / S | Open: tie each request to a live session row |
| IAM-11 | The current password and PIN could be guessed with a stolen session | Low | A07 / API2 / V6 / S | Fixed: limited per user; a wrong PIN counts towards the member lockout, and a locked member cannot change the PIN |
| IAM-12 | The password policy asks for a letter and a digit (ASVS 5 discourages composition rules); scrypt N=2^14 is below current guidance; no breached-password check | Low | A07 / V6, V11 | Open: see recommendations |

### Money integrity and resource limits

| ID | Finding | Severity | OWASP / API / ASVS / STRIDE | Status |
| --- | --- | --- | --- | --- |
| BIZ-1 | Savings interest could be brought up to any date, including the far future: unearned interest, and a loop of millions of steps | High | A06 / API4, API6 / V2 / T, D | Fixed: the interest date, and the date of every run route (fees, penalties, planned fees, fee amortisation, postdated payments, settlement, arrears), must be valid and not in the future |
| BIZ-2 | Loan repayments, disbursements and share movements could be dated in the future | Medium | A06 / API6 / V2 / T | Fixed: no future dates on repayments and disbursements made by a staff user (any route, collection batches and pay-offs included) or on share movements. Open: a backdating permission for loans and shares, as savings has |
| BIZ-3 | The developer guide promised `Idempotency-Key` on money routes, but it applied only to a few routes, so a retried deposit posted twice | Medium | A06 / API6 / V2 / T | Fixed for every POST route built on the shared handler (deposits, withdrawals, transfers, repayments, disbursements, fees, accruals and most others): a replay answers the first result, and the same key on a different request is refused. Open: the few routes that answer by themselves or run their own transaction (member creation, roles, report runs) |
| BIZ-4 | An aborted request's query kept its database connection; no statement time limit | Medium | A10 / API4 / V2 / D | Mitigated: request statements are limited to 55 seconds (`REQUEST_STATEMENT_TIMEOUT_MS`), except job routes (end of day run now, imports, backups). Open: hold the tenant's slot until the database work ends |
| BIZ-5 | The per-tenant wait list had no size limit | Low | API4 / D | Fixed: four times the slots, then refused with 503 |
| BIZ-6 | Transfers skipped the user's withdrawal limit; limits are per transaction, not per day | Medium | A06 / API6 / V2 / E, T | Fixed (transfers held to the withdrawal limit). Open: daily cumulative limits, limits for API consumers |
| BIZ-7 | The same user can create, approve and disburse a loan unless the four-eyes rule is turned on | Medium | A06 / API6 / V2 / E, R | Open: the rule exists (`two_man_rule`) and is off by default to keep running SACCOs unchanged. Turn it on |
| BIZ-8 | Guarantor pledges can be over-committed by concurrent pledges | Medium | A06 / V2 / T | Open: lock the guarantor's accounts when pledging |
| BIZ-9 | Two cash payouts at the same moment could both pass the till's limits | Low | A06 / V2 / T | Fixed: the till row is locked for the posting (tenant migration 050) |
| BIZ-10 | Fees could be dated in the future | Low | V2 / T | Fixed (with BIZ-1) |
| BIZ-11 | Bulk reversals had no size limit | Low | API4 / D | Fixed: at most 1,000 |
| BIZ-12 | Database errors (a number too large, a bad value) came back as 500 with the database's text | Low | A10 / V16 / I | Fixed: answered 400 or 409 with a code; any 500 says only `INTERNAL_ERROR` and an id, with the detail in the log |

### Input, output and outbound calls

| ID | Finding | Severity | OWASP / API / ASVS / STRIDE | Status |
| --- | --- | --- | --- | --- |
| INP-1 | A small workbook could ask for tens of millions of rows or columns and exhaust the server | Medium | A10 / API4 / V5 / D | Fixed: Excel's row and column limits, and a budget of 5,000,000 cells, are enforced while reading; bad character references no longer throw |
| INP-2 | CSV exports did not neutralise spreadsheet formulas, and members can type text that lands in them | Medium | A05 / V1 / T, E | Fixed: text that a spreadsheet would run gets a leading apostrophe in exports, reports and collection sheets |
| INP-3 | Generated documents could post forms or be framed elsewhere | Low | A05 / V3 / I | Fixed: `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'self'`, sandboxed. Hosted images and fonts stay allowed for logos |
| INP-4 | Field-name allow-lists accepted built-in names such as `constructor` | Low | A10 / V2 / D | Fixed: own keys only |
| INP-5 | The YAML reader accepted `__proto__` as a key | Low | A08 / V5 / T | Fixed: refused |
| INP-6 | The outbound guard relied on every caller to check the address; an address written as an IP is not looked up | Low | API7 / V12 / I, E | Fixed: every outbound request refuses plain http and private IP addresses itself |
| INP-7 | The SMS delivery-report token is in the address | Info | V12 / S | Open: accept it in a header where the gateway supports it |
| INP-8 | Upload type checks differ between upload paths; the multipart name pattern matched inside `filename=` | Info | V5 | Fixed (the pattern). Open: check ID-document uploads by their content, as member media is |

### Configuration, cryptography, logging and supply chain

| ID | Finding | Severity | OWASP / API / ASVS / STRIDE | Status |
| --- | --- | --- | --- | --- |
| CFG-1 | Without `BACKUP_ENCRYPTION_KEY`, offsite backups were shipped as plain dumps | Medium | A04, A02 / V11, V14 / I | Fixed: an unencrypted dump is never copied offsite; dumps are written readable by the platform user only |
| CFG-2 | A request sent straight to the `run.app` address can set its own client address, which the IP allow-list, rate limits and audit trail trust | Medium | A02, A09 / V13 / S, R | Open: set Cloud Run ingress to internal and load balancing, behind a load balancer with Cloud Armor (needs the Google Cloud console) |
| CFG-3 | Error answers and `/health` returned the database's text | Low | A02, A10 / V16 / I | Fixed (with BIZ-12) |
| CFG-4 | Second-factor secrets were stored in plain text | Medium | A04 / V11, V14 / S, I | Fixed: sealed with AES-256-GCM; older secrets are sealed the first time they are used |
| CFG-5 | A built-in signing key was used whenever `NODE_ENV` was not exactly `production` | Low | A02, A04 / V13, V9 / S, E | Fixed: only an explicit development or test run may use it; a production key must be at least 32 bytes |
| CFG-6 | `SECRETS_KEY` had no strength check and fell back to `JWT_SECRET` | Low | A04 / V11 / I | Fixed for production: at least 32 bytes and no fallback |
| CFG-7 | A failed audit write was silent; the control plane was not audited; no alerting | Medium | A09 / V16 / R | Fixed (logged under `[audit-write-failed]`; control plane audited). Open: log-based alerts in Cloud Logging |
| CFG-8 | The audit trail's protection is a trigger the application's own database role could switch off | Low | A09, A08 / V16 / T, R | Open: run the service as a non-owner role; copy audit rows daily to write-once storage |
| CFG-9 | The deploy job ran `firebase-tools@latest`, and actions and the base image are pinned by tag | Medium | A03, A08 / V15 / T, E | Mitigated: `firebase-tools` pinned to 15.32.1; Dependabot added for actions, npm and the image. Open: pin actions and the image by digest |
| CFG-10 | Ignore rules did not cover dumps and Redis files | Low | A02 / V13, V14 / I | Fixed |
| CFG-11 | API answers carried no baseline security headers | Low | A02 / V3, V13 / I | Fixed: `nosniff`, `no-store`, `no-referrer`, a deny-all CSP, HSTS in production |
| CFG-12 | The console keeps its refresh token in `sessionStorage`; PINs are short by design; small housekeeping | Info | V3, V6 | Open: noted for the next session design |

## Against the frameworks

### OWASP Top 10:2025

| Category | Assessment after this review |
| --- | --- |
| A01 Broken Access Control | The route table refuses unknown routes. Permissions are reloaded on every request. Row security limits branch users in the database. The fixes close the escalations found (IAM-1, IAM-2, IAM-8, IAM-9). Holds. |
| A02 Security Misconfiguration | Strict CSP on the console and portal, no CORS, no cookies, baseline headers on the API. Open: Cloud Run ingress (CFG-2). |
| A03 Software Supply Chain Failures | Five runtime dependencies, `npm audit` clean, lockfile with integrity hashes, `npm ci`. Dependabot added. Open: digest pinning. |
| A04 Cryptographic Failures | scrypt for passwords; AES-256-GCM for secrets and backups; hashed tokens and keys; sealed TOTP secrets. Open: scrypt cost (IAM-12). |
| A05 Injection | All SQL values are parameters and identifiers come from fixed maps. Template rendering escapes for its context. Formula injection is fixed. Holds. |
| A06 Insecure Design | Balance changes run under row locks, journals are balanced, closed periods are enforced by triggers, idempotency is now general. Open: four-eyes default, guarantor locking, daily limits. |
| A07 Authentication Failures | Lockouts, a second factor for administrators, rotating refresh tokens with reuse detection. The fixes close the enrolment, limiter and replay gaps. Open: session binding (IAM-10). |
| A08 Software or Data Integrity Failures | Webhooks are signed, app requests are signed, backups are verified by round trip, the audit trail is append-only. Open: a non-owner database role. |
| A09 Security Logging and Alerting Failures | Every staff and API request is audited, failed sign-ins included, and now the control plane too. Open: alerts. |
| A10 Mishandling of Exceptional Conditions | Errors answer codes, not internals. Resource bounds are added (statement time, wait list, workbook size). |

### OWASP API Security Top 10:2023

| Risk | Assessment |
| --- | --- |
| API1 Broken Object Level Authorization | Tenant from the token; row security on members, accounts, transactions and credit arrangements; shares fixed. Holds. |
| API2 Broken Authentication | See A07. Holds after the fixes. |
| API3 Broken Object Property Level Authorization | Protected fields (offset pledges, internal flags, roles, limits) are stripped or checked. IAM-1 fixed. |
| API4 Unrestricted Resource Consumption | Request rate per caller, body limits, page caps, now statement time, wait list and workbook bounds. |
| API5 Broken Function Level Authorization | The permission table covers every route; unknown routes are administrator-only. IAM-2 and IAM-5 fixed. |
| API6 Unrestricted Access to Sensitive Business Flows | Future-dated postings, transfers past limits and retries posting twice are fixed. Open: daily limits and four-eyes default. |
| API7 Server Side Request Forgery | The outbound guard (HTTPS, public addresses checked when connecting, no redirects) now applies to every request. Holds. |
| API8 Security Misconfiguration | See A02. |
| API9 Improper Inventory Management | One API, documented in `docs/developer-guide.md`; the sandbox is a separate tenant and marked in every answer. |
| API10 Unsafe Consumption of APIs | Answers from gateways and app definitions are size-limited and parsed by strict readers. Holds. |

### ASVS 5.0, Level 2 (summary by chapter)

| Chapter | Result |
| --- | --- |
| V1 Encoding and Sanitization | Meets, with INP-2 fixed |
| V2 Validation and Business Logic | Meets after BIZ-1, BIZ-2, BIZ-3, BIZ-6 and BIZ-11; open items BIZ-7 and BIZ-8 |
| V3 Web Frontend Security | Meets: strict CSP, no inline script, framing refused, sandboxed app frames |
| V4 API and Web Service | Meets |
| V5 File Handling | Meets after INP-1 and INP-5; INP-8 remainder open |
| V6 Authentication | Meets after IAM-3, IAM-4, IAM-6, IAM-7 and IAM-11; IAM-12 open |
| V7 Session Management | Partly: IAM-10 open |
| V8 Authorization | Meets after IAM-1, IAM-2, IAM-8 and IAM-9 |
| V9 Self-contained Tokens | Meets: HS256 pinned, separate admin key and audience |
| V10 OAuth and OIDC | Not applicable (no OAuth); deploy uses Workload Identity Federation |
| V11 Cryptography | Meets after CFG-4, CFG-5 and CFG-6; scrypt cost open |
| V12 Secure Communication | Meets: HTTPS outbound only, TLS 1.2+ for mail; HSTS added |
| V13 Configuration | Partly: CFG-2 open |
| V14 Data Protection | Meets: anonymisation, sealed secrets, encrypted backups, no-store answers |
| V15 Secure Coding and Architecture | Meets; digest pinning open |
| V16 Security Logging and Error Handling | Meets after CFG-3 and CFG-7; alerting open |
| V17 WebRTC | Not applicable |

### STRIDE by boundary

| Boundary | Spoofing | Tampering | Repudiation | Information disclosure | Denial of service | Elevation of privilege |
| --- | --- | --- | --- | --- | --- | --- |
| Staff sign-in and sessions | MFA, lockout; enrolment and replay fixed | Signed tokens, HS256 pinned | Sign-ins audited | Errors without internals | Limiter per account fixed | Permissions reloaded each request |
| Member portal | PIN lockout, PIN guessing fixed | Signed tokens | Activation audited | Status only after identity | Per-phone limits | Member tokens refused on staff routes |
| API consumers | Hashed keys, address block after 10 bad keys | Idempotency keys | Requests audited | Branch limits | Rate limits | Key creation guarded (IAM-2) |
| Control plane | Own key and audience (IAM-5) | Off by default | Now audited | Not reachable unless on | Not reachable unless on | Admin role only from the admin key |
| Money postings | Actor from the session | Row locks, balanced journals, closed periods; future dates refused | Change log in the same transaction | Branch row security | Statement time limit | Limits, transfers included |
| Outbound | Signed webhooks and app requests | HTTPS | Message log | Secrets sealed | Timeouts, size limits | Guard on every request (INP-6) |
| Backups | Key ids in files | Encrypted and verified | Backup runs recorded | No plain offsite copy (CFG-1) | Pruning | Files readable by the platform user only |

## Controls that hold

These were checked and found sound; they are the reason no critical issue was found:

- **Tenant isolation:**
  - the tenant comes from the token's claim, and a different header or host is refused;
  - each SACCO has its own schema;
  - row-level security applies to branch-limited users, as a separate database role that fails closed.
- **Credentials:**
  - passwords hashed with scrypt, with constant-time comparison;
  - refresh tokens, API keys, MFA tickets and SMS callback tokens stored only as SHA-256 hashes;
  - refresh-token reuse detection that ends the whole session family.
- **SQL:** every value is a parameter, and identifiers come only from fixed maps.
- **Browser:** a strict CSP with no inline script and no third-party code on the console and portal, so stored text in a member's name cannot run.
- **Outbound guard:** HTTPS only, public addresses checked when connecting (which also defeats DNS rebinding), no redirects, total deadlines and size limits.
- **Webhook signing:** HMAC-SHA256.
- **Apps:** signed requests behind one-time launch pages in sandboxed frames.
- **Backups:** AES-256-GCM with key ids and rotation, verified by a round trip before the plain dump is deleted.
- **Audit:**
  - every request is recorded, failures included, with secrets and personal data removed from bodies;
  - append-only by trigger;
  - change-log rows written in the same transaction as the change.
- **Money:**
  - balances change in SQL under row locks;
  - journals balance by a deferred check;
  - closed periods are refused by triggers;
  - write-off approval is refused to the requester.
- **Supply chain:** `npm audit` reports 0 vulnerabilities across 107 packages, with five runtime dependencies.

## Second review of the fixes

A fresh reviewer read the fixes before they were committed. They found no critical issues and six important ones:
- the self-edit rule refused the console's own edit form;
- a branch-limited creator could not use the console's New user form;
- several loan routes still took future dates;
- a workbook could still be wide enough to exhaust memory;
- the idempotency and statement-limit claims went further than the code.

All were fixed or the wording corrected, with checks added to `test/hardening.test.js`. The minor ones fixed at the same time:
- PIN change while locked;
- the control plane auditing refused and aborted requests;
- backup files private from the moment they are created.

## Recommendations, in order

1. **Cloud Run ingress (CFG-2):** set ingress to "internal and Cloud Load Balancing", front the service with an HTTPS load balancer and Cloud Armor, and point Firebase Hosting at it. Until then, the IP allow-list can be bypassed through the `run.app` address.
2. **Turn on four-eyes for loans (BIZ-7):** set `two_man_rule` on for every SACCO, and make it the default for new ones.
3. **Set the new environment settings in production:**
   - `PORTAL_ACTIVATION_REQUIRES_PHONE_ON_FILE=true`, once staff have recorded members' phones;
   - `ADMIN_API` stays off unless needed. When it is needed, set `ADMIN_JWT_SECRET` (48 random bytes, in Secret Manager) and `ADMIN_ALLOWED_IPS`.
4. **Alerting (CFG-7):** add Cloud Logging alerts on these:
   - `[audit-write-failed]`, `[error]` and `[backup]` lines;
   - 429 and 401 spikes;
   - `ADMIN_REQUEST` audit rows.
5. **Database role (CFG-8):** run the service as a role that does not own the tables, and copy the audit trail daily to a bucket with a retention lock.
6. **Daily limits and guarantor locking (BIZ-6, BIZ-8),** session binding (IAM-10), a backdating permission for loans and shares (BIZ-2), and scrypt N=2^17 with rehash on sign-in, a breached-password list and no composition rules (IAM-12).
7. **Digest pinning (CFG-9):** pin the four actions and the Node base image by digest, and let Dependabot update them.
8. **Independent penetration test** of the deployed platform before real member data. This review read and tested the code; a tester should also probe the deployed edge (Firebase, Cloud Run, Cloud SQL).
9. **Kenyan obligations:** the Data Protection Act 2019 requires notifying the Data Commissioner within 72 hours of becoming aware of a personal data breach (section 43), and the affected members within a reasonably practicable period. SASRA's and the Central Bank of Kenya's cybersecurity guidance expect an incident response plan and periodic testing. The audit trail and alerts above are what make the 72 hours achievable.

## Sources

- OWASP Top 10:2025, introduction and list: https://top10.owasp.org/2025/0x00_2025-Introduction/
- OWASP API Security Top 10:2023, as summarised by Wiz: https://www.wiz.io/api/md/academy/api-security/owasp-api-security
- OWASP ASVS 5.0 chapter index (OWASP Cheat Sheet Series): https://cheatsheetseries.owasp.org/IndexASVS.html
- What is new in ASVS 5.0 (levels): https://softwaremill.com/whats-new-in-asvs-5-0/
- Microsoft, the STRIDE threat model: https://learn.microsoft.com/en-us/training/modules/tm-use-a-framework-to-identify-threats-and-find-ways-to-reduce-or-eliminate-risk/1b-threat-modeling-framework
- Kenya Data Protection Act, 2019 (ODPC): https://www.odpc.go.ke/wp-content/uploads/2024/02/TheDataProtectionAct__No24of2019.pdf
- Breach notification under the Kenyan Data Protection Act (Afriwise): https://www.afriwise.com/blog/a-few-insights-on-navigating-data-breaches-in-kenya-under-the-kenyan-data-protection-law
- Central Bank of Kenya Guidance Note on Cybersecurity (summary): https://www.insideprivacy.com/international/central-bank-of-kenya-issues-guidance-note-on-cybersecurity/
