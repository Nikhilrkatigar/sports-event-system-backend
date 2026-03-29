const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

// Suppress util._extend deprecation warning from dependencies
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.code !== 'DEP0060') {
    console.warn(warning.stack);
  }
});

const { setupSocketHandlers } = require('./utils/socket');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['http://localhost:3000'],
    methods: ['GET', 'POST']
  }
});

// Make io available to routes
app.set('io', io);

// Setup Socket.io handlers for real-time updates
setupSocketHandlers(io);

// Middleware
const defaultAllowedOrigins = [
  'http://localhost:3000',
  'https://sports-event-system-frontend.vercel.app'
];
const envAllowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...envAllowedOrigins]);
const allowedOriginPatterns = [
  /^https:\/\/sports-event-system-frontend.*\.vercel\.app$/
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    if (allowedOriginPatterns.some((pattern) => pattern.test(origin))) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/events', require('./routes/events'));
app.use('/api/registrations', require('./routes/registrations'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/generalchampionship', require('./routes/generalchampionship'));
app.use('/api/gallery', require('./routes/gallery'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/users', require('./routes/users'));
app.use('/api/tournaments', require('./routes/tournaments'));
app.use('/api/timeline', require('./routes/timeline'));
app.use('/api/messages', require('./routes/messages'));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/debug/models', (req, res) => {
  const { TimelineItem } = require('./models');
  res.json({
    TimelineItemType: typeof TimelineItem,
    TimelineItemName: TimelineItem?.modelName,
    TimelineItemCollection: TimelineItem?.collection?.name,
    TimelineItemSchemaKeys: Object.keys(TimelineItem?.schema?.paths || {})
  });
});
app.get('/api/debug/timeline-test', async (req, res) => {
  try {
    const { TimelineItem } = require('./models');
    const count = await TimelineItem.countDocuments();
    const sample = await TimelineItem.findOne().lean();
    res.json({ success: true, count, sample });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const PORT = process.env.PORT || 5003;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
