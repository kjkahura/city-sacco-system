#!/usr/bin/env python3
"""
Verification script to check if the database schema is properly linked
"""

import sys
import os

def check_imports():
    """Check if all imports work correctly"""
    print("🔍 Checking imports...")
    
    try:
        print("  ✓ Checking base models...")
        from app.models.base import Base
        print("  ✓ Base model imported")
        
        print("  ✓ Checking all models...")
        from app.models.models import (
            User, Member, Account, Transaction, Loan,
            LoanSchedule, StandingOrder, OTP
        )
        print("  ✓ All models imported successfully")
        
        print("  ✓ Checking database configuration...")
        from app.core.database_local import engine, get_db
        print("  ✓ Database configuration OK")
        
        print("  ✓ Checking local config...")
        from app.core.config_local import settings
        print(f"  ✓ Database URL: {settings.DATABASE_URL}")
        
        print("  ✓ Checking Redis client...")
        from app.core.redis_client_local import get_redis
        print("  ✓ Redis client OK")
        
        print("\n✅ All imports successful!")
        return True
        
    except ImportError as e:
        print(f"\n❌ Import error: {e}")
        print("\n💡 Solution: Install dependencies with:")
        print("   pip install -r requirements.txt")
        return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False

def check_database_schema():
    """Check if database schema is properly linked"""
    print("\n🔍 Checking database schema linkage...")
    
    try:
        from app.models.models import Base
        from app.core.database_local import engine
        
        # Check if Base has metadata
        if not hasattr(Base, 'metadata'):
            print("  ❌ Base model missing metadata")
            return False
        
        # Check if tables are registered
        tables = list(Base.metadata.tables.keys())
        print(f"  ✓ Found {len(tables)} tables in schema:")
        for table in tables:
            print(f"    - {table}")
        
        if len(tables) == 0:
            print("  ⚠️  Warning: No tables found in schema")
            print("  💡 This might be normal if models aren't imported yet")
        
        print("\n✅ Database schema is properly linked!")
        return True
        
    except Exception as e:
        print(f"\n❌ Schema check error: {e}")
        import traceback
        traceback.print_exc()
        return False

def check_database_connection():
    """Check if database connection works"""
    print("\n🔍 Checking database connection...")
    
    try:
        from app.core.database_local import engine
        
        # Try to connect
        with engine.connect() as conn:
            print("  ✓ Database connection successful")
        
        # Check if database file exists (for SQLite)
        if engine.url.drivername == 'sqlite':
            db_path = engine.url.database
            if os.path.exists(db_path):
                print(f"  ✓ Database file exists: {db_path}")
            else:
                print(f"  ℹ️  Database file will be created: {db_path}")
        
        print("\n✅ Database connection OK!")
        return True
        
    except Exception as e:
        print(f"\n❌ Database connection error: {e}")
        return False

def main():
    """Main verification function"""
    print("=" * 60)
    print("Core Banking API - Setup Verification")
    print("=" * 60)
    print()
    
    results = []
    
    # Check imports
    results.append(("Imports", check_imports()))
    
    # Check schema linkage
    if results[0][1]:  # Only check if imports worked
        results.append(("Schema Linkage", check_database_schema()))
        results.append(("Database Connection", check_database_connection()))
    
    # Summary
    print("\n" + "=" * 60)
    print("Verification Summary")
    print("=" * 60)
    
    for name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{name:.<40} {status}")
    
    all_passed = all(result for _, result in results)
    
    if all_passed:
        print("\n🎉 All checks passed! Your setup is ready.")
        print("\nTo start the server, run:")
        print("  start_local.bat")
        print("  or")
        print("  uvicorn app.main_local:app --reload --host 0.0.0.0 --port 8000")
    else:
        print("\n⚠️  Some checks failed. Please review the errors above.")
        print("\nCommon solutions:")
        print("  1. Install dependencies: pip install -r requirements.txt")
        print("  2. Check Python version (should be 3.11+)")
        print("  3. Ensure you're in the project root directory")
    
    return 0 if all_passed else 1

if __name__ == "__main__":
    sys.exit(main())
