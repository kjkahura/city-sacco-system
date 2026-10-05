# Core Banking API

A comprehensive FastAPI-based core banking system for SACCOs and MFIs.

## Features

- **Authentication**: OTP/JWT-based authentication system
- **Member Management**: Complete member lifecycle management
- **Account Management**: Multiple account types (savings, current, fixed deposit)
- **Transaction Processing**: Deposit, withdrawal, transfer operations
- **Loan Management**: Complete loan lifecycle (apply, approve, disburse, repay)
- **USSD Simulator**: Mobile banking simulation
- **Background Tasks**: APScheduler for standing orders and interest accrual
- **Database**: PostgreSQL with Alembic migrations
- **Caching**: Redis for session management and OTP storage

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Python 3.11+ (for local development)

### Using Docker (Recommended)

1. **Start all services**:
   ```bash
   docker-compose up -d
   ```

2. **Run database migrations**:
   ```bash
   docker-compose exec api alembic upgrade head
   ```

3. **Seed demo data**:
   ```bash
   docker-compose exec api python -c "from app.utils.seed import seed_database; seed_database()"
   ```

4. **Access the API**:
   - API Documentation: http://localhost:8000/docs
   - ReDoc: http://localhost:8000/redoc
   - Database Admin: http://localhost:8080
   - **Web Frontend**: See `frontend/` folder for HTML/JavaScript UI

### Local Development

1. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Set up environment variables**:
   ```bash
   export DATABASE_URL="postgresql://postgres:password@localhost:5432/banking_db"
   export REDIS_URL="redis://localhost:6379"
   export SECRET_KEY="your-secret-key"
   ```

3. **Start PostgreSQL and Redis**:
   ```bash
   docker-compose up -d postgres redis
   ```

4. **Run migrations**:
   ```bash
   alembic upgrade head
   ```

5. **Seed demo data**:
   ```bash
   python -c "from app.utils.seed import seed_database; seed_database()"
   ```

6. **Start the API**:
   ```bash
   uvicorn app.main:app --reload
   ```

## Web Frontend

A simple HTML/JavaScript frontend is included in the `frontend/` folder.

### To Run the Frontend:

1. **Start the backend** (if not already running):
   ```bash
   start_local.bat
   ```

2. **Start the frontend server**:
   ```bash
   cd frontend
   start_server.bat
   ```
   Or manually:
   ```bash
   python -m http.server 8080
   ```

3. **Open in browser**: http://localhost:8080

### Frontend Features:
- 📊 Dashboard with statistics
- 👥 Member management
- 💰 Account management
- 💸 Transaction processing (deposit/withdraw/transfer)
- 📋 Loan management
- 📱 USSD simulator

### Default Login:
- Username: `admin` / Password: `admin123`
- Username: `teller1` / Password: `teller123`

## API Endpoints

### Authentication
- `POST /api/v1/auth/otp/send` - Send OTP
- `POST /api/v1/auth/otp/verify` - Verify OTP and get JWT
- `POST /api/v1/auth/login` - Login with credentials
- `POST /api/v1/auth/register` - Register new user

### Members
- `GET /api/v1/members/` - List members
- `POST /api/v1/members/` - Create member
- `GET /api/v1/members/{id}` - Get member details
- `PUT /api/v1/members/{id}` - Update member
- `DELETE /api/v1/members/{id}` - Delete member

### Accounts
- `GET /api/v1/accounts/` - List accounts
- `POST /api/v1/accounts/` - Create account
- `GET /api/v1/accounts/{id}` - Get account details
- `GET /api/v1/accounts/{id}/balance` - Get account balance

### Transactions
- `GET /api/v1/transactions/` - List transactions
- `POST /api/v1/transactions/deposit` - Process deposit
- `POST /api/v1/transactions/withdraw` - Process withdrawal
- `POST /api/v1/transactions/transfer` - Process transfer

### Loans
- `GET /api/v1/loans/` - List loans
- `POST /api/v1/loans/apply` - Apply for loan
- `POST /api/v1/loans/{id}/approve` - Approve loan
- `POST /api/v1/loans/{id}/disburse` - Disburse loan
- `POST /api/v1/loans/{id}/repay` - Make loan payment
- `GET /api/v1/loans/{id}/schedule` - Get loan schedule

### USSD Simulator
- `POST /api/v1/ussd/simulate` - Simulate USSD session
- `GET /api/v1/ussd/test` - Test USSD endpoint

## Demo Data

The system comes with pre-seeded demo data:

- **Users**: admin, teller1, loan_officer1
- **Members**: 3 sample members with different profiles
- **Accounts**: Savings and current accounts with balances
- **Transactions**: Sample deposit, withdrawal, and transfer transactions
- **Loans**: 1 active loan with payment schedule
- **Standing Orders**: 1 monthly recurring transfer

## Database Schema

The system includes the following core models:

- **User**: System users (admin, teller, loan officer, member)
- **Member**: SACCO members with personal information
- **Account**: Member accounts (savings, current, fixed deposit)
- **Transaction**: Financial transactions
- **Loan**: Loan applications and management
- **LoanSchedule**: Loan repayment schedules
- **StandingOrder**: Recurring payment orders
- **OTP**: One-time passwords for authentication

## Background Tasks

The system includes scheduled background tasks:

- **Standing Orders**: Processed daily at 6 AM
- **Loan Interest Accrual**: Processed daily at midnight
- **Daily Reports**: Generated daily at 8 AM

## Security

- JWT-based authentication
- OTP verification for mobile access
- Password hashing (implement proper hashing in production)
- CORS configuration
- Input validation with Pydantic

## Production Considerations

1. **Security**:
   - Use proper password hashing (bcrypt)
   - Implement rate limiting
   - Use HTTPS
   - Secure secret keys

2. **Database**:
   - Use connection pooling
   - Implement database backups
   - Monitor performance

3. **Monitoring**:
   - Add logging
   - Implement health checks
   - Monitor API performance

4. **Deployment**:
   - Use environment-specific configurations
   - Implement CI/CD pipeline
   - Use container orchestration

## License

This project is for demonstration purposes.
