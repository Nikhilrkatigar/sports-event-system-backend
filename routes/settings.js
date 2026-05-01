const router = require('express').Router();
const multer = require('multer');
const { Settings, AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const getClientIp = require('../utils/getClientIp');
const { uploadFile, deleteFromGridFS } = require('../utils/fileUploads');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, fieldSize: 5 * 1024 * 1024 } });

router.get('/', async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({});
    }
    res.json(settings);
  } catch (err) {
    console.error('Settings GET error:', err.stack);
    res.status(500).json({ message: err.message, error: err.toString() });
  }
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
    if (req.file) {
      const currentSettings = await Settings.findOne().select('collegeLogo').lean();
      if (currentSettings?.collegeLogo && !currentSettings.collegeLogo.startsWith('data:') && !currentSettings.collegeLogo.startsWith('http')) {
        await deleteFromGridFS(currentSettings.collegeLogo);
      }
      data.collegeLogo = await uploadFile(req.file);
    }
    let settings = await Settings.findOne();
    if (!settings) settings = new Settings(data);
    else Object.assign(settings, data);
    await settings.save();
    await AuditLog.create({ action: 'Settings Updated', admin: req.admin.name, ip: getClientIp(req) });
    res.json(settings);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
