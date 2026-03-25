const mongoose = require('mongoose');

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

module.exports = mongoose.model('TimelineItem', timelineItemSchema);
