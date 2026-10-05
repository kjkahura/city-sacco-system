"""
Account model for member accounts
"""

from sqlalchemy import Column, String, Numeric, Enum, ForeignKey, Date, Integer
from sqlalchemy.orm import relationship
from app.models.base import BaseModel
import enum

class AccountType(str, enum.Enum):
    SAVINGS = "savings"
    CURRENT = "current"
    FIXED_DEPOSIT = "fixed_deposit"
    SHARE = "share"

class AccountStatus(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    FROZEN = "frozen"
    CLOSED = "closed"

class Account(BaseModel):
    """Account model for member accounts"""
    __tablename__ = "accounts"
    
    account_number = Column(String(20), unique=True, index=True, nullable=False)
    member_id = Column(Integer, ForeignKey("members.id"), nullable=False)
    account_type = Column(Enum(AccountType), nullable=False)
    balance = Column(Numeric(15, 2), default=0.00)
    available_balance = Column(Numeric(15, 2), default=0.00)
    status = Column(Enum(AccountStatus), default=AccountStatus.ACTIVE)
    open_date = Column(Date, nullable=False)
    close_date = Column(Date)
    minimum_balance = Column(Numeric(15, 2), default=0.00)
    interest_rate = Column(Numeric(5, 4), default=0.0000)  # Annual interest rate
    
    # Relationships
    member = relationship("Member", back_populates="accounts")
    transactions = relationship("Transaction", back_populates="account")
    loan = relationship("Loan", back_populates="account", uselist=False)
