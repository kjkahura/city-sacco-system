#!/usr/bin/env python3
"""
Quick test script to check if all required packages are installed
"""

import sys

required_packages = [
    'sqlalchemy',
    'fastapi',
    'uvicorn',
    'pydantic',
    'pydantic_settings',
    'jose',
    'passlib',
    'apscheduler',
]

print("Testing required packages...")
print("=" * 50)

missing = []
installed = []

for package in required_packages:
    try:
        __import__(package)
        print(f"✅ {package:20} - INSTALLED")
        installed.append(package)
    except ImportError:
        print(f"❌ {package:20} - MISSING")
        missing.append(package)

print("=" * 50)
print(f"\nInstalled: {len(installed)}/{len(required_packages)}")
print(f"Missing: {len(missing)}/{len(required_packages)}")

if missing:
    print("\n❌ Missing packages detected!")
    print("\nTo install missing packages, run:")
    print("  python -m pip install " + " ".join(missing))
    print("\nOr install all at once:")
    print("  python -m pip install -r requirements.txt")
    sys.exit(1)
else:
    print("\n✅ All packages are installed!")
    print("\nYou can now start the backend with:")
    print("  start_local.bat")
    print("  or")
    print("  uvicorn app.main_local:app --reload")
    sys.exit(0)
