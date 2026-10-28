const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const env = require('./config/env');
const gymConfig = require('./config/gymConfig');
const { verifyWebhookSignature } = require('./middleware/webhookSecurity');
const { webhookRateLimiter } = require('./middleware/rateLimiter');
const webhookController = require('./controllers/webhookController');
const logger = require('./utils/logger');
const { captureException } = require('./utils/sentry');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Heroku router
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (env.nodeEnv === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });

  // Keep the raw body: Meta's signature is computed over the exact bytes.
  app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => logger.debug(`HTTP ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`));
    next();
  });

  app.get('/', (req, res) => res.json({ service: `${gymConfig.gymName} WhatsApp assistant`, status: 'ok' }));

  app.get('/health', (req, res) => res.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) }));

  app.get('/health/ready', async (req, res) => {
    if (app.locals.isShuttingDown) return res.status(503).json({ status: 'not_ready', reason: 'shutting_down' });
    try {
      await db.one('SELECT 1 AS ok');
      res.json({ status: 'ready', database: 'connected' });
    } catch (err) {
      logger.error('Readiness check failed', { error: err.message });
      res.status(503).json({ status: 'not_ready', database: 'disconnected' });
    }
  });

  app.get('/webhook', webhookController.verifyWebhook);
  app.post('/webhook', webhookRateLimiter, verifyWebhookSignature, webhookController.handleIncoming);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    captureException(err, { component: 'express', path: req.path });
    logger.error('Unhandled request error', { request_id: req.id, error: err.message });
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

module.exports = createApp;
