const { GeneralChampionship, Leaderboard, Application } = require('../models');

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
  const entries = [];
  const departmentScores = {};

  for (const [, competition] of competitionGroups.entries()) {
    const rankedEntries = competition.entries
      .filter((entry) => entry.rank != null)
      .sort((a, b) => a.rank - b.rank || a._id.toString().localeCompare(b._id.toString()));

    const selectedDepartments = new Set();
    let gcPosition = 1;

    for (const entry of rankedEntries) {
      if (gcPosition > 3) break;

      const department = await fetchDepartmentFromRegistration(
        competition.eventId,
        entry.teamOrPlayer,
        departmentCache
      );

      if (selectedDepartments.has(department)) continue;

      selectedDepartments.add(department);
      const points = getPointsForPosition(gcPosition);

      entries.push({
        competitionKey: competition.competitionKey,
        competitionLabel: competition.competitionLabel,
        sourceGender: competition.sourceGender,
        eventId: competition.eventId,
        eventTitle: competition.eventTitle,
        isTeamEvent: competition.isTeamEvent,
        departmentName: department,
        position: gcPosition,
        participantName: entry.teamOrPlayer,
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
