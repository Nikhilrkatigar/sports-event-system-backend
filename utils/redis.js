const redis = require('redis');

let redisClient = null;
let isConnected = false;

/**
 * Initialize Redis client
 */
const initRedis = async () => {
  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = redis.createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 500)
      }
    });

    redisClient.on('error', (err) => {
      console.error('Redis client error:', err);
      isConnected = false;
    });

    redisClient.on('connect', () => {
      console.log('Redis client connected');
      isConnected = true;
    });

    redisClient.on('ready', () => {
      console.log('Redis client ready');
      isConnected = true;
    });

    await redisClient.connect();
    isConnected = true;
    return redisClient;
  } catch (error) {
    console.warn('Redis connection failed. Running without cache:', error.message);
    isConnected = false;
    return null;
  }
};

/**
 * Get Redis client
 */
const getRedisClient = () => {
  return redisClient;
};

/**
 * Check if Redis is connected
 */
const isRedisConnected = () => {
  return isConnected && redisClient !== null;
};

/**
 * Set cache value with TTL
 */
const setCache = async (key, value, ttl = 3600) => {
  try {
    if (!isRedisConnected()) return;
    await redisClient.setEx(key, ttl, JSON.stringify(value));
  } catch (error) {
    console.warn('Cache set error:', error.message);
  }
};

/**
 * Get cache value
 */
const getCache = async (key) => {
  try {
    if (!isRedisConnected()) return null;
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.warn('Cache get error:', error.message);
    return null;
  }
};

/**
 * Delete cache key
 */
const deleteCache = async (key) => {
  try {
    if (!isRedisConnected()) return;
    await redisClient.del(key);
  } catch (error) {
    console.warn('Cache delete error:', error.message);
  }
};

/**
 * Delete cache keys matching pattern
 */
const deleteCachePattern = async (pattern) => {
  try {
    if (!isRedisConnected()) return;
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (error) {
    console.warn('Cache pattern delete error:', error.message);
  }
};

/**
 * Clear all cache
 */
const clearCache = async () => {
  try {
    if (!isRedisConnected()) return;
    await redisClient.flushDb();
  } catch (error) {
    console.warn('Cache clear error:', error.message);
  }
};

/**
 * Graceful shutdown
 */
const closeRedis = async () => {
  try {
    if (redisClient) {
      await redisClient.quit();
      isConnected = false;
      console.log('Redis client closed');
    }
  } catch (error) {
    console.error('Redis close error:', error.message);
  }
};

module.exports = {
  initRedis,
  getRedisClient,
  isRedisConnected,
  setCache,
  getCache,
  deleteCache,
  deleteCachePattern,
  clearCache,
  closeRedis
};
