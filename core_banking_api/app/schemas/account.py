"""
Account schemas
"""

from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime
from decimal import Decimal

class AccountCreate(BaseModel):
    """Account creation schema"""
    member_id: int
    account_type: str
    minimum_balance: Decimal = 0.00
    interest_rate: Decimal = 0.0000

class AccountUpdate(BaseModel):
    """Account update schema"""
    minimum_balance: Optional[Decimal] = None
    interest_rate: Optional[Decimal] = None
    status: Optional[str] = None

class AccountResponse(BaseModel):
    """Account response schema"""
    id: int
    account_number: str
    member_id: int
    account_type: str
    balance: Decimal
    available_balance: Decimal
    status: str
    open_date: date
    close_date: Optional[date]
    minimum_balance: Decimal
    interest_rate: Decimal
    created_at: datetime
    
    class Config:
        from_attributes = True

class AccountBalance(BaseModel):
    """Account balance schema"""
    account_number: str
    balance: Decimal
    available_balance: Decimal
    currency: str = "KES"
