const router = require('express').Router();
const { GeneralChampionship, Event, Leaderboard, Tournament, TournamentMatch, Application } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

// Point system based on position and event type
const getPointsForPosition = (position, isTeamEvent = false) => {
  if (isTeamEvent) {
    // Team events: 25, 15, 10
    const teamPoints = { 1: 25, 2: 15, 3: 10 };
    return teamPoints[position] || 0;
  }
  // Individual events: 15, 10, 5
  const individualPoints = { 1: 15, 2: 10, 3: 5 };
  return individualPoints[position] || 0;
};

// Fetch department info from Application records
const fetchDepartmentFromRegistration = async (eventId, participantName) => {
  try {
    const applications = await Application.find({ eventId }).select('players teamName');
    
    for (const app of applications) {
      // Check team events
      if (app.teamName === participantName) {
        const mainPlayers = app.players.filter(p => !p.isSubstitute);
        if (mainPlayers.length > 0) {
          return mainPlayers[0].department || 'Unassigned';
        }
      }
      
      // Check single player events
      for (const player of app.players) {
        if (!player.isSubstitute && (player.name === participantName || `${player.name} (${player.uucms})` === participantName)) {
          return player.department || 'Unassigned';
        }
      }
    }
    
    return 'Unassigned';
  } catch (err) {
    console.error('Error fetching department:', err);
    return 'Unassigned';
  }
};

// Calculate GC points from all tournaments
const calculateGeneralChampionship = async () => {
  try {
    const gc = await GeneralChampionship.findOne() || new GeneralChampionship({ championship_id: 'gc-main' });
    gc.entries = [];
    const departmentScores = {}; // Use object instead of Map

    // Get all leaderboard entries that have been synced from tournaments
    const leaderboard = await Leaderboard.find().populate('eventId', 'title type');
    
    // Group by event and get top 3
    const eventGroups = new Map();
    for (const entry of leaderboard) {
      if (!entry.eventId) continue;
      
      const eventKey = entry.eventId._id.toString();
      if (!eventGroups.has(eventKey)) {
        eventGroups.set(eventKey, {
          eventId: entry.eventId._id,
          eventTitle: entry.eventId.title,
          isTeamEvent: entry.eventId.type === 'team',
          entries: []
        });
      }
      
      eventGroups.get(eventKey).entries.push(entry);
    }

    // Award points to top 3 in each event
    for (const [, eventData] of eventGroups.entries()) {
      // Sort by rank (1st, 2nd, 3rd)
      const sorted = eventData.entries
        .filter(e => e.rank && e.rank <= 3)
        .sort((a, b) => a.rank - b.rank);

      for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const entry = sorted[i];
        const position = i + 1;
        const department = await fetchDepartmentFromRegistration(eventData.eventId, entry.teamOrPlayer);
        const points = getPointsForPosition(position, eventData.isTeamEvent);

        // Add entry
        gc.entries.push({
          eventId: eventData.eventId,
          eventTitle: eventData.eventTitle,
          isTeamEvent: eventData.isTeamEvent,
          departmentName: department,
          position,
          participantName: entry.teamOrPlayer,
          points
        });

        // Accumulate department score
        departmentScores[department] = (departmentScores[department] || 0) + points;
      }
    }

    gc.departmentScores = departmentScores;
    gc.updatedAt = new Date();
    await gc.save();

    return gc;
  } catch (err) {
    console.error('Error calculating GC:', err);
    throw err;
  }
};

// Public: Get general championship standings
router.get('/', async (req, res) => {
  try {
    let gc = await GeneralChampionship.findOne();
    
    if (!gc) {
      return res.json({
        championship_id: 'gc-main',
        name: 'General Championship',
        entries: [],
        departmentScores: {},
        departmentStandings: [],
        message: 'No championship data yet'
      });
    }

    // Convert to plain object
    const gcObj = gc.toObject();
    const deptScores = gcObj.departmentScores || {};

    // Format response with sorted departments
    const sortedDepts = Object.entries(deptScores)
      .sort((a, b) => b[1] - a[1])
      .map(([dept, score]) => ({ department: dept, totalPoints: score }));

    res.json({
      championship_id: gcObj.championship_id,
      name: gcObj.name,
      entries: gcObj.entries || [],
      departmentScores: deptScores,
      departmentStandings: sortedDepts
    });
  } catch (err) {
    console.error('GC GET error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Admin: Recalculate general championship
router.post('/calculate', auth, requirePermission('manage_leaderboard'), async (req, res) => {
  try {
    const gc = await calculateGeneralChampionship();
    const gcObj = gc.toObject();
    const deptScores = gcObj.departmentScores || {};
    
    const sortedDepts = Object.entries(deptScores)
      .sort((a, b) => b[1] - a[1])
      .map(([dept, score]) => ({ department: dept, totalPoints: score }));

    res.json({
      message: 'General Championship recalculated',
      championship_id: gcObj.championship_id,
      name: gcObj.name,
      entries: gcObj.entries || [],
      departmentScores: deptScores,
      departmentStandings: sortedDepts
    });
  } catch (err) {
    console.error('GC calculate error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Admin: Get GC details by department
router.get('/department/:department', async (req, res) => {
  try {
    const gc = await GeneralChampionship.findOne().populate('entries.eventId', 'title type');
    
    if (!gc) {
      return res.status(404).json({ message: 'No championship data' });
    }

    const deptEntries = gc.entries.filter(e => e.departmentName === req.params.department);
    const totalScore = deptEntries.reduce((sum, e) => sum + e.points, 0);

    res.json({
      department: req.params.department,
      totalPoints: totalScore,
      eventResults: deptEntries.map(e => ({
        event: e.eventTitle,
        position: e.position,
        participant: e.participantName,
        points: e.points,
        isTeamEvent: e.isTeamEvent
      }))
    });
  } catch (err) {
    console.error('GC department error:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
