const mongoose = require('mongoose');

const normalizeDisplayTeamName = (value) => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const normalizeTeamNameKey = (value) => normalizeDisplayTeamName(value).replace(/[\s_]+/g, '');

const playerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  uucms: { type: String, required: true },
  phone: String,
  department: String,
  gender: { type: String, enum: ['male', 'female', 'unspecified'], default: 'unspecified' },
  role: { type: String, enum: ['', 'batsman', 'bowler', 'all_rounder', 'wicket_keeper'], default: '' },
  qrCode: String,
  checkInStatus: { type: Boolean, default: false },
  isSubstitute: { type: Boolean, default: false },
  isTeamLeader: { type: Boolean, default: false }
});

const applicationSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  teamId: String,
  teamName: String,
  teamNameNormalized: { type: String, index: true, sparse: true },
  registrationNumber: { type: String, unique: true, sparse: true },
  qrCode: String,
  players: [playerSchema],
  paymentStatus: { type: String, enum: ['pending', 'paid', 'free'], default: 'pending' },
  paymentVerifiedAt: { type: Date },
  verifiedByAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  paymentScreenshot: { type: String, default: '' },
  paymentScreenshotUploadedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

// Pre-save hook to normalize UUCMS to uppercase
applicationSchema.pre('save', function(next) {
  if (this.teamName) {
    this.teamName = normalizeDisplayTeamName(this.teamName);
    this.teamNameNormalized = normalizeTeamNameKey(this.teamName);
  } else {
    this.teamName = undefined;
    this.teamNameNormalized = undefined;
  }
  if (this.players && Array.isArray(this.players)) {
    this.players.forEach(player => {
      if (player.uucms) {
        player.uucms = String(player.uucms).trim().toUpperCase();
      }
    });
  }
  next();
});

module.exports = mongoose.model('Application', applicationSchema);
