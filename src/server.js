const createApp = require('./app');
const env = require('./config/env');
const { getDatabase, closeDatabase } = require('./db/database');
const webhookWorker = require('./workers/webhookWorker');
const outboundWorker = require('./workers/outboundWorker');
const logger = require('./utils/logger');

// Initialize database & run migrations
getDatabase();

// Validate production requirements (throws and halts if NODE_ENV === 'production' and missing config)
try {
  env.validateForProduction();
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

// Start background workers in non-test mode
if (env.nodeEnv !== 'test') {
  webhookWorker.start(2000);
  outboundWorker.start(2000);
}

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info(`Server started successfully on port ${env.port}`, {
    environment: env.nodeEnv,
    port: env.port,
    model: env.openRouterModel,
    database: env.databasePath
  });

  if (env.nodeEnv !== 'production') {
    console.log(`
=========================================================
  🏋️  GOLDKRAFT FITNESS - WHATSAPP AI BACKEND
=========================================================
  Environment:  ${env.nodeEnv}
  Server URL:   http://localhost:${env.port}
  Health Check: http://localhost:${env.port}/health (Liveness)
  Readiness:    http://localhost:${env.port}/health/ready (Readiness)
  Dashboard:    http://localhost:${env.port}/dashboard/summary (Auth Required)
  Webhook GET:  http://localhost:${env.port}/webhook (Handshake)
  Webhook POST: http://localhost:${env.port}/webhook (Inbound Messages)
  CRM Leads:    http://localhost:${env.port}/leads (Auth Required)
  Database:     ${env.databasePath}
  AI Model:     ${env.openRouterModel}
=========================================================
    `);
  }
});

// Graceful shutdown handling
let isShuttingDown = false;
async function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}. Draining workers and closing server gracefully...`);

  // Force exit safety timer (5s)
  const forceTimer = setTimeout(() => {
    logger.error('Shutdown grace period exceeded. Forcing termination.');
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  try {
    await webhookWorker.stop();
    await outboundWorker.stop();

    server.close(() => {
      logger.info('HTTP server closed.');
      closeDatabase();
      logger.info('SQLite connection closed.');
      process.exit(0);
    });
  } catch (err) {
    logger.error('Error during graceful shutdown:', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

module.exports = server;

