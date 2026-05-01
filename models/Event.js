const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, enum: ['single', 'team'], required: true },
  eventCategory: { type: String, enum: ['general', 'track', 'field'], default: 'general' },
  sportType: { type: String, enum: ['standard', 'cricket'], default: 'standard' },
  status: {
    type: String,
    enum: ['draft', 'coming_soon', 'published', 'open', 'full', 'closed', 'live', 'completed', 'archived'],
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
  allowFemaleRequirementShortfall: { type: Boolean, default: false },
  // Gender participation restrictions (empty means all genders allowed)
  allowedGenders: { type: [String], enum: ['male', 'female'], default: ['male', 'female'] },
  // Department restrictions (empty means all departments allowed)
  allowedDepartments: { type: [String], default: [] },
  // Payment
  registrationFee: { type: Number, default: 0 },
  upiPaymentLink: { type: String, default: '' },
  paymentQRCode: { type: String, default: '' },
  // Track event configuration (used for track races and relay heats)
  lanesPerHeat: { type: Number, default: 8, min: 1, max: 20 },
  // Field event configuration (shot put, long jump, etc.)
  fieldAttempts: { type: Number, default: 3, min: 1, max: 10 },
  // Cricket event configuration
  cricketOvers: { type: Number, default: 20, min: 1, max: 100 },
  // Social features
  likes: { type: [String], default: [] },
  interested: { type: [String], default: [] },
  shares: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Event', eventSchema);
