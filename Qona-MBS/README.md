# Qona DT SACCO Mobile Banking System

**Project:** Qona DT SACCO Mobile Banking System  
**RFP Reference:** QS/MBS/5TH/MAY/2026  
**Client:** Qona DT SACCO, Westlands, Nairobi  
**Deadline:** 19th June 2026 (6 weeks)  
**Status:** In Development (Phase 1)

---

## Project Structure

```
Qona-MBS/
├── server/                    # Backend (Express.js REST API)
│   ├── src/
│   │   ├── index.js          # Entry point
│   │   ├── config/           # Environment & database config
│   │   ├── models/           # Sequelize ORM models
│   │   ├── routes/           # API route definitions
│   │   ├── controllers/      # Business logic handlers
│   │   ├── middleware/       # Auth, error handling, validation
│   │   ├── services/         # External API integrations
│   │   └── utils/            # Helpers, validators
│   ├── database/
│   │   ├── migrations/       # DB schema migrations
│   │   └── seeds/            # Test data seeds
│   ├── tests/                # Unit & integration tests
│   ├── .env                  # Environment variables (gitignored)
│   └── package.json
│
├── client/                    # Frontend (Vanilla JS SPA)
│   ├── public/
│   │   └── index.html        # Main HTML
│   ├── src/
│   │   ├── app.js            # Frontend initialization
│   │   ├── styles.css        # Dark theme CSS
│   │   ├── modules/          # Feature modules
│   │   └── utils/            # API client, validators
│   ├── tests/
│   └── package.json
│
├── docs/                      # Documentation
│   ├── API.md                # API reference
│   ├── DATABASE.md           # Schema & relationships
│   └── ARCHITECTURE.md       # System design
│
├── Qona_MBS_Requirements.md               # Condensed requirements
├── Qona_MBS_Technical_Specification.md   # Detailed technical spec
├── IMPLEMENTATION_ROADMAP.md             # Phase-by-phase plan
└── README.md                 # This file
```

---

## Quick Start

### Prerequisites
- Node.js 18+ 
- PostgreSQL 12+
- Redis (for sessions)
- npm or yarn

### Backend Setup
```bash
cd server
npm install
cp .env.example .env          # Configure environment variables
npm run migrate               # Run database migrations
npm run seed                  # Seed test data
npm start                     # Start server on http://localhost:3001
```

### Frontend Setup
```bash
cd client
npm install
npm start                     # Serve on http://localhost:3000
```

---

## Development Phases

| Phase | Timeline | Focus | Status |
|-------|----------|-------|--------|
| 1 | Weeks 1-2 | Foundation, Auth, DB | 🔴 Starting |
| 2 | Weeks 2-3 | Accounts, Balance, Transactions | ⬜ Pending |
| 3 | Weeks 3-4 | Transfers, Payments, M-Pesa | ⬜ Pending |
| 4 | Weeks 4-5 | Loans, CRB, Approvals | ⬜ Pending |
| 5 | Weeks 5-6 | Shares, WhatsApp, Notifications | ⬜ Pending |
| 6 | Week 6+ | Security, Testing, Launch | ⬜ Pending |

---

## Key Features

### Module Breakdown
- ✅ **Member Account Management** — BOSA, Savings, Shares, Loans
- ✅ **Balance Inquiry** — Across account types
- ✅ **Transactions** — History, statements, receipts
- ✅ **Transfers** — Internal, beneficiaries, external
- ✅ **Bill Payments** — KPLC, Water, TV, Internet
- ✅ **Airtime & Data** — Safaricom, Airtel, Telkom
- ✅ **Loan Management** — Application, approval, repayment
- ✅ **Share Capital** — Trading marketplace
- ✅ **Dividends** — View, capitalize, withdraw
- ✅ **WhatsApp Banking** — Balance, statements, payments
- ✅ **Security** — PIN, 2FA, Biometric, SIM-swap detection
- ✅ **Notifications** — SMS, Email, Push, In-app

---

## Technology Stack

### Backend
- **Framework:** Express.js
- **ORM:** Sequelize
- **Database:** PostgreSQL
- **Cache:** Redis
- **Auth:** JWT + bcrypt
- **Testing:** Jest / Mocha

### Frontend
- **Build:** Vanilla JavaScript (no framework)
- **Styling:** CSS3 (Dark theme)
- **HTTP Client:** Fetch API
- **State:** Simple object-based

### Integrations
- **Payments:** M-Pesa, Airtel Money, PesaLink
- **SMS:** Twilio / AfricasTalking
- **Email:** SendGrid
- **Chat:** Socket.io / Twilio
- **Credit:** Credit Reference Bureau (CRB)

---

## Environment Variables

Create `.env` file in server folder:

```env
# Server
NODE_ENV=development
PORT=3001

# Database
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=password
DB_NAME=qona_mbs
DB_PORT=5432

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-secret-key-change-in-production

# M-Pesa
MPESA_CONSUMER_KEY=your-key
MPESA_CONSUMER_SECRET=your-secret
MPESA_SHORTCODE=your-shortcode
MPESA_ENV=sandbox

# SMS (Twilio)
TWILIO_ACCOUNT_SID=your-sid
TWILIO_AUTH_TOKEN=your-token

# WhatsApp
WHATSAPP_PHONE_NUMBER_ID=your-id
WHATSAPP_ACCESS_TOKEN=your-token

# Email (SendGrid)
SENDGRID_API_KEY=your-key
```

---

## Database Schema

Core entities:
- **members** — User accounts
- **accounts** — BOSA, Savings, Shares, Loan accounts
- **transactions** — All account activity
- **loans** — Loan products & applications
- **beneficiaries** — Transfer recipients
- **shares** — Share holdings & market
- **dividends** — Dividend payments
- **auditLogs** — Immutable action logs

See [DATABASE.md](docs/DATABASE.md) for full schema.

---

## API Reference

70+ endpoints organized by function:

- **Auth** (8 endpoints) — Login, register, OTP, token refresh
- **Accounts** (8 endpoints) — List, balance, statement, transactions
- **Transfers** (10 endpoints) — Internal, external, limits
- **Beneficiaries** (6 endpoints) — Add, edit, delete, verify
- **Loans** (12 endpoints) — Apply, approve, repay, guarantor
- **Shares** (10 endpoints) — Portfolio, market, buy/sell
- **Bills** (8 endpoints) — KPLC, water, TV, internet
- **WhatsApp** (5 endpoints) — Message handling, commands
- **Admin** (10+ endpoints) — Dashboard, approvals, audit logs

See [API.md](docs/API.md) for complete reference.

---

## Testing

### Run Tests
```bash
npm test                      # Run all tests
npm run test:coverage        # Generate coverage report
npm run test:watch           # Watch mode
```

### Test Structure
- Unit tests for utilities, validators, calculations
- Integration tests for API endpoints
- Security tests for auth, encryption
- Performance tests for load

---

## Deployment

### Development
```bash
npm start
```

### Production
```bash
NODE_ENV=production npm start
```

### Docker (coming soon)
```bash
docker-compose up
```

---

## Support & Documentation

- **API Docs:** See `/docs/API.md`
- **Database Docs:** See `/docs/DATABASE.md`
- **Architecture:** See `/docs/ARCHITECTURE.md`
- **Technical Spec:** See `Qona_MBS_Technical_Specification.md`
- **Roadmap:** See `IMPLEMENTATION_ROADMAP.md`

---

## Deadline & Milestones

| Date | Milestone | Status |
|------|-----------|--------|
| 2026-05-12 | Project Start | ✅ Complete |
| 2026-05-19 | RFP Submission Deadline | ⏳ |
| 2026-05-26 | Phase 1-2 Complete | ⏳ |
| 2026-06-02 | Phase 3-4 Complete | ⏳ |
| 2026-06-09 | Phase 5 Complete | ⏳ |
| 2026-06-16 | Testing & Security | ⏳ |
| 2026-06-19 | **LAUNCH** | ⏳ |

---

## Contact

- **Client Contact:** client.contact@example.com
- **Project Lead:** [Your Name]
- **Submission Deadline:** 19th May 2026, 5:00pm EAT

---

**Last Updated:** 2026-05-12  
**Status:** Phase 1 - Foundation Setup
