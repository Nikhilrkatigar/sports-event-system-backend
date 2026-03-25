const router = require('express').Router();
const { Tournament, TournamentMatch, Application, Event, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { emitTournamentMatchUpdate } = require('../utils/socket');

const TRACK_LANE_ORDER = [4, 5, 3, 6, 2, 7, 1, 8];

// Generate lane order for any number of lanes (staggered pattern from middle outward)
const generateLaneOrder = (laneCount) => {
  if (laneCount === 8) return TRACK_LANE_ORDER;
  
  const lanes = Array.from({ length: laneCount }, (_, i) => i + 1);
  const result = [];
  const middle = Math.floor(laneCount / 2);
  
  // Start from middle and alternate outward
  const visited = new Set();
  for (let distance = 0; distance <= middle; distance++) {
    // Right side from middle
    if (middle + distance <= laneCount && !visited.has(middle + distance)) {
      result.push(middle + distance);
      visited.add(middle + distance);
    }
    // Left side from middle
    if (middle - distance > 0 && !visited.has(middle - distance)) {
      result.push(middle - distance);
      visited.add(middle - distance);
    }
  }
  return result;
};
const TOURNAMENT_FORMATS = ['single_elimination', 'round_robin', 'track_heats'];

const nextPowerOf2 = (n) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

const shuffleInPlace = (items = []) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

const getMainPlayer = (application) => (
  application.players.find((player) => !player.isSubstitute) || application.players[0]
);

const toParticipantLabel = (event, application) => {
  if (event.type === 'team') {
    return application.teamName || application.teamId || `Team ${application._id.toString().slice(-4)}`;
  }
  const mainPlayer = getMainPlayer(application);
  return mainPlayer?.name || `Player ${application._id.toString().slice(-4)}`;
};

const buildParticipantPayload = (event, application) => ({
  applicationId: application._id,
  label: toParticipantLabel(event, application),
  isBye: false
});

const buildHeatParticipantPayload = (application) => {
  const mainPlayer = getMainPlayer(application);
  return {
    applicationId: application._id,
    label: mainPlayer?.name || `Player ${application._id.toString().slice(-4)}`,
    department: String(mainPlayer?.department || 'Unassigned').trim() || 'Unassigned'
  };
};

const buildByeParticipant = () => ({
  applicationId: null,
  label: 'BYE',
  isBye: true
});

const hydrateTournament = (tournament) => {
  if (!tournament) return null;
  const data = tournament.toObject ? tournament.toObject() : tournament;
  return {
    ...data,
    participantCount: (data.participants || []).filter((participant) => !participant.isBye).length
  };
};

const buildHeatCycle = (heatCount) => {
  if (heatCount <= 1) return [0];
  const forward = Array.from({ length: heatCount }, (_, index) => index);
  const backward = Array.from({ length: heatCount - 2 }, (_, index) => heatCount - 2 - index);
  return [...forward, ...backward];
};

const spreadParticipantsAcrossHeats = (participants, heatCount, laneLimit) => {
  const heats = Array.from({ length: heatCount }, () => []);
  const cycle = buildHeatCycle(heatCount);
  const departmentMap = new Map();

  participants.forEach((participant) => {
    const department = participant.department || 'Unassigned';
    if (!departmentMap.has(department)) departmentMap.set(department, []);
    departmentMap.get(department).push(participant);
  });

  const departmentGroups = Array.from(departmentMap.entries())
    .map(([department, entries]) => ({ department, entries: shuffleInPlace([...entries]) }))
    .sort((a, b) => b.entries.length - a.entries.length || a.department.localeCompare(b.department));

  departmentGroups.forEach(({ entries }) => {
    let pointer = 0;

    entries.forEach((participant) => {
      let assigned = false;

      for (let attempt = 0; attempt < cycle.length * 2; attempt++) {
        const heatIndex = cycle[pointer % cycle.length];
        pointer += 1;

        if (heats[heatIndex].length < laneLimit) {
          heats[heatIndex].push(participant);
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        const fallbackIndex = heats.findIndex((heat) => heat.length < laneLimit);
        if (fallbackIndex !== -1) heats[fallbackIndex].push(participant);
      }
    });
  });

  return heats;
};

const assignTrackLanes = (participants, laneCount = 8) => {
  const laneOrder = generateLaneOrder(laneCount);
  const shuffled = shuffleInPlace([...participants]);
  return shuffled
    .map((participant, index) => ({
      applicationId: participant.applicationId,
      label: participant.label,
      department: participant.department,
      lane: laneOrder[index % laneOrder.length],
      finishPosition: null,
      finishTime: '',
      isQualified: false
    }))
    .sort((a, b) => a.lane - b.lane);
};

// Public: Get all tournaments
router.get('/', async (req, res) => {
  try {
    const tournaments = await Tournament.find().populate('eventId', 'title type image date status');
    res.json(tournaments.map(hydrateTournament));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get tournament + matches for an event
router.get('/event/:eventId', async (req, res) => {
  try {
    const tournament = await Tournament.findOne({ eventId: req.params.eventId }).populate('eventId', 'title type image date status');
    if (!tournament) return res.status(404).json({ message: 'No tournament found for this event' });
    const matches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });
    res.json({ tournament: hydrateTournament(tournament), matches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get all LIVE (in-progress) matches across all tournaments
router.get('/live', async (req, res) => {
  try {
    const liveMatches = await TournamentMatch.find({ status: 'in_progress' })
      .populate({
        path: 'tournamentId',
        select: 'format status',
        populate: { path: 'eventId', select: 'title type' }
      })
      .sort({ updatedAt: -1 })
      .limit(10);

    const validLive = liveMatches.filter((match) => match.tournamentId && match.tournamentId.eventId);
    res.json(validLive);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Generate bracket/heats from registrations
router.post('/generate', auth, requirePermission('manage_tournaments'), async (req, res) => {
  try {
    const { eventId, format, genderFilter } = req.body;
    if (!eventId || !format) {
      return res.status(400).json({ message: 'Event ID and format are required' });
    }
    if (!TOURNAMENT_FORMATS.includes(format)) {
      return res.status(400).json({ message: 'Format must be single_elimination, round_robin, or track_heats' });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    if (format === 'track_heats' && event.type !== 'single') {
      return res.status(400).json({ message: 'Track heats are only available for individual events' });
    }

    const existing = await Tournament.findOne({ eventId });
    if (existing) {
      return res.status(400).json({ message: 'A tournament already exists for this event. Delete it first to regenerate.' });
    }

    let applications = await Application.find({ eventId }).sort({ createdAt: 1 });

    if (Array.isArray(event.allowedGenders) && event.allowedGenders.length > 0) {
      applications = applications.filter((application) => {
        const mainPlayers = application.players.filter((player) => !player.isSubstitute);
        return mainPlayers.every((player) => event.allowedGenders.includes(player.gender));
      });
    }

    if (genderFilter && ['male', 'female'].includes(genderFilter)) {
      applications = applications.filter((application) => {
        const mainPlayers = application.players.filter((player) => !player.isSubstitute);
        return mainPlayers.every((player) => player.gender === genderFilter);
      });
    }

    if (applications.length < 2) {
      return res.status(400).json({ message: 'At least 2 registrations are required to generate the schedule. Check gender filter and event restrictions.' });
    }

    const participants = applications.map((application) => buildParticipantPayload(event, application));
    const tournament = new Tournament({ eventId, format, participants, status: 'draft' });
    await tournament.save();

    let matches = [];
    if (format === 'single_elimination') {
      matches = generateSingleElimination(tournament, participants, eventId);
    } else if (format === 'round_robin') {
      matches = generateRoundRobin(tournament, participants, eventId);
    } else {
      matches = generateTrackHeats(tournament, applications, eventId, event);
    }

    await TournamentMatch.insertMany(matches);

    if (format === 'single_elimination') {
      await resolveByes(tournament._id);
    }

    tournament.status = 'in_progress';
    await tournament.save();

    const savedMatches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });

    await AuditLog.create({
      action: `Tournament Generated: ${event.title} (${format})`,
      admin: req.admin.name,
      ip: req.ip
    });

    res.status(201).json({ tournament: hydrateTournament(tournament), matches: savedMatches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Schedule or reschedule a match/heat
router.patch('/match/:matchId/schedule', auth, requirePermission('manage_tournaments'), async (req, res) => {
  try {
    const match = await TournamentMatch.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    match.scheduledTime = req.body.scheduledTime ? new Date(req.body.scheduledTime) : null;
    match.updatedAt = new Date();
    await match.save();

    const allMatches = await TournamentMatch.find({ tournamentId: match.tournamentId }).sort({ round: 1, matchNumber: 1 });
    res.json({ match, allMatches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Update match score or heat results
router.put('/match/:matchId', auth, requirePermission('manage_tournaments'), async (req, res) => {
  try {
    const match = await TournamentMatch.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const tournament = await Tournament.findById(match.tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

    if (tournament.format === 'track_heats') {
      if (!Array.isArray(req.body.lanes) || req.body.lanes.length === 0) {
        return res.status(400).json({ message: 'Lane results are required for track heats' });
      }
      if (!Array.isArray(match.lanes) || match.lanes.length === 0) {
        return res.status(400).json({ message: 'This heat has no lane assignments' });
      }

      const updatesByLane = new Map(
        req.body.lanes.map((lane) => [Number(lane.lane), lane])
      );

      match.lanes = match.lanes.map((lane) => {
        const update = updatesByLane.get(Number(lane.lane));
        if (!update) return lane;

        const finishPosition = update.finishPosition === '' || update.finishPosition == null
          ? null
          : Math.max(1, Number(update.finishPosition));

        return {
          ...lane.toObject(),
          finishPosition: Number.isFinite(finishPosition) ? finishPosition : null,
          finishTime: typeof update.finishTime === 'string' ? update.finishTime.trim() : String(lane.finishTime || ''),
          isQualified: Boolean(update.isQualified)
        };
      });

      const sortedLanes = [...match.lanes]
        .filter((lane) => lane.finishPosition != null)
        .sort((a, b) => a.finishPosition - b.finishPosition || a.lane - b.lane);

      const winnerLane = sortedLanes[0] || null;
      match.winnerId = winnerLane?.applicationId || null;
      match.winner = winnerLane?.label || null;
      match.status = 'completed';
      match.updatedAt = new Date();
      await match.save();
    } else {
      const { score1, score2 } = req.body;
      if (score1 == null || score2 == null) {
        return res.status(400).json({ message: 'Both scores are required' });
      }
      if (!match.participant1 || !match.participant2) {
        return res.status(400).json({ message: 'Both participants must be set before entering scores' });
      }

      match.score1 = Number(score1);
      match.score2 = Number(score2);
      match.updatedAt = new Date();

      if (tournament.format === 'single_elimination' && match.score1 === match.score2) {
        return res.status(400).json({ message: 'Single elimination matches cannot end in a tie' });
      }

      if (match.score1 > match.score2) {
        match.winnerId = match.participant1Id;
        match.winner = match.participant1;
      } else if (match.score2 > match.score1) {
        match.winnerId = match.participant2Id;
        match.winner = match.participant2;
      } else {
        match.winnerId = null;
        match.winner = null;
      }

      match.status = 'completed';
      await match.save();

      if (tournament.format === 'single_elimination') {
        await advanceWinner(match);
      }
    }

    const pendingMatches = await TournamentMatch.countDocuments({
      tournamentId: match.tournamentId,
      status: { $ne: 'completed' }
    });
    if (pendingMatches === 0) {
      tournament.status = 'completed';
      await tournament.save();
    }

    const allMatches = await TournamentMatch.find({ tournamentId: match.tournamentId }).sort({ round: 1, matchNumber: 1 });
    
    // Emit real-time update to all clients watching this tournament
    const io = req.app.get('io');
    if (io) {
      emitTournamentMatchUpdate(io, match.tournamentId.toString(), match.toObject());
    }
    
    res.json({ match, allMatches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Delete tournament and its matches
router.delete('/:id', auth, requirePermission('manage_tournaments'), async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

    await TournamentMatch.deleteMany({ tournamentId: tournament._id });
    await Tournament.findByIdAndDelete(req.params.id);

    await AuditLog.create({
      action: `Tournament Deleted for event ${tournament.eventId}`,
      admin: req.admin.name,
      ip: req.ip
    });

    res.json({ message: 'Tournament deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Generate qualification heats (semis/finals) for track events
router.post('/:tournamentId/generate-qualifications', auth, requirePermission('manage_tournaments'), async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });
    if (tournament.format !== 'track_heats') {
      return res.status(400).json({ message: 'Qualification generation is only for track heat tournaments' });
    }

    const heatMatches = await TournamentMatch.find({ tournamentId: tournament._id, round: 1 }).sort({ matchNumber: 1 });
    if (heatMatches.length === 0) {
      return res.status(400).json({ message: 'No heats found to qualify from' });
    }

    // Check which heats are completed
    const completedHeats = heatMatches.filter(h => h.status === 'completed');
    if (completedHeats.length === 0) {
      return res.status(400).json({ message: 'No heats completed yet. Complete at least one heat to generate qualifications.' });
    }

    // Collect all lanes with results
    const allLanes = [];
    heatMatches.forEach(heat => {
      if (heat.lanes && heat.lanes.length > 0) {
        heat.lanes.forEach(lane => {
          allLanes.push({
            ...lane.toObject(),
            heatName: heat.heatName,
            heatId: heat._id
          });
        });
      }
    });

    // Determine qualification method
    const hasTimings = allLanes.some(lane => lane.finishTime && String(lane.finishTime).trim());
    
    let qualifiedLanes = [];
    if (hasTimings) {
      // Rank by time across ALL heats (lowest/fastest time = best)
      const lanesWithTime = allLanes
        .filter(lane => lane.finishTime && String(lane.finishTime).trim())
        .sort((a, b) => {
          const timeA = parseFloat(a.finishTime) || Infinity;
          const timeB = parseFloat(b.finishTime) || Infinity;
          return timeA - timeB;
        });
      
      qualifiedLanes = lanesWithTime.slice(0, 3); // Top 3 fastest
    } else {
      // Take top 3 from each completed heat
      const qualsByHeat = {};
      completedHeats.forEach(heat => {
        const heatLanes = heat.lanes
          .filter(lane => lane.finishPosition !== null)
          .sort((a, b) => a.finishPosition - b.finishPosition)
          .slice(0, 3);
        
        if (heatLanes.length > 0) {
          qualsByHeat[heat._id] = heatLanes;
          qualifiedLanes.push(...heatLanes);
        }
      });
    }

    if (qualifiedLanes.length === 0) {
      return res.status(400).json({ message: 'No qualified players found. Enter results first.' });
    }

    // Create new semifinals/finals heats
    const event = await Event.findById(tournament.eventId);
    const lanesPerHeat = event?.lanesPerHeat || 8;
    const heatCount = Math.ceil(qualifiedLanes.length / lanesPerHeat);
    
    const newRound = Math.max(...heatMatches.map(h => h.round)) + 1;
    
    // Create new heats with qualified participants
    const qualificationMatches = [];
    for (let i = 0; i < heatCount; i++) {
      const startIdx = i * lanesPerHeat;
      const endIdx = Math.min(startIdx + lanesPerHeat, qualifiedLanes.length);
      const heatParticipants = qualifiedLanes.slice(startIdx, endIdx);
      
      const newMatch = new TournamentMatch({
        eventId: tournament.eventId,
        tournamentId: tournament._id,
        round: newRound,
        matchNumber: i + 1,
        heatName: heatCount === 1 ? 'Finals' : `Semifinal ${i + 1}`,
        lanes: assignTrackLanes(
          heatParticipants.map(lane => ({
            applicationId: lane.applicationId,
            label: lane.label,
            department: lane.department
          })),
          lanesPerHeat
        ),
        status: 'pending'
      });
      
      qualificationMatches.push(newMatch);
    }

    // Mark qualified in original heats
    heatMatches.forEach(heat => {
      heat.lanes.forEach(lane => {
        lane.isQualified = qualifiedLanes.some(q => 
          q.applicationId?.toString() === lane.applicationId?.toString()
        );
      });
      heat.save();
    });

    // Save qualification heats
    await TournamentMatch.insertMany(qualificationMatches);

    const allMatches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });

    await AuditLog.create({
      action: `Qualification Heats Generated: ${tournament.eventId} (Round ${newRound})`,
      admin: req.admin.name,
      ip: req.ip
    });

    res.status(201).json({
      message: hasTimings 
        ? `Top 3 by time qualified to Round ${newRound}` 
        : `Top 3 from each heat qualified to Round ${newRound}`,
      matches: qualificationMatches,
      allMatches
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

function generateSingleElimination(tournament, participants, eventId) {
  const n = participants.length;
  const totalSlots = nextPowerOf2(n);
  const totalRounds = Math.log2(totalSlots);

  const shuffledParticipants = shuffleInPlace([...participants]);
  const seeded = [...shuffledParticipants];
  while (seeded.length < totalSlots) {
    seeded.push(buildByeParticipant());
  }

  shuffleInPlace(seeded);

  const matches = [];

  for (let i = 0; i < totalSlots / 2; i++) {
    const participant1 = seeded[i * 2];
    const participant2 = seeded[i * 2 + 1];
    matches.push({
      eventId,
      tournamentId: tournament._id,
      round: 1,
      matchNumber: i + 1,
      participant1Id: participant1.applicationId,
      participant2Id: participant2.applicationId,
      participant1: participant1.label,
      participant2: participant2.label,
      status: 'pending'
    });
  }

  let matchesInRound = totalSlots / 4;
  for (let round = 2; round <= totalRounds; round++) {
    for (let i = 0; i < matchesInRound; i++) {
      matches.push({
        eventId,
        tournamentId: tournament._id,
        round,
        matchNumber: i + 1,
        participant1Id: null,
        participant2Id: null,
        participant1: null,
        participant2: null,
        status: 'pending'
      });
    }
    matchesInRound = matchesInRound / 2;
  }

  return matches;
}

function generateRoundRobin(tournament, participants, eventId) {
  const matches = [];
  let matchNumber = 1;

  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      matches.push({
        eventId,
        tournamentId: tournament._id,
        round: 1,
        matchNumber: matchNumber++,
        participant1Id: participants[i].applicationId,
        participant2Id: participants[j].applicationId,
        participant1: participants[i].label,
        participant2: participants[j].label,
        status: 'pending'
      });
    }
  }

  return matches;
}

function generateTrackHeats(tournament, applications, eventId, event) {
  const lanesPerHeat = event?.lanesPerHeat || 8;
  const heatCount = Math.ceil(applications.length / lanesPerHeat);
  const heatParticipants = applications.map(buildHeatParticipantPayload);
  const balancedHeats = spreadParticipantsAcrossHeats(heatParticipants, heatCount, lanesPerHeat);

  return balancedHeats.map((heat, index) => ({
    eventId,
    tournamentId: tournament._id,
    round: 1,
    matchNumber: index + 1,
    participant1Id: null,
    participant2Id: null,
    participant1: null,
    participant2: null,
    heatName: `Heat ${index + 1}`,
    lanes: assignTrackLanes(heat, lanesPerHeat),
    status: 'pending'
  }));
}

async function resolveByes(tournamentId) {
  const byeMatches = await TournamentMatch.find({
    tournamentId,
    round: 1,
    $or: [{ participant1: 'BYE' }, { participant2: 'BYE' }]
  });

  for (const match of byeMatches) {
    if (match.participant1 === 'BYE' && match.participant2 === 'BYE') {
      match.status = 'completed';
      match.updatedAt = new Date();
      await match.save();
      continue;
    }

    const winnerId = match.participant1 === 'BYE' ? match.participant2Id : match.participant1Id;
    const winner = match.participant1 === 'BYE' ? match.participant2 : match.participant1;
    match.winnerId = winnerId;
    match.winner = winner;
    match.score1 = match.participant1 === 'BYE' ? 0 : 1;
    match.score2 = match.participant2 === 'BYE' ? 0 : 1;
    match.status = 'completed';
    match.updatedAt = new Date();
    await match.save();

    await advanceWinner(match);
  }
}

async function advanceWinner(match) {
  if (!match.winner) return;

  const tournament = await Tournament.findById(match.tournamentId);
  if (!tournament || tournament.format !== 'single_elimination') return;

  const nextRound = match.round + 1;
  const nextMatchNumber = Math.ceil(match.matchNumber / 2);

  const nextMatch = await TournamentMatch.findOne({
    tournamentId: match.tournamentId,
    round: nextRound,
    matchNumber: nextMatchNumber
  });

  if (!nextMatch) return;

  if (match.matchNumber % 2 === 1) {
    nextMatch.participant1Id = match.winnerId;
    nextMatch.participant1 = match.winner;
  } else {
    nextMatch.participant2Id = match.winnerId;
    nextMatch.participant2 = match.winner;
  }
  nextMatch.updatedAt = new Date();

  await nextMatch.save();
}

// Public: Like/Unlike tournament
router.post('/:id/like', async (req, res) => {
  try {
    const { deviceId, action } = req.body;
    if (!deviceId || !action) return res.status(400).json({ message: 'deviceId and action required' });

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

    if (action === 'like') {
      if (!tournament.likes.includes(deviceId)) {
        tournament.likes.push(deviceId);
      }
    } else if (action === 'unlike') {
      const index = tournament.likes.indexOf(deviceId);
      if (index > -1) {
        tournament.likes.splice(index, 1);
      }
    }

    await tournament.save();
    res.json({ likes: tournament.likes.length, liked: tournament.likes.includes(deviceId) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Mark interested in tournament
router.post('/:id/interested', async (req, res) => {
  try {
    const { deviceId, action } = req.body;
    if (!deviceId || !action) return res.status(400).json({ message: 'deviceId and action required' });

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

    if (action === 'add') {
      if (!tournament.interested.includes(deviceId)) {
        tournament.interested.push(deviceId);
      }
    } else if (action === 'remove') {
      const index = tournament.interested.indexOf(deviceId);
      if (index > -1) {
        tournament.interested.splice(index, 1);
      }
    }

    await tournament.save();
    res.json({ interested: tournament.interested.length, isInterested: tournament.interested.includes(deviceId) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
