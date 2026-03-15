const { hasPermission } = require('../utils/roles');

module.exports = (permission) => (req, res, next) => {
  if (!hasPermission(req.admin?.role, permission)) {
    return res.status(403).json({ message: 'You do not have permission to access this resource' });
  }
  return next();
};
