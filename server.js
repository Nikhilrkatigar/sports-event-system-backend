const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const rateLimit = require('express-rate-limit');
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
// Number of reverse proxies in front of the API (Render = 1); makes req.ip the real client IP
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));
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
app.use(express.json({ limit: '100kb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Security headers (the subset of helmet this API needs; CORP left off so the
// frontend on another origin can still load /api/images)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains'
  });
  next();
});

// Never send internal error details (DB/schema messages, stacks) to clients; log them instead
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500) {
      console.error(`${req.method} ${req.originalUrl} ->`, body);
      return json({ message: 'Internal server error' });
    }
    return json(body);
  };
  next();
});

// Rate-limit public (unauthenticated) write endpoints
const publicWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' }
});
app.post([
  '/api/registrations',
  '/api/events/:id/like',
  '/api/events/:id/interested',
  '/api/events/:id/share',
  '/api/tournaments/:id/like',
  '/api/tournaments/:id/interested',
  '/api/leaderboard/public/hype-create'
], publicWriteLimiter);
app.patch([
  '/api/registrations/:id/upload-payment-screenshot',
  '/api/leaderboard/:id/hype'
], publicWriteLimiter);

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
// Reports 503 when the database is down so uptime monitors notice
app.get('/api/health', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'db_down' });
});

// JSON errors for anything thrown in middleware (multer file checks, CORS, bad JSON)
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || (err.name === 'MulterError' ? 400 : 500);
  res.status(status).json({ message: status < 500 ? err.message : 'Internal server error' });
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

// Render's free plan sleeps after 15 min without traffic (~50s cold start). Render sets
// RENDER_EXTERNAL_URL, so ping ourselves through the public URL every 10 min to stay awake.
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/api/health`).catch(() => {});
  }, 10 * 60 * 1000);
}
