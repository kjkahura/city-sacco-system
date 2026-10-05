"""
Authentication schemas
"""

from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime

class OTPRequest(BaseModel):
    """OTP request schema"""
    phone: str

class OTPVerify(BaseModel):
    """OTP verification schema"""
    phone: str
    code: str

class Token(BaseModel):
    """Token response schema"""
    access_token: str
    token_type: str
    expires_in: int

class UserLogin(BaseModel):
    """User login schema"""
    username: str
    password: str

class UserCreate(BaseModel):
    """User creation schema"""
    username: str
    email: EmailStr
    phone: str
    password: str
    full_name: str
    role: str = "member"

class UserResponse(BaseModel):
    """User response schema"""
    id: int
    username: str
    email: str
    phone: str
    full_name: str
    role: str
    is_verified: bool
    created_at: datetime
    
    class Config:
        from_attributes = True
