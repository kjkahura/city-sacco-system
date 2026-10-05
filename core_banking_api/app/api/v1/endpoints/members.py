"""
Member management endpoints
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from datetime import date

from app.core.database import get_db
from app.models.member import Member
from app.schemas.member import MemberCreate, MemberUpdate, MemberResponse

router = APIRouter()

@router.get("/", response_model=List[MemberResponse])
async def get_members(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db)
):
    """Get all members"""
    members = db.query(Member).offset(skip).limit(limit).all()
    return members

@router.get("/{member_id}", response_model=MemberResponse)
async def get_member(member_id: int, db: Session = Depends(get_db)):
    """Get member by ID"""
    member = db.query(Member).filter(Member.id == member_id).first()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member not found"
        )
    return member

@router.post("/", response_model=MemberResponse)
async def create_member(member_create: MemberCreate, db: Session = Depends(get_db)):
    """Create a new member"""
    
    # Check if member already exists
    existing_member = db.query(Member).filter(
        (Member.phone == member_create.phone) |
        (Member.id_number == member_create.id_number)
    ).first()
    
    if existing_member:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Member already exists"
        )
    
    # Generate member number
    member_count = db.query(Member).count()
    member_number = f"MEM{member_count + 1:06d}"
    
    # Create new member
    member = Member(
        member_number=member_number,
        first_name=member_create.first_name,
        last_name=member_create.last_name,
        middle_name=member_create.middle_name,
        email=member_create.email,
        phone=member_create.phone,
        id_number=member_create.id_number,
        date_of_birth=member_create.date_of_birth,
        gender=member_create.gender,
        address=member_create.address,
        occupation=member_create.occupation,
        employer=member_create.employer,
        monthly_income=member_create.monthly_income,
        join_date=date.today()
    )
    
    db.add(member)
    db.commit()
    db.refresh(member)
    
    return member

@router.put("/{member_id}", response_model=MemberResponse)
async def update_member(
    member_id: int,
    member_update: MemberUpdate,
    db: Session = Depends(get_db)
):
    """Update member information"""
    
    member = db.query(Member).filter(Member.id == member_id).first()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member not found"
        )
    
    # Update fields
    update_data = member_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(member, field, value)
    
    db.commit()
    db.refresh(member)
    
    return member

@router.delete("/{member_id}")
async def delete_member(member_id: int, db: Session = Depends(get_db)):
    """Delete member (soft delete)"""
    
    member = db.query(Member).filter(Member.id == member_id).first()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member not found"
        )
    
    # Soft delete
    member.is_active = False
    db.commit()
    
    return {"message": "Member deleted successfully"}
