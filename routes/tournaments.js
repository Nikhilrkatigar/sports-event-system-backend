const router = require('express').Router();
const { Tournament, TournamentMatch, Application, Event, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { emitTournamentMatchUpdate } = require('../utils/socket');

const TRACK_LANE_ORDER = [4, 5, 3, 6, 2, 7, 1, 8];
const MANUAL_BYE_VALUE = '__BYE__';

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
const TOURNAMENT_FORMATS = ['single_elimination', 'round_robin', 'track_heats', 'field_flight'];

const nextPowerOf2 = (n) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

const getDistributedByeMatchIndexes = (matchCount, byeCount) => {
  const indexes = new Set();
  if (matchCount <= 0 || byeCount <= 0) return indexes;

  for (let i = 0; i < byeCount; i++) {
    indexes.add(Math.floor((i * matchCount) / byeCount));
  }

  return indexes;
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

const getPrimaryPlayer = (application) => (
  application.players.find((player) => player.isTeamLeader && !player.isSubstitute)
  || getMainPlayer(application)
);

const getEventCategory = (event) => {
  if (event?.eventCategory) return event.eventCategory;
  return event?.type === 'single' ? 'track' : 'general';
};

const getAllowedFormatsForEvent = (event) => {
  const category = getEventCategory(event);
  if (category === 'track') return ['track_heats'];
  if (category === 'field') return ['field_flight'];
  return ['single_elimination', 'round_robin'];
};

const getApplicationDepartment = (application) => {
  const player = getPrimaryPlayer(application);
  return String(player?.department || 'Unassigned').trim() || 'Unassigned';
};

const getParticipantUucms = (application) => (
  String(getPrimaryPlayer(application)?.uucms || '').trim().toUpperCase()
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
  uucms: getParticipantUucms(application),
  registrationNumber: application.registrationNumber || '',
  isBye: false
});

const buildTrackParticipantPayload = (event, application) => {
  return {
    applicationId: application._id,
    label: toParticipantLabel(event, application),
    uucms: getParticipantUucms(application),
    registrationNumber: application.registrationNumber || '',
    department: getApplicationDepartment(application)
  };
};

const buildFieldEntryPayload = (event, application, index) => ({
  applicationId: application._id,
  label: toParticipantLabel(event, application),
  uucms: getParticipantUucms(application),
  registrationNumber: application.registrationNumber || '',
  department: getApplicationDepartment(application),
  order: index + 1,
  attempts: Array.from({ length: Math.max(1, Number(event?.fieldAttempts) || 3) }, () => null),
  bestScore: null,
  performance: null,
  rank: null
});

const buildByeParticipant = () => ({
  applicationId: null,
  label: 'BYE',
  uucms: '',
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
      uucms: participant.uucms || '',
      registrationNumber: participant.registrationNumber || '',
      department: participant.department,
      lane: laneOrder[index % laneOrder.length],
      finishPosition: null,
      finishTime: '',
      isQualified: false
    }))
    .sort((a, b) => a.lane - b.lane);
};

// Enrich field entries with UUCMS and registration numbers from Application records
const enrichFieldEntriesWithUucms = async (matches) => {
  try {
    const applicationIds = new Set();
    const eventIds = new Set();
    
    matches.forEach((match) => {
      if (match.eventId) eventIds.add(match.eventId.toString());
      if (Array.isArray(match.fieldEntries)) {
        match.fieldEntries.forEach((entry) => {
          if (entry.applicationId) {
            applicationIds.add(entry.applicationId.toString());
          }
        });
      }
      if (Array.isArray(match.lanes)) {
        match.lanes.forEach((lane) => {
          if (lane.applicationId) {
            applicationIds.add(lane.applicationId.toString());
          }
        });
      }
    });

    // Build maps for enrichment
    const appDataMapById = new Map();
    const appDataMapByUucms = new Map();
    
    if (applicationIds.size > 0) {
      const applications = await Application.find({ _id: { $in: Array.from(applicationIds) } }).select('_id players registrationNumber');
      applications.forEach((app) => {
        const primaryPlayer = getPrimaryPlayer(app);
        const appData = {
          uucms: primaryPlayer?.uucms ? String(primaryPlayer.uucms).trim().toUpperCase() : '',
          registrationNumber: app.registrationNumber || ''
        };
        appDataMapById.set(app._id.toString(), appData);
        if (appData.uucms) {
          appDataMapByUucms.set(appData.uucms, appData);
        }
      });
    }

    // For track heats, also fetch all applications by event to enable uucms-based lookup
    if (eventIds.size > 0) {
      const allApplications = await Application.find({ eventId: { $in: Array.from(eventIds) } }).select('_id players registrationNumber');
      allApplications.forEach((app) => {
        const primaryPlayer = getPrimaryPlayer(app);
        const uucms = primaryPlayer?.uucms ? String(primaryPlayer.uucms).trim().toUpperCase() : '';
        if (uucms && !appDataMapByUucms.has(uucms)) {
          appDataMapByUucms.set(uucms, {
            uucms,
            registrationNumber: app.registrationNumber || ''
          });
        }
      });
    }

    // Enrich matches with UUCMS and registration number data
    matches.forEach((match) => {
      if (Array.isArray(match.fieldEntries)) {
        match.fieldEntries = match.fieldEntries.map((entry) => {
          let appData = null;
          
          // First try by applicationId
          if (entry.applicationId) {
            appData = appDataMapById.get(entry.applicationId.toString());
          }
          
          // Fallback: try by uucms
          if (!appData && entry.uucms) {
            appData = appDataMapByUucms.get(entry.uucms.trim().toUpperCase());
          }
          
          if (appData) {
            return {
              ...entry,
              uucms: entry.uucms || appData.uucms,
              registrationNumber: entry.registrationNumber || appData.registrationNumber
            };
          }
          return entry;
        });
      }
      
      // Also enrich lanes for track heats
      if (Array.isArray(match.lanes)) {
        match.lanes = match.lanes.map((lane) => {
          let appData = null;
          
          // First try by applicationId
          if (lane.applicationId) {
            appData = appDataMapById.get(lane.applicationId.toString());
          }
          
          // Fallback: try by uucms
          if (!appData && lane.uucms) {
            appData = appDataMapByUucms.get(lane.uucms.trim().toUpperCase());
          }
          
          if (appData) {
            return {
              ...lane,
              uucms: lane.uucms || appData.uucms,
              registrationNumber: lane.registrationNumber || appData.registrationNumber
            };
          }
          return lane;
        });
      }
    });

    return matches;
  } catch (err) {
    console.error('Error enriching field entries with UUCMS:', err.message);
    return matches; // Return as-is if enrichment fails
  }
};

// Public: Get all tournaments
router.get('/', async (req, res) => {
  try {
    const tournaments = await Tournament.find().populate('eventId', 'title type image date status lanesPerHeat eventCategory');
    res.json(tournaments.map(hydrateTournament));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get tournament + matches for an event (supports multiple gender-specific tournaments)
router.get('/event/:eventId', async (req, res) => {
  try {
    const { genderFilter } = req.query;
    const query = { eventId: req.params.eventId };
    if (genderFilter && ['male', 'female', 'all'].includes(genderFilter)) {
      query.genderFilter = genderFilter;
    }
    const tournaments = await Tournament.find(query).populate('eventId', 'title type image date status lanesPerHeat eventCategory scoreOrder fieldAttempts');
    if (tournaments.length === 0) return res.status(404).json({ message: 'No tournament found for this event' });

    // If a specific genderFilter was requested, return a single tournament
    if (genderFilter) {
      const tournament = tournaments[0];
      let matches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });
      matches = await enrichFieldEntriesWithUucms(matches);
      return res.json({ tournament: hydrateTournament(tournament), matches });
    }

    // Otherwise return all tournaments for this event
    const allTournaments = [];
    for (const tournament of tournaments) {
      let matches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });
      matches = await enrichFieldEntriesWithUucms(matches);
      allTournaments.push({ tournament: hydrateTournament(tournament), matches });
    }

    // For backward compatibility: if only one tournament, return flat format
    if (allTournaments.length === 1) {
      return res.json(allTournaments[0]);
    }

    // Multiple tournaments: return first one as the primary response with extras
    res.json({
      tournament: allTournaments[0].tournament,
      matches: allTournaments[0].matches,
      allTournaments
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get tournament + matches with player details for printing
router.get('/event/:eventId/print', async (req, res) => {
  try {
    const { genderFilter } = req.query;
    const query = { eventId: req.params.eventId };
    if (genderFilter && ['male', 'female', 'all'].includes(genderFilter)) {
      query.genderFilter = genderFilter;
    }

    const tournament = await Tournament.findOne(query)
      .sort({ createdAt: 1 })
      .populate('eventId', 'title type image date status lanesPerHeat eventCategory scoreOrder fieldAttempts');
    if (!tournament) return res.status(404).json({ message: 'No tournament found for this event' });
    
    let matches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });
    
    // For single elimination, enrich with player details
    if (tournament.format === 'single_elimination' || tournament.format === 'round_robin') {
      const applicationIds = new Set();
      matches.forEach((match) => {
        if (match.participant1Id) applicationIds.add(match.participant1Id.toString());
        if (match.participant2Id) applicationIds.add(match.participant2Id.toString());
      });

      if (applicationIds.size > 0) {
        const applications = await Application.find({ _id: { $in: Array.from(applicationIds) } })
          .select('_id teamName teamId players registrationNumber');
        
        const appMap = new Map();
        applications.forEach((app) => {
          appMap.set(app._id.toString(), app);
        });

        matches = matches.map((match) => {
          const matchObj = match.toObject ? match.toObject() : match;
          if (matchObj.participant1Id) {
            const app = appMap.get(matchObj.participant1Id.toString());
            if (app) {
              matchObj.participant1TeamDetails = {
                teamName: app.teamName || app.teamId,
                players: app.players || []
              };
            }
          }
          if (matchObj.participant2Id) {
            const app = appMap.get(matchObj.participant2Id.toString());
            if (app) {
              matchObj.participant2TeamDetails = {
                teamName: app.teamName || app.teamId,
                players: app.players || []
              };
            }
          }
          return matchObj;
        });
      }
    }
    
    // Enrich field entries with UUCMS data if missing
    matches = await enrichFieldEntriesWithUucms(matches);
    
    res.json({ tournament: hydrateTournament(tournament), matches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get all LIVE (in-progress) matches across all tournaments
router.get('/live', async (req, res) => {
  try {
    let liveMatches = await TournamentMatch.find({ status: 'in_progress' })
      .populate({
        path: 'tournamentId',
        select: 'format status',
        populate: { path: 'eventId', select: 'title type' }
      })
      .sort({ updatedAt: -1 })
      .limit(10);

    const validLive = liveMatches.filter((match) => match.tournamentId && match.tournamentId.eventId);
    
    // Enrich field entries with UUCMS data if missing
    const enrichedLive = await enrichFieldEntriesWithUucms(validLive);
    
    res.json(enrichedLive);
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
      return res.status(400).json({ message: 'Format must be single_elimination, round_robin, track_heats, or field_flight' });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const normalizedGender = genderFilter && ['male', 'female'].includes(genderFilter) ? genderFilter : 'all';

    const existing = await Tournament.findOne({ eventId, genderFilter: normalizedGender });
    if (existing) {
      const filterLabel = normalizedGender === 'all' ? '' : ` (${normalizedGender})`;
      return res.status(400).json({ message: `A tournament${filterLabel} already exists for this event. Delete it first to regenerate.` });
    }

    let applications = await Application.find({ eventId }).sort({ createdAt: 1 });

    if (Array.isArray(event.allowedGenders) && event.allowedGenders.length > 0) {
      applications = applications.filter((application) => {
        const mainPlayers = application.players.filter((player) => !player.isSubstitute);
        return mainPlayers.every((player) => event.allowedGenders.includes(player.gender));
      });
    }

    if (normalizedGender !== 'all') {
      applications = applications.filter((application) => {
        const mainPlayers = application.players.filter((player) => !player.isSubstitute);
        return mainPlayers.every((player) => player.gender === normalizedGender);
      });
    }

    if (applications.length < 2) {
      return res.status(400).json({ message: 'At least 2 registrations are required to generate the schedule. Check gender filter and event restrictions.' });
    }

    const participants = applications.map((application) => buildParticipantPayload(event, application));
    const tournament = new Tournament({ eventId, format, genderFilter: normalizedGender, participants, status: 'draft' });
    await tournament.save();

    let matches = [];
    if (format === 'single_elimination') {
      matches = generateSingleElimination(tournament, participants, eventId);
    } else if (format === 'round_robin') {
      matches = generateRoundRobin(tournament, participants, eventId);
    } else if (format === 'track_heats') {
      matches = generateTrackHeats(tournament, applications, eventId, event);
    } else {
      matches = generateFieldFlight(tournament, applications, eventId, event);
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
    const event = await Event.findById(match.eventId).select('scoreOrder lanesPerHeat');
    let responseMessage = null;

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
      match.winnerUucms = winnerLane?.uucms || '';
      match.status = 'completed';
      match.updatedAt = new Date();
      await match.save();

      const qualificationRound = await createTrackQualificationRound(tournament, event, Number(match.round) || 1);
      if (qualificationRound.created) {
        responseMessage = qualificationRound.matches.length === 1
          ? 'Heat results saved and finals generated'
          : `Heat results saved and Round ${qualificationRound.newRound} generated`;
      }
    } else if (tournament.format === 'field_flight') {
      if (!Array.isArray(req.body.fieldEntries) || req.body.fieldEntries.length === 0) {
        return res.status(400).json({ message: 'Field results are required for field flights' });
      }
      if (!Array.isArray(match.fieldEntries) || match.fieldEntries.length === 0) {
        return res.status(400).json({ message: 'This flight has no participant assignments' });
      }

      const updatesByKey = new Map(
        req.body.fieldEntries.map((entry) => {
          const key = entry.applicationId ? String(entry.applicationId) : `order:${Number(entry.order)}`;
          return [key, entry];
        })
      );

      const updatedEntries = match.fieldEntries.map((entry) => {
        const entryObject = entry.toObject ? entry.toObject() : entry;
        const key = entryObject.applicationId ? String(entryObject.applicationId) : `order:${Number(entryObject.order)}`;
        const update = updatesByKey.get(key);
        if (!update) return entryObject;

        const attemptCount = Array.isArray(entryObject.attempts) && entryObject.attempts.length > 0
          ? entryObject.attempts.length
          : Math.max(1, Number(event?.fieldAttempts) || 3);

        const attempts = Array.isArray(update.attempts) && update.attempts.length > 0
          ? update.attempts.slice(0, attemptCount).map((attempt) => {
              if (attempt === '' || attempt == null) return null;
              const numericAttempt = Number(attempt);
              return Number.isFinite(numericAttempt) ? numericAttempt : null;
            })
          : [update.performance];

        while (attempts.length < attemptCount) attempts.push(null);
        const validAttempts = attempts.filter((attempt) => attempt != null);
        const bestScore = validAttempts.length === 0
          ? null
          : (event?.scoreOrder || 'desc') === 'asc'
            ? Math.min(...validAttempts)
            : Math.max(...validAttempts);

        return {
          ...entryObject,
          attempts,
          bestScore,
          performance: bestScore,
          rank: null
        };
      });

      const completedEntries = updatedEntries
        .filter((entry) => entry.bestScore != null)
        .sort((a, b) => {
          if ((event?.scoreOrder || 'desc') === 'asc') {
            return a.bestScore - b.bestScore || a.order - b.order;
          }
          return b.bestScore - a.bestScore || a.order - b.order;
        });

      if (completedEntries.length === 0) {
        return res.status(400).json({ message: 'Enter at least one valid mark before saving results' });
      }

      const rankMap = new Map(
        completedEntries.map((entry, index) => {
          const key = entry.applicationId ? String(entry.applicationId) : `order:${Number(entry.order)}`;
          return [key, index + 1];
        })
      );

      match.fieldEntries = updatedEntries.map((entry) => {
        const key = entry.applicationId ? String(entry.applicationId) : `order:${Number(entry.order)}`;
        return {
          ...entry,
          rank: rankMap.get(key) || null
        };
      });

      const winnerEntry = completedEntries[0] || null;
      match.winnerId = winnerEntry?.applicationId || null;
      match.winner = winnerEntry?.label || null;
      match.winnerUucms = winnerEntry?.uucms || '';
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
        match.winnerUucms = match.participant1Uucms || '';
      } else if (match.score2 > match.score1) {
        match.winnerId = match.participant2Id;
        match.winner = match.participant2;
        match.winnerUucms = match.participant2Uucms || '';
      } else {
        match.winnerId = null;
        match.winner = null;
        match.winnerUucms = '';
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
    
    res.json({ match, allMatches, message: responseMessage });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Update match participant (for updating TBD entries)
router.patch('/match/:matchId/participant', auth, requirePermission('manage_tournaments'), async (req, res) => {
  try {
    const { participantSlot, applicationId } = req.body; // participantSlot: 1 or 2
    const match = await TournamentMatch.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    const tournament = await Tournament.findById(match.tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

    const event = await Event.findById(match.eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (![1, 2].includes(Number(participantSlot))) {
      return res.status(400).json({ message: 'Invalid participant slot (1 or 2)' });
    }

    const normalizedSelection = String(applicationId || '').trim();
    const isManualBye = normalizedSelection === MANUAL_BYE_VALUE || normalizedSelection.toUpperCase() === 'BYE';

    let participantId = null;
    let label = 'BYE';
    let uucms = '';
    let registrationNumber = '';

    if (!isManualBye) {
      const application = await Application.findById(applicationId).populate('players');
      if (!application) return res.status(404).json({ message: 'Team/participant not found' });

      label = event.type === 'team'
        ? (application.teamName || `Team ${application._id.toString().slice(-4)}`)
        : (application.players?.find((p) => !p.isSubstitute)?.name || `Player ${application._id.toString().slice(-4)}`);

      uucms = String(application.players?.find((p) => p.isTeamLeader && !p.isSubstitute)?.uucms ||
                           application.players?.find((p) => !p.isSubstitute)?.uucms || '').trim().toUpperCase();
      registrationNumber = application.registrationNumber || '';
      participantId = application._id;
    }

    // Update the appropriate participant slot
    if (participantSlot === 1) {
      match.participant1Id = participantId;
      match.participant1 = label;
      match.participant1Uucms = uucms;
      match.participant1RegistrationNumber = registrationNumber;
    } else if (participantSlot === 2) {
      match.participant2Id = participantId;
      match.participant2 = label;
      match.participant2Uucms = uucms;
      match.participant2RegistrationNumber = registrationNumber;
    }

    match.updatedAt = new Date();
    await match.save();

    if (tournament.format === 'single_elimination') {
      await resolveByeMatch(match);

      const pendingMatches = await TournamentMatch.countDocuments({
        tournamentId: match.tournamentId,
        status: { $ne: 'completed' }
      });

      tournament.status = pendingMatches === 0 ? 'completed' : 'in_progress';
      await tournament.save();
    }

    const allMatches = await TournamentMatch.find({ tournamentId: match.tournamentId }).sort({ round: 1, matchNumber: 1 });
    res.json({ match, allMatches, message: `Participant ${participantSlot} updated` });
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

    if (!heatMatches.every((heat) => heat.status === 'completed')) {
      return res.status(400).json({ message: 'Complete all heats before generating the next round.' });
    }
    const event = await Event.findById(tournament.eventId);
    const qualificationRound = await createTrackQualificationRound(tournament, event, 1);
    if (!qualificationRound.created) {
      return res.status(400).json({ message: 'Mark qualified athletes and save heat results first.' });
    }

    const allMatches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });

    await AuditLog.create({
      action: `Qualification Heats Generated: ${tournament.eventId} (Round ${qualificationRound.newRound})`,
      admin: req.admin.name,
      ip: req.ip
    });

    res.status(201).json({
      message: qualificationRound.matches.length === 1
        ? 'Qualified athletes advanced to Finals'
        : `Qualified athletes advanced to Round ${qualificationRound.newRound}`,
      matches: qualificationRound.matches,
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
  const byeCount = totalSlots - n;
  const firstRoundMatchCount = totalSlots / 2;
  const byeMatchIndexes = getDistributedByeMatchIndexes(firstRoundMatchCount, byeCount);

  const matches = [];

  let participantCursor = 0;
  for (let i = 0; i < firstRoundMatchCount; i++) {
    const participant1 = shuffledParticipants[participantCursor++] || buildByeParticipant();
    const participant2 = byeMatchIndexes.has(i)
      ? buildByeParticipant()
      : (shuffledParticipants[participantCursor++] || buildByeParticipant());

    matches.push({
      eventId,
      tournamentId: tournament._id,
      round: 1,
      matchNumber: i + 1,
      participant1Id: participant1.applicationId,
      participant2Id: participant2.applicationId,
      participant1: participant1.label,
      participant2: participant2.label,
      participant1Uucms: participant1.uucms || '',
      participant2Uucms: participant2.uucms || '',
      participant1RegistrationNumber: participant1.registrationNumber || '',
      participant2RegistrationNumber: participant2.registrationNumber || '',
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
        participant1Uucms: participants[i].uucms || '',
        participant2Uucms: participants[j].uucms || '',
        participant1RegistrationNumber: participants[i].registrationNumber || '',
        participant2RegistrationNumber: participants[j].registrationNumber || '',
        status: 'pending'
      });
    }
  }

  return matches;
}

function generateTrackHeats(tournament, applications, eventId, event) {
  const lanesPerHeat = event?.lanesPerHeat || 8;
  const heatCount = Math.ceil(applications.length / lanesPerHeat);
  const heatParticipants = applications.map((application) => buildTrackParticipantPayload(event, application));
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

function generateFieldFlight(tournament, applications, eventId, event) {
  return [{
    eventId,
    tournamentId: tournament._id,
    round: 1,
    matchNumber: 1,
    participant1Id: null,
    participant2Id: null,
    participant1: null,
    participant2: null,
    heatName: `${event?.title || 'Field Event'} Flight`,
    fieldEntries: applications.map((application, index) => buildFieldEntryPayload(event, application, index)),
    status: 'pending'
  }];
}

async function createTrackQualificationRound(tournament, event, sourceRound = 1) {
  const existingNextRound = await TournamentMatch.exists({
    tournamentId: tournament._id,
    round: { $gt: sourceRound }
  });
  if (existingNextRound) return { created: false, matches: [] };

  const roundMatches = await TournamentMatch.find({
    tournamentId: tournament._id,
    round: sourceRound
  }).sort({ matchNumber: 1 });
  if (roundMatches.length === 0 || !roundMatches.every((roundMatch) => roundMatch.status === 'completed')) {
    return { created: false, matches: [] };
  }

  const qualifiedLanes = roundMatches.flatMap((roundMatch) =>
    (roundMatch.lanes || [])
      .filter((lane) => lane.isQualified)
      .map((lane) => ({
        ...(lane.toObject ? lane.toObject() : lane),
        heatName: roundMatch.heatName,
        heatId: roundMatch._id
      }))
  );

  if (qualifiedLanes.length < 2) return { created: false, matches: [] };

  const lanesPerHeat = event?.lanesPerHeat || 8;
  const heatCount = Math.ceil(qualifiedLanes.length / lanesPerHeat);
  const newRound = sourceRound + 1;
  const qualificationMatches = [];

  for (let i = 0; i < heatCount; i++) {
    const startIdx = i * lanesPerHeat;
    const endIdx = Math.min(startIdx + lanesPerHeat, qualifiedLanes.length);
    const heatParticipants = qualifiedLanes.slice(startIdx, endIdx);
    const heatName = heatCount === 1
      ? 'Finals'
      : newRound === 2
        ? `Semifinal ${i + 1}`
        : `Round ${newRound} Heat ${i + 1}`;

    qualificationMatches.push({
      eventId: tournament.eventId,
      tournamentId: tournament._id,
      round: newRound,
      matchNumber: i + 1,
      heatName,
      lanes: assignTrackLanes(
        heatParticipants.map((lane) => ({
          applicationId: lane.applicationId,
          label: lane.label,
          uucms: lane.uucms || '',
          department: lane.department
        })),
        lanesPerHeat
      ),
      status: 'pending'
    });
  }

  const insertedMatches = await TournamentMatch.insertMany(qualificationMatches);
  return { created: true, matches: insertedMatches, newRound };
}

async function resolveByes(tournamentId) {
  const byeMatches = await TournamentMatch.find({
    tournamentId,
    round: 1,
    $or: [{ participant1: 'BYE' }, { participant2: 'BYE' }]
  });

  for (const match of byeMatches) {
    await resolveByeMatch(match);
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
    nextMatch.participant1Uucms = match.winnerUucms || '';
  } else {
    nextMatch.participant2Id = match.winnerId;
    nextMatch.participant2 = match.winner;
    nextMatch.participant2Uucms = match.winnerUucms || '';
  }
  nextMatch.updatedAt = new Date();

  await nextMatch.save();

  if (nextMatch.participant1 === 'BYE' || nextMatch.participant2 === 'BYE') {
    await resolveByeMatch(nextMatch);
  }
}

async function resolveByeMatch(match) {
  if (!match || (match.participant1 !== 'BYE' && match.participant2 !== 'BYE')) return false;

  if (match.participant1 === 'BYE' && match.participant2 === 'BYE') {
    match.winnerId = null;
    match.winner = null;
    match.winnerUucms = '';
    match.score1 = 0;
    match.score2 = 0;
    match.status = 'completed';
    match.updatedAt = new Date();
    await match.save();
    return true;
  }

  const winnerId = match.participant1 === 'BYE' ? match.participant2Id : match.participant1Id;
  const winner = match.participant1 === 'BYE' ? match.participant2 : match.participant1;
  const winnerUucms = match.participant1 === 'BYE' ? match.participant2Uucms : match.participant1Uucms;

  if (!winner) return false;

  match.winnerId = winnerId;
  match.winner = winner;
  match.winnerUucms = winnerUucms || '';
  match.score1 = match.participant1 === 'BYE' ? 0 : 1;
  match.score2 = match.participant2 === 'BYE' ? 0 : 1;
  match.status = 'completed';
  match.updatedAt = new Date();
  await match.save();

  await advanceWinner(match);
  return true;
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
