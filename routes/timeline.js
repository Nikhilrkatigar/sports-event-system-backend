const router = require('express').Router();
const { TimelineItem, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

console.log('Timeline route loading... TimelineItem model:', typeof TimelineItem);

// Public: Get visible timeline items only
router.get('/', async (req, res) => {
  console.log('GET /api/timeline called');
  try {
    console.log('TimelineItem:', typeof TimelineItem, TimelineItem.collection ? 'has collection' : 'no collection');
    const items = await TimelineItem.find({ isPublic: true }).sort({ order: 1, time: 1 }).lean();
    console.log('Found items:', items.length);
    res.json(items);
  } catch (err) {
    console.error('Timeline GET error:', err.stack);
    res.status(500).json({ message: err.message, error: err.toString() });
  }
});

// Admin: Get all timeline items (including hidden)
router.get('/all', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const items = await TimelineItem.find().sort({ order: 1, time: 1 }).lean();
    res.json(items);
  } catch (err) {
    console.error('Timeline GET /all error:', err);
    res.status(500).json({ message: err.message, error: err.toString() });
  }
});

// Admin: Create timeline item
router.post('/', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const { time, title, description, icon, color, isPublic, order } = req.body;
    if (!time || !title) return res.status(400).json({ message: 'time and title are required' });
    const item = new TimelineItem({ time, title, description, icon, color, isPublic, order });
    await item.save();
    await AuditLog.create({ action: `Timeline Item Created: ${title}`, admin: req.admin.name, ip: req.ip });
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Update timeline item
router.put('/:id', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const { time, title, description, icon, color, isPublic, order } = req.body;
    const item = await TimelineItem.findByIdAndUpdate(
      req.params.id,
      { time, title, description, icon, color, isPublic, order },
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ message: 'Timeline item not found' });
    await AuditLog.create({ action: `Timeline Item Updated: ${item.title}`, admin: req.admin.name, ip: req.ip });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Toggle visibility
router.patch('/:id/toggle-visibility', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const item = await TimelineItem.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Timeline item not found' });
    item.isPublic = !item.isPublic;
    await item.save();
    const status = item.isPublic ? 'shown' : 'hidden';
    await AuditLog.create({ action: `Timeline Item ${status}: ${item.title}`, admin: req.admin.name, ip: req.ip });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Delete timeline item
router.delete('/:id', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const item = await TimelineItem.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: 'Timeline item not found' });
    await AuditLog.create({ action: `Timeline Item Deleted: ${item.title}`, admin: req.admin.name, ip: req.ip });
    res.json({ message: 'Timeline item deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
