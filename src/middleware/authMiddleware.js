const crypto = require('crypto');
const env = require('../config/env');
const authService = require('../services/authService');
const logger = require('../utils/logger');

/**
 * Authentication middleware protecting CRM and dashboard endpoints.
 * Supports 'Authorization: Bearer <KEY>' and 'x-api-key: <KEY>' headers.
 * Resolves user identity, role, and strict tenantId context.
 */
function requireDashboardAuth(req, res, next) {
  const configuredKey = env.dashboardApiKey;

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

  let authenticatedUser = null;

  // 1. Check if provided token matches DASHBOARD_API_KEY (Platform Admin fallback)
  if (configuredKey) {
    try {
      const providedBuffer = Buffer.from(providedToken);
      const expectedBuffer = Buffer.from(configuredKey);

      if (
        providedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(providedBuffer, expectedBuffer)
      ) {
        authenticatedUser = {
          id: 'admin_master',
          tenant_id: 'goldkraft',
          role: 'platform_admin',
          name: 'Dashboard Master Admin'
        };
      }
    } catch (e) {}
  }

  // 2. Check user table for tenant-specific API keys
  if (!authenticatedUser) {
    const dbUser = authService.authenticateApiKey(providedToken);
    if (dbUser) {
      authenticatedUser = {
        id: dbUser.id,
        tenant_id: dbUser.tenant_id,
        role: dbUser.role,
        name: dbUser.name
      };
    }
  }

  if (!authenticatedUser) {
    logger.warn('Dashboard request rejected: Invalid API key provided.', {
      ip: req.ip,
      path: req.originalUrl
    });
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid API key.'
    });
  }

  // 3. Multi-tenant context scoping
  req.user = authenticatedUser;
  req.userRole = authenticatedUser.role;

  // Allow platform_admin to inspect specific tenant via x-tenant-id header
  const requestedTenantId = req.headers['x-tenant-id'];
  if (requestedTenantId) {
    if (authenticatedUser.role === 'platform_admin') {
      req.tenantId = requestedTenantId;
    } else if (authenticatedUser.tenant_id !== requestedTenantId) {
      logger.warn('Unauthorized cross-tenant access attempt blocked', {
        actor_id: authenticatedUser.id,
        actor_tenant: authenticatedUser.tenant_id,
        target_tenant: requestedTenantId
      });
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You do not have permission to access another tenant\'s records.'
      });
    } else {
      req.tenantId = authenticatedUser.tenant_id;
    }
  } else {
    req.tenantId = authenticatedUser.tenant_id;
  }

  next();
}

/**
 * Role-based authorization middleware
 * @param {string[]} allowedRoles
 */
function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.userRole)) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: Requires one of these roles: ${allowedRoles.join(', ')}`
      });
    }
    next();
  };
}

module.exports = {
  requireDashboardAuth,
  requireRole
};

