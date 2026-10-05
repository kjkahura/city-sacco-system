# Simple Setup Guide - Get Your Backend Running

## The Problem
Your pip installation has an issue (invalid distribution ~ip), which is preventing packages from installing.

## The Solution: Use Virtual Environment

A virtual environment will create a clean Python environment just for this project.

### Quick Setup (3 Steps)

1. **Run the setup script**:
   ```bash
   .\setup_venv.bat
   ```
   This will:
   - Create a virtual environment
   - Install all packages
   - Verify everything works

2. **Activate the virtual environment** (when you want to use the backend):
   ```bash
   venv\Scripts\activate.bat
   ```

3. **Start the backend**:
   ```bash
   start_local.bat
   ```

### Manual Setup (If script doesn't work)

```bash
# Step 1: Create virtual environment
python -m venv venv

# Step 2: Activate it
venv\Scripts\activate.bat

# Step 3: Install packages
pip install -r requirements.txt

# Step 4: Verify
python test_imports.py

# Step 5: Start backend
start_local.bat
```

## After Setup

Once the virtual environment is set up:

1. **Always activate it first**:
   ```bash
   venv\Scripts\activate.bat
   ```
   You'll see `(venv)` in your prompt when it's active.

2. **Then start the backend**:
   ```bash
   start_local.bat
   ```

3. **Open in browser**:
   - API Docs: http://localhost:8000/docs
   - Frontend: http://localhost:8080 (after starting frontend server)

## Why Virtual Environment?

- ✅ Isolates your project dependencies
- ✅ Avoids conflicts with system Python
- ✅ Fixes the pip distribution issue
- ✅ More reliable installation

## Troubleshooting

### "venv\Scripts\activate.bat not found"
**Solution**: Make sure you're in the project directory:
```bash
cd C:\Users\Lenovo\core_banking_api
```

### "python -m venv venv" fails
**Solution**: Make sure Python is installed correctly:
```bash
python --version
```

### Packages still not installing
**Solution**: Try installing one at a time:
```bash
venv\Scripts\activate.bat
pip install sqlalchemy
pip install fastapi
# etc...
```

## What's Already Done ✅

- ✅ All code is correct
- ✅ Database schema is linked
- ✅ All imports are fixed
- ✅ Configuration is ready

**You just need to install packages in a virtual environment!**
