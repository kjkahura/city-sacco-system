"""
Member model for SACCO members
"""

from sqlalchemy import Column, String, Date, Enum, Numeric, ForeignKey, Text, Integer
from sqlalchemy.orm import relationship
from app.models.base import BaseModel
import enum

class MemberStatus(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    SUSPENDED = "suspended"
    TERMINATED = "terminated"

class Member(BaseModel):
    """Member model for SACCO members"""
    __tablename__ = "members"
    
    member_number = Column(String(20), unique=True, index=True, nullable=False)
    first_name = Column(String(50), nullable=False)
    last_name = Column(String(50), nullable=False)
    middle_name = Column(String(50))
    email = Column(String(100), unique=True, index=True)
    phone = Column(String(20), unique=True, index=True, nullable=False)
    id_number = Column(String(20), unique=True, index=True, nullable=False)
    date_of_birth = Column(Date, nullable=False)
    gender = Column(String(10), nullable=False)
    address = Column(Text, nullable=False)
    occupation = Column(String(100))
    employer = Column(String(100))
    monthly_income = Column(Numeric(15, 2))
    status = Column(Enum(MemberStatus), default=MemberStatus.ACTIVE)
    join_date = Column(Date, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"))
    
    # Relationships
    user = relationship("User")
    accounts = relationship("Account", back_populates="member")
    loans = relationship("Loan", back_populates="member")
    standing_orders = relationship("StandingOrder", back_populates="member")
