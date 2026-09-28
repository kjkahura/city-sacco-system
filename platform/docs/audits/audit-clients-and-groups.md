# Audit: Clients and Groups against the reference platform

Audited on 28 September 2026 against commit 0f8b7da. Reference pages read:

- Clients and Groups Overview
- Client Types
- Group Types
- Creating an Individual Client
- Creating a Group
- Managing Clients
- Managing Groups
- Client Life Cycle
- Group Role Names
- Client and Group Roles Configuration
- Internal Controls (the client and group settings)
- Permissions (Clients and Groups)
- The Clients and Groups API v2 specifications

The platform calls clients "members". Groups do not exist in it: the import refuses them and the task templates refuse links to them.

## Defects

Each defect was reproduced on a test tenant, except where the entry says it comes from reading the code.

1. **Member numbers stop being generated once any number has more than six digits.**
   - The next number is `'M' || lpad(max digits + 1, 6, '0')`, and `lpad` cuts anything longer than six characters. After member `483920117` exists, the next number is `M483920`, and the one after that is `M483920` again.
   - From then on, every member created without a number gets 409 DUPLICATE_MEMBER. On the probe tenant, three creates in a row all failed.
   - The reference platform's default client IDs are 9-digit numbers. So after a migration from the reference platform, the console can create at most one more member.
2. **Members created at the same time collide.** The number comes from `MAX() + 1` with no lock or sequence. Ten parallel creates returned 201 four times and 409 six times.
3. **A branch-limited user cannot create a member from the console.**
   - The console form has no branch field, and the API does not default to the user's branch.
   - A member with no branch fails the branch row security check, so the create returns 403 OUTSIDE_YOUR_BRANCH_ACCESS.
   - Members that an administrator creates without a branch are invisible to every branch-limited user.
   - The reference platform can make the branch required (Internal Controls, "Client and Group Required Assignments").
4. **Member states follow no rules.**
   - `POST /members` accepts any state; a member was created as EXITED.
   - `PATCH /members/:id` moves between any states, for example ACTIVE to DECEASED and back to PENDING. It needs only EDIT_CLIENT.
   - `exited_on` is never written.
5. **Exited and deceased members can still open accounts and guarantee loans** (from the code). Loan creation, deposit account opening and guarantor pledges do not read the member's state. The reference platform stops an exited client from opening accounts, acting as a guarantor or joining groups.
6. **Bad input returns the wrong errors.**
   - An impossible birth date (`2020-13-45`) returns 500.
   - A birth date in 2099 is accepted.
   - `gender: "M"` returns 409 with the database constraint message. The data dictionary says the values are M or F; the check allows MALE, FEMALE and OTHER.
7. **The national ID check is easy to get around.**
   - The unique index compares values exactly, so `12345678` and ` 12345678` (with a leading space) both saved.
   - `members.national_id` and the National ID document are not linked. Portal activation reads the column, not the document.
   - Nothing stops two members from holding the same document number.
   - The member search does not look at the national ID, so a search for `12345678` found nothing.
8. **Core details cannot be corrected.**
   - PATCH ignores national ID, birth date, gender and branch; a PATCH of only those returned 400 NO_UPDATABLE_FIELDS.
   - The member number and join date cannot be changed either.
   - The console detail page has no Edit action at all.

Minor points found along the way:

- PATCH accepts both camelCase and raw column names.
- Listing a member's ID documents opens a write transaction, because the options argument is misplaced.
- A document attachment needs only VIEW_CLIENT_DETAILS, where loan attachments need VIEW_DOCUMENTS.
- The console's status filter leaves out DECEASED.
- The member page's shares card reads only the first 200 share accounts, so a member beyond them shows none.
- `members:search` filters on column names such as `first_name`, not the reference platform's fields such as `firstName` and `clientState`, and it cannot filter on custom fields.

Outside this section: deposit and share account numbers come from `count(*) + 1`. They can collide after an import, or when two accounts open at the same time.

## Coverage

| Area | Reference | Platform | Status |
|---|---|---|---|
| Individual clients | Name, ID, type, birth date, gender, language, email, phones, addresses, notes, picture, signature, ID documents, association, custom fields | Names, number, national ID, KRA PIN, birth date, gender, phones, email, flat address, employer, notes, branch, centre, credit officer, custom fields, ID documents | Mostly built. No client type, preferred language, picture or signature. |
| Client types | Default "Client" plus custom types: ID, name, description, ID pattern, allow opening accounts, allow as guarantor, require ID documents, show default address fields. CHANGE_CLIENT_TYPE. A type in use cannot be deleted. | None | Missing |
| Client IDs | Generated from the type's pattern (`#` digit, `@` letter, `$` either); editable with EDIT_CLIENT_ID | `M` plus 6 digits, generated as MAX + 1; any value accepted from the API | Partial, with defects 1 and 2 |
| Life cycle | Six states: PENDING_APPROVAL, INACTIVE, ACTIVE, REJECTED, EXITED, BLACKLISTED. Approve, reject, exit and blacklist, each with an undo. ACTIVE and INACTIVE follow the accounts automatically. A comment on reject and blacklist. | PENDING, ACTIVE, DORMANT, EXITED, DECEASED; set freely | Missing (defects 4 and 5) |
| Initial state | Inactive or Pending Approval (Internal Controls) | ACTIVE, or whatever the request says | Missing |
| Blacklisting | Individuals only. Blocks new accounts and edits to details; existing accounts still transact. EDIT_BLACKLISTED_CLIENT_CFV. | None | Missing |
| Duplicate checks | Chosen fields, at None, Warning or Error; Error also applies to API edits. A warning on duplicate document IDs. | Unique member number, and exact-match unique national ID only | Missing |
| Required assignments | Branch, centre and credit officer can each be made required | None | Missing (see defect 3) |
| Reassignment | Branch, centre and credit officer, one client at a time or in bulk, optionally moving the client's accounts. MANAGE_CLIENT_ASSOCIATION. | Centre within the same branch, and credit officer, one at a time. Each account moves branch on its own. | Partial |
| Delete | Only with no accounts; the personal details are removed. DELETE_CLIENTS. | None | Missing |
| Anonymize | ANONYMIZE_CLIENT | None | Missing |
| Groups | Group name, ID, type, members, role names, association, contact details, address, notes, custom fields. Groups hold loans and deposits. Delete only when no member has an account. | None; refused on import | Missing |
| Group types | Default "Group" plus custom types: ID pattern, allow opening accounts, allow as guarantor, show default address fields. CHANGE_GROUP_TYPE. | None | Missing |
| Group role names | ID and name. Several members can share a role. Used as notification recipients. | None | Missing |
| Group controls | Whether a client may be in more than one group; group size limit at None, Warning or Hard | None | Missing |
| Permissions | Clients: 14 codes. Groups: 7 codes. | VIEW_CLIENT_DETAILS, CREATE_CLIENT, EDIT_CLIENT; the centre codes; the document codes | Partial |
| Centres | Branches and centres, with meeting days | Built, with meeting days that move the first repayment date | Built |
| ID documents | Templates, masks, mandatory templates, up to 5 attachments of up to 50 MB each | Templates, masks, mandatory templates, one attachment of up to 700 KB. Expiry is stored but never checked. | Built, with smaller limits |
| API | `/clients` and `/groups` with CRUD, JSON Patch, `:search` over named fields and custom fields, `/clients/{id}/role` | `/members` (JSON merge PATCH, search over column names), `/clients` only with a view filter | Partial |
| Loan cycle | `loanCycle` and `groupLoanCycle` | `prior_loan_cycles` plus completed loans (loan history) | Built for individuals |

## Proposed build

1. **Fix defects 1 to 8.**
   - Member numbers come from a lock-protected counter per client type, with no truncation. The generator skips numbers already taken.
   - The branch defaults to the creator's own branch when they have exactly one.
   - Birth date, gender and national ID are validated and normalised. The national ID and the National ID document are kept in step.
   - Core details become editable, each with its reference platform permission.
2. **Client types.** A migrated "Client" default type, with the reference platform's fields and ID patterns. Custom field usage and the create form follow the type.
3. **Life cycle.**
   - The reference platform's six states, with approve, reject, exit and blacklist, each with an undo and each with its own permission.
   - ACTIVE and INACTIVE follow the member's accounts automatically.
   - The initial state is a tenant setting.
   - The state is checked wherever loans and deposit accounts are opened and guarantees are pledged.
   - Exiting also requires that the member has no pledged guarantees, since SACCO members guarantee each other's loans. Share capital is left for the member to transfer, as the shares module already models.
4. **Internal controls for members and groups:** duplicate checks (fields and level), required assignments, initial state, membership in more than one group, and the group size limit.
5. **Reassignment** of branch, centre and credit officer, one member at a time or in bulk, optionally moving the member's accounts through the existing inter-branch postings.
6. **Delete and anonymize.**
   - Delete a member who never had an account.
   - Anonymize an exited member: personal fields are replaced and the ledger is kept.
7. **Groups.**
   - Groups with types and role names, members and their roles, association, contact details and custom fields.
   - Groups hold deposit accounts and loans, and statements, the portal and reports treat a group as the account holder.
8. **Permissions and API.**
   - The reference platform's 14 client codes and 7 group codes.
   - `/clients` and `/groups` in the reference platform's shape: JSON Patch, `:search` on the reference platform's field names and custom fields, and `/clients/{id}/role`.
   - `/members` stays as it is.
9. **Console.**
   - A full create form, with branch, centre, credit officer, ID documents and custom fields.
   - Edit and state actions on the member page.
   - Bulk reassignment.
   - Groups pages.

Not proposed:

- Profile pictures and signatures.
- The reference platform's larger attachment limits.
- Solidarity group loans, where one loan is split among the group's members. They belong with a return to loan products.

## Decisions (my default in brackets)

1. **Groups:** build them now, and as full account holders? A group holding loans and deposits touches every account, statement, portal and report path. [Yes: groups that hold deposit accounts and loans; solidarity loans later]
2. **Mapping the current states:**
   - PENDING becomes PENDING_APPROVAL.
   - ACTIVE and DORMANT become ACTIVE or INACTIVE, depending on whether the member has accounts. Dormancy belongs on deposit accounts.
   - DECEASED becomes EXITED with the exit reason DECEASED.

   Keep DECEASED as an exit reason? [Yes]
3. **Initial state for new members:** Inactive or Pending Approval? [Inactive, which is closest to today]
4. **Duplicate checks:** which fields, and at what level? [Error on the national ID document number; Warning on name plus birth date, and on phone]
5. **Delete and anonymize:** build both? Anonymizing must respect how long records have to be kept under the Kenya Data Protection Act 2019 and SACCO rules. [Build delete for members who never had an account. Build anonymize for exited members, with the retention period a tenant setting and left unset.]
