const router = require('express').Router();
const { Admin, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { ROLE_DEFINITIONS, isValidCmsRole, getCanonicalRole } = require('../utils/roles');
const { validatePassword, getPasswordStrengthMessage } = require('../utils/passwordValidator');
const getClientIp = require('../utils/getClientIp');

router.get('/roles', auth, requirePermission('manage_users'), (req, res) => {
  res.json(ROLE_DEFINITIONS.map(({ key, label, description }) => ({ key, label, description })));
});

router.get('/', auth, requirePermission('manage_users'), async (req, res) => {
  try {
    const users = await Admin.find().select('-password').sort({ createdAt: -1 }).lean();
    res.json(users.map((user) => ({ ...user, role: getCanonicalRole(user.role) })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/', auth, requirePermission('manage_users'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Name, email, password and role are required' });
    }
    if (!isValidCmsRole(role)) {
      return res.status(400).json({ message: 'Invalid role selected' });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({ 
        message: getPasswordStrengthMessage(),
        errors: passwordValidation.errors 
      });
    }

    const existing = await Admin.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    const user = new Admin({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password: String(password),
      role: getCanonicalRole(role)
    });
    await user.save();

    await AuditLog.create({
      action: `User Created: ${user.name} (${user.role})`,
      admin: req.admin.name,
      ip: getClientIp(req)
    });

    const safeUser = await Admin.findById(user._id).select('-password').lean();
    res.status(201).json({ ...safeUser, role: getCanonicalRole(safeUser.role) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
