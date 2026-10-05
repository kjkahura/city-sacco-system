"""
Standing order model for recurring payments
"""

from sqlalchemy import Column, String, Numeric, Enum, ForeignKey, Date, Integer, Text
from sqlalchemy.orm import relationship
from app.models.base import BaseModel
import enum

class StandingOrderStatus(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    COMPLETED = "completed"
    CANCELLED = "cancelled"

class StandingOrderFrequency(str, enum.Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    YEARLY = "yearly"

class StandingOrder(BaseModel):
    """Standing order model for recurring payments"""
    __tablename__ = "standing_orders"
    
    member_id = Column(Integer, ForeignKey("members.id"), nullable=False)
    from_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    to_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    frequency = Column(Enum(StandingOrderFrequency), nullable=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date)
    next_execution_date = Column(Date, nullable=False)
    description = Column(Text)
    status = Column(Enum(StandingOrderStatus), default=StandingOrderStatus.ACTIVE)
    
    # Relationships
    member = relationship("Member", back_populates="standing_orders")
    from_account = relationship("Account", foreign_keys=[from_account_id])
    to_account = relationship("Account", foreign_keys=[to_account_id])
