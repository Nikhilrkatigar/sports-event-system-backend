const { CricketMatch, CricketDelivery } = require('../models');

// ============================================================
// Helper utilities
// ============================================================

/** Convert totalBalls to overs display string, e.g. 16 balls at 6-per-over → "2.4" */
function ballsToOvers(balls) {
  const overs = Math.floor(balls / 6);
  const remainder = balls % 6;
  return `${overs}.${remainder}`;
}

/** Compute strike rate */
function strikeRate(runs, balls) {
  if (!balls || balls === 0) return 0;
  return parseFloat(((runs / balls) * 100).toFixed(2));
}

/** Compute economy */
function economy(runs, balls) {
  if (!balls || balls === 0) return 0;
  const overs = balls / 6;
  return parseFloat((runs / overs).toFixed(2));
}

/** Generate a short commentary string for a delivery */
function generateCommentary(data) {
  const { batsmanName, bowlerName, runsScored, isWide, isNoBall, isBye, isLegBye, isFour, isSix, isWicket, wicketType, wicketBatsman } = data;
  if (isWicket) {
    const howOut = wicketType.replace('_', ' ').toUpperCase();
    return `OUT! ${wicketBatsman || batsmanName} is ${howOut}! ${bowlerName} strikes.`;
  }
  if (isSix) return `SIX! ${batsmanName} launches it over the boundary off ${bowlerName}!`;
  if (isFour) return `FOUR! ${batsmanName} finds the gap off ${bowlerName}.`;
  if (isWide) return `Wide ball by ${bowlerName}. ${data.extraRuns || 1} extra run(s).`;
  if (isNoBall) return `No ball by ${bowlerName}!${runsScored > 0 ? ` ${batsmanName} scores ${runsScored}.` : ''}`;
  if (isBye) return `Bye! ${data.extraRuns || 1} run(s) added.`;
  if (isLegBye) return `Leg bye off ${bowlerName}. ${data.extraRuns || 1} run(s).`;
  if (runsScored === 0) return `Dot ball. Good delivery by ${bowlerName} to ${batsmanName}.`;
  return `${runsScored} run(s) scored by ${batsmanName} off ${bowlerName}.`;
}

// ============================================================
// ADMIN: Create a new cricket match
// ============================================================
exports.createMatch = async (req, res) => {
  try {
    const { eventId, teamA, teamB, oversPerSide, venue, matchDate } = req.body;
    if (!eventId || !teamA || !teamB) {
      return res.status(400).json({ error: 'eventId, teamA and teamB are required' });
    }

    const match = new CricketMatch({
      eventId,
      teamA: {
        name: teamA.name,
        applicationId: teamA.applicationId || null,
        players: (teamA.players || []).map((p, i) => ({
          name: p.name,
          uucms: p.uucms || '',
          department: p.department || '',
          role: p.role || 'batsman',
          isCaptain: p.isCaptain || false,
          isViceCaptain: p.isViceCaptain || false,
          isPlaying: p.isPlaying !== undefined ? p.isPlaying : true
        }))
      },
      teamB: {
        name: teamB.name,
        applicationId: teamB.applicationId || null,
        players: (teamB.players || []).map((p, i) => ({
          name: p.name,
          uucms: p.uucms || '',
          department: p.department || '',
          role: p.role || 'batsman',
          isCaptain: p.isCaptain || false,
          isViceCaptain: p.isViceCaptain || false,
          isPlaying: p.isPlaying !== undefined ? p.isPlaying : true
        }))
      },
      oversPerSide: oversPerSide || 20,
      venue: venue || '',
      matchDate: matchDate || new Date(),
      currentState: 'not_started',
      status: 'upcoming'
    });

    await match.save();
    res.status(201).json(match);
  } catch (err) {
    console.error('createMatch error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Update match details (squads, venue, etc.)
// ============================================================
exports.updateMatch = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const { teamA, teamB, oversPerSide, venue, matchDate } = req.body;
    if (teamA) {
      if (teamA.name) match.teamA.name = teamA.name;
      if (teamA.applicationId) match.teamA.applicationId = teamA.applicationId;
      if (teamA.players) match.teamA.players = teamA.players;
    }
    if (teamB) {
      if (teamB.name) match.teamB.name = teamB.name;
      if (teamB.applicationId) match.teamB.applicationId = teamB.applicationId;
      if (teamB.players) match.teamB.players = teamB.players;
    }
    if (oversPerSide) match.oversPerSide = oversPerSide;
    if (venue) match.venue = venue;
    if (matchDate) match.matchDate = matchDate;

    await match.save();
    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Record toss
// ============================================================
exports.recordToss = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const { wonBy, chose } = req.body;
    if (!wonBy || !chose) return res.status(400).json({ error: 'wonBy and chose are required' });

    match.toss = { wonBy, chose };
    match.currentState = 'toss';
    await match.save();

    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Start an innings
// ============================================================
exports.startInnings = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const { inningNumber, strikerId, nonStrikerId, bowlerId } = req.body;
    if (!inningNumber || !strikerId || !nonStrikerId || !bowlerId) {
      return res.status(400).json({ error: 'inningNumber, strikerId, nonStrikerId, bowlerId required' });
    }

    // Determine batting/bowling teams
    let battingTeam, bowlingTeam;
    if (inningNumber === 1) {
      if (match.toss.wonBy === 'teamA') {
        battingTeam = match.toss.chose === 'bat' ? 'teamA' : 'teamB';
      } else {
        battingTeam = match.toss.chose === 'bat' ? 'teamB' : 'teamA';
      }
      bowlingTeam = battingTeam === 'teamA' ? 'teamB' : 'teamA';
    } else {
      // 2nd innings — reverse
      const firstInnings = match.innings.find(i => i.inningNumber === 1);
      battingTeam = firstInnings.bowlingTeam;
      bowlingTeam = firstInnings.battingTeam;
    }

    const battingTeamData = match[battingTeam];
    const bowlingTeamData = match[bowlingTeam];

    const strikerPlayer = battingTeamData.players[parseInt(strikerId)];
    const nonStrikerPlayer = battingTeamData.players[parseInt(nonStrikerId)];
    const bowlerPlayer = bowlingTeamData.players[parseInt(bowlerId)];

    if (!strikerPlayer || !nonStrikerPlayer || !bowlerPlayer) {
      return res.status(400).json({ error: 'Invalid player indices' });
    }

    // Create innings
    const inningsData = {
      inningNumber,
      battingTeam,
      bowlingTeam,
      totalRuns: 0,
      totalWickets: 0,
      totalOvers: '0.0',
      totalBalls: 0,
      extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalties: 0 },
      batsmenStats: [
        {
          playerName: strikerPlayer.name,
          playerId: strikerId,
          runs: 0, ballsFaced: 0, fours: 0, sixes: 0, strikeRate: 0,
          isOut: false, dismissalType: 'not_out',
          battingOrder: 1
        },
        {
          playerName: nonStrikerPlayer.name,
          playerId: nonStrikerId,
          runs: 0, ballsFaced: 0, fours: 0, sixes: 0, strikeRate: 0,
          isOut: false, dismissalType: 'not_out',
          battingOrder: 2
        }
      ],
      bowlerStats: [
        {
          playerName: bowlerPlayer.name,
          playerId: bowlerId,
          oversBowled: 0, ballsBowled: 0, maidens: 0,
          runsConceded: 0, wickets: 0, noBalls: 0, wides: 0,
          economy: 0, bowlingOrder: 1
        }
      ],
      fallOfWickets: [],
      partnerships: [
        {
          wicketNumber: 0,
          batsman1Name: strikerPlayer.name,
          batsman2Name: nonStrikerPlayer.name,
          runs: 0,
          balls: 0
        }
      ],
      currentOverBalls: 0,
      currentOverRuns: 0,
      isCompleted: false
    };

    match.innings.push(inningsData);
    match.currentState = inningNumber === 1 ? 'innings_1' : 'innings_2';
    match.currentInning = inningNumber;
    match.currentStrikerId = strikerId;
    match.currentNonStrikerId = nonStrikerId;
    match.currentBowlerId = bowlerId;
    match.status = 'live';

    await match.save();

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      io.to(`cricket:${match._id}`).emit('cricket_innings_start', {
        matchId: match._id,
        inningNumber,
        battingTeam: battingTeamData.name,
        bowlingTeam: bowlingTeamData.name,
        timestamp: new Date()
      });
    }

    res.json(match);
  } catch (err) {
    console.error('startInnings error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Record a ball (the CORE endpoint)
// ============================================================
exports.recordBall = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (!match.currentState.startsWith('innings_')) {
      return res.status(400).json({ error: 'No active innings' });
    }

    const innings = match.innings.find(i => i.inningNumber === match.currentInning);
    if (!innings || innings.isCompleted) {
      return res.status(400).json({ error: 'Innings not found or completed' });
    }

    const {
      runsScored = 0,
      isWide = false,
      isNoBall = false,
      isBye = false,
      isLegBye = false,
      isWicket = false,
      wicketType = '',
      wicketBatsman = '',
      wicketFielder = '',
      newBatsmanId = ''
    } = req.body;

    const battingTeamData = match[innings.battingTeam];
    const bowlingTeamData = match[innings.bowlingTeam];

    // Current players
    const strikerStat = innings.batsmenStats.find(b => b.playerId === match.currentStrikerId && !b.isOut);
    const bowlerStat = innings.bowlerStats.find(b => b.playerId === match.currentBowlerId);
    
    // Allow recording all-out wickets without striker validation
    const isAllOutWicket = isWicket && !newBatsmanId;
    
    if (!isAllOutWicket && (!strikerStat || !bowlerStat)) {
      console.warn(`❌ Striker: ${strikerStat ? 'Found' : 'NOT FOUND'}, Bowler: ${bowlerStat ? 'Found' : 'NOT FOUND'}`);
      return res.status(400).json({ error: 'Current striker or bowler not found' });
    }
    
    // For all-out wickets, ensure we have at least the bowler
    if (isAllOutWicket && !bowlerStat) {
      console.warn('❌ All-out wicket but bowler not found');
      return res.status(400).json({ error: 'Bowler not found for all-out wicket' });
    }

    // For all-out situations, strikerStat is null - that's okay
    if (!strikerStat && !isAllOutWicket) {
      console.warn('❌ Striker not found and not an all-out wicket');
      return res.status(400).json({ error: 'Current striker not found' });
    }

    const strikerName = strikerStat?.playerName || 'Out Batsman';
    const nonStrikerStat = innings.batsmenStats.find(b => b.playerId === match.currentNonStrikerId && !b.isOut);
    const nonStrikerName = nonStrikerStat ? nonStrikerStat.playerName : '';

    // Calculate runs
    let totalRunsThisBall = 0;
    let extraRuns = 0;
    let isLegalDelivery = true;
    const isFour = runsScored === 4 && !isBye && !isLegBye;
    const isSix = runsScored === 6 && !isBye && !isLegBye;

    // For all-out wickets, skip normal ball processing - just record the dismissal
    if (!isAllOutWicket) {
      if (isWide) {
        extraRuns = 1 + runsScored;
        totalRunsThisBall = extraRuns;
        isLegalDelivery = false;
        innings.extras.wides += extraRuns;
        bowlerStat.wides += 1;
        bowlerStat.runsConceded += extraRuns;
      } else if (isNoBall) {
        extraRuns = 1;
        totalRunsThisBall = 1 + runsScored;
        isLegalDelivery = false;
        innings.extras.noBalls += 1;
        bowlerStat.noBalls += 1;
        bowlerStat.runsConceded += totalRunsThisBall;
        // Batsman gets runs on no-ball
        if (strikerStat) {
          strikerStat.runs += runsScored;
          strikerStat.ballsFaced += 1;
          if (isFour) strikerStat.fours += 1;
          if (isSix) strikerStat.sixes += 1;
        }
      } else if (isBye) {
        extraRuns = runsScored;
        totalRunsThisBall = runsScored;
        isLegalDelivery = true;
        innings.extras.byes += runsScored;
        if (strikerStat) strikerStat.ballsFaced += 1;
        bowlerStat.ballsBowled += 1;
      } else if (isLegBye) {
        extraRuns = runsScored;
        totalRunsThisBall = runsScored;
        isLegalDelivery = true;
        innings.extras.legByes += runsScored;
        if (strikerStat) strikerStat.ballsFaced += 1;
        bowlerStat.ballsBowled += 1;
      } else {
        // Normal delivery
        totalRunsThisBall = runsScored;
        if (strikerStat) {
          strikerStat.runs += runsScored;
          strikerStat.ballsFaced += 1;
          if (isFour) strikerStat.fours += 1;
          if (isSix) strikerStat.sixes += 1;
        }
        bowlerStat.runsConceded += runsScored;
        bowlerStat.ballsBowled += 1;
      }
    } else {
      // All-out wicket - just record it as a legal delivery for stats
      isLegalDelivery = true;
      console.log(`🚨 Recording final wicket for all-out: ${wicketBatsman}`);
    }

    // Update team total
    innings.totalRuns += totalRunsThisBall;
    innings.currentOverRuns += totalRunsThisBall;

    // Update legal ball count
    if (isLegalDelivery) {
      innings.totalBalls += 1;
      innings.currentOverBalls += 1;
    }
    innings.totalOvers = ballsToOvers(innings.totalBalls);

    // Update partnership
    const currentPartnership = innings.partnerships[innings.partnerships.length - 1];
    if (currentPartnership) {
      currentPartnership.runs += totalRunsThisBall;
      if (isLegalDelivery) currentPartnership.balls += 1;
    }

    // Handle wicket
    if (isWicket) {
      const outBatsmanName = wicketBatsman || strikerName;
      const outStat = innings.batsmenStats.find(b => b.playerName === outBatsmanName && !b.isOut);
      if (outStat) {
        outStat.isOut = true;
        outStat.dismissalType = wicketType || 'bowled';
        outStat.dismissalBowler = bowlerStat.playerName;
        outStat.dismissalFielder = wicketFielder || '';

        // Generate dismissal text
        switch (wicketType) {
          case 'bowled':
            outStat.dismissalText = `b ${bowlerStat.playerName}`;
            break;
          case 'caught':
            outStat.dismissalText = wicketFielder
              ? `c ${wicketFielder} b ${bowlerStat.playerName}`
              : `c & b ${bowlerStat.playerName}`;
            break;
          case 'run_out':
            outStat.dismissalText = wicketFielder
              ? `run out (${wicketFielder})`
              : 'run out';
            outStat.dismissalBowler = '';
            break;
          case 'stumped':
            outStat.dismissalText = `st ${wicketFielder || '?'} b ${bowlerStat.playerName}`;
            break;
          case 'lbw':
            outStat.dismissalText = `lbw b ${bowlerStat.playerName}`;
            break;
          case 'hit_wicket':
            outStat.dismissalText = `hit wicket b ${bowlerStat.playerName}`;
            break;
          default:
            outStat.dismissalText = wicketType || 'out';
        }

        // Update bowler wickets (exclude run outs)
        if (wicketType !== 'run_out') {
          bowlerStat.wickets += 1;
        }

        innings.totalWickets += 1;

        // Fall of wicket
        innings.fallOfWickets.push({
          wicketNumber: innings.totalWickets,
          score: innings.totalRuns,
          overNumber: innings.totalOvers,
          batsmanName: outBatsmanName,
          dismissalText: outStat.dismissalText
        });

        // Start new partnership if new batsman comes in
        if (newBatsmanId && innings.totalWickets < 10) {
          const newBatsmanPlayer = battingTeamData.players[parseInt(newBatsmanId)];
          if (newBatsmanPlayer) {
            const existingStat = innings.batsmenStats.find(b => b.playerName === newBatsmanPlayer.name);
            if (!existingStat) {
              innings.batsmenStats.push({
                playerName: newBatsmanPlayer.name,
                playerId: newBatsmanId,
                runs: 0, ballsFaced: 0, fours: 0, sixes: 0, strikeRate: 0,
                isOut: false, dismissalType: 'not_out',
                battingOrder: innings.batsmenStats.length + 1
              });
            }

            // Determine who stays at crease
            const remainingBatsman = outBatsmanName === strikerName
              ? match.currentNonStrikerId
              : match.currentStrikerId;

            const remainingBatsmanName = innings.batsmenStats.find(
              b => b.playerId === remainingBatsman && !b.isOut
            )?.playerName || '';

            // New partnership
            innings.partnerships.push({
              wicketNumber: innings.totalWickets,
              batsman1Name: remainingBatsmanName,
              batsman2Name: newBatsmanPlayer.name,
              runs: 0,
              balls: 0
            });

            // Update current batsman IDs
            if (outBatsmanName === strikerName) {
              match.currentStrikerId = newBatsmanId;
            } else {
              match.currentNonStrikerId = newBatsmanId;
            }
          }
        }
      }
    }

    // Rotate strike on odd runs (only for legal deliveries, non-wide)
    if (!isWide && isLegalDelivery && runsScored % 2 === 1) {
      const temp = match.currentStrikerId;
      match.currentStrikerId = match.currentNonStrikerId;
      match.currentNonStrikerId = temp;
    }

    // Update strike rates for all batsmen
    innings.batsmenStats.forEach(b => {
      b.strikeRate = strikeRate(b.runs, b.ballsFaced);
    });

    // Update bowler stats
    bowlerStat.oversBowled = parseFloat(ballsToOvers(bowlerStat.ballsBowled));
    bowlerStat.economy = economy(bowlerStat.runsConceded, bowlerStat.ballsBowled);

    // Check over completion (6 legal deliveries in this over)
    let overCompleted = false;
    if (innings.currentOverBalls >= 6) {
      overCompleted = true;
      // Check for maiden
      if (innings.currentOverRuns === 0) {
        bowlerStat.maidens += 1;
      }
      innings.currentOverBalls = 0;
      innings.currentOverRuns = 0;

      // Rotate strike at end of over
      const temp = match.currentStrikerId;
      match.currentStrikerId = match.currentNonStrikerId;
      match.currentNonStrikerId = temp;
    }

    // Check innings completion: all out or overs done
    const maxBalls = match.oversPerSide * 6;
    if (innings.totalWickets >= 10 || innings.totalBalls >= maxBalls) {
      innings.isCompleted = true;
      if (match.currentInning === 1) {
        match.currentState = 'innings_break';
      } else {
        match.currentState = 'completed';
        match.status = 'completed';
        // Determine winner
        const inn1 = match.innings.find(i => i.inningNumber === 1);
        const inn2 = match.innings.find(i => i.inningNumber === 2);
        if (inn1 && inn2) {
          if (inn2.totalRuns > inn1.totalRuns) {
            match.result.winner = inn2.battingTeam;
            match.result.winnerName = match[inn2.battingTeam].name;
            const wicketsLeft = 10 - inn2.totalWickets;
            match.result.resultText = `${match[inn2.battingTeam].name} won by ${wicketsLeft} wicket${wicketsLeft !== 1 ? 's' : ''}`;
          } else if (inn1.totalRuns > inn2.totalRuns) {
            match.result.winner = inn1.battingTeam;
            match.result.winnerName = match[inn1.battingTeam].name;
            const runDiff = inn1.totalRuns - inn2.totalRuns;
            match.result.resultText = `${match[inn1.battingTeam].name} won by ${runDiff} run${runDiff !== 1 ? 's' : ''}`;
          } else {
            match.result.winner = 'tie';
            match.result.resultText = 'Match tied!';
          }
        }
      }
    }

    // Check if 2nd innings team has chased the target
    if (match.currentInning === 2 && !innings.isCompleted) {
      const inn1 = match.innings.find(i => i.inningNumber === 1);
      if (inn1 && innings.totalRuns > inn1.totalRuns) {
        innings.isCompleted = true;
        match.currentState = 'completed';
        match.status = 'completed';
        match.result.winner = innings.battingTeam;
        match.result.winnerName = match[innings.battingTeam].name;
        const wicketsLeft = 10 - innings.totalWickets;
        match.result.resultText = `${match[innings.battingTeam].name} won by ${wicketsLeft} wicket${wicketsLeft !== 1 ? 's' : ''}`;
      }
    }

    await match.save();

    // Create delivery document
    const currentOver = Math.floor((innings.totalBalls - (isLegalDelivery ? 1 : 0)) / 6);
    const currentBall = isLegalDelivery ? innings.currentOverBalls || 6 : 0;
    const deliveryData = {
      matchId: match._id,
      inningNumber: match.currentInning,
      overNumber: currentOver,
      ballNumber: isLegalDelivery ? (overCompleted ? 6 : currentBall) : 0,
      batsmanName: strikerName,
      bowlerName: bowlerStat.playerName,
      nonStrikerName,
      runsScored,
      extraRuns,
      totalRuns: totalRunsThisBall,
      isWide,
      isNoBall,
      isBye,
      isLegBye,
      isFour: isFour && !isBye && !isLegBye,
      isSix: isSix && !isBye && !isLegBye,
      isWicket,
      wicketType: isWicket ? wicketType : '',
      wicketBatsman: isWicket ? (wicketBatsman || strikerName) : '',
      wicketFielder: isWicket ? wicketFielder : '',
      teamScore: innings.totalRuns,
      teamWickets: innings.totalWickets,
      oversSoFar: innings.totalOvers,
      commentary: generateCommentary({
        batsmanName: strikerName, bowlerName: bowlerStat.playerName,
        runsScored, isWide, isNoBall, isBye, isLegBye, isFour, isSix,
        isWicket, wicketType, wicketBatsman, extraRuns
      })
    };

    const delivery = new CricketDelivery(deliveryData);
    await delivery.save();

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      console.log(`🔔 Emitting cricket_ball_update to room cricket:${match._id}`);
      io.to(`cricket:${match._id}`).emit('cricket_ball_update', {
        matchId: match._id,
        delivery: deliveryData,
        matchSnapshot: {
          totalRuns: innings.totalRuns,
          totalWickets: innings.totalWickets,
          totalOvers: innings.totalOvers,
          currentStrikerId: match.currentStrikerId,
          currentNonStrikerId: match.currentNonStrikerId,
          currentBowlerId: match.currentBowlerId,
          overCompleted,
          inningsCompleted: innings.isCompleted,
          matchCompleted: match.status === 'completed',
          result: match.result
        },
        timestamp: new Date()
      });

      if (isWicket) {
        console.log(`🔔 Emitting cricket_wicket to room cricket:${match._id}`);
        io.to(`cricket:${match._id}`).emit('cricket_wicket', {
          matchId: match._id,
          wicketData: {
            batsmanName: wicketBatsman || strikerName,
            bowlerName: bowlerStat.playerName,
            wicketType,
            fielder: wicketFielder,
            score: `${innings.totalRuns}/${innings.totalWickets}`,
            over: innings.totalOvers
          },
          timestamp: new Date()
        });
      }

      if (overCompleted) {
        console.log(`🔔 Emitting cricket_over_complete to room cricket:${match._id}`);
        io.to(`cricket:${match._id}`).emit('cricket_over_complete', {
          matchId: match._id,
          overSummary: {
            overNumber: currentOver + 1,
            bowlerName: bowlerStat.playerName,
            runs: innings.currentOverRuns === 0 ? deliveryData.totalRuns : 0, // maiden check happened above
            isMaiden: innings.currentOverRuns === 0
          },
          timestamp: new Date()
        });
      }

      if (match.status === 'completed') {
        console.log(`🔔 Emitting cricket_match_end to room cricket:${match._id}`);
        io.to(`cricket:${match._id}`).emit('cricket_match_end', {
          matchId: match._id,
          result: match.result,
          timestamp: new Date()
        });
      }
    } else {
      console.warn('⚠️ Socket.IO instance not found on req.app');
    }

    res.json({ match, delivery: deliveryData });
  } catch (err) {
    console.error('recordBall error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: End over & select new bowler
// ============================================================
exports.endOver = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const { newBowlerId } = req.body;
    if (!newBowlerId) return res.status(400).json({ error: 'newBowlerId required' });

    const innings = match.innings.find(i => i.inningNumber === match.currentInning);
    if (!innings) return res.status(400).json({ error: 'No active innings' });

    const bowlingTeamData = match[innings.bowlingTeam];
    const bowlerPlayer = bowlingTeamData.players[parseInt(newBowlerId)];
    if (!bowlerPlayer) return res.status(400).json({ error: 'Invalid bowler index' });

    // Check if this bowler already exists in stats
    let bowlerStat = innings.bowlerStats.find(b => b.playerId === newBowlerId);
    if (!bowlerStat) {
      bowlerStat = {
        playerName: bowlerPlayer.name,
        playerId: newBowlerId,
        oversBowled: 0, ballsBowled: 0, maidens: 0,
        runsConceded: 0, wickets: 0, noBalls: 0, wides: 0,
        economy: 0, bowlingOrder: innings.bowlerStats.length + 1
      };
      innings.bowlerStats.push(bowlerStat);
    }

    match.currentBowlerId = newBowlerId;
    await match.save();

    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Undo last delivery
// ============================================================
exports.undoLastBall = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Find and delete the last delivery
    const lastDelivery = await CricketDelivery.findOne({
      matchId: match._id,
      inningNumber: match.currentInning
    }).sort({ timestamp: -1 });

    if (!lastDelivery) return res.status(400).json({ error: 'No deliveries to undo' });

    // Delete the delivery
    await CricketDelivery.deleteOne({ _id: lastDelivery._id });

    // Rebuild innings from remaining deliveries
    const allDeliveries = await CricketDelivery.find({
      matchId: match._id,
      inningNumber: match.currentInning
    }).sort({ timestamp: 1 });

    const innings = match.innings.find(i => i.inningNumber === match.currentInning);
    if (!innings) return res.status(400).json({ error: 'No active innings' });

    // Reset innings stats
    innings.totalRuns = 0;
    innings.totalWickets = 0;
    innings.totalBalls = 0;
    innings.extras = { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalties: 0 };
    innings.batsmenStats.forEach(b => {
      b.runs = 0; b.ballsFaced = 0; b.fours = 0; b.sixes = 0;
      b.strikeRate = 0; b.isOut = false; b.dismissalType = 'not_out';
      b.dismissalBowler = ''; b.dismissalFielder = ''; b.dismissalText = '';
    });
    innings.bowlerStats.forEach(b => {
      b.oversBowled = 0; b.ballsBowled = 0; b.maidens = 0;
      b.runsConceded = 0; b.wickets = 0; b.noBalls = 0; b.wides = 0; b.economy = 0;
    });
    innings.fallOfWickets = [];
    innings.isCompleted = false;

    // Replay all remaining deliveries to rebuild state
    // For simplicity, just use the cumulative snapshot from the last remaining delivery
    if (allDeliveries.length > 0) {
      const lastRemaining = allDeliveries[allDeliveries.length - 1];
      innings.totalRuns = lastRemaining.teamScore;
      innings.totalWickets = lastRemaining.teamWickets;
      innings.totalOvers = lastRemaining.oversSoFar;
      innings.totalBalls = parseInt(lastRemaining.oversSoFar) * 6 + parseInt(lastRemaining.oversSoFar.split('.')[1] || 0);
    } else {
      innings.totalOvers = '0.0';
    }

    // Reset match state if it was completed
    if (match.status === 'completed') {
      match.status = 'live';
      match.currentState = match.currentInning === 1 ? 'innings_1' : 'innings_2';
      match.result = { winner: '', winnerName: '', resultText: '', manOfTheMatch: '' };
    }

    await match.save();

    // Emit undo event
    const io = req.app.get('io');
    if (io) {
      io.to(`cricket:${match._id}`).emit('cricket_undo', {
        matchId: match._id,
        timestamp: new Date()
      });
    }

    res.json({ match, undoneDelivery: lastDelivery });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: End innings
// ============================================================
exports.endInnings = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const innings = match.innings.find(i => i.inningNumber === match.currentInning);
    if (!innings) return res.status(400).json({ error: 'No active innings' });

    innings.isCompleted = true;

    if (match.currentInning === 1) {
      match.currentState = 'innings_break';
    } else {
      match.currentState = 'completed';
      match.status = 'completed';
      // Determine winner
      const inn1 = match.innings.find(i => i.inningNumber === 1);
      if (inn1) {
        if (innings.totalRuns > inn1.totalRuns) {
          match.result.winner = innings.battingTeam;
          match.result.winnerName = match[innings.battingTeam].name;
          const wkts = 10 - innings.totalWickets;
          match.result.resultText = `${match[innings.battingTeam].name} won by ${wkts} wicket${wkts !== 1 ? 's' : ''}`;
        } else if (inn1.totalRuns > innings.totalRuns) {
          match.result.winner = inn1.battingTeam;
          match.result.winnerName = match[inn1.battingTeam].name;
          const runDiff = inn1.totalRuns - innings.totalRuns;
          match.result.resultText = `${match[inn1.battingTeam].name} won by ${runDiff} run${runDiff !== 1 ? 's' : ''}`;
        } else {
          match.result.winner = 'tie';
          match.result.resultText = 'Match tied!';
        }
      }
    }

    match.currentStrikerId = '';
    match.currentNonStrikerId = '';
    match.currentBowlerId = '';

    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.to(`cricket:${match._id}`).emit('cricket_innings_end', {
        matchId: match._id,
        inningNumber: match.currentInning,
        totalRuns: innings.totalRuns,
        totalWickets: innings.totalWickets,
        totalOvers: innings.totalOvers,
        timestamp: new Date()
      });
    }

    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Complete match & set Man of the Match
// ============================================================
exports.completeMatch = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Auto-calculate Man of the Match based on best performance
    let bestBatsman = null;
    let bestBowler = null;
    let maxRuns = -1;
    let maxWickets = -1;
    let bestEconomy = 999;

    // Find best batsman from all innings
    match.innings.forEach(inn => {
      if (inn.batsmenStats) {
        inn.batsmenStats.forEach(batsman => {
          if (batsman.runs > maxRuns) {
            maxRuns = batsman.runs;
            bestBatsman = batsman.playerName;
          }
        });
      }
    });

    // Find best bowler from all innings (most wickets, then best economy)
    match.innings.forEach(inn => {
      if (inn.bowlerStats) {
        inn.bowlerStats.forEach(bowler => {
          if (bowler.wickets > maxWickets || (bowler.wickets === maxWickets && bowler.economy < bestEconomy)) {
            maxWickets = bowler.wickets;
            bestEconomy = bowler.economy;
            bestBowler = bowler.playerName;
          }
        });
      }
    });

    // Determine Man of the Match: Prefer batsman if good score, else bowler
    let manOfTheMatch = '';
    if (bestBatsman && maxRuns >= 30) {
      manOfTheMatch = bestBatsman;
    } else if (bestBowler && maxWickets >= 2) {
      manOfTheMatch = bestBowler;
    } else if (bestBatsman) {
      manOfTheMatch = bestBatsman;
    } else if (bestBowler) {
      manOfTheMatch = bestBowler;
    }

    match.result = {
      winner: match.result?.winner || '',
      winnerName: match.result?.winnerName || '',
      resultText: match.result?.resultText || '',
      manOfTheMatch: manOfTheMatch || 'N/A',
      bestBatsman: bestBatsman || 'N/A',
      bestBowler: bestBowler || 'N/A',
      bestBatsmanRuns: maxRuns,
      bestBowlerWickets: maxWickets
    };

    match.currentState = 'completed';
    match.status = 'completed';
    await match.save();

    const io = req.app.get('io');
    if (io) {
      console.log(`🏆 Emitting cricket_match_end with MoM: ${manOfTheMatch}`);
      io.to(`cricket:${match._id}`).emit('cricket_match_end', {
        matchId: match._id,
        result: match.result,
        timestamp: new Date()
      });
    }

    res.json(match);
  } catch (err) {
    console.error('completeMatch error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Delete a match
// ============================================================
exports.deleteMatch = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    await CricketDelivery.deleteMany({ matchId: match._id });
    await CricketMatch.deleteOne({ _id: match._id });

    res.json({ message: 'Match deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// PUBLIC: List all cricket matches
// ============================================================
exports.listMatches = async (req, res) => {
  try {
    const { status, eventId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (eventId) filter.eventId = eventId;

    const matches = await CricketMatch.find(filter)
      .populate('eventId', 'title type date')
      .sort({ matchDate: -1 })
      .lean();

    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// PUBLIC: Get match detail
// ============================================================
exports.getMatch = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id)
      .populate('eventId', 'title type date')
      .lean();
    if (!match) return res.status(404).json({ error: 'Match not found' });
    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// PUBLIC: Get formatted scorecard
// ============================================================
exports.getScorecard = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id)
      .populate('eventId', 'title type date')
      .lean();
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const scorecard = match.innings.map(inn => {
      const battingTeamName = match[inn.battingTeam]?.name || inn.battingTeam;
      const bowlingTeamName = match[inn.bowlingTeam]?.name || inn.bowlingTeam;
      const totalExtras = (inn.extras?.wides || 0) + (inn.extras?.noBalls || 0) +
        (inn.extras?.byes || 0) + (inn.extras?.legByes || 0) + (inn.extras?.penalties || 0);

      return {
        inningNumber: inn.inningNumber,
        battingTeamName,
        bowlingTeamName,
        totalRuns: inn.totalRuns,
        totalWickets: inn.totalWickets,
        totalOvers: inn.totalOvers,
        extras: inn.extras,
        totalExtras,
        runRate: inn.totalBalls > 0 ? parseFloat(((inn.totalRuns / inn.totalBalls) * 6).toFixed(2)) : 0,
        batting: (inn.batsmenStats || []).map(b => ({
          name: b.playerName,
          runs: b.runs,
          balls: b.ballsFaced,
          fours: b.fours,
          sixes: b.sixes,
          sr: b.strikeRate,
          isOut: b.isOut,
          howOut: b.isOut ? b.dismissalText : 'not out',
          dismissalType: b.dismissalType
        })),
        bowling: (inn.bowlerStats || []).map(b => ({
          name: b.playerName,
          overs: b.oversBowled,
          maidens: b.maidens,
          runs: b.runsConceded,
          wickets: b.wickets,
          noBalls: b.noBalls,
          wides: b.wides,
          economy: b.economy
        })),
        fallOfWickets: inn.fallOfWickets || [],
        partnerships: inn.partnerships || []
      };
    });

    res.json({
      matchId: match._id,
      teamA: match.teamA?.name,
      teamB: match.teamB?.name,
      status: match.status,
      result: match.result,
      toss: match.toss,
      oversPerSide: match.oversPerSide,
      scorecard
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// PUBLIC: Get deliveries (ball-by-ball)
// ============================================================
exports.getDeliveries = async (req, res) => {
  try {
    const { inning } = req.query;
    const filter = { matchId: req.params.id };
    if (inning) filter.inningNumber = parseInt(inning);

    const deliveries = await CricketDelivery.find(filter)
      .sort({ timestamp: 1 })
      .lean();

    res.json(deliveries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// PUBLIC: Get live matches
// ============================================================
exports.getLiveMatches = async (req, res) => {
  try {
    const matches = await CricketMatch.find({ status: 'live' })
      .populate('eventId', 'title type')
      .lean();

    const summaries = matches.map(m => {
      const currentInnings = m.innings.find(i => i.inningNumber === m.currentInning);
      const battingTeamName = currentInnings ? m[currentInnings.battingTeam]?.name : '';
      return {
        _id: m._id,
        eventTitle: m.eventId?.title || 'Cricket',
        teamA: m.teamA?.name,
        teamB: m.teamB?.name,
        currentBattingTeam: battingTeamName,
        score: currentInnings ? `${currentInnings.totalRuns}/${currentInnings.totalWickets}` : '0/0',
        overs: currentInnings?.totalOvers || '0.0',
        currentInning: m.currentInning,
        status: m.status
      };
    });

    res.json(summaries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Create cricket matches from tournament fixtures
// ============================================================
exports.createFromTournament = async (req, res) => {
  try {
    const { tournamentId } = req.body;
    if (!tournamentId) {
      return res.status(400).json({ error: 'Tournament ID is required' });
    }

    const { Tournament, TournamentMatch, Application, Event, CricketMatch } = require('../models');

    const tournament = await Tournament.findById(tournamentId).populate('eventId');
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const event = tournament.eventId;
    if (!event || event.sportType !== 'cricket') {
      return res.status(400).json({ error: 'This tournament is not a cricket event' });
    }

    // Get all tournament matches
    const tournamentMatches = await TournamentMatch.find({ tournamentId }).sort({ round: 1, matchNumber: 1 });

    if (tournamentMatches.length === 0) {
      return res.status(400).json({ error: 'No matches in this tournament' });
    }

    // Check if cricket matches already exist for this tournament
    const existingCricketMatches = await CricketMatch.find({ tournamentId });
    if (existingCricketMatches.length > 0) {
      return res.status(400).json({ error: 'Cricket matches already created for this tournament. Delete them first to regenerate.' });
    }

    const createdMatches = [];

    for (const tMatch of tournamentMatches) {
      // Skip if both teams aren't set (e.g., awaiting results)
      if (!tMatch.participant1 || !tMatch.participant2 || tMatch.participant1 === 'BYE' || tMatch.participant2 === 'BYE') {
        console.log(`⏭️  Skipping tournament match ${tMatch._id} - teams not yet determined`);
        continue;
      }

      try {
        // Fetch application data for both participants to get squad info
        const app1 = tMatch.participant1Id ? await Application.findById(tMatch.participant1Id) : null;
        const app2 = tMatch.participant2Id ? await Application.findById(tMatch.participant2Id) : null;

        // Build player lists from applications or use default
        const buildPlayerList = (app, teamName) => {
          if (!app || !app.players || app.players.length === 0) {
            // Create default player list if no applications
            return [
              { name: 'Player 1', uucms: '', department: '', role: 'batsman', isCaptain: true, isViceCaptain: false, isPlaying: true },
              { name: 'Player 2', uucms: '', department: '', role: 'batsman', isCaptain: false, isViceCaptain: true, isPlaying: true },
              { name: 'Player 3', uucms: '', department: '', role: 'batsman', isCaptain: false, isViceCaptain: false, isPlaying: true },
              { name: 'Player 4', uucms: '', department: '', role: 'batsman', isCaptain: false, isViceCaptain: false, isPlaying: true },
              { name: 'Player 5', uucms: '', department: '', role: 'bowler', isCaptain: false, isViceCaptain: false, isPlaying: true },
              { name: 'Player 6', uucms: '', department: '', role: 'bowler', isCaptain: false, isViceCaptain: false, isPlaying: true },
              { name: 'Player 7', uucms: '', department: '', role: 'bowler', isCaptain: false, isViceCaptain: false, isPlaying: true },
              { name: 'Player 8', uucms: '', department: '', role: 'bowler', isCaptain: false, isViceCaptain: false, isPlaying: true },
              { name: 'Player 9', uucms: '', department: '', role: 'batsman', isCaptain: false, isViceCaptain: false, isPlaying: true },
              { name: 'Player 10', uucms: '', department: '', role: 'batsman', isCaptain: false, isViceCaptain: false, isPlaying: true },
              { name: 'Player 11', uucms: '', department: '', role: 'all_rounder', isCaptain: false, isViceCaptain: false, isPlaying: true }
            ];
          }

          // Use actual players from application
          const mainPlayers = app.players.filter(p => !p.isSubstitute && p.name).slice(0, 11);
          return mainPlayers.map((p, idx) => ({
            name: p.name || `Player ${idx + 1}`,
            uucms: p.uucms || '',
            department: p.department || '',
            role: p.role || 'batsman',
            isCaptain: idx === 0,
            isViceCaptain: idx === 1,
            isPlaying: true
          }));
        };

        const teamAPlayers = buildPlayerList(app1, tMatch.participant1);
        const teamBPlayers = buildPlayerList(app2, tMatch.participant2);

        // Create cricket match
        const cricketMatch = new CricketMatch({
          eventId: event._id,
          tournamentId: tournament._id,
          tournamentMatchId: tMatch._id,
          teamA: {
            name: tMatch.participant1,
            applicationId: tMatch.participant1Id || null,
            players: teamAPlayers
          },
          teamB: {
            name: tMatch.participant2,
            applicationId: tMatch.participant2Id || null,
            players: teamBPlayers
          },
          oversPerSide: event.cricketOvers || 20,
          venue: event.venue || '',
          matchDate: tMatch.scheduledTime ? new Date(tMatch.scheduledTime) : new Date(),
          currentState: 'not_started',
          status: 'upcoming'
        });

        await cricketMatch.save();
        createdMatches.push({
          _id: cricketMatch._id,
          teamA: cricketMatch.teamA.name,
          teamB: cricketMatch.teamB.name,
          tournamentRound: tMatch.round,
          matchNumber: tMatch.matchNumber
        });

        console.log(`✅ Created cricket match from tournament: ${tMatch.participant1} vs ${tMatch.participant2}`);
      } catch (matchError) {
        console.error(`❌ Error creating cricket match from tournament match ${tMatch._id}:`, matchError.message);
        console.error(`   Details: Participant1=${tMatch.participant1}, Participant2=${tMatch.participant2}`);
        console.error(`   Stack: ${matchError.stack}`);
      }
    }

    if (createdMatches.length === 0) {
      return res.status(400).json({ error: 'No cricket matches could be created. Check that all tournament fixtures have participants assigned.' });
    }

    res.status(201).json({
      message: `${createdMatches.length} cricket match${createdMatches.length !== 1 ? 'es' : ''} created from tournament fixtures`,
      createdMatches,
      tournamentId
    });
  } catch (err) {
    console.error('createFromTournament error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      error: 'Failed to generate cricket matches: ' + err.message,
      details: err.stack 
    });
  }
};
