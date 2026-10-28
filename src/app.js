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
const { createCrmApp } = require('../crm/src');

/**
 * One Express app for the whole process. Requests whose Host is in CRM_HOSTS
 * (crm.goldkraftfitness.com, crm.localhost) go to the staff CRM; everything
 * else (wa.goldkraftfitness.com, the herokuapp.com address, localhost) is the
 * bot. Both share the db module and its single connection pool.
 *
 * options.crmHosts / options.secureCookies / options.forceHttps override the env defaults (tests).
 */
function createApp({
  crmHosts = env.crmHosts,
  secureCookies = env.nodeEnv === 'production',
  forceHttps = env.nodeEnv === 'production'
} = {}) {
  const app = express();
  app.set('trust proxy', 1); // Heroku router
  app.disable('x-powered-by');

  // Heroku serves custom domains over plain http too. Send browsers to https
  // (the CRM's login cookie is https-only, so http logins would silently fail)
  // and tell them to stay on https from then on.
  if (forceHttps) {
    app.use((req, res, next) => {
      if (req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        return next();
      }
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
      return res.status(403).json({ error: 'HTTPS required' });
    });
  }

  // CRM first, so its pages never get the bot's headers, CSP, JSON parser or JSON 404.
  // Secure cookies: Heroku terminates TLS, and every request to the app is HTTPS.
  const crmApp = createCrmApp({ db, secureCookies });
  const crmHostSet = new Set(crmHosts.map(h => h.toLowerCase()));
  app.locals.crmApp = crmApp;
  app.use((req, res, next) => {
    if (!crmHostSet.has(String(req.hostname || '').toLowerCase())) return next();
    // The CRM ends every request itself (its own 404 and error pages).
    crmApp(req, res, err => {
      captureException(err || new Error('CRM fell through'), { component: 'crm', path: req.path });
      if (!res.headersSent) res.status(500).send('Internal Server Error');
    });
  });

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
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
