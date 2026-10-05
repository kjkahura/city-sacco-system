# Troubleshooting Guide - Backend Not Starting

## Current Issue: Dependencies Not Installing

The backend can't start because Python packages aren't being installed properly.

## Step-by-Step Solution

### Step 1: Check Python Installation

```bash
python --version
```

Should show: `Python 3.11.x` or `Python 3.13.x`

### Step 2: Fix Invalid Distribution Warning

There's a warning about invalid distribution `~ip`. Let's fix it:

```bash
# Remove the invalid distribution
python -m pip uninstall -y ~ip

# Or manually delete if needed:
# C:\Users\Lenovo\AppData\Local\Programs\Python\Python313\Lib\site-packages\~ip
```

### Step 3: Install Dependencies (Choose One Method)

#### Method A: Install All at Once
```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

#### Method B: Install One by One (More Reliable)
```bash
python -m pip install sqlalchemy
python -m pip install fastapi
python -m pip install "uvicorn[standard]"
python -m pip install pydantic
python -m pip install pydantic-settings
python -m pip install "python-jose[cryptography]"
python -m pip install "passlib[bcrypt]"
python -m pip install python-multipart
python -m pip install apscheduler
python -m pip install python-dotenv
python -m pip install httpx
```

#### Method C: Use Virtual Environment (Recommended)
```bash
# Create virtual environment
python -m venv venv

# Activate it
.\venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt
```

### Step 4: Verify Installation

```bash
python verify_setup.py
```

Or test manually:
```bash
python -c "import sqlalchemy; import fastapi; import uvicorn; print('✅ All packages installed!')"
```

### Step 5: Start the Backend

```bash
start_local.bat
```

Or:
```bash
uvicorn app.main_local:app --reload --host 0.0.0.0 --port 8000
```

## Common Issues & Solutions

### Issue 1: "No module named 'sqlalchemy'"
**Cause**: Packages not installed  
**Solution**: Run Step 3 above

### Issue 2: Permission Denied
**Cause**: Need admin rights or user install  
**Solution**: 
```bash
python -m pip install --user -r requirements.txt
```

### Issue 3: Invalid Distribution Warning
**Cause**: Corrupted pip installation  
**Solution**: 
```bash
python -m pip install --upgrade --force-reinstall pip
```

### Issue 4: Multiple Python Versions
**Cause**: Multiple Python installations  
**Solution**: Use full path:
```bash
C:\Users\Lenovo\AppData\Local\Programs\Python\Python313\python.exe -m pip install -r requirements.txt
```

### Issue 5: Installation Takes Forever
**Cause**: Slow internet or large packages  
**Solution**: 
- Wait patiently (can take 5-10 minutes)
- Use `--no-cache-dir` flag
- Check internet connection

## Quick Test Script

Run this to test if everything works:

```bash
python test_imports.py
```

## What's Already Fixed ✅

- ✅ Database schema properly linked
- ✅ All model imports fixed
- ✅ Local database configuration created
- ✅ Redis fallback implemented
- ✅ All code issues resolved

**The ONLY remaining issue is installing Python packages!**

## Still Having Issues?

1. **Check Python Path**:
   ```bash
   python -c "import sys; print(sys.executable)"
   ```

2. **Check Installed Packages**:
   ```bash
   python -m pip list
   ```

3. **Try Virtual Environment** (Most Reliable):
   ```bash
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

4. **Check for Errors**:
   ```bash
   python -m pip install sqlalchemy -v
   ```

## Next Steps After Installation

Once packages are installed:

1. ✅ Run `python verify_setup.py` - should show all checks passed
2. ✅ Run `start_local.bat` - backend should start
3. ✅ Open `http://localhost:8000/docs` - API docs should load
4. ✅ Start frontend: `cd frontend && start_server.bat`
5. ✅ Open `http://localhost:8080` - frontend should load
