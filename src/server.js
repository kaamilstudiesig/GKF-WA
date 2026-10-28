const env = require('./config/env');
const db = require('./db');
const createApp = require('./app');
const webhookWorker = require('./workers/webhookWorker');
const outboundWorker = require('./workers/outboundWorker');
const eventRepository = require('./db/eventRepository');
const outboundRepository = require('./db/outboundRepository');
const logger = require('./utils/logger');
const { initSentry, captureException } = require('./utils/sentry');

async function main() {
  env.validateForProduction(); // throws in production when settings are missing
  initSentry();
  await db.init(); // connects and applies any pending migrations

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(`WhatsApp bot listening on port ${env.port}`, { env: env.nodeEnv, model: env.openRouterModel, db: db.driverKind() });
  });

  webhookWorker.start();
  outboundWorker.start();

  // Housekeeping: keep the small Postgres plan small.
  const housekeeping = setInterval(async () => {
    try {
      const events = await eventRepository.cleanup(14);
      const sent = await outboundRepository.cleanup(30);
      if (events || sent) logger.info('Housekeeping removed old queue rows', { events, sent });
    } catch (err) {
      logger.error('Housekeeping failed', { error: err.message });
    }
  }, 6 * 60 * 60 * 1000);
  housekeeping.unref();

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    app.locals.isShuttingDown = true;
    logger.info(`${signal} received; finishing in-flight work`);
    setTimeout(() => process.exit(1), 25000).unref(); // Heroku allows 30s
    server.close();
    await Promise.all([webhookWorker.stop(), outboundWorker.stop()]);
    await db.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', reason => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  captureException(err, { component: 'unhandled_rejection' });
  logger.error('Unhandled promise rejection', { error: err.message });
});

process.on('uncaughtException', err => {
  captureException(err, { component: 'uncaught_exception' });
  logger.error('Fatal uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

main().catch(err => {
  logger.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
