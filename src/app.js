const express = require('express');
const { verifyWebhookSignature } = require('./middleware/webhookSecurity');
const { requireDashboardAuth } = require('./middleware/authMiddleware');
const { webhookRateLimiter, dashboardRateLimiter } = require('./middleware/rateLimiter');
const webhookController = require('./controllers/webhookController');
const leadController = require('./controllers/leadController');
const gymConfig = require('./config/gymConfig');
const logger = require('./utils/logger');

function createApp() {
  const app = express();

  // Parse JSON payloads and capture raw body buffer for signature verification
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // Parse URL-encoded bodies
  app.use(express.urlencoded({ extended: true }));

  // Request logger middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.debug(`HTTP ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`, {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        duration_ms: duration,
        ip: req.ip
      });
    });
    next();
  });

  // Dedicated uptime & health check endpoint (distinct from facility metadata)
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  // Root endpoint with gym facility & service overview
  app.get('/', (req, res) => {
    res.json({
      service: 'Goldkraft Fitness WhatsApp AI Lead Manager',
      status: 'operational',
      tagline: gymConfig.tagline,
      facility: {
        name: gymConfig.gymName,
        location: gymConfig.facility.location,
        hours: gymConfig.hours
      },
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

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint Not Found' });
  });

  // Central error handler
  app.use((err, req, res, next) => {
    logger.error('Unhandled Server Error:', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  });

  return app;
}

module.exports = createApp;
