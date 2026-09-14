# Qona MBS Development Setup Guide

**Document Version:** 1.0  
**Date:** 2026-05-12  
**Status:** Step 1 Complete ✅

---

## ✅ Step 4: Project Folder Structure - COMPLETE

### What Was Created:
```
Qona-MBS/
├── server/              # Backend Express.js API
│   ├── src/
│   │   ├── config/      # Database & environment config
│   │   ├── models/      # Sequelize ORM models
│   │   ├── routes/      # API endpoints
│   │   ├── controllers/ # Business logic
│   │   ├── middleware/  # Auth, error handling
│   │   ├── services/    # External integrations
│   │   └── utils/       # Helpers & validators
│   ├── database/
│   │   ├── migrations/  # Schema migrations
│   │   └── seeds/       # Test data
│   └── tests/           # Unit & integration tests
│
├── client/              # Frontend SPA (Vanilla JS)
│   ├── public/          # Static files, index.html
│   ├── src/             # JavaScript modules
│   └── tests/
│
└── docs/                # Documentation files
```

---

## ✅ Step 1: Node.js Project Setup - COMPLETE

### Files Created:

#### 1. **server/package.json**
- **Dependencies** (16):
  - `express` — Web framework
  - `sequelize` — ORM for PostgreSQL
  - `pg` — PostgreSQL driver
  - `redis` — Session & cache store
  - `jsonwebtoken` — JWT authentication
  - `bcryptjs` — Password hashing
  - `express-validator` — Input validation
  - `uuid` — Unique ID generation
  - `winston` — Logging
  - `axios` — HTTP client (for external APIs)
  - `dotenv` — Environment variables
  - `cors` — Cross-origin support

- **Dev Dependencies** (4):
  - `nodemon` — Auto-restart on file changes
  - `jest` — Testing framework
  - `prettier` — Code formatting
  - `eslint` — Code linting

- **Scripts**:
  ```bash
  npm start              # Run production server
  npm run dev            # Run with auto-reload
  npm test               # Run tests
  npm run db:migrate     # Run database migrations
  npm run db:seed        # Seed test data
  ```

#### 2. **client/package.json**
- **Dev Dependencies**:
  - `http-server` — Simple local web server
  - `jest` — Testing
  - `prettier` — Formatting
  - `eslint` — Linting

- **Scripts**:
  ```bash
  npm start              # Start dev server on port 3000
  npm test               # Run tests
  ```

#### 3. **server/.env.example**
Template file with all environment variables:
- Database config (host, user, password, database name)
- JWT secrets
- M-Pesa API credentials
- SMS gateway (Twilio)
- Email service (SendGrid)
- WhatsApp integration
- CRB API key
- Firebase for push notifications
- Feature flags (WhatsApp, Biometric, 2FA, SIM-swap detection)

#### 4. **server/src/config/database.js**
Sequelize configuration for three environments:
- **Development:** Local PostgreSQL, logging enabled
- **Test:** Separate test database
- **Production:** RDS with SSL, connection pooling

#### 5. **.gitignore**
Prevents committing sensitive files:
- `.env` files
- `node_modules/`
- `logs/`
- `coverage/` (test reports)
- IDE files (.vscode, .idea)

#### 6. **.sequelizerc**
Configuration file for Sequelize CLI migrations

---

## 📋 Next Steps: Step 2 (Database Schema Design)

### What Will Be Created:

#### Phase 2a: Database Models (Sequelize)
Create model files in `server/src/models/`:

1. **Member.js** — User accounts
2. **Account.js** — BOSA, Savings, Shares, Loans
3. **Transaction.js** — All account activity
4. **Loan.js** — Loan products & applications
5. **Beneficiary.js** — Transfer recipients
6. **Share.js** — Share holdings
7. **Dividend.js** — Dividend payments
8. **NotificationPreference.js** — User notification settings
9. **AuditLog.js** — Immutable action logs

Each model will include:
- Field definitions (name, type, constraints)
- Validations (required, unique, email format)
- Associations (hasMany, belongsTo)
- Indexes (for performance)

#### Phase 2b: Database Migrations
Create migration files in `database/migrations/`:
- Create each table with proper schema
- Add foreign keys & constraints
- Create indexes

#### Phase 2c: Seed Data
Create seed file in `database/seeders/`:
- 10 test members
- 5 test loans
- Sample transactions
- Test data for all features

### To Run Step 2, Execute:

```bash
# Navigate to server folder
cd server

# Install dependencies
npm install

# Create .env file from template
copy .env.example .env
# Then edit .env with your local PostgreSQL credentials

# Create database (in PostgreSQL)
createdb qona_mbs_dev

# Run migrations
npm run db:migrate

# Seed test data
npm run db:seed

# Start development server
npm run dev
```

---

## 🔐 Security Considerations

### Environment Variables
- Store sensitive values in `.env` (never commit to git)
- Use `.env.example` as template
- In production, use environment-specific secrets management

### Database Security
- PostgreSQL credentials stored in `.env`
- Connection pooling to prevent connection exhaustion
- Prepared statements (Sequelize ORM handles this)

### API Security (implemented later)
- JWT authentication
- Password hashing (bcrypt)
- Input validation (express-validator)
- Rate limiting
- CORS configuration

---

## 🚀 Development Workflow

### For Each Phase:
1. Create models (`src/models/`)
2. Create migrations (`database/migrations/`)
3. Create controllers (`src/controllers/`)
4. Create routes (`src/routes/`)
5. Create tests (`server/tests/`)
6. Write frontend UI (`client/src/`)

### Commands:
```bash
# Development
npm run dev              # Auto-restarting server

# Testing
npm test                 # Run all tests
npm run test:coverage    # Generate coverage report

# Code Quality
npm run lint             # Check code style
npm run format           # Auto-fix formatting

# Database
npm run db:migrate       # Run migrations
npm run db:seed          # Add test data
```

---

## 📊 Current Status

| Phase | Task | Status | Completion |
|-------|------|--------|-----------|
| Setup | Folder structure | ✅ Complete | 100% |
| Setup | package.json & config | ✅ Complete | 100% |
| Setup | Environment template | ✅ Complete | 100% |
| **Phase 1** | **Database models** | ⏳ Next | 0% |
| Phase 1 | Migrations | ⏳ Next | 0% |
| Phase 1 | Authentication routes | ⏳ Pending | 0% |
| Phase 2 | Account management | ⏳ Pending | 0% |
| Phase 3 | Transfers & payments | ⏳ Pending | 0% |
| Phase 4 | Loans | ⏳ Pending | 0% |
| Phase 5 | Shares, WhatsApp | ⏳ Pending | 0% |
| Phase 6 | Testing, launch | ⏳ Pending | 0% |

---

## Prerequisites Checklist

Before proceeding with Step 2, ensure:

- [ ] Node.js 18+ installed (`node --version`)
- [ ] npm 9+ installed (`npm --version`)
- [ ] PostgreSQL 12+ installed and running (`psql --version`)
- [ ] Redis installed (optional for now) (`redis-cli --version`)
- [ ] Git configured
- [ ] Text editor / IDE ready

### Verify PostgreSQL:
```bash
# Connect to PostgreSQL
psql -U postgres

# List databases
\l

# Create development database
CREATE DATABASE qona_mbs_dev;

# Exit
\q
```

---

## Troubleshooting

### Port Already in Use
- Server runs on port 3001 (backend)
- Client runs on port 3000 (frontend)
- If ports are busy, change in config

### PostgreSQL Connection Error
Check `.env` file:
- DB_HOST should be `localhost`
- DB_PORT should be `5432`
- DB_USER and DB_PASSWORD match your PostgreSQL setup

### npm Install Fails
```bash
# Clear cache
npm cache clean --force

# Remove node_modules
rm -r node_modules

# Reinstall
npm install
```

---

## Documentation Files Available

- **README.md** — Project overview
- **SETUP_GUIDE.md** — This file (step-by-step setup)
- **Qona_MBS_Requirements.md** — Condensed RFP requirements
- **Qona_MBS_Technical_Specification.md** — Detailed tech spec
- **IMPLEMENTATION_ROADMAP.md** — 6-week phase plan

---

**Next Step:** Proceed to Step 2 - Database Schema Design
**Estimated Time:** 2-3 hours
**Files to Create:** 9 models + 9 migrations + 1 seed file
