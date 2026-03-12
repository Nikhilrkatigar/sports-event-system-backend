const mongoose = require('mongoose');
require('dotenv').config();

// Import only Admin model
const { Admin } = require('./models');

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@college.edu';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin@123';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Admin User';

const seedDatabase = async () => {
  try {
    console.log('🌱 Starting admin seed...\n');

    // Connect MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

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

      console.log('═══════════════════════════════');
      console.log('✅ Admin created successfully!');
      console.log('═══════════════════════════════\n');

      console.log(`Admin Name: ${ADMIN_NAME}`);
      console.log(`Admin Email: ${ADMIN_EMAIL}`);
      console.log(`Admin Password: ${ADMIN_PASSWORD}\n`);
    } else {
      console.log('ℹ️ Admin already exists with this email.\n');
    }

  } catch (error) {
    console.error('❌ Seeding error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

// Run seed
seedDatabase();