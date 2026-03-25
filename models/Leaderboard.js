const mongoose = require('mongoose');

const leaderboardSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
  teamOrPlayer: String,
  score: Number,
  gender: { type: String, enum: ['male', 'female', 'unspecified'], default: 'unspecified' },
  hype: { type: Number, default: 0 },
  rank: Number,
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Leaderboard', leaderboardSchema);
