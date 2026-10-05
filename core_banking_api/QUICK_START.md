# Quick Start Guide - Backend Not Starting

## Issue: Dependencies Not Installed

The backend isn't starting because Python packages aren't installed.

## Solution: Install Dependencies

### Option 1: Run the Installation Script (Recommended)

1. Open PowerShell or Command Prompt
2. Navigate to the project:
   ```bash
   cd C:\Users\Lenovo\core_banking_api
   ```
3. Run the installation script:
   ```bash
   .\install_dependencies.bat
   ```
   **Note**: This will take a few minutes. Let it complete!

### Option 2: Manual Installation

Run these commands one by one:

```bash
python -m pip install sqlalchemy==2.0.23
python -m pip install fastapi==0.104.1
python -m pip install uvicorn[standard]==0.24.0
python -m pip install pydantic==2.5.0
python -m pip install pydantic-settings==2.1.0
python -m pip install python-jose[cryptography]==3.3.0
python -m pip install passlib[bcrypt]==1.7.4
python -m pip install python-multipart==0.0.6
python -m pip install apscheduler==3.10.4
python -m pip install python-dotenv==1.0.0
python -m pip install httpx==0.25.2
```

### Option 3: Install from requirements.txt

```bash
python -m pip install -r requirements.txt
```

## Verify Installation

After installation, verify it worked:

```bash
python verify_setup.py
```

You should see:
```
✅ All checks passed! Your setup is ready.
```

## Start the Backend

Once dependencies are installed:

```bash
start_local.bat
```

Or manually:
```bash
uvicorn app.main_local:app --reload --host 0.0.0.0 --port 8000
```

## Common Issues

### Issue: "No module named 'sqlalchemy'"
**Solution**: Dependencies aren't installed. Run the installation script above.

### Issue: Installation takes too long
**Solution**: This is normal. The first installation can take 5-10 minutes. Be patient!

### Issue: Permission errors
**Solution**: Try installing with `--user` flag:
```bash
python -m pip install --user -r requirements.txt
```

### Issue: Multiple Python versions
**Solution**: Make sure you're using the correct Python. Check with:
```bash
python --version
python -m pip --version
```

## What Was Fixed

✅ Database schema is properly linked
✅ Missing imports fixed (Integer in member.py and account.py)
✅ Local database configuration created
✅ Redis fallback for local development
✅ All models properly imported

The only remaining issue is installing the Python packages!
