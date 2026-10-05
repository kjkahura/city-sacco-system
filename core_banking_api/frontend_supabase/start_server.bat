@echo off
echo ========================================
echo    Starting Supabase Frontend Server
echo ========================================
echo.
echo Frontend will be available at: http://localhost:8080
echo.
echo Make sure you have:
echo   1. Created a Supabase project
echo   2. Run the database schema SQL
echo   3. Configured js/config.js with your credentials
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

python -m http.server 8080

