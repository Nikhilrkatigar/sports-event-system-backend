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
  status: {
    type: String,
    enum: ['draft', 'coming_soon', 'published', 'open', 'full', 'live', 'completed', 'archived'],
    default: 'draft'
  },
  scoreOrder: { type: String, enum: ['asc', 'desc'], default: 'desc' },
  teamSize: { type: Number, default: 1 },
  description: String,
  rules: String,
  maxParticipants: Number,
  date: Date,
  startTime: String,
  registrationDeadline: Date,
  image: String,
  registrationOpen: { type: Boolean, default: true },
  // Gender composition requirements
  maleRequired: { type: Number, default: 0 },
  femaleRequired: { type: Number, default: 0 },
  // Gender participation restrictions (empty means all genders allowed)
  allowedGenders: { type: [String], enum: ['male', 'female'], default: ['male', 'female'] },
  // Department restrictions (empty means all departments allowed)
  allowedDepartments: { type: [String], default: [] },
  // Payment
  registrationFee: { type: Number, default: 0 },
  upiPaymentLink: { type: String, default: '' },
  paymentQRCode: { type: String, default: '' },
  // Social features
  likes: { type: [String], default: [] },
  interested: { type: [String], default: [] },
  shares: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Event = mongoose.model('Event', eventSchema);

// Player sub-schema
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

// Application / Registration
const applicationSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  teamId: String,
  teamName: String,
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
  gender: { type: String, enum: ['male', 'female', 'unspecified'], default: 'unspecified' },
  hype: { type: Number, default: 0 },
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
  announcement: { type: String, default: '' },
  homeNotice: String,
  announcementText: { type: String, default: '' },
  announcementActive: { type: Boolean, default: false },
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

// Tournament Match
const tournamentParticipantSchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  label: { type: String, required: true },
  isBye: { type: Boolean, default: false }
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
  status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
  scheduledTime: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now }
});
const TournamentMatch = mongoose.model('TournamentMatch', tournamentMatchSchema);

// Tournament
const tournamentSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, unique: true },
  format: { type: String, enum: ['single_elimination', 'round_robin'], required: true },
  participants: [tournamentParticipantSchema],
  status: { type: String, enum: ['draft', 'in_progress', 'completed'], default: 'draft' },
  // Social features
  likes: { type: [String], default: [] },
  interested: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});
const Tournament = mongoose.model('Tournament', tournamentSchema);

// Timeline Item
const timelineItemSchema = new mongoose.Schema({
  time: { type: String, required: true },          // e.g. "10:00 AM"
  title: { type: String, required: true },
  description: { type: String, default: '' },
  icon: { type: String, default: '🏆' },           // emoji icon
  color: { type: String, default: '#3b82f6' },     // accent color
  isPublic: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const TimelineItem = mongoose.model('TimelineItem', timelineItemSchema);

// Messages / Admin Announcements
const messageSchema = new mongoose.Schema({
  adminName: { type: String, required: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

module.exports = { Admin, Event, Application, Gallery, Leaderboard, Settings, AuditLog, Tournament, TournamentMatch, TimelineItem, Message };
