const router = require('express').Router();
const { AuditLog } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

router.get('/', auth, requirePermission('view_audit'), async (req, res) => {
  try {
    const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(200);
    res.json(logs);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
