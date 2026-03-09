const jwt = require('jsonwebtoken');
const { Admin } = require('../models');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findById(decoded.id).select('name email role');
    if (!admin) return res.status(401).json({ message: 'Invalid token' });
    req.admin = {
      id: admin._id.toString(),
      name: admin.name,
      email: admin.email,
      role: admin.role
    };
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};
