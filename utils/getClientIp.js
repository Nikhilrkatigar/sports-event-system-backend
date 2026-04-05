/**
 * Extracts the client IP address from the request, handling proxies and IPv6/IPv4 formats
 * @param {Object} req - Express request object
 * @returns {string} Client IP address
 */
function getClientIp(req) {
  // Check X-Forwarded-For header first (for proxies)
  if (req.headers['x-forwarded-for']) {
    return req.headers['x-forwarded-for'].split(',')[0].trim();
  }

  // Check X-Real-IP header
  if (req.headers['x-real-ip']) {
    return req.headers['x-real-ip'].trim();
  }

  // Check CF-Connecting-IP (Cloudflare)
  if (req.headers['cf-connecting-ip']) {
    return req.headers['cf-connecting-ip'].trim();
  }

  // Get IP from request object
  let ip = req.ip || 
    req.connection?.remoteAddress || 
    req.socket?.remoteAddress || 
    req.connection?.socket?.remoteAddress ||
    'Unknown';

  // Handle IPv6 loopback (::1 or ::ffff:127.0.0.1)
  if (ip === '::1') {
    return '127.0.0.1';
  }

  // Handle IPv6-mapped IPv4 addresses (::ffff:192.0.2.1)
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }

  return ip;
}

module.exports = getClientIp;
