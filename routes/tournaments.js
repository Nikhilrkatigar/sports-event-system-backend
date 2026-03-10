const router = require('express').Router();
const { Tournament, TournamentMatch, Application, Event, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requireFullAccess = require('../middleware/requireFullAccess');

// Helper: next power of 2
const nextPowerOf2 = (n) => {
    let p = 1;
    while (p < n) p *= 2;
    return p;
};

// Public: Get all tournaments
router.get('/', async (req, res) => {
    try {
        const tournaments = await Tournament.find().populate('eventId', 'title type image date');
        res.json(tournaments);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Public: Get tournament + matches for an event
router.get('/event/:eventId', async (req, res) => {
    try {
        const tournament = await Tournament.findOne({ eventId: req.params.eventId }).populate('eventId', 'title type image date');
        if (!tournament) return res.status(404).json({ message: 'No tournament found for this event' });
        const matches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });
        res.json({ tournament, matches });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Admin: Generate bracket from registrations
router.post('/generate', auth, requireFullAccess, async (req, res) => {
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

        // Check if a tournament already exists for this event
        const existing = await Tournament.findOne({ eventId });
        if (existing) {
            return res.status(400).json({ message: 'A tournament already exists for this event. Delete it first to regenerate.' });
        }

        // Get registrations
        const applications = await Application.find({ eventId });
        if (applications.length < 2) {
            return res.status(400).json({ message: 'At least 2 registrations are required to generate a bracket' });
        }

        // Build participant names
        const participants = applications.map(app => {
            if (event.type === 'team') {
                return app.teamName || app.teamId || `Team ${app._id.toString().slice(-4)}`;
            }
            const mainPlayer = app.players.find(p => !p.isSubstitute) || app.players[0];
            return mainPlayer?.name || `Player ${app._id.toString().slice(-4)}`;
        });

        // Create tournament
        const tournament = new Tournament({ eventId, format, participants, status: 'draft' });
        await tournament.save();

        let matches = [];

        if (format === 'single_elimination') {
            matches = generateSingleElimination(tournament, participants, eventId);
        } else {
            matches = generateRoundRobin(tournament, participants, eventId);
        }

        await TournamentMatch.insertMany(matches);

        // Auto-resolve BYE matches for single elimination
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

        res.status(201).json({ tournament, matches: savedMatches });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Admin: Update match score
router.put('/match/:matchId', auth, async (req, res) => {
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

        match.score1 = Number(score1);
        match.score2 = Number(score2);
        match.winner = match.score1 > match.score2 ? match.participant1 : match.participant2;
        match.status = 'completed';
        await match.save();

        const tournament = await Tournament.findById(match.tournamentId);

        // For single elimination, advance winner to next round
        if (tournament && tournament.format === 'single_elimination') {
            await advanceWinner(match);
        }

        // Check if all matches are completed -> mark tournament as completed
        const pendingMatches = await TournamentMatch.countDocuments({
            tournamentId: match.tournamentId,
            status: { $ne: 'completed' }
        });
        if (pendingMatches === 0) {
            await Tournament.findByIdAndUpdate(match.tournamentId, { status: 'completed' });
        }

        const allMatches = await TournamentMatch.find({ tournamentId: match.tournamentId }).sort({ round: 1, matchNumber: 1 });
        res.json({ match, allMatches });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Admin: Delete tournament and its matches
router.delete('/:id', auth, requireFullAccess, async (req, res) => {
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

// ========== BRACKET GENERATION HELPERS ==========

function generateSingleElimination(tournament, participants, eventId) {
    const n = participants.length;
    const totalSlots = nextPowerOf2(n);
    const totalRounds = Math.log2(totalSlots);

    // Pad with BYE entries
    const seeded = [...participants];
    while (seeded.length < totalSlots) {
        seeded.push('BYE');
    }

    // Shuffle to randomize seeding (optional, makes it fair)
    for (let i = seeded.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [seeded[i], seeded[j]] = [seeded[j], seeded[i]];
    }

    const matches = [];

    // Round 1 matches
    for (let i = 0; i < totalSlots / 2; i++) {
        matches.push({
            eventId,
            tournamentId: tournament._id,
            round: 1,
            matchNumber: i + 1,
            participant1: seeded[i * 2],
            participant2: seeded[i * 2 + 1],
            status: 'pending'
        });
    }

    // Create placeholder matches for subsequent rounds
    let matchesInRound = totalSlots / 4;
    for (let round = 2; round <= totalRounds; round++) {
        for (let i = 0; i < matchesInRound; i++) {
            matches.push({
                eventId,
                tournamentId: tournament._id,
                round,
                matchNumber: i + 1,
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
                participant1: participants[i],
                participant2: participants[j],
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
            // Both are BYE, mark completed with no winner
            match.status = 'completed';
            await match.save();
            continue;
        }

        const winner = match.participant1 === 'BYE' ? match.participant2 : match.participant1;
        match.winner = winner;
        match.score1 = match.participant1 === 'BYE' ? 0 : 1;
        match.score2 = match.participant2 === 'BYE' ? 0 : 1;
        match.status = 'completed';
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

    if (!nextMatch) return; // This was the final

    // Odd matchNumber feeds into participant1, even feeds into participant2
    if (match.matchNumber % 2 === 1) {
        nextMatch.participant1 = match.winner;
    } else {
        nextMatch.participant2 = match.winner;
    }

    await nextMatch.save();
}

module.exports = router;
