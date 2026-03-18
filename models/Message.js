const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  senderName: { type: String, required: true },
  senderEmail: { type: String, required: true },
  senderDepartment: { type: String },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  readAt: { type: Date }
});

module.exports = mongoose.model('Message', MessageSchema);
