# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

```bash
npm install                              # Install dependencies once
npm start                                # Run server on http://localhost:3000
npm run build                            # Run Claude build helper script
```

**Environment Setup:**
- Windows CMD: `set CLAUDE_API_KEY=your_key`
- PowerShell: `$env:CLAUDE_API_KEY = 'your_key'`

The API key is required for the Claude build helper to function.

## Architecture Overview

### Two-Tier Stack

**Backend (server.js):** Express.js REST API with 50+ endpoints covering:
- Core financial entities: members/clients, loans, deposit accounts (savings), transactions
- Reference data: branches, centres, groups, currencies, users, products, charges
- Advanced: notifications, workflows, background processes, audit logs, documents
- Reporting: trial balance, balance sheet, income statement, loan portfolio
- Financial calculations: interest accrual, loan recovery rate, balance tracking

**Frontend (app.js + index.html):** Vanilla JavaScript SPA (Single Page Application) with:
- Dashboard overview cards (total members, loans, savings, recovery rate)
- Sortable/searchable tables for members, loans, savings
- Sidebar navigation with collapsible sections
- Dark theme using CSS variables
- Real-time data binding via fetch-based API calls

### Data Flow

```
index.html (renders UI)
    ↓
app.js (initData → fetches from /api/overview, /api/members, etc.)
    ↓
server.js (in-memory data store — objects defined at startup)
    ↓
JSON responses (Mambu-style field names: clientId, displayName, productTypeKey)
```

### In-Memory Data Model

The backend maintains data structures for:
- **members**: Array of {id, firstName, lastName, joinDate, status, ...}
- **loans**: Array of {id, memberId, principal, duration, status, ...}
- **depositAccounts**: Savings accounts with balance and transaction history
- **transactions**: Account activity log
- **referenceData**: branches, centres, groups, currencies, users, GL accounts, products, charges

No database—restart loses unsaved changes. This is by design for rapid iteration.

## File Purposes

| File | Purpose |
|------|---------|
| **server.js** | Express app; 50+ API routes; in-memory data initialization; CORS enabled |
| **app.js** | Frontend initialization; data fetching; DOM binding; table rendering & search |
| **api-init.js** | Secondary frontend API layer; data synchronization helpers |
| **index.html** | Dark-themed dashboard layout; sidebar nav; data containers; inline styles |
| **style.css** | CSS variables for theming; layout; responsive utilities |
| **claude-build.js** | Build script (uses Claude API to process data) |
| **package.json** | Dependencies: express, cors, @anthropic-ai/sdk |

## API Contract

### Response Conventions

- **Member/Client fields:** `clientId`, `displayName`, `dateOfBirth`, `idNumber`, `mobilePhone`, `status` (ACTIVE/INACTIVE)
- **Loan fields:** `id`, `memberId`, `principal`, `duration`, `disbursementDate`, `status` (Active/Arrears)
- **Savings fields:** `id`, `memberId`, `balance`, `lastDepositDate`, `accountState`
- **Success:** HTTP 200 with data object or array
- **Errors:** HTTP 400/404/500 with `{error: "message"}`
- **Pagination:** Clients endpoint supports `?page=1&limit=10`
- **Search:** `/search/clients?q=...` and `/search/members?q=...` are case-insensitive substring matches

### Key Endpoint Patterns

**CRUD for entities:**
- `GET /api/{entity}` — List all (some paginated)
- `GET /api/{entity}/{id}` — Single record
- `POST /api/{entity}` — Create (request body = entity data)
- `PUT /api/{entity}/{id}` — Update (request body = updated fields)
- `DELETE /api/{entity}/{id}` — Delete

**Special endpoints:**
- `GET /api/overview` — Dashboard stats (totalMembers, totalLoans, totalSavings, loanRecoveryRate)
- `GET /api/reports/trial-balance` — GL accounting report
- `POST /api/bulk/members` — Batch import
- `POST /api/processes/accrue-interest` — Financial process trigger

## UI State & Bindings

The frontend binds to DOM elements by class name or ID:
- `.member-count`, `.loan-total`, `.savings-total` — Overview cards
- `#members-table tbody`, `#loans-table tbody` — Rendered rows
- Search inputs trigger filter on keyup (client-side filtering of loaded data)

Errors are displayed in toast notifications (if implemented) or console. Loading states use disabled buttons during fetch.

## Common Development Tasks

### Add a New API Endpoint

1. Define data structure in server.js (e.g., add to `globalData.loans`)
2. Create route: `app.get('/api/loans', (req, res) => {...})`
3. Return JSON matching expected field names
4. Test via `curl` or Postman
5. Bind in app.js if it needs UI display

### Add a New Dashboard Table

1. Add container in index.html: `<table id="new-table"><tbody></tbody></table>`
2. Fetch data in app.js: `fetch('/api/new-entity').then(r => r.json())`
3. Render rows with template literal: `row.innerHTML = <tr><td>${item.field}</td>...</tr>`
4. Attach event listeners for interactions (click, sort, search)

### Search & Filter

Client-side: Filter loaded data array with `.filter(item => item.name.includes(query))`
Server-side: Use `GET /api/search/clients?q=...` for backend-driven search

### Error Handling

- Wrap fetch in try/catch
- Check response.ok before parsing JSON
- Display errors to user (alert, toast, or status message)
- Log to console for debugging

## Known Limitations & Constraints

- **No authentication:** All endpoints are public; no role-based access control
- **In-memory only:** Data persists only for the session; restart clears everything
- **No validation:** Minimal input validation; assumes client sends correct shapes
- **No transactions:** Financial operations don't lock or roll back atomically
- **No concurrency:** Single server instance; no clustering
- **Shallow search:** Search is substring-based, not full-text; no fuzzy matching

## Testing Strategy

- **Manual:** Open http://localhost:3000 and test workflows (create member → create loan → view dashboard)
- **API:** Use curl or browser DevTools Network tab to inspect request/response
- **Data:** Check globalData objects in server.js during a session to validate state changes
- No automated test suite currently; if adding one, use Jest or Mocha with before/after hooks to reset data

## Next Steps for Persistence

To move beyond in-memory storage:
1. Add a database connection string to .env
2. Replace globalData objects with parameterized queries (SQL or ORM)
3. Add transaction support for financial operations (e.g., debit one account, credit another atomically)
4. Add indexes on frequently searched fields (memberId, clientId, status)
5. Implement soft deletes (status = DELETED) instead of removing records

## Deployment Considerations

- **PORT:** Hardcoded to 3000; change with `PORT=3001 npm start`
- **CORS:** Enabled for localhost; adjust for production domains
- **API Key:** Store CLAUDE_API_KEY in environment, not in code
- **Node Version:** Tested on Node 18+; check engines in package.json
- **Dependencies:** Keep @anthropic-ai/sdk, express, cors pinned to safe versions
