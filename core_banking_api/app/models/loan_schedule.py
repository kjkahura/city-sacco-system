"""
Loan schedule model for loan repayment schedules
"""

from sqlalchemy import Column, String, Numeric, Enum, ForeignKey, Date, Integer
from sqlalchemy.orm import relationship
from app.models.base import BaseModel
import enum

class PaymentStatus(str, enum.Enum):
    PENDING = "pending"
    PAID = "paid"
    OVERDUE = "overdue"
    PARTIAL = "partial"

class LoanSchedule(BaseModel):
    """Loan schedule model for loan repayment schedules"""
    __tablename__ = "loan_schedules"
    
    loan_id = Column(Integer, ForeignKey("loans.id"), nullable=False)
    installment_number = Column(Integer, nullable=False)
    due_date = Column(Date, nullable=False)
    principal_amount = Column(Numeric(15, 2), nullable=False)
    interest_amount = Column(Numeric(15, 2), nullable=False)
    total_amount = Column(Numeric(15, 2), nullable=False)
    paid_principal = Column(Numeric(15, 2), default=0.00)
    paid_interest = Column(Numeric(15, 2), default=0.00)
    paid_total = Column(Numeric(15, 2), default=0.00)
    status = Column(Enum(PaymentStatus), default=PaymentStatus.PENDING)
    payment_date = Column(Date)
    
    # Relationships
    loan = relationship("Loan", back_populates="loan_schedules")
