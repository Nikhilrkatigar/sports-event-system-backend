const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  uucms: { type: String, required: true },
  phone: String,
  department: String,
  gender: { type: String, enum: ['male', 'female', 'unspecified'], default: 'unspecified' },
  qrCode: String,
  checkInStatus: { type: Boolean, default: false },
  isSubstitute: { type: Boolean, default: false },
  isTeamLeader: { type: Boolean, default: false }
});

const applicationSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  teamId: String,
  teamName: String,
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
