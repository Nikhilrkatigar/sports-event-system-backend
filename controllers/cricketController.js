const { CricketMatch, CricketDelivery, Tournament, TournamentMatch, Application, Event } = require('../models');
const { emitTournamentMatchUpdate } = require('../utils/socket');

// ============================================================
// Helper utilities
// ============================================================

/** Convert totalBalls to overs display string, e.g. 16 balls at 6-per-over → "2.4" */
function ballsToOvers(balls) {
  const overs = Math.floor(balls / 6);
  const remainder = balls % 6;
  return `${overs}.${remainder}`;
}

const WIDE_WICKET_TYPES = new Set(['run_out', 'stumped', 'hit_wicket', 'obstructing_field']);
const FREE_HIT_WICKET_TYPES = new Set(['run_out', 'obstructing_field']);

function getMaxBowlerOvers(match) {
  const oversPerSide = Number(match?.oversPerSide || 20);
  return Math.max(1, Math.ceil(oversPerSide / 5));
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

function countsAsTeamWicket(wicketType) {
  return wicketType !== 'retired_hurt';
}

function countsAsBowlerWicket(wicketType) {
  return !['run_out', 'retired_hurt', 'retired_out', 'obstructing_field'].includes(wicketType);
}

function dismissalTextForWicket(wicketType, bowlerName, wicketFielder) {
  switch (wicketType) {
    case 'bowled':
      return `b ${bowlerName}`;
    case 'caught':
      return wicketFielder
        ? `c ${wicketFielder} b ${bowlerName}`
        : `c & b ${bowlerName}`;
    case 'run_out':
      return wicketFielder
        ? `run out (${wicketFielder})`
        : 'run out';
    case 'stumped':
      return `st ${wicketFielder || '?'} b ${bowlerName}`;
    case 'lbw':
      return `lbw b ${bowlerName}`;
    case 'hit_wicket':
      return `hit wicket b ${bowlerName}`;
    case 'obstructing_field':
      return 'obstructing the field';
    case 'retired_hurt':
      return 'retired hurt';
    case 'retired_out':
      return 'retired out';
    default:
      return wicketType || 'out';
  }
}

function createBatsmanStat({ playerName, playerId = '', battingOrder = 0 }) {
  return {
    playerName,
    playerId,
    runs: 0,
    ballsFaced: 0,
    fours: 0,
    sixes: 0,
    strikeRate: 0,
    isOut: false,
    dismissalType: 'not_out',
    dismissalBowler: '',
    dismissalFielder: '',
    dismissalText: '',
    battingOrder
  };
}

function createBowlerStat({ playerName, playerId = '', bowlingOrder = 0 }) {
  return {
    playerName,
    playerId,
    oversBowled: 0,
    ballsBowled: 0,
    maidens: 0,
    runsConceded: 0,
    wickets: 0,
    noBalls: 0,
    wides: 0,
    economy: 0,
    bowlingOrder
  };
}

function resolvePlayerIdentity(teamData, playerId, playerName) {
  if (playerId !== undefined && playerId !== null && playerId !== '') {
    const teamPlayer = teamData?.players?.[parseInt(playerId, 10)];
    return {
      playerId: String(playerId),
      playerName: teamPlayer?.name || playerName || ''
    };
  }

  if (!playerName) {
    return { playerId: '', playerName: '' };
  }

  const resolvedIndex = teamData?.players?.findIndex((player) => player?.name === playerName);
  return {
    playerId: resolvedIndex >= 0 ? String(resolvedIndex) : '',
    playerName
  };
}

function ensureBatsmanStat(innings, teamData, playerRef) {
  const identity = resolvePlayerIdentity(teamData, playerRef?.playerId, playerRef?.playerName);
  if (!identity.playerName) return null;

  let stat = innings.batsmenStats.find((b) =>
    (identity.playerId && b.playerId === identity.playerId) || b.playerName === identity.playerName
  );

  if (!stat) {
    stat = createBatsmanStat({
      playerName: identity.playerName,
      playerId: identity.playerId,
      battingOrder: innings.batsmenStats.length + 1
    });
    innings.batsmenStats.push(stat);
  }

  return stat;
}

function ensureBowlerStat(innings, teamData, playerRef) {
  const identity = resolvePlayerIdentity(teamData, playerRef?.playerId, playerRef?.playerName);
  if (!identity.playerName) return null;

  let stat = innings.bowlerStats.find((b) =>
    (identity.playerId && b.playerId === identity.playerId) || b.playerName === identity.playerName
  );

  if (!stat) {
    stat = createBowlerStat({
      playerName: identity.playerName,
      playerId: identity.playerId,
      bowlingOrder: innings.bowlerStats.length + 1
    });
    innings.bowlerStats.push(stat);
  }

  return stat;
}

function swapCurrentBatsmen(match) {
  const temp = match.currentStrikerId;
  match.currentStrikerId = match.currentNonStrikerId;
  match.currentNonStrikerId = temp;
}

function rebuildInningsFromDeliveries(match, innings, deliveries) {
  const battingTeamData = match[innings.battingTeam];
  const bowlingTeamData = match[innings.bowlingTeam];
  const openingBatsmen = [...(innings.batsmenStats || [])]
    .sort((a, b) => (a.battingOrder || 0) - (b.battingOrder || 0))
    .slice(0, 2);
  const openingBowler = innings.bowlerStats?.[0] || null;

  innings.totalRuns = 0;
  innings.totalWickets = 0;
  innings.totalBalls = 0;
  innings.totalOvers = '0.0';
  innings.currentOverBalls = 0;
  innings.currentOverRuns = 0;
  innings.extras = { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalties: 0 };
  innings.fallOfWickets = [];
  innings.partnerships = [{
    wicketNumber: 0,
    batsman1Name: openingBatsmen[0]?.playerName || '',
    batsman2Name: openingBatsmen[1]?.playerName || '',
    runs: 0,
    balls: 0
  }];
  innings.batsmenStats = openingBatsmen.map((b, index) => createBatsmanStat({
    playerName: b.playerName,
    playerId: b.playerId,
    battingOrder: index + 1
  }));
  innings.bowlerStats = openingBowler
    ? [createBowlerStat({
        playerName: openingBowler.playerName,
        playerId: openingBowler.playerId,
        bowlingOrder: 1
      })]
    : [];
  innings.isCompleted = false;
  match.lastCompletedOverBowlerId = '';
  match.isNextBallFreeHit = false;

  match.currentStrikerId = openingBatsmen[0]?.playerId || '';
  match.currentNonStrikerId = openingBatsmen[1]?.playerId || '';
  match.currentBowlerId = openingBowler?.playerId || '';

  for (const delivery of deliveries) {
    const strikerStat = ensureBatsmanStat(innings, battingTeamData, { playerName: delivery.batsmanName });
    const nonStrikerStat = ensureBatsmanStat(innings, battingTeamData, { playerName: delivery.nonStrikerName });
    const bowlerStat = ensureBowlerStat(innings, bowlingTeamData, { playerName: delivery.bowlerName });
    const totalRunsThisBall = Number(delivery.totalRuns || 0);
    const batterRuns = Number(delivery.runsScored || 0);
    const isLegalDelivery = !delivery.isWide && !delivery.isNoBall;
    const isPenaltyDelivery = Boolean(delivery.isPenalty) || Number(delivery.penaltyRuns || 0) > 0;

    if (strikerStat?.playerId) match.currentStrikerId = strikerStat.playerId;
    if (nonStrikerStat?.playerId) match.currentNonStrikerId = nonStrikerStat.playerId;
    if (bowlerStat?.playerId) match.currentBowlerId = bowlerStat.playerId;

    if (strikerStat && strikerStat.isOut && strikerStat.dismissalType === 'retired_hurt') {
      strikerStat.isOut = false;
      strikerStat.dismissalType = 'not_out';
      strikerStat.dismissalBowler = '';
      strikerStat.dismissalFielder = '';
      strikerStat.dismissalText = '';
    }
    if (nonStrikerStat && nonStrikerStat.isOut && nonStrikerStat.dismissalType === 'retired_hurt') {
      nonStrikerStat.isOut = false;
      nonStrikerStat.dismissalType = 'not_out';
      nonStrikerStat.dismissalBowler = '';
      nonStrikerStat.dismissalFielder = '';
      nonStrikerStat.dismissalText = '';
    }

    if (strikerStat) {
      if (!delivery.isWide && !delivery.isBye && !delivery.isLegBye && !isPenaltyDelivery) {
        strikerStat.runs += batterRuns;
        if (delivery.isFour) strikerStat.fours += 1;
        if (delivery.isSix) strikerStat.sixes += 1;
      }
      if (!delivery.isWide && !delivery.isNoBall) {
        strikerStat.ballsFaced += 1;
      }
    }

    if (bowlerStat) {
      if (isLegalDelivery) {
        bowlerStat.ballsBowled += 1;
      }
      if (delivery.isWide) bowlerStat.wides += 1;
      if (delivery.isNoBall) bowlerStat.noBalls += 1;
      if (!delivery.isBye && !delivery.isLegBye && !isPenaltyDelivery) {
        bowlerStat.runsConceded += totalRunsThisBall;
      }
    }

    if (delivery.isWide) innings.extras.wides += totalRunsThisBall || 1;
    else if (delivery.isNoBall) innings.extras.noBalls += 1;
    else if (delivery.isBye) innings.extras.byes += totalRunsThisBall;
    else if (delivery.isLegBye) innings.extras.legByes += totalRunsThisBall;
    else if (isPenaltyDelivery) innings.extras.penalties += totalRunsThisBall;

    if (delivery.isNoBall) {
      match.isNextBallFreeHit = true;
    } else if (isLegalDelivery && !delivery.isWide) {
      match.isNextBallFreeHit = false;
    }

    innings.totalRuns += totalRunsThisBall;
    innings.currentOverRuns += totalRunsThisBall;

    if (isLegalDelivery) {
      innings.totalBalls += 1;
      innings.currentOverBalls += 1;
    }
    innings.totalOvers = ballsToOvers(innings.totalBalls);

    const currentPartnership = innings.partnerships[innings.partnerships.length - 1];
    if (currentPartnership) {
      currentPartnership.runs += totalRunsThisBall;
      if (isLegalDelivery) currentPartnership.balls += 1;
    }

    if (delivery.isWicket && bowlerStat) {
      const outBatsmanName = delivery.wicketBatsman || delivery.batsmanName;
      const outStat = ensureBatsmanStat(innings, battingTeamData, { playerName: outBatsmanName });
      const dismissalType = delivery.wicketType || 'bowled';

      if (outStat) {
        outStat.isOut = true;
        outStat.dismissalType = dismissalType;
        outStat.dismissalBowler = countsAsBowlerWicket(dismissalType) ? bowlerStat.playerName : '';
        outStat.dismissalFielder = delivery.wicketFielder || '';
        outStat.dismissalText = dismissalTextForWicket(dismissalType, bowlerStat.playerName, delivery.wicketFielder);
      }

      if (countsAsBowlerWicket(dismissalType)) {
        bowlerStat.wickets += 1;
      }

      if (countsAsTeamWicket(dismissalType)) {
        innings.totalWickets += 1;
        innings.fallOfWickets.push({
          wicketNumber: innings.totalWickets,
          score: innings.totalRuns,
          overNumber: innings.totalOvers,
          batsmanName: outBatsmanName,
          dismissalText: outStat?.dismissalText || dismissalType
        });
      }

      if (delivery.newBatsmanId || delivery.newBatsmanName) {
        const newBatsmanStat = ensureBatsmanStat(innings, battingTeamData, {
          playerId: delivery.newBatsmanId,
          playerName: delivery.newBatsmanName
        });
        
        if (newBatsmanStat && newBatsmanStat.isOut && newBatsmanStat.dismissalType === 'retired_hurt') {
          newBatsmanStat.isOut = false;
          newBatsmanStat.dismissalType = 'not_out';
          newBatsmanStat.dismissalBowler = '';
          newBatsmanStat.dismissalFielder = '';
          newBatsmanStat.dismissalText = '';
        }

        const outWasStriker = outStat?.playerId && outStat.playerId === strikerStat?.playerId;
        const remainingBatsmanName = outWasStriker ? nonStrikerStat?.playerName : strikerStat?.playerName;

        innings.partnerships.push({
          wicketNumber: innings.totalWickets,
          batsman1Name: remainingBatsmanName || '',
          batsman2Name: newBatsmanStat?.playerName || '',
          runs: 0,
          balls: 0
        });

        if (outWasStriker) {
          match.currentStrikerId = newBatsmanStat?.playerId || '';
        } else {
          match.currentNonStrikerId = newBatsmanStat?.playerId || '';
        }
      }
    }

    const wicketWithNewBatsman = delivery.isWicket && (delivery.newBatsmanId || delivery.newBatsmanName);
    if (!delivery.isWide && batterRuns % 2 === 1 && !wicketWithNewBatsman) {
      swapCurrentBatsmen(match);
    }

    if (bowlerStat) {
      bowlerStat.oversBowled = parseFloat(ballsToOvers(bowlerStat.ballsBowled));
      bowlerStat.economy = economy(bowlerStat.runsConceded, bowlerStat.ballsBowled);
    }

    if (innings.currentOverBalls >= 6) {
      if (bowlerStat && innings.currentOverRuns === 0) {
        bowlerStat.maidens += 1;
      }
      innings.currentOverBalls = 0;
      innings.currentOverRuns = 0;
      match.lastCompletedOverBowlerId = bowlerStat?.playerId || match.lastCompletedOverBowlerId;
      match.currentBowlerId = '';
      swapCurrentBatsmen(match);
    }
  }

  innings.batsmenStats.forEach((b) => {
    b.strikeRate = strikeRate(b.runs, b.ballsFaced);
  });
}

/** Generate a short commentary string for a delivery */
function generateCommentary(data) {
  const { batsmanName, bowlerName, runsScored, isWide, isNoBall, isBye, isLegBye, isOverthrow, isPenalty, penaltyRuns, isFour, isSix, isWicket, wicketType, wicketBatsman, overthrowBaseRuns, overthrowRuns } = data;
  if (isWicket) {
    const howOut = wicketType.replace('_', ' ').toUpperCase();
    return `OUT! ${wicketBatsman || batsmanName} is ${howOut}! ${bowlerName} strikes.`;
  }
  if (isPenalty) {
    const awardedPenaltyRuns = penaltyRuns || runsScored || 0;
    return `Penalty runs awarded: ${awardedPenaltyRuns} run${awardedPenaltyRuns !== 1 ? 's' : ''}.`;
  }
  if (isOverthrow) {
    if (overthrowRuns > 0) {
      return `OVERTHROW! ${overthrowBaseRuns}+${overthrowRuns} run${runsScored !== 1 ? 's' : ''} taken.`;
    }
    return `OVERTHROW! ${runsScored} run${runsScored !== 1 ? 's' : ''} off the fielding error!`;
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

/**
 * Advance a completed single-elimination tournament winner to the next round.
 * Mirrors tournament route progression so cricket scoring can keep brackets in sync.
 */
async function advanceTournamentWinner(tournamentMatch) {
  if (!tournamentMatch?.winner) return;

  const tournament = await Tournament.findById(tournamentMatch.tournamentId);
  if (!tournament || tournament.format !== 'single_elimination') return;

  const nextRound = tournamentMatch.round + 1;
  const nextMatchNumber = Math.ceil(tournamentMatch.matchNumber / 2);
  const nextMatch = await TournamentMatch.findOne({
    tournamentId: tournamentMatch.tournamentId,
    round: nextRound,
    matchNumber: nextMatchNumber
  });

  if (!nextMatch) return;

  if (tournamentMatch.matchNumber % 2 === 1) {
    nextMatch.participant1Id = tournamentMatch.winnerId;
    nextMatch.participant1 = tournamentMatch.winner;
    nextMatch.participant1Uucms = tournamentMatch.winnerUucms || '';
  } else {
    nextMatch.participant2Id = tournamentMatch.winnerId;
    nextMatch.participant2 = tournamentMatch.winner;
    nextMatch.participant2Uucms = tournamentMatch.winnerUucms || '';
  }

  nextMatch.updatedAt = new Date();
  await nextMatch.save();

  if (nextMatch.participant1 === 'BYE' || nextMatch.participant2 === 'BYE') {
    await resolveTournamentByeMatch(nextMatch);
  }
}

/**
 * Resolve BYE matches so winners auto-advance without manual intervention.
 */
async function resolveTournamentByeMatch(tournamentMatch) {
  if (!tournamentMatch || (tournamentMatch.participant1 !== 'BYE' && tournamentMatch.participant2 !== 'BYE')) return false;

  if (tournamentMatch.participant1 === 'BYE' && tournamentMatch.participant2 === 'BYE') {
    tournamentMatch.winnerId = null;
    tournamentMatch.winner = null;
    tournamentMatch.winnerUucms = '';
    tournamentMatch.score1 = 0;
    tournamentMatch.score2 = 0;
    tournamentMatch.status = 'completed';
    tournamentMatch.updatedAt = new Date();
    await tournamentMatch.save();
    return true;
  }

  const winnerId = tournamentMatch.participant1 === 'BYE' ? tournamentMatch.participant2Id : tournamentMatch.participant1Id;
  const winner = tournamentMatch.participant1 === 'BYE' ? tournamentMatch.participant2 : tournamentMatch.participant1;
  const winnerUucms = tournamentMatch.participant1 === 'BYE' ? tournamentMatch.participant2Uucms : tournamentMatch.participant1Uucms;

  if (!winner) return false;

  tournamentMatch.winnerId = winnerId;
  tournamentMatch.winner = winner;
  tournamentMatch.winnerUucms = winnerUucms || '';
  tournamentMatch.score1 = tournamentMatch.participant1 === 'BYE' ? 0 : 1;
  tournamentMatch.score2 = tournamentMatch.participant2 === 'BYE' ? 0 : 1;
  tournamentMatch.status = 'completed';
  tournamentMatch.updatedAt = new Date();
  await tournamentMatch.save();

  await advanceTournamentWinner(tournamentMatch);
  return true;
}

/**
 * Create cricket matches from tournament fixtures that have both participants decided.
 * Safe to call repeatedly; skips fixtures that are already mapped to a cricket match.
 */
async function createCricketMatchesFromTournamentFixtures(tournamentId) {
  if (!tournamentId) {
    throw new Error('Tournament ID is required');
  }

  const tournament = await Tournament.findById(tournamentId).populate('eventId');
  if (!tournament) {
    throw new Error('Tournament not found');
  }

  const event = tournament.eventId;
  if (!event || event.sportType !== 'cricket') {
    throw new Error('This tournament is not a cricket event');
  }

  const tournamentMatches = await TournamentMatch.find({ tournamentId }).sort({ round: 1, matchNumber: 1 });
  if (tournamentMatches.length === 0) {
    return [];
  }

  const existingCricketMatches = await CricketMatch.find({ tournamentId }).select('tournamentMatchId');
  const existingTournamentMatchIds = new Set(
    existingCricketMatches
      .filter((cm) => cm.tournamentMatchId)
      .map((cm) => String(cm.tournamentMatchId))
  );

  const createdMatches = [];

  for (const tMatch of tournamentMatches) {
    if (existingTournamentMatchIds.has(String(tMatch._id))) {
      continue;
    }

    if (!tMatch.participant1 || !tMatch.participant2 || tMatch.participant1 === 'BYE' || tMatch.participant2 === 'BYE') {
      continue;
    }

    try {
      const app1 = tMatch.participant1Id ? await Application.findById(tMatch.participant1Id) : null;
      const app2 = tMatch.participant2Id ? await Application.findById(tMatch.participant2Id) : null;

      const buildPlayerList = (app) => {
        if (!app || !app.players || app.players.length === 0) {
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

        const mainPlayers = app.players.filter((p) => !p.isSubstitute && p.name).slice(0, 11);
        return mainPlayers.map((p, idx) => ({
          name: p.name || `Player ${idx + 1}`,
          uucms: p.uucms || '',
          department: p.department || '',
          gender: p.gender || 'unspecified',
          role: p.role || 'batsman',
          isCaptain: idx === 0,
          isViceCaptain: idx === 1,
          isPlaying: true
        }));
      };

      const cricketMatch = new CricketMatch({
        eventId: event._id,
        tournamentId: tournament._id,
        tournamentMatchId: tMatch._id,
        teamA: {
          name: tMatch.participant1,
          applicationId: tMatch.participant1Id || null,
          players: buildPlayerList(app1)
        },
        teamB: {
          name: tMatch.participant2,
          applicationId: tMatch.participant2Id || null,
          players: buildPlayerList(app2)
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
    } catch (matchError) {
      console.error(`Error creating cricket match from tournament match ${tMatch._id}:`, matchError.message);
    }
  }

  return createdMatches;
}

/**
 * Sync CricketMatch result back to TournamentMatch so bracket progression remains automatic.
 */
async function syncTournamentFromCricket(match, req) {
  if (!match?.tournamentMatchId) return;

  const tournamentMatch = await TournamentMatch.findById(match.tournamentMatchId);
  if (!tournamentMatch) return;

  const inningsTeamA = match.innings.find((inn) => inn.battingTeam === 'teamA');
  const inningsTeamB = match.innings.find((inn) => inn.battingTeam === 'teamB');

  const cricketScore1 = {
    runs: inningsTeamA?.totalRuns ?? null,
    wickets: inningsTeamA?.totalWickets ?? null,
    overs: inningsTeamA?.totalOvers || ''
  };
  const cricketScore2 = {
    runs: inningsTeamB?.totalRuns ?? null,
    wickets: inningsTeamB?.totalWickets ?? null,
    overs: inningsTeamB?.totalOvers || ''
  };

  tournamentMatch.cricketScore1 = cricketScore1;
  tournamentMatch.cricketScore2 = cricketScore2;
  tournamentMatch.score1 = cricketScore1.runs;
  tournamentMatch.score2 = cricketScore2.runs;
  tournamentMatch.cricketResultText = match.result?.resultText || '';
  tournamentMatch.status = match.status === 'completed'
    ? 'completed'
    : (match.status === 'live' ? 'in_progress' : tournamentMatch.status);

  if (match.result?.winner === 'teamA') {
    tournamentMatch.winnerId = tournamentMatch.participant1Id || match.teamA?.applicationId || null;
    tournamentMatch.winner = tournamentMatch.participant1 || match.teamA?.name || null;
    tournamentMatch.winnerUucms = tournamentMatch.participant1Uucms || '';
  } else if (match.result?.winner === 'teamB') {
    tournamentMatch.winnerId = tournamentMatch.participant2Id || match.teamB?.applicationId || null;
    tournamentMatch.winner = tournamentMatch.participant2 || match.teamB?.name || null;
    tournamentMatch.winnerUucms = tournamentMatch.participant2Uucms || '';
  } else {
    tournamentMatch.winnerId = null;
    tournamentMatch.winner = null;
    tournamentMatch.winnerUucms = '';
  }

  tournamentMatch.updatedAt = new Date();
  await tournamentMatch.save();

  if (tournamentMatch.status === 'completed' && tournamentMatch.winner) {
    await advanceTournamentWinner(tournamentMatch);

    // Auto-create newly unlocked knockout fixtures (semi/final, etc.) in cricket matches.
    try {
      const autoCreatedMatches = await createCricketMatchesFromTournamentFixtures(tournamentMatch.tournamentId);

      if (autoCreatedMatches.length > 0 && req?.app) {
        const io = req.app.get('io');
        if (io) {
          io.to(`cricket:${match._id}`).emit('cricket_auto_fixtures_created', {
            tournamentId: tournamentMatch.tournamentId,
            sourceMatchId: match._id,
            createdMatches: autoCreatedMatches,
            count: autoCreatedMatches.length,
            timestamp: new Date()
          });
        }
      }
    } catch (autoCreateErr) {
      console.error('Auto cricket fixture generation failed:', autoCreateErr.message);
    }
  }

  if (req?.app) {
    const io = req.app.get('io');
    if (io) {
      emitTournamentMatchUpdate(io, tournamentMatch.tournamentId.toString(), tournamentMatch.toObject());
    }
  }
}

/**
 * Revert tournament sync if a match is undone from completed state
 */
async function revertTournamentSync(match, req) {
  if (!match?.tournamentMatchId) return;

  const tournamentMatch = await TournamentMatch.findById(match.tournamentMatchId);
  if (!tournamentMatch) return;

  // If this match was already progressing someone, revert it
  if (tournamentMatch.status === 'completed') {
    tournamentMatch.status = 'in_progress';
    tournamentMatch.winnerId = null;
    tournamentMatch.winner = null;
    tournamentMatch.winnerUucms = '';
    
    // Also try to un-advance the winner from the next round if possible
    const tournament = await Tournament.findById(tournamentMatch.tournamentId);
    if (tournament && tournament.format === 'single_elimination') {
      const nextRound = tournamentMatch.round + 1;
      const nextMatchNumber = Math.ceil(tournamentMatch.matchNumber / 2);
      const nextMatch = await TournamentMatch.findOne({
        tournamentId: tournamentMatch.tournamentId,
        round: nextRound,
        matchNumber: nextMatchNumber
      });

      if (nextMatch && nextMatch.status !== 'completed') {
        if (tournamentMatch.matchNumber % 2 === 1) {
          nextMatch.participant1Id = null;
          nextMatch.participant1 = null;
          nextMatch.participant1Uucms = '';
        } else {
          nextMatch.participant2Id = null;
          nextMatch.participant2 = null;
          nextMatch.participant2Uucms = '';
        }
        await nextMatch.save();
      }
    }
  }

  tournamentMatch.updatedAt = new Date();
  await tournamentMatch.save();

  if (req?.app) {
    const io = req.app.get('io');
    if (io) {
      emitTournamentMatchUpdate(io, tournamentMatch.tournamentId.toString(), tournamentMatch.toObject());
    }
  }
}

// ============================================================
// Helper: Compute Man of the Match from all innings
// ============================================================
function computeManOfTheMatch(match) {
  let bestBatsman = null;
  let bestBowler = null;
  let maxRuns = -1;
  let maxWickets = -1;
  let bestEconomy = 999;

  match.innings.forEach(inn => {
    (inn.batsmenStats || []).forEach(batsman => {
      if (batsman.runs > maxRuns) {
        maxRuns = batsman.runs;
        bestBatsman = batsman.playerName;
      }
    });
    (inn.bowlerStats || []).forEach(bowler => {
      if (bowler.wickets > maxWickets || (bowler.wickets === maxWickets && bowler.economy < bestEconomy)) {
        maxWickets = bowler.wickets;
        bestEconomy = bowler.economy;
        bestBowler = bowler.playerName;
      }
    });
  });

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
  return manOfTheMatch || 'N/A';
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
          gender: p.gender || 'unspecified',
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
          gender: p.gender || 'unspecified',
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
    if (match.currentState === 'not_started') {
      match.currentState = 'toss';
    }
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

    if (String(strikerId) === String(nonStrikerId)) {
      return res.status(400).json({ error: 'Striker and non-striker must be different players' });
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

    const isActiveInnings = match.currentState.startsWith('innings_') || match.currentState === 'super_over_1' || match.currentState === 'super_over_2';
    if (!isActiveInnings) {
      return res.status(400).json({ error: 'No active innings' });
    }

    const isSO = match.isSuperOver && (match.currentState === 'super_over_1' || match.currentState === 'super_over_2');
    const inningsArray = isSO ? match.superOverInnings : match.innings;
    const inningNum = isSO ? match.superOverNumber : match.currentInning;
    const innings = inningsArray.find(i => i.inningNumber === inningNum);
    if (!innings || innings.isCompleted) {
      return res.status(400).json({ error: 'Innings not found or completed' });
    }

    const {
      runsScored = 0,
      isWide = false,
      isNoBall = false,
      isBye = false,
      isLegBye = false,
      isOverthrow = false,
      overthrowBaseRuns = 0,
      overthrowRuns = 0,
      isPenalty = false,
      penaltyRuns = 0,
      isWicket = false,
      wicketType = '',
      wicketBatsman = '',
      wicketFielder = '',
      newBatsmanId = ''
    } = req.body;

    const parsedPenaltyRuns = Math.max(0, Number(penaltyRuns || 0));
    const hasPenaltyRuns = Boolean(isPenalty) || parsedPenaltyRuns > 0;

    const battingTeamData = match[innings.battingTeam];
    const bowlingTeamData = match[innings.bowlingTeam];

    if (match.isNextBallFreeHit && isWicket && !FREE_HIT_WICKET_TYPES.has(wicketType)) {
      return res.status(400).json({ error: 'Only run out or obstructing the field is allowed on a free hit' });
    }

    if (isWide && isWicket && !WIDE_WICKET_TYPES.has(wicketType)) {
      return res.status(400).json({ error: 'Invalid wicket type on a wide ball' });
    }

    // Validate new batsman is not already at the crease
    if (isWicket && newBatsmanId) {
      if (String(newBatsmanId) === String(match.currentStrikerId) || String(newBatsmanId) === String(match.currentNonStrikerId)) {
        return res.status(400).json({ error: 'New batsman is already at the crease' });
      }
    }

    // Current players
    const strikerStat = innings.batsmenStats.find(b => b.playerId === match.currentStrikerId && !b.isOut);
    const bowlerStat = match.currentBowlerId
      ? innings.bowlerStats.find(b => b.playerId === match.currentBowlerId)
      : null;
    
    // Allow recording all-out wickets without striker validation
    const isAllOutWicket = isWicket && !newBatsmanId;
    
    if (!hasPenaltyRuns && !isAllOutWicket && (!strikerStat || !bowlerStat)) {
      console.warn(`❌ Striker: ${strikerStat ? 'Found' : 'NOT FOUND'}, Bowler: ${bowlerStat ? 'Found' : 'NOT FOUND'}`);
      return res.status(400).json({ error: 'Current striker or bowler not found' });
    }
    
    // For all-out wickets, ensure we have at least the bowler
    if (!hasPenaltyRuns && isAllOutWicket && !bowlerStat) {
      console.warn('❌ All-out wicket but bowler not found');
      return res.status(400).json({ error: 'Bowler not found for all-out wicket' });
    }

    // For all-out situations, strikerStat is null - that's okay
    if (!hasPenaltyRuns && !strikerStat && !isAllOutWicket) {
      console.warn('❌ Striker not found and not an all-out wicket');
      return res.status(400).json({ error: 'Current striker not found' });
    }

    const strikerName = strikerStat?.playerName || 'Out Batsman';
    const strikerRunsBefore = strikerStat ? strikerStat.runs : 0;
    const nonStrikerStat = innings.batsmenStats.find(b => b.playerId === match.currentNonStrikerId && !b.isOut);
    const nonStrikerName = nonStrikerStat ? nonStrikerStat.playerName : '';

    // Calculate runs
    let totalRunsThisBall = 0;
    let extraRuns = 0;
    let isLegalDelivery = true;
    let computedOverthrowBaseRuns = 0;
    let computedOverthrowRuns = 0;
    let isPenaltyDelivery = false;
    const isFour = runsScored === 4 && !isBye && !isLegBye;
    const isSix = runsScored === 6 && !isBye && !isLegBye;

    if (hasPenaltyRuns) {
      isPenaltyDelivery = true;
      totalRunsThisBall = parsedPenaltyRuns || 5;
      extraRuns = totalRunsThisBall;
      isLegalDelivery = false;
      innings.extras.penalties += totalRunsThisBall;
    }

    // For all-out wickets, skip normal ball processing - just record the dismissal
    if (!isPenaltyDelivery && !isAllOutWicket) {
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
        // Batsman gets runs on no-ball, but it does not count as a ball faced.
        if (strikerStat) {
          strikerStat.runs += runsScored;
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
      } else if (isOverthrow) {
        // Overthrow runs - capture split as (completed runs + overthrow runs)
        // Backward compatibility: if split isn't provided, keep old behavior.
        const parsedBaseRuns = Number(overthrowBaseRuns);
        const parsedOverthrowRuns = Number(overthrowRuns);
        const hasExplicitSplit = Number.isFinite(parsedBaseRuns) && Number.isFinite(parsedOverthrowRuns) && (parsedBaseRuns > 0 || parsedOverthrowRuns > 0);

        if (hasExplicitSplit) {
          computedOverthrowBaseRuns = Math.max(0, parsedBaseRuns);
          computedOverthrowRuns = Math.max(0, parsedOverthrowRuns);
          totalRunsThisBall = computedOverthrowBaseRuns + computedOverthrowRuns;
        } else {
          totalRunsThisBall = runsScored;
          computedOverthrowBaseRuns = totalRunsThisBall > 1 ? 1 : 0;
          computedOverthrowRuns = Math.max(0, totalRunsThisBall - computedOverthrowBaseRuns);
        }

        isLegalDelivery = true;  // Overthrows happen on a normal legal delivery

        // These runs don't count toward any specific extras category, but are recorded in the delivery.
        if (strikerStat) {
          strikerStat.runs += totalRunsThisBall;
          strikerStat.ballsFaced += 1;
          if (totalRunsThisBall === 4) strikerStat.fours += 1;
          if (totalRunsThisBall === 6) strikerStat.sixes += 1;
        }
        bowlerStat.runsConceded += totalRunsThisBall;
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
        const dismissalType = wicketType || 'bowled';
        outStat.isOut = true;
        outStat.dismissalType = dismissalType;
        outStat.dismissalBowler = countsAsBowlerWicket(dismissalType) ? bowlerStat.playerName : '';
        outStat.dismissalFielder = wicketFielder || '';
        outStat.dismissalText = dismissalTextForWicket(dismissalType, bowlerStat.playerName, wicketFielder);

        if (countsAsBowlerWicket(dismissalType)) {
          bowlerStat.wickets += 1;
        }

        if (countsAsTeamWicket(dismissalType)) {
          innings.totalWickets += 1;
          innings.fallOfWickets.push({
            wicketNumber: innings.totalWickets,
            score: innings.totalRuns,
            overNumber: innings.totalOvers,
            batsmanName: outBatsmanName,
            dismissalText: outStat.dismissalText
          });
        }

        // Start new partnership if new batsman comes in
        if (newBatsmanId && (!countsAsTeamWicket(dismissalType) || innings.totalWickets < 10)) {
          const newBatsmanPlayer = battingTeamData.players[parseInt(newBatsmanId)];
          if (newBatsmanPlayer) {
            const existingStat = innings.batsmenStats.find(b => b.playerName === newBatsmanPlayer.name);
            if (!existingStat) {
              innings.batsmenStats.push(createBatsmanStat({
                playerName: newBatsmanPlayer.name,
                playerId: newBatsmanId,
                battingOrder: innings.batsmenStats.length + 1
              }));
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

    // Rotate strike on odd runs (only for legal deliveries, non-wide).
    // Skip rotation when a wicket falls and a new batsman has been set — the new
    // batsman already inherits the correct end; rotating would put them at the wrong end.
    const wicketWithNewBatsman = isWicket && newBatsmanId;
    if (!isPenaltyDelivery && !isWide && runsScored % 2 === 1 && !wicketWithNewBatsman) {
      swapCurrentBatsmen(match);
    }

    // ── Free Hit: set after no-ball, clear after the next legal delivery ──
    if (isNoBall) {
      match.isNextBallFreeHit = true;
    } else if (isLegalDelivery && !isWide) {
      match.isNextBallFreeHit = false;
    }

    // Update strike rates for all batsmen
    innings.batsmenStats.forEach(b => {
      b.strikeRate = strikeRate(b.runs, b.ballsFaced);
    });

    // Update bowler stats
    if (bowlerStat) {
      bowlerStat.oversBowled = parseFloat(ballsToOvers(bowlerStat.ballsBowled));
      bowlerStat.economy = economy(bowlerStat.runsConceded, bowlerStat.ballsBowled);
    }

    // Check over completion (6 legal deliveries in this over)
    let overCompleted = false;
    let completedOverRuns = 0;
    let completedOverIsMaiden = false;
    if (innings.currentOverBalls >= 6) {
      overCompleted = true;
      completedOverRuns = innings.currentOverRuns;
      completedOverIsMaiden = innings.currentOverRuns === 0;
      // Check for maiden
      if (completedOverIsMaiden) {
        bowlerStat.maidens += 1;
      }
      innings.currentOverBalls = 0;
      innings.currentOverRuns = 0;
      match.lastCompletedOverBowlerId = match.currentBowlerId || match.lastCompletedOverBowlerId;
      match.currentBowlerId = '';

      // Rotate strike at end of over
      swapCurrentBatsmen(match);
    }

    // Check innings completion: all out or overs done
    const maxBalls = isSO ? 6 : match.oversPerSide * 6;
    if (innings.totalWickets >= 10 || innings.totalBalls >= maxBalls) {
      innings.isCompleted = true;
      if (isSO) {
        // Super Over innings completed
        if (match.superOverNumber === 1) {
          match.currentState = 'super_over_break';
        } else {
          // SO inning 2 done — determine winner from SO scores
          match.currentState = 'completed';
          match.status = 'completed';
          const soInn1 = match.superOverInnings.find(i => i.inningNumber === 1);
          const soInn2 = match.superOverInnings.find(i => i.inningNumber === 2);
          if (soInn1 && soInn2) {
            if (soInn2.totalRuns > soInn1.totalRuns) {
              match.result.winner = soInn2.battingTeam;
              match.result.winnerName = match[soInn2.battingTeam].name;
              match.result.resultText = `${match[soInn2.battingTeam].name} won in Super Over`;
            } else if (soInn1.totalRuns > soInn2.totalRuns) {
              match.result.winner = soInn1.battingTeam;
              match.result.winnerName = match[soInn1.battingTeam].name;
              match.result.resultText = `${match[soInn1.battingTeam].name} won in Super Over`;
            } else {
              match.result.winner = 'tie';
              match.result.resultText = 'Match tied! (Super Over also tied)';
            }
          }
          match.result.manOfTheMatch = computeManOfTheMatch(match);
        }
      } else if (match.currentInning === 1) {
        match.currentState = 'innings_break';
      } else {
        // 2nd innings done — check winner or trigger Super Over on tie
        const inn1 = match.innings.find(i => i.inningNumber === 1);
        const inn2 = match.innings.find(i => i.inningNumber === 2);
        if (inn1 && inn2) {
          if (inn2.totalRuns > inn1.totalRuns) {
            match.currentState = 'completed';
            match.status = 'completed';
            match.result.winner = inn2.battingTeam;
            match.result.winnerName = match[inn2.battingTeam].name;
            const wicketsLeft = 10 - inn2.totalWickets;
            match.result.resultText = `${match[inn2.battingTeam].name} won by ${wicketsLeft} wicket${wicketsLeft !== 1 ? 's' : ''}`;
            match.result.manOfTheMatch = computeManOfTheMatch(match);
          } else if (inn1.totalRuns > inn2.totalRuns) {
            match.currentState = 'completed';
            match.status = 'completed';
            match.result.winner = inn1.battingTeam;
            match.result.winnerName = match[inn1.battingTeam].name;
            const runDiff = inn1.totalRuns - inn2.totalRuns;
            match.result.resultText = `${match[inn1.battingTeam].name} won by ${runDiff} run${runDiff !== 1 ? 's' : ''}`;
            match.result.manOfTheMatch = computeManOfTheMatch(match);
          } else {
            // TIED! Trigger Super Over
            match.currentState = 'super_over_break';
            match.isSuperOver = true;
          }
        }
      }
    }

    // Check if 2nd innings team has chased the target
    if (!isSO && match.currentInning === 2 && !innings.isCompleted) {
      const inn1 = match.innings.find(i => i.inningNumber === 1);
      if (inn1 && innings.totalRuns > inn1.totalRuns) {
        innings.isCompleted = true;
        match.currentState = 'completed';
        match.status = 'completed';
        match.result.winner = innings.battingTeam;
        match.result.winnerName = match[innings.battingTeam].name;
        const wicketsLeft = 10 - innings.totalWickets;
        match.result.resultText = `${match[innings.battingTeam].name} won by ${wicketsLeft} wicket${wicketsLeft !== 1 ? 's' : ''}`;
        match.result.manOfTheMatch = computeManOfTheMatch(match);
      }
    }

    // Check if Super Over 2nd innings team has chased the SO target
    if (isSO && match.superOverNumber === 2 && !innings.isCompleted) {
      const soInn1 = match.superOverInnings.find(i => i.inningNumber === 1);
      if (soInn1 && innings.totalRuns > soInn1.totalRuns) {
        innings.isCompleted = true;
        match.currentState = 'completed';
        match.status = 'completed';
        match.result.winner = innings.battingTeam;
        match.result.winnerName = match[innings.battingTeam].name;
        match.result.resultText = `${match[innings.battingTeam].name} won in Super Over`;
        match.result.manOfTheMatch = computeManOfTheMatch(match);
      }
    }

    await match.save();
    if (match.status === 'completed') {
      await syncTournamentFromCricket(match, req);
    }

    // Determine milestones
    const strikerRunsAfter = strikerStat ? strikerStat.runs : strikerRunsBefore;
    const isFifty = strikerRunsBefore < 50 && strikerRunsAfter >= 50;
    const isCentury = strikerRunsBefore < 100 && strikerRunsAfter >= 100;

    // Create delivery document
    const currentOver = Math.floor((innings.totalBalls - (isLegalDelivery ? 1 : 0)) / 6);
    const currentBall = isLegalDelivery ? innings.currentOverBalls || 6 : 0;
    const deliveryData = {
      matchId: match._id,
      inningNumber: isSO ? match.superOverNumber + 2 : match.currentInning,
      overNumber: currentOver,
      ballNumber: isLegalDelivery ? (overCompleted ? 6 : currentBall) : 0,
      isSuperOverDelivery: isSO,
      batsmanName: strikerName,
      bowlerName: bowlerStat?.playerName || '',
      nonStrikerName,
      runsScored: isOverthrow ? totalRunsThisBall : runsScored,
      extraRuns,
      totalRuns: totalRunsThisBall,
      overthrowBaseRuns: isOverthrow ? computedOverthrowBaseRuns : 0,
      overthrowRuns: isOverthrow ? computedOverthrowRuns : 0,
      isPenalty: isPenaltyDelivery,
      penaltyRuns: isPenaltyDelivery ? totalRunsThisBall : 0,
      isWide,
      isNoBall,
      isBye,
      isLegBye,
      isOverthrow,
      isFour: isFour && !isBye && !isLegBye,
      isSix: isSix && !isBye && !isLegBye,
      isFifty,
      isCentury,
      isWicket,
      wicketType: isWicket ? wicketType : '',
      wicketBatsman: isWicket ? (wicketBatsman || strikerName) : '',
      wicketFielder: isWicket ? wicketFielder : '',
      newBatsmanId: isWicket ? newBatsmanId : '',
      newBatsmanName: isWicket && newBatsmanId !== ''
        ? (battingTeamData.players[parseInt(newBatsmanId)]?.name || '')
        : '',
      teamScore: innings.totalRuns,
      teamWickets: innings.totalWickets,
      oversSoFar: innings.totalOvers,
      commentary: generateCommentary({
        batsmanName: strikerName, bowlerName: bowlerStat?.playerName || '',
        runsScored: isOverthrow ? totalRunsThisBall : runsScored,
        isWide, isNoBall, isBye, isLegBye, isOverthrow, isFour, isSix,
        isPenalty: isPenaltyDelivery,
        penaltyRuns: isPenaltyDelivery ? totalRunsThisBall : 0,
        isWicket, wicketType, wicketBatsman, extraRuns,
        overthrowBaseRuns: isOverthrow ? computedOverthrowBaseRuns : 0,
        overthrowRuns: isOverthrow ? computedOverthrowRuns : 0
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
            runs: completedOverRuns,
            isMaiden: completedOverIsMaiden
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

      // Emit Super Over trigger
      if (match.currentState === 'super_over_break') {
        console.log(`🔔 Emitting cricket_super_over to room cricket:${match._id}`);
        io.to(`cricket:${match._id}`).emit('cricket_super_over', {
          matchId: match._id,
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

    if (String(newBowlerId) === String(match.lastCompletedOverBowlerId)) {
      return res.status(400).json({ error: 'The same bowler cannot bowl consecutive overs' });
    }

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

    const maxOversPerBowler = getMaxBowlerOvers(match);
    if (bowlerStat.ballsBowled >= maxOversPerBowler * 6) {
      return res.status(400).json({ error: `This bowler has already bowled the maximum of ${maxOversPerBowler} over${maxOversPerBowler !== 1 ? 's' : ''}` });
    }

    match.currentBowlerId = newBowlerId;
    await match.save();
    if (match.status === 'completed') {
      await syncTournamentFromCricket(match, req);
    }

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

    const isSO = match.isSuperOver && (match.currentState === 'super_over_1' || match.currentState === 'super_over_2' || match.currentState === 'super_over_break');
    const deliveryInningNum = isSO ? match.superOverNumber + 2 : match.currentInning;

    // Find and delete the last delivery
    const lastDelivery = await CricketDelivery.findOne({
      matchId: match._id,
      inningNumber: deliveryInningNum
    }).sort({ timestamp: -1 });

    if (!lastDelivery) return res.status(400).json({ error: 'No deliveries to undo' });

    await CricketDelivery.deleteOne({ _id: lastDelivery._id });

    const allDeliveries = await CricketDelivery.find({
      matchId: match._id,
      inningNumber: deliveryInningNum
    }).sort({ timestamp: 1 });

    const inningsArray = isSO ? match.superOverInnings : match.innings;
    const inningNum = isSO ? match.superOverNumber : match.currentInning;
    const innings = inningsArray.find(i => i.inningNumber === inningNum);
    if (!innings) return res.status(400).json({ error: 'No active innings' });

    rebuildInningsFromDeliveries(match, innings, allDeliveries);

    // Reopen the active innings after undo
    if (isSO) {
      if (match.currentState === 'super_over_break' || match.currentState === 'completed' || match.status === 'completed') {
        match.currentState = match.superOverNumber === 1 ? 'super_over_1' : 'super_over_2';
      }
    } else if (match.currentState === 'innings_break' || match.currentState === 'super_over_break' || match.currentState === 'completed' || match.status === 'completed') {
      match.currentState = match.currentInning === 1 ? 'innings_1' : 'innings_2';
      // If we're undoing from super_over_break back to innings_2, clear SO state
      if (match.isSuperOver && allDeliveries.length === 0) {
        match.isSuperOver = false;
        match.superOverNumber = 0;
        match.superOverInnings = [];
      }
    }

    if (match.status === 'completed') {
      match.status = 'live';
      match.result = { winner: '', winnerName: '', resultText: '', manOfTheMatch: '' };
      await revertTournamentSync(match, req);
    } else if (match.status !== 'live') {
      match.status = 'live';
    }

    if (allDeliveries.length === 0) {
      innings.totalOvers = '0.0';
    }

    await match.save();
    await syncTournamentFromCricket(match, req);

    const io = req.app.get('io');
    if (io) {
      io.to(`cricket:${match._id}`).emit('cricket_undo', {
        matchId: match._id,
        timestamp: new Date()
      });
    }

    res.json(match);
  } catch (error) {
    console.error('Error undoing last ball:', error);
    res.status(500).json({ error: error.message });
  }
};
// ============================================================
// ADMIN: Change bowler mid-over
// ============================================================
exports.changeBowler = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const { newBowlerId } = req.body;
    if (!newBowlerId) return res.status(400).json({ error: 'newBowlerId required' });

    const isSO = match.isSuperOver && (match.currentState === 'super_over_1' || match.currentState === 'super_over_2');
    const inningsArray = isSO ? match.superOverInnings : match.innings;
    const inningNum = isSO ? match.superOverNumber : match.currentInning;
    const innings = inningsArray.find(i => i.inningNumber === inningNum);

    if (!innings || innings.isCompleted) return res.status(400).json({ error: 'No active innings' });

    if (String(newBowlerId) === String(match.currentBowlerId)) {
      return res.status(400).json({ error: 'This bowler is already bowling' });
    }

    if (String(newBowlerId) === String(match.lastCompletedOverBowlerId)) {
      return res.status(400).json({ error: 'The same bowler cannot bowl consecutive overs' });
    }

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

    const maxOversPerBowler = getMaxBowlerOvers(match);
    if (bowlerStat.ballsBowled >= maxOversPerBowler * 6) {
      return res.status(400).json({ error: `This bowler has already bowled the maximum of ${maxOversPerBowler} over${maxOversPerBowler !== 1 ? 's' : ''}` });
    }

    match.currentBowlerId = newBowlerId;
    await match.save();

    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Resume Retired Batsman
// ============================================================
exports.resumeBatsman = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const { batsmanId, replaceOutBatsmanId, fillEmptySpot } = req.body;
    if (!batsmanId) return res.status(400).json({ error: 'batsmanId required' });
    if (!replaceOutBatsmanId && !fillEmptySpot) return res.status(400).json({ error: 'Must specify replaceOutBatsmanId or fillEmptySpot' });

    const isSO = match.isSuperOver && (match.currentState === 'super_over_1' || match.currentState === 'super_over_2');
    const inningsArray = isSO ? match.superOverInnings : match.innings;
    const inningNum = isSO ? match.superOverNumber : match.currentInning;
    const innings = inningsArray.find(i => i.inningNumber === inningNum);

    if (!innings || innings.isCompleted) return res.status(400).json({ error: 'No active innings' });

    const retiredStat = innings.batsmenStats.find(b => b.playerId === String(batsmanId) && b.isOut && b.dismissalType === 'retired_hurt');
    if (!retiredStat) {
      return res.status(400).json({ error: 'Batsman is not retired hurt or not found' });
    }

    if (fillEmptySpot) {
      // Find which spot is empty (striker or non-striker)
      if (!match.currentStrikerId) {
        match.currentStrikerId = batsmanId;
      } else if (!match.currentNonStrikerId) {
        match.currentNonStrikerId = batsmanId;
      } else {
        return res.status(400).json({ error: 'No empty spot available at the crease' });
      }
    } else if (replaceOutBatsmanId) {
      // Make sure the batsman we are replacing is actually out or is currently at the crease to be swapped
      if (String(match.currentStrikerId) === String(replaceOutBatsmanId)) {
        match.currentStrikerId = batsmanId;
      } else if (String(match.currentNonStrikerId) === String(replaceOutBatsmanId)) {
        match.currentNonStrikerId = batsmanId;
      } else {
        return res.status(400).json({ error: 'The batsman to replace is not currently at the crease' });
      }
    }

    // Mark them as not out
    retiredStat.isOut = false;
    retiredStat.dismissalType = 'not_out';
    retiredStat.dismissalBowler = '';
    retiredStat.dismissalFielder = '';
    retiredStat.dismissalText = '';

    // We should remove their fall of wicket entry
    innings.fallOfWickets = innings.fallOfWickets.filter(fow => fow.batsmanName !== retiredStat.playerName);

    // Create a new partnership with whoever is at the other end
    const otherBatsmanId = match.currentStrikerId === batsmanId ? match.currentNonStrikerId : match.currentStrikerId;
    const otherBatsmanName = innings.batsmenStats.find(b => b.playerId === String(otherBatsmanId))?.playerName || '';
    
    innings.partnerships.push({
      wicketNumber: innings.totalWickets,
      batsman1Name: otherBatsmanName,
      batsman2Name: retiredStat.playerName,
      runs: 0,
      balls: 0
    });

    await match.save();

    const io = req.app.get('io');
    if (io) {
      // Just emit a generic update to refresh clients
      io.to(`cricket:${match._id}`).emit('cricket_ball_update', {
         matchId: match._id,
         timestamp: new Date()
      });
    }

    res.json(match);
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

    // Guard: if already completed, just return current state
    if (match.status === 'completed') {
      return res.json(match);
    }

    const isSO = match.isSuperOver && (match.currentState === 'super_over_1' || match.currentState === 'super_over_2');
    const inningsArray = isSO ? match.superOverInnings : match.innings;
    const inningNum = isSO ? match.superOverNumber : match.currentInning;
    const innings = inningsArray.find(i => i.inningNumber === inningNum);
    if (!innings) return res.status(400).json({ error: 'No active innings' });

    innings.isCompleted = true;

    if (isSO) {
      // Super Over innings ending
      if (match.superOverNumber === 1) {
        match.currentState = 'super_over_break';
      } else {
        // SO inning 2 done — determine winner
        match.currentState = 'completed';
        match.status = 'completed';
        const soInn1 = match.superOverInnings.find(i => i.inningNumber === 1);
        if (soInn1) {
          if (innings.totalRuns > soInn1.totalRuns) {
            match.result.winner = innings.battingTeam;
            match.result.winnerName = match[innings.battingTeam].name;
            match.result.resultText = `${match[innings.battingTeam].name} won in Super Over`;
          } else if (soInn1.totalRuns > innings.totalRuns) {
            match.result.winner = soInn1.battingTeam;
            match.result.winnerName = match[soInn1.battingTeam].name;
            match.result.resultText = `${match[soInn1.battingTeam].name} won in Super Over`;
          } else {
            match.result.winner = 'tie';
            match.result.resultText = 'Match tied! (Super Over also tied)';
          }
        }
        match.result.manOfTheMatch = computeManOfTheMatch(match);
      }
    } else if (match.currentInning === 1) {
      match.currentState = 'innings_break';
    } else {
      // Regular 2nd innings ending
      const inn1 = match.innings.find(i => i.inningNumber === 1);
      if (inn1) {
        if (innings.totalRuns > inn1.totalRuns) {
          match.currentState = 'completed';
          match.status = 'completed';
          match.result.winner = innings.battingTeam;
          match.result.winnerName = match[innings.battingTeam].name;
          const wkts = 10 - innings.totalWickets;
          match.result.resultText = `${match[innings.battingTeam].name} won by ${wkts} wicket${wkts !== 1 ? 's' : ''}`;
          match.result.manOfTheMatch = computeManOfTheMatch(match);
        } else if (inn1.totalRuns > innings.totalRuns) {
          match.currentState = 'completed';
          match.status = 'completed';
          match.result.winner = inn1.battingTeam;
          match.result.winnerName = match[inn1.battingTeam].name;
          const runDiff = inn1.totalRuns - innings.totalRuns;
          match.result.resultText = `${match[inn1.battingTeam].name} won by ${runDiff} run${runDiff !== 1 ? 's' : ''}`;
          match.result.manOfTheMatch = computeManOfTheMatch(match);
        } else {
          // TIED! Trigger Super Over
          match.currentState = 'super_over_break';
          match.isSuperOver = true;
        }
      }
    }

    match.currentStrikerId = '';
    match.currentNonStrikerId = '';
    match.currentBowlerId = '';

    await match.save();

    if (match.status === 'completed') {
      await syncTournamentFromCricket(match, req);
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`cricket:${match._id}`).emit('cricket_innings_end', {
        matchId: match._id,
        inningNumber: isSO ? match.superOverNumber : match.currentInning,
        totalRuns: innings.totalRuns,
        totalWickets: innings.totalWickets,
        totalOvers: innings.totalOvers,
        timestamp: new Date()
      });
      if (match.status === 'completed') {
        io.to(`cricket:${match._id}`).emit('cricket_match_end', {
          matchId: match._id,
          result: match.result,
          timestamp: new Date()
        });
      }
      if (match.currentState === 'super_over_break') {
        io.to(`cricket:${match._id}`).emit('cricket_super_over', {
          matchId: match._id,
          timestamp: new Date()
        });
      }
    }

    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ============================================================
// ADMIN: Start a Super Over innings
// ============================================================
exports.startSuperOverInnings = async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (match.currentState !== 'super_over_break') {
      return res.status(400).json({ error: 'Match is not in Super Over break state' });
    }

    const { strikerId, nonStrikerId, bowlerId } = req.body;
    if (!strikerId || !nonStrikerId || !bowlerId) {
      return res.status(400).json({ error: 'strikerId, nonStrikerId, and bowlerId are required' });
    }
    if (strikerId === nonStrikerId) {
      return res.status(400).json({ error: 'Striker and non-striker must be different' });
    }

    // Determine which SO inning we're starting
    const soInningNumber = (match.superOverInnings?.length || 0) === 0 ? 1 : 2;

    // In IPL: team that batted second in the main match bats first in Super Over
    // SO inning 1: main innings 2 batting team bats
    // SO inning 2: main innings 1 batting team bats
    const mainInn2 = match.innings.find(i => i.inningNumber === 2);
    const mainInn1 = match.innings.find(i => i.inningNumber === 1);
    let battingTeamKey, bowlingTeamKey;
    if (soInningNumber === 1) {
      battingTeamKey = mainInn2?.battingTeam || 'teamB';
      bowlingTeamKey = mainInn2?.bowlingTeam || 'teamA';
    } else {
      battingTeamKey = mainInn1?.battingTeam || 'teamA';
      bowlingTeamKey = mainInn1?.bowlingTeam || 'teamB';
    }

    const battingTeamData = match[battingTeamKey];
    const bowlingTeamData = match[bowlingTeamKey];

    const strikerPlayer = battingTeamData.players[parseInt(strikerId)];
    const nonStrikerPlayer = battingTeamData.players[parseInt(nonStrikerId)];
    const bowlerPlayer = bowlingTeamData.players[parseInt(bowlerId)];

    if (!strikerPlayer || !nonStrikerPlayer || !bowlerPlayer) {
      return res.status(400).json({ error: 'Invalid player selection' });
    }

    const inningsData = {
      inningNumber: soInningNumber,
      battingTeam: battingTeamKey,
      bowlingTeam: bowlingTeamKey,
      totalRuns: 0,
      totalWickets: 0,
      totalOvers: '0.0',
      totalBalls: 0,
      extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalties: 0 },
      batsmenStats: [
        createBatsmanStat({ playerName: strikerPlayer.name, playerId: strikerId, battingOrder: 1 }),
        createBatsmanStat({ playerName: nonStrikerPlayer.name, playerId: nonStrikerId, battingOrder: 2 })
      ],
      bowlerStats: [{
        playerName: bowlerPlayer.name,
        playerId: bowlerId,
        oversBowled: 0, ballsBowled: 0, maidens: 0,
        runsConceded: 0, wickets: 0, noBalls: 0, wides: 0,
        economy: 0, bowlingOrder: 1
      }],
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

    match.superOverInnings.push(inningsData);
    match.superOverNumber = soInningNumber;
    match.currentState = soInningNumber === 1 ? 'super_over_1' : 'super_over_2';
    match.currentStrikerId = strikerId;
    match.currentNonStrikerId = nonStrikerId;
    match.currentBowlerId = bowlerId;
    match.lastCompletedOverBowlerId = '';
    match.isNextBallFreeHit = false;
    match.status = 'live';

    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.to(`cricket:${match._id}`).emit('cricket_innings_start', {
        matchId: match._id,
        inningNumber: soInningNumber,
        isSuperOver: true,
        battingTeam: battingTeamData.name,
        bowlingTeam: bowlingTeamData.name,
        timestamp: new Date()
      });
    }

    res.json(match);
  } catch (err) {
    console.error('startSuperOverInnings error:', err);
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

    // Sync tournament bracket so the winner advances
    await syncTournamentFromCricket(match, req);

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
    const createdMatches = await createCricketMatchesFromTournamentFixtures(tournamentId);

    if (createdMatches.length === 0) {
      return res.status(200).json({
        message: 'No new cricket matches were created. Existing fixtures are already mapped or participants are not ready yet.',
        createdMatches,
        tournamentId
      });
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
