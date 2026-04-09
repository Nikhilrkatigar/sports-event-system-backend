const express = require('express');
const router = express.Router();
const cricket = require('../controllers/cricketController');

// ── Admin endpoints (protected by auth middleware in production) ──
router.post('/matches', cricket.createMatch);
router.put('/matches/:id', cricket.updateMatch);
router.post('/matches/:id/toss', cricket.recordToss);
router.post('/matches/:id/start-innings', cricket.startInnings);
router.post('/matches/:id/ball', cricket.recordBall);
router.post('/matches/:id/end-over', cricket.endOver);
router.post('/matches/:id/undo', cricket.undoLastBall);
router.post('/matches/:id/end-innings', cricket.endInnings);
router.post('/matches/:id/complete', cricket.completeMatch);
router.post('/from-tournament', cricket.createFromTournament);
router.delete('/matches/:id', cricket.deleteMatch);

// ── Public read endpoints ──
router.get('/live', cricket.getLiveMatches);
router.get('/matches', cricket.listMatches);
router.get('/matches/:id', cricket.getMatch);
router.get('/matches/:id/scorecard', cricket.getScorecard);
router.get('/matches/:id/deliveries', cricket.getDeliveries);

module.exports = router;
