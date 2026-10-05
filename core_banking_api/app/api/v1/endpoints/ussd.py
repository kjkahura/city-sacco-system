"""
USSD simulator endpoints
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from app.core.database import get_db
from app.models.member import Member
from app.models.account import Account
from app.models.transaction import Transaction

router = APIRouter()

class USSDRequest(BaseModel):
    """USSD request schema"""
    phone: str
    session_id: str
    text: str
    service_code: str = "*123#"

class USSDResponse(BaseModel):
    """USSD response schema"""
    response: str
    session_id: str
    status: str = "continue"  # continue, end

@router.post("/simulate", response_model=USSDResponse)
async def simulate_ussd(ussd_request: USSDRequest, db: Session = Depends(get_db)):
    """Simulate USSD banking session"""
    
    # Parse the USSD text
    text_parts = ussd_request.text.split('*') if ussd_request.text else []
    
    # Main menu
    if not ussd_request.text or ussd_request.text == "":
        response = """Welcome to SACCO Banking
1. Check Balance
2. Mini Statement
3. Transfer Money
4. Pay Bills
5. Loan Services
0. Exit"""
        return USSDResponse(
            response=response,
            session_id=ussd_request.session_id,
            status="continue"
        )
    
    # Handle menu selections
    if len(text_parts) == 1:
        selection = text_parts[0]
        
        if selection == "1":
            # Check Balance
            member = db.query(Member).filter(Member.phone == ussd_request.phone).first()
            if not member:
                return USSDResponse(
                    response="Error: Member not found. Please register first.",
                    session_id=ussd_request.session_id,
                    status="end"
                )
            
            accounts = db.query(Account).filter(Account.member_id == member.id).all()
            if not accounts:
                return USSDResponse(
                    response="Error: No accounts found.",
                    session_id=ussd_request.session_id,
                    status="end"
                )
            
            response = "Your Account Balances:\n"
            for account in accounts:
                response += f"{account.account_number}: KES {account.balance:,.2f}\n"
            response += "Thank you for using SACCO Banking"
            
            return USSDResponse(
                response=response,
                session_id=ussd_request.session_id,
                status="end"
            )
        
        elif selection == "2":
            # Mini Statement
            member = db.query(Member).filter(Member.phone == ussd_request.phone).first()
            if not member:
                return USSDResponse(
                    response="Error: Member not found.",
                    session_id=ussd_request.session_id,
                    status="end"
                )
            
            accounts = db.query(Account).filter(Account.member_id == member.id).all()
            if not accounts:
                return USSDResponse(
                    response="Error: No accounts found.",
                    session_id=ussd_request.session_id,
                    status="end"
                )
            
            response = "Select Account:\n"
            for i, account in enumerate(accounts, 1):
                response += f"{i}. {account.account_number}\n"
            
            return USSDResponse(
                response=response,
                session_id=ussd_request.session_id,
                status="continue"
            )
        
        elif selection == "3":
            # Transfer Money
            response = """Transfer Money
Enter recipient account number:"""
            return USSDResponse(
                response=response,
                session_id=ussd_request.session_id,
                status="continue"
            )
        
        elif selection == "4":
            # Pay Bills
            response = """Pay Bills
1. Electricity
2. Water
3. Internet
0. Back"""
            return USSDResponse(
                response=response,
                session_id=ussd_request.session_id,
                status="continue"
            )
        
        elif selection == "5":
            # Loan Services
            response = """Loan Services
1. Check Loan Balance
2. Apply for Loan
3. Loan Repayment
0. Back"""
            return USSDResponse(
                response=response,
                session_id=ussd_request.session_id,
                status="continue"
            )
        
        elif selection == "0":
            # Exit
            return USSDResponse(
                response="Thank you for using SACCO Banking. Goodbye!",
                session_id=ussd_request.session_id,
                status="end"
            )
        
        else:
            return USSDResponse(
                response="Invalid selection. Please try again.",
                session_id=ussd_request.session_id,
                status="continue"
            )
    
    # Handle multi-step flows
    elif len(text_parts) == 2:
        first_selection = text_parts[0]
        second_selection = text_parts[1]
        
        if first_selection == "2":  # Mini Statement
            member = db.query(Member).filter(Member.phone == ussd_request.phone).first()
            if not member:
                return USSDResponse(
                    response="Error: Member not found.",
                    session_id=ussd_request.session_id,
                    status="end"
                )
            
            accounts = db.query(Account).filter(Account.member_id == member.id).all()
            try:
                account_index = int(second_selection) - 1
                if 0 <= account_index < len(accounts):
                    account = accounts[account_index]
                    transactions = db.query(Transaction).filter(
                        Transaction.account_id == account.id
                    ).order_by(Transaction.created_at.desc()).limit(5).all()
                    
                    response = f"Mini Statement - {account.account_number}\n"
                    response += f"Balance: KES {account.balance:,.2f}\n\n"
                    response += "Recent Transactions:\n"
                    
                    for transaction in transactions:
                        response += f"{transaction.transaction_date}: {transaction.transaction_type.upper()}\n"
                        response += f"Amount: KES {transaction.amount:,.2f}\n"
                        response += f"Balance: KES {transaction.balance_after:,.2f}\n\n"
                    
                    response += "Thank you for using SACCO Banking"
                    
                    return USSDResponse(
                        response=response,
                        session_id=ussd_request.session_id,
                        status="end"
                    )
                else:
                    return USSDResponse(
                        response="Invalid account selection.",
                        session_id=ussd_request.session_id,
                        status="end"
                    )
            except ValueError:
                return USSDResponse(
                    response="Invalid selection.",
                    session_id=ussd_request.session_id,
                    status="end"
                )
    
    # Default response
    return USSDResponse(
        response="Invalid input. Please try again.",
        session_id=ussd_request.session_id,
        status="continue"
    )

@router.get("/test")
async def test_ussd():
    """Test USSD endpoint"""
    return {
        "message": "USSD simulator is working",
        "example_request": {
            "phone": "+254712345678",
            "session_id": "test123",
            "text": "",
            "service_code": "*123#"
        }
    }
