const env = require('./config/env');
const db = require('./db');
const createApp = require('./app');
const { migrateAll } = require('./migrate');
const webhookWorker = require('./workers/webhookWorker');
const outboundWorker = require('./workers/outboundWorker');
const conversionsWorker = require('./workers/conversionsWorker');
const conversionsApi = require('./services/conversionsApi');
const businessProfile = require('./services/businessProfile');
const eventRepository = require('./db/eventRepository');
const outboundRepository = require('./db/outboundRepository');
const logger = require('./utils/logger');
const tenancy = require('./tenancy/context');
const registry = require('./tenancy/registry');
const { initSentry, captureException } = require('./utils/sentry');

/** No CRM staff yet (tenant 1): seed the example accounts on local PGlite, otherwise say how. */
async function ensureCrmUsers() {
  const { c } = await db.one('SELECT COUNT(*)::int AS c FROM crm_users');
  if (c > 0) return;
  if (db.driverKind() === 'pglite' && env.nodeEnv !== 'production') {
    const config = require('../crm/src/config');
    const { seedUsers } = require('../crm/scripts/seed');
    const created = await seedUsers(db, config.seedUsersFile);
    logger.info(`Created starting CRM accounts (passwords in ${config.seedUsersFile}): ${created.join(', ')}`);
  } else {
    logger.warn('No CRM staff accounts yet. Run `npm run crm:seed` (on Heroku: `heroku run npm run crm:seed`).');
  }
}

async function main() {
  env.validateForProduction(); // throws in production when settings are missing
  initSentry();
  await migrateAll(); // connects, then applies pending bot, CRM and platform migrations
  if (!(await db.checkRlsActive())) {
    logger.error('Row-level security does not apply to this database role (superuser or BYPASSRLS). Tenants are NOT isolated.');
  }
  await businessProfile.loadAll(); // K8 + K10: every tenant and its business facts
  registry.startRefresh();
  businessProfile.startRefresh();
  logger.info('Tenants loaded', { tenants: registry.list().map(t => t.slug) });
  await tenancy.run(registry.DEFAULT_TENANT_ID, ensureCrmUsers);

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(`WhatsApp bot listening on port ${env.port}`, { env: env.nodeEnv, model: env.openRouterModel, db: db.driverKind() });
    if (env.nodeEnv !== 'production') {
      logger.info(`Bot: http://localhost:${env.port}  CRM: http://${env.crmHosts.find(h => h.endsWith('localhost')) || 'crm.localhost'}:${env.port}`);
    }
  });

  webhookWorker.start();
  outboundWorker.start();
  if (conversionsApi.enabledForAny) conversionsWorker.start(); // K7: sales results back to Meta
  else logger.info('Conversions API off for every tenant (set a dataset and WABA id to send sales results to Meta)');

  // Housekeeping: keep the small Postgres plan small.
  const housekeeping = setInterval(async () => {
    try {
      const { events, sent } = await tenancy.runAsSystem(async () => ({
        events: await eventRepository.cleanup(14),
        sent: await outboundRepository.cleanup(30)
      }));
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
    await Promise.all([webhookWorker.stop(), outboundWorker.stop(), conversionsWorker.stop()]);
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
