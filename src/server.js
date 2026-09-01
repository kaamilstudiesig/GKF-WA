const createApp = require('./app');
const env = require('./config/env');
const { getDatabase, closeDatabase } = require('./db/database');

// Initialize database
getDatabase();
env.validateForProduction();

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`
=========================================================
  🏋️  GOLDKRAFT FITNESS - WHATSAPP AI BACKEND
=========================================================
  Environment:  ${env.nodeEnv}
  Server URL:   http://localhost:${env.port}
  Webhook GET:  http://localhost:${env.port}/webhook (Handshake)
  Webhook POST: http://localhost:${env.port}/webhook (Inbound Messages)
  CRM Leads:    http://localhost:${env.port}/leads
  Database:     ${env.databasePath}
  AI Model:     ${env.openRouterModel}
=========================================================
  `);
});

// Graceful shutdown handling
function handleShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Closing gracefully...`);
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    closeDatabase();
    console.log('[Server] SQLite connection closed.');
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

module.exports = server;
