/**
 * The staff CRM, served by the bot's own Express app on the CRM hostname
 * (see src/app.js). It uses the bot's db module (src/db), so there is one
 * connection pool for the whole process.
 *
 *   const db = require('../src/db');
 *   await db.init();                 // bot migrations
 *   await migrateCrm(db);            // then the CRM's (src/migrate.js does both)
 *   const crmApp = createCrmApp({ db });
 */
const { createCrmApp } = require('./app');
const { migrateCrm, checkBotSchema } = require('./migrations');

module.exports = { createCrmApp, migrateCrm, checkBotSchema };
