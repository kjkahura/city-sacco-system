# 🆘 Help - Backend Not Starting

## Quick Diagnosis

Run this command to see what's missing:
```bash
python test_imports.py
```

## The Problem

Your backend isn't starting because **Python packages aren't installed**.

## The Solution (3 Options)

### Option 1: Quick Install (Try This First)
```bash
python -m pip install -r requirements.txt
```

### Option 2: Virtual Environment (Most Reliable)
```bash
# Create virtual environment
python -m venv venv

# Activate it (PowerShell)
.\venv\Scripts\Activate.ps1

# Install packages
pip install -r requirements.txt

# Then start backend
start_local.bat
```

### Option 3: Manual Install (If others fail)
```bash
python -m pip install sqlalchemy fastapi "uvicorn[standard]" pydantic pydantic-settings "python-jose[cryptography]" "passlib[bcrypt]" python-multipart apscheduler python-dotenv httpx
```

## Verify It Worked

After installing, test:
```bash
python test_imports.py
```

Should show: ✅ All packages are installed!

## Start the Backend

Once packages are installed:
```bash
start_local.bat
```

Then open: http://localhost:8000/docs

## Still Stuck?

1. **Check Python version**: `python --version` (should be 3.11+)
2. **Check pip**: `python -m pip --version`
3. **Try virtual environment** (Option 2 above) - this usually fixes everything
4. **Check TROUBLESHOOTING.md** for more detailed help

## What's Already Working ✅

- ✅ All code is correct
- ✅ Database schema is linked
- ✅ All imports are fixed
- ✅ Configuration is set up

**You just need to install the Python packages!**
