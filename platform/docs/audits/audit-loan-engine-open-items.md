# Audit: the loan-engine open items against the reference platform

Audited on 28 September 2026, after the open-items build. Three items were held back because they reach into the loan engine:

1. Importing revolving, tranched, index-rate and adjustable-rate loans.
2. Solidarity group loans.
3. Lines of credit (the reference platform's credit arrangements).

Reference pages read:

- Excel Migration Template
- Loans for Groups (types of loan groups)
- Working with Credit Arrangements (Lines of Credit)
- Creating a new credit arrangement
- Credit arrangement states
- Managing credit arrangements
- Adding accounts to a credit arrangement
- Permissions (Credit Arrangements)

## 1. Importing revolving, tranched, index-rate and adjustable-rate loans

**The reference platform:** its own Excel migration template has no columns for any of them. There is no revolving credit, no tranches, and no rate source, spread, review frequency or adjustable-rate setting; the loan has one Interest Rate field. The reference platform also says its template cannot import solidarity group loans.

**Platform:** the import refuses these loans with a clear message. `src/domain/loanMigration.js` accepts FIXED_TERM and DYNAMIC_TERM products only, and refuses index-rate products.

**Finding:** this is not a gap against the reference platform. The refusal matches what the reference platform's template supports. Importing these loans would go beyond the reference platform, and each type needs state the template has no place for:

- Tranched loans: each tranche's amount, date and whether it was disbursed.
- Revolving loans: the limit, the amount drawn and the billing cycle position.
- Index-rate loans: the rate source, the spread and the next review date.
- Adjustable-rate loans: the adjustment history.

## 2. Solidarity group loans

**The reference platform:**

- A solidarity (or hybrid) group loan is one individual loan account per member. Each account has its own ID, amount and schedule, and all of them are made together for a group.
- A member's write-off leaves the others running. A member who defaulted can be kept from the next cycle while the others go on.
- Loan cycles advance per member.
- The product is made available to solidarity groups only, not to individuals or ordinary groups.
- A pure group loan is one loan held by the group, with one schedule. The Clients and Groups build already supports these.

**Platform:** there are no solidarity loans.

- `loan_accounts` has no link from a member's loan to the group it was made under.
- `available_for` on products takes INDIVIDUALS and GROUPS only.

**Finding: low engine risk.** Each member's account is an ordinary individual loan, and the engine already handles those. What is new:

- a link from the loan to its group;
- a product availability value, SOLIDARITY_GROUPS;
- one call that opens every member's loan together;
- the group page showing its members' loans;
- `groupLoanCycle` counting them.

Existing loans and products are unaffected, because no product is available to solidarity groups until a tenant says so.

## 3. Lines of credit (credit arrangements)

**The reference platform:**

- **What it is:** a credit arrangement is one holder's credit limit (a member or a group) across several loan and overdraft accounts.
- **Fields:**
  - an amount;
  - an ID, generated automatically;
  - a start date and an end date;
  - an exposure limit type: either the original amounts (loan amounts and overdraft limits) or the current balances;
  - notes;
  - custom fields.
- **States:**

  | State | Reached by |
  |---|---|
  | PENDING_APPROVAL | Creation (when that is the initial state) |
  | APPROVED | Approve, or creation (the initial state is an internal control) |
  | ACTIVE | Adding the first account |
  | CLOSED | Close, once every linked account is closed |
  | WITHDRAWN, REJECTED | Withdraw or reject, from pending approval only |

  Approve, withdraw and reject each have an undo. A closed arrangement can be reopened.
- **Linkable accounts:**
  - Loans, when the product allows it: Optional, Required or No.
  - Deposit accounts with an overdraft, which must have an overdraft expiry date.
  - A linked account must belong to the same holder, be in partial application, pending approval, approved or active, and not be linked elsewhere.
  - A loan must be disbursed after the start date and mature before the end date, and adding it must keep the total within the limit.
- **Display:** available and consumed credit, on both bases.
- **Edits:** the amount can be set below the exposure, which makes the available credit negative. The dates must still cover the linked accounts.
- **Reschedules:** a rescheduled or refinanced loan stays linked.
- **Closing and deleting:** closing needs every account closed, and a closed arrangement's accounts cannot reopen. An arrangement can be deleted only with no accounts.
- **Permissions:** VIEW_LINE_OF_CREDIT_DETAILS, CREATE_LINES_OF_CREDIT, EDIT_LINES_OF_CREDIT, APPROVE_LINE_OF_CREDIT, UNDO_APPROVE_LINE_OF_CREDIT, WITHDRAW_LINE_OF_CREDIT, UNDO_WITHDRAW_LINE_OF_CREDIT, REJECT_LINE_OF_CREDIT, UNDO_REJECT_LINE_OF_CREDIT, ADD_ACCOUNTS_TO_LINE_OF_CREDIT, REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT (the reference platform's spelling), CLOSE_LINES_OF_CREDIT, DELETE_LINES_OF_CREDIT.

**Platform:**

- **Arrangements:** none. `GET /api/clients/:id/creditarrangements` and `/groups/:id/creditarrangements` return an empty list as placeholders.
- **Exposure:** a tenant-wide maximum per member exists (the lending controls: SUM_OF_LOANS or SUM_MINUS_DEPOSITS). It stays as it is: the reference platform keeps the two apart.
- **Overdrafts:** deposit accounts have an overdraft limit but no overdraft expiry date, which the reference platform requires before an overdraft can be linked.

**Finding: medium engine risk, and no conflict if the product setting defaults to No.** The engine gains a check wherever a linked account's exposure grows:

- a loan joins an arrangement;
- a loan is disbursed, or a tranche is;
- a revolving loan is drawn;
- an overdraft limit is set.

Existing loans and deposit accounts, and products left at No, are untouched.

## Proposed build

1. **Solidarity group loans:**
   - `loan_accounts.solidarity_group_id`, and SOLIDARITY_GROUPS in `available_for`.
   - `POST /api/groups/:id/solidarity-loans` with one line per member (the member and the amount) and the loan settings, which opens every member's loan in one transaction through the existing application path.
   - The group page lists the loans and their totals; group indicators count them; `groupLoanCycle` counts completed ones.
2. **Credit arrangements:**
   - A `credit_arrangements` table, with `/api/creditarrangements` in the reference platform's shape and each state action.
   - Adding and removing accounts, including `/creditarrangements/:id:addAccount`.
   - A product setting `creditArrangementRequirement` (OPTIONAL, REQUIRED, NOT_REQUIRED) on loan and deposit products, default NOT_REQUIRED.
   - An optional overdraft expiry date on deposit accounts.
   - The limit checked when an account is added, at disbursement, at a tranche or revolving draw, and when an overdraft limit changes.
   - The initial state is a client control.
   - The reference platform's 13 permissions.
   - Console tab on the member and group pages.
3. **The four loan types in the import:** not built. They stay refused in the Excel import, as in the reference platform's template.

## Decisions (my default in brackets)

1. **Importing the four loan types:** keep them refused, as the reference platform does, or extend the platform's own migration API (`POST /api/loans/migrate`) beyond the reference platform? [Keep refused; revisit only if a real migration needs one of them]
2. **Solidarity group loans:** build them as linked individual loans, as the reference platform does? [Yes]
3. **Credit arrangements:** build them with the product setting defaulting to NOT_REQUIRED, so nothing existing changes? [Yes]
4. **Initial state of a new credit arrangement:** PENDING_APPROVAL or APPROVED? [PENDING_APPROVAL]
5. **Overdraft expiry date:** add it as an optional field on deposit accounts? It is required only to link an overdraft to an arrangement. [Yes]
