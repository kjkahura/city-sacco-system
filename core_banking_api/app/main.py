"""
FastAPI Core Banking API
========================

A comprehensive core banking system for SACCOs and MFIs with:
- OTP/JWT authentication
- Member and account management
- Teller operations (deposit, withdraw, transfer)
- Loan lifecycle management
- USSD simulator
- Background task scheduling
"""

from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer
from contextlib import asynccontextmanager
import redis
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.config import settings
from app.core.database import get_db, engine
from app.core.redis_client import get_redis
from app.models.models import Base
from app.api.v1.api import api_router
from app.core.scheduler import scheduler
from app.utils.seed import seed_database

# Create database tables
Base.metadata.create_all(bind=engine)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    # Startup
    print("🚀 Starting Core Banking API...")
    
    # Start scheduler
    scheduler.start()
    print("📅 Background scheduler started")
    
    # Seed database with demo data
    try:
        await seed_database()
        print("🌱 Database seeded with demo data")
    except Exception as e:
        print(f"⚠️  Warning: Could not seed database: {e}")
    
    yield
    
    # Shutdown
    print("🛑 Shutting down Core Banking API...")
    scheduler.shutdown()
    print("📅 Background scheduler stopped")

# Create FastAPI app
app = FastAPI(
    title="Core Banking API",
    description="A comprehensive core banking system for SACCOs and MFIs",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API router
app.include_router(api_router, prefix="/api/v1")

@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "message": "Welcome to Core Banking API",
        "version": "1.0.0",
        "docs": "/docs",
        "redoc": "/redoc"
    }

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "Core Banking API",
        "version": "1.0.0"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True
    )
