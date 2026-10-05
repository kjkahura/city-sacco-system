"""
Database seeding script for demo data
"""

from sqlalchemy.orm import Session
from datetime import date, datetime, timedelta
from decimal import Decimal
import uuid

try:
    from app.core.database_local import SessionLocal
except ImportError:
    from app.core.database import SessionLocal
from app.models.models import (
    User, Member, Account, Transaction, Loan, 
    LoanSchedule, StandingOrder, OTP
)

def seed_database():
    """Seed the database with demo data"""
    
    db = SessionLocal()
    
    try:
        # Check if data already exists
        if db.query(User).count() > 0:
            print("Database already seeded. Skipping...")
            return
        
        print("Seeding database with demo data...")
        
        # Create demo users
        users = [
            User(
                username="admin",
                email="admin@sacco.com",
                phone="+254700000001",
                hashed_password="admin123",  # In production, this should be hashed
                full_name="System Administrator",
                role="admin",
                is_verified=True
            ),
            User(
                username="teller1",
                email="teller1@sacco.com",
                phone="+254700000002",
                hashed_password="teller123",
                full_name="John Teller",
                role="teller",
                is_verified=True
            ),
            User(
                username="loan_officer1",
                email="loanofficer1@sacco.com",
                phone="+254700000003",
                hashed_password="officer123",
                full_name="Jane Loan Officer",
                role="loan_officer",
                is_verified=True
            )
        ]
        
        for user in users:
            db.add(user)
        db.commit()
        
        # Create demo members
        members = [
            Member(
                member_number="MEM000001",
                first_name="Alice",
                last_name="Johnson",
                middle_name="Wanjiku",
                email="alice.johnson@email.com",
                phone="+254712345678",
                id_number="12345678",
                date_of_birth=date(1985, 5, 15),
                gender="Female",
                address="123 Main Street, Nairobi",
                occupation="Teacher",
                employer="Nairobi Primary School",
                monthly_income=Decimal('50000.00'),
                status="active",
                join_date=date(2020, 1, 15),
                user_id=users[0].id
            ),
            Member(
                member_number="MEM000002",
                first_name="Bob",
                last_name="Mwangi",
                middle_name="Kamau",
                email="bob.mwangi@email.com",
                phone="+254723456789",
                id_number="23456789",
                date_of_birth=date(1988, 8, 22),
                gender="Male",
                address="456 Oak Avenue, Mombasa",
                occupation="Engineer",
                employer="Tech Solutions Ltd",
                monthly_income=Decimal('75000.00'),
                status="active",
                join_date=date(2020, 3, 10),
                user_id=users[1].id
            ),
            Member(
                member_number="MEM000003",
                first_name="Carol",
                last_name="Ochieng",
                middle_name="Adhiambo",
                email="carol.ochieng@email.com",
                phone="+254734567890",
                id_number="34567890",
                date_of_birth=date(1990, 12, 3),
                gender="Female",
                address="789 Pine Road, Kisumu",
                occupation="Nurse",
                employer="Kisumu General Hospital",
                monthly_income=Decimal('45000.00'),
                status="active",
                join_date=date(2021, 6, 20),
                user_id=users[2].id
            )
        ]
        
        for member in members:
            db.add(member)
        db.commit()
        
        # Create demo accounts
        accounts = [
            Account(
                account_number="ACC00000001",
                member_id=members[0].id,
                account_type="savings",
                balance=Decimal('150000.00'),
                available_balance=Decimal('150000.00'),
                status="active",
                open_date=date(2020, 1, 15),
                minimum_balance=Decimal('1000.00'),
                interest_rate=Decimal('0.0500')  # 5% annual
            ),
            Account(
                account_number="ACC00000002",
                member_id=members[1].id,
                account_type="current",
                balance=Decimal('250000.00'),
                available_balance=Decimal('250000.00'),
                status="active",
                open_date=date(2020, 3, 10),
                minimum_balance=Decimal('5000.00'),
                interest_rate=Decimal('0.0300')  # 3% annual
            ),
            Account(
                account_number="ACC00000003",
                member_id=members[2].id,
                account_type="savings",
                balance=Decimal('75000.00'),
                available_balance=Decimal('75000.00'),
                status="active",
                open_date=date(2021, 6, 20),
                minimum_balance=Decimal('1000.00'),
                interest_rate=Decimal('0.0500')  # 5% annual
            )
        ]
        
        for account in accounts:
            db.add(account)
        db.commit()
        
        # Create demo transactions
        transactions = [
            Transaction(
                transaction_id=str(uuid.uuid4()),
                account_id=accounts[0].id,
                user_id=users[0].id,
                transaction_type="deposit",
                amount=Decimal('50000.00'),
                balance_after=Decimal('200000.00'),
                status="completed",
                description="Salary deposit",
                reference="SAL2024001",
                transaction_date=date.today() - timedelta(days=5)
            ),
            Transaction(
                transaction_id=str(uuid.uuid4()),
                account_id=accounts[0].id,
                user_id=users[0].id,
                transaction_type="withdrawal",
                amount=Decimal('10000.00'),
                balance_after=Decimal('190000.00'),
                status="completed",
                description="ATM withdrawal",
                reference="ATM2024001",
                transaction_date=date.today() - timedelta(days=3)
            ),
            Transaction(
                transaction_id=str(uuid.uuid4()),
                account_id=accounts[1].id,
                user_id=users[1].id,
                transaction_type="deposit",
                amount=Decimal('75000.00'),
                balance_after=Decimal('325000.00'),
                status="completed",
                description="Salary deposit",
                reference="SAL2024002",
                transaction_date=date.today() - timedelta(days=4)
            ),
            Transaction(
                transaction_id=str(uuid.uuid4()),
                account_id=accounts[0].id,
                user_id=users[0].id,
                transaction_type="transfer",
                amount=Decimal('25000.00'),
                balance_after=Decimal('165000.00'),
                status="completed",
                description="Transfer to savings",
                reference="TRF2024001",
                transaction_date=date.today() - timedelta(days=2),
                to_account_id=accounts[2].id
            )
        ]
        
        for transaction in transactions:
            db.add(transaction)
        db.commit()
        
        # Create demo loan
        loan = Loan(
            loan_number="LOAN000001",
            member_id=members[0].id,
            account_id=accounts[0].id,
            loan_type="personal",
            principal_amount=Decimal('100000.00'),
            interest_rate=Decimal('0.1200'),  # 12% annual
            term_months=24,
            monthly_payment=Decimal('4707.35'),
            outstanding_principal=Decimal('85000.00'),
            outstanding_interest=Decimal('5000.00'),
            total_outstanding=Decimal('90000.00'),
            status="active",
            application_date=date(2023, 6, 1),
            approval_date=date(2023, 6, 5),
            disbursement_date=date(2023, 6, 10),
            maturity_date=date(2025, 6, 10),
            purpose="Home improvement",
            collateral_description="Property title deed"
        )
        
        db.add(loan)
        db.commit()
        
        # Create demo loan schedule
        loan_schedules = []
        for i in range(1, 25):  # 24 months
            due_date = date(2023, 6, 10) + timedelta(days=30 * i)
            loan_schedules.append(
                LoanSchedule(
                    loan_id=loan.id,
                    installment_number=i,
                    due_date=due_date,
                    principal_amount=Decimal('4166.67'),
                    interest_amount=Decimal('540.68'),
                    total_amount=Decimal('4707.35'),
                    status="paid" if i <= 6 else "pending"  # First 6 payments made
                )
            )
        
        for schedule in loan_schedules:
            db.add(schedule)
        db.commit()
        
        # Create demo standing order
        standing_order = StandingOrder(
            member_id=members[0].id,
            from_account_id=accounts[0].id,
            to_account_id=accounts[2].id,
            amount=Decimal('5000.00'),
            frequency="monthly",
            start_date=date(2024, 1, 1),
            end_date=date(2024, 12, 31),
            next_execution_date=date.today() + timedelta(days=15),
            description="Monthly savings transfer",
            status="active"
        )
        
        db.add(standing_order)
        db.commit()
        
        print("✅ Database seeded successfully!")
        print(f"   - {len(users)} users created")
        print(f"   - {len(members)} members created")
        print(f"   - {len(accounts)} accounts created")
        print(f"   - {len(transactions)} transactions created")
        print(f"   - 1 loan created")
        print(f"   - {len(loan_schedules)} loan schedule entries created")
        print(f"   - 1 standing order created")
        
    except Exception as e:
        print(f"❌ Error seeding database: {e}")
        db.rollback()
        raise
    finally:
        db.close()

async def seed_database_async():
    """Async wrapper for seed_database"""
    seed_database()
