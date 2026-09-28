# Build log: lines of credit and solidarity group loans

Built on 28 September 2026. Follows the audit in `audit-loan-engine-open-items.md`. The commit is on main, on the device, not pushed. John pushes with `git push origin main`.

## Decisions (the audit's defaults, taken with "proceed")

1. **Importing revolving, tranched, index-rate and adjustable-rate loans:** kept refused in the Excel import, as in the reference platform's template. Not built.
2. **Solidarity group loans:** built as one individual loan per member, linked to the group and opened together, as the reference platform does.
3. **Credit arrangements:** built, with every loan and deposit product starting at NOT_REQUIRED, so nothing existing changes.
4. **Initial state:** PENDING_APPROVAL, as a client control that can be set to APPROVED.
5. **Overdraft expiry date:** added as an optional field on deposit accounts. It is needed only to link an overdraft to an arrangement.

## Built

### Solidarity group loans

- `POST /api/groups/:id/solidarity-loans` takes the product, the shared loan settings and one line per member (the member and the amount). It opens every member's loan in one transaction through the ordinary application path. `GET` lists the group's solidarity loans with their totals.
- **Product:** a loan product may be available to SOLIDARITY_GROUPS alone (the reference platform's HYBRID_GROUPS is read as it). Mixing it with INDIVIDUALS or GROUPS is refused, as the reference platform unticks Client and Groups for these products.
- **The database's holder check** (tenant migration 035) refuses the product to an individual on their own and to the group itself. A loan made under a group is held by an individual.
- **Checks when the loans are opened:** the group is inactive or active, each member is in the group, and no member is named twice.
- **Where the loans sit:** in the group's branch with the group's credit officer. Each loan keeps its group (`loan_accounts.solidarity_group_id`); a reschedule keeps it when the new product is also for solidarity groups.
- **Loan cycles:** a repaid solidarity loan counts in the member's `loanCycle` and `groupLoanCycle`.
- **Indicators:** GROUP_BORROWERS counts groups with a running group loan or a running solidarity loan. SOLIDARITY_LOAN_PORTFOLIO is new.
- **Deleting a group:** refused when it has solidarity loans or a credit arrangement.
- **Console:** the group page lists the solidarity loans and opens new ones, with an amount per group member.

### Credit arrangements (lines of credit)

- **API:** the reference platform's v2 shape at `/api/creditarrangements`:
  - list (filters `holderKey` and `state`, paging headers), `POST`, and `GET`, `PUT`, `PATCH` and `DELETE /:id`;
  - `POST /:id:changeState`, `:addAccount` and `:removeAccount`, and `GET /:id/accounts`;
  - `GET /api/clients/:id/creditarrangements` and `/api/groups/:id/creditarrangements`, which returned an empty list before.
- **Fields:**
  - an amount;
  - an ID, CA000001 onwards from the account number counters, or one given;
  - a start date and an expire date;
  - the exposure limit type, APPROVED_AMOUNT or OUTSTANDING_AMOUNT;
  - notes;
  - custom fields (entity CREDIT_ARRANGEMENT).
- **Exposure, shown on both bases:**
  - APPROVED_AMOUNT counts the loan amounts and overdraft limits of the linked accounts that are not closed.
  - OUTSTANDING_AMOUNT counts the principal they owe and the overdrawn balances.
  - The amount may be set below the exposure, making available negative (the reference platform). Nothing more is then paid out.
- **States:**

  | State | Reached by |
  |---|---|
  | PENDING_APPROVAL | Creation, or an undo of approve, reject or withdraw |
  | APPROVED | Approve, or creation when the client control says APPROVED |
  | ACTIVE | Adding the first account |
  | CLOSED | Close, once every linked account is closed |
  | WITHDRAWN, REJECTED | Withdraw or reject, from pending approval |

  A closed arrangement is reopened with UNDO_CLOSE, back to the state it was closed from, unless it has expired.
- **Linking accounts:**
  - Each loan and deposit product has `creditArrangementRequirement`: NOT_REQUIRED (the default; none may be linked), OPTIONAL or REQUIRED.
  - An account is added once the arrangement is approved. It must be the same holder's, open, and in no other arrangement.
  - A loan must be in partial application, pending approval, approved or active, disbursed inside the dates, and maturing by the expire date.
  - A deposit account needs an overdraft with an expiry date on or before the expire date.
  - A loan can be linked when it is applied for (`creditArrangementId`, which needs ADD_ACCOUNTS_TO_LINE_OF_CREDIT).
  - An account is removed unless it is closed or its product requires an arrangement.
  - An arrangement is deleted only when it has no accounts.
- **The engine's checks:**
  - The limit is checked when an account is added, when a linked loan's amount or a linked overdraft limit is raised, and at every payout (first disbursement, tranche or revolving draw).
  - On the outstanding basis, a withdrawal or transfer into a linked overdraft is checked too.
  - A payout needs the arrangement approved or active and the date inside its dates. The schedule it draws must mature by the expire date, or the whole disbursement is rolled back.
  - Under a REQUIRED product, a loan is not approved or disbursed, and an overdraft is not set (at opening or later), without an arrangement.
  - A product whose open accounts are linked cannot be set back to NOT_REQUIRED.
  - A loan withdrawn, rejected or closed cannot reopen into a closed arrangement.
- **Restructures:** a rescheduled or refinanced loan takes the old loan's arrangement (the reference platform keeps it linked). The new principal must fit once the old loan is left out.
- **Permissions:**
  - The reference platform's 13 codes in a new "Lines of credit" group; the catalogue is now 167 codes.
  - `REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT` keeps the reference platform's own spelling.
  - Tenant migration 035 and platform migration 010 give each role and user the code matching a loan permission they hold. For example, APPROVE_LOANS gives APPROVE_LINE_OF_CREDIT and UNDO_APPROVE_LINE_OF_CREDIT, and DELETE_LOAN_ACCOUNT gives DELETE_LINES_OF_CREDIT.
  - The built-in roles' defaults follow the same split. Viewing is for all staff; creating, editing, withdrawing and linking are front office; approving, rejecting, the undos and closing are management; deleting is for administrators.
  - The three colon actions share one route rule and each checks its own permission.
- **Branch access:** row security on `credit_arrangements` shows a branch-limited user the arrangements of the holders they see.
- **Reading:**
  - a CREDIT_ARRANGEMENTS custom view and menu item, with `?viewfilter=` on the list;
  - the indicators CREDIT_ARRANGEMENTS (approved and active) and CREDIT_ARRANGEMENT_AMOUNT;
  - the data dictionary entries.
- **Console:**
  - The member and group pages list the arrangements and create new ones.
  - Each arrangement opens on its own page, with its limit on both bases, the state actions the user may take, its loan and deposit accounts, adding and removing accounts, editing and deleting.
  - The client controls card sets the initial state.
  - The deposit page shows the overdraft expiry date.

### Overdraft expiry date

- `savings_accounts.overdraft_expires_on`, set through `PUT /api/savings/:id/overdraft` with `expiryDate`. The limit and the date may each be left out, and a null date clears it.
- Past the date the overdraft limit no longer lends: withdrawals and transfers see no overdraft room, and the balance shows `overdraftExpired`. What is already overdrawn stays owed.
- An overdraft with no expiry date lends as before.
- A linked overdraft keeps its date, which must be on or before the arrangement's expire date.

## Found on the way

- `PUT /api/savings/:id/overdraft` needed a limit every time; a request that only sets the expiry date keeps the current limit.
- The module-layer test lists the domain modules that stand above `loans`; `solidarityLoans` was added to it.

## Tests

- New suite `test/credit-arrangements.test.js` with 76 checks. They cover both exposure bases, the reschedule carry, the REQUIRED product rules on loans and deposits, every state action and its undo, branch access, and running tenant migration 035 a second time.
- The console test gains 3 checks: the group page's solidarity loans, and creating and approving a credit arrangement on its own page.
- 38 suites, 2,625 checks, pass under both UTC and Africa/Nairobi.

## Not built

- Importing revolving, tranched, index-rate and adjustable-rate loans, and solidarity loans, in the Excel import (decision 1).
- The reference platform's `POST /creditarrangements:search` and the credit arrangement schedule endpoint. The list filters by holder and state, and custom views filter on any field.
