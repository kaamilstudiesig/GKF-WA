const crypto = require('crypto');
const env = require('../config/env');

/**
 * Middleware to verify Meta WhatsApp webhook signature (X-Hub-Signature-256)
 */
function verifyWebhookSignature(req, res, next) {
  // If META_APP_SECRET is not configured (e.g. initial dev testing), log and proceed
  if (!env.metaAppSecret) {
    if (env.nodeEnv !== 'test') {
      console.warn('[Security Warning] META_APP_SECRET is not set. Skipping webhook signature verification.');
    }
    return next();
  }

  const signatureHeader = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'];

  if (!signatureHeader) {
    console.error('[Security Error] Missing X-Hub-Signature-256 header on webhook request.');
    return res.status(401).json({ error: 'Signature verification failed: Missing signature header' });
  }

  // Header is formatted as 'sha256=<signature_hex>'
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    console.error('[Security Error] Invalid X-Hub-Signature-256 format:', signatureHeader);
    return res.status(401).json({ error: 'Signature verification failed: Invalid signature format' });
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
      console.error('[Security Error] Webhook signature mismatch.');
      return res.status(403).json({ error: 'Signature verification failed: Mismatch' });
    }
  } catch (err) {
    console.error('[Security Error] Error verifying signature:', err.message);
    return res.status(403).json({ error: 'Signature verification error' });
  }

  // Signature is valid
  next();
}

module.exports = {
  verifyWebhookSignature
};
