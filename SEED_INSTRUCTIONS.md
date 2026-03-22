# Database Seeding Guide

## Overview
The `seed.js` script initializes your MongoDB database with default data needed for production deployment. Instead of using the first-time setup UI, you can now seed the database automatically.

## What Gets Seeded

✅ **Admin Account**
- Email: `admin@college.edu` (configurable)
- Password: `admin@123` (configurable)
- Role: Admin with full access

✅ **Sample Events** (5 default events)
- Cricket Championship (Team - 11 players)
- Basketball Tournament (Team - 5 players)
- 100M Sprint (Individual)
- Badminton Doubles (Team - 2 players)
- Chess Tournament (Individual)

✅ **Default Settings**
- College name
- Event name and date
- Venue information
- Department list

## Prerequisites

1. **MongoDB running** - Ensure MongoDB is running locally or accessible via MONGO_URI
2. **Backend dependencies installed** - Run `npm install` in the backend folder
3. **.env configured** - Copy `.env.example` to `.env` and update `MONGO_URI`

## How to Use

### Basic Usage (Non-destructive)
```bash
cd backend
node seed.js
```
This will:
- Create admin account if it doesn't exist
- Create sample events if none exist
- Create default settings if they don't exist
- NOT delete existing data

### Clear Database & Reseed
```bash
node seed.js --clear
```
This will:
- Delete all existing data (Admin, Events, Settings, etc.)
- Create fresh admin account
- Create sample events
- Create default settings

## Customizing Seed Data

### Option 1: Environment Variables
Edit your `.env` file before running the seed:
```env
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/sports-event-system
SEED_ADMIN_EMAIL=youradmin@example.com
SEED_ADMIN_PASSWORD=yourSecurePassword123
SEED_ADMIN_NAME=Your Admin Name
```

Then run:
```bash
node seed.js
```

### Option 2: Edit seed.js Directly
Modify the `sampleEvents` array in `seed.js` to customize event data, or update the settings object.

## Production Deployment Steps

1. **Prepare your server**
   ```bash
   npm install
   ```

2. **Configure .env**
   - Set MONGO_URI to your production MongoDB
   - Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to secure credentials
   - Set other environment variables

3. **Run the seed script**
   ```bash
   node seed.js
   ```

4. **Start the server**
   ```bash
   npm start
   ```

5. **Verify in admin panel**
   - Navigate to `/admin/login`
   - Login with your seeded credentials
   - Check Dashboard, Events, Settings

## What Replaces Now

The `SetupPage.jsx` (/admin/setup) was an in-browser setup. Now you use the seed.js script instead:

| Before | After |
|--------|-------|
| Manual form in browser | Automated script |
| Interactive setup | Command-line execution |
| Can only set admin account | Can seed events & settings too |
| Browser-based (slower) | Direct DB connection (faster) |

You can **keep or remove** the SetupPage from your code - the seed.js is the recommended production approach.

## Troubleshooting

### "MongooseconnectionError"
- Verify MongoDB is running
- Check MONGO_URI in .env is correct
- Ensure network connectivity to MongoDB server

### "Admin already exists"
- This is normal on subsequent runs (non-destructive by default)
- Use `node seed.js --clear` to replace existing data

### "E11000 duplicate key error"
- You may have duplicate admin emails
- Use `node seed.js --clear` to reset
- Or manually delete the admin document in MongoDB

## Security Notes

🔒 **Important for Production:**
- Use strong, unique passwords in `.env`
- Don't commit `.env` to version control
- Load `.env` from secure secret management system
- Change default admin password after first login
- Consider disabling /admin/setup route in server.js

## Example Production Workflow

```bash
# 1. Clone repo
git clone <your-repo>
cd backend

# 2. Install dependencies
npm install

# 3. Set up .env with production values
echo "MONGO_URI=<your-mongodb-url>" > .env
echo "SEED_ADMIN_EMAIL=prod-admin@yourorg.com" >> .env
echo "SEED_ADMIN_PASSWORD=<strong-password>" >> .env

# 4. Seed the database
node seed.js

# 5. Start server (in production, use PM2, etc.)
npm start
```

## File Location

```
backend/
├── seed.js                 ← Database seeding script
├── server.js               ← Main server file
├── models/
│   └── index.js            ← Database models
├── package.json
├── .env                    ← Your configuration
└── .env.example            ← Example configuration
```

## Need Help?

Check the seeding output for detailed messages about what was created or skipped. All operations are logged to console with emojis for easy reading.

---

## Database Migrations

### UUCMS Uppercase Migration

**Purpose:** All UUCMS (University Unique Code/Number) entries must be stored in UPPERCASE format for consistency and easy searching.

**When to Run:**
- After updating the code to the latest version
- If you have existing registrations with lowercase UUCMS
- To normalize data across the database

**Running the Migration:**
```bash
cd backend
node migrate-uucms.js
```

**What it does:**
- Finds all registrations in the database
- Converts any lowercase UUCMS to UPPERCASE
- Logs each conversion for auditing
- Shows summary of updates

**Example Output:**
```
🚀 Starting UUCMS uppercase migration...

✅ Connected to MongoDB

📊 Found 150 registrations to check

📝 Converting: John Doe | u02cg23s0001 → U02CG23S0001
📝 Converting: Jane Smith | u02eb24c0050 → U02EB24C0050
...

═══════════════════════════════════════
✅ Migration completed successfully!
═══════════════════════════════════════

📊 Summary:
   Registrations updated: 45
   Players updated: 78
```

**Automatic Enforcement:**
- New registrations automatically convert UUCMS to UPPERCASE
- Frontend input field shows real-time uppercase conversion
- Backend enforces uppercase storage via pre-save hook

