@echo off
echo ========================================
echo    Starting Frontend Server
echo ========================================
echo.
echo Frontend will be available at: http://localhost:8080
echo.
echo Make sure your FastAPI backend is running at: http://localhost:8000
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

python -m http.server 8080
