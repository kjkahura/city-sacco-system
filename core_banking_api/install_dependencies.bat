@echo off
echo ========================================
echo Installing Core Banking API Dependencies
echo ========================================
echo.

python -m pip install --upgrade pip
echo.

echo Installing core dependencies...
python -m pip install sqlalchemy==2.0.23
python -m pip install fastapi==0.104.1
python -m pip install uvicorn[standard]==0.24.0
python -m pip install pydantic==2.5.0
python -m pip install pydantic-settings==2.1.0
echo.

echo Installing authentication dependencies...
python -m pip install python-jose[cryptography]==3.3.0
python -m pip install passlib[bcrypt]==1.7.4
python -m pip install python-multipart==0.0.6
echo.

echo Installing other dependencies...
python -m pip install apscheduler==3.10.4
python -m pip install python-dotenv==1.0.0
python -m pip install httpx==0.25.2
echo.

echo ========================================
echo Installation Complete!
echo ========================================
echo.
echo Verifying installation...
python -c "import sqlalchemy; import fastapi; import uvicorn; print('✅ All core packages installed successfully!')"
echo.
pause
