#!/usr/bin/env python3
"""
Local development runner for Core Banking API
"""

import os
import sys
import subprocess
from pathlib import Path

def setup_environment():
    """Set up environment variables for local development"""
    env_vars = {
        'DATABASE_URL': 'sqlite:///./banking_db.db',
        'SECRET_KEY': 'your-secret-key-change-in-production-12345',
        'ALGORITHM': 'HS256',
        'ACCESS_TOKEN_EXPIRE_MINUTES': '30',
        'OTP_EXPIRE_MINUTES': '5',
        'OTP_LENGTH': '6',
        'ENVIRONMENT': 'development',
        'DEBUG': 'true'
    }
    
    for key, value in env_vars.items():
        os.environ[key] = value
    
    print("✅ Environment variables set for local development")

def install_dependencies():
    """Install required dependencies"""
    print("📦 Installing dependencies...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])
        print("✅ Dependencies installed successfully")
    except subprocess.CalledProcessError as e:
        print(f"❌ Error installing dependencies: {e}")
        return False
    return True

def run_server():
    """Run the FastAPI server"""
    print("🚀 Starting Core Banking API server...")
    print("📍 Server will be available at: http://localhost:8000")
    print("📚 API Documentation: http://localhost:8000/docs")
    print("📖 ReDoc: http://localhost:8000/redoc")
    print("\n" + "="*50)
    print("Press Ctrl+C to stop the server")
    print("="*50 + "\n")
    
    try:
        subprocess.run([
            sys.executable, "-m", "uvicorn", 
            "app.main_local:app", 
            "--reload", 
            "--host", "0.0.0.0", 
            "--port", "8000"
        ])
    except KeyboardInterrupt:
        print("\n🛑 Server stopped by user")
    except Exception as e:
        print(f"❌ Error running server: {e}")

def main():
    """Main function"""
    print("🏦 Core Banking API - Local Development Setup")
    print("=" * 50)
    
    # Check if we're in the right directory
    if not Path("requirements.txt").exists():
        print("❌ Error: requirements.txt not found. Please run this script from the project root directory.")
        sys.exit(1)
    
    # Setup environment
    setup_environment()
    
    # Install dependencies
    if not install_dependencies():
        sys.exit(1)
    
    # Run server
    run_server()

if __name__ == "__main__":
    main()
