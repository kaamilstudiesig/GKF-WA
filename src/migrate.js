const db = require('./db');
const tenancy = require('./tenancy/context');
const { migrateCrm } = require('../crm/src');
const { PLATFORM_MIGRATIONS } = require('./db/platformMigrations');
const logger = require('./utils/logger');

/** Platform migrations (K8 tenancy and everything after it), tracked in platform_migrations. */
async function migratePlatform() {
  await db.query(`CREATE TABLE IF NOT EXISTS platform_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.tx(async () => {
    await db.query('SELECT pg_advisory_xact_lock(4242003)'); // serialise concurrent migrators
    const applied = new Set((await db.many('SELECT id FROM platform_migrations')).map(r => r.id));
    for (const m of PLATFORM_MIGRATIONS) {
      if (applied.has(m.id)) continue;
      logger.info(`Applying platform migration ${m.id}_${m.name}`);
      for (const stmt of m.up) await db.query(stmt);
      await db.query('INSERT INTO platform_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
    }
  });
}

/**
 * Applies all pending migrations: the bot's tables first (db.init), then the
 * CRM's crm_* tables, then the platform's (K8 tenancy and later). Safe to run on
 * every start; all use advisory locks, so the release phase and a starting dyno
 * can't collide. Runs across all tenants. Locally (PGlite) it then drops
 * superuser rights so row-level security applies, as on Heroku.
 */
async function migrateAll() {
  await db.init(); // runs migrateAfterBot on first connect
  await migrateAfterBot(); // and again here, for a database opened earlier (no-op when up to date)
}

/** CRM and platform migrations (db.init runs the bot's first). */
async function migrateAfterBot() {
  await db.useMigrationRole();
  await tenancy.runAsSystem(async () => {
    await migrateCrm(db);
    await migratePlatform();
  });
  await db.useRestrictedRole();
}

module.exports = { migrateAll, migratePlatform, migrateAfterBot };
