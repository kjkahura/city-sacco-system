@echo off
echo ========================================
echo Setting up Virtual Environment
echo ========================================
echo.

echo Step 1: Creating virtual environment...
python -m venv venv
if errorlevel 1 (
    echo ERROR: Failed to create virtual environment
    pause
    exit /b 1
)

echo.
echo Step 2: Activating virtual environment...
call venv\Scripts\activate.bat

echo.
echo Step 3: Upgrading pip...
python -m pip install --upgrade pip

echo.
echo Step 4: Installing dependencies...
echo This may take a few minutes, please wait...
python -m pip install sqlalchemy fastapi "uvicorn[standard]" pydantic pydantic-settings "python-jose[cryptography]" "passlib[bcrypt]" python-multipart apscheduler python-dotenv httpx

echo.
echo Step 5: Verifying installation...
python test_imports.py

echo.
echo ========================================
echo Setup Complete!
echo ========================================
echo.
echo To activate the virtual environment in the future, run:
echo   venv\Scripts\activate.bat
echo.
echo Then start the backend with:
echo   start_local.bat
echo.
pause
