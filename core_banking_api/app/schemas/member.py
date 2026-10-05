"""
Member schemas
"""

from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime
from decimal import Decimal

class MemberCreate(BaseModel):
    """Member creation schema"""
    first_name: str
    last_name: str
    middle_name: Optional[str] = None
    email: Optional[str] = None
    phone: str
    id_number: str
    date_of_birth: date
    gender: str
    address: str
    occupation: Optional[str] = None
    employer: Optional[str] = None
    monthly_income: Optional[Decimal] = None

class MemberUpdate(BaseModel):
    """Member update schema"""
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    middle_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    occupation: Optional[str] = None
    employer: Optional[str] = None
    monthly_income: Optional[Decimal] = None

class MemberResponse(BaseModel):
    """Member response schema"""
    id: int
    member_number: str
    first_name: str
    last_name: str
    middle_name: Optional[str]
    email: Optional[str]
    phone: str
    id_number: str
    date_of_birth: date
    gender: str
    address: str
    occupation: Optional[str]
    employer: Optional[str]
    monthly_income: Optional[Decimal]
    status: str
    join_date: date
    created_at: datetime
    
    class Config:
        from_attributes = True
