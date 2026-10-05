# 🚀 Supabase Quick Start Guide

## Why Switch to Supabase?

✅ **No Python dependencies** - No installation issues!
✅ **No backend server** - Everything runs in the cloud
✅ **Auto-generated APIs** - REST API created automatically
✅ **Free tier** - Perfect for development and small projects
✅ **Easy setup** - Get running in minutes

## Quick Setup (5 Steps)

### Step 1: Create Supabase Account (2 minutes)

1. Go to: https://supabase.com
2. Click "Start your project"
3. Sign up with GitHub/Google/Email (free)
4. Click "New Project"
5. Fill in:
   - **Name**: Core Banking System
   - **Database Password**: (choose a strong password - save it!)
   - **Region**: Choose closest to you
6. Click "Create new project"
7. Wait 1-2 minutes for setup

### Step 2: Get Your Credentials (1 minute)

1. In your Supabase dashboard, click **Settings** (gear icon)
2. Click **API** in the left menu
3. Copy these two values:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: `eyJhbGc...` (long string)

### Step 3: Set Up Database (2 minutes)

1. In Supabase dashboard, click **SQL Editor**
2. Click **New query**
3. Open file: `supabase/database_schema.sql`
4. Copy ALL the SQL code
5. Paste into Supabase SQL Editor
6. Click **Run** (or press Ctrl+Enter)
7. You should see "Success. No rows returned"

### Step 4: Add Demo Data (Optional - 1 minute)

1. In SQL Editor, click **New query**
2. Open file: `supabase/seed_data.sql`
3. Copy ALL the SQL code
4. Paste and click **Run**

### Step 5: Configure Frontend (1 minute)

1. Open: `frontend_supabase/js/config.js`
2. Replace:
   ```javascript
   url: 'YOUR_SUPABASE_URL',  // Paste your Project URL
   anonKey: 'YOUR_SUPABASE_ANON_KEY'  // Paste your anon key
   ```
3. Save the file

### Step 6: Run the Frontend

1. Open `frontend_supabase/index.html` in your browser
   OR
2. Run: `cd frontend_supabase && start_server.bat`
3. Open: http://localhost:8080

## That's It! 🎉

Your Core Banking System is now running on Supabase!

## Login Credentials

After seeding demo data:
- **Username**: `admin`
- **Password**: `admin123`

## What You Get

- ✅ Full database in the cloud
- ✅ Auto-generated REST API
- ✅ Real-time capabilities
- ✅ Built-in authentication
- ✅ No server maintenance
- ✅ Free tier (up to 500MB database, 2GB bandwidth)

## File Structure

```
core_banking_api/
├── supabase/
│   ├── database_schema.sql    ← Run this in Supabase SQL Editor
│   └── seed_data.sql          ← Optional: Add demo data
└── frontend_supabase/
    ├── index.html             ← Main frontend file
    ├── js/
    │   ├── config.js          ← Configure your Supabase credentials here
    │   ├── supabase-client.js
    │   └── app.js
    └── css/
        └── style.css
```

## Troubleshooting

### "Supabase not configured"
→ Update `js/config.js` with your credentials

### "Failed to connect"
→ Check your Project URL and API key are correct

### Tables not found
→ Make sure you ran `database_schema.sql` in Supabase SQL Editor

### Can't see data
→ Run `seed_data.sql` to add demo data

## Next Steps

1. ✅ Set up Supabase project
2. ✅ Run database schema
3. ✅ Configure frontend
4. ✅ Start using the system!

**No Python, no dependencies, no server - just Supabase!** 🚀

