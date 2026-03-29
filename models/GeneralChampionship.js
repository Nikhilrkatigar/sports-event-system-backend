const mongoose = require('mongoose');

const generalChampionshipEntrySchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  eventTitle: { type: String, required: true },
  isTeamEvent: { type: Boolean, default: false },
  departmentName: { type: String, required: true },
  position: { type: Number, enum: [1, 2, 3], required: true }, // 1st, 2nd, 3rd
  participantName: { type: String, required: true },
  points: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const generalChampionshipSchema = new mongoose.Schema({
  championship_id: { type: String, unique: true, sparse: true }, // e.g., "gc-2024"
  name: { type: String, default: 'General Championship' },
  description: String,
  entries: [generalChampionshipEntrySchema],
  departmentScores: { type: mongoose.Schema.Types.Mixed, default: {} }, // Plain object for JSON serialization
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('GeneralChampionship', generalChampionshipSchema);
