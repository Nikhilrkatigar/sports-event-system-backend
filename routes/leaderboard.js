const router = require('express').Router();
const { Leaderboard, Event } = require('../models');
const auth = require('../middleware/auth');

const resolveScoreOrder = async (eventId) => {
  if (!eventId) return 'desc';
  const event = await Event.findById(eventId).select('scoreOrder');
  return event?.scoreOrder === 'asc' ? 'asc' : 'desc';
};

const recalcRanks = async (eventId) => {
  if (!eventId) return;
  const order = await resolveScoreOrder(eventId);
  const sortDir = order === 'asc' ? 1 : -1;
  const entries = await Leaderboard.find({ eventId }).sort({ score: sortDir, _id: 1 });
  if (entries.length === 0) return;

  const ops = entries.map((entry, index) => ({
    updateOne: {
      filter: { _id: entry._id },
      update: { rank: index + 1 }
    }
  }));
  await Leaderboard.bulkWrite(ops);
};

router.get('/', async (req, res) => {
  try {
    const data = await Leaderboard.find().populate('eventId', 'title').sort({ rank: 1 });
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { eventId, teamOrPlayer, score } = req.body;
    if (!eventId || !teamOrPlayer || score === undefined || score === null || score === '') {
      return res.status(400).json({ message: 'Event, player/team, and score are required' });
    }
    const entry = new Leaderboard(req.body);
    await entry.save();
    await recalcRanks(entry.eventId);
    res.status(201).json(entry);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const existing = await Leaderboard.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Entry not found' });
    const previousEventId = existing.eventId;
    const entry = await Leaderboard.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true });
    await recalcRanks(entry.eventId);
    if (previousEventId && String(previousEventId) !== String(entry.eventId)) {
      await recalcRanks(previousEventId);
    }
    res.json(entry);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const existing = await Leaderboard.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Entry not found' });
    await Leaderboard.findByIdAndDelete(req.params.id);
    await recalcRanks(existing.eventId);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
