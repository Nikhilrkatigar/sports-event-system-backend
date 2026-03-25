// Import all models from separate files
const Admin = require('./Admin');
const Event = require('./Event');
const Application = require('./Application');
const Gallery = require('./Gallery');
const Leaderboard = require('./Leaderboard');
const Settings = require('./Settings');
const AuditLog = require('./AuditLog');
const Tournament = require('./Tournament');
const TournamentMatch = require('./TournamentMatch');
const TimelineItem = require('./TimelineItem');
const Message = require('./Message');

module.exports = {
  Admin,
  Event,
  Application,
  Gallery,
  Leaderboard,
  Settings,
  AuditLog,
  Tournament,
  TournamentMatch,
  TimelineItem,
  Message
};

