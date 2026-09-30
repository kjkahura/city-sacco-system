# Build log: Code refactoring

Done on 29 September 2026 at John's request ("do a code refactoring"), with the four scopes he chose: shared helpers, one audit log helper, splitting the large domain files, and splitting the console. Nothing a user or an API client sees changed. The work is four commits on main, each named "Refactor: …", on the device and not pushed.

## Rule for every phase

- Behaviour stays the same: the same routes, responses, status codes, SQL, audit rows and console screens.
- The migrations, the API and the database are untouched.
- All 44 suites, 3,069 checks, pass after each phase in both UTC and Africa/Nairobi.

## Phase 1: shared helpers

- **`src/lib/handlers.js`:**
  - `handle(fn, options)` opens the tenant transaction (or a read-only one), calls the handler with `(c, req, res, ctx)` and sends the reply;
  - presets `run`, `json`, `tx`, `read` and `plain` cover the variants the route files had written out themselves;
  - `pagingHeaders()` sets the paging headers for `?paginationDetails=ON`.
- **25 route files** use it instead of their own wrappers. `auth.js` and `reports.js` keep their own flow.
- **`src/lib/errors.js`:** `err(message, status = 400)`, defined once; 23 files import it.
- **`src/lib/dates.js`:** `localDay` and `utcDay`, defined once; 9 files import them.
- Imports that nothing used any more were removed.

## Phase 2: one audit log helper

- **`src/lib/auditLog.js`:** `recordAudit(c, { actor, action, entity, entityId, before, after })` is the only code that inserts into `audit_log`.
- **Callers:** the 109 inline inserts in the domain, route, auth and ops modules call it with the same values. The chart of accounts keeps its local `audit()`, which now calls `recordAudit`.
- **Unchanged:** the trigger from migration 042 still fills the links, IP address and channel.

## Phase 3: large domain files as folders

Each file becomes a folder with an `index.js` that rebuilds the module's exports, so `require('./savings')`, `require('./loans')` and `require('./dataImport')` resolve as before.

| Folder | Parts, in layer order |
|---|---|
| `src/domain/savings/` (was 1,975 lines) | core, funds, interest, transactions, reversals, terms, lifecycle, daily (the end of day) |
| `src/domain/loans/` (was 969 lines) | core, disbursement, repayment, reversals |
| `src/domain/dataImport/` (was 1,341 lines) | definitions, parse, execute, workbooks, lifecycle |

- **Mechanics:**
  - the parts were cut by a script at the files' own section boundaries;
  - a name from another part is read as `part.name`. Which name refers to which binding was resolved with a scope analyser, so a local of the same name was left alone.
- **Moves to keep the layers one way:** in savings, `repriceFloor` and the day helpers moved into core, `accountTerms` into terms, and `endOfDay` into its own part, daily.
- **Tests:**
  - `loan-structure.test.js` checks that the domain require graph has no cycles, and it now covers the parts too;
  - that test reads a folder module as one module, both for the loans layer rule and for the product-type check.
- **A defect found while splitting and fixed before the commit:** in the data import, a local variable `sheets` in the template workbook had the same name as a part. The part is named `definitions`.

## Phase 4: the console as ES modules

- **Layout:** `public/app.js` (5,643 lines) becomes `public/js/`, with 29 modules:
  - `base.js`: state, DOM helpers and the API client;
  - `session.js`, `ui.js`, `nav.js` (the page table and `go`/`render`) and `access.js`;
  - one module per page or record;
  - `main.js`, the entry module, which wires the sign-in form and the navigation and resumes a session.
- **Loading:**
  - `index.html` loads `js/main.js` with `type="module"`;
  - there is still no build step, and the CSP (`script-src 'self'`) is unchanged.
- **Mechanics:**
  - the code is as it was written;
  - a top-level name another module uses is exported, and each module imports what it uses.
- **Checks on the result:**
  - every import is exported by its target;
  - no module is left with a free name other than a browser global;
  - no module reads another module's constant while it loads.
- **`console.test.js`:** it opens a member or loan page through the module (`import('/console/js/members.js')`), where it used to call a global.

## Documentation

`README.md` lists the new helpers, the three domain folders and the console modules in its layout section.

## Left as it was

- **Large single functions:** `loanDetail` in the console (760 lines), `memberDetail` (270 lines) and the data import's `execute` (400 lines) are each still one function. Splitting them means changing their internals, which this refactoring did not do.
- **The member portal (`portal/`)** is still two classic scripts.
