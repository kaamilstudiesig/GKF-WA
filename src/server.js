/**
 * Standalone runner for local development (and for running the CRM on its own).
 * Once merged into the bot app, the bot's server mounts createCrmApp instead.
 */
const config = require('./config');
const { createDb } = require('./db');
const { createCrmApp, migrateCrm, checkBotSchema } = require('./index');

async function main() {
  const url = config.databaseUrl();
  const db = createDb(url);
  const isPglite = url.startsWith('pglite://');

  if (isPglite && (await checkBotSchema(db)).some(p => p === 'missing table leads')) {
    // Dev only: no bot here, so load the copy of the bot tables with demo leads.
    const { installBotFixture } = require('../dev/bot-fixture');
    const n = await installBotFixture(db);
    console.log(`PGlite: created a demo copy of the bot tables with ${n} sample leads.`);
  }
  await migrateCrm(db); // fails with a clear message if the bot tables are missing

  const { c: userCount } = await db.one('SELECT COUNT(*)::int AS c FROM crm_users');
  if (userCount === 0) {
    if (isPglite) {
      const { seedUsers } = require('../scripts/seed');
      const created = await seedUsers(db, config.seedUsersFile);
      console.log(`PGlite: created starting users (passwords in ${config.seedUsersFile}):\n  ${created.join('\n  ')}`);
    } else {
      console.warn('No CRM users yet. Run `npm run seed` to create the starting accounts.');
    }
  }

  const app = createCrmApp({ db });
  const server = app.listen(config.port, () => {
    console.log(`GKF CRM running on http://localhost:${config.port}`);
    console.log(`  Database: ${isPglite ? url : 'Postgres (DATABASE_URL)'}`);
  });

  const shutdown = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
