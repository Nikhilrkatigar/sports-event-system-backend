const mongoose = require('mongoose');

const tournamentLaneSchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  label: { type: String, required: true },
  department: { type: String, default: '' },
  lane: { type: Number, required: true },
  finishPosition: { type: Number, default: null },
  finishTime: { type: String, default: '' },
  isQualified: { type: Boolean, default: false }
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
  score1: { type: Number, default: null },
  score2: { type: Number, default: null },
  winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  winner: { type: String, default: null },
  heatName: { type: String, default: null },
  lanes: { type: [tournamentLaneSchema], default: [] },
  status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
  scheduledTime: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('TournamentMatch', tournamentMatchSchema);
