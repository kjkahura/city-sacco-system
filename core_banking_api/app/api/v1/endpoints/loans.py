"""
Loan management endpoints
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from datetime import date, timedelta
import uuid
from decimal import Decimal

from app.core.database import get_db
from app.models.loan import Loan
from app.models.loan_schedule import LoanSchedule
from app.models.account import Account
from app.models.member import Member
from app.schemas.loan import (
    LoanApplication, LoanApproval, LoanDisbursement, 
    LoanRepayment, LoanResponse, LoanScheduleResponse
)

router = APIRouter()

@router.get("/", response_model=List[LoanResponse])
async def get_loans(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db)
):
    """Get all loans"""
    loans = db.query(Loan).offset(skip).limit(limit).all()
    return loans

@router.get("/{loan_id}", response_model=LoanResponse)
async def get_loan(loan_id: int, db: Session = Depends(get_db)):
    """Get loan by ID"""
    loan = db.query(Loan).filter(Loan.id == loan_id).first()
    if not loan:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Loan not found"
        )
    return loan

@router.get("/{loan_id}/schedule", response_model=List[LoanScheduleResponse])
async def get_loan_schedule(loan_id: int, db: Session = Depends(get_db)):
    """Get loan repayment schedule"""
    loan = db.query(Loan).filter(Loan.id == loan_id).first()
    if not loan:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Loan not found"
        )
    
    schedules = db.query(LoanSchedule).filter(LoanSchedule.loan_id == loan_id).all()
    return schedules

@router.post("/apply")
async def apply_loan(loan_application: LoanApplication, db: Session = Depends(get_db)):
    """Apply for a loan"""
    
    # Check if member exists
    member = db.query(Member).filter(Member.id == loan_application.member_id).first()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member not found"
        )
    
    # Check if account exists
    account = db.query(Account).filter(Account.id == loan_application.account_id).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    
    # Generate loan number
    loan_count = db.query(Loan).count()
    loan_number = f"LOAN{loan_count + 1:06d}"
    
    # Create loan application
    loan = Loan(
        loan_number=loan_number,
        member_id=loan_application.member_id,
        account_id=loan_application.account_id,
        loan_type=loan_application.loan_type,
        principal_amount=loan_application.principal_amount,
        term_months=loan_application.term_months,
        outstanding_principal=loan_application.principal_amount,
        total_outstanding=loan_application.principal_amount,
        application_date=date.today(),
        purpose=loan_application.purpose,
        collateral_description=loan_application.collateral_description,
        guarantor_name=loan_application.guarantor_name,
        guarantor_phone=loan_application.guarantor_phone
    )
    
    db.add(loan)
    db.commit()
    db.refresh(loan)
    
    return {
        "message": "Loan application submitted successfully",
        "loan_number": loan.loan_number,
        "status": "pending"
    }

@router.post("/{loan_id}/approve")
async def approve_loan(
    loan_id: int,
    loan_approval: LoanApproval,
    db: Session = Depends(get_db)
):
    """Approve a loan"""
    
    loan = db.query(Loan).filter(Loan.id == loan_id).first()
    if not loan:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Loan not found"
        )
    
    if loan.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Loan is not in pending status"
        )
    
    # Update loan with approval details
    loan.interest_rate = loan_approval.interest_rate
    if loan_approval.approved_amount:
        loan.principal_amount = loan_approval.approved_amount
        loan.outstanding_principal = loan_approval.approved_amount
        loan.total_outstanding = loan_approval.approved_amount
    if loan_approval.approved_term_months:
        loan.term_months = loan_approval.approved_term_months
    
    # Calculate monthly payment (simplified calculation)
    monthly_rate = loan.interest_rate / 12
    if monthly_rate > 0:
        loan.monthly_payment = loan.principal_amount * (monthly_rate * (1 + monthly_rate) ** loan.term_months) / ((1 + monthly_rate) ** loan.term_months - 1)
    else:
        loan.monthly_payment = loan.principal_amount / loan.term_months
    
    loan.status = "approved"
    loan.approval_date = date.today()
    
    db.commit()
    db.refresh(loan)
    
    return {
        "message": "Loan approved successfully",
        "loan_number": loan.loan_number,
        "approved_amount": loan.principal_amount,
        "monthly_payment": loan.monthly_payment
    }

@router.post("/{loan_id}/disburse")
async def disburse_loan(
    loan_id: int,
    loan_disbursement: LoanDisbursement,
    db: Session = Depends(get_db)
):
    """Disburse a loan"""
    
    loan = db.query(Loan).filter(Loan.id == loan_id).first()
    if not loan:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Loan not found"
        )
    
    if loan.status != "approved":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Loan is not approved"
        )
    
    # Get account
    account = db.query(Account).filter(Account.id == loan.account_id).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    
    # Update loan status
    loan.status = "disbursed"
    loan.disbursement_date = loan_disbursement.disbursement_date
    loan.maturity_date = loan_disbursement.disbursement_date + timedelta(days=loan.term_months * 30)
    
    # Credit the account
    account.balance += loan_disbursement.disbursement_amount
    account.available_balance += loan_disbursement.disbursement_amount
    
    # Create disbursement transaction
    from app.models.transaction import Transaction
    transaction = Transaction(
        transaction_id=str(uuid.uuid4()),
        account_id=account.id,
        transaction_type="loan_disbursement",
        amount=loan_disbursement.disbursement_amount,
        balance_after=account.balance,
        status="completed",
        description=f"Loan disbursement - {loan.loan_number}",
        reference=loan.loan_number,
        transaction_date=loan_disbursement.disbursement_date
    )
    
    db.add(transaction)
    db.commit()
    db.refresh(loan)
    
    return {
        "message": "Loan disbursed successfully",
        "loan_number": loan.loan_number,
        "disbursed_amount": loan_disbursement.disbursement_amount,
        "account_balance": account.balance
    }

@router.post("/{loan_id}/repay")
async def repay_loan(
    loan_id: int,
    loan_repayment: LoanRepayment,
    db: Session = Depends(get_db)
):
    """Process loan repayment"""
    
    loan = db.query(Loan).filter(Loan.id == loan_id).first()
    if not loan:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Loan not found"
        )
    
    if loan.status not in ["disbursed", "active"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Loan is not active"
        )
    
    # Get account
    account = db.query(Account).filter(Account.id == loan.account_id).first()
    if not account:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found"
        )
    
    # Check sufficient balance
    if account.available_balance < loan_repayment.amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Insufficient balance"
        )
    
    # Update loan balances (simplified calculation)
    if loan_repayment.amount >= loan.outstanding_principal:
        # Full repayment
        loan.outstanding_principal = Decimal('0.00')
        loan.outstanding_interest = Decimal('0.00')
        loan.total_outstanding = Decimal('0.00')
        loan.status = "completed"
    else:
        # Partial repayment
        loan.outstanding_principal -= loan_repayment.amount
        loan.total_outstanding -= loan_repayment.amount
    
    # Debit the account
    account.balance -= loan_repayment.amount
    account.available_balance -= loan_repayment.amount
    
    # Create repayment transaction
    from app.models.transaction import Transaction
    transaction = Transaction(
        transaction_id=str(uuid.uuid4()),
        account_id=account.id,
        transaction_type="loan_repayment",
        amount=loan_repayment.amount,
        balance_after=account.balance,
        status="completed",
        description=f"Loan repayment - {loan.loan_number}",
        reference=loan.loan_number,
        transaction_date=date.today()
    )
    
    db.add(transaction)
    db.commit()
    db.refresh(loan)
    
    return {
        "message": "Loan repayment successful",
        "loan_number": loan.loan_number,
        "remaining_balance": loan.total_outstanding,
        "account_balance": account.balance
    }
