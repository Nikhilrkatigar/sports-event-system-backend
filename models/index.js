const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Admin User
const adminSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'Admin' },
  createdAt: { type: Date, default: Date.now }
});
adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});
const Admin = mongoose.model('Admin', adminSchema);

// Event
const eventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, enum: ['single', 'team'], required: true },
  teamSize: { type: Number, default: 1 },
  description: String,
  rules: String,
  maxParticipants: Number,
  date: Date,
  image: String,
  createdAt: { type: Date, default: Date.now }
});
const Event = mongoose.model('Event', eventSchema);

// Player sub-schema
const playerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  uucms: { type: String, required: true },
  phone: String,
  department: String,
  qrCode: String,
  checkInStatus: { type: Boolean, default: false },
  isSubstitute: { type: Boolean, default: false },
  isTeamLeader: { type: Boolean, default: false }
});

// Application / Registration
const applicationSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  teamId: String,
  teamName: String,
  qrCode: String,
  players: [playerSchema],
  createdAt: { type: Date, default: Date.now }
});
const Application = mongoose.model('Application', applicationSchema);

// Gallery
const gallerySchema = new mongoose.Schema({
  image: { type: String, required: true },
  caption: String,
  createdAt: { type: Date, default: Date.now }
});
const Gallery = mongoose.model('Gallery', gallerySchema);

// Leaderboard
const leaderboardSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
  teamOrPlayer: String,
  score: Number,
  rank: Number,
  updatedAt: { type: Date, default: Date.now }
});
const Leaderboard = mongoose.model('Leaderboard', leaderboardSchema);

// Settings
const settingsSchema = new mongoose.Schema({
  collegeName: { type: String, default: 'Global College' },
  collegeLogo: String,
  eventName: { type: String, default: 'Annual Sports Day' },
  eventDate: Date,
  venue: String,
  description: String,
  departments: {
    type: [String],
    default: ['BCA', 'MCA', 'BBA', 'MBA', 'B.Com', 'B.Sc', 'B.Tech', 'M.Tech', 'BA', 'MA', 'B.Ed', 'Other']
  }
});
const Settings = mongoose.model('Settings', settingsSchema);

// Audit Log
const auditSchema = new mongoose.Schema({
  action: String,
  admin: String,
  timestamp: { type: Date, default: Date.now },
  ip: String
});
const AuditLog = mongoose.model('AuditLog', auditSchema);

module.exports = { Admin, Event, Application, Gallery, Leaderboard, Settings, AuditLog };
