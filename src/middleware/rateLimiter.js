const { rateLimit } = require('express-rate-limit');
const env = require('../config/env');

const isTest = env.nodeEnv === 'test';

/**
 * Rate limiter for inbound webhook traffic from Meta
 * Standard: 100 requests per minute per IP
 */
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isTest ? 10000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many webhook requests from this IP. Please slow down.'
  },
  skip: () => isTest
});

/**
 * Rate limiter for CRM dashboard and lead management APIs
 * Standard: 60 requests per minute per IP
 */
const dashboardRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isTest ? 10000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many dashboard requests. Rate limit exceeded.'
  },
  skip: () => isTest
});

module.exports = {
  webhookRateLimiter,
  dashboardRateLimiter
};
