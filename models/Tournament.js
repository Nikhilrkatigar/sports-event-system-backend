const mongoose = require('mongoose');

const tournamentParticipantSchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  label: { type: String, required: true },
  uucms: { type: String, default: '' },
  isBye: { type: Boolean, default: false }
}, { _id: false });

const tournamentSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  format: { type: String, enum: ['single_elimination', 'round_robin', 'track_heats', 'field_flight'], required: true },
  genderFilter: { type: String, enum: ['male', 'female', 'all'], default: 'all' },
  participants: [tournamentParticipantSchema],
  status: { type: String, enum: ['draft', 'in_progress', 'completed'], default: 'draft' },
  // Social features - using deviceId for public interactions
  likes: { type: [String], default: [] },
  interested: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});

// Compound unique index: one tournament per event per gender filter
tournamentSchema.index({ eventId: 1, genderFilter: 1 }, { unique: true });

module.exports = mongoose.model('Tournament', tournamentSchema);
