# Database Schema Documentation

**Document Version:** 1.0  
**Last Updated:** 2026-05-12  
**Status:** Complete (9 core models)

---

## Overview

The Qona MBS database is designed using PostgreSQL with Sequelize ORM. It follows a relational model with proper normalization, constraints, and indexes for performance.

**Technology Stack:**
- Database: PostgreSQL 12+
- ORM: Sequelize 6+
- Migrations: Sequelize CLI

---

## Entity Relationship Diagram (ERD)

```
┌─────────────────────────────────────────────────────────────────┐
│                          MEMBERS                                 │
│  (User accounts, authentication, KYC status, device binding)     │
└────────┬──────────────────────────────────────────────────────┬──┘
         │                                                       │
    ┌────▼────────────────┐    ┌────────────────────────────────▼─┐
    │     ACCOUNTS        │    │  NOTIFICATION_PREFERENCES        │
    │ (BOSA, Savings,     │    │  (SMS, Email, Push, Categories) │
    │  Shares, Loans)     │    └──────────────────────────────────┘
    └────┬────────────────┘
         │
    ┌────▼──────────────┐
    │   TRANSACTIONS    │
    │ (All account flow)│
    └───────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        LOANS                                     │
│  (Loan products, applications, repayment, guarantors)           │
├─────────────────────────────────────────────────────────────────┤
│  - Links to MEMBERS (borrower)                                  │
│  - Links to ACCOUNTS (loan account)                             │
│  - Can have multiple GUARANTORS (other MEMBERS)                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     BENEFICIARIES                                │
│  (Internal members, bank accounts, mobile money)                │
├─────────────────────────────────────────────────────────────────┤
│  - Links to MEMBERS (owner)                                     │
│  - Can link to another MEMBER (internal transfer)               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        SHARES                                    │
│  (Share holdings, trading, valuation)                           │
├─────────────────────────────────────────────────────────────────┤
│  - Links to MEMBERS (owner)                                     │
│  - Links to ACCOUNTS (share capital account)                    │
│  - Links to TRANSACTIONS (purchase/sale record)                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      DIVIDENDS                                   │
│  (Dividend declarations, payments, capitalization)             │
├─────────────────────────────────────────────────────────────────┤
│  - Links to MEMBERS (recipient)                                 │
│  - Links to ACCOUNTS (payout account)                           │
│  - Links to TRANSACTIONS (payout record)                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      AUDIT_LOGS                                  │
│  (Immutable action logs for compliance, security)               │
├─────────────────────────────────────────────────────────────────┤
│  - Links to MEMBERS (who performed action)                      │
│  - Tracks all CREATE, UPDATE, DELETE, LOGIN, APPROVE, etc.     │
│  - Never deleted (7-year retention)                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Entities

### 1. MEMBERS Table

**Purpose:** User accounts, authentication, KYC status, device binding for security

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Unique member identifier |
| firstName | VARCHAR(100) | NOT NULL | First name |
| lastName | VARCHAR(100) | NOT NULL | Last name |
| dateOfBirth | DATE | NOT NULL | For KYC, age calculation |
| idNumber | VARCHAR(50) | UNIQUE, NOT NULL | National ID (encrypted) |
| mobilePhone | VARCHAR(20) | UNIQUE, NOT NULL | Login phone number (encrypted) |
| email | VARCHAR(150) | UNIQUE | Email address |
| nextOfKin | VARCHAR(150) | | Next of kin name |
| address | TEXT | | Full address |
| pin | VARCHAR(255) | NOT NULL | Hashed PIN (bcrypt) |
| status | ENUM | ACTIVE/INACTIVE/SUSPENDED/CLOSED | Account status |
| kycStatus | ENUM | PENDING/VERIFIED/REJECTED | KYC verification |
| joinDate | DATE | DEFAULT NOW | When member joined |
| lastLoginDate | DATE | | Last login timestamp |
| deviceId | VARCHAR(255) | | Device identifier for binding |
| imsi | VARCHAR(20) | | SIM IMSI for SIM-swap detection |
| imei | VARCHAR(20) | | Device IMEI |
| twoFactorEnabled | BOOLEAN | DEFAULT false | 2FA status |
| biometricEnabled | BOOLEAN | DEFAULT false | Biometric auth status |
| dailyTransactionLimit | DECIMAL(15,2) | DEFAULT 500000 | Daily limit in KES |
| deletedAt | DATE | | Soft delete timestamp |

**Indexes:**
- mobilePhone (unique, for login)
- idNumber (unique)
- status
- kycStatus
- createdAt

**Key Relationships:**
- 1 Member → Many Accounts
- 1 Member → Many Loans (as borrower)
- 1 Member → Many Loans (as guarantor)
- 1 Member → Many Beneficiaries
- 1 Member → Many Shares
- 1 Member → Many Dividends
- 1 Member → 1 NotificationPreference

---

### 2. ACCOUNTS Table

**Purpose:** Member accounts (BOSA, Savings, Shares, Loans)

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Account identifier |
| memberId | UUID | FK, NOT NULL | Which member owns this |
| accountNumber | VARCHAR(50) | UNIQUE, NOT NULL | Account number |
| accountType | ENUM | BOSA/SAVINGS/SHARE_CAPITAL/DIVIDEND/LOAN | Account category |
| balance | DECIMAL(15,2) | NOT NULL, DEFAULT 0 | Current balance |
| currency | VARCHAR(3) | DEFAULT KES | Currency code |
| accountState | ENUM | ACTIVE/INACTIVE/FROZEN/CLOSED | Account status |
| interestRate | DECIMAL(5,2) | DEFAULT 0 | Annual interest % |
| lastDepositDate | DATE | | Last deposit timestamp |
| lastWithdrawalDate | DATE | | Last withdrawal timestamp |
| overdraftLimit | DECIMAL(15,2) | DEFAULT 0 | Overdraft allowance |
| monthlyBudget | DECIMAL(15,2) | | Optional budget limit |
| isLinked | BOOLEAN | DEFAULT false | Linked for auto-transfer |

**Indexes:**
- (memberId, accountType) — Quick account lookup by type
- accountNumber (unique)
- accountState

**Key Relationships:**
- N Accounts → 1 Member
- 1 Account → Many Transactions (from/to)
- 1 Account → Many Loans
- 1 Account → Many Shares
- 1 Account → Many Dividends

---

### 3. TRANSACTIONS Table

**Purpose:** All financial activity (deposits, withdrawals, transfers, payments)

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Transaction ID |
| fromAccountId | UUID | FK, NOT NULL | Source account |
| toAccountId | UUID | FK | Destination (null for external) |
| transactionType | ENUM | DEPOSIT, WITHDRAWAL, TRANSFER, LOAN_REPAYMENT, etc. | Type of transaction |
| amount | DECIMAL(15,2) | NOT NULL, MIN 0.01 | Amount transferred |
| currency | VARCHAR(3) | DEFAULT KES | Currency |
| description | TEXT | | Transaction note |
| referenceNumber | VARCHAR(50) | UNIQUE, NOT NULL | Unique ref for tracking |
| externalReference | VARCHAR(100) | | M-Pesa txn ID, bank ref |
| channel | ENUM | MOBILE_APP/WEB/USSD/WHATSAPP/BRANCH/ATM | How transaction initiated |
| status | ENUM | PENDING/SUCCESS/FAILED/REVERSED/DISPUTED | Transaction status |
| balanceAfter | DECIMAL(15,2) | | Balance after transaction |
| fee | DECIMAL(10,2) | DEFAULT 0 | Transaction fee |
| metadata | JSON | | Additional data (charges, etc.) |
| failureReason | TEXT | | Why it failed |
| reversalTransactionId | UUID | FK | Links to reversal txn |

**Indexes:**
- (fromAccountId, createdAt) — Member's transaction history
- referenceNumber (unique, for lookup)
- status
- transactionType
- createdAt

**Immutability:** Once created, transactions are NEVER updated (append-only audit trail)

---

### 4. LOANS Table

**Purpose:** Loan products, applications, approvals, repayment

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Loan identifier |
| memberId | UUID | FK, NOT NULL | Which member borrowed |
| accountId | UUID | FK | Loan account |
| principal | DECIMAL(15,2) | NOT NULL | Original loan amount |
| disbursedAmount | DECIMAL(15,2) | | Amount actually disbursed |
| outstandingBalance | DECIMAL(15,2) | | Amount still owed |
| interestRate | DECIMAL(5,2) | NOT NULL | Annual interest rate |
| duration | INTEGER | NOT NULL, 1-120 | Loan tenure in months |
| disbursementDate | DATE | | When money was disbursed |
| maturityDate | DATE | | When loan is due |
| originalMaturityDate | DATE | | Original due date (if restructured) |
| status | ENUM | PENDING/APPROVED/ACTIVE/ARREARS/SETTLED/DEFAULTED | Loan status |
| productType | VARCHAR(100) | | E.g., Personal Loan, Emergency |
| paidAmount | DECIMAL(15,2) | DEFAULT 0 | Total paid so far |
| interestPaid | DECIMAL(15,2) | DEFAULT 0 | Total interest paid |
| lastPaymentDate | DATE | | Last repayment date |
| nextPaymentDueDate | DATE | | Next payment due |
| isTopUpEligible | BOOLEAN | DEFAULT true | Can member get top-up |
| amortizationSchedule | JSON | | Monthly repayment schedule |
| approvedBy | UUID | FK | Staff who approved |
| approvalDate | DATE | | When approved |
| rejectionReason | TEXT | | If rejected |

**Indexes:**
- (memberId, status) — Member's active loans
- status
- maturityDate

**Key Relationships:**
- N Loans → 1 Member
- 1 Loan → 1 Account (loan account)
- 1 Loan → Many Guarantors (via junction table — to be created)
- 1 Loan → Many Transactions (repayments)

---

### 5. BENEFICIARIES Table

**Purpose:** Transfer recipients (internal members, bank accounts, mobile money)

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Beneficiary ID |
| memberId | UUID | FK, NOT NULL | Who added this beneficiary |
| name | VARCHAR(150) | NOT NULL | Beneficiary name |
| beneficiaryType | ENUM | INTERNAL_MEMBER/EXTERNAL_BANK/MOBILE_MONEY | Type |
| beneficiaryMemberId | UUID | FK | For internal transfers |
| bankName | VARCHAR(100) | | Bank name |
| bankCode | VARCHAR(10) | | Bank code (PesaLink) |
| accountNumber | VARCHAR(50) | | Bank account |
| accountHolderName | VARCHAR(150) | | Account holder name |
| mobileNetwork | ENUM | SAFARICOM/AIRTEL/TELKOM | Mobile network |
| mobilePhoneNumber | VARCHAR(20) | | Mobile number |
| relationship | VARCHAR(50) | | Relative, employer, etc. |
| dailyLimit | DECIMAL(15,2) | | Optional transfer limit |
| totalDailyAmount | DECIMAL(15,2) | DEFAULT 0 | Amount transferred today |
| lastTransferDate | DATE | | Last use |
| isVerified | BOOLEAN | DEFAULT false | Verified via OTP |
| verificationDate | DATE | | When verified |
| isActive | BOOLEAN | DEFAULT true | Active status |

**Indexes:**
- memberId
- isVerified
- mobilePhoneNumber / accountNumber (for duplicate detection)

---

### 6. SHARES Table

**Purpose:** Share holdings, trading, valuation

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Share record ID |
| memberId | UUID | FK, NOT NULL | Who owns |
| accountId | UUID | FK | Share account |
| quantity | INTEGER | NOT NULL, MIN 1 | Number of shares |
| purchasePrice | DECIMAL(10,2) | NOT NULL | Price per share at buy |
| totalCost | DECIMAL(15,2) | NOT NULL | Quantity × Purchase Price |
| currentSharePrice | DECIMAL(10,2) | NOT NULL | Current market price |
| totalValue | DECIMAL(15,2) | NOT NULL | Quantity × Current Price |
| gainLoss | DECIMAL(15,2) | | Total Value - Total Cost |
| gainLossPercent | DECIMAL(5,2) | | Percentage gain/loss |
| purchaseDate | DATE | DEFAULT NOW | When purchased |
| purchaseMethod | ENUM | CASH/MPESA/BANK/DIVIDEND_CAP | How purchased |
| transactionId | UUID | FK | Purchase transaction |
| isForSale | BOOLEAN | DEFAULT false | Listed for trading |
| salePrice | DECIMAL(10,2) | | Asking price if for sale |
| quantityForSale | INTEGER | | How many offered for sale |

**Indexes:**
- memberId
- isForSale

**Note:** Share MARKET data (pricing history) would be in a separate `SHARE_MARKET` table (future phase)

---

### 7. DIVIDENDS Table

**Purpose:** Dividend declarations, payments, capitalization to shares

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Dividend record ID |
| memberId | UUID | FK, NOT NULL | Member receiving |
| accountId | UUID | FK | Payout account |
| dividendYear | INTEGER | NOT NULL | Year declared |
| dividendPeriod | VARCHAR(20) | NOT NULL | Q1, Q2, H1, Annual |
| declaredDate | DATE | NOT NULL | Declaration date |
| paymentDate | DATE | | When paid |
| amount | DECIMAL(15,2) | NOT NULL | Dividend amount |
| status | ENUM | DECLARED/APPROVED/PAID/WITHDRAWN/CAPITALIZED | Status |
| disbursementMethod | ENUM | ACCOUNT/WITHDRAWAL/SHARES | How disbursed |
| transactionId | UUID | FK | Payout transaction |
| sharesCreditedQuantity | INTEGER | | Shares if capitalized |
| sharesPurchasePrice | DECIMAL(10,2) | | Price if capitalized to shares |
| processedBy | UUID | FK | Staff who processed |
| processedDate | DATE | | When processed |

**Indexes:**
- memberId
- status
- dividendYear

---

### 8. NOTIFICATION_PREFERENCES Table

**Purpose:** User notification settings (channels, categories, quiet hours)

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Preference record ID |
| memberId | UUID | FK, UNIQUE | One per member |
| smsEnabled | BOOLEAN | DEFAULT true | Enable SMS |
| emailEnabled | BOOLEAN | DEFAULT true | Enable email |
| pushEnabled | BOOLEAN | DEFAULT true | Enable push notifications |
| inAppEnabled | BOOLEAN | DEFAULT true | Enable in-app |
| whatsappEnabled | BOOLEAN | DEFAULT true | Enable WhatsApp |
| transactionAlerts | BOOLEAN | DEFAULT true | Notify on txns |
| loanUpdates | BOOLEAN | DEFAULT true | Notify on loans |
| shareMarketUpdates | BOOLEAN | DEFAULT true | Notify on shares |
| dividendNotices | BOOLEAN | DEFAULT true | Notify on dividends |
| accountAlerts | BOOLEAN | DEFAULT true | Low balance, etc. |
| securityAlerts | BOOLEAN | DEFAULT true | Login, auth failures |
| promotions | BOOLEAN | DEFAULT false | Marketing |
| quietHoursEnabled | BOOLEAN | DEFAULT false | Quiet hours on |
| quietHoursStart | VARCHAR(5) | | HH:MM format (21:00) |
| quietHoursEnd | VARCHAR(5) | | HH:MM format (08:00) |
| preferredPhoneNumber | VARCHAR(20) | | For SMS |
| preferredEmail | VARCHAR(150) | | For emails |

---

### 9. AUDIT_LOGS Table

**Purpose:** Immutable action logs for compliance, security, and debugging

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK | Log ID |
| action | VARCHAR(100) | NOT NULL | CREATE, UPDATE, DELETE, LOGIN, APPROVE |
| entityType | VARCHAR(50) | NOT NULL | LOAN, ACCOUNT, MEMBER, TRANSACTION |
| entityId | UUID | | What entity was affected |
| performedBy | UUID | FK | Who did it |
| performedByRole | VARCHAR(50) | | MEMBER, STAFF, ADMIN, SYSTEM |
| changesJson | JSON | | {field: {oldValue, newValue}} |
| statusBefore | VARCHAR(50) | | Previous status |
| statusAfter | VARCHAR(50) | | New status |
| description | TEXT | | Human-readable summary |
| ipAddress | VARCHAR(45) | | IPv4 or IPv6 |
| userAgent | TEXT | | Browser/app info |
| deviceInfo | VARCHAR(255) | | Device identifier |
| channel | ENUM | MOBILE_APP/WEB/USSD/WHATSAPP/API/SYSTEM | How action initiated |
| result | ENUM | SUCCESS/FAILURE | Did it succeed |
| errorMessage | TEXT | | If failed |
| metadata | JSON | | Additional context |
| timestamp | DATE | NOT NULL | Immutable creation time |

**Key Characteristics:**
- **Immutable:** No updates, no deletes
- **Retention:** 7 years (for regulatory compliance)
- **Comprehensive:** Logs LOGIN, CREATE, UPDATE, DELETE, APPROVE, REJECT, TRANSFER, etc.
- **Traceability:** IP, Device, User Agent, Timestamp, What changed

**Indexes:**
- (entityType, entityId, timestamp)
- performedBy
- action
- timestamp

---

## Key Design Patterns

### 1. Soft Deletes
Members, Accounts use `deletedAt` column instead of hard deletes:
- Record is never actually deleted from database
- Data preserved for audit and history
- Queries use `WHERE deletedAt IS NULL` to exclude deleted records

### 2. Immutable Audit Trail
- AUDIT_LOGS table has NO updates or deletes
- timestamp column is immutable
- Every action logged: WHO, WHAT, WHEN, WHERE, WHY, HOW

### 3. Decimal for Money
- All monetary values use `DECIMAL(15,2)` type (not FLOAT/DOUBLE)
- Ensures accurate financial calculations
- No rounding errors

### 4. UUID Primary Keys
- All tables use UUID (not auto-increment integers)
- Allows distributed systems and prevents ID enumeration
- Improves security

### 5. Timestamps
- `createdAt` — When record created
- `updatedAt` — Last modification (auto-managed by Sequelize)
- `deletedAt` — Soft delete timestamp
- Enables audit trails and data recovery

### 6. Proper Indexing
- Foreign keys indexed (for JOIN performance)
- Frequently searched fields indexed (phone, email, status)
- Compound indexes for common queries
- Timestamp indexed for historical queries

---

## Security Considerations

### Encrypted Fields
These fields should be encrypted at rest:
- `idNumber` — National ID
- `mobilePhone` — Phone number
- Bank account numbers in BENEFICIARIES
- Passwords/PINs (hashed with bcrypt, not encrypted)

**Implementation:** Use PostgreSQL pgcrypto extension or application-level encryption

### Database Access Control
- Production database accessible only from application server
- No direct member access
- Staff access via admin interface only
- All access logged in AUDIT_LOGS

### Row-Level Security
- Members can only see their own data
- Staff can see assigned members' data
- Admins see all data
- Implemented in API controllers, enforced in queries

---

## Performance Considerations

### Connection Pooling
- Min 5, Max 20 connections in production
- Min 0, Max 5 in development
- Idle timeout 10 seconds

### Query Optimization
- Use indexes for WHERE, JOIN, ORDER BY
- Use pagination (LIMIT/OFFSET) for large result sets
- Cache frequently accessed data (share price, exchange rates)

### Maintenance
- Regular ANALYZE/VACUUM for PostgreSQL
- Monitor slow query logs
- Archive old AUDIT_LOGS to separate table yearly (after 7 years)

---

## Migration Strategy

### Sequelize CLI
```bash
# Generate new migration
npx sequelize-cli migration:generate --name <name>

# Run pending migrations
npm run db:migrate

# Undo last migration
npm run db:migrate:undo

# Undo all migrations
npm run db:migrate:undo:all
```

### Initial Setup
```bash
# Create database
createdb qona_mbs_dev

# Run all migrations
npm run db:migrate

# Seed test data
npm run db:seed:all
```

---

## Backup & Recovery

### Backup Strategy
- Daily automated backups (PostgreSQL pg_dump)
- Point-in-time recovery enabled
- 30-day retention

### Recovery Procedure
1. Restore from daily backup
2. Replay transaction logs for point-in-time recovery
3. Verify AUDIT_LOGS for integrity

---

**Next Phase:** Migration files and seed data will be created during development
