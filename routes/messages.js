const router = require('express').Router();
const { Message, Admin } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

// Public: Get all announcements
router.get('/', async (req, res) => {
  try {
    const messages = await Message.find()
      .populate('adminId', 'name')
      .sort({ createdAt: -1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Post a new announcement
router.post('/', auth, requirePermission('view_registrations'), async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: 'Message cannot be empty' });
    }

    const newMessage = new Message({
      adminName: req.admin.name,
      adminId: req.admin.id,
      message: String(message).trim()
    });

    await newMessage.save();
    const populated = await newMessage.populate('adminId', 'name');
    res.status(201).json({ message: 'Announcement posted successfully', data: populated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Delete a specific announcement
router.delete('/:id', auth, requirePermission('manage_registrations'), async (req, res) => {
  try {
    const message = await Message.findByIdAndDelete(req.params.id);
    if (!message) return res.status(404).json({ message: 'Announcement not found' });
    res.json({ message: 'Announcement deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Delete all announcements
router.delete('/', auth, requirePermission('manage_registrations'), async (req, res) => {
  try {
    const result = await Message.deleteMany({});
    res.json({ message: `${result.deletedCount} announcements deleted successfully` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
