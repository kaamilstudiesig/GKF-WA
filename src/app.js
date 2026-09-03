const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { verifyWebhookSignature } = require('./middleware/webhookSecurity');
const { requireDashboardAuth } = require('./middleware/authMiddleware');
const { webhookRateLimiter, dashboardRateLimiter } = require('./middleware/rateLimiter');
const webhookController = require('./controllers/webhookController');
const leadController = require('./controllers/leadController');
const dashboardController = require('./controllers/dashboardController');
const { getDatabase } = require('./db/database');
const gymConfig = require('./config/gymConfig');
const env = require('./config/env');
const logger = require('./utils/logger');
const { captureException } = require('./utils/sentry');

function createApp() {
  const app = express();

  // Trust reverse proxy (load balancers / reverse proxies like ALB, Cloudflare, Nginx)
  app.set('trust proxy', 1);

  // Security Headers Middleware
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    if (env.nodeEnv === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // Request ID tracing
    const reqId = req.headers['x-request-id'] || crypto.randomUUID();
    req.id = reqId;
    res.setHeader('x-request-id', reqId);
    next();
  });

  // Parse JSON payloads with body size limit and capture raw body buffer
  app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // Parse URL-encoded bodies with size limit
  app.use(express.urlencoded({ limit: '1mb', extended: true }));

  // Request logger middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.debug(`HTTP ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`, {
        request_id: req.id,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        duration_ms: duration,
        ip: req.ip
      });
    });
    next();
  });

  // Dedicated uptime & liveness check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  // Readiness check endpoint (verifies critical SQLite dependency and shutdown state)
  app.get('/health/ready', (req, res) => {
    if (app.locals.isShuttingDown) {
      return res.status(503).json({
        status: 'not_ready',
        database: 'shutting_down',
        error: 'Server is terminating'
      });
    }

    try {
      const db = getDatabase();
      db.prepare('SELECT 1').get();
      res.status(200).json({
        status: 'ready',
        database: 'connected',
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      logger.error('Readiness check failed:', { error: err.message });
      res.status(503).json({
        status: 'not_ready',
        database: 'disconnected',
        error: env.nodeEnv === 'production' ? 'Database unavailable' : err.message
      });
    }
  });

  // Static assets for WhatsApp Demo UI (without hijacking GET /)
  app.use(express.static(path.join(__dirname, '../public'), { index: false }));

  // Dedicated WhatsApp Demo UI Route
  app.get('/demo', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  // Root endpoint with gym facility & service overview (redirects browser navigation to /demo)
  app.get('/', (req, res) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html') && !accept.includes('application/json')) {
      return res.redirect('/demo');
    }
    res.json({
      service: 'Goldkraft Fitness WhatsApp AI Lead Manager',
      status: 'operational',
      tagline: gymConfig.tagline,
      facility: {
        name: gymConfig.gymName,
        location: gymConfig.facility.location,
        hours: gymConfig.hours
      },
      demo_url: '/demo',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    });
  });

  // Webhook routes for Meta WhatsApp Cloud API
  app.get('/webhook', (req, res) => webhookController.verifyWebhook(req, res));
  app.post(
    '/webhook',
    webhookRateLimiter,
    verifyWebhookSignature,
    (req, res) => webhookController.handleIncoming(req, res)
  );

  // Authenticated & Rate-Limited Lead Management API routes for CRM / Dashboard
  app.get(
    '/leads',
    dashboardRateLimiter,
    requireDashboardAuth,
    (req, res) => leadController.listLeads(req, res)
  );
  
  app.get(
    '/leads/:wa_id',
    dashboardRateLimiter,
    requireDashboardAuth,
    (req, res) => leadController.getLeadByWaId(req, res)
  );

  app.patch(
    '/leads/:wa_id',
    dashboardRateLimiter,
    requireDashboardAuth,
    (req, res) => leadController.updateLead(req, res)
  );

  // Dashboard Aggregated Summary Endpoint (Phase 57)
  app.get(
    '/dashboard/summary',
    dashboardRateLimiter,
    requireDashboardAuth,
    (req, res) => dashboardController.getSummary(req, res)
  );

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint Not Found' });
  });

  // Central error handler (protects against stack trace / internal details leakage in production)
  app.use((err, req, res, next) => {
    captureException(err, {
      component: 'express_http',
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      tenantId: req.tenantId
    });

    logger.error('Unhandled Server Error:', {
      request_id: req.id,
      error: err.message,
      stack: env.nodeEnv === 'production' ? undefined : err.stack
    });

    const isProd = env.nodeEnv === 'production';
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      ...(isProd ? {} : { message: err.message })
    });
  });

  return app;
}

module.exports = createApp;

