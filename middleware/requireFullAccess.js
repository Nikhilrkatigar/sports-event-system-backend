const { hasFullCmsAccess } = require('../utils/roles');

module.exports = (req, res, next) => {
  if (!hasFullCmsAccess(req.admin?.role)) {
    return res.status(403).json({ message: 'You do not have permission to access this resource' });
  }
  return next();
};
