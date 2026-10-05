"""
API v1 router
"""

from fastapi import APIRouter
from app.api.v1.endpoints import auth, members, accounts, transactions, loans, ussd

api_router = APIRouter()

# Include all endpoint routers
api_router.include_router(auth.router, prefix="/auth", tags=["authentication"])
api_router.include_router(members.router, prefix="/members", tags=["members"])
api_router.include_router(accounts.router, prefix="/accounts", tags=["accounts"])
api_router.include_router(transactions.router, prefix="/transactions", tags=["transactions"])
api_router.include_router(loans.router, prefix="/loans", tags=["loans"])
api_router.include_router(ussd.router, prefix="/ussd", tags=["ussd"])
