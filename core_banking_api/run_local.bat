@echo off
echo Setting up Core Banking API for local development...

REM Set environment variables
set DATABASE_URL=postgresql://postgres:password@localhost:5432/banking_db
set REDIS_URL=redis://localhost:6379
set SECRET_KEY=your-secret-key-change-in-production-12345
set ALGORITHM=HS256
set ACCESS_TOKEN_EXPIRE_MINUTES=30
set OTP_EXPIRE_MINUTES=5
set OTP_LENGTH=6
set ENVIRONMENT=development
set DEBUG=true

echo Environment variables set!
echo.
echo To start the API server, run:
echo uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
echo.
echo To seed the database, run:
echo python -c "from app.utils.seed import seed_database; seed_database()"
echo.
echo API will be available at: http://localhost:8000
echo API Documentation: http://localhost:8000/docs
echo.
pause
