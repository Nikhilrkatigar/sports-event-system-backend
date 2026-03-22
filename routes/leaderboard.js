const router = require('express').Router();
const { Leaderboard, Event, Application } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

const resolveScoreOrder = async (eventId) => {
  if (!eventId) return 'desc';
  const event = await Event.findById(eventId).select('scoreOrder');
  return event?.scoreOrder === 'asc' ? 'asc' : 'desc';
};

const fetchGenderFromRegistration = async (eventId, teamOrPlayer) => {
  if (!eventId || !teamOrPlayer) return 'unspecified';
  
  const event = await Event.findById(eventId).select('type');
  if (!event) return 'unspecified';
  
  // Get ALL applications for this event
  const applications = await Application.find({ eventId });
  if (!applications || applications.length === 0) return 'unspecified';
  
  // For team events, look up team
  if (event.type === 'team') {
    for (const app of applications) {
      if (app.teamName === teamOrPlayer || app.teamId === teamOrPlayer) {
        // Get majority gender from team players
        const genders = app.players
          .filter(p => !p.isSubstitute)
          .map(p => p.gender || 'unspecified');
        if (genders.length === 0) continue;
        const maleCount = genders.filter(g => g === 'male').length;
        const femaleCount = genders.filter(g => g === 'female').length;
        if (maleCount > femaleCount) return 'male';
        if (femaleCount > maleCount) return 'female';
        return 'unspecified';
      }
    }
  } else {
    // For single events, find player by name across all applications
    for (const app of applications) {
      const player = app.players.find(
        p => !p.isSubstitute && (
          p.name === teamOrPlayer || 
          `${p.name} (${p.uucms})` === teamOrPlayer
        )
      );
      if (player && player.gender) return player.gender;
    }
  }
  
  return 'unspecified';
};

const recalcRanks = async (eventId) => {
  if (!eventId) return;
  const order = await resolveScoreOrder(eventId);
  const sortDir = order === 'asc' ? 1 : -1;
  const allEntries = await Leaderboard.find({ eventId }).sort({ gender: 1, score: sortDir, _id: 1 });
  if (allEntries.length === 0) return;

  const ops = [];
  const genders = ['male', 'female', 'unspecified'];
  
  genders.forEach((gender) => {
    const genderEntries = allEntries.filter(e => e.gender === gender);
    
    // Separate entries with score 0 (unscored) from those with actual scores
    const scoredEntries = genderEntries.filter(e => e.score !== null && e.score !== undefined && e.score !== 0);
    const unscoredEntries = genderEntries.filter(e => e.score === null || e.score === undefined || e.score === 0);
    
    let previousScore = null;
    let previousRank = 0;

    // Rank only entries with actual scores
    scoredEntries.forEach((entry, index) => {
      const currentScore = Number(entry.score);
      const rank = previousScore !== null && currentScore === previousScore ? previousRank : index + 1;
      previousScore = currentScore;
      previousRank = rank;

      ops.push({
        updateOne: {
          filter: { _id: entry._id },
          update: { rank }
        }
      });
    });

    // Set rank to null for unscored entries
    unscoredEntries.forEach((entry) => {
      ops.push({
        updateOne: {
          filter: { _id: entry._id },
          update: { rank: null }
        }
      });
    });
  });

  if (ops.length > 0) await Leaderboard.bulkWrite(ops);
};

router.get('/', async (req, res) => {
  try {
    const data = await Leaderboard.find().populate('eventId', 'title').sort({ rank: 1 });
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Public endpoint: Get registrations for unscored athletes display (for closed registration events)
router.get('/public/unscored/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    
    // Get event details
    const event = await Event.findById(eventId).select('title type registrationOpen');
    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }
    
    // Get all registrations for this event
    const applications = await Application.find({ eventId }).populate('eventId', 'title type');
    
    // Build list of unscored athletes (registrations that don't have leaderboard entries yet)
    const unscored = [];
    for (const app of applications) {
      // For team events
      if (event.type === 'team') {
        const teamName = app.teamName || app.teamId;
        const inLeaderboard = await Leaderboard.findOne({ 
          eventId, 
          teamOrPlayer: teamName 
        });
        
        if (!inLeaderboard) {
          const genders = app.players
            .filter(p => !p.isSubstitute)
            .map(p => p.gender || 'unspecified');
          const maleCount = genders.filter(g => g === 'male').length;
          const femaleCount = genders.filter(g => g === 'female').length;
          const gender = maleCount > femaleCount ? 'male' : femaleCount > maleCount ? 'female' : 'unspecified';
          
          unscored.push({
            _id: `temp-${teamName}-${eventId}`,
            eventId: app.eventId,
            teamOrPlayer: teamName,
            gender,
            hype: 0,
            isUnscored: true
          });
        }
      } else {
        // For single player events
        for (const player of app.players) {
          if (player.isSubstitute) continue;
          
          const displayName = player.uucms ? `${player.name} (${player.uucms})` : player.name;
          const inLeaderboard = await Leaderboard.findOne({ 
            eventId, 
            teamOrPlayer: displayName 
          });
          
          if (!inLeaderboard) {
            unscored.push({
              _id: `temp-${displayName}-${eventId}`,
              eventId: app.eventId,
              teamOrPlayer: displayName,
              gender: player.gender || 'unspecified',
              hype: 0,
              isUnscored: true
            });
          }
        }
      }
    }
    
    res.json(unscored);
  } catch (err) { 
    console.error('Error fetching unscored athletes:', err);
    res.status(500).json({ message: err.message }); 
  }
});

// Public endpoint: Create leaderboard entry from hype (no auth required)
router.post('/public/hype-create', async (req, res) => {
  try {
    const { eventId, teamOrPlayer, gender } = req.body;
    if (!eventId || !teamOrPlayer) {
      return res.status(400).json({ message: 'Event and player/team are required' });
    }
    
    // Check if entry already exists
    const existing = await Leaderboard.findOne({ eventId, teamOrPlayer });
    if (existing) {
      return res.json(existing);
    }
    
    // Create new entry with score 0 and hype 1
    const genderToUse = gender || await fetchGenderFromRegistration(eventId, teamOrPlayer);
    const entry = new Leaderboard({ 
      eventId, 
      teamOrPlayer, 
      score: 0,
      gender: genderToUse,
      hype: 1
    });
    await entry.save();
    await recalcRanks(eventId);
    
    // Populate eventId before sending response
    const populated = await Leaderboard.findById(entry._id).populate('eventId', 'title');
    res.status(201).json(populated);
  } catch (err) { 
    console.error('Error creating leaderboard entry:', err);
    res.status(500).json({ message: err.message }); 
  }
});

router.post('/', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    const { eventId, teamOrPlayer, score } = req.body;
    if (!eventId || !teamOrPlayer || score === undefined || score === null || score === '') {
      return res.status(400).json({ message: 'Event, player/team, and score are required' });
    }
    
    // Fetch gender from registration
    const gender = await fetchGenderFromRegistration(eventId, teamOrPlayer);
    
    const entry = new Leaderboard({ ...req.body, gender });
    await entry.save();
    await recalcRanks(entry.eventId);
    res.status(201).json(entry);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/:id', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    const existing = await Leaderboard.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Entry not found' });
    const previousEventId = existing.eventId;
    
    // If teamOrPlayer changed, refetch gender. Otherwise keep the provided gender or existing.
    let updateData = { ...req.body, updatedAt: new Date() };
    if (req.body.teamOrPlayer !== existing.teamOrPlayer || req.body.eventId !== String(existing.eventId)) {
      const eventId = req.body.eventId || existing.eventId;
      const teamOrPlayer = req.body.teamOrPlayer || existing.teamOrPlayer;
      updateData.gender = await fetchGenderFromRegistration(eventId, teamOrPlayer);
    } else if (!req.body.gender) {
      updateData.gender = existing.gender;
    }
    
    const entry = await Leaderboard.findByIdAndUpdate(req.params.id, updateData, { new: true });
    await recalcRanks(entry.eventId);
    if (previousEventId && String(previousEventId) !== String(entry.eventId)) {
      await recalcRanks(previousEventId);
    }
    res.json(entry);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/:id', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    const existing = await Leaderboard.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Entry not found' });
    await Leaderboard.findByIdAndDelete(req.params.id);
    await recalcRanks(existing.eventId);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Admin endpoint - reset ALL hype counts (requires auth)
router.patch('/admin/reset-all-hype', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    console.log('Reset all hype endpoint called');
    const result = await Leaderboard.updateMany({}, { $set: { hype: 0 } });
    console.log('Updated entries:', result.modifiedCount);
    
    const updatedEntries = await Leaderboard.find().populate('eventId', 'title').sort({ rank: 1 });
    res.json({ 
      message: `All hype counts reset successfully! (${result.modifiedCount} entries updated)`,
      data: updatedEntries 
    });
  } catch (err) { 
    console.error('Error resetting all hype:', err);
    res.status(500).json({ message: `Error: ${err.message}` }); 
  }
});

// Admin endpoint - reset hype count for a single player (requires auth)
router.patch('/admin/reset-hype/:id', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    const entry = await Leaderboard.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Entry not found' });
    entry.hype = 0;
    await entry.save();
    res.json(entry);
  } catch (err) { 
    console.error('Error resetting hype:', err);
    res.status(500).json({ message: err.message }); 
  }
});

// Hype endpoint - increment hype count for a player (public)
router.patch('/:id/hype', async (req, res) => {
  try {
    const entry = await Leaderboard.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Entry not found' });
    entry.hype = (entry.hype || 0) + 1;
    await entry.save();
    res.json(entry);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
