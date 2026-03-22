const router = require('express').Router();
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Application, Event, AuditLog, Tournament, TournamentMatch, Leaderboard } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const {
  getMainPlayerCount,
  getRegistrationState,
  syncEventRegistrationStatus
} = require('../utils/events');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/payment-screenshots';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

const ALLOWED_GENDERS = new Set(['male', 'female', 'unspecified']);

const normalizeGender = (value) => {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'm') return 'male';
  if (v === 'f') return 'female';
  if (v === 'u' || v === 'unknown' || v === 'unspecified' || v === 'prefer_not_say') return 'unspecified';
  return v;
};

const formatGender = (value) => {
  const v = String(value || '').toLowerCase();
  if (v === 'male') return 'Male';
  if (v === 'female') return 'Female';
  return 'Unspecified';
};

const normalizeUucms = (value) => String(value || '').trim().toUpperCase();
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildSearchQuery = (search) => {
  const trimmed = String(search || '').trim();
  if (!trimmed) return {};
  const regex = new RegExp(escapeRegex(trimmed), 'i');
  return {
    $or: [
      { teamId: regex },
      { teamName: regex },
      { 'players.name': regex },
      { 'players.uucms': regex },
      { 'players.department': regex }
    ]
  };
};

const getEventRegistrationCounts = async (eventId) => {
  const rows = await Application.aggregate([
    { $match: { eventId } },
    {
      $project: {
        mainPlayerCount: {
          $size: {
            $filter: {
              input: '$players',
              as: 'player',
              cond: { $ne: ['$$player.isSubstitute', true] }
            }
          }
        }
      }
    },
    {
      $group: {
        _id: '$eventId',
        teamCount: { $sum: 1 },
        playerCount: { $sum: '$mainPlayerCount' }
      }
    }
  ]);
  return rows[0] || { teamCount: 0, playerCount: 0 };
};

const generateTeamId = (eventTitle, count) => {
  const prefix = eventTitle.replace(/\s+/g, '').substring(0, 3).toUpperCase();
  return `${prefix}-TEAM-${String(count + 1).padStart(3, '0')}`;
};

const normalizePlayerInput = (player = {}, index = 0) => {
  const gender = normalizeGender(player.gender);
  if (!player.name || !String(player.name).trim()) {
    throw new Error(`Player ${index + 1} name is required`);
  }
  const uucms = normalizeUucms(player.uucms);
  if (!uucms) {
    throw new Error(`Player ${index + 1} UUCMS number is required`);
  }
  if (!gender || !ALLOWED_GENDERS.has(gender) || gender === 'unspecified') {
    throw new Error(`Gender is required for Player ${index + 1}`);
  }

  return {
    name: String(player.name).trim(),
    uucms,
    phone: String(player.phone || '').trim(),
    department: String(player.department || '').trim(),
    gender,
    isSubstitute: Boolean(player.isSubstitute),
    isTeamLeader: Boolean(player.isTeamLeader)
  };
};

const syncTournamentDisplayName = async (application, previousName, nextName) => {
  if (!application || !nextName || previousName === nextName) return;

  const applicationId = application._id;

  const tournaments = await Tournament.find({ 'participants.applicationId': applicationId });
  for (const tournament of tournaments) {
    let changed = false;
    tournament.participants = (tournament.participants || []).map((participant) => {
      if (String(participant.applicationId || '') !== String(applicationId)) return participant;
      changed = true;
      return { ...participant.toObject(), label: nextName };
    });
    if (changed) await tournament.save();
  }

  const matches = await TournamentMatch.find({
    $or: [
      { participant1Id: applicationId },
      { participant2Id: applicationId },
      { winnerId: applicationId }
    ]
  });

  for (const match of matches) {
    if (String(match.participant1Id || '') === String(applicationId)) match.participant1 = nextName;
    if (String(match.participant2Id || '') === String(applicationId)) match.participant2 = nextName;
    if (String(match.winnerId || '') === String(applicationId)) match.winner = nextName;
    match.updatedAt = new Date();
    await match.save();
  }

  if (previousName) {
    await Leaderboard.updateMany(
      { eventId: application.eventId, teamOrPlayer: previousName },
      { $set: { teamOrPlayer: nextName } }
    );
  }
};

const getRegistrationClosedMessage = (event, state) => {
  if (event.status === 'draft') return 'Registration has not opened yet for this event';
  if (event.status === 'published') return 'Registration is not open yet for this event';
  if (event.status === 'live') return 'This event is already live and no longer accepting registrations';
  if (event.status === 'completed' || event.status === 'archived') return 'Registration is closed for this event';
  if (state.isPastDeadline) return 'Registration deadline has passed for this event';
  if (state.isFull || event.status === 'full') return 'This event is already full';
  return 'Registration is closed for this event';
};

// Public: Register for event
router.post('/', async (req, res) => {
  try {
    const { eventId, players, teamName } = req.body;
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const counts = await getEventRegistrationCounts(event._id);
    const registrationState = getRegistrationState(event, counts);
    if (!registrationState.canRegister) {
      return res.status(400).json({ message: getRegistrationClosedMessage(event, registrationState) });
    }

    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ message: 'At least one player is required' });
    }

    if (event.type === 'team' && (!teamName || !String(teamName).trim())) {
      return res.status(400).json({ message: 'Team name is required for team events' });
    }

    const normalizedPlayers = players.map((player, index) => normalizePlayerInput(player, index));
    const mainPlayers = normalizedPlayers.filter((player) => !player.isSubstitute);

    if (mainPlayers.length === 0) {
      return res.status(400).json({ message: 'At least one main player is required' });
    }

    // Check department restrictions
    if (Array.isArray(event.allowedDepartments) && event.allowedDepartments.length > 0) {
      const invalidDepts = mainPlayers
        .filter(p => !event.allowedDepartments.includes(p.department))
        .map(p => p.department);
      
      if (invalidDepts.length > 0) {
        return res.status(400).json({ 
          message: `This event is only open for: ${event.allowedDepartments.join(', ')}. Students from ${invalidDepts.join(', ')} cannot register.` 
        });
      }
    }

    // Check gender participation restrictions
    if (Array.isArray(event.allowedGenders) && event.allowedGenders.length > 0) {
      const invalidGenders = mainPlayers
        .filter(p => !event.allowedGenders.includes(p.gender))
        .map(p => `${p.name} (${p.gender})`);
      
      if (invalidGenders.length > 0) {
        const restriction = event.allowedGenders.length === 1 
          ? `only ${event.allowedGenders[0]}s` 
          : event.allowedGenders.join(' and ');
        return res.status(400).json({ 
          message: `This event is open for ${restriction} only. Cannot register: ${invalidGenders.join(', ')}.` 
        });
      }
    }

    if (event.type === 'team') {
      if (mainPlayers.length !== Number(event.teamSize || 1)) {
        return res.status(400).json({ message: `Exactly ${event.teamSize} main players are required for this event` });
      }
      const leaderCount = mainPlayers.filter((player) => player.isTeamLeader).length;
      if (leaderCount !== 1) {
        return res.status(400).json({ message: 'Please select exactly one team leader' });
      }
      
      // Check gender composition requirements
      if (event.maleRequired > 0 || event.femaleRequired > 0) {
        const maleCount = mainPlayers.filter((player) => player.gender === 'male').length;
        const femaleCount = mainPlayers.filter((player) => player.gender === 'female').length;
        
        if (maleCount < event.maleRequired) {
          return res.status(400).json({ 
            message: `This event requires at least ${event.maleRequired} male player(s). You have ${maleCount}.` 
          });
        }
        if (femaleCount < event.femaleRequired) {
          return res.status(400).json({ 
            message: `This event requires at least ${event.femaleRequired} female player(s). You have ${femaleCount}.` 
          });
        }
      }
    } else {
      if (mainPlayers.length !== 1) {
        return res.status(400).json({ message: 'Single events accept exactly one participant' });
      }
      normalizedPlayers.forEach((player) => {
        player.isSubstitute = false;
        player.isTeamLeader = true;
      });
    }

    const uucmsNumbers = mainPlayers.map((player) => player.uucms);
    if (new Set(uucmsNumbers).size !== uucmsNumbers.length) {
      return res.status(400).json({ message: 'Duplicate UUCMS numbers were found in this registration' });
    }

    if (registrationState.hasCapacityLimit && registrationState.remainingSlots < mainPlayers.length) {
      return res.status(400).json({ message: `Only ${registrationState.remainingSlots} slot(s) are remaining for this event` });
    }

    const duplicateApplications = await Application.find({
      eventId,
      players: {
        $elemMatch: {
          uucms: { $in: uucmsNumbers },
          isSubstitute: { $ne: true }
        }
      }
    }).lean();

    const duplicateUucms = new Set();
    duplicateApplications.forEach((application) => {
      (application.players || []).forEach((player) => {
        if (!player.isSubstitute && uucmsNumbers.includes(normalizeUucms(player.uucms))) {
          duplicateUucms.add(normalizeUucms(player.uucms));
        }
      });
    });

    if (duplicateUucms.size > 0) {
      return res.status(400).json({
        message: `Player with UUCMS ${Array.from(duplicateUucms).join(', ')} already registered for this event`
      });
    }

    const teamId = event.type === 'team' ? generateTeamId(event.title, counts.teamCount) : null;
    const finalTeamName = event.type === 'team' ? String(teamName).trim() : null;
    const playersWithStatus = normalizedPlayers.map((player) => ({
      ...player,
      checkInStatus: false
    }));

    const application = new Application({
      eventId,
      teamId,
      teamName: finalTeamName,
      qrCode: '',
      players: playersWithStatus,
      paymentStatus: event.registrationFee > 0 ? 'pending' : 'free'
    });

    const qrPayload = JSON.stringify({
      t: event.type === 'team' ? 'T' : 'S',
      e: String(eventId),
      a: String(application._id)
    });
    application.qrCode = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 420
    });

    await application.save();
    await syncEventRegistrationStatus(event, {
      teamCount: counts.teamCount + 1,
      playerCount: counts.playerCount + getMainPlayerCount(playersWithStatus)
    });

    // Populate eventId with payment details for response
    const result = await Application.findById(application._id).populate('eventId', 'title type status registrationFee paymentQRCode upiPaymentLink');
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Get all registrations
router.get('/', auth, requirePermission('view_registrations'), async (req, res) => {
  try {
    const { eventId, search, attendance, dept, gender } = req.query;
    const query = {};

    if (eventId) query.eventId = eventId;
    if (search) Object.assign(query, buildSearchQuery(search));
    if (attendance === 'pending') query['players.checkInStatus'] = false;
    if (attendance === 'checked_in') query['players.checkInStatus'] = true;
    if (dept) query['players.department'] = dept;
    if (gender) query['players.gender'] = gender;

    const applications = await Application.find(query)
      .populate('eventId', 'title type status')
      .sort({ createdAt: -1 });

    res.json(applications);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get registration by ID (for QR display)
router.get('/public/:id', async (req, res) => {
  try {
    const app = await Application.findById(req.params.id).populate('eventId', 'title');
    if (!app) return res.status(404).json({ message: 'Registration not found' });
    res.json(app);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get Team/Player Profile by Display Name
router.get('/public/profile/:name', async (req, res) => {
  try {
    const name = req.params.name;
    // Find all applications where this name is the team name or the main player's name
    const apps = await Application.find({
      $or: [
        { teamName: name },
        { teamId: name },
        { 'players.0.name': name } 
      ]
    }).populate('eventId', 'title type date');

    if (!apps || apps.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    // Since a player/team might have registered for multiple events, we aggregate their profile
    const profile = {
      name: name,
      events: [],
      players: [],
      totalPoints: 0
    };

    // Use the first found app for the master roster list to show on the profile
    const masterApp = apps.find(a => a.teamName === name) || apps[0];
    profile.players = masterApp.players.map(p => ({
      name: p.name,
      department: p.department,
      role: p.isTeamLeader ? 'Leader' : (p.isSubstitute ? 'Substitute' : 'Player')
    }));

    for (const app of apps) {
      if (app.eventId) {
        profile.events.push({
          eventId: app.eventId._id,
          title: app.eventId.title,
          type: app.eventId.type,
          date: app.eventId.date
        });
      }
    }

    // Get total points from Leaderboard
    const leaderboardEntries = await Leaderboard.find({ teamOrPlayer: name });
    profile.totalPoints = leaderboardEntries.reduce((sum, entry) => sum + (entry.score || 0), 0);
    profile.leaderboardRanks = leaderboardEntries.map(e => ({ eventId: e.eventId, rank: e.rank, score: e.score }));

    res.json(profile);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Check-in by UUCMS scan
router.post('/checkin', auth, requirePermission('check_in'), async (req, res) => {
  try {
    const { eventId } = req.body;
    const uucms = normalizeUucms(req.body.uucms);
    const application = await Application.findOne({ eventId, 'players.uucms': uucms });
    if (!application) return res.status(404).json({ message: 'Player not found' });

    const player = application.players.find((entry) => normalizeUucms(entry.uucms) === uucms);
    if (!player) return res.status(404).json({ message: 'Player not found' });
    player.checkInStatus = true;
    await application.save();

    res.json({ message: `${player.name} checked in successfully`, player });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Check-in by scanned QR payload (single or team)
router.post('/checkin/scan', auth, requirePermission('check_in'), async (req, res) => {
  try {
    const { eventId, qrData } = req.body;
    if (!eventId || !qrData) {
      return res.status(400).json({ message: 'Event and QR data are required' });
    }

    let parsed = null;
    let candidateUucms = String(qrData).trim();

    try {
      const obj = JSON.parse(candidateUucms);
      if (obj && typeof obj === 'object') parsed = obj;
    } catch {
      parsed = null;
    }

    const parsedType = String(parsed?.t || parsed?.type || '').toLowerCase();
    const parsedApplicationId = String(parsed?.a || parsed?.applicationId || parsed?.appId || '').trim();
    const parsedEventId = String(parsed?.e || parsed?.eventId || '').trim();

    let parsedApplication = null;
    if (parsedApplicationId) {
      parsedApplication = await Application.findById(parsedApplicationId);
      if (!parsedApplication) return res.status(404).json({ message: 'Registration not found' });
      if (String(parsedApplication.eventId) !== String(eventId)) {
        return res.status(400).json({ message: 'QR belongs to a different event' });
      }
      if (parsedEventId && parsedEventId !== String(eventId)) {
        return res.status(400).json({ message: 'QR event mismatch' });
      }
    }

    if (
      (parsedApplication && (parsedType === 't' || parsedType === 'team' || Boolean(parsedApplication.teamId))) ||
      (!parsedApplication && parsed && (parsedType === 't' || parsedType === 'team' || parsed.teamId || Array.isArray(parsed.playerUucms)))
    ) {
      let application = parsedApplication;

      if (!application && parsed.teamId) {
        application = await Application.findOne({ eventId, teamId: parsed.teamId });
      }
      if (!application && Array.isArray(parsed.playerUucms) && parsed.playerUucms.length) {
        application = await Application.findOne({ eventId, 'players.uucms': normalizeUucms(parsed.playerUucms[0]) });
      }
      if (!application && parsed.teamLeaderUucms) {
        application = await Application.findOne({ eventId, 'players.uucms': normalizeUucms(parsed.teamLeaderUucms) });
      }

      if (!application) return res.status(404).json({ message: 'Team not found for this event' });

      let updatedCount = 0;
      application.players.forEach((player) => {
        if (!player.checkInStatus) {
          player.checkInStatus = true;
          updatedCount += 1;
        }
      });
      await application.save();

      return res.json({
        type: 'team',
        teamId: application.teamId,
        teamName: application.teamName,
        players: application.players,
        message: `${application.teamName || application.teamId || 'Team'} checked in (${updatedCount} updated)`
      });
    }

    if (parsed && parsed.uucms) candidateUucms = normalizeUucms(parsed.uucms);
    if (!candidateUucms && parsedApplication) {
      const singlePlayer = parsedApplication.players.find((player) => !player.isSubstitute) || parsedApplication.players[0];
      if (singlePlayer) candidateUucms = normalizeUucms(singlePlayer.uucms);
    }

    const application = parsedApplication || await Application.findOne({ eventId, 'players.uucms': normalizeUucms(candidateUucms) });
    if (!application) return res.status(404).json({ message: 'Player not found' });

    const player = application.players.find((entry) => normalizeUucms(entry.uucms) === normalizeUucms(candidateUucms))
      || application.players.find((entry) => !entry.isSubstitute)
      || application.players[0];
    if (!player) return res.status(404).json({ message: 'Player not found' });

    const alreadyCheckedIn = Boolean(player.checkInStatus);
    player.checkInStatus = true;
    await application.save();

    res.json({
      type: 'single',
      player,
      message: alreadyCheckedIn ? `${player.name} already checked in` : `${player.name} checked in successfully`
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Update player gender
router.patch('/:id/players/:playerId', auth, requirePermission('manage_registrations'), async (req, res) => {
  try {
    const { gender, name, phone, uucms, department } = req.body;
    const updates = {};

    // Update gender if provided
    if (gender) {
      const normalizedGender = normalizeGender(gender);
      if (!normalizedGender || !ALLOWED_GENDERS.has(normalizedGender)) {
        return res.status(400).json({ message: 'Invalid gender value' });
      }
      updates.gender = normalizedGender;
    }

    // Update name if provided
    if (name && typeof name === 'string' && name.trim()) {
      updates.name = name.trim();
    }

    // Update phone if provided
    if (phone && typeof phone === 'string') {
      updates.phone = phone.trim();
    }

    // Update UUCMS if provided
    if (uucms && typeof uucms === 'string') {
      updates.uucms = normalizeUucms(uucms);
    }

    // Update department if provided
    if (department && typeof department === 'string') {
      updates.department = department.trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Registration not found' });

    const player = application.players.id(req.params.playerId);
    if (!player) return res.status(404).json({ message: 'Player not found' });

    // Apply updates
    Object.assign(player, updates);
    await application.save();

    res.json({ message: 'Player updated', player });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Toggle player check-in
router.patch('/:id/players/:playerId/checkin', auth, requirePermission('check_in'), async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Registration not found' });

    const player = application.players.id(req.params.playerId);
    if (!player) return res.status(404).json({ message: 'Player not found' });

    player.checkInStatus = Boolean(req.body.checkInStatus);
    await application.save();

    res.json({ message: 'Check-in status updated', player });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Update team name
router.patch('/:id', auth, requirePermission('manage_registrations'), async (req, res) => {
  try {
    const { teamName } = req.body;
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Registration not found' });
    if (!application.teamId) return res.status(400).json({ message: 'Only team registrations can have a team name' });
    if (!teamName || !String(teamName).trim()) return res.status(400).json({ message: 'Team name is required' });

    const previousName = application.teamName;
    application.teamName = String(teamName).trim();
    await application.save();
    await syncTournamentDisplayName(application, previousName, application.teamName);

    await AuditLog.create({
      action: `Team Name Updated: ${application.teamName}`,
      admin: req.admin.name,
      ip: req.ip
    });

    res.json({ message: 'Team name updated', teamName: application.teamName });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Delete registration
router.delete('/:id', auth, requirePermission('manage_registrations'), async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Registration not found' });

    const tournamentExists = await Tournament.exists({ eventId: application.eventId });
    if (tournamentExists) {
      return res.status(400).json({ message: 'Cannot delete a registration after a tournament bracket has been created for this event' });
    }

    await Application.findByIdAndDelete(req.params.id);
    const event = await Event.findById(application.eventId);
    if (event) {
      const counts = await getEventRegistrationCounts(application.eventId);
      if (event.status === 'full') {
        event.registrationOpen = true;
      }
      await syncEventRegistrationStatus(event, counts);
    }

    await AuditLog.create({ action: 'Application Deleted', admin: req.admin.name, ip: req.ip });
    res.json({ message: 'Registration deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Export all as Excel
router.get('/export/excel', auth, requirePermission('view_registrations'), async (req, res) => {
  try {
    const { eventId } = req.query;
    const query = {};
    if (eventId) query.eventId = eventId;

    const applications = await Application.find(query).populate('eventId', 'title type');
    const rows = [];

    for (const app of applications) {
      for (const player of app.players) {
        rows.push({
          Event: app.eventId?.title || '',
          'Team ID': app.teamId || 'N/A',
          'Team Name': app.teamName || 'N/A',
          'Player Name': player.name,
          'UUCMS Number': player.uucms,
          Phone: player.phone,
          Department: player.department,
          Gender: formatGender(player.gender),
          Role: player.isTeamLeader ? 'Leader' : player.isSubstitute ? 'Substitute' : 'Player',
          'Check-In': player.checkInStatus ? 'Yes' : 'No',
          Substitute: player.isSubstitute ? 'Yes' : 'No',
          'Registration Date': new Date(app.createdAt).toLocaleDateString()
        });
      }
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Participants');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Participants.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Export event-wise participants
router.get('/export/event/:eventId', auth, requirePermission('view_registrations'), async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const applications = await Application.find({ eventId: req.params.eventId });
    const rows = [];

    for (const app of applications) {
      for (const player of app.players) {
        const row = { Event: event.title };
        if (event.type === 'team') {
          row['Team ID'] = app.teamId || 'N/A';
          row['Team Name'] = app.teamName || 'N/A';
        }
        row['Player Name'] = player.name;
        row['UUCMS Number'] = player.uucms;
        row.Phone = player.phone;
        row.Department = player.department;
        row.Gender = formatGender(player.gender);
        row.Role = player.isTeamLeader ? 'Leader' : player.isSubstitute ? 'Substitute' : 'Player';
        row['Check-In'] = player.checkInStatus ? 'Yes' : 'No';
        if (event.type === 'team') row.Substitute = player.isSubstitute ? 'Yes' : 'No';
        rows.push(row);
      }
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Participants');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = `${event.title.replace(/\s+/g, '_')}_Participants.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Export CSV
router.get('/export/csv', auth, requirePermission('view_registrations'), async (req, res) => {
  try {
    const { eventId } = req.query;
    const query = {};
    if (eventId) query.eventId = eventId;

    const applications = await Application.find(query).populate('eventId', 'title');
    let csv = 'Event,Team ID,Team Name,Player Name,UUCMS Number,Phone,Department,Gender,Role,Check-In,Registration Date\n';

    for (const app of applications) {
      for (const player of app.players) {
        const role = player.isTeamLeader ? 'Leader' : player.isSubstitute ? 'Substitute' : 'Player';
        csv += `"${app.eventId?.title || ''}","${app.teamId || 'N/A'}","${app.teamName || 'N/A'}","${player.name}","${player.uucms}","${player.phone}","${player.department}","${formatGender(player.gender)}","${role}","${player.checkInStatus ? 'Yes' : 'No'}","${new Date(app.createdAt).toLocaleDateString()}"\n`;
      }
    }

    res.setHeader('Content-Disposition', 'attachment; filename="registrations.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Stats
router.get('/stats/overview', auth, requirePermission('view_dashboard'), async (req, res) => {
  try {
    const [totalRegistrations, totalTeams, totalEvents, openEvents, fullEvents, applications] = await Promise.all([
      Application.countDocuments(),
      Application.countDocuments({ teamId: { $ne: null } }),
      Event.countDocuments(),
      Event.countDocuments({ status: 'open' }),
      Event.countDocuments({ status: 'full' }),
      Application.find().lean()
    ]);

    const checkedIn = applications.reduce(
      (sum, application) => sum + application.players.filter((player) => player.checkInStatus).length,
      0
    );
    const totalParticipants = applications.reduce(
      (sum, application) => sum + application.players.length,
      0
    );

    res.json({
      totalEvents,
      totalRegistrations,
      totalTeams,
      checkedIn,
      pendingCheckIn: Math.max(totalParticipants - checkedIn, 0),
      openEvents,
      fullEvents
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Verify payment for a registration
router.patch('/:id/verify-payment', auth, requirePermission('manage_registrations'), async (req, res) => {
  try {
    const application = await Application.findByIdAndUpdate(
      req.params.id,
      {
        paymentStatus: 'paid',
        paymentVerifiedAt: new Date(),
        verifiedByAdmin: req.admin.id
      },
      { new: true }
    ).populate('eventId', 'title registrationFee');
    
    if (!application) return res.status(404).json({ message: 'Registration not found' });
    res.json({ message: 'Payment verified successfully', data: application });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Mark payment as pending (undo verification)
router.patch('/:id/unverify-payment', auth, requirePermission('manage_registrations'), async (req, res) => {
  try {
    const application = await Application.findByIdAndUpdate(
      req.params.id,
      {
        paymentStatus: 'pending',
        paymentVerifiedAt: null,
        verifiedByAdmin: null
      },
      { new: true }
    ).populate('eventId', 'title registrationFee');
    
    if (!application) return res.status(404).json({ message: 'Registration not found' });
    res.json({ message: 'Payment status reset', data: application });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// User: Upload payment screenshot proof
router.patch('/:id/upload-payment-screenshot', auth, upload.single('screenshot'), async (req, res) => {
  try {
    const application = await Application.findById(req.params.id).populate('eventId', 'title registrationFee paymentQRCode upiPaymentLink');
    if (!application) return res.status(404).json({ message: 'Registration not found' });
    
    if (!req.file) {
      return res.status(400).json({ message: 'Payment screenshot file required' });
    }

    application.paymentScreenshot = `/uploads/payment-screenshots/${req.file.filename}`;
    application.paymentScreenshotUploadedAt = new Date();
    application.paymentStatus = 'pending';
    await application.save();
    
    // Reload with populated eventId
    const updated = await Application.findById(req.params.id).populate('eventId', 'title registrationFee paymentQRCode upiPaymentLink');
    res.json({ message: 'Payment screenshot uploaded successfully', data: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
