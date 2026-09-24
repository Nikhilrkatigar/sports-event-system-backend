const express = require('express');
const router = express.Router();
const cricket = require('../controllers/cricketController');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

const admin = [auth, requirePermission('manage_tournaments')];

// ── Admin endpoints ──
router.post('/matches', admin, cricket.createMatch);
router.put('/matches/:id', admin, cricket.updateMatch);
router.post('/matches/:id/toss', admin, cricket.recordToss);
router.post('/matches/:id/start-innings', admin, cricket.startInnings);
router.post('/matches/:id/ball', admin, cricket.recordBall);
router.post('/matches/:id/end-over', admin, cricket.endOver);
router.post('/matches/:id/change-bowler', admin, cricket.changeBowler);
router.post('/matches/:id/resume-batsman', admin, cricket.resumeBatsman);
router.post('/matches/:id/undo', admin, cricket.undoLastBall);
router.post('/matches/:id/end-innings', admin, cricket.endInnings);
router.post('/matches/:id/super-over-innings', admin, cricket.startSuperOverInnings);
router.post('/matches/:id/complete', admin, cricket.completeMatch);
router.post('/from-tournament', admin, cricket.createFromTournament);
router.post('/matches/:id/restart', admin, cricket.restartMatch);
router.delete('/matches/:id', admin, cricket.deleteMatch);

// ── Public read endpoints ──
router.get('/live', cricket.getLiveMatches);
router.get('/matches', cricket.listMatches);
router.get('/matches/:id', cricket.getMatch);
router.get('/matches/:id/scorecard', cricket.getScorecard);
router.get('/matches/:id/deliveries', cricket.getDeliveries);

module.exports = router;
