# Build log: Users and Access Control

Follows the audit in `claude/audit-users-access-control.md`. Commit 6cea8e9 on main, on the device, not pushed. John pushes with `git push origin main`.

## Decisions (the audit's defaults, taken with "proceed")

- A user's permissions are their role's plus extra permissions of their own. The reference platform allows one or the other; this is kept as a documented deviation.
- Branch access built now.
- API consumers and keys built now.
- Till permissions take the reference platform's meaning. A supervisor's moves of cash in and out of a till stay under OPEN_TILL.
- Password expiry is off by default, with a history of 4 and a 12-character minimum.

## Defects fixed

1. **Role editors could raise their own access.** A user who is not an administrator can no longer do any of the following:
   - change the role they hold;
   - give a role a permission they do not hold;
   - create an administrator role, or move a role onto the administrator base.

   The same rules apply to users and API consumers. Only an administrator creates or edits an administrator.
2. **View permissions were marked enforced but not checked on the main lists.** Every route now goes through one table, `src/lib/routePermissions.js`, and a route missing from it is for administrators only.
3. **Most routes still checked the base role.** All 30 role lists are gone. `requireAuth` now honours only `PLATFORM_ADMIN` and `MEMBER`.
4. **The API access flag on roles did nothing.** Roles now carry the reference platform's two access rights:
   - The reference platform: signing in to the back office.
   - API: the role may be given to an API consumer.
5. **The credit officer was free text.** A database trigger now checks, on members and loans, that the credit officer is a user of the credit officer type or an administrator. Deactivating a credit officer who still has members asks for confirmation first.
6. **Till permissions had the wrong meaning.**
   - ADD_CASH and REMOVE_CASH are the teller's permissions to post through a till. The till trigger checks them.
   - CLOSE_TILL is a supervisor's permission.
   - Moving cash into or out of a till needs OPEN_TILL.
7. **Requests did not check that the user belongs to the tenant.** `userState` now checks the user's tenant, and a token must name the tenant it is used on. A token with no tenant claim now gets 403, and a forged claim gets 401 USER_NOT_FOUND. Both were 200 in the audit's probe.

## Built

- **Permissions:**
  - The catalogue now holds 136 permissions, every one of them checked. They are the reference platform's codes for what the platform has, plus 11 of the platform's own.
  - The built-in roles' defaults were derived from the old route role lists, so access is unchanged except where noted below.
  - Migration 032 gives roles saved before this build the permissions their base role now needs.
  - Role lists in the lending controls, custom field rights and channel usage rights now accept tenant roles.
  - Batch jobs that work on the whole organization need access to every branch.
- **Users:**
  - User type on the user (administrator, teller, credit officer), with the reference platform's rules. A teller or credit officer must belong to a branch.
  - Title and language.
  - A LOCKED state, with unlock.
  - Sign-in history, for the user themselves and for administrators.
  - Users edit their own profile.
  - The reference platform's six transaction limits (the four new ones are fee application, deposits, withdrawals and repayments).
- **Branch access:** all branches, or the user's own branch plus listed ones. A credit officer without "other credit officers' clients" sees only their own members and members with no credit officer.
  - Enforced by row security on members, loan accounts, deposit accounts and transactions, under the `sacco_branch_scoped` role. Migrations grant each tenant's tables to that role.
  - A database without that role refuses branch-limited users rather than show them every branch.
- **Access preferences** (per tenant):
  - Session inactivity timeout: access tokens are capped at the timeout, and an idle session is not renewed.
  - Password policy: length, digit, capital and symbol counts, history and expiry. A password must also contain a letter and a digit and must not contain the username.
  - Lockout after 3 to 6 failed sign-ins, with a cooldown or a permanent lock.
  - IP allowlist for administrators, back-office users or API keys. It refuses a change that would lock out the person saving it.
  - Re-authentication for critical actions: X-Reauth-Token, obtained from POST /auth/reauth.
  - Which roles must use two-factor authentication.
  - API key grace and expiry settings.
  - Audit retention.
- **API consumers and keys:** consumers get a role, their own permissions or the administrator type.
  - Keys are shown once, can expire, and rotate with a secret key and a grace period.
  - An IP address is blocked after ten bad keys, and an administrator can reset it.
  - A consumer whose keys have been used cannot be deleted.
- **Audit trail:** every staff and API request, including refused ones and sign-in attempts.
  - Personal details and secrets are removed from stored bodies.
  - The reference platform's filters, with a 10,000-row window.
  - Pruned at end of day.
- **Console:**
  - The Users page shows user type, state, branch access, limits, unlock and sign-ins.
  - The role editor has the access rights.
  - A new Access page covers preferences, blocked addresses, API consumers and keys, and the audit trail.
  - Clicking your name opens your profile, where you can also change your password and see your sign-ins.
  - The console asks for your password before critical actions and signs out after inactivity.

## Changes to what built-in roles can do

- An auditor now reads user details, staff transaction limits and the user audit log.
- A manager now runs the end-of-day positions snapshot.
- A teller now posts through a till with ADD_CASH and REMOVE_CASH, but no longer closes a till.
- A limit set on an administrator applies.

## Tests

- New suite `test/uac.test.js` with 119 checks.
- Tests updated for the reference platform's rules:
  - passwords with a digit and without the username;
  - tellers and credit officers in a branch;
  - credit officers of the credit officer type;
  - a supervisor closing tills;
  - permissions deciding access instead of base roles.
- The console test gains checks for the Access page and the profile.
- 35 suites, 2,369 checks, pass under both UTC and Africa/Nairobi.

## Not built

- SAML single sign-on and support or delivery users (not proposed).
- Deleting users; deactivating them covers the need.
- Branch scoping of the general ledger.
