const db = require('./db');
const { migrateCrm } = require('../crm/src');

/**
 * Applies all pending migrations: the bot's tables first (db.init), then the
 * CRM's crm_* tables, which reference the bot's leads table. Safe to run on
 * every start; both use advisory locks, so the release phase and a starting
 * dyno can't collide.
 */
async function migrateAll() {
  await db.init();
  await migrateCrm(db);
}

module.exports = { migrateAll };
