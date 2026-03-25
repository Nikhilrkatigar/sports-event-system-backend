const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema({
  action: String,
  admin: String,
  timestamp: { type: Date, default: Date.now },
  ip: String
});

module.exports = mongoose.model('AuditLog', auditSchema);
