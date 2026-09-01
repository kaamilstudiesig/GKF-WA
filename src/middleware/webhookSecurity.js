const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Middleware to verify Meta WhatsApp webhook signature (X-Hub-Signature-256)
 * Strict SHA-256 verification exclusively.
 */
function verifyWebhookSignature(req, res, next) {
  // If META_APP_SECRET is not configured
  if (!env.metaAppSecret) {
    if (env.nodeEnv === 'production') {
      logger.error('CRITICAL: META_APP_SECRET is not configured in production. Rejecting webhook request.');
      return res.status(500).json({ error: 'Server configuration error: Webhook verification secret missing.' });
    }
    
    if (env.nodeEnv !== 'test') {
      console.warn(`
\x1b[41m\x1b[37m=================================================================\x1b[0m
\x1b[31m[SECURITY WARNING] META_APP_SECRET is not set!\x1b[0m
\x1b[33mRunning in unverified developer mode. Inbound payloads are NOT verified.\x1b[0m
\x1b[33mSet META_APP_SECRET in .env before deploying to staging/production.\x1b[0m
\x1b[41m\x1b[37m=================================================================\x1b[0m
      `);
    }
    return next();
  }

  // Strictly check X-Hub-Signature-256 header (Meta standard)
  const signatureHeader = req.headers['x-hub-signature-256'];

  if (!signatureHeader) {
    logger.warn('Webhook signature check failed: Missing X-Hub-Signature-256 header.', {
      ip: req.ip
    });
    return res.status(401).json({ error: 'Signature verification failed: Missing X-Hub-Signature-256 header' });
  }

  // Header must strictly be formatted as 'sha256=<signature_hex>'
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    logger.warn('Webhook signature check failed: Invalid header format.', {
      header: signatureHeader
    });
    return res.status(401).json({ error: 'Signature verification failed: Header must be formatted as sha256=<hex_hash>' });
  }

  const receivedHash = parts[1];
  
  // Use rawBody buffer captured during express.json parsing
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  
  const expectedHash = crypto
    .createHmac('sha256', env.metaAppSecret)
    .update(rawBody)
    .digest('hex');

  try {
    const receivedBuffer = Buffer.from(receivedHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');

    if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
      logger.warn('Webhook signature mismatch: Signature does not match computed HMAC.');
      return res.status(403).json({ error: 'Signature verification failed: Signature mismatch' });
    }
  } catch (err) {
    logger.error('Error during webhook signature verification:', { error: err.message });
    return res.status(403).json({ error: 'Signature verification error' });
  }

  // Signature is valid
  next();
}

module.exports = {
  verifyWebhookSignature
};
