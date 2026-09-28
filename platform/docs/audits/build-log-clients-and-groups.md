# Build log: Clients and Groups

Follows the audit in `audit-clients-and-groups.md`, and is committed with the code it describes (`git log -- docs/audits/build-log-clients-and-groups.md`).

## Decisions (the audit's defaults, taken with "proceed")

1. **Groups are full account holders.** They hold loans, deposit accounts and shares. Solidarity loans, where one loan is split among a group's members, are left for a return to loan products.
2. **State mapping:**
   - PENDING became PENDING_APPROVAL.
   - ACTIVE and DORMANT became ACTIVE or INACTIVE, depending on whether the member has running accounts.
   - DECEASED became EXITED, with DECEASED kept as the exit reason.
3. **Initial state:** new members start INACTIVE.
4. **Duplicate checks:**
   - ERROR (the create or edit is refused) on the document number.
   - WARNING (the member is saved and the matches are listed) on name with birth date, and on phone.
   - NONE on email.
5. **Delete and anonymize:**
   - Delete only members or groups that never held an account or a guarantee.
   - Anonymize exited members. The retention period is a tenant setting that ships unset.

## How groups are stored

A group is a row of `members` with `holder_type = 'GROUP'`. Its name is in `first_name`, and `last_name` is empty.

- **Why:** every existing account, statement, report and portal path that takes a member takes a group without change.
- **API:** the reference platform's `/api/groups` shows groups apart from members.
- **Counts:** the members list and the reports' member counts cover individuals only.

This is a deviation from the reference platform in storage only.

## Defects fixed

1. **Member numbers stopped being generated after any number longer than six digits.**
   - Cause: `lpad` cut the new number to six characters, so the same number came back each time.
   - Fix: numbers now come from a counter on the client type. The counter is never cut: M999999 is followed by M1000000.
2. **Members created at the same time collided.** The counter row is locked while a number is given out, and a number already taken is stepped over. Ten parallel creates now all succeed.
3. **Branch-limited users could not create members.** A member created without a branch goes to the creator's own branch. The console form has branch, centre and credit officer fields.
4. **States followed no rules.**
   - The reference platform's six states, with approve, reject, exit and blacklist, and an undo for each. Each action has its own permission.
   - ACTIVE and INACTIVE follow the member's accounts, set in the database.
   - The state cannot be set by POST or PATCH. The exit date and reason are recorded.
5. **Exited and deceased members could still act.** The database refuses a new running account unless the holder is INACTIVE or ACTIVE, its type may open accounts, and the product is available to that kind of holder. It refuses a guarantee unless the guarantor is INACTIVE or ACTIVE and its type may guarantee.
6. **Bad input gave the wrong errors.**
   - An impossible birth date returns 400, not 500.
   - Future birth dates are refused.
   - M and F are read as MALE and FEMALE.
   - Email and phone formats are checked.
7. **The national ID check was easy to bypass.**
   - National IDs are stored without spaces and in capitals.
   - One ID template can be marked as the national ID. Its document and the national ID stay in step.
   - A document number another member holds is refused.
   - The member search finds national IDs.
8. **Core details could not be corrected.** National ID, birth date, gender, type, ID, branch, centre and credit officer are editable, each under its reference platform permission. The console has Edit.

Minor points fixed:

- PATCH ignores unknown keys; state changes return 400.
- Listing a member's ID documents runs as a read.
- The console state filter shows the six states.
- The member page's shares card reads the member's own accounts, so the 200-account limit is gone.
- `POST /clients:search` searches the reference platform's field names and custom fields in SQL.

Found on the way:

- **Colon routes overlapped.** Express 5 reads `/members:search` as a route parameter, so `/members:duplicates` ran the member search. The five colon routes now escape the colon.
- **Deposit accounts could not be closed.** A member's exit needs it, so `POST /api/savings/:id/close` was added (CLOSE_SAVINGS_ACCOUNTS). It closes only an account with nothing in it or owed on it that is not a running loan's settlement account.
- **The share minimum holding blocked a full transfer.** It now applies only to the shares that remain, so an exiting member can transfer all of theirs.
- **Guarantor errors were misleading.** An exited guarantor was told they had insufficient free deposits. The state and type checks now come first.

## Built

- **Client and group types** (`/api/client-types`):
  - Fields: ID pattern (# a digit, @ a letter, $ either), may open accounts, may guarantee, requires the mandatory ID documents, shows the address fields.
  - Defaults are Client (M######) and Group (G######). A default type, or one in use, cannot be deleted.
  - Custom fields for members and groups can be set per type.
- **The life cycle:**
  - `POST /api/members/:id/state` with an action and a reason.
  - `GET /api/members/:id/state-history`, backed by `member_state_changes`, which also records the automatic changes.
- **Duplicate checks:**
  - Document number, name with birth date, phone (last nine digits) and email, each at NONE, WARNING or ERROR.
  - The lookup runs across every branch.
  - `POST /api/members:duplicates` runs the checks without saving.
- **Reassigning:**
  - One member (`POST /api/members/:id/association`) or up to 1,000 (`POST /api/members:reassign`).
  - Optionally moves the member's open loans and deposit accounts through the inter-branch postings.
- **Delete and anonymize:**
  - `DELETE /api/members/:id` removes a member or group that never held an account; its audit log copies lose the personal details.
  - `POST /api/members/:id/anonymize` needs the retention period set in the client controls, and the period to have passed since the exit.
- **Groups:**
  - Group role names (`/api/group-role-names`).
  - Members with any number of roles. Individuals only; exited and rejected members are refused.
  - Controls for membership of more than one group and the group size limit (NONE, WARNING, HARD).
  - Products say who may hold them (`availableFor`). Loan and deposit products start as individuals only; share products start open to both.
  - Groups have no portal.
  - Tasks can link to groups.
- **The reference platform's API v2:**
  - `/api/clients` and `/api/groups`: GET with paging headers, POST, GET, PUT (clears the personal fields left out), PATCH (JSON Patch or plain fields; a patch of /state runs the matching action) and DELETE.
  - `POST /clients:search` and `/groups:search`.
  - `GET /clients/:id/role`.
- **Client controls** (`/api/client-controls`):
  - Settings: initial state, duplicate checks, required assignments (branch, centre, credit officer), membership of more than one group, group size limit and the anonymization period.
  - Readable by any staff user; only an administrator can change them.
- **Permissions:**
  - The reference platform's 14 client codes and 7 group codes. The catalogue is now 154 codes.
  - Roles and users that held EDIT_CLIENT keep what it allowed (state, association, type, ID). Tenant migration 033 and platform migration 009 grant the new codes.
  - Deleting and anonymizing are for administrators.
- **Console:**
  - Members page: the full create form, with a duplicate warning prompt, and a bulk reassign.
  - Each member: Edit, Change association, the state actions, State history, Anonymize, Delete, and closing an empty deposit account.
  - A Groups page, and a group page showing its members and their roles.
  - Organization page: client and group types, group role names and the client controls.

## Tests

- New suite `test/clients.test.js` with 117 checks.
- The migration's state mapping was checked separately: old states were mapped on a fresh tenant and 033 was re-applied, which also showed it is safe to run twice.
- Tests changed:
  - The reporting test uses EXITED in place of the removed DORMANT state.
  - The data-importing test reads the new groups message.
  - The tills test allows a task linked to a group.
- The console test gains 8 checks: member creation, a state action and its undo, state history, groups and the setup cards.
- 36 suites, 2,494 checks, pass under both UTC and Africa/Nairobi.

## Not built

- Solidarity group loans.
- Custom views of groups, and group indicators.
- Importing groups from the Excel template.
- Profile pictures and signatures.
- The reference platform's larger attachment limits.
- ID document expiry checks.
