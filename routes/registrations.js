const router = require('express').Router();
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { Application, Event, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requireFullAccess = require('../middleware/requireFullAccess');

// Helper: generate team ID
const generateTeamId = (eventTitle, count) => {
  const prefix = eventTitle.replace(/\s+/g, '').substring(0, 3).toUpperCase();
  return `${prefix}-TEAM-${String(count + 1).padStart(3, '0')}`;
};

// Public: Register for event
router.post('/', async (req, res) => {
  try {
    const { eventId, players } = req.body;
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    if (event.registrationOpen === false) return res.status(400).json({ message: 'Registration is closed for this event' });

    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ message: 'At least one player is required' });
    }

    const normalizedPlayers = players.map((player) => ({
      name: player.name,
      uucms: player.uucms,
      phone: player.phone,
      department: player.department,
      isSubstitute: Boolean(player.isSubstitute),
      isTeamLeader: Boolean(player.isTeamLeader)
    }));

    const mainPlayers = normalizedPlayers.filter(p => !p.isSubstitute);
    if (mainPlayers.length === 0) {
      return res.status(400).json({ message: 'At least one main player is required' });
    }

    if (event.type === 'team') {
      const leaderCount = mainPlayers.filter(p => p.isTeamLeader).length;
      if (leaderCount !== 1) {
        return res.status(400).json({ message: 'Please select exactly one team leader' });
      }
    } else {
      // For single events, the participant is treated as leader.
      normalizedPlayers.forEach((p) => {
        p.isSubstitute = false;
        p.isTeamLeader = true;
      });
    }

    // Duplicate check
    const uucmsNumbers = mainPlayers.map(p => p.uucms);
    for (const uucms of uucmsNumbers) {
      const existing = await Application.findOne({
        eventId,
        'players.uucms': uucms,
        'players.isSubstitute': { $ne: true }
      });
      if (existing) {
        return res.status(400).json({ message: `Player with UUCMS ${uucms} already registered for this event` });
      }
    }

    // Count existing teams for this event
    const existingCount = await Application.countDocuments({ eventId });

    const teamId = event.type === 'team' ? generateTeamId(event.title, existingCount) : null;
    const teamName = event.type === 'team' ? `Team ${existingCount + 1}` : null;
    // Keep per-player status, but generate one QR for the whole registration.
    const playersWithStatus = normalizedPlayers.map((player) => ({
      ...player,
      checkInStatus: false
    }));

    const application = new Application({
      eventId,
      teamId,
      teamName,
      qrCode: '',
      players: playersWithStatus
    });

    // Compact payload keeps QR dense enough to scan reliably.
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
    res.status(201).json(application);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Get all registrations
router.get('/', auth, async (req, res) => {
  try {
    const { eventId, search } = req.query;
    let query = {};
    if (eventId) query.eventId = eventId;

    let applications = await Application.find(query).populate('eventId', 'title type').sort({ createdAt: -1 });

    if (search) {
      const s = search.toLowerCase();
      applications = applications.filter(app =>
        app.players.some(p =>
          p.name.toLowerCase().includes(s) ||
          p.uucms.toLowerCase().includes(s) ||
          p.department?.toLowerCase().includes(s)
        )
      );
    }
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

// Admin: Check-in by UUCMS scan
router.post('/checkin', auth, async (req, res) => {
  try {
    const { uucms, eventId } = req.body;
    const application = await Application.findOne({ eventId, 'players.uucms': uucms });
    if (!application) return res.status(404).json({ message: 'Player not found' });

    const player = application.players.find(p => p.uucms === uucms);
    player.checkInStatus = true;
    await application.save();

    res.json({ message: `${player.name} checked in successfully`, player });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Check-in by scanned QR payload (single or team)
router.post('/checkin/scan', auth, async (req, res) => {
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

    // Team QR payload path
    if (
      parsedApplication && (parsedType === 't' || parsedType === 'team' || Boolean(parsedApplication.teamId)) ||
      (!parsedApplication && parsed && (parsedType === 't' || parsedType === 'team' || parsed.teamId || Array.isArray(parsed.playerUucms)))
    ) {
      let application = parsedApplication;

      if (!application && parsed.teamId) {
        application = await Application.findOne({ eventId, teamId: parsed.teamId });
      }
      if (!application && Array.isArray(parsed.playerUucms) && parsed.playerUucms.length) {
        application = await Application.findOne({ eventId, 'players.uucms': parsed.playerUucms[0] });
      }
      if (!application && parsed.teamLeaderUucms) {
        application = await Application.findOne({ eventId, 'players.uucms': parsed.teamLeaderUucms });
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

    // Single QR payload or manual UUCMS path
    if (parsed && parsed.uucms) candidateUucms = String(parsed.uucms).trim();
    if (!candidateUucms && parsedApplication) {
      const singlePlayer = parsedApplication.players.find(p => !p.isSubstitute) || parsedApplication.players[0];
      if (singlePlayer) candidateUucms = String(singlePlayer.uucms);
    }

    const application = parsedApplication || await Application.findOne({ eventId, 'players.uucms': candidateUucms });
    if (!application) return res.status(404).json({ message: 'Player not found' });

    const player = application.players.find(p => p.uucms === candidateUucms) || application.players.find(p => !p.isSubstitute) || application.players[0];
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

// Admin: Delete registration
router.delete('/:id', auth, async (req, res) => {
  try {
    await Application.findByIdAndDelete(req.params.id);
    await AuditLog.create({ action: 'Application Deleted', admin: req.admin.name, ip: req.ip });
    res.json({ message: 'Registration deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Export all as Excel
router.get('/export/excel', auth, async (req, res) => {
  try {
    const { eventId } = req.query;
    let query = {};
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

    res.setHeader('Content-Disposition', `attachment; filename="Participants.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Export event-wise participants
router.get('/export/event/:eventId', auth, async (req, res) => {
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
        row['Phone'] = player.phone;
        row['Department'] = player.department;
        row['Role'] = player.isTeamLeader ? 'Leader' : player.isSubstitute ? 'Substitute' : 'Player';
        row['Check-In'] = player.checkInStatus ? 'Yes' : 'No';
        if (event.type === 'team') row['Substitute'] = player.isSubstitute ? 'Yes' : 'No';
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
router.get('/export/csv', auth, async (req, res) => {
  try {
    const { eventId } = req.query;
    let query = {};
    if (eventId) query.eventId = eventId;

    const applications = await Application.find(query).populate('eventId', 'title');
    let csv = 'Event,Team ID,Team Name,Player Name,UUCMS Number,Phone,Department,Role,Check-In,Registration Date\n';

    for (const app of applications) {
      for (const player of app.players) {
        const role = player.isTeamLeader ? 'Leader' : player.isSubstitute ? 'Substitute' : 'Player';
        csv += `"${app.eventId?.title || ''}","${app.teamId || 'N/A'}","${app.teamName || 'N/A'}","${player.name}","${player.uucms}","${player.phone}","${player.department}","${role}","${player.checkInStatus ? 'Yes' : 'No'}","${new Date(app.createdAt).toLocaleDateString()}"\n`;
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
router.get('/stats/overview', auth, requireFullAccess, async (req, res) => {
  try {
    const totalRegistrations = await Application.countDocuments();
    const totalTeams = await Application.countDocuments({ teamId: { $ne: null } });
    const allApps = await Application.find();
    const checkedIn = allApps.reduce((sum, app) => sum + app.players.filter(p => p.checkInStatus).length, 0);
    const totalEvents = await require('../models').Event.countDocuments();
    res.json({ totalEvents, totalRegistrations, totalTeams, checkedIn });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
