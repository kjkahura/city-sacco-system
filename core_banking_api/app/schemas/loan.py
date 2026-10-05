"""
Loan schemas
"""

from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime
from decimal import Decimal

class LoanApplication(BaseModel):
    """Loan application schema"""
    member_id: int
    account_id: int
    loan_type: str
    principal_amount: Decimal
    term_months: int
    purpose: Optional[str] = None
    collateral_description: Optional[str] = None
    guarantor_name: Optional[str] = None
    guarantor_phone: Optional[str] = None

class LoanApproval(BaseModel):
    """Loan approval schema"""
    interest_rate: Decimal
    approved_amount: Optional[Decimal] = None
    approved_term_months: Optional[int] = None

class LoanDisbursement(BaseModel):
    """Loan disbursement schema"""
    disbursement_amount: Decimal
    disbursement_date: date

class LoanRepayment(BaseModel):
    """Loan repayment schema"""
    loan_id: int
    amount: Decimal
    payment_type: str = "regular"  # regular, early, partial

class LoanResponse(BaseModel):
    """Loan response schema"""
    id: int
    loan_number: str
    member_id: int
    account_id: int
    loan_type: str
    principal_amount: Decimal
    interest_rate: Decimal
    term_months: int
    monthly_payment: Decimal
    outstanding_principal: Decimal
    outstanding_interest: Decimal
    total_outstanding: Decimal
    status: str
    application_date: date
    approval_date: Optional[date]
    disbursement_date: Optional[date]
    maturity_date: Optional[date]
    purpose: Optional[str]
    created_at: datetime
    
    class Config:
        from_attributes = True

class LoanScheduleResponse(BaseModel):
    """Loan schedule response schema"""
    id: int
    loan_id: int
    installment_number: int
    due_date: date
    principal_amount: Decimal
    interest_amount: Decimal
    total_amount: Decimal
    paid_principal: Decimal
    paid_interest: Decimal
    paid_total: Decimal
    status: str
    payment_date: Optional[date]
    
    class Config:
        from_attributes = True
