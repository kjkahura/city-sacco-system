# Audit: Custom Fields against the reference platform

Audited on 30 September 2026, at commit 076e51b. Nothing is built yet; the proposed build and its decisions are at the end.

## Reference pages read

- **Custom Fields** (the user guide page). It covers definitions and values, the value quotas, the entities, the per-type granularity, standard and grouped sets, the nine field types, usage, rights, managing definitions, and definitions as document placeholders.
- **Custom Fields Configuration** (configuration as code). It covers `GET` and `PUT /configuration/customfields.yaml`, the template, the YAML attributes and the update rules.
- **Using Custom Fields** (API v2). It covers the value shape (`_set` objects, grouped sets as lists with `_index`), `detailsLevel=FULL`, JSON Patch (RFC 6902), and the rule that a value in a body may not be an empty string or null.

The API v2 schema pages for custom field and custom field set metadata did not load here. The metadata endpoints named below are the ones those schema pages belong to. Their exact response shapes are to be checked when the build starts.

## What the platform has

Custom fields were built with Organization setup (tenant migration 027) and extended by later sections.

- **Definitions and sets:**
  - `src/domain/customFields.js`, served at `/api/custom-fields`;
  - sets are standard or grouped, with IDs starting with `_`, and can be created, renamed, deleted when empty and rearranged;
  - definitions can be created, edited, deactivated, deleted when no record holds a value, and rearranged, with a dependent field kept below its parent.
- **Entities (11):**
  - members and groups, per client or group type;
  - loan accounts, per loan product;
  - deposit accounts, per deposit product;
  - transactions, per channel;
  - deposit products, guarantors and collateral, with no sets for the last two;
  - branches, centres, users and credit arrangements.
- **Types (8):** FREE_TEXT (input mask, unique value, 2,048 characters), SELECTION (option IDs, scores, options that depend on a parent selection in the same set), NUMBER, CHECKBOX, DATE, DATE_TIME, MEMBER_LINK and USER_LINK. Every type can be a long field.
- **Usage:**
  - Available, Default and Required, where Required implies Default and Default implies Available;
  - usage is per item for the granular entities, or for all items;
  - a dependent field takes its parent's usage.
- **Rights:**
  - view and edit roles per definition, where empty means every role, current and future;
  - edit rights carry view rights;
  - a user without edit rights is not held to a required field.
- **Values:**
  - kept in each record's `custom_fields` column in the API v2 shape;
  - checked on create and update; at most 200 per record;
  - filtered by view rights when read;
  - set sums shown as scores.
- **Where the values are used:**
  - **Reference-shaped APIs:** `/clients`, `/groups`, `/deposits` and `/creditarrangements` show them and take them. `/clients` takes them through JSON Patch on `/_set/field`, and `:search` filters on `_set.field`.
  - **Transactions:** deposits, withdrawals, repayments, transfers (as the `internal` channel) and bulk deposits.
  - **Documents:** product document placeholders.
  - **Views:** custom views, including grouped sets.
  - **Other flows:** the data import, and a reschedule, which carries the values to the new loan.
- **Console:**
  - a Custom fields card, with an editor, on member, group, loan, deposit and credit arrangement pages;
  - in Organization, a table of definitions, a New set dialog, a New field dialog, and activate or deactivate.
- **Permissions:**
  - VIEW_, CREATE_, EDIT_ and DELETE_CUSTOM_FIELD for definitions;
  - values follow each definition's rights.

## Findings

### 1. Entities and granularity

**The reference platform:**

- 13 entities: clients, groups, loan accounts, deposit accounts, deposit products, credit arrangements, guarantors, assets, branches, centres, users, transactions by channel, and transactions by type (transfers only);
- deposit products are granular per deposit product type.

**Platform:**

- the same entities except transactions by type, with assets as collateral;
- transfers take the fields of the `internal` channel;
- deposit product fields apply to every product type.

**Gaps:**

- transactions by type;
- deposit product fields per product type.

### 2. Field types

**The reference platform:** nine types, with CLIENT_LINK and GROUP_LINK as separate types.

**Platform:** one MEMBER_LINK type, and nothing checks what it points at.

**Defect:** a member link accepts a group, because the lookup reads the members table without checking the holder type.

**Gaps:**

- CLIENT_LINK and GROUP_LINK as separate types;
- the reference platform's type name CLIENT_LINK.

### 3. Values in the reference platform's API shape

**The reference platform:**

- values are strings, and a checkbox is `TRUE` or `FALSE`;
- each entry of a grouped set carries `_index`;
- values are returned only with `detailsLevel=FULL`;
- a body value may not be an empty string or null, and a value is removed with a JSON Patch `REMOVE`.

**Platform:**

- values keep their stored JSON type: numbers are numbers and checkboxes are booleans;
- grouped entries have no `_index`;
- BASIC responses drop them only because they are nested objects;
- null or an empty string clears a value.

**Defect, confirmed:** a checkbox sent as `"TRUE"`, the reference platform's own form, is refused with `INVALID_CUSTOM_FIELD_VALUE`. Only `true`, `false`, `"true"` and `"false"` are accepted.

**Gaps:**

- string output and `_index` on reference-shaped responses;
- refusing null and empty strings on those endpoints.

### 4. JSON Patch on custom fields

**The reference platform:** RFC 6902, including paths into grouped sets such as `/_set/0/field` and appending with `/_set/-`.

**Platform:** `/clients` JSON Patch takes one or two path segments only.

**Gaps:**

- grouped-set paths;
- JSON Patch on the other reference-shaped entities.

### 5. Searching by custom fields

**The reference platform:** `:search` filters on custom field values.

**Platform:**

- `_set.field` is read as text: `custom_fields -> set ->> field`;
- no type is taken from the definition.

**Defects, confirmed:**

- MORE_THAN, LESS_THAN and BETWEEN on a NUMBER field compare text, so 10 is less than 9;
- a filter on a field in a grouped set matches nothing, because the set is a list;
- a checkbox filter depends on the case of `true`.

### 6. Usage

**The reference platform:** a dependent selection inherits its parent's usage.

**Platform:**

- the dependent field copies the parent's `usage` JSON;
- the dependent field keeps its own `available_for_all`, which defaults to true.

**Defect, confirmed:** the parent was made available for one loan product only. Its dependent field is still available for every product, because `usageFor` reads `available_for_all` before the item list.

### 7. Unique values

**The reference platform:** a unique FREE_TEXT value, error 926 `DUPLICATE_UNIQUE_VALUE`.

**Platform:**

- the uniqueness check compares the value with other records;
- NUMBER fields may be unique as well.

**Defects:**

- **Within one record, confirmed:** two entries of a grouped set in the same record may hold the same unique value.
- **Across records:** the check is a SELECT with no lock, so two records saved at the same moment can both take the same value.

### 8. Selection options

**The reference platform:** option IDs of letters, digits, dashes and underscores. The UI lists 20 options and searches beyond them.

**Platform:** option IDs are not checked.

**Defect, confirmed:** an option ID such as `has space!` is stored.

**Console gap:** the editor shows every option in a plain list, with no search.

### 9. Value quotas

**The reference platform:** 200 values per record, but 25 for transactions by channel and by type.

**Platform:** 200 for every entity.

**Gap:** 25 on transactions.

### 10. Who may read and write values through `/api/custom-fields/values`

**Platform:**

- the `GET` route is open to any signed-in user;
- the `PUT` route needs any one of EDIT_CLIENT, EDIT_LOAN_ACCOUNT, EDIT_SAVINGS_ACCOUNT, EDIT_USER, EDIT_BRANCH or EDIT_CENTRE, whatever the entity.

**Defects:**

- **Mismatched permissions:** a user with EDIT_BRANCH alone can write the custom fields of any loan account or member.
- **Unscoped reads:** a user can read the values of a record they have no view permission for, or one outside their branches.
- **Member rules skipped:** writes through this route skip the member rules that `/clients` applies, namely the blacklisted client check (EDIT_BLACKLISTED_CLIENT_CFV) and the anonymized member check.

### 11. Definition metadata and configuration as code

**The reference platform:**

- read endpoints for definitions and sets in API v2;
- `GET` and `PUT /configuration/customfields.yaml` and the template.

PUT through configuration as code works as follows:

- replaces every set and definition of the file's entities;
- deactivates, rather than deletes, those left out;
- deletes selections, usages and rights left out;
- deactivates a definition that has no rights or no usage.

**Platform:**

- `/api/custom-fields` returns database rows (`field_type`, `edit_roles`, and so on);
- there is no reference-shaped metadata and no YAML.

**Gaps:**

- the metadata endpoints in the reference platform's shape;
- configuration as code.

### 12. Console administration

**The reference platform:** Administration > Fields per entity, which covers:

- sets and their order;
- each definition's General, Display, Usage, Rights and Description sections;
- editing, deactivating, deleting and rearranging definitions;
- Show Disabled Fields;
- Filter for and Available for filters on the granular entities.

**Platform:** a flat table of every definition, create dialogs, and activate or deactivate.

**Gaps:**

- editing a definition, including usage per item, rights and options;
- deleting;
- rearranging sets and fields;
- a per-entity view with the filters;
- editing grouped sets without typing JSON.

### 13. Smaller points

- **Set notes:** once set, they cannot be cleared, because the update uses COALESCE.
- **Sort order:** new definitions are numbered per set, but rearranging numbers them across the entity.
- **Deactivated values:** a deactivated definition's values stay and are shown, as in the reference platform. **No gap.**
- **Document placeholders:** these work. **No gap.**

## Proposed build

1. **Defects** (no migration):
   - **Dependent usage:** a dependent field takes its parent's `available_for_all` as well as its usage, and existing dependent fields are fixed on migration.
   - **Checkbox values:** `TRUE`, `FALSE`, `true` and `false` are accepted.
   - **Unique values:**
     - checked within the record's own grouped entries;
     - checked under a transaction-level advisory lock on the definition, so two concurrent saves cannot both take a value.
   - **Option IDs:** checked against `^[A-Za-z0-9_-]{1,64}$`.
   - **Set notes:** can be cleared.
   - **Sort order:** numbered one way.
2. **Link types** (a tenant migration):
   - CLIENT_LINK, which points at individuals only, and GROUP_LINK, which points at groups only;
   - existing MEMBER_LINK definitions become CLIENT_LINK, or GROUP_LINK where every stored value is a group;
   - MEMBER_LINK is still accepted as a name for CLIENT_LINK.
3. **Search:**
   - `_set.field` filters use the definition's type (numeric, date, date-time or boolean comparison);
   - they match any entry of a grouped set;
   - unknown fields are refused.
4. **Values in the reference platform's API shape** on `/clients`, `/groups`, `/deposits` and `/creditarrangements`:
   - values as strings, with checkboxes as `TRUE` or `FALSE`, and `_index` on grouped entries;
   - values only with `detailsLevel=FULL`;
   - null and empty strings refused in bodies;
   - JSON Patch paths into grouped sets (`/_set/0/field`, `/_set/-`, `REMOVE` of an entry).
5. **Permissions on `/api/custom-fields/values`:**
   - the entity's own permission (for example EDIT_LOAN_ACCOUNT for a loan account);
   - the entity's view permission and the user's branches for reads;
   - the member rules (blacklisted, anonymized) applied here as in `/clients`.
6. **Entities:**
   - transactions by type, for transfers, with its own usage;
   - deposit product fields per product type;
   - a quota of 25 values on both transaction entities.
7. **Metadata and configuration as code:**
   - `GET /api/customfields/:id`, `GET /api/customfieldsets` and `GET /api/customfieldsets/:id/customfields` in the reference platform's shape;
   - `GET` and `PUT /api/configuration/customfields.yaml` and `GET /api/configuration/customfields/template.yaml`, with the reference platform's update rules;
   - PUT runs in one transaction, so a file with an error changes nothing.
8. **Console:** Administration > Fields, which covers:
   - an entity picker;
   - sets in order, with their fields in order;
   - one form per definition with General, Display, Usage (per item for granular entities), Rights and Description;
   - edit, deactivate, delete and rearrange;
   - Show Disabled Fields;
   - the Available for filter;
   - on records, a grouped set edited as rows rather than JSON, and a searchable selection when there are more than 20 options.
9. **Tests:** a new `test/custom-fields.test.js` for the above. The existing suites keep passing.

## Decisions (my default in brackets)

1. **Value types on reference-shaped responses:** the reference platform returns strings. Changing numbers and booleans to strings changes what current API clients of `/clients`, `/deposits` and `/creditarrangements` receive. [Strings, as the reference platform does. The platform's own `/api/members` and `/api/custom-fields` keep typed values]
2. **Values with BASIC:** returning custom fields only with `detailsLevel=FULL` hides them from clients that read them today without it. [FULL only, as the reference platform does, on the reference-shaped endpoints]
3. **Null and empty strings:** [Refused on the reference-shaped endpoints, where `REMOVE` clears a value. The platform's own endpoints keep null as "clear"]
4. **MEMBER_LINK:** [Split into CLIENT_LINK and GROUP_LINK as in item 2 of the proposed build, keeping MEMBER_LINK as an accepted input name]
5. **Unique NUMBER fields:** the reference platform allows unique values on FREE_TEXT only. [Keep NUMBER as well; it takes nothing away]
6. **Transfers:** keep the `internal` channel's fields on transfers as well as the new transactions-by-type fields? [Transactions by type only for transfers, with the `internal` channel's existing definitions moved to it by the migration]
7. **Configuration as code scope:** the reference platform replaces the configuration of every entity in the file. [Same: entities not in the file are left alone, and those in the file are replaced]
8. **Who may use configuration as code:** [CREATE_, EDIT_ and DELETE_CUSTOM_FIELD together, as a PUT can do all three]
9. **Left out:** asynchronous PUT with a callback URL (the reference platform's async and callback headers), which the reference platform suggests for over 300 definitions. [Leave it out; PUT runs synchronously]
