const { rateLimit } = require('express-rate-limit');
const env = require('../config/env');

/**
 * Generous per-IP limit on the webhook. Meta's legitimate traffic stays well
 * below this; it only stops floods of junk requests.
 */
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests from this IP.' },
  skip: () => env.nodeEnv === 'test'
});

/** Connect pages (K9): a person clicks a few times at most. */
const connectRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait 15 minutes and try again.' },
  skip: () => env.nodeEnv === 'test'
});

module.exports = { webhookRateLimiter, connectRateLimiter };
