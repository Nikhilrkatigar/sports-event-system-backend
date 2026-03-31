const { GeneralChampionship, Leaderboard, Application } = require('../models');

const getPointsForPosition = (position, isTeamEvent = false) => {
  if (isTeamEvent) {
    const teamPoints = { 1: 25, 2: 15, 3: 10 };
    return teamPoints[position] || 0;
  }

  const individualPoints = { 1: 15, 2: 10, 3: 5 };
  return individualPoints[position] || 0;
};

const fetchDepartmentFromRegistration = async (eventId, participantName, cache = new Map()) => {
  const cacheKey = `${String(eventId)}::${participantName}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const applications = await Application.find({ eventId }).select('players teamName');

    for (const app of applications) {
      if (app.teamName === participantName) {
        const mainPlayers = app.players.filter((player) => !player.isSubstitute);
        const department = mainPlayers[0]?.department || 'Unassigned';
        cache.set(cacheKey, department);
        return department;
      }

      for (const player of app.players) {
        if (!player.isSubstitute && (player.name === participantName || `${player.name} (${player.uucms})` === participantName)) {
          const department = player.department || 'Unassigned';
          cache.set(cacheKey, department);
          return department;
        }
      }
    }
  } catch (err) {
    console.error('Error fetching department:', err);
  }

  cache.set(cacheKey, 'Unassigned');
  return 'Unassigned';
};

const buildGeneralChampionshipStandings = async () => {
  const leaderboard = await Leaderboard.find().populate('eventId', 'title type');
  const eventGroups = new Map();

  for (const entry of leaderboard) {
    if (!entry.eventId) continue;

    const eventKey = entry.eventId._id.toString();
    if (!eventGroups.has(eventKey)) {
      eventGroups.set(eventKey, {
        eventId: entry.eventId._id,
        eventTitle: entry.eventId.title,
        isTeamEvent: entry.eventId.type === 'team',
        entries: []
      });
    }

    eventGroups.get(eventKey).entries.push(entry);
  }

  const departmentCache = new Map();
  const entries = [];
  const departmentScores = {};

  for (const [, eventData] of eventGroups.entries()) {
    const rankedEntries = eventData.entries
      .filter((entry) => entry.rank != null)
      .sort((a, b) => a.rank - b.rank || a._id.toString().localeCompare(b._id.toString()));

    const selectedDepartments = new Set();
    let gcPosition = 1;

    for (const entry of rankedEntries) {
      if (gcPosition > 3) break;

      const department = await fetchDepartmentFromRegistration(eventData.eventId, entry.teamOrPlayer, departmentCache);
      if (selectedDepartments.has(department)) continue;

      selectedDepartments.add(department);
      const points = getPointsForPosition(gcPosition, eventData.isTeamEvent);

      entries.push({
        eventId: eventData.eventId,
        eventTitle: eventData.eventTitle,
        isTeamEvent: eventData.isTeamEvent,
        departmentName: department,
        position: gcPosition,
        participantName: entry.teamOrPlayer,
        points
      });

      departmentScores[department] = (departmentScores[department] || 0) + points;
      gcPosition += 1;
    }
  }

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
