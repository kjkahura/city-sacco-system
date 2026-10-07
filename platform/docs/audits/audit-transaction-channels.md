# Audit: Transaction Channels against the reference platform

Audited on 7 October 2026, at commit f9abdfb. The proposed build and its decisions are at the end; the build itself is logged in `build-log-transaction-channels.md`.

## Reference pages read

- **Transaction Channels** (the user guide page). It covers the predefined Cash channel, the four permissions, the ID and name, loan and savings constraints (Amount, Type and Product, with Match All or Match Any), the GL account, usage rights by role, custom fields per channel, deactivation, deletion and rearranging.
- **Transaction Channels Configuration** (configuration as code). It covers `GET` and `PUT /configuration/transactionchannels.yaml`, the attributes, the constraint operators and the validations.
- **API v2, Transaction Channels:** create (`POST /organization/transactionChannels`), get all (`GET /organization/transactionChannels`, with `transactionChannelState` and `detailsLevel`), get by ID, update (`PUT /organization/transactionChannels/{id}`) and delete (`DELETE`, answered 204). The request and response schemas were read from the rendered pages.

The schema pages linked from search results no longer exist; the operation pages carry the same schemas.

## What the platform has

Transaction channels were built with Organization setup (tenant migrations 001 and 027).

- **Records:** `transaction_channels` with ID, name, type (CASH, MOBILE, TRANSFER, CHEQUE, INTERNAL, PAYROLL), GL account, order, default flag, active flag, usage roles and loan and deposit constraints.
- **Seeds:** cash (the default), M-Pesa, bank transfer, cheque, payroll check-off, and three internal channels (`internal` with no GL account, `settlement`, `transfer`).
- **API:** `/api/transaction-channels`: list (with `?usable=true` for the channels the signed-in user may post through), create, edit, delete and rearrange. Every change is in the change log.
- **Permissions:** `VIEW_`, `CREATE_`, `EDIT_` and `DELETE_TRANSACTION_CHANNELS`, as in the reference.
- **Rules:**
  - the default channel can be renamed, not deleted or deactivated;
  - a channel that has been used can be deactivated, not deleted;
  - a GL account change on a used channel returns a warning to move past balances by manual journal entry;
  - the order is set by a list of IDs.
- **Constraints:** `{"match": "ALL" | "ANY", "filters": [...]}` with three filter kinds: `AMOUNT` (inclusive minimum and maximum), `TYPE` (DISBURSEMENT, REPAYMENT, RECOVERY for loans; DEPOSIT, WITHDRAWAL for deposits) and `PRODUCT` (product IDs).
- **Enforcement:** `assertUsable` is called by loan disbursement, repayment and recovery, and deposit deposits and withdrawals (including the funds route). Share transactions check usage rights only.
- **Custom fields per channel:** transaction custom fields can be limited to channels and made required per channel.
- **Console:** Organization, "Transaction channels" card. Constraints are typed as raw JSON; a typing error shows only "Constraints must be JSON".

## Findings

| # | Reference | Platform | Gap |
| --- | --- | --- | --- |
| 1 | API v2 at `/organization/transactionChannels`, with `state`, `glAccount`, `availableForAll`, `usageRights`, `loanConstraints` and `depositConstraints` | Its own shape at `/transaction-channels` | No reference-shaped API. An integration written for the reference cannot manage channels. |
| 2 | Configuration as code: `GET` and `PUT /configuration/transactionchannels.yaml` | None (custom fields have it) | Missing. |
| 3 | Constraint operators: `EQUALS`, `MORE_THAN`, `LESS_THAN`, `BETWEEN`, `EMPTY`, `NOT_EMPTY` for amounts; `IN`, `EMPTY`, `NOT_EMPTY` for type and product | Inclusive minimum and maximum; type and product lists | `EMPTY` and `NOT_EMPTY` cannot be expressed. The others map onto a range (see decision 3). |
| 4 | Product constraint values must be existing product IDs of the right kind | Any string accepted | A typing error makes the channel refuse every transaction without saying why. |
| 5 | Usage set in a form: Unconstrained or Limited, Match All or Match Any, filters added one by one | Raw JSON in a text box | Hard to use and easy to get wrong. |
| 6 | Channel type | Not in the reference | A local addition, used only as a label. Kept, as an extension field. |
| 7 | Share transactions | The reference has no share constraints | Shares check usage rights only. Matches the reference; no change. |
| 8 | `glAccount` not required | Required on create, except the seeded `internal` channel | Kept: a channel without a GL account cannot post. Configuration as code allows a missing GL account only on a channel that already has none. |
| 9 | Only the predefined channel is protected | `internal`, `settlement` and `transfer` are posted through by the platform itself (transfers between deposit accounts, dividend payouts, settlement accounts, loan transfers), yet could be deleted while unused or deactivated | A defect: deleting or deactivating one breaks those postings. |
| 10 | A channel that has been used cannot be deleted | Only transactions and journal entries count as use | Loan accounts, tills and collection batches also name channels; deleting one of those fails on the database's foreign key with a generic error. |

## Proposed build

1. **Reference-shaped API** in `src/domain/channelConfig.js`, mounted at `/api/organization/transactionChannels`: get all (filter by state), get by ID, create (201, honours `Idempotency-Key`), update by full replacement (`PUT`), delete (204). The same permissions as the existing routes. The existing `/api/transaction-channels` stays for the console and current callers.
2. **Configuration as code:** `GET` and `PUT /api/configuration/transactionchannels.yaml`, and a template at `/api/configuration/transactionchannels/template.yaml`.
3. **Constraint operators** in the stored model: `EMPTY` and `NOT_EMPTY` added; product values checked against the products of the right kind.
4. **System channels:** `internal`, `settlement` and `transfer` cannot be deleted, or deactivated once active. A configuration file that leaves them out keeps them, with a warning.
5. **Console constraints form:** Unconstrained or Limited, Match All or Any, and a row per filter (criterion, operator, values), in place of the JSON box.

## Decisions (defaults taken)

1. **Strict and inclusive bounds.** `MORE_THAN` and `LESS_THAN` are taken as strict, and `BETWEEN` as inclusive at both ends; the reference pages do not say. Amounts are in cents, so `MORE_THAN 100` is stored as a minimum of 100.01 and shown back as `MORE_THAN 100`. An existing inclusive minimum of 100 is shown as `MORE_THAN 99.99`, and a minimum of zero as `NOT_EMPTY` (it takes every amount).
2. **`EMPTY` and `NOT_EMPTY`.** Every transaction has an amount, a type and a product, so `EMPTY` never matches and `NOT_EMPTY` always does. This reproduces the reference example where `PRODUCT EMPTY` closes a channel to loans. A side that is Limited with no filter (closed) is written to the file as `PRODUCT EMPTY`, so the file reads back.
3. **Recovery.** Loan type values include `RECOVERY` (a repayment after write-off), which the reference does not list. It is kept.
4. **Key names in the YAML.** The reference's example uses `loansConstraints` and its attribute table `loanConstraints`. The file is written with `loansConstraints`; both are read.
5. **A PUT of the YAML** replaces the configuration: channels the file leaves out are deleted, or deactivated with a warning when they have been used or another record names them. The system channels are kept. The default channel's ID cannot change and it cannot be deactivated; a SACCO with no default channel is refused. The listed channels take the file's order; the default keeps its place. It all runs in one transaction, under a lock on the channels table, so a file with an error changes nothing and two files cannot interleave.
6. **`PUT /organization/transactionChannels/{id}`** is a full replacement of the reference fields: a missing `state` means ACTIVE, and missing usage rights mean all users. `channelType`, not a reference field, is kept when left out. The ID in the body, if given, must match the address.
7. **`detailsLevel`** is accepted and ignored: the response has no nested custom field definitions. Custom fields per channel stay at `/api/custom-fields`.
8. **Usage rights** are role IDs as `/api/roles` lists them, as today.
9. **Product checks** apply to products newly named in a filter. A product the channel already names may since have been deleted, and the channel can still be edited.
10. **Shares** keep the rights-only check: the reference has no share constraints.
