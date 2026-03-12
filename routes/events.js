const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Event, Application, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requireFullAccess = require('../middleware/requireFullAccess');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/events';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Public: Get all events
router.get('/', async (req, res) => {
  try {
    const events = await Event.find().sort({ date: 1 });
    // Add registration counts
    const eventsWithCounts = await Promise.all(events.map(async (event) => {
      const regs = await Application.find({ eventId: event._id });
      const teamCount = regs.length;
      const playerCount = regs.reduce((sum, r) => sum + r.players.filter(p => !p.isSubstitute).length, 0);
      return { ...event.toObject(), teamCount, playerCount };
    }));
    res.json(eventsWithCounts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get single event
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Create event
router.post('/', auth, requireFullAccess, upload.single('image'), async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.file) data.image = `/uploads/events/${req.file.filename}`;
    const event = new Event(data);
    await event.save();
    await AuditLog.create({ action: `Event Created: ${event.title}`, admin: req.admin.name, ip: req.ip });
    res.status(201).json(event);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Update event
router.put('/:id', auth, requireFullAccess, upload.single('image'), async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.file) data.image = `/uploads/events/${req.file.filename}`;
    const event = await Event.findByIdAndUpdate(req.params.id, data, { new: true });
    await AuditLog.create({ action: `Event Updated: ${event.title}`, admin: req.admin.name, ip: req.ip });
    res.json(event);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Toggle registration open/closed
router.patch('/:id/toggle-registration', auth, requireFullAccess, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    event.registrationOpen = !event.registrationOpen;
    await event.save();
    const status = event.registrationOpen ? 'opened' : 'closed';
    await AuditLog.create({ action: `Registration ${status}: ${event.title}`, admin: req.admin.name, ip: req.ip });
    res.json(event);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Delete event
router.delete('/:id', auth, requireFullAccess, async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    await AuditLog.create({ action: `Event Deleted: ${event.title}`, admin: req.admin.name, ip: req.ip });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
