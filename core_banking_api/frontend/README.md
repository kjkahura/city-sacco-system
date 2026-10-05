# Core Banking System - Frontend

A simple HTML/JavaScript frontend for the FastAPI Core Banking API.

## Features

- 📊 **Dashboard** - View system statistics
- 👥 **Member Management** - Add and view members
- 💰 **Account Management** - Create and manage accounts
- 💸 **Transaction Processing** - Deposit, withdraw, and transfer money
- 📋 **Loan Management** - Apply for and view loans
- 📱 **USSD Simulator** - Interactive mobile banking simulation

## How to Run

### Option 1: Direct File Opening
1. Make sure your FastAPI backend is running (`start_local.bat`)
2. Open `index.html` in your web browser
3. Note: Some browsers may block CORS requests when opening files directly

### Option 2: Using Python HTTP Server (Recommended)
1. Open PowerShell/Command Prompt
2. Navigate to the frontend directory:
   ```bash
   cd C:\Users\Lenovo\core_banking_api\frontend
   ```
3. Start a local server:
   ```bash
   python -m http.server 8080
   ```
4. Open your browser and go to: `http://localhost:8080`

### Option 3: Using Node.js (if installed)
```bash
npx http-server -p 8080
```

## Default Login Credentials

Use any of these demo accounts:
- **Username**: `admin` / **Password**: `admin123`
- **Username**: `teller1` / **Password**: `teller123`
- **Username**: `loan_officer1` / **Password**: `officer123`

## API Connection

The frontend connects to the FastAPI backend at:
- **Base URL**: `http://localhost:8000/api/v1`

Make sure your backend is running before using the frontend!

## Features Overview

### Dashboard
- View total members, accounts, loans, and transactions
- Real-time statistics

### Members
- View all members in a table
- Add new members with complete information
- Member details include: name, phone, ID number, address, etc.

### Accounts
- View all accounts with balances
- Create new accounts (savings, current, fixed deposit, share)
- Set minimum balance and interest rates

### Transactions
- **Deposit**: Add money to accounts
- **Withdraw**: Remove money from accounts
- **Transfer**: Move money between accounts
- View transaction history

### Loans
- Apply for new loans
- View all loans with status and outstanding amounts
- Loan types: Personal, Business, Emergency, Education, Agriculture

### USSD Simulator
- Interactive mobile banking simulation
- Dial *123# to start
- Check balances, view mini statements, and more

## Browser Compatibility

- Chrome (recommended)
- Firefox
- Edge
- Safari

## Troubleshooting

### CORS Errors
If you see CORS errors, make sure:
1. You're using a local server (not opening file directly)
2. Your FastAPI backend has CORS enabled (it does by default)
3. Both frontend and backend are running

### Connection Errors
- Ensure the FastAPI backend is running on `http://localhost:8000`
- Check that the API is accessible at `http://localhost:8000/docs`

### Login Issues
- Make sure the database is seeded with demo data
- Try refreshing the page
- Check browser console for errors
