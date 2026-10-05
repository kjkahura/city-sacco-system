"""
Authentication endpoints
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import random
import string
from jose import JWTError, jwt

from app.core.database import get_db
from app.core.redis_client import get_redis
from app.core.config import settings
from app.models.user import User
from app.schemas.auth import OTPRequest, OTPVerify, Token, UserLogin, UserCreate, UserResponse

router = APIRouter()
security = HTTPBearer()

def generate_otp(length: int = 6) -> str:
    """Generate OTP code"""
    return ''.join(random.choices(string.digits, k=length))

def create_access_token(data: dict, expires_delta: timedelta = None):
    """Create JWT access token"""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt

@router.post("/otp/send")
async def send_otp(otp_request: OTPRequest, db: Session = Depends(get_db), redis_client = Depends(get_redis)):
    """Send OTP to phone number"""
    
    # Check if user exists
    user = db.query(User).filter(User.phone == otp_request.phone).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    # Generate OTP
    otp_code = generate_otp()
    
    # Store OTP in Redis with expiration
    otp_key = f"otp:{otp_request.phone}"
    redis_client.setex(otp_key, settings.OTP_EXPIRE_MINUTES * 60, otp_code)
    
    # In a real application, you would send SMS here
    print(f"OTP for {otp_request.phone}: {otp_code}")
    
    return {
        "message": "OTP sent successfully",
        "phone": otp_request.phone,
        "expires_in": settings.OTP_EXPIRE_MINUTES * 60
    }

@router.post("/otp/verify")
async def verify_otp(otp_verify: OTPVerify, db: Session = Depends(get_db), redis_client = Depends(get_redis)):
    """Verify OTP and return access token"""
    
    # Check OTP in Redis
    otp_key = f"otp:{otp_verify.phone}"
    stored_otp = redis_client.get(otp_key)
    
    if not stored_otp or stored_otp != otp_verify.code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired OTP"
        )
    
    # Get user
    user = db.query(User).filter(User.phone == otp_verify.phone).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    # Create access token
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username, "user_id": user.id},
        expires_delta=access_token_expires
    )
    
    # Delete OTP from Redis
    redis_client.delete(otp_key)
    
    # Update last login
    user.last_login = datetime.utcnow()
    db.commit()
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "user": UserResponse.from_orm(user)
    }

@router.post("/login")
async def login(user_login: UserLogin, db: Session = Depends(get_db)):
    """Login with username and password"""
    
    # Get user
    user = db.query(User).filter(User.username == user_login.username).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials"
        )
    
    # In a real application, you would verify the password hash here
    # For demo purposes, we'll skip password verification
    
    # Create access token
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username, "user_id": user.id},
        expires_delta=access_token_expires
    )
    
    # Update last login
    user.last_login = datetime.utcnow()
    db.commit()
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "user": UserResponse.from_orm(user)
    }

@router.post("/register", response_model=UserResponse)
async def register(user_create: UserCreate, db: Session = Depends(get_db)):
    """Register a new user"""
    
    # Check if user already exists
    existing_user = db.query(User).filter(
        (User.username == user_create.username) |
        (User.email == user_create.email) |
        (User.phone == user_create.phone)
    ).first()
    
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User already exists"
        )
    
    # Create new user
    # In a real application, you would hash the password here
    user = User(
        username=user_create.username,
        email=user_create.email,
        phone=user_create.phone,
        hashed_password=user_create.password,  # This should be hashed
        full_name=user_create.full_name,
        role=user_create.role
    )
    
    db.add(user)
    db.commit()
    db.refresh(user)
    
    return UserResponse.from_orm(user)
