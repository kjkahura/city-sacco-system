# Build log: Auditing (the audit trail and tracking activities)

Built on 29 September 2026, following `audit-auditing.md` and its ten decision defaults, which John accepted with "build it". The commit is on main, on the device, not pushed. John pushes with `git push origin main`.

## Built

### Tenant migration 042

- **Links on the change log:**
  - `audit_log` gains `member_id`, `loan_id`, `savings_account_id`, `credit_arrangement_id`, `branch_id` and `channel`, with indexes;
  - the columns are plain, with no foreign keys, so a deleted member or account keeps its history.
- **`audit_links()` and a BEFORE INSERT trigger:**
  - fill the links from the record kind and id, so none of the 100+ places that write the log changed;
  - covered kinds: members, loans, deposit accounts, credit arrangements, a loan's attachments, fees, guarantors, collateral, funding sources, write-off requests, penalties and planned fees, branches, centres and tills;
  - for other kinds, or a record already deleted, the ids in the before and after values are used;
  - an account gives its member, branch and credit arrangement; a credit arrangement its holder; a member their branch.
- **Backfill:** existing rows were linked the same way.
- **IP address and channel:**
  - `db/tenantContext` puts the request's IP address and channel (UI or API) in `app.ip` and `app.channel`;
  - the trigger writes them on each row; `audit_log.ip` had never been filled before.
- **`audit_events.response_payload`.**
- **Protection:**
  - `forbid_audit_change()` refuses UPDATE, DELETE and TRUNCATE on `audit_log` and `audit_events`;
  - the exceptions each set `app.audit_maintenance` for their transaction: `prune` lets the retention prune delete old requests, and `anonymize` lets member anonymization update the change log;
  - neither flag opens the other table or the other operation.

Platform migration 014 adds `platform.users.activity_types`.

### Activities (`src/domain/activities.js`, `src/routes/activities.js`)

- **One read model:**
  - the change log;
  - loan state history, as `LOAN_<action>`: application, approval, disbursement, arrears, closing, write-off and their undos;
  - member state changes, as `MEMBER_<action>`.
- **Duplicates:** a state change also in the change log shows once. The match is the same record at the same moment, since both are written in one transaction.
- **Not activities:** deposits, withdrawals and repayments (decision 1).
- **The activity object** (the reference platform's API v1 Activity):
  - `encodedKey`, `type`, `timestamp`, `userKey`, `notes`;
  - `clientKey` or `groupKey`, `memberNo`, `branchKey` and `branchId`, `centreKey`;
  - `loanAccountKey` and `loanAccountId`, `loanProductKey`, `savingsAccountKey` and `savingsAccountId`, `savingsProductKey`, `creditArrangementKey`;
  - `entity`, `entityId`, `channel` and `ipAddress`;
  - `fieldChanges` (`fieldChangeName`, `originalValue`, `newValue`), worked out from the top-level keys of the before and after values (decision 9). Nothing is shown for a redacted row.
- **`GET /api/activities`** with AUDIT_TRANSACTIONS (decision 4):
  - filters `from`, `to`, `branchID`, `clientID`, `groupID`, `centreID`, `userID`, `loanAccountID`, `savingsAccountID`, `loanProductID`, `savingsProductID`, `creditArrangementID` and `type`;
  - `offset` and `limit`, and the paging headers;
  - a `viewfilter` request still goes to the custom view.
- **One record's activities:** `GET /api/{members|clients|groups|loans|savings|deposits|creditarrangements}/:id/activities`.
  - Each is let in by the permission that views the record (decision 3).
  - The record is found under row security, so a user outside its branch gets a 404.
  - A member's list includes the activities of their accounts.
- **Dashboard feed** (`GET /api/activities/feed`, any staff user, decision 2):
  - activities in the user's branches;
  - activities with no branch only for holders of AUDIT_TRANSACTIONS or VIEW_REPORTS;
  - only the types in the user's `activityTypes`, when set;
  - ten by default.
- **Choosing types:**
  - `GET /api/activities/types` lists the types there are;
  - `PATCH /api/profile` takes `activityTypes` (a list, or null or empty for every type);
  - `GET /api/profile` returns it.
- **Branch access:** a user limited to some branches reads the activities of those branches in `/api/activities` and the feed. A record's list follows the record's visibility instead.
- **ACTIVITIES custom view:** limited to the user's branches, with new Branch and Channel fields.

### Audit trail (`src/ops/auditTrail.js`)

- **The reference platform's path:** `GET /api/v1/events` runs the same query, with MANAGE_AUDIT_TRAIL.
- **Response bodies:**
  - a failed request (status 400 and above) keeps its response body, with personal details removed and at most 4,000 characters, as request bodies are (decision 5);
  - `response_payload` can be filtered and is returned with each event.
- **Removing details:**
  - `groupName`, `loanName` and `assetName` are removed from bodies;
  - every key containing `code` is still removed (decision 7), except `errorCode` in an error body.
- **User-Agent:**
  - `requireUserAgent` in the access preferences, off by default (decision 6);
  - when on, a request without a User-Agent header is refused with the reference platform's message.
- **Retention prune:** sets the maintenance flag for its delete.

### Console

- **Activity cards:** the member, group, loan, deposit account and credit arrangement pages have an Activity card, ten at a time, with Show more.
- **Dashboard:** every user's Latest activity card reads the feed, with a "Choose activity types" dialog.
- **Access page:**
  - the preferences have the User-Agent setting;
  - the audit trail table shows the response body.

## Not built (decision 10)

- the Audit Trail V2 API and the Streaming API;
- the reference platform Payment Gateway's audit trail.

## Known limits

- **Field names:** the reference platform's API v1 activities reference did not load here, so the activity field names follow the reference platform's published model from memory.
- **Activity types:** these are the platform's action names (for example `LOAN_APPROVE`, `SAVINGS_ACCOUNT_EDITED`), not the reference platform's list of activity types.
- **What the protection covers:** it stops changes made outside the two paths. A database user who sets the maintenance flag by hand can still change rows; that needs database roles to prevent.
- **Branch links:** a row written by a user limited to some branches is linked through lookups that row security applies to. A change reaching a record outside their branches, which their access already refuses, would have no link.
- **Performance:** the backfill links each existing row by lookup. On a large change log the migration takes time in proportion to it.

## Tests

- New suite `test/activities.test.js`, 62 checks.
- `test/console.test.js` gained checks for the member Activity card and the dashboard's activity types.
- 44 suites, 3,069 checks, pass under both UTC and Africa/Nairobi.
