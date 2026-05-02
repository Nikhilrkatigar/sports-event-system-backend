const mongoose = require('mongoose');

// Individual player within a cricket squad
const cricketPlayerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  uucms: { type: String, default: '' },
  department: { type: String, default: '' },
  role: { type: String, enum: ['batsman', 'bowler', 'all_rounder', 'wicket_keeper'], default: 'batsman' },
  isCaptain: { type: Boolean, default: false },
  isViceCaptain: { type: Boolean, default: false },
  isPlaying: { type: Boolean, default: true }  // Playing XI flag
}, { _id: false });

// Per-batsman stats within an innings
const batsmanStatSchema = new mongoose.Schema({
  playerName: { type: String, required: true },
  playerId: { type: String, default: '' },       // index ref into team players
  runs: { type: Number, default: 0 },
  ballsFaced: { type: Number, default: 0 },
  fours: { type: Number, default: 0 },
  sixes: { type: Number, default: 0 },
  strikeRate: { type: Number, default: 0 },       // (runs/balls)*100
  isOut: { type: Boolean, default: false },
  dismissalType: {
    type: String,
    enum: ['not_out', 'bowled', 'caught', 'run_out', 'stumped', 'lbw', 'hit_wicket', 'retired_hurt', 'retired_out'],
    default: 'not_out'
  },
  dismissalBowler: { type: String, default: '' },
  dismissalFielder: { type: String, default: '' },
  dismissalText: { type: String, default: '' },    // "c Kiran b Suresh"
  battingOrder: { type: Number, default: 0 }
}, { _id: false });

// Per-bowler stats within an innings
const bowlerStatSchema = new mongoose.Schema({
  playerName: { type: String, required: true },
  playerId: { type: String, default: '' },
  oversBowled: { type: Number, default: 0 },       // e.g. 3.4
  ballsBowled: { type: Number, default: 0 },        // legal deliveries
  maidens: { type: Number, default: 0 },
  runsConceded: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 },
  noBalls: { type: Number, default: 0 },
  wides: { type: Number, default: 0 },
  economy: { type: Number, default: 0 },            // runs / overs
  bowlingOrder: { type: Number, default: 0 }
}, { _id: false });

// Fall of wicket entry
const fallOfWicketSchema = new mongoose.Schema({
  wicketNumber: { type: Number, required: true },
  score: { type: Number, required: true },          // team score when wicket fell
  overNumber: { type: String, default: '0.0' },     // e.g. "2.4"
  batsmanName: { type: String, required: true },
  dismissalText: { type: String, default: '' }
}, { _id: false });

// Partnership entry
const partnershipSchema = new mongoose.Schema({
  wicketNumber: { type: Number, default: 0 },       // 0 = opening
  batsman1Name: { type: String, default: '' },
  batsman2Name: { type: String, default: '' },
  runs: { type: Number, default: 0 },
  balls: { type: Number, default: 0 }
}, { _id: false });

// Extras breakdown
const extrasSchema = new mongoose.Schema({
  wides: { type: Number, default: 0 },
  noBalls: { type: Number, default: 0 },
  byes: { type: Number, default: 0 },
  legByes: { type: Number, default: 0 },
  penalties: { type: Number, default: 0 }
}, { _id: false });

// Single innings
const inningsSchema = new mongoose.Schema({
  inningNumber: { type: Number, required: true },
  battingTeam: { type: String, enum: ['teamA', 'teamB'], required: true },
  bowlingTeam: { type: String, enum: ['teamA', 'teamB'], required: true },
  totalRuns: { type: Number, default: 0 },
  totalWickets: { type: Number, default: 0 },
  totalOvers: { type: String, default: '0.0' },     // display string "16.4"
  totalBalls: { type: Number, default: 0 },          // actual legal deliveries
  extras: { type: extrasSchema, default: () => ({}) },
  batsmenStats: [batsmanStatSchema],
  bowlerStats: [bowlerStatSchema],
  fallOfWickets: [fallOfWicketSchema],
  partnerships: [partnershipSchema],
  currentOverBalls: { type: Number, default: 0 },    // balls in current over (0-5)
  currentOverRuns: { type: Number, default: 0 },     // runs in current over
  isDeclared: { type: Boolean, default: false },
  isCompleted: { type: Boolean, default: false }
}, { _id: false });

// Team container
const cricketTeamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
  players: [cricketPlayerSchema]
}, { _id: false });

// Main CricketMatch schema
const cricketMatchSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', default: null },
  tournamentMatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentMatch', default: null },

  // Teams
  teamA: { type: cricketTeamSchema, required: true },
  teamB: { type: cricketTeamSchema, required: true },

  // Toss
  toss: {
    wonBy: { type: String, enum: ['teamA', 'teamB', ''], default: '' },
    chose: { type: String, enum: ['bat', 'bowl', ''], default: '' }
  },

  // Match config
  oversPerSide: { type: Number, default: 20 },
  venue: { type: String, default: '' },
  matchDate: { type: Date, default: Date.now },

  // Current state tracking
  currentState: {
    type: String,
    enum: ['not_started', 'toss', 'innings_1', 'innings_break', 'innings_2', 'super_over_break', 'super_over_1', 'super_over_2', 'completed', 'abandoned'],
    default: 'not_started'
  },
  currentInning: { type: Number, default: 0 },       // 0 = not started, 1 or 2 (or 3/4 for super over)
  currentStrikerId: { type: String, default: '' },
  currentNonStrikerId: { type: String, default: '' },
  currentBowlerId: { type: String, default: '' },
  lastCompletedOverBowlerId: { type: String, default: '' },  // bowler of the last completed over (for consecutive-over rule)
  isNextBallFreeHit: { type: Boolean, default: false },       // ICC Free Hit after no-ball

  // Super Over
  isSuperOver: { type: Boolean, default: false },
  superOverNumber: { type: Number, default: 0 },              // 0 = not started, 1 or 2
  superOverInnings: [inningsSchema],                           // Super Over innings (max 2)

  // Innings data
  innings: [inningsSchema],

  // Result
  result: {
    winner: { type: String, enum: ['teamA', 'teamB', 'tie', 'no_result', ''], default: '' },
    winnerName: { type: String, default: '' },
    resultText: { type: String, default: '' },
    manOfTheMatch: { type: String, default: '' }
  },

  status: { type: String, enum: ['upcoming', 'live', 'completed', 'abandoned'], default: 'upcoming' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Auto-update timestamp
cricketMatchSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('CricketMatch', cricketMatchSchema);
