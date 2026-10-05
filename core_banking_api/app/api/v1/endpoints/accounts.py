"""
Account management endpoints
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from datetime import date

from app.core.database import get_db
from app.models.account import Account
from app.models.member import Member
from app.schemas.account import AccountCreate, AccountUpdate, AccountResponse, AccountBalance

router = APIRouter()

@router.get("/", response_model=List[AccountResponse])
async def get_accounts(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db)
):
    """Get all accounts"""
    accounts = db.query(Account).offset(skip).limit(limit).all()
    return accounts

@router.get("/{account_id}", response_model=AccountResponse)
async def get_account(account_id: int, db: Session = Depends(get_db)):
    """Get account by ID"""
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    return account

@router.get("/number/{account_number}", response_model=AccountResponse)
async def get_account_by_number(account_number: str, db: Session = Depends(get_db)):
    """Get account by account number"""
    account = db.query(Account).filter(Account.account_number == account_number).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    return account

@router.get("/{account_id}/balance", response_model=AccountBalance)
async def get_account_balance(account_id: int, db: Session = Depends(get_db)):
    """Get account balance"""
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    
    return AccountBalance(
        account_number=account.account_number,
        balance=account.balance,
        available_balance=account.available_balance
    )

@router.post("/", response_model=AccountResponse)
async def create_account(account_create: AccountCreate, db: Session = Depends(get_db)):
    """Create a new account"""
    
    # Check if member exists
    member = db.query(Member).filter(Member.id == account_create.member_id).first()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member not found"
        )
    
    # Generate account number
    account_count = db.query(Account).count()
    account_number = f"ACC{account_count + 1:08d}"
    
    # Create new account
    account = Account(
        account_number=account_number,
        member_id=account_create.member_id,
        account_type=account_create.account_type,
        minimum_balance=account_create.minimum_balance,
        interest_rate=account_create.interest_rate,
        open_date=date.today()
    )
    
    db.add(account)
    db.commit()
    db.refresh(account)
    
    return account

@router.put("/{account_id}", response_model=AccountResponse)
async def update_account(
    account_id: int,
    account_update: AccountUpdate,
    db: Session = Depends(get_db)
):
    """Update account information"""
    
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    
    # Update fields
    update_data = account_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(account, field, value)
    
    db.commit()
    db.refresh(account)
    
    return account

@router.delete("/{account_id}")
async def delete_account(account_id: int, db: Session = Depends(get_db)):
    """Delete account (soft delete)"""
    
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    
    # Soft delete
    account.is_active = False
    db.commit()
    
    return {"message": "Account deleted successfully"}
