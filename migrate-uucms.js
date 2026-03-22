const mongoose = require('mongoose');
require('dotenv').config();

const { Application } = require('./models');

const migrateUucmsToUppercase = async () => {
  try {
    console.log('🚀 Starting UUCMS uppercase migration...\n');

    // Connect MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all applications with players
    const allApplications = await Application.find();
    console.log(`📊 Found ${allApplications.length} registrations to check\n`);

    let updated = 0;
    let totalPlayersUpdated = 0;

    // Process each application
    for (const application of allApplications) {
      let hasChanges = false;
      
      if (application.players && Array.isArray(application.players)) {
        for (const player of application.players) {
          if (player.uucms && player.uucms !== String(player.uucms).toUpperCase()) {
            console.log(`📝 Converting: ${player.name} | ${player.uucms} → ${String(player.uucms).toUpperCase()}`);
            player.uucms = String(player.uucms).toUpperCase();
            hasChanges = true;
            totalPlayersUpdated++;
          }
        }
      }

      // Save if there were changes
      if (hasChanges) {
        await application.save();
        updated++;
      }
    }

    console.log('\n═══════════════════════════════════════');
    console.log('✅ Migration completed successfully!');
    console.log('═══════════════════════════════════════\n');
    console.log(`📊 Summary:`);
    console.log(`   Registrations updated: ${updated}`);
    console.log(`   Players updated: ${totalPlayersUpdated}\n`);

  } catch (error) {
    console.error('❌ Migration error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

// Run migration
migrateUucmsToUppercase();
