const jwt = require('jsonwebtoken');

const studentAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Authentication required. Please login to comment.' });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key'
    );

    if (decoded.type !== 'student') {
      return res.status(401).json({ message: 'Invalid token type' });
    }

    req.student = {
      id: decoded.id,
      uucms: decoded.uucms,
      username: decoded.username
    };

    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = studentAuth;
