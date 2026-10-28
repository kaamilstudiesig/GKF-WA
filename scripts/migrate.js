// Applies pending database migrations. Heroku runs this in the release phase
// before each new version starts.
const db = require('../src/db');

db.init()
  .then(() => db.close())
  .then(() => { console.log('Migrations complete.'); process.exit(0); })
  .catch(err => { console.error(`Migration failed: ${err.message}`); process.exit(1); });
