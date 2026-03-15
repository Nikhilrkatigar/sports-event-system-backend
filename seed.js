const mongoose = require('mongoose');
require('dotenv').config();

// Import only Admin model
const { Admin } = require('./models');

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@college.edu';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || '';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Super Admin';

const seedDatabase = async () => {
  try {
    console.log('Starting admin seed...\n');

    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is required');
    }
    if (!ADMIN_PASSWORD || ADMIN_PASSWORD.trim().length < 8) {
      throw new Error('SEED_ADMIN_PASSWORD must be provided and be at least 8 characters long');
    }

    // Connect MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB\n');

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ email: ADMIN_EMAIL });

    if (!existingAdmin) {
      console.log('Creating admin account...');

      const admin = new Admin({
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        role: 'Super Admin'
      });

      await admin.save();

      console.log('Super Admin created successfully.\n');
      console.log(`Admin Name: ${ADMIN_NAME}`);
      console.log(`Admin Email: ${ADMIN_EMAIL}`);
      console.log('Password was provided from SEED_ADMIN_PASSWORD and was not echoed for security.\n');
    } else {
      console.log('Admin already exists with this email.\n');
    }

  } catch (error) {
    console.error('Seeding error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
    process.exit(0);
  }
};

// Run seed
seedDatabase();
