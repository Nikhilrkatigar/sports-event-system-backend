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
    origin: (origin, callback) => {
      const allowedOrigins = [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:8000',
        process.env.REACT_APP_FRONTEND_URL || '',
        'https://sports-event-system-frontend.vercel.app'
      ].filter(Boolean);
      
      const patterns = [
        /^https:\/\/sports-event-system-frontend.*\.vercel\.app$/
      ];
      
      if (!origin || allowedOrigins.includes(origin) || patterns.some(p => p.test(origin))) {
        callback(null, true);
      } else {
        callback(new Error('CORS not allowed'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
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
app.use('/api/images', require('./routes/images'));
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
app.use('/api/cricket', require('./routes/cricketRoutes'));
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
  .then(async () => {
    const dbName = mongoose.connection.db.databaseName;
    console.log(`MongoDB connected → database: "${dbName}"`);

    // ── GridFS health check ──
    // Logs how many uploaded files exist so you can verify data persists across deploys.
    try {
      const filesCount = await mongoose.connection.db.collection('uploads.files').countDocuments();
      const chunksCount = await mongoose.connection.db.collection('uploads.chunks').countDocuments();
      console.log(`📦 GridFS health: ${filesCount} file(s), ${chunksCount} chunk(s) in "${dbName}"`);

      const Application = require('./models/Application');
      const withScreenshot = await Application.countDocuments({
        paymentScreenshot: { $exists: true, $ne: '' }
      });
      console.log(`📸 Applications with screenshots: ${withScreenshot}`);
    } catch (err) {
      console.warn('GridFS health check skipped:', err.message);
    }

    // Sync Tournament indexes (drops old unique eventId index, creates new compound index)
    try {
      const { Tournament } = require('./models');
      await Tournament.syncIndexes();
      console.log('Tournament indexes synced');
    } catch (err) {
      console.warn('Could not sync Tournament indexes:', err.message);
    }
  })
  .catch(err => console.error('MongoDB error:', err));

const PORT = process.env.PORT || 5003;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
