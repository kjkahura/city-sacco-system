# City SACCO System

This project includes the uploaded City SACCO management platform UI and a backend API server.

## What is included

- `index.html` — dashboard UI from the uploaded SACCO platform design
- `api-init.js` — frontend API hydration and UI data synchronization
- `server.js` — Express backend with full SACCO API routes
- `package.json` — Node.js dependencies and start script

## How to run

1. Install Node.js if it is not already installed.
2. In the project folder, install dependencies:
   ```bash
   npm install
   ```
3. Set your Claude API key in the environment:
   ```bash
   set CLAUDE_API_KEY=your_claude_api_key
   ```
   or in PowerShell:
   ```powershell
   $env:CLAUDE_API_KEY = 'your_claude_api_key'
   ```
4. Start the app:
   ```bash
   npm start
   ```
5. Run the Claude build helper:
   ```bash
   npm run build
   ```
6. Open the dashboard in your browser:
   ```
   http://localhost:3000
   ```

## Available API endpoints

### Core Entities
- `GET /api/overview`
- `GET /api/clients` (paginated, searchable)
- `GET /api/clients/{clientId}`
- `POST /api/clients`
- `PUT /api/clients/{clientId}`
- `DELETE /api/clients/{clientId}`
- `GET /api/loans`
- `GET /api/loans/{loanId}`
- `POST /api/loans`
- `PUT /api/loans/{loanId}`
- `DELETE /api/loans/{loanId}`
- `GET /api/deposit-accounts`
- `GET /api/deposit-accounts/{accountId}`
- `POST /api/deposit-accounts`
- `PUT /api/deposit-accounts/{accountId}`
- `DELETE /api/deposit-accounts/{accountId}`

### Administration
- `GET /api/users`
- `POST /api/users`
- `PUT /api/users/{email}`
- `DELETE /api/users/{email}`
- `GET /api/gl-accounts`
- `POST /api/gl-accounts`
- `PUT /api/gl-accounts/{code}`
- `DELETE /api/gl-accounts/{code}`
- `GET /api/loan-products`
- `POST /api/loan-products`
- `PUT /api/loan-products/{id}`
- `DELETE /api/loan-products/{id}`
- `GET /api/savings-products`
- `POST /api/savings-products`
- `PUT /api/savings-products/{id}`
- `DELETE /api/savings-products/{id}`
- `GET /api/share-products`
- `POST /api/share-products`
- `PUT /api/share-products/{id}`
- `DELETE /api/share-products/{id}`
- `GET /api/charges`
- `POST /api/charges`
- `PUT /api/charges/{name}`
- `DELETE /api/charges/{name}`
- `GET /api/branches`
- `POST /api/branches`
- `PUT /api/branches/{id}`
- `DELETE /api/branches/{id}`
- `GET /api/centres`
- `POST /api/centres`
- `PUT /api/centres/{id}`
- `DELETE /api/centres/{id}`
- `GET /api/groups`
- `POST /api/groups`
- `PUT /api/groups/{id}`
- `DELETE /api/groups/{id}`
- `GET /api/currencies`
- `POST /api/currencies`
- `PUT /api/currencies/{code}`
- `DELETE /api/currencies/{code}`
- `GET /api/transactions`
- `POST /api/transactions`
- `PUT /api/transactions/{id}`
- `DELETE /api/transactions/{id}`
- `GET /api/cards`
- `POST /api/cards`
- `PUT /api/cards/{id}`
- `DELETE /api/cards/{id}`

### Advanced Features
- `GET /api/notifications`
- `POST /api/notifications`
- `PUT /api/notifications/{id}/read`
- `GET /api/background-processes`
- `POST /api/background-processes/{id}/run`
- `GET /api/documents`
- `POST /api/documents`
- `GET /api/workflows`
- `POST /api/workflows/{id}/advance`
- `GET /api/audit-logs`
- `GET /api/reports/loan-portfolio`
- `GET /api/reports/member-engagement`
- `POST /api/bulk/members`
- `POST /api/processes/accrue-interest`

### Configuration & Metadata
- `GET /api/kyc-fields`
- `GET /api/custom-fields`
- `GET /api/reports/trial-balance`
- `GET /api/reports/balance-sheet`
- `GET /api/reports/income-statement`
- `GET /api/search/clients?q=...`
- `GET /api/search/members?q=...`

## Notes

- The `/api/clients`, `/api/loans`, and `/api/deposit-accounts` endpoints now support full create/update/delete operations for demo data.
- Responses use Mambu-style field names such as `clientId`, `displayName`, `accountHolderType`, `productTypeKey`, and `accountState`.
- Created REST-like resource endpoints for clients, loans, deposit accounts, branches, centres, groups, transactions, and cards.
- The backend still uses in-memory demo data, but the response shape is now closer to Mambu API conventions.
- The frontend uses the uploaded HTML page layout and loads data from the backend with `api-init.js`.
- The backend stores in-memory demo data for the dashboard, loans, savings, members, products, and reports.
- If you want, I can continue by wiring the form inputs to API POST/PUT requests and adding persistent storage.
