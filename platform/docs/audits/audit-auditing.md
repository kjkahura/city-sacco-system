# Audit: Auditing against the reference platform (the audit trail and tracking activities)

Audited on 29 September 2026, at commit 791ca93. John accepted the defaults below with "build it"; `build-log-auditing.md` records the build.

## Reference pages read

- Audit Trail (the user guide page for the reference platform's Audit Trail API)
- Tracking Activities
- Dashboard: the Latest Activity widget
- Audit Trail V2 (a pointer to the API reference only)

The pages below did not load here: Audit Trail API V2, Audit Trail and the User-Agent Header, the API v1 activities reference, and the audit trail OpenAPI file. The activities API fields below are the reference platform's API v1 names as I know them, not from a page read in this audit. User Management and Audit Trail is about the reference platform Payment Gateway, which the platform does not have, so it is left out.

## What the platform has

- **Request log (`audit_events`, `src/ops/auditTrail.js`):**
  - every staff or API consumer request to a tenant's API is recorded: the source (UI or API), method, path, resource, user, IP address, user agent, response code, duration, and the request body with secrets and personal details removed;
  - the member portal is left out, because members are not staff;
  - `GET /api/audit-trail/events` takes the reference platform's filters and operators, its paging window of 10,000 (`from`, `size`, `sort_by`, `sort_order`), and needs MANAGE_AUDIT_TRAIL;
  - events are kept for the tenant's `auditRetentionDays` (30 to 3,650 days, default 365) and pruned at the end of day;
  - the console's Access page queries it.
- **Change log (`audit_log`):**
  - over 100 places in the code write a row for each change: the actor, action, record kind and id, and the record before and after;
  - the ACTIVITIES custom view reads it, with AUDIT_TRANSACTIONS, and so does the predefined Activities menu item;
  - `GET /api/reports/audit-log` lists it, with AUDIT_TRANSACTIONS or VIEW_REPORTS.
- **State histories:**
  - `loan_state_history` records a loan's application, approval, disbursement, arrears, closing, write-off and their undos;
  - `member_state_changes` records a member's state changes;
  - deposit account state changes are written to `audit_log`.
- **Console:**
  - the dashboard has a Latest activity card: the last 10 change log rows for the whole organization, shown to users with AUDIT_TRANSACTIONS or VIEW_REPORTS;
  - the member page shows the state history, and the loan page shows the loan's state history.
- **Platform log:** user management events (`USER_*`) are in `platform.audit_log`, read through `GET /api/users/audit`.

## Findings

### 1. Recording requests

**The reference platform:** every UI and API action, including API consumers, with who and when.

**Platform:** every request, with the fields above.

**No gap.**

### 2. Querying the audit trail

**The reference platform:**

- `GET /v1/events` under the tenant's `/api`, with an API consumer holding MANAGE_AUDIT_TRAIL;
- filters on `event_source`, `request_uri`, `request_method`, `request_payload`, `user_agent`, `resource`, `resource_fragment`, `username`, `client_ip`, `response_code`, `occurred_at` and `response_payload`;
- the operators `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `startsWith`, `in` and `contains`;
- at most 10,000 entries per query: `from` and `size` add up to 10,000 at most, and `size` defaults to 100.

**Platform:**

- the same filters, operators and limits, at `/api/audit-trail/events`;
- the response body is not kept, so there is no `response_payload` filter.

**Gap:** the reference platform's path (`/api/v1/events`) and the response body.

### 3. Removing personal details from bodies

**The reference platform removes:** PASSWORD, PAGINATION_DETAILS, FETCHING_INFO, MOBILE_PHONE (and 1, 2), EMAIL_ADDRESS, ADDRESSES, BIRTH_DATE, FIRST_NAME, LAST_NAME, MIDDLE_NAME, HOME_PHONE, NOTES, GROUP_NAME, ADDRESS_LINE_1 and 2, ADDRESS_LATITUDE and LONGITUDE, DESCRIPTION, TITLE, TEXT, ASSET_NAME, LOAN_NAME, NAME, POST_CODE, COUNTRY, REGION, GENDER and IBAN.

**Platform:**

- removes all of these except GROUP_NAME, LOAN_NAME and ASSET_NAME: a key such as `groupName` is kept, because only a key named exactly `name` is caught;
- also removes secrets, tokens, PINs and any key containing `code`. That catches one-time codes, but also branch, product and GL codes, which are not personal.

**Small gap:** the three names.

### 4. The User-Agent header

**The reference platform:** when the audit trail is on, a request without a User-Agent header is refused ("The user agent cannot be null").

**Platform:** records the header when there is one and accepts a request without it.

**Gap.**

### 5. Retention

**The reference platform:** as long as the tenant's agreement says.

**Platform:** the tenant's retention setting, pruned at the end of day.

**No gap.**

### 6. Keeping the record intact

**The reference platform:** the audit trail is for investigating fraud and detecting unauthorized actions.

**Platform:**

- nothing at the database stops a change or deletion of `audit_events` or `audit_log`;
- the application changes them in two places only: the retention prune, and member anonymization, which clears personal details from `audit_log` rows.

**Gap:** the tables are not protected. The reference platform's pages do not describe this; it follows from what the audit trail is for.

### 7. The dashboard's Latest Activity

**The reference platform:**

- every user sees the latest activities in the branches they have access to;
- each user picks which activity types their feed shows.

**Platform:**

- the last 10 change log rows for the whole organization;
- shown only to users with AUDIT_TRANSACTIONS or VIEW_REPORTS;
- no branch limit and no choice of types.

**Gap.**

### 8. Activity on a client, group, account or credit arrangement

**The reference platform:**

- a client or group page lists its recent activity, with "Show more" for older actions;
- loan and deposit accounts have an Activity tab (approval, disbursement, arrears changes and the rest);
- credit arrangements have an Activity tab.

**Platform:**

- the member page and loan page show state histories only;
- deposit accounts and credit arrangements show nothing.

**Gap.**

### 9. System activities views

**The reference platform:** the Activities menu and its custom views, with AUDIT_TRANSACTIONS; saved and temporary views.

**Platform:** the ACTIVITIES custom view and the predefined Activities menu item. A user limited to some branches sees every branch's activities.

**Small gap:** the branch limit.

### 10. The activities API

**The reference platform (API v1 only):** `GET /api/activities`, filtered by `from`, `to`, `branchID`, `clientID`, `groupID`, `centreID`, `userID`, `loanAccountID`, `savingsAccountID`, `loanProductID` and `savingsProductID`, with `offset` and `limit`. Each activity has:

- `encodedKey`, `type`, `timestamp`, `userKey`, `notes`;
- the keys of its client, group, branch, centre, loan or deposit account, and product;
- `fieldChanges`: `fieldChangeName`, `originalValue`, `newValue`.

**Platform:** `/api/activities` answers only with a `viewfilter` (a custom view) and in the view's own shape.

**Gap.**

### 11. What an activity is linked to

**Platform:**

- an `audit_log` row names a record kind and id, but not the member, account or branch it belongs to;
- its `ip` column is never filled;
- lending and member state changes live in their own history tables.

A feed for a member, an account or a user's branches needs these read together.

**Gap** (the data model behind findings 7 to 10).

## Proposed build

1. **Links on the change log** (a tenant migration):
   - add `member_id`, `loan_id`, `savings_account_id`, `credit_arrangement_id` and `branch_id` to `audit_log`;
   - fill them from the record kind and id with a database trigger when a row is written, so none of the 100+ places that write it change;
   - backfill existing rows;
   - fill `ip` from the request (a session setting, as `app.actor` is).
2. **One activities read model:**
   - the change log, loan state history (as `LOAN_ACCOUNT_<action>`) and member state changes (as `CLIENT_<action>` or `GROUP_<action>`), read together;
   - each activity has a type, time, user, the linked member, account, credit arrangement, branch and product, notes, and `fieldChanges` worked out from the before and after values.
3. **`GET /api/activities`** in the reference platform's API v1 shape, with its filters and paging. A `viewfilter` request still goes to the custom view. A user limited to some branches reads their branches.
4. **Activity feeds for records:** `GET /api/members/:id/activities` (clients and groups), `/api/loans/:id/activities`, `/api/savings/:id/activities`, `/api/deposits/:id/activities` and `/api/creditarrangements/:id/activities`, each paged.
5. **The dashboard's Latest Activity:**
   - activities in the user's branches;
   - activity types chosen per user and kept with their profile.
6. **The ACTIVITIES custom view** limited to a user's branches.
7. **Console:**
   - an Activity card, with "Show more", on the member, group, loan, deposit account and credit arrangement pages;
   - a settings control on the dashboard card to choose the activity types.
8. **Audit trail:**
   - `GET /api/v1/events` as well as `/api/audit-trail/events`;
   - the response body kept for failed requests, with the `response_payload` filter;
   - GROUP_NAME, LOAN_NAME and ASSET_NAME removed from bodies;
   - an access preference to refuse requests without a User-Agent header.
9. **Keeping the record intact:**
   - database triggers refuse any change or deletion of `audit_events` and `audit_log` rows;
   - the two exceptions are the retention prune and member anonymization, each allowed through a session setting only they set.

## Decisions (my default in brackets)

1. **What counts as an activity:** the change log and the two state histories, but not deposits, withdrawals and repayments, which have their own transaction lists? The reference platform's account Activity tab shows approval, disbursement and arrears changes. [Yes: change log and state histories; disbursement shows through the loan's state history]
2. **Who sees the dashboard feed:** the reference platform shows it to every user, for their branches. Today only holders of AUDIT_TRANSACTIONS or VIEW_REPORTS see it. [Every staff user sees activities in their branches. Activities with no branch (products, settings, the chart of accounts) stay with AUDIT_TRANSACTIONS or VIEW_REPORTS, as today]
3. **Permission for a record's feed:** the reference platform's pages do not name one. [The permission that views the record: VIEW_CLIENT_DETAILS, VIEW_GROUP_DETAILS, VIEW_LOAN_ACCOUNT_DETAILS, VIEW_SAVINGS_ACCOUNT_DETAILS, VIEW_LINE_OF_CREDIT_DETAILS]
4. **Permission for `GET /api/activities`:** [AUDIT_TRANSACTIONS, as the Activities menu has]
5. **Response bodies:** the reference platform keeps the response body. Keeping every response would store every list of members and balances. [Failed requests only (status 400 and above), with personal details removed, at most 4,000 characters, as request bodies are]
6. **The User-Agent header:** refusing requests without it would break clients that do not send one today. [An access preference, off by default]
7. **Removing personal details:** add GROUP_NAME, LOAN_NAME and ASSET_NAME, and stop removing codes that are not secrets (branch, product, GL)? [Add the three names; keep removing every `code`, since removing too much is the safe side]
8. **Protecting the audit tables:** [Yes, with the retention prune and anonymization as the only exceptions]
9. **Field changes:** [Worked out from the top-level keys of the before and after values when an activity is read]
10. **Left out:** the Audit Trail V2 API and the Streaming API (their pages did not load, and streaming belongs with integrations), and the Payment Gateway's audit trail (the platform has no payment gateway). [Leave them out]
