const router = require('express').Router();
const { Tournament, TournamentMatch, Application, Event, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

const nextPowerOf2 = (n) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

const toParticipantLabel = (event, application) => {
  if (event.type === 'team') {
    return application.teamName || application.teamId || `Team ${application._id.toString().slice(-4)}`;
  }
  const mainPlayer = application.players.find((player) => !player.isSubstitute) || application.players[0];
  return mainPlayer?.name || `Player ${application._id.toString().slice(-4)}`;
};

const buildParticipantPayload = (event, application) => ({
  applicationId: application._id,
  label: toParticipantLabel(event, application),
  isBye: false
});

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
    
    // Filter out matches where the event pop failed (just in case event was deleted)
    const validLive = liveMatches.filter(m => m.tournamentId && m.tournamentId.eventId);
    res.json(validLive);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Generate bracket from registrations
router.post('/generate', auth, requirePermission('manage_tournaments'), async (req, res) => {
  try {
    const { eventId, format } = req.body;
    if (!eventId || !format) {
      return res.status(400).json({ message: 'Event ID and format are required' });
    }
    if (!['single_elimination', 'round_robin'].includes(format)) {
      return res.status(400).json({ message: 'Format must be single_elimination or round_robin' });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const existing = await Tournament.findOne({ eventId });
    if (existing) {
      return res.status(400).json({ message: 'A tournament already exists for this event. Delete it first to regenerate.' });
    }

    const applications = await Application.find({ eventId }).sort({ createdAt: 1 });
    if (applications.length < 2) {
      return res.status(400).json({ message: 'At least 2 registrations are required to generate a bracket' });
    }

    const participants = applications.map((application) => buildParticipantPayload(event, application));
    const tournament = new Tournament({ eventId, format, participants, status: 'draft' });
    await tournament.save();

    const matches = format === 'single_elimination'
      ? generateSingleElimination(tournament, participants, eventId)
      : generateRoundRobin(tournament, participants, eventId);

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

// Admin: Schedule or reschedule a match
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

// Admin: Update match score
router.put('/match/:matchId', auth, requirePermission('manage_tournaments'), async (req, res) => {
  try {
    const { score1, score2 } = req.body;
    if (score1 == null || score2 == null) {
      return res.status(400).json({ message: 'Both scores are required' });
    }

    const match = await TournamentMatch.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (!match.participant1 || !match.participant2) {
      return res.status(400).json({ message: 'Both participants must be set before entering scores' });
    }

    const tournament = await Tournament.findById(match.tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

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

    const pendingMatches = await TournamentMatch.countDocuments({
      tournamentId: match.tournamentId,
      status: { $ne: 'completed' }
    });
    if (pendingMatches === 0) {
      tournament.status = 'completed';
      await tournament.save();
    }

    const allMatches = await TournamentMatch.find({ tournamentId: match.tournamentId }).sort({ round: 1, matchNumber: 1 });
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

function generateSingleElimination(tournament, participants, eventId) {
  const n = participants.length;
  const totalSlots = nextPowerOf2(n);
  const totalRounds = Math.log2(totalSlots);

  // Randomize the participants so matchups are completely fair and random
  const shuffledParticipants = [...participants];
  for (let i = shuffledParticipants.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledParticipants[i], shuffledParticipants[j]] = [shuffledParticipants[j], shuffledParticipants[i]];
  }

  const seeded = [...shuffledParticipants];
  while (seeded.length < totalSlots) {
    seeded.push(buildByeParticipant());
  }

  // Shuffle again after adding Byes so that Byes are randomly distributed
  for (let i = seeded.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [seeded[i], seeded[j]] = [seeded[j], seeded[i]];
  }

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
