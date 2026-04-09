const router = require('express').Router();
const { Leaderboard, Event, Application, Tournament, TournamentMatch } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { calculateGeneralChampionship } = require('../utils/generalChampionship');

const resolveScoreOrder = async (eventId) => {
  if (!eventId) return 'desc';
  const [event, tournament] = await Promise.all([
    Event.findById(eventId).select('scoreOrder eventCategory'),
    Tournament.findOne({ eventId }).sort({ createdAt: -1 }).select('format')
  ]);

  if (tournament?.format === 'track_heats') return 'asc';
  if (tournament?.format === 'field_flight') return 'desc';
  if (event?.eventCategory === 'track') return 'asc';
  if (event?.eventCategory === 'field') return 'desc';
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

const buildTournamentScopeQuery = (eventId, tournament) => {
  const query = { eventId };

  if (['male', 'female'].includes(tournament?.genderFilter)) {
    query.gender = { $in: [tournament.genderFilter, 'unspecified'] };
  }

  return query;
};

const syncPodiumToLeaderboard = async (eventId, tournament, podiumEntries = []) => {
  if (!Array.isArray(podiumEntries) || podiumEntries.length === 0) {
    return 0;
  }

  const scopeQuery = buildTournamentScopeQuery(eventId, tournament);
  const existingEntries = await Leaderboard.find(scopeQuery).sort({ _id: 1 });
  const existingByLabel = new Map();

  existingEntries.forEach((entry) => {
    const key = String(entry.teamOrPlayer || '').trim();
    if (!key) return;
    if (!existingByLabel.has(key)) existingByLabel.set(key, []);
    existingByLabel.get(key).push(entry);
  });

  const touchedIds = new Set();
  let syncedCount = 0;

  for (const podiumEntry of podiumEntries) {
    const label = String(podiumEntry.label || '').trim();
    if (!label) continue;

    const matchingEntries = existingByLabel.get(label) || [];
    const preferredGender = ['male', 'female'].includes(tournament?.genderFilter) ? tournament.genderFilter : null;
    const reusableEntry = matchingEntries.find((entry) => !touchedIds.has(String(entry._id)) && (!preferredGender || entry.gender === preferredGender))
      || matchingEntries.find((entry) => !touchedIds.has(String(entry._id)) && entry.gender === 'unspecified')
      || matchingEntries.find((entry) => !touchedIds.has(String(entry._id)));
    const gender = ['male', 'female'].includes(tournament?.genderFilter)
      ? tournament.genderFilter
      : await fetchGenderFromRegistration(eventId, label);
    const numericScore = Number(podiumEntry.score);
    const normalizedScore = Number.isFinite(numericScore) ? numericScore : 0;

    if (reusableEntry) {
      reusableEntry.score = normalizedScore;
      reusableEntry.gender = gender;
      reusableEntry.rank = null;
      reusableEntry.updatedAt = new Date();
      await reusableEntry.save();
      touchedIds.add(String(reusableEntry._id));

      for (const duplicateEntry of matchingEntries) {
        const duplicateId = String(duplicateEntry._id);
        if (duplicateId !== String(reusableEntry._id) && !touchedIds.has(duplicateId)) {
          await Leaderboard.findByIdAndDelete(duplicateEntry._id);
          touchedIds.add(duplicateId);
        }
      }
    } else {
      const created = await Leaderboard.create({
        eventId,
        teamOrPlayer: label,
        score: normalizedScore,
        gender,
        hype: 0
      });
      touchedIds.add(String(created._id));
    }

    syncedCount += 1;
  }

  const podiumLabels = new Set(
    podiumEntries
      .map((entry) => String(entry.label || '').trim())
      .filter(Boolean)
  );

  const staleEntryIds = existingEntries
    .filter((entry) => !podiumLabels.has(String(entry.teamOrPlayer || '').trim()))
    .map((entry) => entry._id);

  if (staleEntryIds.length > 0) {
    await Leaderboard.deleteMany({ _id: { $in: staleEntryIds } });
  }

  return syncedCount;
};

// Sync tournament results to leaderboard - Auto-add winners as leaderboard entries
const syncTournamentToLeaderboard = async (eventId, options = {}) => {
  try {
    const query = { eventId };
    if (options.tournamentId) query._id = options.tournamentId;
    else if (options.genderFilter && ['male', 'female', 'all'].includes(options.genderFilter)) query.genderFilter = options.genderFilter;

    const tournament = await Tournament.findOne(query).sort({ createdAt: -1 });
    if (!tournament || !['in_progress', 'completed'].includes(tournament.status)) {
      return { synced: 0, message: 'No completed tournament found' };
    }

    const event = await Event.findById(eventId);
    if (!event) return { synced: 0, message: 'Event not found' };

    const matches = await TournamentMatch.find({ tournamentId: tournament._id });
    if (!matches || matches.length === 0) return { synced: 0, message: 'No tournament matches found' };

    let syncedCount = 0;
    let podiumEntries = [];

    // Handle field flight format - winners already ranked
    if (tournament.format === 'field_flight') {
      for (const match of matches) {
        if (!Array.isArray(match.fieldEntries) || match.fieldEntries.length === 0) continue;

        // Get top 3 by rank
        const ranked = match.fieldEntries
          .filter((entry) => entry.rank != null && entry.rank <= 3)
          .sort((a, b) => a.rank - b.rank || a.order - b.order);

        podiumEntries = ranked.map((entry) => ({
          label: entry.label,
          score: Number(entry.bestScore ?? entry.performance ?? 0)
        }));
        break;
      }
    }

    // Handle track heats format - participant with best time/lowest time
    if (tournament.format === 'track_heats') {
      const completedMatches = matches.filter((match) => match.status === 'completed');
      const latestRound = completedMatches.length > 0
        ? Math.max(...completedMatches.map((match) => Number(match.round) || 1))
        : 1;

      let podiumCandidates = [];
      if (latestRound > 1) {
        podiumCandidates = completedMatches
          .filter((match) => (Number(match.round) || 1) === latestRound)
          .flatMap((match) => match.lanes || [])
          .filter((lane) => lane.finishPosition != null || String(lane.finishTime || '').trim());
      } else {
        podiumCandidates = completedMatches
          .flatMap((match) => (match.lanes || []).filter((lane) => lane.isQualified));

        if (podiumCandidates.length === 0) {
          podiumCandidates = completedMatches
            .flatMap((match) => match.lanes || [])
            .filter((lane) => lane.finishPosition != null || String(lane.finishTime || '').trim());
        }
      }

      const qualified = podiumCandidates
        .sort((a, b) => {
          const hasTimeA = Boolean(String(a.finishTime || '').trim());
          const hasTimeB = Boolean(String(b.finishTime || '').trim());
          if (hasTimeA && hasTimeB) {
            return (parseFloat(a.finishTime) || Infinity) - (parseFloat(b.finishTime) || Infinity)
              || (a.finishPosition ?? 999) - (b.finishPosition ?? 999)
              || a.lane - b.lane;
          }
          if (a.finishPosition == null) return 1;
          if (b.finishPosition == null) return -1;
          return a.finishPosition - b.finishPosition || a.lane - b.lane;
        });

      podiumEntries = qualified.slice(0, 3).map((lane) => ({
        label: lane.label,
        score: Number(lane.finishPosition || 0)
      }));
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

      podiumEntries = winners.map((winner) => ({
        label: winner.label,
        score: Number(winner.score || 0)
      }));
    }

    syncedCount = await syncPodiumToLeaderboard(eventId, tournament, podiumEntries);
    await recalcRanks(eventId);

    return { synced: syncedCount, message: `Auto-synced ${syncedCount} tournament winner(s) to leaderboard` };
  } catch (err) {
    console.error('Error syncing tournament to leaderboard:', err);
    return { synced: 0, message: `Sync error: ${err.message}` };
  }
};

const refreshLeaderboardFromTournaments = async () => {
  const tournaments = await Tournament.find({ status: { $in: ['in_progress', 'completed'] } })
    .select('_id eventId genderFilter updatedAt createdAt')
    .sort({ updatedAt: -1, createdAt: -1 });

  const seenScopes = new Set();

  for (const tournament of tournaments) {
    const scopeKey = `${String(tournament.eventId)}:${tournament.genderFilter || 'all'}`;
    if (seenScopes.has(scopeKey)) continue;
    seenScopes.add(scopeKey);
    await syncTournamentToLeaderboard(String(tournament.eventId), { tournamentId: tournament._id });
  }
};

// Admin endpoint: Sync tournament results to leaderboard
router.post('/sync-tournament/:eventId', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    const result = await syncTournamentToLeaderboard(req.params.eventId, {
      tournamentId: req.body?.tournamentId,
      genderFilter: req.body?.genderFilter
    });
    
    // Auto-recalculate General Championship after sync
    try {
      await calculateGeneralChampionship();
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
    if (req.query.refresh === '1') {
      await refreshLeaderboardFromTournaments();
    }
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

// Admin endpoint - delete ALL leaderboard entries (requires auth)
router.delete('/admin/delete-all', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    const result = await Leaderboard.deleteMany({});
    res.json({ 
      message: `All leaderboard entries deleted successfully! (${result.deletedCount} entries removed)`,
      deletedCount: result.deletedCount
    });
  } catch (err) { 
    console.error('Error deleting all entries:', err);
    res.status(500).json({ message: `Error: ${err.message}` }); 
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
