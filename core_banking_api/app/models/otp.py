"""
OTP model for one-time passwords
"""

from sqlalchemy import Column, String, Integer, ForeignKey, DateTime, Boolean
from sqlalchemy.orm import relationship
from app.models.base import BaseModel

class OTP(BaseModel):
    """OTP model for one-time passwords"""
    __tablename__ = "otps"
    
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    phone = Column(String(20), nullable=False)
    code = Column(String(10), nullable=False)
    is_used = Column(Boolean, default=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    
    # Relationships
    user = relationship("User", back_populates="otps")
