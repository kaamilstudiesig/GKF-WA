const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const env = require('./config/env');
const gymConfig = require('./config/gymConfig');
const { verifyWebhookSignature } = require('./middleware/webhookSecurity');
const { webhookRateLimiter } = require('./middleware/rateLimiter');
const webhookController = require('./controllers/webhookController');
const { legalRouter } = require('./routes/legal');
const logger = require('./utils/logger');
const { captureException } = require('./utils/sentry');
const { createCrmApp } = require('../crm/src');
const { Crm } = require('../crm/src/crm');
const razorpay = require('./services/razorpay');
const notifyService = require('./services/notifyService');
const staffAlerts = require('./services/staffAlerts');
const tenancy = require('./tenancy/context');
const registry = require('./tenancy/registry');

/** Express 4 does not catch rejected promises; pass them to the error handler. */
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * One Express app for the whole process, serving every tenant (K8).
 * - A tenant's CRM hostname (tenants.crm_host; tenant 1 also CRM_HOSTS) gets the
 *   staff CRM, running as that tenant.
 * - Everything else is the bot: /webhook (our shared Meta app, routed by phone
 *   number id), /webhook/:slug (a tenant's own Meta app), Razorpay webhooks,
 *   health checks and the public pages (tenant 1).
 * All share the db module and its single connection pool.
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
  const paymentCrm = new Crm(db);
  const crmHostSet = new Set(crmHosts.map(x => x.toLowerCase()));
  app.locals.crmApp = crmApp;
  app.use(h(async (req, res, next) => {
    const host = String(req.hostname || '').toLowerCase();
    const tenant = crmHostSet.has(host) ? registry.config(registry.DEFAULT_TENANT_ID) : await registry.byCrmHost(host);
    if (!tenant) return next();
    if (tenant.status !== 'active') return res.status(403).send('This CRM is suspended. Contact support.');
    // The CRM ends every request itself (its own 404 and error pages), as this tenant.
    tenancy.run(tenant.id, () => crmApp(req, res, err => {
      captureException(err || new Error('CRM fell through'), { component: 'crm', path: req.path });
      if (!res.headersSent) res.status(500).send('Internal Server Error');
    }));
  }));

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

  // Public bot-host pages belong to tenant 1 (its legal pages, its name).
  const asDefault = (req, res, next) => tenancy.run(registry.DEFAULT_TENANT_ID, () => next());

  app.get('/', asDefault, (req, res) => res.json({ service: `${gymConfig.gymName} WhatsApp assistant`, status: 'ok' }));

  app.get('/health', (req, res) => res.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) }));

  app.get('/health/ready', async (req, res) => {
    if (app.locals.isShuttingDown) return res.status(503).json({ status: 'not_ready', reason: 'shutting_down' });
    try {
      await tenancy.runAsSystem(() => db.one('SELECT 1 AS ok'));
      res.json({ status: 'ready', database: 'connected' });
    } catch (err) {
      logger.error('Readiness check failed', { error: err.message });
      res.status(503).json({ status: 'not_ready', database: 'disconnected' });
    }
  });

  // Public privacy policy, terms and data-deletion pages (Meta App Review).
  app.use(asDefault, legalRouter());

  // A tenant from the :slug in the URL (its own Meta app or Razorpay account), or 404.
  const tenantFromSlug = h(async (req, res, next) => {
    const tenant = await registry.bySlug(req.params.slug);
    if (!tenant || tenant.status !== 'active') return res.status(404).json({ error: 'Not found' });
    req.tenant = tenant;
    next();
  });

  app.get('/webhook', webhookController.verifyWebhook);
  app.post('/webhook', webhookRateLimiter, verifyWebhookSignature, webhookController.handleIncoming);
  app.get('/webhook/:slug', tenantFromSlug, webhookController.verifyWebhook);
  app.post('/webhook/:slug', webhookRateLimiter, tenantFromSlug, verifyWebhookSignature, webhookController.handleIncoming);

  // K11: Razorpay says a payment link was paid -> log Joined + ₹ (and, through K7, tell Meta).
  // /razorpay/webhook is tenant 1's account; /razorpay/webhook/:slug another tenant's.
  const razorpayWebhook = (req, res) => tenancy.run(req.tenant ? req.tenant.id : registry.DEFAULT_TENANT_ID,
    () => handleRazorpay(req, res));
  app.post('/razorpay/webhook', razorpayWebhook);
  app.post('/razorpay/webhook/:slug', tenantFromSlug, razorpayWebhook);

  async function handleRazorpay(req, res) {
    if (!razorpay.enabled()) return res.status(404).json({ error: 'Not found' });
    if (!razorpay.verifySignature(req.rawBody, req.get('x-razorpay-signature'))) return res.status(401).json({ error: 'Bad signature' });
    const event = req.body || {};
    if (event.event !== 'payment_link.paid') return res.json({ ok: true, ignored: event.event || null });
    try {
      const link = event.payload?.payment_link?.entity || {};
      const payment = event.payload?.payment?.entity || {};
      const paid = await paymentCrm.markLinkPaid({ linkId: link.id, amountPaise: link.amount_paid ?? payment.amount, paymentId: payment.id });
      if (paid) {
        notifyService.send(`💰 Paid: ${paid.plan}, ₹${paid.amount.toLocaleString('en-IN')} (logged as Joined)`,
          { buttons: notifyService.leadLinks(paid.waId, null, { replyLabel: 'Open in CRM' }).buttons }).catch(() => {});
        staffAlerts.alert({ waId: paid.waId, event: 'payment', details: `${paid.plan}, ₹${paid.amount.toLocaleString('en-IN')} (logged as a sale)` });
      }
      res.json({ ok: true });
    } catch (err) {
      captureException(err, { component: 'razorpay_webhook' });
      logger.error('Razorpay webhook failed', { error: err.message });
      res.status(500).json({ error: 'Failed' }); // Razorpay retries
    }
  }

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
