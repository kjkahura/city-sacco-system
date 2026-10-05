"""
Transaction model for financial transactions
"""

from sqlalchemy import Column, Integer, String, Numeric, Enum, ForeignKey, Date, Text
from sqlalchemy.orm import relationship
from app.models.base import BaseModel
import enum

class TransactionType(str, enum.Enum):
    DEPOSIT = "deposit"
    WITHDRAWAL = "withdrawal"
    TRANSFER = "transfer"
    LOAN_DISBURSEMENT = "loan_disbursement"
    LOAN_REPAYMENT = "loan_repayment"
    INTEREST_ACCRUAL = "interest_accrual"
    FEE = "fee"
    REFUND = "refund"

class TransactionStatus(str, enum.Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class Transaction(BaseModel):
    """Transaction model for financial transactions"""
    __tablename__ = "transactions"
    
    transaction_id = Column(String(50), unique=True, index=True, nullable=False)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"))
    transaction_type = Column(Enum(TransactionType), nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    balance_after = Column(Numeric(15, 2), nullable=False)
    status = Column(Enum(TransactionStatus), default=TransactionStatus.PENDING)
    description = Column(Text)
    reference = Column(String(100))
    transaction_date = Column(Date, nullable=False)
    
    # For transfers
    to_account_id = Column(Integer, ForeignKey("accounts.id"))
    
    # Relationships
    account = relationship("Account", back_populates="transactions", foreign_keys=[account_id])
    user = relationship("User", back_populates="transactions")
    to_account = relationship("Account", foreign_keys=[to_account_id])
