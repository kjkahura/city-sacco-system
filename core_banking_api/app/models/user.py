"""
User model for authentication and authorization
"""

from sqlalchemy import Column, String, Boolean, DateTime, Enum
from sqlalchemy.orm import relationship
from app.models.base import BaseModel
import enum

class UserRole(str, enum.Enum):
    ADMIN = "admin"
    TELLER = "teller"
    LOAN_OFFICER = "loan_officer"
    MEMBER = "member"

class User(BaseModel):
    """User model for system users"""
    __tablename__ = "users"
    
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=False)
    phone = Column(String(20), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(100), nullable=False)
    role = Column(Enum(UserRole), default=UserRole.MEMBER)
    is_verified = Column(Boolean, default=False)
    last_login = Column(DateTime(timezone=True))
    
    # Relationships
    otps = relationship("OTP", back_populates="user")
    transactions = relationship("Transaction", back_populates="user")
