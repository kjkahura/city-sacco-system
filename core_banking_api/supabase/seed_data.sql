-- Demo Data for Core Banking System
-- Run this after creating the schema

-- Insert demo users
INSERT INTO users (username, email, phone, hashed_password, full_name, role, is_verified) VALUES
('admin', 'admin@sacco.com', '+254700000001', 'admin123', 'System Administrator', 'admin', true),
('teller1', 'teller1@sacco.com', '+254700000002', 'teller123', 'John Teller', 'teller', true),
('loan_officer1', 'loanofficer1@sacco.com', '+254700000003', 'officer123', 'Jane Loan Officer', 'loan_officer', true);

-- Get user IDs (you'll need to adjust these after inserting)
-- For now, we'll use a subquery approach

-- Insert demo members
INSERT INTO members (member_number, first_name, last_name, middle_name, email, phone, id_number, date_of_birth, gender, address, occupation, employer, monthly_income, status, join_date, user_id)
SELECT 
    'MEM000001',
    'Alice',
    'Johnson',
    'Wanjiku',
    'alice.johnson@email.com',
    '+254712345678',
    '12345678',
    '1985-05-15',
    'Female',
    '123 Main Street, Nairobi',
    'Teacher',
    'Nairobi Primary School',
    50000.00,
    'active',
    '2020-01-15',
    id
FROM users WHERE username = 'admin'
LIMIT 1;

INSERT INTO members (member_number, first_name, last_name, middle_name, email, phone, id_number, date_of_birth, gender, address, occupation, employer, monthly_income, status, join_date, user_id)
SELECT 
    'MEM000002',
    'Bob',
    'Mwangi',
    'Kamau',
    'bob.mwangi@email.com',
    '+254723456789',
    '23456789',
    '1988-08-22',
    'Male',
    '456 Oak Avenue, Mombasa',
    'Engineer',
    'Tech Solutions Ltd',
    75000.00,
    'active',
    '2020-03-10',
    id
FROM users WHERE username = 'teller1'
LIMIT 1;

INSERT INTO members (member_number, first_name, last_name, middle_name, email, phone, id_number, date_of_birth, gender, address, occupation, employer, monthly_income, status, join_date, user_id)
SELECT 
    'MEM000003',
    'Carol',
    'Ochieng',
    'Adhiambo',
    'carol.ochieng@email.com',
    '+254734567890',
    '34567890',
    '1990-12-03',
    'Female',
    '789 Pine Road, Kisumu',
    'Nurse',
    'Kisumu General Hospital',
    45000.00,
    'active',
    '2021-06-20',
    id
FROM users WHERE username = 'loan_officer1'
LIMIT 1;

-- Insert demo accounts
INSERT INTO accounts (account_number, member_id, account_type, balance, available_balance, status, open_date, minimum_balance, interest_rate)
SELECT 
    'ACC00000001',
    id,
    'savings',
    150000.00,
    150000.00,
    'active',
    '2020-01-15',
    1000.00,
    0.0500
FROM members WHERE member_number = 'MEM000001'
LIMIT 1;

INSERT INTO accounts (account_number, member_id, account_type, balance, available_balance, status, open_date, minimum_balance, interest_rate)
SELECT 
    'ACC00000002',
    id,
    'current',
    250000.00,
    250000.00,
    'active',
    '2020-03-10',
    5000.00,
    0.0300
FROM members WHERE member_number = 'MEM000002'
LIMIT 1;

INSERT INTO accounts (account_number, member_id, account_type, balance, available_balance, status, open_date, minimum_balance, interest_rate)
SELECT 
    'ACC00000003',
    id,
    'savings',
    75000.00,
    75000.00,
    'active',
    '2021-06-20',
    1000.00,
    0.0500
FROM members WHERE member_number = 'MEM000003'
LIMIT 1;

