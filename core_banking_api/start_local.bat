@echo off
echo ========================================
echo    Core Banking API - Local Development
echo ========================================
echo.

REM Set environment variables
set DATABASE_URL=sqlite:///./banking_db.db
set SECRET_KEY=your-secret-key-change-in-production-12345
set ALGORITHM=HS256
set ACCESS_TOKEN_EXPIRE_MINUTES=30
set OTP_EXPIRE_MINUTES=5
set OTP_LENGTH=6
set ENVIRONMENT=development
set DEBUG=true

echo Environment variables set!
echo.
echo Starting FastAPI server...
echo.
echo 🌐 API will be available at: http://localhost:8000
echo 📚 API Documentation: http://localhost:8000/docs
echo 📖 ReDoc: http://localhost:8000/redoc
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

uvicorn app.main_local:app --reload --host 0.0.0.0 --port 8000
