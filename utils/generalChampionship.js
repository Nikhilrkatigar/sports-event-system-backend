const { GeneralChampionship, Leaderboard, Application, Tournament, TournamentMatch } = require('../models');

const POINTS_BY_POSITION = { 1: 15, 2: 10, 3: 5 };

const normalizeValue = (value) => String(value || '').trim();
const normalizeLookupKey = (value) => normalizeValue(value).toLowerCase();
const normalizeDepartment = (value) => normalizeValue(value) || 'Unassigned';
const normalizeGender = (value) => ['male', 'female'].includes(value) ? value : 'unspecified';

const getDivisionMeta = (gender) => {
  if (gender === 'male') return { key: 'male', label: 'Men' };
  if (gender === 'female') return { key: 'female', label: 'Women' };
  return { key: 'open', label: 'Open' };
};

const getPointsForPosition = (position) => POINTS_BY_POSITION[position] || 0;

const registerLookupValue = (lookup, value, department) => {
  const key = normalizeLookupKey(value);
  if (!key || lookup.has(key)) return;
  lookup.set(key, normalizeDepartment(department));
};

const buildDepartmentLookupForEvent = async (eventId, cache = new Map()) => {
  const eventKey = String(eventId);
  if (cache.has(eventKey)) return cache.get(eventKey);

  const lookup = new Map();
  const applications = await Application.find({ eventId }).select('teamName teamId players');

  for (const app of applications) {
    const mainPlayers = Array.isArray(app.players)
      ? app.players.filter((player) => !player.isSubstitute)
      : [];
    const primaryPlayer = mainPlayers.find((player) => player.isTeamLeader) || mainPlayers[0];
    const teamDepartment = normalizeDepartment(primaryPlayer?.department);

    registerLookupValue(lookup, app.teamName, teamDepartment);
    registerLookupValue(lookup, app.teamId, teamDepartment);

    for (const player of mainPlayers) {
      const department = normalizeDepartment(player.department);
      registerLookupValue(lookup, player.name, department);
      registerLookupValue(lookup, `${player.name} (${player.uucms})`, department);
      registerLookupValue(lookup, player.uucms, department);
    }
  }

  cache.set(eventKey, lookup);
  return lookup;
};

const fetchDepartmentFromRegistration = async (eventId, participantName, cache = new Map()) => {
  try {
    const lookup = await buildDepartmentLookupForEvent(eventId, cache);
    return lookup.get(normalizeLookupKey(participantName)) || 'Unassigned';
  } catch (err) {
    console.error('Error fetching department:', err);
    return 'Unassigned';
  }
};

const buildCompetitionLabel = (eventTitle, divisionMeta) => (
  divisionMeta.key === 'open' ? eventTitle : `${eventTitle} (${divisionMeta.label})`
);

const sortTrackCandidates = (a, b) => {
  const hasTimeA = Boolean(String(a.finishTime || '').trim());
  const hasTimeB = Boolean(String(b.finishTime || '').trim());

  if (hasTimeA && hasTimeB) {
    return (parseFloat(a.finishTime) || Infinity) - (parseFloat(b.finishTime) || Infinity)
      || (a.finishPosition ?? 999) - (b.finishPosition ?? 999)
      || (a.lane ?? 999) - (b.lane ?? 999);
  }

  if (a.finishPosition != null && b.finishPosition != null) {
    return a.finishPosition - b.finishPosition || (a.lane ?? 999) - (b.lane ?? 999);
  }

  if (a.finishPosition != null) return -1;
  if (b.finishPosition != null) return 1;

  return (parseFloat(a.finishTime) || Infinity) - (parseFloat(b.finishTime) || Infinity)
    || (a.lane ?? 999) - (b.lane ?? 999);
};

const buildTournamentCompetitionCandidates = async (departmentCache = new Map()) => {
  const candidateMap = new Map();
  const tournaments = await Tournament.find({ status: { $in: ['completed', 'in_progress'] } })
    .populate('eventId', 'title type')
    .sort({ createdAt: 1 });

  for (const tournament of tournaments) {
    if (!tournament?.eventId) continue;
    if (!['track_heats', 'field_flight'].includes(tournament.format)) continue;

    const divisionMeta = getDivisionMeta(normalizeGender(tournament.genderFilter));
    const competitionKey = `${tournament.eventId._id.toString()}::${divisionMeta.key}`;

    let matches = await TournamentMatch.find({ tournamentId: tournament._id }).sort({ round: 1, matchNumber: 1 });
    let candidates = [];

    if (tournament.format === 'track_heats') {
      const completedMatches = matches.filter((match) => match.status === 'completed');
      const latestRound = completedMatches.length > 0
        ? Math.max(...completedMatches.map((match) => Number(match.round) || 1))
        : 1;

      const sourceMatches = latestRound > 1
        ? completedMatches.filter((match) => (Number(match.round) || 1) === latestRound)
        : completedMatches;

      candidates = sourceMatches
        .flatMap((match) => (match.lanes || []).map((lane) => ({ ...lane })))
        .filter((lane) => lane.finishPosition != null || String(lane.finishTime || '').trim())
        .sort(sortTrackCandidates);
    } else if (tournament.format === 'field_flight') {
      candidates = matches
        .flatMap((match) => (match.fieldEntries || []).map((entry) => ({ ...entry })))
        .filter((entry) => entry.rank != null || entry.bestScore != null || entry.performance != null)
        .sort((a, b) => {
          if (a.rank != null && b.rank != null) return a.rank - b.rank || a.order - b.order;
          if (a.rank != null) return -1;
          if (b.rank != null) return 1;
          return (b.bestScore ?? b.performance ?? -Infinity) - (a.bestScore ?? a.performance ?? -Infinity)
            || a.order - b.order;
        });
    }

    const enrichedCandidates = [];
    for (const candidate of candidates) {
      const participantName = candidate.label || candidate.participant || candidate.teamOrPlayer;
      if (!participantName) continue;

      const rawDepartment = normalizeValue(candidate.department);
      const department = rawDepartment
        ? normalizeDepartment(rawDepartment)
        : await fetchDepartmentFromRegistration(tournament.eventId._id, participantName, departmentCache);

      enrichedCandidates.push({
        participantName,
        departmentName: department
      });
    }

    if (enrichedCandidates.length > 0) {
      candidateMap.set(competitionKey, {
        competitionKey,
        competitionLabel: buildCompetitionLabel(tournament.eventId.title, divisionMeta),
        eventId: tournament.eventId._id,
        eventTitle: tournament.eventId.title,
        isTeamEvent: tournament.eventId.type === 'team',
        sourceGender: normalizeGender(tournament.genderFilter),
        candidates: enrichedCandidates
      });
    }
  }

  return candidateMap;
};

const buildGeneralChampionshipStandings = async () => {
  const leaderboard = await Leaderboard.find({ rank: { $ne: null } }).populate('eventId', 'title type');
  const competitionGroups = new Map();

  for (const entry of leaderboard) {
    if (!entry.eventId) continue;

    const gender = normalizeGender(entry.gender);
    const divisionMeta = getDivisionMeta(gender);
    const competitionKey = `${entry.eventId._id.toString()}::${divisionMeta.key}`;

    if (!competitionGroups.has(competitionKey)) {
      competitionGroups.set(competitionKey, {
        competitionKey,
        competitionLabel: buildCompetitionLabel(entry.eventId.title, divisionMeta),
        eventId: entry.eventId._id,
        eventTitle: entry.eventId.title,
        isTeamEvent: entry.eventId.type === 'team',
        sourceGender: gender,
        entries: []
      });
    }

    competitionGroups.get(competitionKey).entries.push(entry);
  }

  const departmentCache = new Map();
  const tournamentCompetitionMap = await buildTournamentCompetitionCandidates(departmentCache);
  const entries = [];
  const departmentScores = {};

  for (const [, competition] of competitionGroups.entries()) {
    const tournamentCompetition = tournamentCompetitionMap.get(competition.competitionKey);
    const rankedEntries = tournamentCompetition
      ? tournamentCompetition.candidates
      : competition.entries
          .filter((entry) => entry.rank != null)
          .sort((a, b) => a.rank - b.rank || a._id.toString().localeCompare(b._id.toString()))
          .map((entry) => ({
            participantName: entry.teamOrPlayer,
            departmentName: null
          }));

    const selectedDepartments = new Set();
    let gcPosition = 1;

    for (const entry of rankedEntries) {
      if (gcPosition > 3) break;

      const participantName = entry.participantName || entry.teamOrPlayer;
      if (!participantName) continue;

      const rawDepartment = normalizeValue(entry.departmentName);
      const department = rawDepartment
        ? normalizeDepartment(rawDepartment)
        : await fetchDepartmentFromRegistration(competition.eventId, participantName, departmentCache);

      if (selectedDepartments.has(department)) continue;

      selectedDepartments.add(department);
      const points = getPointsForPosition(gcPosition);
      if (!points) continue;

      entries.push({
        competitionKey: competition.competitionKey,
        competitionLabel: competition.competitionLabel,
        sourceGender: competition.sourceGender,
        eventId: competition.eventId,
        eventTitle: competition.eventTitle,
        isTeamEvent: competition.isTeamEvent,
        departmentName: department,
        position: gcPosition,
        participantName,
        points
      });

      departmentScores[department] = (departmentScores[department] || 0) + points;
      gcPosition += 1;
    }
  }

  entries.sort((a, b) => {
    const labelCompare = a.competitionLabel.localeCompare(b.competitionLabel);
    if (labelCompare !== 0) return labelCompare;
    return a.position - b.position;
  });

  return { entries, departmentScores };
};

const calculateGeneralChampionship = async () => {
  const gc = await GeneralChampionship.findOne() || new GeneralChampionship({ championship_id: 'gc-main' });
  const { entries, departmentScores } = await buildGeneralChampionshipStandings();

  gc.entries = entries;
  gc.departmentScores = departmentScores;
  gc.updatedAt = new Date();
  await gc.save();

  return gc;
};

module.exports = {
  getPointsForPosition,
  fetchDepartmentFromRegistration,
  buildGeneralChampionshipStandings,
  calculateGeneralChampionship
};
