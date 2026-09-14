# Developer Quick Reference Guide

**Purpose:** Fast lookup for common tasks during development  
**Last Updated:** 2026-05-12

---

## Quick Start (5 minutes)

### 1. First Time Setup
```bash
cd server
npm install
cp .env.example .env
# Edit .env with your database credentials
npm run dev
```

### 2. Access Server
- API: http://localhost:3001
- Health: http://localhost:3001/health

### 3. Test Auth
```bash
# Register
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"firstName":"John","lastName":"Doe","dateOfBirth":"1990-01-15","idNumber":"12345678","mobilePhone":"0712345678","pin":"1234"}'

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"mobilePhone":"0712345678","pin":"1234"}'
```

---

## File Structure Quick Map

### Backend Files You'll Edit Most

```
server/src/
├── models/              # Database models (rarely edit after Phase 1)
├── controllers/         # Business logic (EDIT: add new endpoints here)
├── routes/             # Route definitions (EDIT: add routes here)
├── middleware/         # Auth, validation (rarely edit)
├── services/           # External API calls (TO DO: create these)
├── utils/              # Helpers (rarely edit)
└── index.js            # Main server (rarely edit)
```

### Development Workflow
```
1. Create model (if new entity)      → src/models/NewEntity.js
2. Create controller                 → src/controllers/NewController.js
3. Create routes                     → src/routes/new.js
4. Mount routes in index.js
5. Test in Postman
6. Add error handling
7. Update docs
```

---

## Common Tasks

### Add a New API Endpoint

**Step 1: Create Controller Method**
```javascript
// src/controllers/AccountController.js
const getBalance = async (req, res) => {
  try {
    const { accountId } = req.params;
    
    const account = await Account.findByPk(accountId);
    
    if (!account || account.memberId !== req.user.memberId) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    return res.json({ balance: account.balance });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
```

**Step 2: Create Route**
```javascript
// src/routes/accounts.js
const express = require('express');
const router = express.Router();
const AccountController = require('../controllers/AccountController');
const { verifyJWT, loadMember } = require('../middleware/auth');

router.get('/:accountId', verifyJWT, loadMember, AccountController.getBalance);

module.exports = router;
```

**Step 3: Mount Route in Server**
```javascript
// src/index.js
const accountRoutes = require('./routes/accounts');
app.use('/api/accounts', accountRoutes);
```

**Step 4: Test**
```bash
# Get access token from login first
curl -X GET http://localhost:3001/api/accounts/ACCOUNT_ID \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

---

### Create a New Database Model

**Step 1: Create Model File**
```javascript
// src/models/Loan.js
module.exports = (sequelize) => {
  const Loan = sequelize.define('Loan', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    memberId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'members', key: 'id' },
    },
    principal: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
    },
    // ... more fields
  }, {
    tableName: 'loans',
    timestamps: true,
    indexes: [{ fields: ['memberId'] }],
  });
  
  return Loan;
};
```

**Step 2: Export in models/index.js**
```javascript
const Loan = require('./Loan')(sequelize);
// ... add association
Loan.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });
module.exports = { ..., Loan };
```

**Step 3: Use in Controller**
```javascript
const { Loan } = require('../models');

const createLoan = async (req, res) => {
  const loan = await Loan.create({
    memberId: req.user.memberId,
    principal: 100000,
    // ...
  });
  return res.json(loan);
};
```

---

### Add Validation

**Built-in Sequelize Validation**
```javascript
// In model definition
amount: {
  type: DataTypes.DECIMAL(15, 2),
  allowNull: false,
  validate: {
    min: 0.01,
    isDecimal: true,
  },
}
```

**Controller Validation**
```javascript
// In controller
const { isValidPhoneNumber, isValidPinFormat } = require('../utils/auth');

if (!isValidPhoneNumber(mobilePhone)) {
  return res.status(400).json({ error: 'Invalid phone number' });
}
```

---

### Work with Transactions

```javascript
// Create a transaction
const transaction = await Transaction.create({
  fromAccountId: sourceId,
  toAccountId: targetId,
  transactionType: 'TRANSFER',
  amount: 50000,
  referenceNumber: generateTransactionReference(),
  status: 'PENDING',
});

// Update transaction status
transaction.status = 'SUCCESS';
transaction.balanceAfter = newBalance;
await transaction.save();

// Query transactions
const history = await Transaction.findAll({
  where: { fromAccountId: accountId },
  order: [['createdAt', 'DESC']],
  limit: 10,
});
```

---

### Query Data with Sequelize

**Find Single Record**
```javascript
// By primary key
const member = await Member.findByPk(memberId);

// By condition
const member = await Member.findOne({
  where: { mobilePhone: phone },
});
```

**Find Multiple Records**
```javascript
// All records
const allMembers = await Member.findAll();

// With conditions
const activeMembers = await Member.findAll({
  where: { status: 'ACTIVE' },
});

// Paginated
const members = await Member.findAll({
  limit: 10,
  offset: 0,
  order: [['createdAt', 'DESC']],
});
```

**With Associations**
```javascript
// Include related data
const member = await Member.findByPk(memberId, {
  include: ['accounts', 'loans'],
});

// Access related data
member.accounts.forEach(acc => console.log(acc.balance));
```

---

### Handle Errors

**Sequelize Errors**
```javascript
try {
  await Member.create({...});
} catch (error) {
  if (error.name === 'SequelizeValidationError') {
    return res.status(400).json({ error: error.errors[0].message });
  }
  if (error.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({ error: 'Record already exists' });
  }
  throw error;
}
```

**Custom Validation**
```javascript
const validateLoanApplication = (principal, duration) => {
  if (principal < 10000) {
    throw new Error('Minimum loan: 10,000');
  }
  if (duration < 1 || duration > 120) {
    throw new Error('Duration: 1-120 months');
  }
};
```

---

### Log Events (for Audit Trail)

```javascript
const { logAuditEvent } = require('../middleware/auth');

await logAuditEvent({
  action: 'LOAN_APPROVED',
  entityType: 'LOAN',
  entityId: loan.id,
  description: `Loan approved by staff`,
  performedBy: req.user.memberId,
  performedByRole: req.user.role,
  ipAddress: req.ip,
  result: 'SUCCESS',
});
```

---

## Important Constants

### Transaction Types
```javascript
'DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'LOAN_DISBURSEMENT',
'LOAN_REPAYMENT', 'BILL_PAYMENT', 'AIRTIME_PURCHASE',
'DATA_PURCHASE', 'DIVIDEND_PAYOUT', 'INTEREST_ACCRUAL'
```

### Account Types
```javascript
'BOSA', 'SAVINGS', 'SHARE_CAPITAL', 'DIVIDEND', 'LOAN'
```

### Member Status
```javascript
'ACTIVE', 'INACTIVE', 'SUSPENDED', 'CLOSED'
```

### KYC Status
```javascript
'PENDING', 'VERIFIED', 'REJECTED'
```

### Loan Status
```javascript
'PENDING', 'APPROVED', 'ACTIVE', 'ARREARS', 'SETTLED', 'DEFAULTED'
```

---

## Testing Checklist

Before committing code:

- [ ] Endpoint returns correct status code (200, 201, 400, 401, 404, etc.)
- [ ] Response format matches specification (JSON keys, data types)
- [ ] Validation works (test with invalid data)
- [ ] Authentication required for protected routes
- [ ] Member can only see their own data
- [ ] Audit log created for sensitive actions
- [ ] No sensitive data in error messages (no stack traces)
- [ ] Database queries use indexes (check slow query log)
- [ ] No N+1 queries (use include/associations)

---

## Database Maintenance

### View Database
```bash
# Connect to database
psql -U postgres -d qona_mbs_dev

# List tables
\dt

# Describe table
\d members

# Run query
SELECT * FROM members LIMIT 5;

# Exit
\q
```

### Check Indexes
```sql
-- List all indexes on a table
SELECT * FROM pg_indexes WHERE tablename = 'members';

-- Create index
CREATE INDEX idx_members_phone ON members(mobile_phone);
```

### Backup Database
```bash
# Dump database
pg_dump -U postgres -d qona_mbs_dev > backup.sql

# Restore
psql -U postgres -d qona_mbs_dev < backup.sql
```

---

## Debugging

### Enable Detailed Logging
```javascript
// In .env
DEBUG=qona-mbs:*
DB_LOGGING=true
```

### Check Request/Response
```javascript
// Add to any controller
console.log('Request:', {
  body: req.body,
  user: req.user,
  headers: req.headers,
});
console.log('Response:', result);
```

### Inspect Database State
```bash
# In PostgreSQL
SELECT * FROM members WHERE id = 'UUID';
SELECT * FROM audit_logs WHERE entity_id = 'UUID' ORDER BY timestamp DESC;
```

### Test with cURL
```bash
# With token
curl -X GET http://localhost:3001/api/auth/me \
  -H "Authorization: Bearer TOKEN_HERE"

# With body
curl -X POST http://localhost:3001/api/endpoint \
  -H "Content-Type: application/json" \
  -d '{"field": "value"}'
```

---

## Security Reminders

✅ **DO:**
- Hash passwords/PINs before storing
- Validate all input
- Use parameterized queries (Sequelize handles this)
- Check user ownership before returning data
- Log sensitive actions
- Use HTTPS in production
- Rotate JWT secrets regularly
- Rate limit auth endpoints

❌ **DON'T:**
- Store plaintext passwords or PINs
- Return stack traces in error responses
- Allow SQL injection via string concatenation
- Trust client-provided IDs for authentication
- Log sensitive data (passwords, PINs, credit cards)
- Commit .env files to git
- Use hardcoded secrets in code

---

## Performance Tips

### Database Optimization
```javascript
// ✅ GOOD: Use include to avoid N+1 queries
const members = await Member.findAll({
  include: ['accounts'],
  limit: 10,
});

// ❌ BAD: Queries once per loop iteration
const members = await Member.findAll({ limit: 10 });
for (const member of members) {
  const accounts = await Account.findAll({ where: { memberId: member.id } });
}
```

### Add Indexes
```javascript
// For frequently queried fields
indexes: [
  { fields: ['memberId'] },
  { fields: ['status'] },
  { fields: ['memberId', 'status'] }, // Compound index
]
```

### Use Pagination
```javascript
// ✅ GOOD
const records = await Model.findAll({ limit: 50, offset: 0 });

// ❌ BAD (loads all records into memory)
const records = await Model.findAll();
```

---

## Version Control

### Commit Message Format
```
type(scope): subject

body

footer

Examples:
feat(auth): add OTP verification endpoint
fix(accounts): correct balance calculation
docs(database): add schema documentation
refactor(models): extract validation logic
test(auth): add login tests
```

### Before Committing
```bash
npm run lint       # Check code style
npm run format     # Auto-format code
npm test           # Run tests
git status         # Check files
```

---

## Useful Commands

```bash
# Development
npm run dev              # Start with auto-reload

# Testing
npm test                 # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report

# Database
npm run db:migrate      # Run migrations
npm run db:seed         # Seed test data

# Code Quality
npm run lint            # Check code
npm run format          # Format code

# Build
npm run build          # Build for production
```

---

## Useful Links

- **Sequelize Docs:** https://sequelize.org/
- **Express Docs:** https://expressjs.com/
- **PostgreSQL Docs:** https://www.postgresql.org/docs/
- **JWT.io:** https://jwt.io/
- **bcryptjs:** https://github.com/dcodeIO/bcrypt.js

---

## FAQ

**Q: How do I reset the database?**
```bash
# Drop and recreate
dropdb -U postgres qona_mbs_dev
createdb -U postgres qona_mbs_dev
# Then restart server to sync models
```

**Q: How do I view generated SQL?**
```bash
# Enable in .env
DB_LOGGING=true
# Or in code
sequelize.options.logging = console.log;
```

**Q: How do I test protected endpoints?**
1. Register a member
2. Login to get accessToken
3. Use in Authorization header: `Bearer TOKEN`

**Q: How do I add a new required field to model?**
1. Add field to model definition
2. Create migration (use Sequelize CLI)
3. Run migration in test environment
4. Update controllers/validators

**Q: Can I modify old migrations?**
**NO!** Never modify old migrations. Create a new migration for changes.

---

**Last Updated:** 2026-05-12  
**Next Review:** After Phase 2 completion
