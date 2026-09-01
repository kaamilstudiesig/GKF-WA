const createApp = require('./app');
const env = require('./config/env');
const { getDatabase, closeDatabase } = require('./db/database');
const logger = require('./utils/logger');

// Initialize database
getDatabase();

// Validate production requirements (throws and halts if NODE_ENV === 'production' and missing config)
try {
  env.validateForProduction();
} catch (err) {
  logger.error(err.message);
  process.exit(1);
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
  Health Check: http://localhost:${env.port}/health
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
function handleShutdown(signal) {
  logger.info(`Received ${signal}. Closing server gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    closeDatabase();
    logger.info('SQLite connection closed.');
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

module.exports = server;
