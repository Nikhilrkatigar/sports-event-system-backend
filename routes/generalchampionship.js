const router = require('express').Router();
const { GeneralChampionship } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { calculateGeneralChampionship } = require('../utils/generalChampionship');

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
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
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
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
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
        competition: e.competitionLabel || e.eventTitle,
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
