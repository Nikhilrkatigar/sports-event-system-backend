const EVENT_STATUSES = ['draft', 'coming_soon', 'published', 'open', 'full', 'closed', 'live', 'completed', 'archived'];
const PUBLIC_EVENT_STATUSES = ['coming_soon', 'published', 'open', 'full', 'closed', 'live', 'completed'];
const EVENT_CATEGORIES = ['general', 'track', 'field'];
const SPORT_TYPES = ['standard', 'cricket'];

const normalizeDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getMainPlayerCount = (players = []) => players.filter((player) => !player.isSubstitute).length;

const getEventCapacity = (event, counts = {}) => {
  const maxParticipants = Number(event?.maxParticipants);
  const playerCount = Number(counts.playerCount || 0);
  const teamCount = Number(counts.teamCount || 0);
  const hasCapacityLimit = Number.isFinite(maxParticipants) && maxParticipants > 0;
  const remainingSlots = hasCapacityLimit ? Math.max(maxParticipants - playerCount, 0) : null;
  const availableTeams = hasCapacityLimit && Number(event?.teamSize) > 0
    ? Math.floor(remainingSlots / Number(event.teamSize || 1))
    : null;
  const isFull = hasCapacityLimit ? remainingSlots <= 0 : false;

  return {
    teamCount,
    playerCount,
    remainingSlots,
    availableTeams,
    isFull,
    hasCapacityLimit
  };
};

const getRegistrationState = (event, counts = {}, nowInput = new Date()) => {
  const now = normalizeDate(nowInput) || new Date();
  const registrationDeadline = normalizeDate(event?.registrationDeadline);
  const capacity = getEventCapacity(event, counts);
  const isPastDeadline = Boolean(registrationDeadline && registrationDeadline.getTime() < now.getTime());
  const isRegistrationStatus = event?.status === 'open';
  const canRegister = Boolean(
    event &&
    event.registrationOpen !== false &&
    isRegistrationStatus &&
    !isPastDeadline &&
    !capacity.isFull
  );

  return {
    ...capacity,
    registrationDeadline,
    isPastDeadline,
    canRegister
  };
};

const getNormalizedEventPayload = (input = {}) => {
  const payload = { ...input };
  if (payload.status != null) {
    const status = String(payload.status || '').trim().toLowerCase();
    if (EVENT_STATUSES.includes(status)) payload.status = status;
    else delete payload.status;
  }
  if (payload.eventCategory != null) {
    const eventCategory = String(payload.eventCategory || '').trim().toLowerCase();
    if (EVENT_CATEGORIES.includes(eventCategory)) payload.eventCategory = eventCategory;
    else delete payload.eventCategory;
  }
  if (payload.sportType != null) {
    const sportType = String(payload.sportType || '').trim().toLowerCase();
    if (SPORT_TYPES.includes(sportType)) payload.sportType = sportType;
    else delete payload.sportType;
  }

  if (payload.maxParticipants === '' || payload.maxParticipants == null) delete payload.maxParticipants;
  else payload.maxParticipants = Number(payload.maxParticipants);

  if (payload.teamSize === '' || payload.teamSize == null) delete payload.teamSize;
  else payload.teamSize = Math.max(1, Number(payload.teamSize));

  if (payload.fieldAttempts === '' || payload.fieldAttempts == null) delete payload.fieldAttempts;
  else payload.fieldAttempts = Math.min(10, Math.max(1, Number(payload.fieldAttempts)));

  if (payload.cricketOvers === '' || payload.cricketOvers == null) delete payload.cricketOvers;
  else payload.cricketOvers = Math.min(100, Math.max(1, Number(payload.cricketOvers)));

  if (payload.registrationDeadline === '') delete payload.registrationDeadline;
  if (payload.date === '') delete payload.date;

  // Parse JSON arrays from FormData string representations
  if (payload.allowedGenders && typeof payload.allowedGenders === 'string') {
    try {
      payload.allowedGenders = JSON.parse(payload.allowedGenders);
    } catch {
      payload.allowedGenders = [];
    }
  }
  if (payload.allowedDepartments && typeof payload.allowedDepartments === 'string') {
    try {
      payload.allowedDepartments = JSON.parse(payload.allowedDepartments);
    } catch {
      payload.allowedDepartments = [];
    }
  }

  if (payload.status) {
    payload.registrationOpen = payload.status === 'open';
  }

  if (payload.sportType === 'cricket') {
    payload.type = 'team';
    payload.eventCategory = 'general';
  }

  return payload;
};

const syncEventRegistrationStatus = async (event, counts = {}) => {
  if (!event) return event;
  const state = getRegistrationState(event, counts);

  if (event.status === 'open' && state.isFull) {
    event.status = 'full';
    event.registrationOpen = false;
    await event.save();
  } else if (event.status === 'full' && !state.isFull && event.registrationOpen !== false) {
    event.status = 'open';
    await event.save();
  }

  return event;
};

module.exports = {
  EVENT_STATUSES,
  EVENT_CATEGORIES,
  SPORT_TYPES,
  PUBLIC_EVENT_STATUSES,
  getMainPlayerCount,
  getEventCapacity,
  getRegistrationState,
  getNormalizedEventPayload,
  syncEventRegistrationStatus
};
