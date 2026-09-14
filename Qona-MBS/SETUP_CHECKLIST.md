# Setup Checklist - Qona MBS Phase 1

Print this page and check off each item as you complete it.

---

## Pre-Requirements

- [ ] Node.js 18+ installed (`node --version` shows 18+)
- [ ] npm 9+ installed (`npm --version` shows 9+)
- [ ] PostgreSQL 12+ installed and running
- [ ] Text editor or IDE open (VS Code, WebStorm, etc.)
- [ ] Postman or Insomnia installed (for API testing)
- [ ] Git configured (`git config --global user.name "Your Name"`)

---

## Step 1: Database Setup

### PostgreSQL

- [ ] PostgreSQL service is running (check Services on Windows)
- [ ] Can connect: `psql -U postgres` works
- [ ] Create database: `CREATE DATABASE qona_mbs_dev;`
- [ ] Database created: `\l` shows qona_mbs_dev
- [ ] Exit PostgreSQL: `\q`

---

## Step 2: Project Initialization

### Navigate to Project

- [ ] Open terminal/command prompt
- [ ] Navigate: `cd "Qona-MBS/server"`
- [ ] Verify location: `pwd` (or `cd` on Windows) shows correct path

### Install Dependencies

- [ ] Run: `npm install`
- [ ] Wait for completion (2-3 minutes)
- [ ] Check success: `npm list` shows 16 dependencies
- [ ] No errors in terminal

---

## Step 3: Environment Configuration

### Create .env File

- [ ] Copy template: `cp .env.example .env` (or copy manually on Windows)
- [ ] Open `.env` in editor
- [ ] Set database credentials:
  - [ ] `DB_HOST=localhost`
  - [ ] `DB_PORT=5432`
  - [ ] `DB_USER=postgres`
  - [ ] `DB_PASSWORD=your_password` (your PostgreSQL password)
  - [ ] `DB_NAME=qona_mbs_dev`
- [ ] Set JWT secret: `JWT_SECRET=your-secret-key-change-in-production`
- [ ] Save file
- [ ] Verify `.env` file exists: `ls` or `dir`
- [ ] `.env` is in gitignore: check `.gitignore` file

---

## Step 4: Start Server

### Run Development Server

- [ ] Run: `npm run dev`
- [ ] Wait for server to start
- [ ] See banner with ASCII art
- [ ] Server message: "Listening on http://localhost:3001"
- [ ] No error messages

### Database Sync

- [ ] Check console output
- [ ] Database connection established
- [ ] Models synced message appears
- [ ] 9 tables created in PostgreSQL (can verify with `\dt` in psql)

---

## Step 5: Health Check

### Verify Server Running

- [ ] Open new terminal/command prompt
- [ ] Test endpoint: `curl http://localhost:3001`
  (Or use Postman to GET http://localhost:3001)
- [ ] Response: `{ status: "OK", service: "Qona MBS API", ... }`

### Check Database Connection

- [ ] Test health: `curl http://localhost:3001/health`
  (Or GET http://localhost:3001/health in Postman)
- [ ] Response includes: `{ status: "OK", database: "Connected" }`

---

## Step 6: Authentication Testing

### Register Member (Postman/Insomnia)

- [ ] Open Postman
- [ ] Create new request: `POST`
- [ ] URL: `http://localhost:3001/api/auth/register`
- [ ] Headers: `Content-Type: application/json`
- [ ] Body (raw JSON):
  ```json
  {
    "firstName": "Test",
    "lastName": "User",
    "dateOfBirth": "1990-01-15",
    "idNumber": "12345678",
    "mobilePhone": "0712345678",
    "email": "test@example.com",
    "pin": "1234"
  }
  ```
- [ ] Click Send
- [ ] Response status: `201 Created`
- [ ] Response includes: `memberId`, `firstName`, `mobilePhone`
- [ ] No errors

### Login with Member

- [ ] Create new request: `POST`
- [ ] URL: `http://localhost:3001/api/auth/login`
- [ ] Headers: `Content-Type: application/json`
- [ ] Body:
  ```json
  {
    "mobilePhone": "0712345678",
    "pin": "1234"
  }
  ```
- [ ] Click Send
- [ ] Response status: `200 OK`
- [ ] Response includes: `accessToken`, `refreshToken`
- [ ] Copy `accessToken` value

### Get Current User (Protected Route)

- [ ] Create new request: `GET`
- [ ] URL: `http://localhost:3001/api/auth/me`
- [ ] Headers:
  - [ ] `Content-Type: application/json`
  - [ ] `Authorization: Bearer PASTE_TOKEN_HERE` (paste the accessToken)
- [ ] Click Send
- [ ] Response status: `200 OK`
- [ ] Response shows member profile (firstName, lastName, etc.)

### Logout

- [ ] Create new request: `POST`
- [ ] URL: `http://localhost:3001/api/auth/logout`
- [ ] Headers: `Authorization: Bearer TOKEN_HERE`
- [ ] Click Send
- [ ] Response status: `200 OK`
- [ ] Response: `{ message: "Logged out successfully" }`

---

## Step 7: Database Verification

### Check Tables Created

- [ ] Open PostgreSQL: `psql -U postgres -d qona_mbs_dev`
- [ ] List tables: `\dt`
- [ ] Should see 9 tables:
  - [ ] `members`
  - [ ] `accounts`
  - [ ] `transactions`
  - [ ] `loans`
  - [ ] `beneficiaries`
  - [ ] `shares`
  - [ ] `dividends`
  - [ ] `notification_preferences`
  - [ ] `audit_logs`

### Check Sample Data

- [ ] Query members: `SELECT id, firstName, mobilePhone FROM members;`
- [ ] Should see the test user you registered
- [ ] Exit: `\q`

---

## Step 8: Code Review

### Check File Structure

- [ ] Navigate: `ls -la` or `dir` in server folder
- [ ] Verify files exist:
  - [ ] `package.json`
  - [ ] `.env`
  - [ ] `.env.example`
  - [ ] `.sequelizerc`
  - [ ] `.gitignore`
  - [ ] `src/` folder

### Check Backend Code

- [ ] Check models exist:
  - [ ] `src/models/Member.js`
  - [ ] `src/models/Account.js`
  - [ ] `src/models/Transaction.js`
  - [ ] `src/models/Loan.js`
  - [ ] `src/models/Beneficiary.js`
  - [ ] `src/models/Share.js`
  - [ ] `src/models/Dividend.js`
  - [ ] `src/models/NotificationPreference.js`
  - [ ] `src/models/AuditLog.js`

- [ ] Check controllers:
  - [ ] `src/controllers/AuthController.js` exists
  - [ ] Has functions: register, login, requestOTP, verifyOTP, logout, getCurrentUser, resetPin

- [ ] Check routes:
  - [ ] `src/routes/auth.js` exists
  - [ ] Has 8 route definitions

- [ ] Check middleware:
  - [ ] `src/middleware/auth.js` exists
  - [ ] Has 10 middleware functions

- [ ] Check utils:
  - [ ] `src/utils/auth.js` exists
  - [ ] Has 42 utility functions

- [ ] Check server:
  - [ ] `src/index.js` exists
  - [ ] Has Express server setup

---

## Step 9: Documentation Review

### Root Level

- [ ] `README.md` exists (project overview)
- [ ] `SETUP_GUIDE.md` exists (setup instructions)
- [ ] `PHASE_1_COMPLETION.md` exists (detailed report)
- [ ] `DEVELOPER_GUIDE.md` exists (quick reference)
- [ ] `PHASE_1_SUMMARY.txt` exists (executive summary)
- [ ] `IMPLEMENTATION_ROADMAP.md` exists (6-week plan)

### Documentation Folder

- [ ] `docs/DATABASE.md` exists
- [ ] DATABASE.md explains all 9 models
- [ ] DATABASE.md has ERD diagram

### Configuration Examples

- [ ] `.env.example` has 50+ variables
- [ ] Comments explain each variable
- [ ] No actual secrets in .env.example

---

## Step 10: Code Quality

### No Errors

- [ ] Terminal shows no error messages
- [ ] Server running without warnings
- [ ] Database connected successfully
- [ ] All tests passed (if any)

### Sensitive Data Check

- [ ] `.env` file NOT committed to git
- [ ] No secrets in code files
- [ ] No plaintext passwords anywhere
- [ ] `.gitignore` includes `.env`

### Code Organization

- [ ] Models organized in `src/models/`
- [ ] Controllers in `src/controllers/`
- [ ] Routes in `src/routes/`
- [ ] Middleware in `src/middleware/`
- [ ] Utils in `src/utils/`

---

## Step 11: Next Steps

### Ready for Phase 2

- [ ] Phase 1 setup complete
- [ ] All endpoints tested
- [ ] Database verified
- [ ] Documentation reviewed
- [ ] Code organized

### Plan Phase 2

- [ ] Read `DEVELOPER_GUIDE.md` for workflow
- [ ] Review `PHASE_1_SUMMARY.txt` for progress
- [ ] Plan Account Management endpoints
- [ ] Schedule next development session

---

## Troubleshooting

### If Server Won't Start

- [ ] Check Node.js version: `node --version`
- [ ] Check PostgreSQL running: `psql -U postgres`
- [ ] Check .env file: `cat .env` (or `type .env` on Windows)
- [ ] Check database exists: `psql -l`
- [ ] Delete node_modules and reinstall: `rm -rf node_modules && npm install`
- [ ] Check port not in use: `lsof -i :3001` (Mac/Linux) or `netstat -ano | findstr :3001` (Windows)

### If Login Fails

- [ ] Double-check phone number matches registration
- [ ] Double-check PIN matches (must be 4-6 digits)
- [ ] Check member in database: `SELECT * FROM members;`
- [ ] Check DB_LOGGING=true in .env for SQL queries
- [ ] Look at server console output for error details

### If Tests Fail

- [ ] Check database connection: `\c qona_mbs_dev` in psql
- [ ] Check tables exist: `\dt` in psql
- [ ] Check sample data: `SELECT COUNT(*) FROM members;`
- [ ] Restart server: `npm run dev`
- [ ] Try test again in Postman

---

## Success Criteria

Once all items are checked:

✅ Database: PostgreSQL qona_mbs_dev created with 9 tables  
✅ Server: Running on http://localhost:3001  
✅ API: All 8 auth endpoints responding  
✅ Auth: Register, login, logout working  
✅ Database: Sample data verified  
✅ Documentation: All guides and specs present  
✅ Code: Well-organized, no errors  
✅ Ready: Phase 1 complete, Phase 2 ready to start  

---

## Sign-Off

**Setup Date:** _______________

**Completed By:** _______________

**Status:**
- [ ] All items checked (Ready for Phase 2)
- [ ] Some items incomplete (See Troubleshooting)
- [ ] Major issues (Contact support)

**Notes:**
```
_________________________________________________________________

_________________________________________________________________

_________________________________________________________________
```

---

## Quick Reference

**Start Server:**
```bash
cd Qona-MBS/server
npm run dev
```

**Test Health:**
```bash
curl http://localhost:3001/health
```

**Register User:**
```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"User","dateOfBirth":"1990-01-15","idNumber":"12345678","mobilePhone":"0712345678","pin":"1234"}'
```

**Login:**
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"mobilePhone":"0712345678","pin":"1234"}'
```

**Documentation:**
- Setup: `SETUP_GUIDE.md`
- Database: `docs/DATABASE.md`
- Development: `DEVELOPER_GUIDE.md`
- Summary: `PHASE_1_SUMMARY.txt`

---

**Phase 1 Status: ✅ COMPLETE**  
**Ready for Phase 2: YES**  
**Last Updated: 2026-05-12**
