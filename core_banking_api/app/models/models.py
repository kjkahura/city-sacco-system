"""
Import all models to ensure they are registered with SQLAlchemy
"""

from app.models.base import Base
from app.models.user import User, UserRole
from app.models.member import Member, MemberStatus
from app.models.account import Account, AccountType, AccountStatus
from app.models.transaction import Transaction, TransactionType, TransactionStatus
from app.models.loan import Loan, LoanStatus, LoanType
from app.models.loan_schedule import LoanSchedule, PaymentStatus
from app.models.standing_order import StandingOrder, StandingOrderStatus, StandingOrderFrequency
from app.models.otp import OTP

__all__ = [
    "Base",
    "User", "UserRole",
    "Member", "MemberStatus", 
    "Account", "AccountType", "AccountStatus",
    "Transaction", "TransactionType", "TransactionStatus",
    "Loan", "LoanStatus", "LoanType",
    "LoanSchedule", "PaymentStatus",
    "StandingOrder", "StandingOrderStatus", "StandingOrderFrequency",
    "OTP"
]
