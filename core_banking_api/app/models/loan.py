"""
Loan model for loan management
"""

from sqlalchemy import Column, String, Numeric, Enum, ForeignKey, Date, Integer, Text
from sqlalchemy.orm import relationship
from app.models.base import BaseModel
import enum

class LoanStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DISBURSED = "disbursed"
    ACTIVE = "active"
    COMPLETED = "completed"
    DEFAULTED = "defaulted"
    WRITTEN_OFF = "written_off"

class LoanType(str, enum.Enum):
    PERSONAL = "personal"
    BUSINESS = "business"
    EMERGENCY = "emergency"
    EDUCATION = "education"
    AGRICULTURE = "agriculture"

class Loan(BaseModel):
    """Loan model for loan management"""
    __tablename__ = "loans"
    
    loan_number = Column(String(20), unique=True, index=True, nullable=False)
    member_id = Column(Integer, ForeignKey("members.id"), nullable=False)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    loan_type = Column(Enum(LoanType), nullable=False)
    principal_amount = Column(Numeric(15, 2), nullable=False)
    interest_rate = Column(Numeric(5, 4), nullable=False)  # Annual interest rate
    term_months = Column(Integer, nullable=False)
    monthly_payment = Column(Numeric(15, 2), nullable=False)
    outstanding_principal = Column(Numeric(15, 2), nullable=False)
    outstanding_interest = Column(Numeric(15, 2), default=0.00)
    total_outstanding = Column(Numeric(15, 2), nullable=False)
    status = Column(Enum(LoanStatus), default=LoanStatus.PENDING)
    application_date = Column(Date, nullable=False)
    approval_date = Column(Date)
    disbursement_date = Column(Date)
    maturity_date = Column(Date)
    purpose = Column(Text)
    collateral_description = Column(Text)
    guarantor_name = Column(String(100))
    guarantor_phone = Column(String(20))
    
    # Relationships
    member = relationship("Member", back_populates="loans")
    account = relationship("Account", back_populates="loan")
    loan_schedules = relationship("LoanSchedule", back_populates="loan")
