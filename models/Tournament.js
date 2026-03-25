const mongoose = require('mongoose');

const tournamentParticipantSchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  label: { type: String, required: true },
  isBye: { type: Boolean, default: false }
}, { _id: false });

const tournamentSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, unique: true },
  format: { type: String, enum: ['single_elimination', 'round_robin', 'track_heats'], required: true },
  participants: [tournamentParticipantSchema],
  status: { type: String, enum: ['draft', 'in_progress', 'completed'], default: 'draft' },
  // Social features - using deviceId for public interactions
  likes: { type: [String], default: [] },
  interested: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Tournament', tournamentSchema);
