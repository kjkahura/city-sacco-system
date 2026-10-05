# Core Banking System - Supabase Frontend

A modern frontend for the Core Banking System using Supabase as the backend.

## Why Supabase?

- ✅ **No Backend Server Needed** - Supabase handles everything
- ✅ **No Python Dependencies** - Pure JavaScript/HTML
- ✅ **Auto-generated APIs** - REST API created automatically
- ✅ **Built-in Authentication** - Ready to use
- ✅ **Real-time Updates** - Live data synchronization
- ✅ **Free Tier Available** - Perfect for development

## Setup Instructions

### Step 1: Create Supabase Account

1. Go to https://supabase.com
2. Click "Start your project" and sign up (free)
3. Create a new project
4. Wait for project to be created (takes 1-2 minutes)

### Step 2: Get Your Credentials

1. In Supabase dashboard, go to **Settings** → **API**
2. Copy:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: `eyJhbGc...` (long string starting with `eyJ`)

### Step 3: Set Up Database

1. In Supabase dashboard, go to **SQL Editor**
2. Open the file: `supabase/database_schema.sql`
3. Copy the entire SQL script
4. Paste it into the SQL Editor
5. Click "Run" to create all tables

### Step 4: Seed Demo Data (Optional)

1. In SQL Editor, open: `supabase/seed_data.sql`
2. Copy and run the script to add demo data

### Step 5: Configure Frontend

1. Open `js/config.js`
2. Replace the placeholders:
   ```javascript
   const SUPABASE_CONFIG = {
       url: 'YOUR_SUPABASE_URL',  // Paste your Project URL here
       anonKey: 'YOUR_SUPABASE_ANON_KEY'  // Paste your anon key here
   };
   ```

### Step 6: Open the Frontend

1. **Option A**: Open `index.html` directly in your browser
2. **Option B**: Use a local server:
   ```bash
   cd frontend_supabase
   python -m http.server 8080
   ```
   Then open: http://localhost:8080

## Features

- 📊 **Dashboard** - View system statistics
- 👥 **Member Management** - Add and view members
- 💰 **Account Management** - Create and manage accounts
- 💸 **Transaction Processing** - Deposit, withdraw, transfer
- 📋 **Loan Management** - Apply for and view loans

## Default Login

After seeding demo data, use:
- **Username**: `admin`
- **Password**: `admin123`

## Database Schema

All tables are created automatically when you run the SQL script:
- `users` - System users
- `members` - SACCO members
- `accounts` - Member accounts
- `transactions` - Financial transactions
- `loans` - Loan applications and management
- `loan_schedules` - Loan repayment schedules
- `standing_orders` - Recurring payments
- `otps` - One-time passwords

## Troubleshooting

### "Supabase not configured" error
**Solution**: Make sure you've updated `js/config.js` with your credentials

### "Failed to connect to Supabase" error
**Solution**: 
- Check your Project URL and API key
- Make sure your Supabase project is active
- Check browser console for detailed errors

### Tables not found
**Solution**: Make sure you've run the `database_schema.sql` script in Supabase SQL Editor

### CORS errors
**Solution**: Supabase handles CORS automatically. If you see CORS errors, check:
- Your Supabase project settings
- Browser console for specific errors

## Benefits Over FastAPI Backend

- ✅ No server to maintain
- ✅ No Python dependencies
- ✅ Automatic API generation
- ✅ Built-in authentication
- ✅ Real-time capabilities
- ✅ Easy to deploy
- ✅ Free tier available

## Next Steps

1. Set up your Supabase project
2. Run the database schema SQL
3. Configure the frontend
4. Start using the system!

Your code is ready - just connect it to Supabase! 🚀

