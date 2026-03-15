const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Admin, AuditLog } = require('../models');
const { getCanonicalRole } = require('../utils/roles');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts. Please try again in 15 minutes.' }
});

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const isStrongPassword = (value) => String(value || '').trim().length >= 8;

// Login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    const email = normalizeEmail(req.body.email);
    const admin = await Admin.findOne({ email });
    if (!admin) return res.status(400).json({ message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(400).json({ message: 'Invalid credentials' });

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ message: 'Server auth configuration missing (JWT_SECRET)' });
    }

    const token = jwt.sign({ id: admin._id, name: admin.name, email: admin.email, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '24h' });

    await AuditLog.create({ action: 'Admin Login', admin: admin.name, ip: req.ip });

    res.json({
      token,
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: getCanonicalRole(admin.role)
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/setup-status', async (req, res) => {
  try {
    const count = await Admin.countDocuments();
    const setupRequired = count === 0;
    res.json({
      setupRequired,
      setupEnabled: setupRequired && Boolean(process.env.INITIAL_SETUP_KEY)
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Register first admin (only if no admins exist)
router.post('/setup', authLimiter, async (req, res) => {
  try {
    const count = await Admin.countDocuments();
    if (count > 0) return res.status(403).json({ message: 'Setup already done' });
    if (!process.env.INITIAL_SETUP_KEY) {
      return res.status(500).json({ message: 'INITIAL_SETUP_KEY is not configured on the server' });
    }

    const { name, password, setupKey } = req.body;
    const email = normalizeEmail(req.body.email);
    if (!name || !email || !password || !setupKey) {
      return res.status(400).json({ message: 'Name, email, password, and setup key are required' });
    }
    if (setupKey !== process.env.INITIAL_SETUP_KEY) {
      return res.status(403).json({ message: 'Invalid setup key' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const admin = new Admin({ name: String(name).trim(), email, password, role: 'Super Admin' });
    await admin.save();
    await AuditLog.create({ action: 'Initial Super Admin Created', admin: admin.name, ip: req.ip });
    res.json({ message: 'Super Admin created successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get current admin
const authMiddleware = require('../middleware/auth');
router.get('/me', authMiddleware, async (req, res) => {
  const admin = await Admin.findById(req.admin.id).select('-password');
  res.json({
    ...admin.toObject(),
    role: getCanonicalRole(admin.role)
  });
});


module.exports = router;
