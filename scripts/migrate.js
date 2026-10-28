// Applies pending database migrations (bot, then CRM). Heroku runs this in the
// release phase before each new version starts.
const db = require('../src/db');
const { migrateAll } = require('../src/migrate');

migrateAll()
  .then(() => db.close())
  .then(() => { console.log('Migrations complete (bot + CRM).'); process.exit(0); })
  .catch(err => { console.error(`Migration failed: ${err.message}`); process.exit(1); });
