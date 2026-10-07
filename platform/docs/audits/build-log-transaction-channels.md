# Build log: Transaction Channels

Built on 7 October 2026, following `audit-transaction-channels.md` and its decision defaults, which John accepted with "Yes, start". The commit is on main locally and on the device, not pushed.

## Built

### The reference platform's API v2 (`src/domain/channelConfig.js`)

- **Routes** under `/api/organization/transactionChannels`:
  - `GET` lists the channels in their order, with `transactionChannelState=ACTIVE|INACTIVE`;
  - `GET /:id` returns one channel;
  - `POST` creates one (201) and honours `Idempotency-Key`;
  - `PUT /:id` replaces one; the ID cannot change;
  - `DELETE /:id` answers 204.
- **Shape:** `id`, `name`, `state`, `glAccount`, `isDefault`, `availableForAll`, `usageRights`, `loanConstraints` and `depositConstraints` (`usage`, `matchFiltersOption`, `constraints` with `criteria`, `operator`, `value`, `secondValue`, `values`), and `channelType` as an addition.
- **Permissions:** the four channel permissions, as on `/api/transaction-channels`, which stays for existing callers.

### Configuration as code

- `GET` and `PUT /api/configuration/transactionchannels.yaml`, and a starting file at `/api/configuration/transactionchannels/template.yaml`.
- **The file:** `defaultTransactionChannel` and `transactionChannels`, each channel with `id`, `name`, `state`, `loansConstraints` (`loanConstraints` is also read), `savingsConstraints`, `glAccountCode`, `usageRights` (`roles`, `allUsers`) and `channelType`.
- **A PUT:**
  - needs the create, edit and delete permissions together;
  - creates and updates the channels the file lists, in its order (the default keeps its place);
  - deletes the channels it leaves out, or deactivates them with the reference platform's warning when they have been used or another record names them;
  - keeps the system channels, with a warning;
  - refuses a change of the default channel's ID, its deactivation, and a SACCO with no default channel;
  - runs in one transaction under a lock on the channels table.
- **Round trip:** a file read with `GET` is taken back by `PUT` unchanged.

### Constraint operators

- **AMOUNT:** EQUALS, MORE_THAN, LESS_THAN, BETWEEN, EMPTY, NOT_EMPTY. **TYPE and PRODUCT:** IN, EMPTY, NOT_EMPTY.
- **Stored model:** the inclusive minimum and maximum stay. A strict bound is stored a cent inside it and read back as the operator it came from (decision 1). `EMPTY` and `NOT_EMPTY` are stored as an operator on the filter.
- **Validation:** an amount is a number not below zero with at most two decimals; BETWEEN takes the lower amount first; TYPE values are the side's types; a product filter names existing products of its side (loan or deposit), checked only for products new to the channel.

### Defects fixed (`src/domain/channels.js`)

- **System channels:** `internal`, `settlement` and `transfer`, which the platform posts through itself, can no longer be deleted, or deactivated once active.
- **A channel without a GL account** (the seeded `internal`) can be edited without being given one.
- **Bad filters** (a filter that is not an object, a list that is not a list, a negative or written amount) are refused with a code instead of being stored.

### Console (`public/js/channelEditor.js`)

- The channel form sets Unconstrained or Limited usage, Match All or Match Any, and one row per filter (criterion, operator, values), with checkboxes for types. It replaces the JSON text boxes.
- The Transaction channels card reads and writes through the API v2 routes and shows constraints as text ("any of: amount more than 5000.00, type in REPAYMENT").

## Review

An independent review of the change found, and the build fixed:

- a closed side (Limited, no filter) and a legacy minimum of zero did not survive the file's round trip;
- a system channel already inactive could not be edited;
- a SACCO with no default channel would have been given an unprotected one;
- the product check refused edits to a channel naming a deleted product;
- a channel named by a loan account, till or collection batch failed the PUT on the foreign key instead of being deactivated;
- concurrent PUTs were not serialised;
- the round-trip test compared two reads taken after the PUT.

It found no security issue. Express matches paths in any case, but the permission table does not, so another spelling falls to administrators only (fails closed).

## Tests

- **`test/transaction-channels.test.js`** (new, 86 checks): the operators and their round trip, the API v2 routes and their validation, constraints on postings, update and delete, permissions, the configuration file (round trip, the reference platform's own example shape, deletion and deactivation, system channels, order, errors that change nothing, the template, the change log).
- **`test/console.test.js`:** the channel form creates a channel with two filters, reopens with them and saves it unconstrained.
- **Full run, both time zones:** 3,746 checks passed in East Africa Time; the only failures are the known date failures (lending 2, loan-accounting 8, loan-accounts 1). One events-streaming check failed once in UTC and passed on rerun.

## Left out

- `detailsLevel=FULL` with nested custom field definitions (decision 7).
- Share constraints: the reference has none (decision 10).
- The hard-coded `bank` default for seizures without a channel stays; a SACCO that deletes `bank` must name a channel on seizures.
