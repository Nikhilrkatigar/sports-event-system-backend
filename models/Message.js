const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  // Announcement fields (used by admin CRM/announcements)
  adminName: { type: String },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  // Contact-form fields (kept for backwards compatibility)
  senderName: { type: String },
  senderEmail: { type: String },
  senderDepartment: { type: String },
  // Common fields
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  readAt: { type: Date }
});

module.exports = mongoose.model('Message', MessageSchema);
