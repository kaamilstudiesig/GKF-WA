const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Authentication middleware protecting CRM /leads endpoints.
 * Supports 'Authorization: Bearer <KEY>' and 'x-api-key: <KEY>' headers.
 */
function requireDashboardAuth(req, res, next) {
  const configuredKey = env.dashboardApiKey;

  // Fail closed if DASHBOARD_API_KEY is not configured
  if (!configuredKey) {
    logger.error('Dashboard auth attempt rejected: DASHBOARD_API_KEY is not configured on the server.');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Server dashboard authentication is not configured.'
    });
  }

  // Extract token from Authorization header or x-api-key header
  let providedToken = null;
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else {
      providedToken = authHeader.trim();
    }
  } else if (apiKeyHeader) {
    providedToken = String(apiKeyHeader).trim();
  }

  if (!providedToken) {
    logger.warn('Dashboard request rejected: Missing Authorization or x-api-key header.', {
      ip: req.ip,
      path: req.originalUrl
    });
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing authentication credentials (Authorization: Bearer <KEY> or x-api-key: <KEY> required).'
    });
  }

  // Constant-time token verification
  try {
    const providedBuffer = Buffer.from(providedToken);
    const expectedBuffer = Buffer.from(configuredKey);

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      logger.warn('Dashboard request rejected: Invalid API key provided.', {
        ip: req.ip,
        path: req.originalUrl
      });
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid API key.'
      });
    }
  } catch (err) {
    logger.error('Error during token verification:', { error: err.message });
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Token validation error.'
    });
  }

  next();
}

module.exports = {
  requireDashboardAuth
};
