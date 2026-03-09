const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Import models
const { Admin, Event, Settings, Leaderboard, Application, Gallery, AuditLog } = require('./models');

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@college.edu';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin@123';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Admin User';

const seedDatabase = async () => {
  try {
    console.log('🌱 Starting database seed...\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Clear existing data (optional - comment out if you don't want to clear)
    const clearDatabase = process.argv.includes('--clear');
    if (clearDatabase) {
      console.log('🗑️  Clearing existing data...');
      await Admin.deleteMany({});
      await Event.deleteMany({});
      await Settings.deleteMany({});
      await Application.deleteMany({});
      await Leaderboard.deleteMany({});
      await Gallery.deleteMany({});
      await AuditLog.deleteMany({});
      console.log('✅ Database cleared\n');
    }

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ email: ADMIN_EMAIL });
    if (!existingAdmin) {
      console.log('👤 Creating admin account...');
      const admin = new Admin({
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        role: 'Admin'
      });
      await admin.save();
      console.log(`✅ Admin created: ${ADMIN_EMAIL}\n`);
    } else {
      console.log(`ℹ️  Admin already exists: ${ADMIN_EMAIL}\n`);
    }

    // Check if events already exist
    const existingEvents = await Event.countDocuments();
    if (existingEvents === 0) {
      console.log('🏆 Creating default events...');
      const sampleEvents = [
        {
          title: 'Cricket Championship',
          type: 'team',
          teamSize: 11,
          description: 'Inter-college cricket tournament with exciting prizes',
          rules: '1. Standard cricket rules apply\n2. Fair play is mandatory\n3. All players must be registered',
          maxParticipants: 16,
          date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
          image: null
        },
        {
          title: 'Basketball Tournament',
          type: 'team',
          teamSize: 5,
          description: 'Fast-paced basketball competition',
          rules: '1. FIBA rules apply\n2. 4 quarters of 8 minutes each\n3. Fouls tracked per player',
          maxParticipants: 12,
          date: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
          image: null
        },
        {
          title: '100M Sprint',
          type: 'single',
          teamSize: 1,
          description: 'Individual track and field event',
          rules: '1. False starts not allowed\n2. Electronic timing only\n3. Single lane per participant',
          maxParticipants: 30,
          date: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
          image: null
        },
        {
          title: 'Badminton Doubles',
          type: 'team',
          teamSize: 2,
          description: 'Badminton doubles championship',
          rules: '1. Best of 3 sets\n2. Scoring to 21 points\n3. Rally scoring rules',
          maxParticipants: 20,
          date: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
          image: null
        },
        {
          title: 'Chess Tournament',
          type: 'single',
          teamSize: 1,
          description: 'Individual chess competition',
          rules: '1. Standard chess rules (FIDE)\n2. Time control: 10 minutes\n3. No outside assistance',
          maxParticipants: 32,
          date: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
          image: null
        }
      ];

      for (const eventData of sampleEvents) {
        const event = new Event(eventData);
        await event.save();
        console.log(`  ✓ ${event.title}`);
      }
      console.log('✅ Events created\n');
    } else {
      console.log(`ℹ️  Events already exist (${existingEvents} found)\n`);
    }

    // Check if settings already exist
    const existingSettings = await Settings.countDocuments();
    if (existingSettings === 0) {
      console.log('⚙️  Creating default settings...');
      const settings = new Settings({
        collegeName: 'Global College',
        eventName: 'Annual Sports Day 2026',
        eventDate: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
        venue: 'Sports Ground, Main Campus',
        description: 'Join us for an exciting day of sports, competition, and camaraderie!',
        departments: ['BCA', 'MCA', 'BBA', 'MBA', 'B.Com', 'B.Sc', 'B.Tech', 'M.Tech', 'BA', 'MA', 'B.Ed', 'Other']
      });
      await settings.save();
      console.log('✅ Settings created\n');
    } else {
      console.log(`ℹ️  Settings already exist\n`);
    }

    console.log('════════════════════════════════════════');
    console.log('🎉 Database seeding completed successfully!');
    console.log('════════════════════════════════════════\n');

    console.log('📋 Seeded Information:');
    console.log(`   Admin Email: ${ADMIN_EMAIL}`);
    console.log(`   Admin Password: ${ADMIN_PASSWORD}`);
    console.log(`   Admin Name: ${ADMIN_NAME}\n`);

    console.log('💡 Next Steps:');
    console.log('   1. Start the server: npm start');
    console.log('   2. Open: http://localhost:5000 (or your configured URL)');
    console.log('   3. Go to /admin/login');
    console.log('   4. Login with the credentials above\n');

    console.log('🔧 Useful Commands:');
    console.log('   Clear & reseed: node seed.js --clear');
    console.log('   Environment variables to customize:');
    console.log('   - SEED_ADMIN_EMAIL');
    console.log('   - SEED_ADMIN_PASSWORD');
    console.log('   - SEED_ADMIN_NAME\n');

  } catch (error) {
    console.error('❌ Seeding error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

// Run the seed
seedDatabase();
