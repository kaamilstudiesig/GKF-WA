const express = require('express');
const { verifyWebhookSignature } = require('./middleware/webhookSecurity');
const webhookController = require('./controllers/webhookController');
const leadController = require('./controllers/leadController');
const gymConfig = require('./config/gymConfig');

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

  // Basic request logger
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  // Health check endpoint
  app.get('/', (req, res) => {
    res.json({
      service: 'Goldkraft Fitness WhatsApp AI Lead Manager',
      status: 'operational',
      facility: gymConfig.facility.location,
      version: '1.0.0',
      timestamp: new Date().toISOString()
    });
  });

  // Webhook routes for Meta WhatsApp Cloud API
  app.get('/webhook', (req, res) => webhookController.verifyWebhook(req, res));
  app.post('/webhook', verifyWebhookSignature, (req, res) => webhookController.handleIncoming(req, res));

  // Lead Management API routes for CRM & Dashboard
  app.get('/leads', (req, res) => leadController.listLeads(req, res));
  app.get('/leads/:wa_id', (req, res) => leadController.getLeadByWaId(req, res));

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint Not Found' });
  });

  // Central error handler
  app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  });

  return app;
}

module.exports = createApp;
