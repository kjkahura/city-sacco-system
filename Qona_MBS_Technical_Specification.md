# Qona DT SACCO Mobile Banking System — Technical Specification

**Document Version:** 1.0  
**Date Created:** 2026-05-12  
**Status:** Foundation Planning  

---

## 1. System Architecture Overview

### 1.1 Architecture Pattern
**Two-Tier Stack** (similar to City SACCO System):
- **Backend:** Express.js REST API with 70+ endpoints
- **Frontend:** Vanilla JavaScript SPA (or modern framework)
- **Data Store:** Transition from in-memory → database (PostgreSQL recommended)

### 1.2 High-Level Flow
```
Mobile App (iOS/Android or Web Browser)
    ↓
Frontend SPA (index.html + app.js)
    ↓
Express.js REST API (server.js)
    ↓
Database (PostgreSQL) + External Integrations
    ↓
Core Banking System, M-Pesa, Airtel Money, PesaLink, KPLC, etc.
```

---

## 2. Core Data Models

### 2.1 Member/User Entity
```
members {
  id: UUID (primary key)
  firstName: string
  lastName: string
  dateOfBirth: date
  idNumber: string (unique, encrypted)
  mobilePhone: string (unique, encrypted)
  email: string
  nextOfKin: string
  address: string
  status: enum (ACTIVE, INACTIVE, SUSPENDED)
  kycStatus: enum (PENDING, VERIFIED, REJECTED)
  joinDate: timestamp
  lastLoginDate: timestamp
  createdAt: timestamp
  updatedAt: timestamp
}
```

### 2.2 Account Entity (BOSA, Savings, Shares, etc.)
```
accounts {
  id: UUID
  memberId: UUID (foreign key)
  accountType: enum (BOSA, SAVINGS, SHARE_CAPITAL, DIVIDEND, LOAN)
  accountNumber: string (unique)
  balance: decimal (with 2 decimal places)
  accountState: enum (ACTIVE, INACTIVE, FROZEN, CLOSED)
  currency: string (default: KES)
  interestRate: decimal (if applicable)
  lastDepositDate: timestamp
  lastWithdrawalDate: timestamp
  createdAt: timestamp
  updatedAt: timestamp
}
```

### 2.3 Loan Entity
```
loans {
  id: UUID
  memberId: UUID
  principal: decimal
  disbursedAmount: decimal
  outstandingBalance: decimal
  interestRate: decimal
  duration: integer (months)
  disbursementDate: date
  maturityDate: date
  status: enum (PENDING, ACTIVE, ARREARS, SETTLED, DEFAULTED)
  productType: string (e.g., "Personal Loan", "Emergency Loan")
  guarantors: array of UUID (member IDs)
  isTopUpEligible: boolean
  documents: array (application, statement, guarantee letter)
  createdAt: timestamp
  updatedAt: timestamp
}
```

### 2.4 Transaction Entity
```
transactions {
  id: UUID
  fromAccountId: UUID
  toAccountId: UUID (nullable for external withdrawals)
  transactionType: enum (DEPOSIT, WITHDRAWAL, TRANSFER, LOAN_REPAYMENT, PURCHASE, DIVIDEND_PAYOUT)
  amount: decimal
  currency: string
  description: string
  referenceNumber: string (unique, for reconciliation)
  externalReference: string (M-Pesa txn ID, etc.)
  channel: enum (MOBILE_APP, USSD, BRANCH, ATM, WHATSAPP)
  status: enum (PENDING, SUCCESS, FAILED, REVERSED)
  balanceAfter: decimal (snapshot)
  timestamp: timestamp
  metadata: JSON (charges, fees, balance impact)
  createdAt: timestamp
}
```

### 2.5 Beneficiary Entity
```
beneficiaries {
  id: UUID
  memberId: UUID
  name: string
  accountType: enum (INTERNAL_MEMBER, EXTERNAL_BANK, MOBILE_MONEY)
  accountNumber: string (encrypted)
  bank: string (nullable)
  bankCode: string (nullable)
  mobileNetwork: string (nullable, e.g., "SAFARICOM", "AIRTEL")
  relationship: string (spouse, child, parent, etc.)
  dailyLimit: decimal (optional)
  isVerified: boolean
  createdAt: timestamp
  updatedAt: timestamp
}
```

### 2.6 Shares Entity
```
shares {
  id: UUID
  memberId: UUID
  accountId: UUID
  quantity: integer
  purchasePrice: decimal (per share at time of purchase)
  currentValue: decimal (market value)
  totalValue: decimal (quantity × currentValue)
  purchaseDate: timestamp
  createdAt: timestamp
}

shareMarket {
  id: UUID
  date: date
  sharePrice: decimal (current market price)
  previousPrice: decimal
  dayChange: decimal
  percentChange: decimal
  tradingVolume: integer
  buyOffers: array (price, quantity, memberID)
  sellOffers: array (price, quantity, memberID)
}
```

### 2.7 Loan Application Workflow
```
loanApplications {
  id: UUID
  memberId: UUID
  applicationDate: timestamp
  productType: string
  requestedAmount: decimal
  status: enum (DRAFT, SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, DISBURSED)
  creditScore: decimal (from CRB or internal scoring)
  approvedAmount: decimal
  approvalDate: timestamp
  approverId: UUID (staff member)
  rejectionReason: string (if rejected)
  documents: array (ID copy, payslip, bank statement)
  guarantors: array of { memberId, status: PENDING/ACCEPTED/DECLINED }
  createdAt: timestamp
  updatedAt: timestamp
}
```

### 2.8 Dividend Entity
```
dividends {
  id: UUID
  memberId: UUID
  declaredDate: date
  paymentDate: date
  amount: decimal
  status: enum (DECLARED, PAID_TO_ACCOUNT, WITHDRAWN, CAPITALIZED_TO_SHARES)
  disbursementMethod: enum (ACCOUNT, WITHDRAWAL, SHARES)
  transactionId: UUID (links to transaction record)
  createdAt: timestamp
}
```

### 2.9 Notification Preference Entity
```
notificationPreferences {
  id: UUID
  memberId: UUID
  channel: enum (SMS, EMAIL, PUSH)
  transactionAlerts: boolean
  loanUpdates: boolean
  shareMarketUpdates: boolean
  dividendNotices: boolean
  promotions: boolean
  createdAt: timestamp
  updatedAt: timestamp
}
```

### 2.10 Audit Log Entity
```
auditLogs {
  id: UUID
  action: string (CREATE, UPDATE, DELETE, LOGIN, APPROVE, REJECT)
  entityType: string (LOAN, ACCOUNT, BENEFICIARY, etc.)
  entityId: UUID
  performedBy: UUID (staff member or system)
  changes: JSON (what changed: { field, oldValue, newValue })
  ipAddress: string
  deviceInfo: string
  timestamp: timestamp
}
```

---

## 3. API Endpoints Structure

### 3.1 Authentication & Session (8 endpoints)
```
POST   /api/auth/register          → Self-service member registration
POST   /api/auth/login             → Login with phone + PIN/biometric
POST   /api/auth/logout            → Logout & clear session
POST   /api/auth/refresh-token     → Refresh JWT token
POST   /api/auth/request-otp       → Request OTP for verification
POST   /api/auth/verify-otp        → Verify OTP (login, password reset)
POST   /api/auth/reset-pin         → Reset PIN via OTP
GET    /api/auth/me                → Get current logged-in member
```

### 3.2 Member/Profile (6 endpoints)
```
GET    /api/members/:id            → Get member profile
PUT    /api/members/:id            → Update profile (phone, email, address, KOK)
GET    /api/members/:id/kyc        → Get KYC status
POST   /api/members/:id/kyc        → Submit KYC documents
GET    /api/members/search         → Search members (for transfers)
GET    /api/members/:id/accounts   → Get all accounts for member
```

### 3.3 Accounts (8 endpoints)
```
GET    /api/accounts               → List all member accounts
GET    /api/accounts/:id           → Get single account details
GET    /api/accounts/:id/balance   → Get current balance
GET    /api/accounts/:id/statement → Get mini-statement (last 10 txns)
POST   /api/accounts/:id/statement/export → Export full statement (PDF)
GET    /api/accounts/:id/transactions → Get transaction history (paginated)
POST   /api/accounts/:id/freeze    → Freeze account (staff only)
DELETE /api/accounts/:id           → Close account (soft delete)
```

### 3.4 Transactions & Transfers (10 endpoints)
```
POST   /api/transactions/transfer           → Internal transfer (member-to-member)
POST   /api/transactions/internal-transfer  → Transfer between own accounts
POST   /api/transactions/deposit            → Initiate M-Pesa deposit (STK Push)
POST   /api/transactions/withdraw           → Initiate withdrawal (M-Pesa B2C, bank)
GET    /api/transactions/:id                → Get transaction details
POST   /api/transactions/:id/receipt        → Generate receipt
POST   /api/transactions/:id/dispute        → Dispute a transaction
POST   /api/transactions/:id/reverse        → Reverse a transaction (staff only)
GET    /api/transactions/limits             → Get member transaction limits
PUT    /api/transactions/limits             → Update limits (staff only)
```

### 3.5 Beneficiaries (6 endpoints)
```
GET    /api/beneficiaries                   → List all beneficiaries
POST   /api/beneficiaries                   → Add beneficiary
GET    /api/beneficiaries/:id               → Get beneficiary details
PUT    /api/beneficiaries/:id               → Edit beneficiary
DELETE /api/beneficiaries/:id               → Delete beneficiary
POST   /api/beneficiaries/:id/verify        → Verify beneficiary (OTP)
```

### 3.6 Loans (12 endpoints)
```
GET    /api/loans                           → List member's loans
POST   /api/loans/apply                     → Submit loan application
GET    /api/loans/:id                       → Get loan details
GET    /api/loans/:id/statement             → Get loan statement (amortization)
POST   /api/loans/:id/repay                 → Make loan repayment
POST   /api/loans/:id/top-up                → Apply for loan top-up
POST   /api/loans/:id/restructure           → Restructure loan (extend tenure)
POST   /api/loans/:id/early-settlement      → Settle early (with interest calc)
POST   /api/loans/:id/guarantor-request     → Send guarantor request
GET    /api/loans/:id/guarantor-requests    → Get guarantor requests
POST   /api/loans/:id/guarantor-requests/:gid/accept   → Accept guarantee
POST   /api/loans/:id/guarantor-requests/:gid/decline  → Decline guarantee
GET    /api/loans/guaranteed                → Get loans where member is guarantor
```

### 3.7 Shares & Dividends (10 endpoints)
```
GET    /api/shares/portfolio                → Get member's share holdings
GET    /api/shares/market                   → Get current share price & market data
POST   /api/shares/buy                      → Buy shares from market or SACCO
POST   /api/shares/:id/sell                 → Sell shares on marketplace
GET    /api/shares/orders                   → Get pending buy/sell orders
DELETE /api/shares/orders/:id               → Cancel pending order

GET    /api/dividends                       → Get dividend history
GET    /api/dividends/:id                   → Get dividend details
POST   /api/dividends/:id/capitalize        → Capitalize dividend to shares
POST   /api/dividends/:id/withdraw          → Withdraw dividend to account
```

### 3.8 Bill Payments & Utilities (8 endpoints)
```
POST   /api/bills/kplc                      → Pay KPLC (prepaid/postpaid)
POST   /api/bills/water                     → Pay water bill
POST   /api/bills/tv                        → Pay DStv/GOtv/Zuku
POST   /api/bills/internet                  → Pay internet bill
POST   /api/airtime/buy                     → Buy airtime (Safaricom, Airtel, Telkom)
POST   /api/data/buy                        → Buy data bundle
POST   /api/merchant/paybill                → M-Pesa Paybill payment
POST   /api/merchant/till                   → M-Pesa Buy Goods (Till) payment
```

### 3.9 WhatsApp Banking (5 endpoints)
```
POST   /api/whatsapp/webhook                → Receive messages from WhatsApp
POST   /api/whatsapp/send                   → Send response to WhatsApp
GET    /api/whatsapp/balance                → Balance inquiry via WhatsApp
POST   /api/whatsapp/authenticate           → OTP authentication for WhatsApp
GET    /api/whatsapp/supported-commands     → List available WhatsApp commands
```

### 3.10 Notifications (6 endpoints)
```
GET    /api/notifications                   → Get notification history
GET    /api/notifications/preferences       → Get notification settings
PUT    /api/notifications/preferences       → Update notification settings
POST   /api/notifications/test              → Send test notification
DELETE /api/notifications/:id               → Mark notification as read
POST   /api/notifications/subscribe-push    → Register device for push notifications
```

### 3.11 Support & Help (4 endpoints)
```
GET    /api/support/faq                     → Get FAQ list
POST   /api/support/ticket                  → Create support ticket
GET    /api/support/tickets/:id             → Get ticket status
POST   /api/support/chat                    → Start chat with support (WebSocket)
```

### 3.12 Admin Dashboard (10 endpoints — staff only)
```
GET    /api/admin/dashboard                 → Dashboard stats (volumes, failed txns, system health)
GET    /api/admin/transactions              → All transactions (with filters)
GET    /api/admin/members                   → All members (with search)
GET    /api/admin/loans/pending-approval    → Loans awaiting approval
POST   /api/admin/loans/:id/approve         → Approve loan
POST   /api/admin/loans/:id/reject          → Reject loan
GET    /api/admin/audit-log                 → Immutable audit trails
POST   /api/admin/reports/custom            → Generate custom report
GET    /api/admin/system-health             → System health & monitoring
```

---

## 4. Frontend UI Modules

### 4.1 Authentication Screens
- [ ] Login (phone, PIN/biometric)
- [ ] Registration (self-service, 3-step)
- [ ] Forgot PIN/Password (OTP recovery)
- [ ] 2FA Challenge (OTP verification)

### 4.2 Dashboard
- [ ] 6 Overview Cards: Total Balance, Total Loans, Share Holdings, Pending Loans, Available Limit, Account Health
- [ ] Quick Actions (Transfer, Deposit, Pay Bill, Buy Airtime)
- [ ] Recent Transactions (last 5)
- [ ] Alerts & Notifications

### 4.3 Accounts Section
- [ ] Account List (BOSA, Savings, Shares, Loan accounts)
- [ ] Account Details & Mini-Statement
- [ ] Full Statement Export (PDF)
- [ ] Transaction History (with search/filter)

### 4.4 Transfers & Payments
- [ ] Transfer Wizard (beneficiary selection, amount, confirmation, receipt)
- [ ] Internal Transfer (between own accounts)
- [ ] Bill Payment Portal (KPLC, Water, TV, Internet)
- [ ] Airtime & Data (Safaricom, Airtel, Telkom)
- [ ] M-Pesa Merchant Payments

### 4.5 Loans Section
- [ ] Loan List (active, pending, settled)
- [ ] Loan Application Wizard
- [ ] Loan Details & Statement (amortization schedule)
- [ ] Loan Repayment Form
- [ ] Guarantor Requests (accept/decline)
- [ ] Loan Top-Up & Restructuring

### 4.6 Shares & Dividends
- [ ] Share Portfolio (holdings, valuation, performance)
- [ ] Share Market View (price chart, buy/sell offers)
- [ ] Share Purchase/Sale Flow
- [ ] Dividend History & Actions (capitalize, withdraw)

### 4.7 Beneficiaries
- [ ] Beneficiary List
- [ ] Add/Edit Beneficiary Form
- [ ] Verification Process

### 4.8 Notifications & Preferences
- [ ] Notification History
- [ ] Preference Settings (SMS, Email, Push, by category)

### 4.9 Profile & Security
- [ ] Profile View/Edit (name, phone, email, address, KOK)
- [ ] Change PIN/Password
- [ ] Device Management (linked devices, security)
- [ ] Session Management

### 4.10 Support
- [ ] FAQ Section
- [ ] Support Ticket Submission
- [ ] Live Chat (WebSocket)

### 4.11 Admin Dashboard (for SACCO staff)
- [ ] Transaction Dashboard
- [ ] Member Management
- [ ] Loan Approval Queue
- [ ] Audit Logs
- [ ] System Health Monitoring

---

## 5. External Integrations

### 5.1 Payment Channels
| Integration | Use Case | Type |
|------------|----------|------|
| M-Pesa STK Push | Deposits | API |
| M-Pesa B2C | Withdrawals | API |
| M-Pesa Buy Goods | Merchant payments | API |
| M-Pesa Paybill | Utility payments, loans | API |
| Airtel Money B2C | Withdrawals | API |
| PesaLink | Bank transfers | File-based |
| EFT/RTGS | Bank transfers | File-based |

### 5.2 Billers
- KPLC (Kenya Power & Lighting) — Prepaid & Postpaid
- Water Authority (regional)
- DStv/GOtv/Zuku — Pay TV
- Internet Service Providers

### 5.3 Telcos (Airtime & Data)
- Safaricom (SMS/HTTP API)
- Airtel (SMS/HTTP API)
- Telkom (SMS/HTTP API)

### 5.4 Core Banking
- Member/account data sync
- Transaction settlement
- Interest accrual posting

### 5.5 Compliance & Risk
- Credit Reference Bureau (CRB) — Credit scoring
- Kenya Data Protection Act (KDPA) — Data handling
- AML/CFT monitoring — Large transaction flagging

### 5.6 Communication
- SMS Gateway (Twilio, AfricasTalking, Pesapal)
- Email Service (SendGrid, AWS SES)
- Push Notifications (Firebase Cloud Messaging, Apple Push)
- WhatsApp Business API

---

## 6. Security & Authentication

### 6.1 Authentication Layers
1. **PIN-based Login** (4-6 digit code)
2. **Biometric Authentication** (Fingerprint, Face ID)
3. **2FA (OTP)** for high-value transactions (SMS/Email)
4. **Device Binding** (IMSI/IMEI locking)
5. **Session Token** (JWT with 15-30 min expiry)

### 6.2 Anti-Fraud
- SIM-swap detection (block transactions if IMSI changes)
- Unusual activity detection (velocity checks, location)
- Transaction limits (daily, per-transaction)
- Maker-checker workflow (approval required for exceptions)

### 6.3 Encryption
- **Transport:** TLS 1.2+ for all API calls
- **Data at Rest:** Sensitive fields encrypted (ID numbers, phone, account numbers)
- **End-to-End:** E2E encryption for WhatsApp channel

### 6.4 Compliance
- Kenya Data Protection Act (KDPA) compliance (consent, data retention, deletion)
- Audit trails (immutable logs of all actions: User, Timestamp, IP, Device, Action)
- Password reset & session management
- Secure logout

---

## 7. Database & Persistence

### 7.1 Recommended Tech Stack
- **Database:** PostgreSQL (relational, strong ACID compliance for financial data)
- **ORM:** Sequelize or TypeORM (Node.js compatible)
- **Redis:** Caching (session store, rate limiting, real-time data)
- **Message Queue:** RabbitMQ or Bull (background jobs: interest accrual, dividend processing)

### 7.2 Key Indexes
- `members.mobilePhone` (unique, for login)
- `members.idNumber` (unique, encrypted)
- `accounts.memberId, accountType` (account lookup)
- `loans.memberId, status` (member loan lookup)
- `transactions.fromAccountId, toAccountId, timestamp` (statement queries)
- `transactions.status, externalReference` (reconciliation)

### 7.3 Data Retention Policy
- **Transactions:** Retain indefinitely (immutable)
- **Audit logs:** Retain 7 years (regulatory requirement)
- **Failed transactions:** Retain 1 year (for disputes)
- **Deleted accounts:** Soft delete, archive after 2 years

---

## 8. Deployment & Environment

### 8.1 Environment Variables
```
NODE_ENV=production
PORT=3001
DB_HOST=<postgres-host>
DB_USER=<user>
DB_PASSWORD=<password>
DB_NAME=qona_mbs
REDIS_URL=<redis-connection>
TWILIO_ACCOUNT_SID=<sid>
TWILIO_AUTH_TOKEN=<token>
MPESA_CONSUMER_KEY=<key>
MPESA_CONSUMER_SECRET=<secret>
MPESA_SHORTCODE=<shortcode>
JWT_SECRET=<secret>
WHATSAPP_PHONE_NUMBER_ID=<id>
WHATSAPP_ACCESS_TOKEN=<token>
```

### 8.2 Deployment Target
- **Server:** AWS EC2, DigitalOcean, or on-premise
- **Database:** RDS PostgreSQL or self-managed
- **CDN:** CloudFront for static assets
- **Monitoring:** CloudWatch, Datadog, or New Relic
- **Backup:** Daily automated backups, 30-day retention

---

## 9. Development Phases

### Phase 1: Core Foundations (Weeks 1-2)
- [ ] Database schema setup
- [ ] Authentication (login, registration, OTP)
- [ ] Member profile management
- [ ] API foundation (Express, error handling, middleware)

### Phase 2: Account & Balance (Weeks 2-3)
- [ ] Account management
- [ ] Balance inquiry
- [ ] Transaction history & statements
- [ ] Mini-statement & PDF export

### Phase 3: Transfers & Payments (Weeks 3-4)
- [ ] Internal transfers
- [ ] External transfers (beneficiaries)
- [ ] M-Pesa integration (deposits/withdrawals)
- [ ] Bill payments & airtime

### Phase 4: Loans (Weeks 4-5)
- [ ] Loan application & approval workflow
- [ ] Loan management & repayment
- [ ] Guarantor functionality
- [ ] CRB integration for credit scoring

### Phase 5: Advanced Features (Weeks 5-6)
- [ ] Share market & dividends
- [ ] WhatsApp banking
- [ ] Notifications & preferences
- [ ] Admin dashboard

### Phase 6: Security & Testing (Week 6+)
- [ ] 2FA & biometric
- [ ] SIM-swap detection
- [ ] Comprehensive testing (unit, integration, security)
- [ ] Performance optimization

---

## 10. Success Metrics & Verification

### 10.1 Functional Verification
- [ ] All 14 functional modules implemented
- [ ] All 70+ API endpoints working
- [ ] All UI screens present and functional
- [ ] External integrations tested (M-Pesa, Airtel, PesaLink)

### 10.2 Non-Functional Requirements
- [ ] 99.9% system availability
- [ ] API response time <500ms (p95)
- [ ] Database query time <200ms (p95)
- [ ] Transaction processing <3 seconds end-to-end

### 10.3 Security Checklist
- [ ] Biometric + PIN authentication working
- [ ] 2FA enabled for high-value transactions
- [ ] SIM-swap detection active
- [ ] TLS encryption on all channels
- [ ] KDPA compliance verified
- [ ] Audit logs immutable and complete

### 10.4 Compliance
- [ ] 24/7 support channels (chat, email, call)
- [ ] Maker-checker workflow for approvals
- [ ] 15% performance bond in place
- [ ] 12-month warranty period
- [ ] 6-week delivery deadline

---

## 11. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| M-Pesa API downtime | Deposits/withdrawals blocked | Fallback to USSD, manual entry |
| Database corruption | Data loss | Daily backups, point-in-time recovery |
| Security breach | Member data exposed | Encryption, audit logs, incident response plan |
| High concurrency (peak hours) | Slow transactions | Connection pooling, caching, horizontal scaling |
| Regulatory changes | Compliance violation | Regular legal review, flexible architecture |

---

**Next Steps:**
1. Review and refine this specification with stakeholders
2. Create detailed ERD (Entity Relationship Diagram)
3. Design UI mockups/wireframes
4. Set up development environment (PostgreSQL, Redis, Node.js)
5. Begin Phase 1 implementation (core foundations)
