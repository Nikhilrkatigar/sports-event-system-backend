/**
 * Client IP for audit logs. Uses req.ip, which honours X-Forwarded-For only from
 * proxies trusted via `app.set('trust proxy')`, so clients cannot spoof it.
 * @param {Object} req - Express request object
 * @returns {string} Client IP address
 */
function getClientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'Unknown';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

module.exports = getClientIp;
