# Build log: Custom Fields

Built on 30 September 2026, following `audit-custom-fields.md` (commit 0b0985f) and its nine decision defaults, which John accepted with "build it". The commit is on main, on the device, not pushed.

## Built

### Tenant migration 044

- **Link types:**
  - CLIENT_LINK points at individuals and GROUP_LINK at groups;
  - existing MEMBER_LINK definitions became GROUP_LINK where every stored value is a group, and CLIENT_LINK otherwise;
  - MEMBER_LINK is still accepted as an input name for CLIENT_LINK (decision 4).
- **Dependent fields:** a dependent selection now takes its parent's `available_for_all` as well as its usage. Existing dependent fields were corrected.
- **Transactions by type:** a transaction-channel set whose fields were used by the internal channel alone (the channel transfers were posted through) moved to the new TRANSACTION_TYPE entity, used for transfers (decision 6).
- **Order:** definitions are numbered across their entity (sets in order, then their fields).

### Defects fixed

- **Checkboxes:** a checkbox takes `TRUE` and `FALSE` as well as `true` and `false`.
- **Unique values:**
  - a unique value is checked within the record's own grouped entries;
  - the check runs under a transaction-level advisory lock per field, so two records saved at the same moment cannot both take a value.
- **Option IDs:** they must be letters, digits, dashes and underscores.
- **Set notes:** they can be cleared.
- **Rearranging:** new definitions are placed after the last field of their set in the entity's single numbering.
- **Credit arrangement JSON Patch:** `ADD`, `REPLACE` and `REMOVE` are taken in either case. Before, only lowercase was accepted.
- **Deposit postings:** `/deposits` postings always apply the channel's custom fields, so a required channel field is asked for even when none are sent, as `/api/savings` already did.

### Search (`src/lib/searchCriteria.js`)

- **Types:** `_set.field` filters use the definition's type: numbers compare as numbers, dates and date-times as dates, checkboxes as booleans.
- **Grouped sets:**
  - a filter on a field of a grouped set matches when any entry matches;
  - EMPTY and DIFFERENT_THAN match when no entry has the value;
  - sorting by a grouped field is refused.
- **Unknown fields:** a custom field that is not a definition of the entity is refused.
- **Where it applies:** `/clients:search`, `/groups:search`, `/deposits:search` and `/creditarrangements:search`.

### Values in the reference platform's shape

These rules apply on `/clients`, `/groups`, `/deposits` and `/creditarrangements`.

- **Output:**
  - values are strings, and a checkbox is `TRUE` or `FALSE`;
  - each grouped entry carries `_index`;
  - custom fields are returned only with `detailsLevel=FULL` (decisions 1 and 2).
- **Bodies:** a body value may not be null or an empty string (decision 3).
- **JSON Patch:**
  - paths reach into grouped sets: `/_set/0/field`, `/_set/0` and `/_set/-`;
  - `REMOVE` clears a field or removes an entry;
  - fields the user cannot see are kept.
- **The platform's own endpoints:** `/api/members` and `/api/custom-fields` keep typed values and null as "clear".

### Who may read and write values

`/api/custom-fields/values/:entity/:id` now checks the following through `customFields.assertAccess`:

- **Permissions:** the entity's own view or edit permission (for example EDIT_LOAN_ACCOUNT for a loan account, EDIT_SECURITIES for guarantors and assets, and the account's permission for a transaction).
- **Branches:** the user's branches. A member outside them was already hidden by the branch rules (404); the check covers records without such rules.
- **Member rules:**
  - a blacklisted client's values need EDIT_BLACKLISTED_CLIENT_CFV;
  - an anonymized member takes no values;
  - a member is not read or written as a group, nor a group as a member.

### Entities and quotas

- **TRANSACTION_TYPE:**
  - usage is per type, and the only type is TRANSFER;
  - transfers take these fields rather than the internal channel's;
  - it shares the transactions' `custom_fields` column with the channel fields.
- **Deposit products:** fields are set per product type.
- **Quotas:** a transaction holds at most 25 values of each of the two transaction entities. Other records hold 200.

### API v2 metadata and configuration as code (`src/domain/customFieldConfig.js`)

- **Metadata:**
  - `GET /api/customfields/:id`;
  - `GET /api/customfieldsets` (with `availableFor`);
  - `GET /api/customfieldsets/:id/customfields`;
  - all three need VIEW_CUSTOM_FIELD.
- **Configuration as code:**
  - `GET /api/configuration/customfields.yaml` and `GET /api/configuration/customfields/template.yaml`;
  - `PUT /api/configuration/customfields.yaml`, which needs CREATE_, EDIT_ and DELETE_CUSTOM_FIELD together (decision 8).
- **PUT rules:**
  - PUT replaces the configuration of the entities the file names and leaves the others alone (decision 7);
  - fields and sets left out are deactivated;
  - options, usage and rights left out are removed;
  - a field without rights, or with per-item usage and no items, is deactivated;
  - required implies default;
  - a file with an error changes nothing.
- **Left out:** the asynchronous PUT (decision 9).
- **Guarantors and assets:** they have no sets. In the file they sit under one set per entity (`_guarantors`, `_assets`), whose ID and name are not stored.
- **YAML:** `src/lib/yaml.js` reads and writes the subset the file needs, with no new dependency. It covers block mappings and sequences, quoted and plain scalars, booleans, null, numbers, comments and flow lists of scalars. Errors name the line.

### Console

- **Organization > Fields (`public/js/fields.js`):**
  - an entity picker;
  - the Available for filter on granular entities;
  - Show disabled fields;
  - each set in order with its fields in order;
  - new, edit, delete and move up or down for sets;
  - add, edit, activate or deactivate, delete and move up or down for fields.
- **The definition form:**
  - it has General, Display, Usage, Rights and Description sections;
  - usage is set per product, type or channel from the tenant's own lists.
- **On records:**
  - a grouped set is edited as rows ("edit rows"), not as JSON;
  - a selection with more than 20 options is a searchable list.

## Tests

- **New suites and checks:**
  - `test/custom-fields.test.js`: 69 checks;
  - `test/console.test.js`: 6 new checks for the Fields administration and the grouped rows editor (128).
- **Full runs:** all 45 suites pass, 3,144 checks, in UTC and in Africa/Nairobi.

## Left as it was

- **Metadata shapes:** the API v2 schema pages for custom field metadata did not load during the audit. The metadata endpoints follow the configuration-as-code attribute names, which the reference platform's pages did give.
- **Set state:** sets have no state of their own. A set left out of a configuration file keeps its record, and its fields are deactivated.
