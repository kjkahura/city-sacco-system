"""
Transaction endpoints
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from datetime import date
import uuid

from app.core.database import get_db
from app.models.transaction import Transaction
from app.models.account import Account
from app.schemas.transaction import (
    TransactionCreate, TransactionResponse, 
    DepositRequest, WithdrawalRequest, TransferRequest
)

router = APIRouter()

@router.get("/", response_model=List[TransactionResponse])
async def get_transactions(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db)
):
    """Get all transactions"""
    transactions = db.query(Transaction).offset(skip).limit(limit).all()
    return transactions

@router.get("/{transaction_id}", response_model=TransactionResponse)
async def get_transaction(transaction_id: int, db: Session = Depends(get_db)):
    """Get transaction by ID"""
    transaction = db.query(Transaction).filter(Transaction.id == transaction_id).first()
    if not transaction:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Transaction not found"
        )
    return transaction

@router.post("/deposit")
async def deposit(deposit_request: DepositRequest, db: Session = Depends(get_db)):
    """Process deposit transaction"""
    
    # Get account
    account = db.query(Account).filter(Account.account_number == deposit_request.account_number).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    
    if account.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Account is not active"
        )
    
    # Update account balance
    account.balance += deposit_request.amount
    account.available_balance += deposit_request.amount
    
    # Create transaction
    transaction = Transaction(
        transaction_id=str(uuid.uuid4()),
        account_id=account.id,
        transaction_type="deposit",
        amount=deposit_request.amount,
        balance_after=account.balance,
        status="completed",
        description=deposit_request.description,
        reference=deposit_request.reference,
        transaction_date=date.today()
    )
    
    db.add(transaction)
    db.commit()
    db.refresh(transaction)
    
    return {
        "message": "Deposit successful",
        "transaction_id": transaction.transaction_id,
        "new_balance": account.balance
    }

@router.post("/withdraw")
async def withdraw(withdrawal_request: WithdrawalRequest, db: Session = Depends(get_db)):
    """Process withdrawal transaction"""
    
    # Get account
    account = db.query(Account).filter(Account.account_number == withdrawal_request.account_number).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    
    if account.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Account is not active"
        )
    
    # Check sufficient balance
    if account.available_balance < withdrawal_request.amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Insufficient balance"
        )
    
    # Update account balance
    account.balance -= withdrawal_request.amount
    account.available_balance -= withdrawal_request.amount
    
    # Create transaction
    transaction = Transaction(
        transaction_id=str(uuid.uuid4()),
        account_id=account.id,
        transaction_type="withdrawal",
        amount=withdrawal_request.amount,
        balance_after=account.balance,
        status="completed",
        description=withdrawal_request.description,
        reference=withdrawal_request.reference,
        transaction_date=date.today()
    )
    
    db.add(transaction)
    db.commit()
    db.refresh(transaction)
    
    return {
        "message": "Withdrawal successful",
        "transaction_id": transaction.transaction_id,
        "new_balance": account.balance
    }

@router.post("/transfer")
async def transfer(transfer_request: TransferRequest, db: Session = Depends(get_db)):
    """Process transfer transaction"""
    
    # Get source account
    from_account = db.query(Account).filter(Account.account_number == transfer_request.from_account_number).first()
    if not from_account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Source account not found"
        )
    
    # Get destination account
    to_account = db.query(Account).filter(Account.account_number == transfer_request.to_account_number).first()
    if not to_account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Destination account not found"
        )
    
    if from_account.status != "active" or to_account.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="One or both accounts are not active"
        )
    
    # Check sufficient balance
    if from_account.available_balance < transfer_request.amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Insufficient balance"
        )
    
    # Update account balances
    from_account.balance -= transfer_request.amount
    from_account.available_balance -= transfer_request.amount
    to_account.balance += transfer_request.amount
    to_account.available_balance += transfer_request.amount
    
    # Create transactions
    transaction_id = str(uuid.uuid4())
    
    # Debit transaction
    debit_transaction = Transaction(
        transaction_id=f"{transaction_id}-D",
        account_id=from_account.id,
        transaction_type="transfer",
        amount=transfer_request.amount,
        balance_after=from_account.balance,
        status="completed",
        description=transfer_request.description,
        reference=transfer_request.reference,
        transaction_date=date.today(),
        to_account_id=to_account.id
    )
    
    # Credit transaction
    credit_transaction = Transaction(
        transaction_id=f"{transaction_id}-C",
        account_id=to_account.id,
        transaction_type="transfer",
        amount=transfer_request.amount,
        balance_after=to_account.balance,
        status="completed",
        description=transfer_request.description,
        reference=transfer_request.reference,
        transaction_date=date.today(),
        to_account_id=from_account.id
    )
    
    db.add(debit_transaction)
    db.add(credit_transaction)
    db.commit()
    
    return {
        "message": "Transfer successful",
        "transaction_id": transaction_id,
        "from_balance": from_account.balance,
        "to_balance": to_account.balance
    }
