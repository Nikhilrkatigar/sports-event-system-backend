/**
 * Socket.io event handlers for real-time tournament updates
 */

const setupSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    // Join a cricket match room for live score updates
    socket.on('join_cricket_match', (matchId) => {
      const room = `cricket:${matchId}`;
      socket.join(room);
      console.log(`🎫 Socket ${socket.id} joined ${room}`);
      console.log(`📊 Room members: ${io.sockets.adapter.rooms.get(room)?.size || 0}`);
      socket.emit('cricket_match_joined', { matchId, message: 'Successfully joined cricket match' });
    });

    // Leave a cricket match room
    socket.on('leave_cricket_match', (matchId) => {
      const room = `cricket:${matchId}`;
      socket.leave(room);
      console.log(`👋 Socket ${socket.id} left ${room}`);
    });

    // Join a tournament room for live updates
    socket.on('join_tournament', (tournamentId) => {
      const room = `tournament:${tournamentId}`;
      socket.join(room);
      console.log(`Socket ${socket.id} joined ${room}`);
      socket.emit('tournament_joined', { tournamentId, message: 'Successfully joined tournament' });
    });

    // Leave a tournament room
    socket.on('leave_tournament', (tournamentId) => {
      const room = `tournament:${tournamentId}`;
      socket.leave(room);
      console.log(`Socket ${socket.id} left ${room}`);
    });

    // Join an event room for live updates
    socket.on('join_event', (eventId) => {
      const room = `event:${eventId}`;
      socket.join(room);
      console.log(`Socket ${socket.id} joined ${room}`);
      socket.emit('event_joined', { eventId, message: 'Successfully joined event' });
    });

    // Leave an event room
    socket.on('leave_event', (eventId) => {
      const room = `event:${eventId}`;
      socket.leave(room);
      console.log(`Socket ${socket.id} left ${room}`);
    });

    // Disconnect handler
    socket.on('disconnect', () => {
      console.log(`❌ User disconnected: ${socket.id}`);
    });

    // Handle errors
    socket.on('error', (error) => {
      console.error(`Socket error for ${socket.id}:`, error);
    });
  });
};

/**
 * Emit tournament match update to all connected clients
 */
const emitTournamentMatchUpdate = (io, tournamentId, matchData) => {
  const room = `tournament:${tournamentId}`;
  io.to(room).emit('tournament_match_updated', {
    tournamentId,
    match: matchData,
    timestamp: new Date()
  });
};

/**
 * Emit leaderboard update to all connected clients
 */
const emitLeaderboardUpdate = (io, eventId, leaderboardData) => {
  const room = `event:${eventId}`;
  io.to(room).emit('leaderboard_updated', {
    eventId,
    leaderboard: leaderboardData,
    timestamp: new Date()
  });
};

/**
 * Emit event status change to all connected clients
 */
const emitEventStatusChange = (io, eventId, status) => {
  const room = `event:${eventId}`;
  io.to(room).emit('event_status_changed', {
    eventId,
    status,
    timestamp: new Date()
  });
};

/**
 * Emit registration count update
 */
const emitRegistrationUpdate = (io, eventId, registrationData) => {
  const room = `event:${eventId}`;
  io.to(room).emit('registration_updated', {
    eventId,
    teamCount: registrationData.teamCount,
    playerCount: registrationData.playerCount,
    timestamp: new Date()
  });
};

/**
 * Emit cricket ball update to all viewers of a match
 */
const emitCricketBallUpdate = (io, matchId, ballData) => {
  const room = `cricket:${matchId}`;
  io.to(room).emit('cricket_ball_update', {
    matchId,
    ...ballData,
    timestamp: new Date()
  });
};

/**
 * Emit cricket wicket to all viewers of a match
 */
const emitCricketWicketUpdate = (io, matchId, wicketData) => {
  const room = `cricket:${matchId}`;
  io.to(room).emit('cricket_wicket', {
    matchId,
    wicketData,
    timestamp: new Date()
  });
};

module.exports = {
  setupSocketHandlers,
  emitTournamentMatchUpdate,
  emitLeaderboardUpdate,
  emitEventStatusChange,
  emitRegistrationUpdate,
  emitCricketBallUpdate,
  emitCricketWicketUpdate
};
