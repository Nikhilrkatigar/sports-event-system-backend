const mongoose = require('mongoose');

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
  },
  termsAndConditions: {
    type: String,
    default: 'By registering for this event, you agree to abide by all rules and regulations. You must be a valid student of this institution. Provide accurate information during registration. Participants are responsible for their own safety and well-being. Organizers reserve the right to disqualify participants for misconduct.'
  },
  maxSingleEventRegistrations: {
    type: Number,
    default: 2,
    min: 1,
    max: 10
  },
  maxTeamEventRegistrations: {
    type: Number,
    default: 999,
    min: 1
  },
  maxPlayersPerTeam: {
    type: Number,
    default: 5,
    min: 1,
    max: 20
  }
});

module.exports = mongoose.model('Settings', settingsSchema);
