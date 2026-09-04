const env = require('../config/env');
const { requireDashboardAuth } = require('./authMiddleware');
const logger = require('../utils/logger');

/**
 * Security middleware protecting demo endpoints from public exploitation.
 * - Non-production (dev/test): Allowed freely.
 * - Production: Disabled by default (403 Forbidden). If explicitly enabled via
 *   ENABLE_DEMO=true, requires dashboard authentication.
 */
function checkDemoAccess(req, res, next) {
  const isProduction = (process.env.NODE_ENV || env.nodeEnv) === 'production';

  if (isProduction) {
    const isDemoEnabledInProd = process.env.ENABLE_DEMO === 'true';

    if (!isDemoEnabledInProd) {
      logger.warn('Demo endpoint access blocked in production environment', {
        ip: req.ip,
        path: req.originalUrl
      });
      return res.status(403).json({
        success: false,
        error: 'Demo endpoints are disabled in production environment.'
      });
    }

    // In production with ENABLE_DEMO=true, require dashboard authentication
    return requireDashboardAuth(req, res, next);
  }

  next();
}

module.exports = {
  checkDemoAccess
};
