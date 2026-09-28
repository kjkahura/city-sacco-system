# Audit: Users and Access Control against the reference platform

Audited on 28 September 2026 against commit b620ab6. Reference pages read: Understanding Users, Roles and Permissions; Roles; Permissions; Access Preferences; Creating a User; Deactivating, Reactivating and Deleting User Accounts; Profile and Password Management; API Consumers; Audit Trail; Federated Authentication; Getting Support (support and delivery users); Teller Users.

## Defects

1. **A role editor can raise their own access.** `PATCH /api/roles/{code}` checks only `EDIT_ROLE`. A non-administrator who holds it can add any permission to the role they hold, or move a tenant role they hold onto the `TENANT_ADMIN` base and become an administrator. With `CREATE_ROLE`, they can create an administrator-based role. In the reference platform only administrators create or edit administrators. Today only administrators hold `EDIT_ROLE` by default, so the risk is live only once an administrator grants it to someone else.
2. **The catalogue marks view permissions as enforced when the main routes do not check them.** `VIEW_CLIENT_DETAILS`, `VIEW_LOAN_ACCOUNT_DETAILS` and `VIEW_SAVINGS_ACCOUNT_DETAILS` are marked enforced. They gate views, menus and templates, but `GET /api/members`, `/api/loans` and `/api/savings` accept any signed-in staff user. A role with those permissions removed still lists every member and account.
3. **Tenant roles and extra permissions do not reach most routes.** About 30 role lists in the loans, organization, savings, branches, products, index rates, finance and data routes still check the base role. An extra `APPROVE_LOANS` on a teller does not let them approve, and a manager-based role with approval removed still approves.
4. **API access on roles is stored and never checked.** `roles.api_access` has no effect.
5. **Credit officer is free text.** `members.credit_officer` and `loan_accounts.credit_officer` take any string. The reference platform requires a user of the credit officer type, and warns when a credit officer who has clients is deactivated.
6. **Till permission meanings differ from the reference platform's.** In the reference platform, `ADD_CASH` lets a teller post deposits and repayments through the till, and `REMOVE_CASH` lets them post withdrawals and disbursements. `OPEN_TILL` and `CLOSE_TILL` are supervisor permissions. In the last build, `ADD_CASH` and `REMOVE_CASH` gate a supervisor's cash top-ups, and the built-in `TELLER` role holds `CLOSE_TILL`.
7. **The request check never confirms that the user belongs to the tenant.** `requireAuth` trusts the token's tenant claim, and `userState` loads the user without checking their tenant. A signed staff token with no tenant claim can read any tenant named in `X-Tenant`. A probe with such a token returned 200 on `GET /api/members`, both for a platform administrator and for another tenant's administrator. Every token the platform issues carries the claim, so exploiting this needs the signing key. It is still a missing second check.

## Coverage

| Area | Reference | Platform | Status |
|---|---|---|---|
| User fields | Name, title, role, type, the reference platform or API access, username that cannot change, email, password, 2FA, language, phones, branch | Email (the username, cannot change), name, role, phone, branch, custom fields | Partial: no title, language, user type on the user, or the reference platform/API access |
| User types | Administrator, teller, credit officer on the user; administrator and teller cannot be combined; branch required for tellers and credit officers | Type on tenant roles only; built-in roles have no credit officer type; branch never required | Partial |
| Branch access | All branches, or chosen branches; credit officers can see other credit officers' clients | None: every user sees every branch | Missing |
| Transaction limits | Six types: loan approval, disbursement, fee application, deposits, withdrawals, repayments | Approval and disbursement | Partial |
| Permissions | Given directly or through a role, never both; about 220 codes | Role plus extra permissions on the user; 60 codes catalogued, 27 checked | Deviation (on purpose) and partial |
| Granular administration | CRUD permissions for branches, centres, products, channels, custom fields, users; MANAGE_* for simpler settings | Administration routes check the base role | Missing |
| User management permissions | CREATE_USER, EDIT_USER, VIEW_USER_DETAILS, DELETE_USER | Catalogued, not checked; administrators only | Partial |
| Roles | CRUD, ID, type, access rights, notes; edits reach users; built-in and in-use roles cannot be deleted | All of that | Built (see defect 1) |
| Deactivate and reactivate | Yes, with a confirmation for credit officers with clients | Suspend and reactivate; ends sessions at once | Built, without the credit officer check |
| Lock and unlock | Locked after 3 to 6 failed logins, a cooldown or a permanent lock, unlocked by an administrator, email to the user | Rate limit: 8 attempts per account per 15 minutes, which lifts by itself; no locked state | Partial |
| Delete a user | Allowed only when the user has no activity, clients, tills or transactions | Not possible | Missing (suspending covers the need) |
| Own profile | Edit name, title, email, language; change own password | Change own password only | Partial |
| Forgotten password | Email link | Administrator reset with a temporary password; the platform sends no email | Partial, and blocked on email |
| Password policy | Minimum length (at least 6), counts of digits, capitals and symbols, history (1 to 10, default 4), expiry, must not contain the username; set per tenant | Fixed 12-character minimum, must differ from the current one | Partial |
| Session timeout | Inactivity timeout, set per tenant | 15-minute access tokens, 30-day refresh tokens renewed on use: an open console never times out | Missing |
| Two-factor | SMS; administrators set it up for others; MANAGE_TWO_FACTOR_AUTHENTICATION | TOTP authenticator with recovery codes; required roles set at provisioning only; administrators reset it | Built, stronger than the reference platform, but the tenant cannot change its own policy |
| IP restrictions | Allowlist (IPv4, wildcards, ranges, CIDR) for administrators, UI users or API; blocks an IP after 10 bad API keys | None | Missing |
| Critical-action re-authentication | Password asked again for listed actions (users, roles, products, settings, exports) | None | Missing |
| API consumers and keys | Consumers with a role or permissions; keys shown once, expiry, rotation with secret keys, grace period | None: the API uses the same user sign-in as the console | Missing |
| Federated authentication | SAML 2.0 SSO | None | Not planned unless you want it |
| Audit trail | Every UI and API request, searchable by user, IP, resource and response code | Change records in the tenant and platform audit logs; sign-in attempts recorded but not readable; no request log | Partial |
| Support and delivery users | Read-only support user switched on by the tenant, off after 5 idle days | Platform administrators cannot reach tenant data | Not needed |

## Proposed build

1. Fix defects 1 to 5 and 7, and align the till permissions with the reference platform (defect 6).
2. Move every remaining role-list route onto permissions, including granular administration permissions, user management permissions and the missing codes for features the platform has. Base roles then only set default permission sets.
3. User types on the user, with the reference platform's rules. Branch access: all branches, chosen branches, or other credit officers' clients, applied to members, loans, deposits, views, tasks and reports.
4. Access preferences per tenant: session inactivity timeout, password policy (length, character counts, history, expiry, no username), lockout after failed logins with a locked state and administrator unlock, IP allowlist, re-authentication for critical actions, and the MFA policy.
5. The four transaction limits still missing.
6. Own profile editing. A readable sign-in history. A request-level audit trail with the reference platform's filters.
7. API consumers and keys (optional).

Not proposed: SAML SSO, support and delivery users, and deleting users.

## Decisions (my default in brackets)

1. Permissions given directly and through a role, or only one of the two as in the reference platform? [Keep both, documented as a deviation]
2. Branch access: build it now? It changes what every list returns. [Yes]
3. API consumers and keys: build now or later? [Now; the audit trail and a future streaming API need them]
4. Till permissions: align with the reference platform's meanings? [Yes, and keep the supervisor's add and remove cash under OPEN_TILL]
5. Password expiry: off by default? [Off, with history 4 and minimum length 12]
