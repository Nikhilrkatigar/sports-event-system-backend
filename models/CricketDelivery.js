const mongoose = require('mongoose');

const cricketDeliverySchema = new mongoose.Schema({
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'CricketMatch', required: true, index: true },
  inningNumber: { type: Number, required: true },
  overNumber: { type: Number, required: true },       // 0-indexed (0 = 1st over)
  ballNumber: { type: Number, required: true },        // ball within the over (1-6)

  // Players involved
  batsmanName: { type: String, required: true },
  bowlerName: { type: String, required: true },
  nonStrikerName: { type: String, default: '' },

  // Runs
  runsScored: { type: Number, default: 0 },            // runs off bat (0,1,2,3,4,6)
  extraRuns: { type: Number, default: 0 },             // runs from extras on this ball
  totalRuns: { type: Number, default: 0 },             // total runs added for this delivery
  overthrowBaseRuns: { type: Number, default: 0 },     // runs completed before overthrow
  overthrowRuns: { type: Number, default: 0 },         // runs scored due to overthrow
  isPenalty: { type: Boolean, default: false },
  penaltyRuns: { type: Number, default: 0 },

  // Extras flags
  isWide: { type: Boolean, default: false },
  isNoBall: { type: Boolean, default: false },
  isBye: { type: Boolean, default: false },
  isLegBye: { type: Boolean, default: false },
  isOverthrow: { type: Boolean, default: false },

  // Boundaries and Milestones
  isFour: { type: Boolean, default: false },
  isSix: { type: Boolean, default: false },
  isFifty: { type: Boolean, default: false },
  isCentury: { type: Boolean, default: false },

  // Wicket
  isWicket: { type: Boolean, default: false },
  wicketType: {
    type: String,
    enum: ['', 'bowled', 'caught', 'run_out', 'stumped', 'lbw', 'hit_wicket', 'obstructing_field', 'retired_hurt', 'retired_out'],
    default: ''
  },
  wicketBatsman: { type: String, default: '' },        // who got out
  wicketFielder: { type: String, default: '' },        // fielder (if caught/stumped/run_out)
  newBatsmanId: { type: String, default: '' },         // incoming batsman after wicket/retirement
  newBatsmanName: { type: String, default: '' },

  // Cumulative state after this ball (snapshot for live display)
  teamScore: { type: Number, default: 0 },
  teamWickets: { type: Number, default: 0 },
  oversSoFar: { type: String, default: '0.0' },       // "16.3"

  // Auto-generated commentary
  commentary: { type: String, default: '' },

  timestamp: { type: Date, default: Date.now }
});

// Compound index for efficient retrieval
cricketDeliverySchema.index({ matchId: 1, inningNumber: 1, overNumber: 1, ballNumber: 1 });

module.exports = mongoose.model('CricketDelivery', cricketDeliverySchema);
