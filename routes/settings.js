const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Settings, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/settings';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

router.get('/', async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});
    res.json(settings);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/', auth, requirePermission('manage_settings'), upload.single('collegeLogo'), async (req, res) => {
  try {
    const data = { ...req.body };
    if (typeof data.departments === 'string') {
      try {
        const parsed = JSON.parse(data.departments);
        if (Array.isArray(parsed)) {
          data.departments = parsed.map(d => String(d).trim()).filter(Boolean);
        } else {
          delete data.departments;
        }
      } catch {
        delete data.departments;
      }
    }
    if (req.file) data.collegeLogo = `/uploads/settings/${req.file.filename}`;
    let settings = await Settings.findOne();
    if (!settings) settings = new Settings(data);
    else Object.assign(settings, data);
    await settings.save();
    await AuditLog.create({ action: 'Settings Updated', admin: req.admin.name, ip: req.ip });
    res.json(settings);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
