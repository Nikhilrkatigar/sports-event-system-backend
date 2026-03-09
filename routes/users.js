const router = require('express').Router();
const { Admin, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requireFullAccess = require('../middleware/requireFullAccess');
const { CMS_ROLES, isValidCmsRole } = require('../utils/roles');

router.get('/roles', auth, requireFullAccess, (req, res) => {
  res.json(CMS_ROLES);
});

router.get('/', auth, requireFullAccess, async (req, res) => {
  try {
    const users = await Admin.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/', auth, requireFullAccess, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Name, email, password and role are required' });
    }
    if (!isValidCmsRole(role)) {
      return res.status(400).json({ message: 'Invalid role selected' });
    }

    const existing = await Admin.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    const user = new Admin({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password: String(password),
      role
    });
    await user.save();

    await AuditLog.create({
      action: `User Created: ${user.name} (${user.role})`,
      admin: req.admin.name,
      ip: req.ip
    });

    const safeUser = await Admin.findById(user._id).select('-password');
    res.status(201).json(safeUser);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
