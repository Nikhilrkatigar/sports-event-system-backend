const router = require('express').Router();
const { Leaderboard, Event, Application, Tournament, TournamentMatch, GeneralChampionship } = require('../models');
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

// Sync tournament results to leaderboard - Auto-add winners as leaderboard entries
const syncTournamentToLeaderboard = async (eventId) => {
  try {
    const tournament = await Tournament.findOne({ eventId });
    if (!tournament || tournament.status !== 'in_progress') return { synced: 0, message: 'No completed tournament found' };

    const event = await Event.findById(eventId);
    if (!event) return { synced: 0, message: 'Event not found' };

    const matches = await TournamentMatch.find({ tournamentId: tournament._id });
    if (!matches || matches.length === 0) return { synced: 0, message: 'No tournament matches found' };

    let syncedCount = 0;

    // Handle field flight format - winners already ranked
    if (tournament.format === 'field_flight') {
      for (const match of matches) {
        if (!Array.isArray(match.fieldEntries) || match.fieldEntries.length === 0) continue;

        // Get top 3 by rank
        const ranked = match.fieldEntries.filter(e => e.rank != null && e.rank <= 3);
        
        for (const entry of ranked) {
          if (!entry.label) continue;
          
          const existing = await Leaderboard.findOne({ eventId, teamOrPlayer: entry.label });
          if (!existing) {
            const gender = await fetchGenderFromRegistration(eventId, entry.label);
            const newEntry = new Leaderboard({
              eventId,
              teamOrPlayer: entry.label,
              score: entry.bestScore || 0,
              gender,
              hype: 0
            });
            await newEntry.save();
            syncedCount++;
          }
        }
      }
    }

    // Handle track heats format - participant with best time/lowest time
    if (tournament.format === 'track_heats') {
      const qualified = matches
        .flatMap(m => (m.lanes || []).filter(lane => lane.isQualified))
        .sort((a, b) => {
          if (a.finishPosition == null) return 1;
          if (b.finishPosition == null) return -1;
          return a.finishPosition - b.finishPosition;
        });

      for (let i = 0; i < Math.min(3, qualified.length); i++) {
        const lane = qualified[i];
        if (!lane.label) continue;

        const existing = await Leaderboard.findOne({ eventId, teamOrPlayer: lane.label });
        if (!existing) {
          const gender = await fetchGenderFromRegistration(eventId, lane.label);
          const newEntry = new Leaderboard({
            eventId,
            teamOrPlayer: lane.label,
            score: lane.finishPosition || 0,
            gender,
            hype: 0
          });
          await newEntry.save();
          syncedCount++;
        }
      }
    }

    // Handle single elimination and round robin - tournament winner
    if (['single_elimination', 'round_robin'].includes(tournament.format)) {
      const winners = matches
        .filter(m => m.status === 'completed' && m.winner)
        .map(m => ({
          label: m.winner,
          score: (m.score1 || 0) + (m.score2 || 0)
        }))
        .reduce((acc, curr) => {
          const existing = acc.find(x => x.label === curr.label);
          if (existing) {
            existing.score += curr.score;
          } else {
            acc.push(curr);
          }
          return acc;
        }, [])
        .sort((a, b) => b.score - a.score)
        .slice(0, 3); // top 3

      for (const winner of winners) {
        if (!winner.label) continue;

        const existing = await Leaderboard.findOne({ eventId, teamOrPlayer: winner.label });
        if (!existing) {
          const gender = await fetchGenderFromRegistration(eventId, winner.label);
          const newEntry = new Leaderboard({
            eventId,
            teamOrPlayer: winner.label,
            score: winner.score,
            gender,
            hype: 0
          });
          await newEntry.save();
          syncedCount++;
        }
      }
    }

    if (syncedCount > 0) {
      await recalcRanks(eventId);
    }

    return { synced: syncedCount, message: `Auto-synced ${syncedCount} tournament winner(s) to leaderboard` };
  } catch (err) {
    console.error('Error syncing tournament to leaderboard:', err);
    return { synced: 0, message: `Sync error: ${err.message}` };
  }
};

// Admin endpoint: Sync tournament results to leaderboard
router.post('/sync-tournament/:eventId', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    const result = await syncTournamentToLeaderboard(req.params.eventId);
    
    // Auto-recalculate General Championship after sync
    try {
      const gc = await GeneralChampionship.findOne() || new GeneralChampionship({ championship_id: 'gc-main' });
      const departmentScores = new Map();
      
      // Get top 3 from each event in leaderboard
      const allLeaderboard = await Leaderboard.find().populate('eventId', 'title type');
      const eventGroups = new Map();
      
      for (const entry of allLeaderboard) {
        if (!entry.eventId) continue;
        const eventKey = entry.eventId._id.toString();
        if (!eventGroups.has(eventKey)) {
          eventGroups.set(eventKey, { eventId: entry.eventId._id, eventTitle: entry.eventId.title, isTeamEvent: entry.eventId.type === 'team', entries: [] });
        }
        eventGroups.get(eventKey).entries.push(entry);
      }
      
      gc.entries = [];
      const pointsMap = { 1: { individual: 15, team: 25 }, 2: { individual: 10, team: 15 }, 3: { individual: 5, team: 10 } };
      
      for (const [, eventData] of eventGroups.entries()) {
        const sorted = eventData.entries.filter(e => e.rank && e.rank <= 3).sort((a, b) => a.rank - b.rank);
        
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
          const entry = sorted[i];
          const position = i + 1;
          const app = await Application.findOne({ eventId: eventData.eventId, $or: [{ teamName: entry.teamOrPlayer }, { 'players.name': entry.teamOrPlayer }] });
          const department = app?.players?.[0]?.department || 'Unassigned';
          const points = eventData.isTeamEvent ? pointsMap[position].team : pointsMap[position].individual;
          
          gc.entries.push({ eventId: eventData.eventId, eventTitle: eventData.eventTitle, isTeamEvent: eventData.isTeamEvent, departmentName: department, position, participantName: entry.teamOrPlayer, points });
          departmentScores.set(department, (departmentScores.get(department) || 0) + points);
        }
      }
      
      gc.departmentScores = departmentScores;
      gc.updatedAt = new Date();
      await gc.save();
    } catch (gcErr) {
      console.error('Error updating GC:', gcErr);
    }
    
    res.json({ ...result, message: result.message + ' (General Championship updated)' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

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
