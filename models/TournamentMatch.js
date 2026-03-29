const mongoose = require('mongoose');

const tournamentLaneSchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  label: { type: String, required: true },
  uucms: { type: String, default: '' },
  department: { type: String, default: '' },
  lane: { type: Number, required: true },
  finishPosition: { type: Number, default: null },
  finishTime: { type: String, default: '' },
  isQualified: { type: Boolean, default: false }
}, { _id: false });

const tournamentFieldEntrySchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  label: { type: String, required: true },
  uucms: { type: String, default: '' },
  registrationNumber: { type: String, default: '' },
  department: { type: String, default: '' },
  order: { type: Number, required: true },
  attempts: { type: [Number], default: [null, null, null] },
  bestScore: { type: Number, default: null },
  performance: { type: Number, default: null },
  rank: { type: Number, default: null }
}, { _id: false });

const tournamentMatchSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  round: { type: Number, required: true },
  matchNumber: { type: Number, required: true },
  participant1Id: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  participant2Id: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  participant1: { type: String, default: null },
  participant2: { type: String, default: null },
  participant1Uucms: { type: String, default: '' },
  participant2Uucms: { type: String, default: '' },
  score1: { type: Number, default: null },
  score2: { type: Number, default: null },
  winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  winner: { type: String, default: null },
  winnerUucms: { type: String, default: '' },
  heatName: { type: String, default: null },
  lanes: { type: [tournamentLaneSchema], default: [] },
  fieldEntries: { type: [tournamentFieldEntrySchema], default: [] },
  status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
  scheduledTime: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('TournamentMatch', tournamentMatchSchema);
