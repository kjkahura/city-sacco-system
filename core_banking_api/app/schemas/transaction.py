"""
Transaction schemas
"""

from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime
from decimal import Decimal

class TransactionCreate(BaseModel):
    """Transaction creation schema"""
    account_id: int
    transaction_type: str
    amount: Decimal
    description: Optional[str] = None
    reference: Optional[str] = None
    to_account_id: Optional[int] = None

class TransactionResponse(BaseModel):
    """Transaction response schema"""
    id: int
    transaction_id: str
    account_id: int
    transaction_type: str
    amount: Decimal
    balance_after: Decimal
    status: str
    description: Optional[str]
    reference: Optional[str]
    transaction_date: date
    to_account_id: Optional[int]
    created_at: datetime
    
    class Config:
        from_attributes = True

class DepositRequest(BaseModel):
    """Deposit request schema"""
    account_number: str
    amount: Decimal
    description: Optional[str] = None
    reference: Optional[str] = None

class WithdrawalRequest(BaseModel):
    """Withdrawal request schema"""
    account_number: str
    amount: Decimal
    description: Optional[str] = None
    reference: Optional[str] = None

class TransferRequest(BaseModel):
    """Transfer request schema"""
    from_account_number: str
    to_account_number: str
    amount: Decimal
    description: Optional[str] = None
    reference: Optional[str] = None
